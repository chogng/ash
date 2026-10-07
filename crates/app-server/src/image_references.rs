use ash_core::ThreadController;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use std::sync::Arc;
use std::sync::Weak;

pub(crate) struct ThreadImageReferences(Weak<ThreadController>);
impl ThreadImageReferences {
    pub(crate) fn new(threads: &Arc<ThreadController>) -> Self {
        Self(Arc::downgrade(threads))
    }
}
impl image_generation::ImageReferenceSource for ThreadImageReferences {
    fn list(&self, session: &SessionId, thread: &ThreadId) -> Result<Vec<String>, String> {
        let threads = self.0.upgrade().ok_or("Thread owner has stopped")?;
        let snapshot = threads.read_thread(thread).map_err(|e| e.to_string())?;
        if &snapshot.session_id != session {
            return Err("image references belong to another Session".into());
        }
        Ok(snapshot
            .items
            .iter()
            .rev()
            .filter_map(|item| match item {
                ThreadItem::UserImageAttachment { item_id, .. } => {
                    Some(format!("attachment:{item_id}"))
                }
                _ => None,
            })
            .take(20)
            .collect())
    }
    fn read(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        reference: &str,
    ) -> Result<String, String> {
        let id = reference
            .strip_prefix("attachment:")
            .ok_or("invalid image attachment reference")?;
        let threads = self.0.upgrade().ok_or("Thread owner has stopped")?;
        let snapshot = threads.read_thread(thread).map_err(|e| e.to_string())?;
        if &snapshot.session_id != session {
            return Err("image references belong to another Session".into());
        }
        let attachment = snapshot
            .items
            .iter()
            .find_map(|item| match item {
                ThreadItem::UserImageAttachment {
                    item_id,
                    attachment,
                    ..
                } if item_id.as_str() == id => Some(attachment),
                _ => None,
            })
            .ok_or("image attachment is not part of this Thread")?;
        threads
            .attachments()
            .materialize_data_url(attachment)
            .map_err(|e| e.to_string())
    }
}
