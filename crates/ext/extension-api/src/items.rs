use crate::ExtensionError;
use crate::ExtensionScope;
use crate::ExtensionState;
use crate::ItemContributor;
use crate::ThreadContext;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use extension_items::ExtensionItem;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Default)]
struct ThreadItems(Mutex<VecDeque<ExtensionItem>>);

/// Bounded recent results shared by tools and the authorized Thread item API.
pub struct ExtensionItemStore {
    state: Arc<ExtensionState>,
}
impl ExtensionItemStore {
    pub fn new(state: Arc<ExtensionState>) -> Self {
        Self { state }
    }
    pub fn publish(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        item: ExtensionItem,
    ) -> Result<(), ExtensionError> {
        item.validate().map_err(ExtensionError::new)?;
        let data = self
            .state
            .get_or_insert::<ThreadItems>(ExtensionScope::Thread(
                session.clone(),
                thread.clone(),
            ))?;
        let mut items = data
            .0
            .lock()
            .map_err(|_| ExtensionError::new("extension items lock poisoned"))?;
        items.retain(|old| old.extension != item.extension || old.id != item.id);
        if items.len() == 64 {
            items.pop_front();
        }
        items.push_back(item);
        Ok(())
    }
}
impl ItemContributor for ExtensionItemStore {
    fn contribute(&self, context: ThreadContext<'_>) -> Result<Vec<ExtensionItem>, ExtensionError> {
        let data = self
            .state
            .get_or_insert::<ThreadItems>(ExtensionScope::Thread(
                context.session_id.clone(),
                context.thread_id.clone(),
            ))?;
        let items = data
            .0
            .lock()
            .map_err(|_| ExtensionError::new("extension items lock poisoned"))?;
        Ok(items.iter().cloned().collect())
    }
}
