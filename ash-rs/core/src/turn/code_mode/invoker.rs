use super::broker::CodeModeBrokerInner;
use super::broker::RuntimeKey;
use crate::ThreadUpdateSink;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_code_mode::ToolInvoker;
use ash_code_mode_protocol::CellId;
use ash_code_mode_protocol::NestedToolCall;
use ash_code_mode_protocol::RuntimeNotification;
use ash_protocol::StreamCursor;
use ash_protocol::ThreadUpdate;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolCallId;
use ash_protocol::ToolOutputStream;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

pub(super) struct BrokerToolInvoker {
    broker: Weak<CodeModeBrokerInner>,
    key: RuntimeKey,
    cancellation: CancellationToken,
    close_source: CancellationSource,
    cell_cancellations: Mutex<BTreeMap<CellId, CancellationSource>>,
    cancelled_cells: Mutex<BTreeSet<CellId>>,
    updates: Arc<dyn ThreadUpdateSink>,
    stream_instance_id: ash_protocol::StreamInstanceId,
    next_stream_sequence: AtomicU64,
    hooks: Arc<dyn crate::HookService>,
}

impl BrokerToolInvoker {
    pub(super) fn new(
        broker: Weak<CodeModeBrokerInner>,
        key: RuntimeKey,
        cancellation: &CancellationToken,
        updates: Arc<dyn ThreadUpdateSink>,
        hooks: Arc<dyn crate::HookService>,
        stream_instance_id: ash_protocol::StreamInstanceId,
    ) -> Self {
        let close_source = cancellation.child_source();
        Self {
            broker,
            key,
            cancellation: close_source.token(),
            close_source,
            cell_cancellations: Mutex::new(BTreeMap::new()),
            cancelled_cells: Mutex::new(BTreeSet::new()),
            updates,
            stream_instance_id,
            next_stream_sequence: AtomicU64::new(0),
            hooks,
        }
    }
}

impl ToolInvoker for BrokerToolInvoker {
    fn invoke(&self, call: NestedToolCall) -> Result<serde_json::Value, String> {
        // Hold the cell-cancellation guard until the active source has been selected. This keeps
        // cancel_cell() from racing between the check and creation of a new child source.
        let _cancelled_cells = self
            .cancelled_cells
            .lock()
            .map_err(|_| "Code Mode cell cancellation registry was poisoned".to_string())?;
        if _cancelled_cells.contains(&call.cell_id) {
            return Err("Code Mode cell has been cancelled".into());
        }
        let cell_cancellation = self
            .cell_cancellations
            .lock()
            .map_err(|_| "Code Mode cell cancellation registry was poisoned".to_string())?
            .entry(call.cell_id.clone())
            .or_insert_with(|| self.cancellation.child_source())
            .token();
        drop(_cancelled_cells);

        let broker = self
            .broker
            .upgrade()
            .ok_or_else(|| "Code Mode broker has been closed".to_string())?;
        broker
            .invoke_nested(
                &self.key,
                call,
                &cell_cancellation,
                Arc::clone(&self.updates),
                Arc::clone(&self.hooks),
            )
            .map_err(|error| error.to_string())
    }

    fn notify(&self, notification: RuntimeNotification) -> Result<(), String> {
        let broker = self
            .broker
            .upgrade()
            .ok_or_else(|| "Code Mode broker has been closed".to_string())?;
        let thread_id = self.key.thread_id().map_err(|error| error.to_string())?;
        let call_id = ToolCallId::new(notification.tool_call_id.clone())
            .map_err(|error| error.to_string())?;
        let snapshot = broker
            .threads
            .read_thread(&thread_id)
            .map_err(|error| error.to_string())?;
        let sequence = self
            .next_stream_sequence
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        self.updates.publish(ThreadUpdateEnvelope {
            session_id: snapshot.session_id,
            thread_id,
            durable_sequence: snapshot.sequence,
            stream_cursor: Some(StreamCursor {
                stream_instance_id: self.stream_instance_id.clone(),
                sequence,
            }),
            update: ThreadUpdate::ToolOutputDelta {
                turn_id: self.key.turn_id().map_err(|error| error.to_string())?,
                tool_call_id: call_id,
                stream: ToolOutputStream::Stdout,
                text: notification.text,
            },
        });
        Ok(())
    }

    fn cancel(&self) {
        let _ = self.close_source.cancel();
        let cancellations = self
            .cell_cancellations
            .lock()
            .map(|mut cancellations| std::mem::take(&mut *cancellations))
            .unwrap_or_default();
        for cancellation in cancellations.into_values() {
            let _ = cancellation.cancel();
        }
    }

    fn cancel_cell(&self, cell_id: &CellId) {
        let cancellation = {
            let Ok(mut cancelled_cells) = self.cancelled_cells.lock() else {
                return;
            };
            cancelled_cells.insert(cell_id.clone());
            self.cell_cancellations
                .lock()
                .ok()
                .and_then(|mut cancellations| cancellations.remove(cell_id))
        };
        if let Some(cancellation) = cancellation {
            let _ = cancellation.cancel();
        }
    }
}
