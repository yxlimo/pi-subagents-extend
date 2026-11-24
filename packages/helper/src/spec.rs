//! The spec the pi extension hands to the helper.

use serde::Deserialize;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// What the command is allowed to touch.
///
/// The extension writes this as JSON at activation time, so every bash call in
/// the session reuses one file instead of a fresh document per command.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Spec {
    /// Directory the command runs in.
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    /// Paths the command may read and execute through. Empty means nothing is
    /// readable, which is rarely what a caller wants; the extension always
    /// sends at least `/`.
    #[serde(default)]
    pub read: Vec<PathBuf>,
    /// Paths the command may create, change and delete. Everything outside is
    /// read-only, which is the whole point of the sandbox.
    #[serde(default)]
    pub write: Vec<PathBuf>,
    /// Directory that gets a private tmpfs. The extension names the temporary
    /// directory the command's own temp files land in — the host's `TMPDIR`,
    /// which is not always `/tmp` — so the write grant and the mount cannot
    /// disagree. Absent means nothing beyond the conventional `/tmp`, which is
    /// also all a spec written by an older extension knows.
    #[serde(default)]
    pub tmp: Option<PathBuf>,
    /// Run the command without network access. Named for what the helper does,
    /// so the sandbox only ever has to act on a positive condition.
    #[serde(default)]
    pub offline: bool,
    /// Environment variables to set for the command.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// Kill the command tree when it uses no CPU for this many seconds.
    ///
    /// Absent means no watchdog. The extension omits the field unless a caller asked
    /// for it, which also keeps the document readable by a helper built before this
    /// field existed (`deny_unknown_fields` would reject an unknown key, not ignore it).
    #[serde(
        default,
        rename = "stallSeconds",
        skip_serializing_if = "Option::is_none"
    )]
    pub stall_seconds: Option<u64>,
    /// Directories whose writes are observed, so the caller learns whether the command
    /// actually changed anything — a question the kernel answers and no program table
    /// can. Absent means no observation at all, which is the common case.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub watch: Vec<PathBuf>,
}

impl Spec {
    /// Parse a spec document and reject paths that cannot be sandboxed.
    pub fn parse(text: &str) -> Result<Self, String> {
        let spec: Spec =
            serde_json::from_str(text).map_err(|e| format!("spec is not valid JSON: {e}"))?;
        for path in spec
            .read
            .iter()
            .chain(spec.write.iter())
            .chain(spec.tmp.iter())
            .chain(spec.watch.iter())
        {
            if path.is_absolute() {
                if path.as_os_str().to_string_lossy().contains('\0') {
                    return Err(format!("spec path {path:?} contains a NUL byte"));
                }
            } else {
                return Err(format!(
                    "spec path {path:?} is relative; every path must be absolute"
                ));
            }
        }
        if let Some(cwd) = &spec.cwd {
            if !cwd.is_absolute() {
                return Err(format!("spec cwd {cwd:?} is relative; it must be absolute"));
            }
        }
        Ok(spec)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_full_spec() {
        let spec = Spec::parse(
            r#"{"cwd":"/work","read":["/"],"write":["/work/src"],"offline":true,"env":{"A":"b"}}"#,
        )
        .expect("spec should parse");
        assert_eq!(spec.read, vec![PathBuf::from("/")]);
        assert_eq!(spec.write, vec![PathBuf::from("/work/src")]);
        assert!(spec.offline);
        assert_eq!(spec.env.get("A").map(String::as_str), Some("b"));
    }

    #[test]
    fn defaults_are_empty_and_online() {
        let spec = Spec::parse("{}").expect("an empty spec is valid");
        assert!(spec.read.is_empty());
        assert!(spec.write.is_empty());
        assert!(spec.offline == false);
        assert!(spec.cwd.is_none());
    }

    #[test]
    fn rejects_relative_paths() {
        let error =
            Spec::parse(r#"{"write":["src/auth"]}"#).expect_err("relative paths are refused");
        assert!(
            error.contains("must be absolute"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn a_scratch_dir_outside_tmp_is_kept() {
        let spec = Spec::parse(r#"{"tmp":"/var/tmp/pi-scratch"}"#).expect("a tmp path is valid");
        assert_eq!(spec.tmp, Some(PathBuf::from("/var/tmp/pi-scratch")));
        assert!(Spec::parse("{}")
            .expect("an empty spec is valid")
            .tmp
            .is_none());
    }

    #[test]
    fn rejects_a_relative_scratch_dir() {
        let error = Spec::parse(r#"{"tmp":"var/tmp"}"#).expect_err("relative paths are refused");
        assert!(
            error.contains("must be absolute"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn rejects_unknown_keys() {
        let error = Spec::parse(r#"{"writable":"/work"}"#).expect_err("unknown keys are refused");
        assert!(
            error.contains("not valid JSON"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn watched_roots_parse_and_are_absolute() {
        let spec = Spec::parse(r#"{"watch":["/work/src"]}"#).expect("a watch list is valid");
        assert_eq!(spec.watch, vec![PathBuf::from("/work/src")]);
        assert!(
            Spec::parse("{}").expect("an empty spec is valid").watch.is_empty(),
            "no watch list means no observation"
        );
        let error = Spec::parse(r#"{"watch":["src"]}"#).expect_err("relative roots are refused");
        assert!(
            error.contains("must be absolute"),
            "unexpected error: {error}"
        );
    }
}
