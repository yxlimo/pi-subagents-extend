//! `pi-subagents-extend-helper` — apply the pi-subagents-extend sandbox to one command.
//!
//! The pi extension rewrites a bash tool call into
//!
//! ```text
//! <helper> --spec <file> -- bash -lc '<command>'
//! ```
//!
//! and this binary sandboxes itself before handing the process over to that
//! command:
//!
//! * **files** — a Landlock ruleset (kernel ABI 7) allows reading the listed
//!   paths and writing only the writable ones;
//! * **network** — a private network namespace, so no TCP, no UDP and no DNS;
//! * **resolver** — the `nscd`/`systemd-resolved` socket directories are
//!   shadowed in the private mount namespace, because a unix socket crosses a
//!   network namespace;
//! * **scratch** — the command's temporary directory and the conventional `/tmp`
//!   are shadowed with an empty tmpfs, so temp files stay inside the sandbox;
//! * **processes** — a private PID namespace with a fresh `/proc`, so the host's
//!   processes and their environments are out of reach;
//! * **capabilities** — every capability is dropped before the command starts;
//! * **TCP** — also denied by Landlock, which keeps holding when the kernel
//!   refuses user namespaces.
//!
//! No system sandbox binary is involved: these are the same kernel primitives
//! bubblewrap is built from, applied by this process to itself.

mod namespace;
mod sandbox;
mod spec;
mod supervise;
mod watch;

use std::ffi::OsString;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::Command;

use spec::Spec;

/// The kernel cannot sandbox this command: no Landlock, or an ABI below 7.
pub(crate) const EXIT_UNSUPPORTED: i32 = 76;
/// The spec handed over by the extension is unusable.
pub(crate) const EXIT_BAD_SPEC: i32 = 77;
/// The sandbox could not be set up, so the command must not run.
pub(crate) const EXIT_SANDBOX_FAILED: i32 = 78;
/// The command tree stopped using CPU and was killed by the stall watchdog.
///
/// Distinct from a timeout on purpose: exit status alone cannot tell a hung command from
/// a slow one, and this one comes with an explanation on stderr.
pub(crate) const EXIT_STALLED: i32 = 79;
/// The command itself could not be executed.
const EXIT_EXEC_FAILED: i32 = 127;

const USAGE: &str = "\
usage:
  pi-subagents-extend-helper --describe
  pi-subagents-extend-helper [--spec <file|->] [--] <command> [args...]

  --describe       print the sandbox capabilities as JSON and exit
  --spec <file>    read the sandbox spec from <file>; '-' reads standard input
  --probe-userns   internal: report whether a user namespace can be created
  --version        print the helper version
";

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match args.first().and_then(|arg| arg.to_str()) {
        Some("--describe") => describe(),
        Some("--probe-userns") => match namespace::probe() {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("pi-subagents-extend-helper: {error}");
                1
            }
        },
        Some("--version") | Some("-V") => {
            println!("pi-subagents-extend-helper {}", env!("CARGO_PKG_VERSION"));
            0
        }
        Some("--help") | Some("-h") | None => {
            print!("{USAGE}");
            0
        }
        Some("--spec") => match run_with_spec(&args[1..]) {
            Ok(code) => code,
            Err((code, message)) => {
                eprintln!("pi-subagents-extend-helper: {message}");
                code
            }
        },
        Some(other) => {
            eprintln!("pi-subagents-extend-helper: unknown option {other}\n\n{USAGE}");
            EXIT_BAD_SPEC
        }
    }
}

/// Everything after `--spec <where>`: the spec source, then the command.
fn run_with_spec(args: &[OsString]) -> Result<i32, (i32, String)> {
    let (source, rest) = args
        .split_first()
        .ok_or((EXIT_BAD_SPEC, "--spec needs a file or '-'".to_string()))?;
    let source = source.to_string_lossy().into_owned();
    let text = if source == "-" {
        let mut buffer = String::new();
        std::io::stdin().read_to_string(&mut buffer).map_err(|e| {
            (
                EXIT_BAD_SPEC,
                format!("cannot read the spec from stdin: {e}"),
            )
        })?;
        buffer
    } else {
        std::fs::read_to_string(&source)
            .map_err(|e| (EXIT_BAD_SPEC, format!("cannot read the spec {source}: {e}")))?
    };
    let spec = Spec::parse(&text).map_err(|e| (EXIT_BAD_SPEC, e))?;

    // An explicit `--` separates the spec from the command; without it the
    // first remaining argument is already the command.
    let command: &[OsString] = match rest.first().and_then(|arg| arg.to_str()) {
        Some("--") => &rest[1..],
        _ => rest,
    };
    let (program, program_args) = command
        .split_first()
        .ok_or((EXIT_BAD_SPEC, "no command given after the spec".to_string()))?;

    // 观察结果写在 spec 旁边：helper 自己知道 spec 的路径，所以「结果放哪」不必进 spec ——
    // 那会让文件名和内容互相依赖（内容要写路径，路径要等写完才知道）。从 stdin 读 spec
    // 时没有路径，也就没有观察。
    let observation = if spec.watch.is_empty() || source == "-" {
        None
    } else {
        Some(watch::Observation {
            result: std::path::PathBuf::from(format!("{source}.observe")),
            roots: spec.watch.clone(),
        })
    };

    apply(program, program_args, &spec, observation)
}

/// Enter the namespaces, then run the command inside the sandbox.
fn apply(
    program: &OsString,
    program_args: &[OsString],
    spec: &Spec,
    observation: Option<watch::Observation>,
) -> Result<i32, (i32, String)> {
    // The mount and PID namespaces are what give the command a private scratch
    // space and hide the host's processes; the network namespace is only entered
    // for an offline command. A host can refuse all of them (some CI runners do),
    // and then the command runs with Landlock alone — see `sandbox::apply`.
    let cwd = spec.cwd.clone();
    let namespaces = match namespace::isolate(spec.offline, cwd.as_deref(), spec.tmp.as_deref()) {
        Ok(isolated) => {
            // 私有 tmpfs 挂上之后，落在它下面的写授权就不存在了：那里只有 tmpfs 的空根。
            // 早先这表现为 Landlock 报 "spec path ... does not exist" —— 读起来像 spec 里写错了
            // 路径，实际原因是那份授权和这次挂载互相抵消。在命令跑起来之前点名原因，
            // 退出码沿用「spec 不可用」，调用方才不会把它当成可以重试的沙箱故障。
            if let Some((grant, dir)) =
                namespace::resolved_hidden_grant(&spec.write, &isolated.privatised)
            {
                return Err((
                    EXIT_BAD_SPEC,
                    format!(
                        "spec write grant {} is hidden by the private tmpfs mounted over {}; \
                         a grant under a privately mounted tmpfs cannot take effect",
                        grant.display(),
                        dir.display()
                    ),
                ));
            }
            // Always let an offline command say whether its namespaces are
            // real: that is the difference between a structural "no route
            // out" and Landlock's coarse port rules, and a run that says
            // nothing is indistinguishable from one that fell back. The
            // success line itself carries no news after a session's first
            // offline command, though, and it lands in the model's context
            // once per bash call — so the caller sets
            // PI_SUBAGENTS_EXTEND_QUIET_NETWORK_NOTICE=1 on the second and
            // later invocations, and only this success pair goes quiet. The
            // degraded branch below is never silenced: there the warning is
            // news on every single command.
            let quiet = matches!(std::env::var("PI_SUBAGENTS_EXTEND_QUIET_NETWORK_NOTICE").as_deref(), Ok("1"));
            if spec.offline && !quiet {
                let shadowed: Vec<String> = isolated
                    .shadowed
                    .iter()
                    .map(|dir| dir.display().to_string())
                    .collect();
                match shadowed.is_empty() {
                    true => eprintln!(
                        "pi-subagents-extend-helper: network isolated, no resolver sockets to shadow"
                    ),
                    false => eprintln!(
                        "pi-subagents-extend-helper: network isolated, resolver sockets shadowed: {}",
                        shadowed.join(", ")
                    ),
                }
            }
            true
        }
        Err(error) => {
            if spec.offline {
                // Landlock takes over the network cut in this case, so the
                // command is still offline — it just loses the private scratch
                // space and the process hiding that the namespaces would have
                // given it.
                eprintln!(
                    "pi-subagents-extend-helper: warning: cannot enter the namespaces ({error}); \
                     the command runs with Landlock only, TCP still blocked"
                );
            }
            false
        }
    };

    supervise::run(
        || run_command(program, program_args, spec, namespaces),
        namespaces,
        spec.stall_seconds,
        observation,
    )
    .map_err(|e| (EXIT_SANDBOX_FAILED, e))
}

/// Runs as the command, inside the PID namespace, and never returns on success.
fn run_command(
    program: &OsString,
    program_args: &[OsString],
    spec: &Spec,
    namespaces: bool,
) -> i32 {
    if let Some(cwd) = &spec.cwd {
        if let Err(error) = std::env::set_current_dir(cwd) {
            eprintln!(
                "pi-subagents-extend-helper: cannot enter {}: {error}",
                cwd.display()
            );
            return EXIT_SANDBOX_FAILED;
        }
    }

    if let Err(error) = sandbox::apply(spec, namespaces) {
        eprintln!("pi-subagents-extend-helper: {error}");
        return EXIT_UNSUPPORTED;
    }
    // Nothing below needs a capability: the namespaces and mounts are set up,
    // and the sandbox itself is enforced by Landlock.
    if let Err(error) = namespace::drop_capabilities() {
        eprintln!("pi-subagents-extend-helper: {error}");
        return EXIT_SANDBOX_FAILED;
    }

    for (key, value) in &spec.env {
        std::env::set_var(key, value);
    }

    let error = Command::new(program).args(program_args).exec();
    let cwd = match &spec.cwd {
        Some(cwd) => cwd.display().to_string(),
        None => "the current directory".to_string(),
    };
    eprintln!(
        "pi-subagents-extend-helper: cannot execute {} in {cwd}: {error}",
        program.to_string_lossy()
    );
    EXIT_EXEC_FAILED
}

/// Print what this machine can enforce, as JSON, so the extension can gate on
/// it instead of guessing from the kernel version.
fn describe() -> i32 {
    let (report, supported) = report();
    println!("{report}");
    match supported {
        true => 0,
        false => EXIT_UNSUPPORTED,
    }
}

/// What `--describe` prints, and whether the sandbox can run here.
fn report() -> (serde_json::Value, bool) {
    let resolver: Vec<String> = namespace::resolver_dirs()
        .iter()
        .map(|dir| dir.display().to_string())
        .collect();
    let userns = namespace::available();
    let (supported, abi, reason) = match sandbox::abi_or_reason() {
        Ok(abi) => (true, abi, serde_json::Value::Null),
        // Report the ABI the kernel actually has, not 0: the reason already says
        // it is too old, and a caller reading the number should see the truth.
        // 0 is left for the case where Landlock itself is missing.
        Err(reason) => (
            false,
            sandbox::kernel_abi().unwrap_or(0),
            serde_json::Value::from(reason),
        ),
    };
    let report = serde_json::json!({
        "helper": "pi-subagents-extend-helper",
        "version": env!("CARGO_PKG_VERSION"),
        "landlock": {
            "kernel_abi": abi,
            "required_abi": sandbox::REQUIRED_ABI,
            "supported": supported,
            "reason": reason,
        },
        "network_namespace": userns,
        "resolver_sockets": resolver,
    });
    (report, supported)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_command_is_a_usage_error() {
        let args: Vec<OsString> = vec![OsString::from("/dev/null")];
        let error = run_with_spec(&args).expect_err("no command given");
        assert_eq!(error.0, EXIT_BAD_SPEC, "unexpected error: {}", error.1);
    }

    #[test]
    fn a_missing_spec_file_is_a_usage_error() {
        let args: Vec<OsString> = vec![
            OsString::from("/definitely/not/a/spec.json"),
            OsString::from("--"),
            OsString::from("true"),
        ];
        let error = run_with_spec(&args).expect_err("the spec cannot be read");
        assert_eq!(error.0, EXIT_BAD_SPEC, "unexpected error: {}", error.1);
    }

    /// The number is a diagnosis: on an old kernel it has to be the real ABI, not
    /// a placeholder that hides which kernel the user is on.
    #[test]
    fn the_report_carries_the_measured_abi() {
        let (report, supported) = report();
        let reported = report["landlock"]["kernel_abi"].as_i64().unwrap_or(-1);
        match sandbox::kernel_abi() {
            Ok(abi) => assert_eq!(reported, i64::from(abi)),
            // No Landlock at all: there is no number to report.
            Err(_) => {
                assert_eq!(reported, 0);
                assert!(!supported, "a kernel without Landlock is unsupported");
            }
        }
    }
}
