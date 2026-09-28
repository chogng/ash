//! Device-local dictation sessions. The product host owns connection identity and delivery;
//! this crate owns microphone exclusivity, recognition, and session teardown.

use std::cell::RefCell;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

use system_dictation::DictationSession;

#[derive(Debug, Eq, PartialEq)]
pub enum DictationEvent {
    Transcript(String),
    Ended { error: Option<String> },
}

/// A recognizer owns every resource needed to turn one live microphone session into text.
/// Implementations send ordered events to `on_event` and release their resources in `stop`.
trait Recognizer: Send + Sync {
    fn start(
        &self,
        on_event: Box<dyn Fn(DictationEvent) + Send>,
    ) -> Result<Box<dyn RecognitionSession>, String>;
}

/// The active recognition session releases capture and inference before `stop` returns.
trait RecognitionSession: Send {
    fn stop(&mut self);
}

struct SystemRecognizer;

struct SystemSession(DictationSession);

impl Recognizer for SystemRecognizer {
    fn start(
        &self,
        on_event: Box<dyn Fn(DictationEvent) + Send>,
    ) -> Result<Box<dyn RecognitionSession>, String> {
        let failure = RefCell::new(None);
        let session = DictationSession::start(move |event| match event {
            system_dictation::DictationEvent::Transcript(text) => {
                on_event(DictationEvent::Transcript(text));
            }
            system_dictation::DictationEvent::Failed(error) => *failure.borrow_mut() = Some(error),
            system_dictation::DictationEvent::Ended => on_event(DictationEvent::Ended {
                error: failure.borrow_mut().take(),
            }),
        })
        .map_err(|error| error.to_string())?;
        Ok(Box::new(SystemSession(session)))
    }
}

impl RecognitionSession for SystemSession {
    fn stop(&mut self) {
        self.0.stop();
    }
}

struct ActiveDictation {
    owner: u64,
    resource_id: String,
    session: Box<dyn RecognitionSession>,
    ended: Arc<AtomicBool>,
}

/// One device-local dictation manager shared by all product connections in a process.
/// The owner and resource ID jointly identify the session; closing that owner releases it.
pub struct DictationManager {
    recognizer: Box<dyn Recognizer>,
    active: Mutex<Option<ActiveDictation>>,
}

impl Default for DictationManager {
    fn default() -> Self {
        Self {
            recognizer: Box::new(SystemRecognizer),
            active: Mutex::new(None),
        }
    }
}

impl DictationManager {
    pub fn start(
        &self,
        owner: u64,
        resource_id: String,
        on_event: impl Fn(DictationEvent) + Send + 'static,
    ) -> Result<(), String> {
        if resource_id.is_empty()
            || resource_id.len() > 128
            || !resource_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("Invalid dictation resource ID".into());
        }
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Dictation state unavailable")?;
        if active
            .as_ref()
            .is_some_and(|session| session.ended.load(Ordering::Acquire))
        {
            let mut completed = active.take().expect("validated completed dictation");
            completed.session.stop();
        }
        if active.is_some() {
            return Err("The microphone is already in use for dictation".into());
        }
        let ended = Arc::new(AtomicBool::new(false));
        let event_ended = Arc::clone(&ended);
        let session = self.recognizer.start(Box::new(move |event| {
            if matches!(event, DictationEvent::Ended { .. }) {
                event_ended.store(true, Ordering::Release);
            }
            on_event(event);
        }))?;
        *active = Some(ActiveDictation {
            owner,
            resource_id,
            session,
            ended,
        });
        Ok(())
    }

    pub fn stop(&self, owner: u64, resource_id: &str) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "Dictation state unavailable")?;
        if active
            .as_ref()
            .is_none_or(|session| session.owner != owner || session.resource_id != resource_id)
        {
            return Err("Dictation session not found".into());
        }
        let mut session = active.take().expect("validated active dictation");
        session.session.stop();
        Ok(())
    }

    pub fn close(&self, owner: u64) {
        let Ok(mut active) = self.active.lock() else {
            return;
        };
        let mut session = if active
            .as_ref()
            .is_some_and(|session| session.owner == owner)
        {
            active.take()
        } else {
            None
        };
        if let Some(session) = session.as_mut() {
            session.session.stop();
        }
    }
}

#[cfg(test)]
#[path = "dictation_tests.rs"]
mod tests;
