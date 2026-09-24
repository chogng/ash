use ash_terminal::{GridSize, ScreenBuffer, TerminalColor, TerminalCore, TerminalMousePosition};
use ash_ui_components::ScrollbarPresentation;
use ash_ui_theme::UiTheme;
use zui::ui::{
    Color, FontFamily, FontWeight, PaintRect, Point, Rect, TextBlock, TextStyle, UiScene,
};

use crate::blocks::{TerminalBlockLineKind, project_block_lines};
use crate::output_scroll_view::TerminalOutputScrollView;
use crate::{TerminalSelectionRange, paint_terminal_selection};

pub const TERMINAL_CELL_WIDTH: f32 = 8.0;
pub const TERMINAL_LINE_HEIGHT: f32 = 18.0;
pub const TERMINAL_PADDING: f32 = 24.0;

#[derive(Clone, Copy)]
pub struct TerminalPaneView<'a> {
    pub core: Option<&'a TerminalCore>,
    pub scroll_offset: usize,
    pub scrollbar: ScrollbarPresentation,
    pub selection: Option<TerminalSelectionRange>,
}

impl<'a> TerminalPaneView<'a> {
    pub fn new(core: Option<&'a TerminalCore>) -> Self {
        Self {
            core,
            scroll_offset: 0,
            scrollbar: ScrollbarPresentation::default(),
            selection: None,
        }
    }

    pub const fn with_view_state(
        mut self,
        scroll_offset: usize,
        scrollbar: ScrollbarPresentation,
        selection: Option<TerminalSelectionRange>,
    ) -> Self {
        self.scroll_offset = scroll_offset;
        self.scrollbar = scrollbar;
        self.selection = selection;
        self
    }
}

pub fn content_bounds(viewport: Rect) -> Rect {
    Rect::from_xywh(
        viewport.origin.x + TERMINAL_PADDING,
        viewport.origin.y + TERMINAL_PADDING,
        (viewport.size.width - TERMINAL_PADDING * 2.0).max(1.0),
        (viewport.size.height - TERMINAL_PADDING * 2.0).max(1.0),
    )
}

pub fn grid_size(bounds: Rect) -> GridSize {
    GridSize::new(
        (bounds.size.height / TERMINAL_LINE_HEIGHT)
            .floor()
            .clamp(1.0, u16::MAX as f32) as u16,
        (bounds.size.width / TERMINAL_CELL_WIDTH)
            .floor()
            .clamp(1.0, u16::MAX as f32) as u16,
    )
}

pub fn mouse_position(bounds: Rect, point: Point) -> Option<TerminalMousePosition> {
    if !bounds.contains(point) {
        return None;
    }
    let row = ((point.y - bounds.origin.y) / TERMINAL_LINE_HEIGHT).floor() as u16;
    let col = ((point.x - bounds.origin.x) / TERMINAL_CELL_WIDTH).floor() as u16;
    let size = grid_size(bounds);
    (row < size.rows() && col < size.cols()).then(|| TerminalMousePosition::new(row, col))
}

pub fn cursor_area(bounds: Rect, terminal: &TerminalCore, scroll_offset: usize) -> Option<Rect> {
    if scroll_offset != 0 || !terminal.modes().cursor_visible() {
        return None;
    }
    let (row, col) = terminal.grid().cursor();
    Some(Rect::from_xywh(
        bounds.origin.x + col as f32 * TERMINAL_CELL_WIDTH,
        bounds.origin.y + row as f32 * TERMINAL_LINE_HEIGHT,
        TERMINAL_CELL_WIDTH,
        TERMINAL_LINE_HEIGHT,
    ))
}

pub fn draw_terminal(
    scene: &mut UiScene,
    bounds: Rect,
    view: TerminalPaneView<'_>,
    screen: ScreenBuffer,
    palette: UiTheme,
) {
    let Some(terminal) = view.core else {
        draw_terminal_text(scene, "Starting shell…", bounds, palette.muted_foreground);
        return;
    };
    if screen == ScreenBuffer::Alternate {
        draw_grid(scene, terminal, bounds, view.scroll_offset, palette);
    } else {
        draw_block_list(scene, terminal, bounds, view, palette);
    }
}

fn draw_grid(
    scene: &mut UiScene,
    terminal: &TerminalCore,
    bounds: Rect,
    scroll_offset: usize,
    palette: UiTheme,
) {
    let cursor = terminal.grid().cursor();
    let cursor_visible = terminal.modes().cursor_visible() && scroll_offset == 0;
    for (row, line) in terminal.grid().viewport_lines(scroll_offset).enumerate() {
        let y = bounds.origin.y + row as f32 * TERMINAL_LINE_HEIGHT;
        if y + TERMINAL_LINE_HEIGHT > bounds.bottom() {
            break;
        }
        for (col, cell) in line.cells().iter().enumerate() {
            if cell.is_continuation() {
                continue;
            }
            let x = bounds.origin.x + col as f32 * TERMINAL_CELL_WIDTH;
            if x + TERMINAL_CELL_WIDTH > bounds.right() {
                break;
            }
            let style = cell.style();
            let (foreground, background) = terminal_cell_colors(style, palette);
            if background != Color::TRANSPARENT {
                scene.draw_rect(PaintRect::new(
                    Rect::from_xywh(x, y, TERMINAL_CELL_WIDTH, TERMINAL_LINE_HEIGHT),
                    background,
                ));
            }
            if cursor_visible && cursor == (row, col) {
                scene.draw_rect(PaintRect::new(
                    Rect::from_xywh(x, y + TERMINAL_LINE_HEIGHT - 2.0, TERMINAL_CELL_WIDTH, 2.0),
                    palette.accent,
                ));
            }
            if !cell.text().is_empty() {
                let mut style = terminal_text_style(foreground);
                if cell.style().bold {
                    style = style.with_weight(FontWeight::Bold);
                }
                draw_text(
                    scene,
                    cell.text(),
                    Rect::from_xywh(x, y, TERMINAL_CELL_WIDTH * 2.0, TERMINAL_LINE_HEIGHT),
                    style,
                );
            }
        }
    }
}

fn draw_block_list(
    scene: &mut UiScene,
    terminal: &TerminalCore,
    bounds: Rect,
    view: TerminalPaneView<'_>,
    palette: UiTheme,
) {
    let lines = project_block_lines(terminal);
    TerminalOutputScrollView::new(
        bounds,
        lines.len(),
        TERMINAL_LINE_HEIGHT,
        view.scroll_offset,
        view.scrollbar,
        palette,
    )
    .draw(scene, |scene, viewport, range| {
        for index in range {
            let line = &lines[index];
            let color = match line.kind {
                TerminalBlockLineKind::Preamble | TerminalBlockLineKind::Status => {
                    palette.muted_foreground
                }
                TerminalBlockLineKind::Command => palette.accent,
                TerminalBlockLineKind::Output => palette.foreground,
            };
            draw_terminal_text(
                scene,
                &line.text,
                Rect::from_xywh(
                    viewport.content_origin().x,
                    viewport.content_origin().y + index as f32 * TERMINAL_LINE_HEIGHT,
                    viewport.bounds().size.width,
                    TERMINAL_LINE_HEIGHT,
                ),
                color,
            );
        }
        if let Some(selection) = view.selection {
            paint_terminal_selection(
                scene,
                viewport.bounds(),
                terminal.grid().size().cols() as usize,
                selection,
                TERMINAL_CELL_WIDTH,
                TERMINAL_LINE_HEIGHT,
                palette.text_selection_background,
            );
        }
    });
}

fn terminal_cell_colors(style: ash_terminal::CellStyle, palette: UiTheme) -> (Color, Color) {
    let mut foreground = terminal_color(style.foreground, palette.foreground, palette);
    let mut background = terminal_color(style.background, Color::TRANSPARENT, palette);
    if style.inverse {
        std::mem::swap(&mut foreground, &mut background);
    }
    (foreground, background)
}

fn terminal_color(color: TerminalColor, default: Color, palette: UiTheme) -> Color {
    match color {
        TerminalColor::Default => default,
        TerminalColor::Indexed(index) => palette.terminal_indexed_color(index),
        TerminalColor::Rgb(red, green, blue) => Color::rgb(red, green, blue),
    }
}

fn terminal_text_style(color: Color) -> TextStyle {
    TextStyle::new(13.0, color)
        .with_family(FontFamily::Monospace)
        .with_line_height(TERMINAL_LINE_HEIGHT)
}

fn draw_terminal_text(scene: &mut UiScene, text: &str, bounds: Rect, color: Color) {
    draw_text(scene, text, bounds, terminal_text_style(color));
}

fn draw_text(scene: &mut UiScene, text: &str, bounds: Rect, style: TextStyle) {
    if bounds.is_empty() {
        return;
    }
    scene.draw_text(TextBlock::new(text, bounds.origin, bounds.size, style));
}
