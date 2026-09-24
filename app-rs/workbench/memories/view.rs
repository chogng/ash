use super::*;
use ash_editor::CodeEditor;
use ash_editor::CodeEditorHeader;
use ash_editor::CodeEditorPresentation;
use ash_editor::CodeEditorStyle;
use ash_ui_components::Button;
use ash_ui_components::ButtonBackgrounds;
use ash_ui_components::ButtonState;
use ash_ui_components::ButtonStyle;
use ash_ui_components::Dialog;
use ash_ui_components::DialogIds;
use ash_ui_components::DialogStyle;
use ash_ui_components::InputBox;
use ash_ui_components::InputBoxState;
use ash_ui_components::InputBoxStateColors;
use ash_ui_components::InputBoxStyle;
use ash_ui_components::InteractionRegion;
use ash_ui_theme::UiTheme;
use zui::ui::*;

pub(crate) fn list_bounds(panel: Rect) -> Rect {
    Rect::from_xywh(
        panel.origin.x + 16.0,
        panel.origin.y + 148.0,
        (panel.size.width - 32.0).max(1.0),
        (panel.size.height - 400.0).clamp(28.0, 112.0),
    )
}
pub(crate) fn body_bounds(panel: Rect) -> Rect {
    let top = list_bounds(panel).bottom() + 78.0;
    Rect::from_xywh(
        panel.origin.x + 16.0,
        top,
        (panel.size.width - 32.0).max(1.0),
        (panel.bottom() - top - 90.0).max(20.0),
    )
}
pub(crate) fn panel_bounds(viewport: Rect) -> Rect {
    Rect::from_xywh(
        viewport.origin.x + (viewport.size.width - (viewport.size.width - 24.0).min(680.0)) * 0.5,
        viewport.origin.y + (viewport.size.height - (viewport.size.height - 24.0).min(660.0)) * 0.5,
        (viewport.size.width - 24.0).min(680.0),
        (viewport.size.height - 24.0).min(660.0),
    )
}

pub(crate) fn body_editor<'a>(
    state: &'a State,
    bounds: Rect,
    style: &CodeEditorStyle,
    caret: CaretVisibility,
) -> CodeEditor<'a> {
    CodeEditor::new(
        bounds,
        &state.body,
        state.viewport,
        CodeEditorHeader::Hidden,
        style.clone(),
    )
    .with_presentation(CodeEditorPresentation::Compact)
    .with_line_wrapping(ash_editor::CodeEditorLineWrapping::Soft)
    .with_caret_visibility(caret)
}

pub(crate) fn draw(
    context: &mut ComponentContext<'_, '_>,
    viewport: Rect,
    state: &State,
    theme: UiTheme,
    dispatch: &UiDispatch,
    caret: CaretVisibility,
    text_layout: &mut TextInputLayoutEngine,
    style: &CodeEditorStyle,
) -> Option<Rect> {
    if !state.open {
        return None;
    }
    let panel = panel_bounds(viewport);
    let dialog = Dialog::new(
        viewport,
        panel.size,
        "Memories",
        DialogIds::new(crate::WINDOW, ROOT),
        DialogStyle::new(Color::TRANSPARENT, theme.content_background)
            .with_border(Border::uniform(1.0, theme.border))
            .with_corner_radii(CornerRadii::uniform(8.0))
            .with_viewport_margin(12.0),
    );
    let mut ime = None;
    dialog.draw_components(context, |context, panel| {
        let x = panel.origin.x + 16.0;
        let width = (panel.size.width - 32.0).max(1.0);
        let y = panel.origin.y;
        label(
            context.scene_mut(),
            "Memories",
            Rect::from_xywh(x, y + 12.0, width - 80.0, 24.0),
            theme,
        );
        button(
            context,
            CLOSE,
            "Close",
            Rect::from_xywh(panel.right() - 78.0, y + 10.0, 62.0, 28.0),
            true,
            theme,
            dispatch,
        );
        let scope = state
            .scopes
            .get(state.scope_index)
            .map(|entry| entry.label.as_str())
            .unwrap_or("Personal memories");
        button(
            context,
            SCOPE_NEXT,
            scope,
            Rect::from_xywh(x, y + 44.0, width, 28.0),
            !state.busy,
            theme,
            dispatch,
        );
        let reading = state.policy().is_some_and(|policy| {
            policy.automatic_read == memories::MemoryReadMode::FirstInvocation
        });
        let saving = state
            .policy()
            .is_some_and(|policy| policy.model_write == memories::MemoryWriteMode::Enabled);
        button(
            context,
            READING,
            if reading {
                "Reading: on"
            } else {
                "Reading: off"
            },
            Rect::from_xywh(x, y + 78.0, width * 0.49, 28.0),
            !state.busy,
            theme,
            dispatch,
        );
        button(
            context,
            SAVING,
            if saving {
                "Model saving: on"
            } else {
                "Model saving: off"
            },
            Rect::from_xywh(x + width * 0.51, y + 78.0, width * 0.49, 28.0),
            !state.busy,
            theme,
            dispatch,
        );
        input(
            context,
            QUERY,
            "Search or paste a memory: reference",
            &state.query,
            Rect::from_xywh(x, y + 112.0, width - 154.0, 30.0),
            theme,
            dispatch,
            caret,
            text_layout,
            &mut ime,
        );
        button(
            context,
            SEARCH,
            "Search",
            Rect::from_xywh(panel.right() - 160.0, y + 112.0, 68.0, 30.0),
            !state.busy,
            theme,
            dispatch,
        );
        button(
            context,
            REFERENCE,
            "Open ref",
            Rect::from_xywh(panel.right() - 86.0, y + 112.0, 70.0, 30.0),
            !state.busy,
            theme,
            dispatch,
        );
        let list = ash_ui_components::ListView::new(
            list_bounds(panel),
            state.entries.len(),
            28.0,
            state.list_scroll,
            theme.file_list_scroll_view_style(),
        );
        list.draw_components(context, |context, row| {
            button(
                context,
                row_id(row.index()),
                &state.entries[row.index()].title,
                row.bounds(),
                !state.busy,
                theme,
                dispatch,
            );
        });
        let list_actions_y = list_bounds(panel).bottom() + 8.0;
        button(
            context,
            NEW,
            "New",
            Rect::from_xywh(x, list_actions_y, 70.0, 28.0),
            !state.busy,
            theme,
            dispatch,
        );
        button(
            context,
            REFRESH,
            "Refresh",
            Rect::from_xywh(x + 78.0, list_actions_y, 80.0, 28.0),
            !state.busy,
            theme,
            dispatch,
        );
        button(
            context,
            NEXT,
            "Next page",
            Rect::from_xywh(x + 166.0, list_actions_y, 90.0, 28.0),
            !state.busy && state.cursor.is_some(),
            theme,
            dispatch,
        );
        input(
            context,
            TITLE,
            "Memory title",
            &state.title,
            Rect::from_xywh(x, list_actions_y + 38.0, width, 30.0),
            theme,
            dispatch,
            caret,
            text_layout,
            &mut ime,
        );
        let body_bounds = body_bounds(panel);
        context.draw_component(
            &InteractionRegion::new(
                "MemoryBody",
                BODY,
                body_bounds,
                AccessibilityRole::TextInput,
                "Memory content",
            )
            .with_parent(ROOT)
            .with_focus(FocusBehavior::TabStop)
            .with_navigation(NavigationGroupId::new(ROOT), NavigationAxis::Vertical)
            .with_cursor(CursorFeedback::Text)
            .with_value(state.body.text()),
        );
        let editor = body_editor(
            state,
            body_bounds,
            style,
            if dispatch.is_focused(BODY) {
                caret
            } else {
                CaretVisibility::Hidden
            },
        );
        if dispatch.is_focused(BODY) {
            ime = editor.caret_bounds();
        }
        context.draw_component(&editor);
        let actions_y = body_bounds.bottom() + 8.0;
        button(
            context,
            SAVE,
            "Save memory",
            Rect::from_xywh(x, actions_y, 114.0, 28.0),
            !state.busy && !state.read_only,
            theme,
            dispatch,
        );
        button(
            context,
            DELETE,
            if state.confirm_delete {
                "Confirm delete"
            } else {
                "Delete"
            },
            Rect::from_xywh(x + 122.0, actions_y, 114.0, 28.0),
            !state.busy && state.selected.is_some(),
            theme,
            dispatch,
        );
        button(
            context,
            HELP,
            "Help",
            Rect::from_xywh(x + 244.0, actions_y, 66.0, 28.0),
            true,
            theme,
            dispatch,
        );
        label(
            context.scene_mut(),
            &state.status,
            Rect::from_xywh(x, actions_y + 34.0, width, 40.0),
            theme,
        );
    });
    ime
}

fn button(
    context: &mut ComponentContext<'_, '_>,
    id: ElementId,
    text: &str,
    bounds: Rect,
    enabled: bool,
    theme: UiTheme,
    dispatch: &UiDispatch,
) {
    let state = if !enabled {
        ButtonState::Disabled
    } else if dispatch.is_pressed(id) {
        ButtonState::Pressed
    } else if dispatch.is_hovered(id) {
        ButtonState::Hovered
    } else if dispatch.is_focused(id) {
        ButtonState::Focused
    } else {
        ButtonState::Resting
    };
    let mut region =
        InteractionRegion::new("MemoryAction", id, bounds, AccessibilityRole::Button, text)
            .with_parent(ROOT)
            .with_focus(FocusBehavior::TabStop)
            .with_navigation(NavigationGroupId::new(ROOT), NavigationAxis::Vertical)
            .with_cursor(CursorFeedback::Pointer);
    if enabled {
        region = region.with_action(NodeAction::Activate);
    }
    context.draw_component(&region);
    context.draw_component(&Button::new(
        bounds,
        text,
        state,
        ButtonStyle::new(
            ButtonBackgrounds::new(theme.side_bar_background)
                .with_hovered(theme.list_hover_background)
                .with_focused(theme.list_active_background)
                .with_pressed(theme.hover_background),
            theme.interface_control.text_style(theme.foreground),
        )
        .with_border(Border::uniform(1.0, theme.border))
        .with_corner_radii(CornerRadii::uniform(4.0)),
    ));
}

fn input(
    context: &mut ComponentContext<'_, '_>,
    id: ElementId,
    label: &str,
    value: &TextInput,
    bounds: Rect,
    theme: UiTheme,
    dispatch: &UiDispatch,
    caret: CaretVisibility,
    layout: &mut TextInputLayoutEngine,
    ime: &mut Option<Rect>,
) {
    let style = InputBoxStyle::new(
        InputBoxStateColors::new(
            theme.side_bar_background,
            theme.side_bar_background,
            theme.side_bar_background,
        ),
        InputBoxStateColors::new(theme.border, theme.hover_border, theme.accent),
        theme.interface_control.text_style(theme.foreground),
        theme.interface_control.text_style(theme.muted_foreground),
    )
    .with_corner_radii(CornerRadii::uniform(4.0))
    .with_selection_color(theme.text_selection_background)
    .with_caret_color(theme.accent);
    context.draw_component(
        &InteractionRegion::new(
            "MemoryInput",
            id,
            bounds,
            AccessibilityRole::TextInput,
            label,
        )
        .with_parent(ROOT)
        .with_focus(FocusBehavior::TabStop)
        .with_navigation(NavigationGroupId::new(ROOT), NavigationAxis::Vertical)
        .with_cursor(CursorFeedback::Text)
        .with_value(value.text()),
    );
    let input = InputBox::new(
        bounds,
        label,
        if dispatch.is_focused(id) {
            InputBoxState::Focused(caret)
        } else {
            InputBoxState::Resting
        },
        style,
        value,
        layout,
    );
    if dispatch.is_focused(id) {
        *ime = input.caret_bounds();
    }
    context.draw_component(&input);
}
fn label(scene: &mut UiScene, text: &str, bounds: Rect, theme: UiTheme) {
    scene.draw_text(TextBlock::new(
        text,
        bounds.origin,
        bounds.size,
        theme.interface_body.text_style(theme.foreground),
    ));
}
