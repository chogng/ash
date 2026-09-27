use super::notification_queue::NotificationQueue;
use super::update_broker::notification;
use ash_app_server_protocol::protocol::dictation::DictationEnded;
use ash_app_server_protocol::protocol::dictation::DictationTranscript;
use ash_app_server_protocol::protocol::registry::ServerNotificationMethod;
use ash_system_dictation::DictationEvent;
use ash_system_dictation::DictationSession;
use std::cell::RefCell;
use std::sync::Mutex;

struct ActiveDictation {
    owner: u64,
    resource_id: String,
    session: DictationSession,
}

#[derive(Default)]
pub(super) struct DictationRuntime {
    active: Mutex<Option<ActiveDictation>>,
}

impl DictationRuntime {
    pub fn start(
        &self,
        owner: u64,
        resource_id: String,
        notifications: NotificationQueue,
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
        if active.is_some() {
            return Err("The microphone is already in use for dictation".into());
        }
        let event_resource_id = resource_id.clone();
        let failure = RefCell::new(None);
        let session = DictationSession::start(move |event| match event {
            DictationEvent::Transcript(text) => notifications.push(notification(
                ServerNotificationMethod::DictationTranscript,
                &DictationTranscript {
                    resource_id: event_resource_id.clone(),
                    text,
                },
            )),
            DictationEvent::Failed(error) => *failure.borrow_mut() = Some(error),
            DictationEvent::Ended => notifications.push(notification(
                ServerNotificationMethod::DictationEnded,
                &DictationEnded {
                    resource_id: event_resource_id.clone(),
                    error: failure.borrow_mut().take(),
                },
            )),
        })
        .map_err(|error| error.to_string())?;
        *active = Some(ActiveDictation {
            owner,
            resource_id,
            session,
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
        drop(active);
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
        drop(active);
        if let Some(session) = session.as_mut() {
            session.session.stop();
        }
    }
}
