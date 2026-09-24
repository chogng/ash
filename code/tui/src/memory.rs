use crate::client::new_command_id;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_client::MemoryRecording;
use ash_memory_diagnostics::MemoryMetric;
use ash_memory_diagnostics::MemoryMetricKind;
use ash_memory_diagnostics::MemoryProduct;
use ash_memory_diagnostics::MemoryStatus;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum Status {
    #[default]
    Disabled,
    Starting,
    Recording,
    Stopping,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Action {
    Start,
    Stop,
}

const fn action(enabled: bool, status: Status) -> Option<Action> {
    match (enabled, status) {
        (true, Status::Disabled) => Some(Action::Start),
        (false, Status::Recording) => Some(Action::Stop),
        _ => None,
    }
}

const fn status_after_recording(status: MemoryStatus) -> Status {
    match status {
        MemoryStatus::Recording => Status::Recording,
        MemoryStatus::Stopped | MemoryStatus::BudgetExpired | MemoryStatus::TargetsExited => {
            Status::Disabled
        }
    }
}

pub(super) enum Completion {
    Started(Result<Box<MemoryRecording>, String>),
    Stopped(Result<(), String>),
}

pub(super) enum Request {
    Start {
        client: AppServerRequestHandle,
        id: String,
        objects: Arc<AtomicUsize>,
    },
    Stop {
        recording: Box<MemoryRecording>,
    },
}

impl Request {
    pub(super) const fn name(&self) -> &'static str {
        match self {
            Self::Start { .. } => "ash-memory-start",
            Self::Stop { .. } => "ash-memory-stop",
        }
    }

    pub(super) fn execute(self) -> Completion {
        match self {
            Self::Start {
                client,
                id,
                objects,
            } => Completion::Started(
                MemoryRecording::start(client, MemoryProduct::Tui, id, move || {
                    vec![MemoryMetric {
                        kind: MemoryMetricKind::UiObjects,
                        value: Some(objects.load(Ordering::Relaxed) as u64),
                        unavailable: None,
                    }]
                })
                .map(Box::new),
            ),
            Self::Stop { mut recording } => Completion::Stopped(recording.stop().map(|_| ())),
        }
    }
}

pub(super) struct Controller {
    status: Status,
    recording: Option<Box<MemoryRecording>>,
    objects: Arc<AtomicUsize>,
}

impl Default for Controller {
    fn default() -> Self {
        Self {
            status: Status::Disabled,
            recording: None,
            objects: Arc::new(AtomicUsize::new(0)),
        }
    }
}

impl Controller {
    pub(super) const fn status(&self) -> Status {
        self.status
    }

    pub(super) fn observe_objects(&self, count: usize) {
        self.objects.store(count, Ordering::Relaxed);
    }

    pub(super) fn reconcile(
        &mut self,
        enabled: bool,
        client: AppServerRequestHandle,
    ) -> Result<Option<Request>, String> {
        if self.status == Status::Recording {
            let recording = self
                .recording
                .as_ref()
                .expect("recording status owns a memory recording");
            match recording.status() {
                Ok(status) => {
                    let status = status_after_recording(status);
                    if status != Status::Recording {
                        self.recording = None;
                        self.status = status;
                    }
                }
                Err(error) => {
                    self.recording = None;
                    self.status = Status::Failed;
                    return Err(format!("Memory diagnostics stopped: {error}"));
                }
            }
        }
        if !enabled && self.status == Status::Failed {
            self.status = Status::Disabled;
        }
        let request = match action(enabled, self.status) {
            Some(Action::Start) => {
                self.status = Status::Starting;
                Some(Request::Start {
                    client,
                    id: new_command_id("memory").to_string(),
                    objects: Arc::clone(&self.objects),
                })
            }
            Some(Action::Stop) => {
                self.status = Status::Stopping;
                Some(Request::Stop {
                    recording: self
                        .recording
                        .take()
                        .expect("recording status owns a memory recording"),
                })
            }
            None => None,
        };
        Ok(request)
    }

    pub(super) fn complete(&mut self, completion: Completion) -> Result<(), String> {
        match completion {
            Completion::Started(Ok(recording)) => {
                self.recording = Some(recording);
                self.status = Status::Recording;
                Ok(())
            }
            Completion::Started(Err(error)) => {
                self.recording = None;
                self.status = Status::Failed;
                Err(format!("Could not start memory diagnostics: {error}"))
            }
            Completion::Stopped(Ok(())) => {
                self.recording = None;
                self.status = Status::Disabled;
                Ok(())
            }
            Completion::Stopped(Err(error)) => {
                self.recording = None;
                self.status = Status::Failed;
                Err(format!("Could not stop memory diagnostics: {error}"))
            }
        }
    }

    pub(super) fn schedule_failed(&mut self) {
        self.recording = None;
        self.status = Status::Failed;
    }
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
