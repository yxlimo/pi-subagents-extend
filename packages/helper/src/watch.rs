//! Kernel-side evidence that the command changed something on disk.
//!
//! The extension's probe asks "is this agent still working?", and the answer used to
//! come from the tool calls: a bash command it judged a writer counted as progress.
//! That judgement is gone with the read/write classification — and a guess is the
//! wrong shape for a question the kernel can answer exactly. An inotify watch on the
//! directories the task may write says whether the command touched any of them.
//!
//! The watch lives in the supervisor (PID 1 of the namespace), not in the command:
//! only the supervisor outlives the `exec`, and `IN_CLOEXEC` keeps the descriptor out
//! of the command's hands so nothing can see or drain the evidence. The draining runs
//! in its own thread so the supervisor still blocks in `waitpid` and commands keep
//! their exit latency; `finish` does one last synchronous drain for whatever landed
//! between the last event wakeup and the exit.
//!
//! The honest blind spot: a command that writes only outside the watched roots looks
//! idle here. Watched roots are the write scope, and the scope is what the task is
//! meant to change, so that is the right set — but `watched: 0` (the roots do not
//! exist) means an empty event log proves nothing, which is why the count travels
//! with the answer instead of being dropped.

use std::ffi::CString;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
/// Ceiling on watched directories: a write scope can name a tree a build fills with
/// thousands of directories, and every watch costs kernel memory.
const MAX_WATCHES: usize = 2048;
/// Depth ceiling; deeper directories are not watched.
const MAX_DEPTH: u32 = 8;
/// Wakeup interval of the drain thread when nothing happens. Events wake it at once,
/// so this only bounds how quickly it notices that the process is gone.
const POLL_MS: libc::c_int = 200;

const MASK: u32 = libc::IN_CREATE
    | libc::IN_MODIFY
    | libc::IN_CLOSE_WRITE
    | libc::IN_DELETE
    | libc::IN_MOVED_FROM
    | libc::IN_MOVED_TO
    | libc::IN_ATTRIB;

/// Where the observation goes and which directories are worth watching.
pub struct Observation {
    pub result: PathBuf,
    pub roots: Vec<PathBuf>,
}

pub struct Watch {
    fd: libc::c_int,
    dirs: usize,
    seen: Arc<AtomicBool>,
}

impl Watch {
    /// Watch every root (recursively) or return `None` when the kernel refuses an
    /// inotify instance. `None` means "no evidence", never "nothing was written".
    pub fn new(roots: &[PathBuf]) -> Option<Watch> {
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if fd < 0 {
            return None;
        }
        let mut watch = Watch {
            fd,
            dirs: 0,
            seen: Arc::new(AtomicBool::new(false)),
        };
        for root in roots {
            watch.add_tree(root, 0);
        }
        Some(watch)
    }

    /// Number of directories actually watched. Zero means the roots did not exist,
    /// so an empty event log is not evidence of anything.
    pub fn dirs(&self) -> usize {
        self.dirs
    }

    /// Start draining. Called in the supervisor before the command forks.
    pub fn start(&self) {
        let fd = self.fd;
        let seen = Arc::clone(&self.seen);
        std::thread::spawn(move || {
            let mut poll_fd = libc::pollfd {
                fd,
                events: libc::POLLIN,
                revents: 0,
            };
            loop {
                let ready = unsafe { libc::poll(&mut poll_fd, 1, POLL_MS) };
                if ready < 0 {
                    if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                        continue;
                    }
                    return;
                }
                if ready == 0 {
                    continue;
                }
                if !drain(fd, &seen) {
                    return;
                }
            }
        });
    }

    /// Final answer: one last synchronous drain, then the latched flag.
    pub fn finish(&self) -> bool {
        drain(self.fd, &self.seen);
        self.seen.load(Ordering::Relaxed)
    }

    fn add(&mut self, dir: &Path) -> bool {
        if self.dirs >= MAX_WATCHES {
            return false;
        }
        let Ok(path) = CString::new(dir.as_os_str().as_bytes()) else {
            return false;
        };
        let wd = unsafe { libc::inotify_add_watch(self.fd, path.as_ptr(), MASK) };
        if wd < 0 {
            return false;
        }
        self.dirs += 1;
        true
    }

    fn add_tree(&mut self, dir: &Path, depth: u32) {
        // 根目录不存在不算错：写范围可以指向一个任务还没创建的文件。只是那一条根就
        // 没有证据可言，`dirs()` 会如实反映。
        if depth > MAX_DEPTH || !self.add(dir) {
            return;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                self.add_tree(&entry.path(), depth + 1);
            }
        }
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        unsafe { libc::close(self.fd) };
    }
}

/// Read every queued event, latching `seen`. `false` means the descriptor is finished
/// (a real read error, not the ordinary empty buffer) and draining should stop.
fn drain(fd: libc::c_int, seen: &AtomicBool) -> bool {
    let mut buffer = [0u8; 4096];
    loop {
        let read = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
        if read > 0 {
            seen.store(true, Ordering::Relaxed);
            continue;
        }
        if read == 0 {
            return false;
        }
        let error = std::io::Error::last_os_error();
        return match error.kind() {
            std::io::ErrorKind::Interrupted => continue,
            std::io::ErrorKind::WouldBlock => true,
            _ => false,
        };
    }
}

/// Hand the answer to the extension. Best effort: a missing file reads as "no
/// evidence", which is the same conclusion the extension draws from `watched: 0`.
pub fn write_result(path: &Path, wrote: Option<bool>, watched: usize) {
    let wrote = match wrote {
        Some(true) => "true",
        Some(false) => "false",
        None => "null",
    };
    let _ = fs::write(path, format!("{{\"wrote\":{wrote},\"watched\":{watched}}}\n"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pi-watch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_missing_root_is_no_watch_rather_than_an_error() {
        let dir = scratch("missing");
        let watch = Watch::new(&[dir.join("nope")]).expect("inotify is available on linux");
        assert_eq!(watch.dirs(), 0, "a root that does not exist cannot be watched");
        assert!(!watch.finish(), "and nothing can be claimed from it");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_inside_a_watched_tree_is_seen() {
        let dir = scratch("write");
        let nested = dir.join("src/nested");
        fs::create_dir_all(&nested).expect("nested dir");
        let watch = Watch::new(&[dir.clone()]).expect("inotify is available on linux");
        assert!(watch.dirs() >= 3, "the tree is watched recursively, got {}", watch.dirs());
        watch.start();
        assert!(!watch.finish(), "an untouched tree reports nothing");
        fs::write(nested.join("file.txt"), "x").expect("write");
        // 轮询线程有自己的唤醒节奏，但 finish 会同步再抽干一次，所以这里不需要等。
        assert!(watch.finish(), "a write in a nested directory is seen");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_and_statting_are_not_writes() {
        let dir = scratch("read");
        let file = dir.join("exists.txt");
        fs::write(&file, "hello").expect("seed file");
        let watch = Watch::new(&[dir.clone()]).expect("inotify is available on linux");
        watch.start();
        let _ = fs::read(&file).expect("read");
        let _ = fs::metadata(&file).expect("stat");
        let _ = fs::read_dir(&dir).expect("list");
        assert!(!watch.finish(), "reading a file is not a write");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_result_names_an_unavailable_answer_as_null() {
        let dir = scratch("result");
        let path = dir.join("obs.json");
        write_result(&path, None, 0);
        assert_eq!(
            fs::read_to_string(&path).expect("result file"),
            "{\"wrote\":null,\"watched\":0}\n"
        );
        write_result(&path, Some(true), 12);
        assert_eq!(
            fs::read_to_string(&path).expect("result file"),
            "{\"wrote\":true,\"watched\":12}\n"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
