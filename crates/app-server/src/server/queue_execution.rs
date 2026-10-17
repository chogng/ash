use super::AppServer;
use queue::Delivery;
use queue::QueuedMessage;
use std::sync::Arc;

impl AppServer {
    pub fn start_queue(self: &Arc<Self>) -> Result<Option<queue::QueueRuntime>, String> {
        self.queue
            .as_ref()
            .map(|store| {
                queue::QueueRuntime::start(store.clone(), self.clone())
                    .map_err(|error| error.to_string())
            })
            .transpose()
    }
}
impl queue::QueueExecutor for AppServer {
    fn accepts(&self, message: &QueuedMessage) -> bool {
        self.queue_directory.as_deref() == Some(message.request.directory.as_str())
    }
    fn ready(&self, message: &QueuedMessage) -> Result<bool, String> {
        self.queue_processor().queued_message_ready(message)
    }
    fn deliver(&self, message: &QueuedMessage) -> Result<Delivery, String> {
        self.queue_processor().deliver_queued_message(message)
    }
    fn changed(&self) {
        self.updates.publish_queue_changed();
    }
    fn report_error(&self, error: &str) {
        log::error!("message queue: {error}");
    }
}
