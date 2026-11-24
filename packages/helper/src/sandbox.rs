//! File and TCP enforcement through Landlock.

use crate::spec::Spec;
use landlock::{
    path_beneath_rules, Access, AccessFs, AccessNet, BitFlags, CompatLevel, Compatible,
    LandlockStatus, Ruleset, RulesetAttr, RulesetCreatedAttr, ABI,
};
use std::path::{Path, PathBuf};

/// The oldest kernel ABI this helper supports. Older kernels are refused
/// outright instead of silently getting a weaker sandbox.
pub const REQUIRED_ABI: i32 = 7;

/// The ABI the ruleset is built against: every right we ask for exists in V7,
/// and V7 is also the floor above, so the two cannot drift apart.
const ABI_USED: ABI = ABI::V7;

/// `LANDLOCK_CREATE_RULESET_VERSION` from `<uapi/linux/landlock.h>`.
const CREATE_RULESET_VERSION: libc::c_uint = 1;

/// The running kernel's Landlock ABI, or the `errno` that made it unavailable.
pub fn kernel_abi() -> Result<i32, i32> {
    let abi = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            CREATE_RULESET_VERSION,
        )
    };
    if abi < 0 {
        Err(std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(libc::ENOSYS)
            .abs())
    } else {
        Ok(abi as i32)
    }
}

/// A human-readable reason for an `errno` returned by [`kernel_abi`].
pub fn unsupported_reason(errno: i32) -> String {
    match errno {
        libc::ENOSYS => {
            "the kernel is not built with Landlock (CONFIG_SECURITY_LANDLOCK)".to_string()
        }
        libc::EOPNOTSUPP => {
            "Landlock is disabled; add 'landlock' to CONFIG_LSM or to the lsm= kernel parameter"
                .to_string()
        }
        other => format!("Landlock is unavailable (errno {other})"),
    }
}

/// The kernel ABI when it is new enough to enforce this sandbox, otherwise the
/// reason the caller has to refuse the command.
pub fn abi_or_reason() -> Result<i32, String> {
    match kernel_abi() {
        Ok(abi) if abi >= REQUIRED_ABI => Ok(abi),
        Ok(abi) => Err(format!(
            "kernel Landlock ABI is {abi}, but ABI {REQUIRED_ABI} is required"
        )),
        Err(errno) => Err(unsupported_reason(errno)),
    }
}

/// Restrict this process: reads under `spec.read`, writes only under
/// `spec.write`, and no outbound TCP when the spec asks for an offline command.
///
/// The restriction applies to the calling process and everything it starts, so
/// the caller only has to `exec` the command afterwards.
pub fn apply(spec: &Spec, namespaces: bool) -> Result<(), String> {
    let _abi = abi_or_reason()?;
    for path in spec.read.iter().chain(spec.write.iter()) {
        match path.exists() {
            true => {}
            false => return Err(format!("spec path {} does not exist", path.display())),
        }
    }

    let mut ruleset = Ruleset::default()
        .set_compatibility(CompatLevel::HardRequirement)
        .handle_access(AccessFs::from_all(ABI_USED))
        .map_err(|e| format!("cannot handle file access rights: {e}"))?;
    // Offline is enforced by the network namespace (namespace.rs), which starts
    // empty and gets loopback brought up and nothing else: there is no route to
    // anywhere, while a local server stays reachable. Landlock's net rules are
    // port-based, so they cannot express "loopback only" — on a host where the
    // namespace works, adding them here would refuse the local connections a
    // test suite needs.
    //
    // Where the namespace cannot be created (some CI runners deny it), that
    // structural cut is missing, so the port rules have to carry the network
    // restriction instead. They are coarse — every local connection is refused
    // too — but they are what keeps an "offline" command offline.
    if needs_landlock_network(spec.offline, namespaces) {
        // Handling the right without adding any port rule denies every port.
        ruleset = ruleset
            .handle_access(AccessNet::BindTcp)
            .map_err(|e| format!("cannot handle TCP bind: {e}"))?
            .handle_access(AccessNet::ConnectTcp)
            .map_err(|e| format!("cannot handle TCP connect: {e}"))?;
    }

    let created = ruleset
        .create()
        .map_err(|e| format!("cannot create the ruleset: {e}"))?;
    let created = add_rules(created, &spec.read, AccessFs::from_read(ABI_USED), "read")?;
    let created = add_rules(created, &spec.write, AccessFs::from_all(ABI_USED), "write")?;

    let status = created
        .set_compatibility(CompatLevel::HardRequirement)
        .restrict_self()
        .map_err(|e| format!("cannot restrict this process: {e}"))?;
    match status.landlock {
        LandlockStatus::Available { .. } => Ok(()),
        other => Err(format!("Landlock is not active: {other:?}")),
    }
}

/// Landlock has to carry the network cut when the network namespace did not
/// happen: without the namespace there is no structural "no route out".
pub fn needs_landlock_network(offline: bool, namespaces: bool) -> bool {
    offline && !namespaces
}

fn add_rules(
    created: landlock::RulesetCreated,
    paths: &[PathBuf],
    access: BitFlags<AccessFs>,
    what: &str,
) -> Result<landlock::RulesetCreated, String> {
    if paths.is_empty() {
        return Ok(created);
    }
    created
        .add_rules(path_beneath_rules(paths.iter().map(Path::new), access))
        .map_err(|e| format!("cannot allow {what} access to {paths:?}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn required_abi_matches_the_ruleset_abi() {
        assert_eq!(ABI_USED as i32, REQUIRED_ABI);
    }

    #[test]
    fn a_missing_path_is_reported() {
        // Only meaningful where the sandbox would run at all: on an older kernel
        // the ABI check refuses before the paths are looked at.
        if abi_or_reason().is_err() {
            return;
        }
        let spec = Spec {
            cwd: None,
            read: vec!["/".into()],
            write: vec!["/definitely/not/here".into()],
            tmp: None,
            offline: true,
            env: Default::default(),
            stall_seconds: None,
            watch: Vec::new(),
        };
        let error = apply(&spec, true).expect_err("a missing path must be refused");
        assert!(
            error.contains("does not exist"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn unsupported_reason_names_enosys() {
        assert!(unsupported_reason(libc::ENOSYS).contains("CONFIG_SECURITY_LANDLOCK"));
    }

    /// Without a network namespace the port rules are the only cut left, so they
    /// must come back; with one, they would break loopback for no gain.
    #[test]
    fn landlock_carries_the_network_only_when_the_namespace_is_missing() {
        assert!(needs_landlock_network(true, false));
        assert!(!needs_landlock_network(true, true));
        assert!(!needs_landlock_network(false, false));
        assert!(!needs_landlock_network(false, true));
    }

    #[test]
    fn an_old_abi_is_refused_with_the_required_version() {
        match kernel_abi() {
            Ok(abi) if abi >= REQUIRED_ABI => {
                assert!(abi_or_reason().is_ok(), "a modern kernel must be accepted");
            }
            Ok(abi) => {
                let reason = abi_or_reason().expect_err("an old kernel must be refused");
                // The wording matters: the caller shows it to the user, and CI
                // asserts on it on a 5.15 kernel.
                assert!(reason.contains(&format!("ABI is {abi}")), "{reason}");
                assert!(
                    reason.contains(&format!("ABI {REQUIRED_ABI} is required")),
                    "{reason}"
                );
            }
            Err(_) => {
                assert!(
                    abi_or_reason().is_err(),
                    "a kernel without Landlock must be refused"
                );
            }
        }
    }
}
