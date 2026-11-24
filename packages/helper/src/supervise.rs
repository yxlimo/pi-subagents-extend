//! Process supervision for the PID namespace.
//!
//! Unsharing a PID namespace only takes effect for children, and the command
//! cannot be that first child: PID 1 of a namespace does not get default-action
//! signals, so `kill <helper>` would leave a shell that ignores SIGTERM.
//!
//! The tree is therefore three levels deep, the same shape bubblewrap uses:
//!
//! ```text
//! caller ── helper ──┬─ init   (PID 1 in the namespace, forwards signals)
//!                    │   └─ the command (PID 2+, replaced via execve)
//!                    └─ waits, mirrors the exit status
//! ```

use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

/// Set by the supervisor once the command is running.
static COMMAND_PID: AtomicI32 = AtomicI32::new(0);

/// Run `child_main` as the sandboxed command and return its exit status.
///
/// `child_main` is expected to `exec`; returning from it means the command could
/// not be started, and the returned value becomes the exit status.
pub fn run(
    child_main: impl FnOnce() -> i32,
    fresh_proc: bool,
    stall: Option<u64>,
    observation: Option<crate::watch::Observation>,
) -> Result<i32, String> {
    match unsafe { libc::fork() } {
        -1 => Err(format!(
            "cannot fork the sandbox init: {}",
            std::io::Error::last_os_error()
        )),
        0 => supervisor(child_main, fresh_proc, stall, observation),
        pid => Ok(decode(wait_for(pid)?)),
    }
}

/// The PID 1 of the new namespace: mount a fresh procfs, then supervise.
fn supervisor(
    child_main: impl FnOnce() -> i32,
    fresh_proc: bool,
    stall: Option<u64>,
    observation: Option<crate::watch::Observation>,
) -> ! {
    // If the caller dies, the whole namespace must die with it, otherwise the
    // command is orphaned inside a namespace nobody can reach.
    unsafe {
        libc::prctl(
            libc::PR_SET_PDEATHSIG,
            libc::SIGKILL as libc::c_ulong,
            0,
            0,
            0,
        )
    };

    // A fresh procfs is only meaningful inside a PID namespace: it shows that
    // namespace's processes. Without one the process is still in the host's, so
    // mounting over /proc would fail and hide nothing.
    if fresh_proc {
        if let Err(error) = crate::namespace::mount_proc() {
            eprintln!("pi-subagents-extend-helper: {error}");
            unsafe { libc::_exit(crate::EXIT_SANDBOX_FAILED) }
        }
    }

    // PID 1 only receives a signal when it has a handler installed, so the
    // default dispositions have to be replaced with forwarding ones.
    for signal in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP, libc::SIGQUIT] {
        unsafe { libc::signal(signal, forward as *const () as libc::sighandler_t) };
    }

    // 观察必须在命令 fork 之前挂好：写事件只有在 watch 建立之后才会入队，晚一步就漏掉
    // 命令开头写的东西。drain 线程与此同时开始等待，所以命令退出时事件已经在缓冲区里。
    let watch = observation
        .as_ref()
        .and_then(|observation| crate::watch::Watch::new(&observation.roots));
    if let Some(watch) = &watch {
        watch.start();
    }

    match unsafe { libc::fork() } {
        -1 => {
            eprintln!(
                "pi-subagents-extend-helper: cannot start the command: {}",
                std::io::Error::last_os_error()
            );
            unsafe { libc::_exit(crate::EXIT_SANDBOX_FAILED) }
        }
        0 => {
            let code = child_main();
            unsafe { libc::_exit(code) }
        }
        pid => {
            COMMAND_PID.store(pid, Ordering::SeqCst);
            let code = match stall {
                Some(seconds) if seconds > 0 => match wait_with_stall(pid, seconds, fresh_proc) {
                    Ok(code) => code,
                    Err(error) => {
                        eprintln!("pi-subagents-extend-helper: {error}");
                        crate::EXIT_SANDBOX_FAILED
                    }
                },
                _ => match wait_for(pid) {
                    Ok(status) => decode(status),
                    Err(error) => {
                        eprintln!("pi-subagents-extend-helper: {error}");
                        crate::EXIT_SANDBOX_FAILED
                    }
                },
            };
            // 观察结果在命令退出后交给调用方：`None` 表示这次根本没观察（没要求，
            // 或内核不给 inotify 实例），`watched: 0` 表示根目录都不存在、空事件
            // 说明不了任何事。两种情况都不能被误读成「没写过」。
            if let Some(target) = observation.as_ref().map(|o| o.result.as_path()) {
                let (wrote, watched) = match &watch {
                    Some(watch) => (Some(watch.finish()), watch.dirs()),
                    None => (None, 0),
                };
                crate::watch::write_result(target, wrote, watched);
            }
            unsafe { libc::_exit(code) }
        }
    }
}

/// Wait for the command while watching its CPU time, and kill the tree when it stops using any.
///
/// A wall-clock limit cannot tell a long compile from a deadlock; CPU time can. A tree that is
/// working accumulates CPU in every sample, a deadlocked one accumulates none — it waits on a lock, a
/// socket, or a child that died without closing a pipe. The supervisor is the only process that sees
/// the whole subtree (it is PID 1 of the namespace), so the measurement belongs here.
///
/// This is opt-in and it has an honest blind spot: a command that deliberately sleeps (
/// `sleep 300`, a poll loop backing off) also uses no CPU, and the helper cannot see output — stdio is
/// inherited, not piped — so "no output" cannot corroborate it. That is why the extension leaves it
/// off unless a caller asks for it.
/// 采样间隔，同时也是「命令是否已经退出」的检查间隔。
///
/// 两者共用同一个循环，所以这个间隔直接决定每条命令完成后的额外延迟上限——早先它取
/// `阈值 / 4`，`stallSeconds: 90` 时就是 22.5 秒，一个 `true` 要 22.5 秒才回到调用方。
/// 现在钉在 [250ms, 1s]：扫一遍 `/proc` 只要微秒级，密一点不贵，而上限保证退出延迟不超过
/// 一秒。`stall_seconds` 为 0 不会走到这里（调用方保证 > 0）。
fn poll_period(stall_seconds: u64) -> Duration {
    Duration::from_millis(250)
        .max(Duration::from_secs(stall_seconds) / 4)
        .min(Duration::from_secs(1))
}

fn wait_with_stall(
    pid: libc::pid_t,
    stall_seconds: u64,
    private_proc: bool,
) -> Result<i32, String> {
    let period = poll_period(stall_seconds);
    let limit = Duration::from_secs(stall_seconds);
    let mut cpu = tree_cpu(pid, private_proc);
    let mut quiet_since = Instant::now();
    loop {
        if let Some(status) = try_wait(pid)? {
            return Ok(decode(status));
        }
        std::thread::sleep(period);
        if let Some(status) = try_wait(pid)? {
            return Ok(decode(status));
        }
        let now = tree_cpu(pid, private_proc);
        if now > cpu {
            cpu = now;
            quiet_since = Instant::now();
            continue;
        }
        if quiet_since.elapsed() < limit {
            continue;
        }
        eprintln!(
            "pi-subagents-extend-helper: cpu stall: the command tree used no CPU for {} s while still running; killing it (a working build would have used CPU — this is usually a lock, a socket, or an orphaned child, not a slow compile)",
            stall_seconds
        );
        kill_tree(pid, private_proc); // Reap what we killed so the exit status we report is ours, not a stray SIGCHLD.
        let _ = wait_for(pid);
        return Ok(crate::EXIT_STALLED);
    }
}

/// `waitpid` without blocking; `None` means the child is still running.
fn try_wait(pid: libc::pid_t) -> Result<Option<libc::c_int>, String> {
    let mut status: libc::c_int = 0;
    loop {
        let reaped = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
        if reaped == pid {
            return Ok(Some(status));
        }
        if reaped == 0 {
            return Ok(None);
        }
        if reaped < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(format!("cannot wait for the command: {error}"));
        }
    }
}

/// Cumulative CPU (utime + stime, in clock ticks) of the command and every descendant.
///
/// With a private procfs the whole table is the namespace, so summing every entry is both correct
/// and cheap. Without one the table is the host's, where summing everything would let unrelated
/// work mask a stall — there the walk follows parent links from the command instead.
fn tree_cpu(root: libc::pid_t, private_proc: bool) -> u64 {
    let stats = proc_stats();
    let self_pid = std::process::id() as libc::pid_t;
    if private_proc {
        // 私有 procfs 里就是这棵子树，但**包括我们自己**——supervisor 是那个每轮采样两次
        // 的进程，它的 CPU 如果算进来，采样自身的开销就可能让 `now > cpu` 每轮都成立，
        // 于是永远不判定为空闲。这正是大构建树（表格大、扫描贵）最会出问题的场景。
        return stats
            .iter()
            .filter(|s| s.pid != self_pid)
            .map(ProcStat::total)
            .sum();
    }
    let mut total = 0;
    let mut frontier = vec![root];
    let mut seen = 0usize;
    while let Some(pid) = frontier.pop() {
        seen += 1;
        if seen > 4096 {
            break;
        }
        if let Some(stat) = stats.iter().find(|s| s.pid == pid) {
            total += stat.total();
        }
        for stat in &stats {
            if stat.ppid == pid {
                frontier.push(stat.pid);
            }
        }
    }
    total
}

/// Kill every process of the command tree, deepest last. PID 1 exiting would take the namespace with
/// it, but the host case has no such guarantee.
fn kill_tree(root: libc::pid_t, private_proc: bool) -> bool {
    let stats = proc_stats();
    let self_pid = std::process::id() as libc::pid_t;
    // 先把根杀掉：下面的快照可能读空（`read_dir(/proc)` 失败就是空表），那样就什么也没杀，
    // 而紧接着的 `wait_for` 会永久阻塞 —— 看门狗反过来把 helper 挂着。
    unsafe { libc::kill(root, libc::SIGKILL) };
    if !private_proc {
        let mut frontier = vec![root];
        let mut seen = 0usize;
        while let Some(pid) = frontier.pop() {
            seen += 1;
            if seen > 4096 {
                break;
            }
            unsafe { libc::kill(pid, libc::SIGKILL) };
            for stat in &stats {
                if stat.ppid == pid {
                    frontier.push(stat.pid);
                }
            }
        }
        return true;
    }
    for stat in &stats {
        if stat.pid != self_pid {
            unsafe { libc::kill(stat.pid, libc::SIGKILL) };
        }
    }
    // 根已单独杀过，表为空也能保证至少杀了它。
    true
}

struct ProcStat {
    pid: libc::pid_t,
    ppid: libc::pid_t,
    utime: u64,
    stime: u64,
    cutime: u64,
    cstime: u64,
}

impl ProcStat {
    /// 这个进程累计消耗的 CPU，**包含已回收子进程的时间**。
    ///
    /// 只算 `utime + stime` 会让总量不单调：短命的子进程（`make` 每个编译单元、测试框架里
    /// 成百上千个一闪而过的二进制）在两次采样之间就退出了，它们的 CPU 从总和里消失，
    /// 于是一棵正在干活的树看起来和卡住一样 —— 误杀。`cutime`/`cstime` 正是把这些时间
    /// 结转到父进程的字段。
    fn total(&self) -> u64 {
        self.utime + self.stime + self.cutime + self.cstime
    }
}

/// Read `/proc/<pid>/stat` for every process visible in `/proc`.
fn proc_stats() -> Vec<ProcStat> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|n| n.parse::<libc::pid_t>().ok()) else {
            continue;
        };
        let Ok(text) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        if let Some(stat) = parse_stat(pid, &text) {
            out.push(stat);
        }
    }
    out
}

/// Parse the fields of `/proc/<pid>/stat` that matter here.
///
/// The second field is the executable name in parentheses and may itself contain spaces and
/// parentheses, so everything before the last `)` has to be skipped rather than split on whitespace.
fn parse_stat(pid: libc::pid_t, text: &str) -> Option<ProcStat> {
    let close = text.rfind(')')?;
    let rest: Vec<&str> = text[close + 1..].split_whitespace().collect();
    // After the name come state, ppid, pgrp, session, tty, tpgid, flags, minflt, cminflt, majflt,
    // cmajflt, utime, stime, cutime, cstime: state is index 0, so ppid is 1, utime 11, stime 12,
    // cutime 13, cstime 14.
    let ppid = rest.get(1)?.parse().ok()?;
    let utime = rest.get(11)?.parse().ok()?;
    let stime = rest.get(12)?.parse().ok()?;
    let cutime = rest.get(13)?.parse().ok()?;
    let cstime = rest.get(14)?.parse().ok()?;
    Some(ProcStat {
        pid,
        ppid,
        utime,
        stime,
        cutime,
        cstime,
    })
}

/// Hand a signal that reached the supervisor to the command.
extern "C" fn forward(signal: libc::c_int) {
    let pid = COMMAND_PID.load(Ordering::SeqCst);
    if pid > 0 {
        unsafe { libc::kill(pid, signal) };
    }
}

/// Wait for one child, retrying across signal interruptions.
fn wait_for(pid: libc::pid_t) -> Result<libc::c_int, String> {
    let mut status: libc::c_int = 0;
    loop {
        let reaped = unsafe { libc::waitpid(pid, &mut status, 0) };
        if reaped == pid {
            return Ok(status);
        }
        if reaped < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(format!("cannot wait for the command: {error}"));
        }
    }
}

/// Turn a `waitpid` status into the exit code the caller sees. A command killed
/// by signal N follows the shell convention of 128 + N.
fn decode(status: libc::c_int) -> i32 {
    if libc::WIFEXITED(status) {
        libc::WEXITSTATUS(status)
    } else if libc::WIFSIGNALED(status) {
        128 + libc::WTERMSIG(status)
    } else {
        crate::EXIT_SANDBOX_FAILED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_exit_code_is_mirrored() {
        assert_eq!(decode(0), 0);
        // 0x0100 is the wait status of exit(1).
        assert_eq!(decode(0x0100), 1);
    }

    #[test]
    fn a_signal_death_becomes_128_plus_signal() {
        // SIGKILL (9) without the exited bit.
        assert_eq!(decode(9), 137);
    }

    #[test]
    fn a_stat_line_with_parentheses_in_the_name_still_parses() {
        // 第二个字段是带括号的可执行名，名字里可以出现空格和括号 —— 按空白切分必然错位，
        // 所以必须从最后一个 ')' 之后开始读。这里用一个真实会出现的形状：编译器驱动进程。
        // 尾两位是 cutime/cstime：不下标错就只有靠它们才能钉住，早先这里是 `0 0`，
        // 于是「读错一位」也能通过，而那样一来 cutime 的修复就等于没做。
        let line = "4242 (cc1plus (worker)) S 4200 4242 4242 0 -1 4194560 1 0 0 0 1234 567 89 10";
        let stat = parse_stat(4242, line).expect("parses");
        assert_eq!(stat.ppid, 4200);
        assert_eq!(stat.utime, 1234);
        assert_eq!(stat.stime, 567);
        assert_eq!(stat.cutime, 89);
        assert_eq!(stat.cstime, 10);
        assert_eq!(stat.total(), 1900, "reaped children stay in the sum");
    }

    #[test]
    fn the_poll_period_is_bounded_at_both_ends() {
        // 下界保证不空转，上界保证退出检测的延迟不超过一秒 —— 这就是 22.5 秒那条 bug 的回归线。
        assert_eq!(poll_period(1), Duration::from_millis(250));
        assert_eq!(poll_period(2), Duration::from_millis(500));
        assert_eq!(poll_period(4), Duration::from_secs(1));
        assert_eq!(poll_period(90), Duration::from_secs(1));
        assert_eq!(poll_period(86_400), Duration::from_secs(1));
    }

    #[test]
    fn a_truncated_stat_line_parses_to_nothing() {
        assert!(parse_stat(1, "1 (init) S").is_none());
    }
}
