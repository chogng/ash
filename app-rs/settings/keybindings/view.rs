use ash_icons::icons;
use ash_ui_components::InputBoxStateColors;
use ash_ui_components::InputBoxStyle;
use ash_ui_components::KeycapSequence;
use ash_ui_components::KeycapStyle;
use ash_ui_components::QuickInputIds;
use ash_ui_components::QuickInputMessageKind;
use ash_ui_components::QuickInputStyle;
use ash_ui_components::QuickPick;
use ash_ui_components::QuickPickItem;
use ash_ui_components::QuickPickItemLayout;
use ash_ui_components::QuickPickSelection;
use ash_ui_components::QuickPickStyle;
use ash_ui_components::ScrollViewStyle;
use ash_ui_components::ScrollbarStyle;
use ash_ui_components::SearchBoxStyle;
use zui::ui::CaretVisibility;
use zui::ui::Color;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CornerRadii;
use zui::ui::Edges;
use zui::ui::Element;
use zui::ui::ElementId;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::TextInput;
use zui::ui::TextInputLayoutEngine;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;
use zui::ui::UiScene;

use super::state::KeyboardShortcutsState;
use ash_keybinding::HostPlatform;
use ash_keybinding::KeySequence;
use ash_keybinding::format_key_sequence;
use ash_keybinding::keycap_labels;

/// One host-owned command projected into the shortcut settings surface.
#[derive(Clone, Copy)]
pub struct KeyboardShortcutRow<'a, Command> {
    pub command: Command,
    pub element: ElementId,
    pub label: &'a str,
    pub keybinding: Option<&'a KeySequence>,
}

impl<'a, Command> KeyboardShortcutRow<'a, Command> {
    pub const fn new(
        command: Command,
        element: ElementId,
        label: &'a str,
        keybinding: Option<&'a KeySequence>,
    ) -> Self {
        Self {
            command,
            element,
            label,
            keybinding,
        }
    }
}

/// Shortcut quick-access dialog built from host-owned command rows.
pub struct KeyboardShortcuts<'a, Command> {
    quick_pick: QuickPick<'a>,
    state: &'a KeyboardShortcutsState<Command>,
    rows: Vec<&'a KeyboardShortcutRow<'a, Command>>,
    platform: HostPlatform,
}

impl<'a, Command: Copy + Eq> KeyboardShortcuts<'a, Command> {
    pub fn new(
        viewport: Rect,
        state: &'a KeyboardShortcutsState<Command>,
        search_input: &TextInput,
        rows: &'a [KeyboardShortcutRow<'a, Command>],
        diagnostics: &'a [String],
        ids: QuickInputIds,
        platform: HostPlatform,
        caret_visibility: CaretVisibility,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &'a UiDispatch,
    ) -> Self {
        let rows = rows.iter().collect::<Vec<_>>();
        let items = rows
            .iter()
            .map(|row| {
                let value = row
                    .keybinding
                    .map(|keybinding| format_key_sequence(keybinding, platform))
                    .unwrap_or_else(|| "Unassigned".to_owned());
                QuickPickItem::new(row.element, row.label).with_value(value)
            })
            .collect();
        let selection = state
            .recording_command()
            .and_then(|command| rows.iter().position(|row| row.command == command))
            .map(QuickPickSelection::Item)
            .unwrap_or_default();
        let (message, kind) = state
            .status_message()
            .map(|(message, error)| {
                (
                    message.to_owned(),
                    if error {
                        QuickInputMessageKind::Error
                    } else {
                        QuickInputMessageKind::Status
                    },
                )
            })
            .or_else(|| {
                diagnostics
                    .first()
                    .map(|diagnostic| (diagnostic.clone(), QuickInputMessageKind::Error))
            })
            .unwrap_or_else(|| {
                (
                    "Select a command, then press up to four key chords.".to_owned(),
                    QuickInputMessageKind::Status,
                )
            });
        let quick_pick = QuickPick::new(
            viewport,
            "Keyboard shortcuts",
            "Search keyboard shortcuts",
            search_input,
            caret_visibility,
            items,
            ids,
            quick_pick_style(),
            text_layout,
            dispatch,
        )
        .with_selection(selection)
        .with_message(message, kind);
        Self {
            quick_pick,
            state,
            rows,
            platform,
        }
    }

    fn paint_row(
        &self,
        scene: &mut UiScene,
        layout: QuickPickItemLayout,
        row: &KeyboardShortcutRow<'_, Command>,
    ) {
        let bounds = layout.bounds();
        let selected = self.state.recording_command() == Some(row.command);
        let style = self.quick_pick.style();
        let recorded = selected.then(|| self.state.recorded_keybinding()).flatten();
        let keybinding = recorded.as_ref().or(row.keybinding);
        let labels = keybinding
            .map(|keybinding| keycap_labels(keybinding, self.platform))
            .unwrap_or_default();
        if labels.is_empty() {
            scene.draw_text(zui::ui::TextBlock::new(
                if selected {
                    "Press keys…"
                } else {
                    "Unassigned"
                }
                .to_owned(),
                Point::new(bounds.right() - 130.0, bounds.origin.y + 8.0),
                zui::ui::Size::new(120.0, 18.0),
                TextStyle::new(12.0, style.text_muted()).with_line_height(18.0),
            ));
            return;
        }
        let style = keycap_style();
        let measured = KeycapSequence::new(Point::new(0.0, 0.0), labels.clone(), style.clone());
        let sequence = KeycapSequence::new(
            Point::new(
                (bounds.right() - measured.bounds().size.width - 10.0)
                    .max(bounds.origin.x + bounds.size.width * 0.5),
                bounds.origin.y + (bounds.size.height - measured.bounds().size.height) * 0.5,
            ),
            labels,
            style,
        );
        scene.draw_component(&sequence);
    }
}

impl<Command: Copy + Eq> Component for KeyboardShortcuts<'_, Command> {
    fn element(&self) -> ComponentElement {
        Element::leaf("KeyboardShortcuts").in_overlay(self.quick_pick.bounds())
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        self.quick_pick.draw_components(context, |context, layout| {
            self.paint_row(context.scene_mut(), layout, &self.rows[layout.index()]);
        });
    }

    fn paint_element(&self, scene: &mut UiScene, _element: &ComputedElement) {
        self.quick_pick.paint_items(scene, |scene, layout| {
            self.paint_row(scene, layout, &self.rows[layout.index()]);
        });
    }
}

impl<Command> KeyboardShortcuts<'_, Command> {
    pub const fn search_caret_bounds(&self) -> Option<Rect> {
        self.quick_pick.search_caret_bounds()
    }
}

fn quick_pick_style() -> QuickPickStyle {
    let text = Color::rgb(38, 38, 41);
    let text_muted = Color::rgb(126, 126, 132);
    let border = Color::rgb(222, 222, 224);
    let input_box = InputBoxStyle::new(
        InputBoxStateColors::new(Color::WHITE, Color::rgb(248, 248, 249), Color::WHITE),
        InputBoxStateColors::new(border, border, Color::rgb(58, 123, 213)),
        TextStyle::new(13.0, text).with_line_height(18.0),
        TextStyle::new(13.0, text_muted).with_line_height(18.0),
    )
    .with_corner_radii(CornerRadii::uniform(6.0))
    .with_padding(Edges::new(8.0, 10.0, 8.0, 10.0))
    .with_selection_color(Color::rgba(75, 125, 180, 120))
    .with_caret_color(Color::rgb(58, 123, 213))
    .with_preedit_underline_color(Color::rgb(58, 123, 213));
    let input = QuickInputStyle::new(
        Color::rgba(20, 20, 24, 72),
        Color::WHITE,
        border,
        text,
        text_muted,
        Color::rgb(176, 54, 64),
        Color::rgb(235, 235, 237),
        SearchBoxStyle::new(input_box, icons::SEARCH, text_muted),
    );
    QuickPickStyle::new(
        input,
        Color::rgb(248, 248, 249),
        Color::rgb(232, 241, 239),
        ScrollViewStyle::new(ScrollbarStyle::new(Color::TRANSPARENT, text_muted)),
    )
}

fn keycap_style() -> KeycapStyle {
    KeycapStyle::new(Color::rgb(62, 63, 69), Color::WHITE)
        .with_corner_radii(CornerRadii::uniform(4.0))
        .with_height(22.0)
        .with_minimum_width(22.0)
        .with_horizontal_padding(6.0)
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;
