use super::*;
use crate::FileSystemAccess;
use crate::NetworkAccess;
use crate::ProcessHandle;
use crate::SandboxDenialTiming;
use crate::SandboxLaunch;
use crate::SandboxManager;
use crate::SandboxProcess;
use crate::SandboxProcessDenial;
use crate::SandboxProcessExitStatus;
use std::io;
use std::io::Read;
use std::io::Write;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

#[derive(Clone, Copy)]
enum Behavior {
    Ready,
    Unsupported,
    Broken,
    Unrestricted,
    SpawnFailure(SandboxDenialTiming),
}

struct Candidate {
    name: &'static str,
    behavior: Behavior,
    only: Option<&'static str>,
    prepares: Arc<AtomicUsize>,
    starts: Arc<AtomicUsize>,
}

impl Candidate {
    fn new(name: &'static str, behavior: Behavior) -> Self {
        Self {
            name,
            behavior,
            only: None,
            prepares: Arc::new(AtomicUsize::new(0)),
            starts: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl SandboxBackend for Candidate {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Restricted
    }
    fn prepare(
        &self,
        command: &SandboxCommand,
        _: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        self.prepares.fetch_add(1, Ordering::SeqCst);
        assert!(command.working_directory().is_absolute());
        if self
            .only
            .is_some_and(|program| command.program() != program)
        {
            return Err(SandboxError::UnsupportedPolicy(self.name.into()));
        }
        match self.behavior {
            Behavior::Unsupported => Err(SandboxError::UnsupportedPolicy(self.name.into())),
            Behavior::Broken => Err(SandboxError::BackendUnavailable {
                backend: self.kind(),
                message: "runtime integrity check failed".into(),
            }),
            Behavior::Unrestricted => Ok(PreparedCommand::unrestricted(command)),
            behavior => Ok(PreparedCommand::sandboxed(
                command,
                Launch {
                    behavior,
                    starts: Arc::clone(&self.starts),
                },
            )),
        }
    }
    fn classify_denial(
        &self,
        _: SandboxProcessExitStatus,
        _: &str,
        _: &str,
    ) -> Option<SandboxProcessDenial> {
        Some(SandboxProcessDenial::process_may_have_started(self.name))
    }
}

struct Launch {
    behavior: Behavior,
    starts: Arc<AtomicUsize>,
}
impl SandboxLaunch for Launch {
    fn spawn(self: Box<Self>, _: &[(String, String)]) -> Result<ProcessHandle, SandboxError> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        if let Behavior::SpawnFailure(timing) = self.behavior {
            return Err(SandboxError::StartFailed {
                timing,
                message: "launch failed".into(),
            });
        }
        Ok(ProcessHandle::new(Completed))
    }
}
struct Completed;
impl SandboxProcess for Completed {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        None
    }
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        None
    }
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        None
    }
    fn try_wait(&mut self) -> io::Result<Option<SandboxProcessExitStatus>> {
        Ok(Some(SandboxProcessExitStatus::Code(1)))
    }
    fn close(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn policy() -> SandboxPolicy {
    SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied)
}
fn manager(candidates: Vec<Candidate>) -> SandboxManager<SandboxBackends> {
    SandboxManager::new(
        Dir::open_local(".").unwrap(),
        SandboxBackends::new(
            candidates
                .into_iter()
                .map(|candidate| {
                    (
                        candidate.name,
                        Arc::new(candidate) as Arc<dyn SandboxBackend>,
                    )
                })
                .collect(),
        ),
    )
}

#[test]
fn first_supported_backend_is_selected_without_preparing_another() {
    let first = Candidate::new("mxc", Behavior::Ready);
    let starts = Arc::clone(&first.starts);
    let next = Candidate::new("windows", Behavior::Ready);
    let calls = Arc::clone(&next.prepares);
    let manager = manager(vec![first, next]);
    let prepared = manager
        .prepare(
            &SandboxCommand::new("command", Vec::<String>::new(), "."),
            policy(),
        )
        .unwrap();
    let child = prepared.spawn(&[]).unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        child
            .classify_denial(SandboxProcessExitStatus::Code(1), "", "")
            .unwrap()
            .reason(),
        "mxc"
    );
}

#[test]
fn unsupported_candidates_are_skipped_before_any_process_starts() {
    let first = Candidate::new("first", Behavior::Unsupported);
    let second = Candidate::new("second", Behavior::Ready);
    let starts = Arc::clone(&second.starts);
    let manager = manager(vec![first, second]);
    let prepared = manager
        .prepare(
            &SandboxCommand::new("command", Vec::<String>::new(), "."),
            policy(),
        )
        .unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 0);
    let child = prepared.spawn(&[]).unwrap();
    assert_eq!(starts.load(Ordering::SeqCst), 1);
    assert_eq!(
        child
            .classify_denial(SandboxProcessExitStatus::Code(1), "", "")
            .unwrap()
            .reason(),
        "second"
    );
}

#[test]
fn operational_failures_do_not_select_a_different_backend() {
    let next = Candidate::new("next", Behavior::Ready);
    let calls = Arc::clone(&next.prepares);
    let manager = manager(vec![Candidate::new("broken", Behavior::Broken), next]);
    assert!(matches!(
        manager.prepare(
            &SandboxCommand::new("command", Vec::<String>::new(), "."),
            policy()
        ),
        Err(SandboxError::BackendUnavailable { .. })
    ));
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn launch_failure_never_reselects_or_replays_the_command() {
    for timing in [
        SandboxDenialTiming::BeforeProcessStart,
        SandboxDenialTiming::ProcessMayHaveStarted,
    ] {
        let first = Candidate::new("first", Behavior::SpawnFailure(timing));
        let starts = Arc::clone(&first.starts);
        let next = Candidate::new("next", Behavior::Ready);
        let calls = Arc::clone(&next.prepares);
        let manager = manager(vec![first, next]);
        let prepared = manager
            .prepare(
                &SandboxCommand::new("command", Vec::<String>::new(), "."),
                policy(),
            )
            .unwrap();
        assert!(matches!(
            prepared.spawn(&[]),
            Err(SandboxError::StartFailed { .. })
        ));
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }
}

#[test]
fn a_restricted_request_cannot_be_satisfied_by_an_ordinary_process() {
    let manager = manager(vec![Candidate::new("invalid", Behavior::Unrestricted)]);
    assert!(
        manager
            .prepare(
                &SandboxCommand::new("command", Vec::<String>::new(), "."),
                policy()
            )
            .is_err()
    );
}

#[test]
fn denial_classification_stays_with_each_prepared_execution() {
    let mut first = Candidate::new("first", Behavior::Ready);
    first.only = Some("first-command");
    let manager = manager(vec![first, Candidate::new("second", Behavior::Ready)]);
    let first = manager
        .prepare(
            &SandboxCommand::new("first-command", Vec::<String>::new(), "."),
            policy(),
        )
        .unwrap();
    let second = manager
        .prepare(
            &SandboxCommand::new("second-command", Vec::<String>::new(), "."),
            policy(),
        )
        .unwrap();
    let second = second.spawn(&[]).unwrap();
    let first = first.spawn(&[]).unwrap();
    assert_eq!(
        first
            .classify_denial(SandboxProcessExitStatus::Code(1), "", "")
            .unwrap()
            .reason(),
        "first"
    );
    assert_eq!(
        second
            .classify_denial(SandboxProcessExitStatus::Code(1), "", "")
            .unwrap()
            .reason(),
        "second"
    );
}

#[test]
fn explicit_unrestricted_authority_does_not_depend_on_backend_availability() {
    let manager = manager(Vec::new());
    let prepared = manager
        .prepare(
            &SandboxCommand::new("command", Vec::<String>::new(), "."),
            SandboxPolicy::new(FileSystemAccess::FullAccess, NetworkAccess::Allowed),
        )
        .unwrap();
    assert_eq!(prepared.kind(), SandboxKind::Unrestricted);
}
