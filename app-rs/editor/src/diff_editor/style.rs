//! Diff-specific decorations layered on CodeEditor tokens.

use ash_diff::DiffRowKind;
use zui::ui::Color;

use super::DiffEditorSide;
use crate::code_editor::CodeEditorStyle;

/// Resolved color inputs used to construct one DiffEditor presentation style.
#[derive(Clone, Debug, PartialEq)]
pub struct DiffEditorPalette {
    pub code_editor: CodeEditorStyle,
    pub divider: Color,
    pub removed_marker: Color,
    pub added_marker: Color,
    pub removed_line: Color,
    pub added_line: Color,
    pub removed_inline: Color,
    pub added_inline: Color,
    pub missing_line: Color,
    pub fold_line: Color,
    pub fold_marker: Color,
}

/// Diff-specific decorations layered onto the shared CodeEditor style.
#[derive(Clone, Debug, PartialEq)]
pub struct DiffEditorStyle {
    code_editor: CodeEditorStyle,
    divider: Color,
    removed_marker: Color,
    added_marker: Color,
    pub(super) removed_line: Color,
    pub(super) added_line: Color,
    pub(super) removed_inline: Color,
    pub(super) added_inline: Color,
    pub(super) missing_line: Color,
    pub(super) fold_line: Color,
    pub(super) fold_marker: Color,
}

impl DiffEditorStyle {
    pub fn light() -> Self {
        Self::new(DiffEditorPalette {
            code_editor: CodeEditorStyle::light(),
            divider: Color::rgb(222, 222, 224),
            removed_marker: Color::rgb(207, 34, 46),
            added_marker: Color::rgb(26, 127, 55),
            removed_line: Color::rgb(255, 235, 233),
            added_line: Color::rgb(218, 251, 225),
            removed_inline: Color::rgb(255, 198, 194),
            added_inline: Color::rgb(166, 235, 183),
            missing_line: Color::rgb(248, 248, 249),
            fold_line: Color::rgb(241, 246, 252),
            fold_marker: Color::rgb(87, 96, 106),
        })
    }

    pub fn new(palette: DiffEditorPalette) -> Self {
        Self {
            code_editor: palette.code_editor,
            divider: palette.divider,
            removed_marker: palette.removed_marker,
            added_marker: palette.added_marker,
            removed_line: palette.removed_line,
            added_line: palette.added_line,
            removed_inline: palette.removed_inline,
            added_inline: palette.added_inline,
            missing_line: palette.missing_line,
            fold_line: palette.fold_line,
            fold_marker: palette.fold_marker,
        }
    }

    pub(crate) fn same_layout_as(&self, other: &Self) -> bool {
        self.code_editor.same_layout_as(&other.code_editor)
    }

    pub(super) const fn code_editor(&self) -> &CodeEditorStyle {
        &self.code_editor
    }

    pub(super) const fn divider(&self) -> Color {
        self.divider
    }

    pub(super) const fn marker_color(&self, side: DiffEditorSide) -> Color {
        match side {
            DiffEditorSide::Original => self.removed_marker,
            DiffEditorSide::Modified => self.added_marker,
        }
    }

    pub(super) const fn inline_color(&self, side: DiffEditorSide) -> Color {
        match side {
            DiffEditorSide::Original => self.removed_inline,
            DiffEditorSide::Modified => self.added_inline,
        }
    }

    pub(super) const fn fold_line(&self) -> Color {
        self.fold_line
    }

    pub(super) const fn fold_marker(&self) -> Color {
        self.fold_marker
    }

    pub(super) fn line_background(
        &self,
        kind: DiffRowKind,
        side: DiffEditorSide,
        has_line: bool,
    ) -> Color {
        if !has_line {
            return self.missing_line;
        }
        match (kind, side) {
            (DiffRowKind::Added, DiffEditorSide::Modified)
            | (DiffRowKind::Modified, DiffEditorSide::Modified) => self.added_line,
            (DiffRowKind::Removed, DiffEditorSide::Original)
            | (DiffRowKind::Modified, DiffEditorSide::Original) => self.removed_line,
            _ => self.code_editor.surface(),
        }
    }
}
