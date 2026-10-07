const MAX_PREAMBLE_BYTES: usize = 256 * 1024;
const MAX_BLOCK_OUTPUT_BYTES: usize = 1024 * 1024;

/// Stable identity assigned to one submitted terminal command.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct BlockId(u64);

impl BlockId {
    pub const fn get(self) -> u64 {
        self.0
    }
}

/// Lifecycle of a command/output block.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlockStatus {
    Running,
    Completed,
    Exited(i32),
}

/// One user-submitted command and the printable output observed before the next command.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalBlock {
    id: BlockId,
    command: String,
    output: String,
    status: BlockStatus,
    truncated: bool,
}

impl TerminalBlock {
    pub const fn id(&self) -> BlockId {
        self.id
    }

    pub fn command(&self) -> &str {
        &self.command
    }

    pub fn output(&self) -> &str {
        &self.output
    }

    pub const fn status(&self) -> BlockStatus {
        self.status
    }

    pub const fn is_truncated(&self) -> bool {
        self.truncated
    }
}

/// Ordered terminal command history with bounded printable output retention.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct BlockList {
    preamble: String,
    preamble_truncated: bool,
    blocks: Vec<TerminalBlock>,
    next_id: u64,
    pending_echo: Option<PendingEcho>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingEcho {
    expected: String,
    buffered: String,
}

impl BlockList {
    pub fn new() -> Self {
        Self {
            next_id: 1,
            ..Self::default()
        }
    }

    pub fn preamble(&self) -> &str {
        &self.preamble
    }

    pub const fn preamble_is_truncated(&self) -> bool {
        self.preamble_truncated
    }

    pub fn blocks(&self) -> &[TerminalBlock] {
        &self.blocks
    }

    pub fn start_command(&mut self, command: impl Into<String>) -> BlockId {
        self.flush_pending_echo();
        if let Some(active) = self.blocks.last_mut()
            && active.status == BlockStatus::Running
        {
            active.status = BlockStatus::Completed;
        }
        let id = BlockId(self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        self.blocks.push(TerminalBlock {
            id,
            command: command.into(),
            output: String::new(),
            status: BlockStatus::Running,
            truncated: false,
        });
        let command = self.blocks.last().expect("new block must exist").command();
        self.pending_echo = Some(PendingEcho {
            expected: format!("{command}\n"),
            buffered: String::new(),
        });
        id
    }

    pub fn append_printable_output(&mut self, output: &str) {
        if output.is_empty() {
            return;
        }
        let Some(output) = self.filter_pending_echo(output) else {
            return;
        };
        if let Some(active) = self.blocks.last_mut()
            && active.status == BlockStatus::Running
        {
            active.output.push_str(&output);
            active.truncated |= truncate_front(&mut active.output, MAX_BLOCK_OUTPUT_BYTES);
            return;
        }
        self.preamble.push_str(&output);
        self.preamble_truncated |= truncate_front(&mut self.preamble, MAX_PREAMBLE_BYTES);
    }

    pub fn complete_command(&mut self) {
        self.flush_pending_echo();
        if let Some(active) = self.blocks.last_mut()
            && active.status == BlockStatus::Running
        {
            active.status = BlockStatus::Completed;
        }
    }

    pub fn mark_process_exited(&mut self, exit_code: i32) {
        self.flush_pending_echo();
        if let Some(active) = self.blocks.last_mut()
            && active.status == BlockStatus::Running
        {
            active.status = BlockStatus::Exited(exit_code);
        }
    }

    fn filter_pending_echo(&mut self, output: &str) -> Option<String> {
        let Some(pending) = self.pending_echo.as_mut() else {
            return Some(output.to_string());
        };
        pending.buffered.push_str(output);
        if pending.expected.starts_with(&pending.buffered) {
            return None;
        }
        let pending = self.pending_echo.take().expect("pending echo must exist");
        if let Some(remainder) = pending.buffered.strip_prefix(&pending.expected) {
            (!remainder.is_empty()).then(|| remainder.to_string())
        } else {
            Some(pending.buffered)
        }
    }

    fn flush_pending_echo(&mut self) {
        let Some(pending) = self.pending_echo.take() else {
            return;
        };
        if pending.buffered.is_empty() {
            return;
        }
        if let Some(active) = self.blocks.last_mut()
            && active.status == BlockStatus::Running
        {
            active.output.push_str(&pending.buffered);
            active.truncated |= truncate_front(&mut active.output, MAX_BLOCK_OUTPUT_BYTES);
        }
    }
}

fn truncate_front(text: &mut String, limit: usize) -> bool {
    if text.len() <= limit {
        return false;
    }
    let mut remove = text.len() - limit;
    while !text.is_char_boundary(remove) {
        remove += 1;
    }
    text.drain(..remove);
    true
}

#[cfg(test)]
#[path = "block_list_tests.rs"]
mod tests;
