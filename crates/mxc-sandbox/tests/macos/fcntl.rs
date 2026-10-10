use super::support;
use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::PatternMatchTiming;
use ash_sandboxing::SandboxPathAccess;
use ash_sandboxing::SandboxPathRule;
use ash_sandboxing::SandboxScope;
use ash_tool_executor::CommandInput;
use std::fs;
use std::fs::File;
use std::os::macos::fs::MetadataExt;
use std::path::Path;
use test_binary_support::TestBinary;

const FILES: [&str; 3] = ["canary", "work/donor", "receiver"];
const TRANSFER_UNSUPPORTED: &str = "transfer positive control unsupported";

#[derive(Debug, PartialEq, Eq)]
struct Snapshot {
    bytes: Vec<u8>,
    blocks: u64,
    flags: u32,
    modified: (i64, i64),
    changed: (i64, i64),
}

fn snapshots(root: &Path) -> Vec<Snapshot> {
    FILES
        .iter()
        .map(|name| {
            let path = root.join(name);
            let metadata = fs::metadata(&path).unwrap();
            Snapshot {
                bytes: fs::read(path).unwrap(),
                blocks: metadata.st_blocks(),
                flags: metadata.st_flags(),
                modified: (metadata.st_mtime(), metadata.st_mtime_nsec()),
                changed: (metadata.st_ctime(), metadata.st_ctime_nsec()),
            }
        })
        .collect()
}

#[test]
fn restricted_filesystems_deny_mutating_fcntls_through_readonly_descriptors() {
    let helper = TestBinary::test(module_path!(), "fcntl_child").unwrap();
    for access in [
        None,
        Some(FileSystemAccess::ReadOnly),
        Some(FileSystemAccess::DirectoryWrite),
        Some(FileSystemAccess::FullAccess),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let work = temp.path().join("work");
        fs::create_dir(&work).unwrap();
        fs::write(temp.path().join(FILES[0]), "outside canary").unwrap();
        fs::write(temp.path().join(FILES[2]), []).unwrap();
        fs::write(
            work.join("expectation"),
            if access.is_some() { "deny" } else { "allow" },
        )
        .unwrap();
        // Keep the descriptor live until verification: closing its last owner
        // can release the donor's unused preallocation beyond EOF.
        let donor = File::create(temp.path().join(FILES[1])).unwrap();
        syscalls::allocate(&donor);
        let before = snapshots(temp.path());
        assert!(before[1].blocks > 0);
        let (status, stdout, stderr) = match access {
            None => {
                let output = helper.command().current_dir(&work).output().unwrap();
                (
                    output.status.code(),
                    String::from_utf8(output.stdout).unwrap(),
                    String::from_utf8(output.stderr).unwrap(),
                )
            }
            Some(access) => {
                let scope = if access == FileSystemAccess::FullAccess {
                    let dir = Dir::open_local(temp.path()).unwrap();
                    SandboxScope::single(dir.clone())
                        .with_path_rules(vec![
                            SandboxPathRule::pattern(
                                dir,
                                "**/{canary,donor,receiver}",
                                SandboxPathAccess::ReadOnly,
                                PatternMatchTiming::Continuous,
                            )
                            .unwrap(),
                        ])
                        .unwrap()
                } else {
                    support::scope(&work)
                };
                let output = support::run(
                    &scope,
                    access,
                    helper.executable(),
                    helper
                        .arguments()
                        .iter()
                        .map(|argument| argument.to_str().unwrap().into())
                        .collect(),
                    CommandInput::Closed,
                )
                .unwrap();
                (output.exit_code, output.stdout, output.stderr)
            }
        };
        assert_eq!(status, Some(0), "{access:?}: {stdout}; {stderr}");
        assert!(stdout.contains("fcntl probes completed"));
        let after = snapshots(temp.path());
        if access.is_some() {
            assert_eq!(after, before, "restricted fcntls changed canaries");
        } else {
            assert!(
                after[0].bytes.is_empty(),
                "positive compression control must truncate"
            );
            if stdout.contains(TRANSFER_UNSUPPORTED) {
                assert_eq!(
                    &after[1..],
                    &before[1..],
                    "unsupported transfer must preserve both files"
                );
            } else {
                assert!(
                    after[1].blocks < before[1].blocks,
                    "positive control must move extents"
                );
                assert!(
                    after[2].blocks > before[2].blocks,
                    "receiver must gain extents"
                );
            }
        }
        drop(donor);
    }
}

#[test]
#[ignore = "child entry selected only by the parent fcntl regression"]
fn fcntl_child() {
    // FullAccess's continuous rules are rooted above work; the other modes
    // already launch there. This changes cwd only in the dedicated subprocess.
    if Path::new("work/expectation").exists() {
        std::env::set_current_dir("work").unwrap();
    }
    let denied = match fs::read_to_string("expectation").unwrap().as_str() {
        "deny" => true,
        "allow" => false,
        other => panic!("invalid fcntl expectation {other:?}"),
    };
    syscalls::probe(denied);
    println!("fcntl probes completed");
}

// The only unsafe exception in this package is this test-only macOS ABI
// boundary. The production library and its unit tests retain forbid(unsafe_code).
#[allow(unsafe_code)]
mod syscalls {
    use std::fs;
    use std::fs::File;
    use std::io;
    use std::mem::size_of_val;
    use std::os::fd::AsRawFd;

    pub(super) fn allocate(file: &File) {
        let mut allocation = libc::fstore_t {
            fst_flags: libc::F_ALLOCATEALL,
            fst_posmode: libc::F_PEOFPOSMODE,
            fst_offset: 0,
            fst_length: 65536,
            fst_bytesalloc: 0,
        };
        // SAFETY: F_PREALLOCATE receives a live fstore_t with the platform layout.
        let result =
            unsafe { libc::fcntl(file.as_raw_fd(), libc::F_PREALLOCATE, &raw mut allocation) };
        assert_eq!(
            result,
            0,
            "preallocate donor: {}",
            io::Error::last_os_error()
        );
    }

    pub(super) fn probe(denied: bool) {
        let files = ["../canary", "donor", "../receiver"].map(|path| {
            fs::OpenOptions::new()
                .read(true)
                .write(!denied)
                .open(path)
                .unwrap()
        });
        for file in &files {
            // SAFETY: F_GETFL takes a live descriptor and no variadic argument.
            let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
            assert!(flags >= 0);
            assert_eq!(
                flags & libc::O_ACCMODE,
                if denied { libc::O_RDONLY } else { libc::O_RDWR }
            );
        }
        if denied {
            let error = fs::OpenOptions::new()
                .write(true)
                .open("../canary")
                .unwrap_err();
            assert_eq!(error.raw_os_error(), Some(libc::EPERM));
        }
        let mut attributes = libc::attrlist {
            bitmapcount: 5,
            reserved: 0,
            commonattr: libc::ATTR_CMN_GEN_COUNT,
            volattr: 0,
            dirattr: 0,
            fileattr: 0,
            forkattr: 0,
        };
        let mut generation = [0_u32; 2];
        // SAFETY: both buffers match the ABI and sizes requested by fgetattrlist.
        let result = unsafe {
            libc::fgetattrlist(
                files[0].as_raw_fd(),
                (&raw mut attributes).cast(),
                generation.as_mut_ptr().cast(),
                size_of_val(&generation),
                libc::FSOPT_ATTR_CMN_EXTENDED,
            )
        };
        assert_eq!(
            result,
            0,
            "generation query: {}",
            io::Error::last_os_error()
        );
        assert_eq!(generation[0] as usize, size_of_val(&generation));
        for (fd, selector, argument) in [
            (files[0].as_raw_fd(), 80, generation[1]),
            (
                files[1].as_raw_fd(),
                libc::F_TRANSFEREXTENTS,
                files[2].as_raw_fd() as u32,
            ),
        ] {
            // SAFETY: these selectors take numeric arguments; all fds remain live.
            let result = unsafe { libc::fcntl(fd, selector, argument) };
            let error = io::Error::last_os_error().raw_os_error();
            if denied {
                assert_eq!((result, error), (-1, Some(libc::EPERM)), "fcntl {selector}");
            } else if selector == libc::F_TRANSFEREXTENTS
                && result == -1
                && matches!(error, Some(libc::ENOTSUP) | Some(libc::EINVAL))
            {
                println!("{}", super::TRANSFER_UNSUPPORTED);
            } else {
                assert_eq!(result, 0, "fcntl {selector}: {error:?}");
            }
        }
    }
}
