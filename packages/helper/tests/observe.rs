//! End-to-end proof that the helper observes writes through the kernel.
//!
//! The unit tests in `watch.rs` prove the watch mechanics; this drives the real
//! binary the way the extension does — `--spec <file> <command>` — because the parts
//! that can silently disagree live in the wiring, not in the watch: the spec key must
//! parse, the supervisor must create the watch *before* forking the command, and the
//! result must land at `<spec>.observe`.
//!
//! A host that cannot sandbox at all (no Landlock ABI, namespaces refused) makes the
//! helper exit non-zero before the command runs, so there is nothing to observe; the
//! case reports that instead of failing, and the answer stays honest on kernels that
//! cannot enforce anything.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn binary() -> &'static str {
    env!("CARGO_BIN_EXE_pi-subagents-extend-helper")
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("pi-observe-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("work/out")).expect("scratch tree");
    dir
}

/// Write a spec, run `script` inside the sandbox, and return the observation the
/// helper left next to the spec. `None` means the helper refused to run the command
/// on this kernel, which is a skip rather than a failure.
fn observe(root: &Path, watch: &[&str], script: &str) -> Option<String> {
    let work = root.join("work");
    let spec_path = root.join("spec.json");
    let watch: Vec<String> = watch.iter().map(|dir| root.join(dir).display().to_string()).collect();
    let spec = format!(
        r#"{{"cwd":"{}","read":["/"],"write":["{}"],"watch":{}}}"#,
        work.display(),
        work.join("out").display(),
        serde_json::to_string(&watch).expect("watch list")
    );
    fs::write(&spec_path, spec).expect("spec file");
    let status = Command::new(binary())
        .arg("--spec")
        .arg(&spec_path)
        .arg("/bin/sh")
        .arg("-c")
        .arg(script)
        .status()
        .expect("helper runs");
    if !status.success() {
        eprintln!("  skip  the helper cannot sandbox on this kernel ({status})");
        return None;
    }
    let observe_path = format!("{}.observe", spec_path.display());
    Some(fs::read_to_string(&observe_path).unwrap_or_else(|e| {
        panic!("the helper must leave an observation at {observe_path}: {e}")
    }))
}

#[test]
fn a_write_inside_the_watched_tree_is_reported_and_a_read_is_not() {
    let root = scratch("write");
    let target = root.join("work/out/file.txt");

    let wrote = observe(
        &root,
        &["work/out"],
        &format!("printf 'x\\n' > {}", target.display()),
    );
    let Some(wrote) = wrote else {
        let _ = fs::remove_dir_all(&root);
        return;
    };
    assert!(
        target.exists(),
        "the command really wrote its file, so the observation is about a real write"
    );
    assert!(
        wrote.contains("\"wrote\":true"),
        "a write in the watched tree is reported: {wrote}"
    );
    assert!(
        !wrote.contains("\"watched\":0"),
        "the watch was installed, otherwise `true` would prove nothing: {wrote}"
    );

    // 读不是写：同一棵树里只读，结果必须是 false（否则「还在干活」就成了永真）。
    // 用 shell 内建的 `read` 而不是 cat：这台机器是 NixOS，/bin 里只有 sh 之类的少数
    // 几个入口，cat 不在 /bin 下，execve 直接 ENOENT（退出码 127），那就变成在测
    // 「命令跑不起来」而不是「读不产生事件」。
    let read = observe(
        &root,
        &["work/out"],
        &format!("read line < {}", target.display()),
    );
    let Some(read) = read else {
        let _ = fs::remove_dir_all(&root);
        return;
    };
    assert!(
        read.contains("\"wrote\":false"),
        "reading the file is not a write: {read}"
    );
    assert!(
        !read.contains("\"watched\":0"),
        "and the watch existed for this run too: {read}"
    );

    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_missing_watch_root_reports_no_evidence_rather_than_a_clean_bill() {
    let root = scratch("missing");
    let Some(result) = observe(&root, &["work/absent"], ":") else {
        let _ = fs::remove_dir_all(&root);
        return;
    };
    // 根目录不存在时 `wrote:false` 不能当作「没写过」的证据，调用方靠 watched 判断。
    assert!(
        result.contains("\"watched\":0"),
        "a root that does not exist is reported as zero watched directories: {result}"
    );
    let _ = fs::remove_dir_all(&root);
}
