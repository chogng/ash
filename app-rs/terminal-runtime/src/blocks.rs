use ash_terminal::{BlockStatus, TerminalCore};

#[derive(Clone, Copy)]
pub enum TerminalBlockLineKind {
    Preamble,
    Command,
    Output,
    Status,
}

pub struct TerminalBlockLine {
    pub text: String,
    pub kind: TerminalBlockLineKind,
}

pub fn project_block_lines(terminal: &TerminalCore) -> Vec<TerminalBlockLine> {
    let mut lines = Vec::new();
    push_display_text(
        &mut lines,
        terminal.block_list().preamble(),
        TerminalBlockLineKind::Preamble,
    );
    for block in terminal.block_list().blocks() {
        lines.push(TerminalBlockLine {
            text: format!("❯ {}", block.command()),
            kind: TerminalBlockLineKind::Command,
        });
        if block.is_truncated() {
            lines.push(TerminalBlockLine {
                text: "… earlier output truncated …".to_string(),
                kind: TerminalBlockLineKind::Status,
            });
        }
        push_display_text(&mut lines, block.output(), TerminalBlockLineKind::Output);
        if let BlockStatus::Exited(exit_code) = block.status() {
            lines.push(TerminalBlockLine {
                text: format!("[process exited with code {exit_code}]"),
                kind: TerminalBlockLineKind::Status,
            });
        }
    }
    lines
}

fn push_display_text(lines: &mut Vec<TerminalBlockLine>, text: &str, kind: TerminalBlockLineKind) {
    lines.extend(text.lines().map(|line| TerminalBlockLine {
        text: line.to_string(),
        kind,
    }));
}
