//! Stateless Session identity colors. Selection and other interaction styles belong to views.

use crate::render::RenderContext;
use ash_protocol::SessionId;
use ratatui::style::Color;

/// Uses the complete ID and the theme's stable accent order; collisions are allowed.
pub(super) fn session_color(id: &SessionId, context: RenderContext<'_>) -> Color {
    // Explicit FNV-1a avoids process-random or Rust-version-dependent identity assignments.
    let hash = id
        .as_str()
        .bytes()
        .fold(0xcbf29ce484222325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3)
        });
    let colors = context.identity_colors();
    colors[(hash % colors.len() as u64) as usize]
}
