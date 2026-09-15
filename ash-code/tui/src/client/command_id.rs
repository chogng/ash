use ash_protocol::CommandId;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

static NEXT_COMMAND: AtomicU64 = AtomicU64::new(0);

/// Creates the stable identity for one newly initiated logical command.
pub(crate) fn new_command_id(prefix: &str) -> CommandId {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let sequence = NEXT_COMMAND.fetch_add(1, Ordering::Relaxed);
    CommandId::new(format!(
        "{prefix}-{}-{timestamp}-{sequence}",
        std::process::id()
    ))
    .expect("generated command ID is non-empty")
}

#[cfg(test)]
#[path = "command_id_tests.rs"]
mod tests;
