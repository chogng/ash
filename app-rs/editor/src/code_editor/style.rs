//! CodeEditor-owned presentation tokens.

use std::sync::Arc;
use std::sync::OnceLock;

use ash_ui_theme::DEFAULT_UI_THEME;
use zui::ui::{Border, Color, Edges, PaintRect, Rect, TextInputLayoutEngine, TextStyle};

use super::{
    CodeEditorDiagnosticPalette, CodeEditorDiagnosticSeverity, CodeEditorSyntaxPalette,
    CodeEditorTokenRole,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CodeEditorTypographyError {
    InvalidTextStyle,
    InvalidHeaderStyle,
    InvalidCellWidth,
}

impl std::fmt::Display for CodeEditorTypographyError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidTextStyle => "editor text metrics must be finite and positive",
            Self::InvalidHeaderStyle => "editor header metrics must be finite and positive",
            Self::InvalidCellWidth => "editor font must produce a finite positive cell width",
        };
        formatter.write_str(message)
    }
}

impl std::error::Error for CodeEditorTypographyError {}

/// Resolved editor text styles and measured monospace cell advance.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeEditorTypography {
    text_style: TextStyle,
    header_style: TextStyle,
    cell_width: f32,
}

impl CodeEditorTypography {
    pub fn measure(
        text_style: TextStyle,
        header_style: TextStyle,
        text_layout: &mut TextInputLayoutEngine,
    ) -> Result<Self, CodeEditorTypographyError> {
        if !valid_text_style(&text_style) {
            return Err(CodeEditorTypographyError::InvalidTextStyle);
        }
        if !valid_text_style(&header_style) {
            return Err(CodeEditorTypographyError::InvalidHeaderStyle);
        }
        let cell_width = text_layout.measure_text("0", &text_style).width;
        if !cell_width.is_finite() || cell_width <= 0.0 {
            return Err(CodeEditorTypographyError::InvalidCellWidth);
        }
        Ok(Self {
            text_style: text_style.with_color(Color::TRANSPARENT),
            header_style: header_style.with_color(Color::TRANSPARENT),
            cell_width,
        })
    }
}

fn valid_text_style(style: &TextStyle) -> bool {
    style.font_size().is_finite()
        && style.font_size() > 0.0
        && style.line_height().is_finite()
        && style.line_height() > 0.0
}

/// Resolved color inputs used to construct one CodeEditor presentation style.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodeEditorPalette {
    pub surface: Color,
    pub header: Color,
    pub gutter: Color,
    pub divider: Color,
    pub text: Color,
    pub text_muted: Color,
    pub selection: Color,
    pub caret: Color,
    pub composition_underline: Color,
    pub diagnostics: CodeEditorDiagnosticPalette,
    pub syntax: CodeEditorSyntaxPalette,
}

/// Resolved paint-only editor values shared by every CodeEditor presentation.
#[derive(Debug, PartialEq)]
struct CodeEditorAppearance {
    surface: Color,
    header: Color,
    gutter: Color,
    divider: Color,
    text_muted: Color,
    selection: Color,
    caret: Color,
    composition_underline: Color,
    diagnostics: CodeEditorDiagnosticPalette,
    text_style: TextStyle,
    header_style: TextStyle,
    syntax: CodeEditorSyntaxPalette,
}

/// Shared immutable editor appearance and measured typography snapshots.
///
/// Cloning this value preserves both snapshots, so ordinary, composer, and diff editors do not
/// repeatedly copy resolved colors, font names, or measured geometry.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeEditorStyle {
    appearance: Arc<CodeEditorAppearance>,
    typography: Arc<CodeEditorTypography>,
}

impl CodeEditorStyle {
    pub fn light() -> Self {
        static STYLE: OnceLock<CodeEditorStyle> = OnceLock::new();
        STYLE
            .get_or_init(|| {
                let mut text_layout = TextInputLayoutEngine::new();
                Self::from_theme(DEFAULT_UI_THEME, &mut text_layout)
                    .expect("default editor theme typography must be valid")
            })
            .clone()
    }

    pub fn new(palette: CodeEditorPalette, typography: CodeEditorTypography) -> Self {
        let text_style = typography.text_style.clone().with_color(palette.text);
        let header_style = typography.header_style.clone().with_color(palette.text);
        Self {
            appearance: Arc::new(CodeEditorAppearance {
                surface: palette.surface,
                header: palette.header,
                gutter: palette.gutter,
                divider: palette.divider,
                text_muted: palette.text_muted,
                selection: palette.selection,
                caret: palette.caret,
                composition_underline: palette.composition_underline,
                diagnostics: palette.diagnostics,
                text_style,
                header_style,
                syntax: palette.syntax,
            }),
            typography: Arc::new(typography),
        }
    }

    /// Returns whether switching between two styles can preserve editor row geometry.
    pub fn same_layout_as(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.typography, &other.typography) || self.typography == other.typography
    }

    pub fn row_height(&self) -> f32 {
        self.typography.text_style.line_height()
    }

    pub fn header_height(&self) -> f32 {
        self.typography.header_style.line_height()
    }

    pub fn cell_width(&self) -> f32 {
        self.typography.cell_width
    }

    pub(crate) fn surface(&self) -> Color {
        self.appearance.surface
    }

    pub(super) fn gutter(&self) -> Color {
        self.appearance.gutter
    }

    pub(super) fn selection(&self) -> Color {
        self.appearance.selection
    }

    pub(super) fn caret(&self) -> Color {
        self.appearance.caret
    }

    pub(super) fn composition_underline(&self) -> Color {
        self.appearance.composition_underline
    }

    pub(super) fn diagnostic_color(&self, severity: CodeEditorDiagnosticSeverity) -> Color {
        self.appearance.diagnostics.color(severity)
    }

    pub fn text_style(&self) -> &TextStyle {
        &self.appearance.text_style
    }

    pub(super) fn header_text_style(&self) -> &TextStyle {
        &self.appearance.header_style
    }

    pub(super) fn muted_text_style(&self) -> TextStyle {
        self.text_with_color(self.appearance.text_muted)
    }

    pub fn text_with_color(&self, color: Color) -> TextStyle {
        self.appearance.text_style.clone().with_color(color)
    }

    pub(super) fn syntax_color(&self, role: CodeEditorTokenRole) -> Color {
        self.appearance.syntax.color(role)
    }

    pub(super) fn header_rect(&self, bounds: Rect) -> PaintRect {
        PaintRect::new(bounds, self.appearance.header).with_border(Border::new(
            Edges::new(0.0, 0.0, 1.0, 0.0),
            self.appearance.divider,
        ))
    }
}
