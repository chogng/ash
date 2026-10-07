use extension_api::ExtensionError;
use extension_api::ThreadContext;
use std::sync::Arc;

/// Installs queue wakeup and display contributions using the same durable store.
pub fn install(
    builder: &mut extension_api::ExtensionRegistryBuilder,
    store: Arc<crate::QueueStore>,
) {
    let extension = Arc::new(QueueExtension(store));
    builder
        .idle_contributor("queue", extension.clone())
        .item_contributor("queue", extension);
}

struct QueueExtension(Arc<crate::QueueStore>);
impl extension_api::IdleContributor for QueueExtension {
    fn contribute(&self, _: ThreadContext<'_>) {
        self.0.wake();
    }
}
impl extension_api::ItemContributor for QueueExtension {
    fn contribute(
        &self,
        context: ThreadContext<'_>,
    ) -> Result<Vec<extension_items::ExtensionItem>, ExtensionError> {
        self.0
            .list(context.session_id, context.thread_id)
            .map_err(|error| ExtensionError::new(error.to_string()))?
            .into_iter()
            .filter(|message| {
                !matches!(
                    message.status,
                    crate::QueueStatus::Started | crate::QueueStatus::Cancelled
                )
            })
            .map(|message| {
                let status = match message.status {
                    crate::QueueStatus::Pending | crate::QueueStatus::Paused => {
                        extension_items::ExtensionItemStatus::Pending
                    }
                    crate::QueueStatus::Delivering => extension_items::ExtensionItemStatus::Running,
                    crate::QueueStatus::Started => extension_items::ExtensionItemStatus::Completed,
                    crate::QueueStatus::Rejected => extension_items::ExtensionItemStatus::Failed,
                    crate::QueueStatus::Cancelled => {
                        extension_items::ExtensionItemStatus::Cancelled
                    }
                };
                let body = message
                    .request
                    .input
                    .iter()
                    .filter_map(|input| match input {
                        protocol::UserInput::Text { text } => Some(text.as_str()),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                // Display has a separate bound; the full durable input remains available in queue/list.
                let body = body.chars().take(16_384).collect();
                Ok(extension_items::ExtensionItem {
                    extension: "queue".into(),
                    id: message.request.command_id.to_string(),
                    title: message.error.unwrap_or_else(|| "Queued message".into()),
                    body,
                    status,
                    content: extension_items::ExtensionItemContent::Text,
                })
            })
            .collect()
    }
}
