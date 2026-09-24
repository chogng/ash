use ash_remote_connections::RemoteConnectionEntry;
use ash_remote_connections::RemoteConnectionName;
use ash_ui_components::ButtonBackgrounds;
use ash_ui_components::ButtonStyle;
use ash_ui_components::Picker;
use ash_ui_components::PickerIds;
use ash_ui_components::PickerItem;
use ash_ui_components::PickerStyle;
use ash_ui_components::ScrollAxis;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollMetrics;
use ash_ui_components::ScrollState;
use zui::ui::CaretVisibility;
use zui::ui::Color;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CornerRadii;
use zui::ui::Edges;
use zui::ui::ElementId;
use zui::ui::Rect;
use zui::ui::Size;
use zui::ui::TextInput;
use zui::ui::TextInputCommand;
use zui::ui::TextInputCompositionEvent;
use zui::ui::TextInputLayoutEngine;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;
use zui::ui::UiNode;
use zui::ui::UiScene;

use crate::remote::style::RemoteUiStyle;

const REMOTE_CONNECTION_PICKER_SCOPE: u32 = 9;
const REMOTE_CONNECTION_PICKER: ElementId = ElementId::scoped(REMOTE_CONNECTION_PICKER_SCOPE, 1);
pub const REMOTE_CONNECTION_SEARCH_INPUT: ElementId =
    ElementId::scoped(REMOTE_CONNECTION_PICKER_SCOPE, 2);
const FIRST_REMOTE_CONNECTION_ITEM: u32 = 3;
const PICKER_VISIBLE_ITEM_COUNT: usize = 8;
const PICKER_CONTENT_WIDTH: f32 = 440.0;
pub const REMOTE_CONNECTION_ITEM_HEIGHT: f32 = 30.0;

#[derive(Clone, Debug, Eq, PartialEq)]
struct RemoteConnectionPickerItem {
    label: String,
    action: Option<RemoteConnectionPickerAction>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RemoteConnectionPickerAction {
    Manage,
    ManageTunnels,
    Connect(RemoteConnectionName),
}

#[derive(Clone, Debug, PartialEq)]
struct OpenRemoteConnectionPicker {
    anchor: Rect,
    connections: Vec<RemoteConnectionEntry>,
    tunnels_available: bool,
    restore_focus: Option<ElementId>,
}

/// Product-owned picker state over the shared credential-free Remote target catalog.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemoteConnectionPickerState {
    open: Option<OpenRemoteConnectionPicker>,
    search_input: TextInput,
    scroll: ScrollState,
}

impl RemoteConnectionPickerState {
    pub fn open(
        &mut self,
        anchor: Rect,
        mut connections: Vec<RemoteConnectionEntry>,
        tunnels_available: bool,
        restore_focus: Option<ElementId>,
    ) {
        connections.sort_by(|left, right| left.name().cmp(right.name()));
        self.search_input.take_text();
        self.open = Some(OpenRemoteConnectionPicker {
            anchor,
            connections,
            tunnels_available,
            restore_focus,
        });
        self.scroll = ScrollState::default();
    }

    pub const fn is_open(&self) -> bool {
        self.open.is_some()
    }

    pub fn dismiss(&mut self) -> Option<ElementId> {
        self.open.take().and_then(|open| open.restore_focus)
    }

    pub const fn search_input(&self) -> &TextInput {
        &self.search_input
    }

    pub fn apply_search(&mut self, command: TextInputCommand) {
        self.search_input.apply(command);
        self.scroll = ScrollState::default();
    }

    pub fn apply_search_composition(&mut self, event: TextInputCompositionEvent) {
        self.search_input.apply_composition(event);
        self.scroll = ScrollState::default();
    }

    pub fn cancel_search_composition(&mut self) {
        self.search_input.cancel_composition();
    }

    pub fn selected_search_text(&self) -> Option<&str> {
        self.search_input.selected_text()
    }

    pub const fn scroll_state(&self) -> ScrollState {
        self.scroll
    }

    pub fn apply_scroll(&mut self, command: ScrollCommand, metrics: ScrollMetrics) -> bool {
        self.scroll.apply(command, metrics, ScrollAxis::Vertical)
    }

    pub fn ensure_item_visible(&mut self, index: usize, metrics: ScrollMetrics) -> bool {
        self.apply_scroll(
            ScrollCommand::EnsureVisible(Rect::from_xywh(
                0.0,
                index as f32 * REMOTE_CONNECTION_ITEM_HEIGHT,
                metrics.content().width,
                REMOTE_CONNECTION_ITEM_HEIGHT,
            )),
            metrics,
        )
    }

    pub fn first_action_id(&self) -> Option<ElementId> {
        self.items().iter().enumerate().find_map(|(index, item)| {
            item.action
                .as_ref()
                .map(|_| remote_connection_item_id(index))
        })
    }

    pub fn is_picker_element(&self, id: ElementId) -> bool {
        id == REMOTE_CONNECTION_PICKER
            || id == REMOTE_CONNECTION_SEARCH_INPUT
            || self
                .items()
                .iter()
                .enumerate()
                .any(|(index, _)| remote_connection_item_id(index) == id)
    }

    pub fn item_index(&self, id: ElementId) -> Option<usize> {
        self.items()
            .iter()
            .enumerate()
            .find_map(|(index, _)| (remote_connection_item_id(index) == id).then_some(index))
    }

    pub fn activate(&self, index: usize) -> Option<RemoteConnectionPickerAction> {
        self.items().get(index)?.action.clone()
    }

    fn items(&self) -> Vec<RemoteConnectionPickerItem> {
        let Some(open) = self.open.as_ref() else {
            return Vec::new();
        };
        let query = self.search_input.text().trim().to_ascii_lowercase();
        let mut items = Vec::new();
        if query.is_empty() || "manage remote connections".contains(&query) {
            items.push(RemoteConnectionPickerItem {
                label: "Manage Remote connections…".into(),
                action: Some(RemoteConnectionPickerAction::Manage),
            });
        }
        if open.tunnels_available && (query.is_empty() || "manage remote tunnels".contains(&query))
        {
            items.push(RemoteConnectionPickerItem {
                label: "Manage Remote tunnels…".into(),
                action: Some(RemoteConnectionPickerAction::ManageTunnels),
            });
        }
        items.extend(
            open.connections
                .iter()
                .filter(|entry| {
                    query.is_empty()
                        || entry.name().as_str().contains(&query)
                        || entry
                            .target()
                            .host()
                            .as_str()
                            .to_ascii_lowercase()
                            .contains(&query)
                        || entry
                            .target()
                            .dir()
                            .as_str()
                            .to_ascii_lowercase()
                            .contains(&query)
                })
                .map(|entry| RemoteConnectionPickerItem {
                    label: format!(
                        "{} · {} · {}",
                        entry.name().as_str(),
                        entry.target().host().as_str(),
                        entry.target().dir().as_str()
                    ),
                    action: Some(RemoteConnectionPickerAction::Connect(entry.name().clone())),
                }),
        );
        if !items.is_empty() {
            return items;
        }
        vec![RemoteConnectionPickerItem {
            label: if open.connections.is_empty() {
                "No matching Remote actions".into()
            } else {
                "No matching Remote connections".into()
            },
            action: None,
        }]
    }
}

pub struct RemoteConnectionPicker {
    picker: Picker,
}

impl RemoteConnectionPicker {
    pub fn new(
        viewport: Rect,
        state: &RemoteConnectionPickerState,
        caret_visibility: CaretVisibility,
        palette: RemoteUiStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &UiDispatch,
        parent: ElementId,
    ) -> Option<Self> {
        let open = state.open.as_ref()?;
        let items = state.items();
        let selected_backgrounds = ButtonBackgrounds::new(palette.session_tab_highlight)
            .with_hovered(palette.session_tab_highlight)
            .with_focused(palette.session_tab_highlight)
            .with_pressed(palette.border);
        let button_style = ButtonStyle::new(
            ButtonBackgrounds::new(Color::TRANSPARENT),
            TextStyle::new(13.0, palette.text).with_line_height(18.0),
        )
        .with_selected_backgrounds(selected_backgrounds)
        .with_corner_radii(CornerRadii::uniform(2.0))
        .with_padding(Edges::new(0.0, 10.0, 0.0, 10.0));
        let picker_items = items
            .iter()
            .enumerate()
            .map(|(index, entry)| {
                let item = PickerItem::new(remote_connection_item_id(index), entry.label.clone());
                if entry.action.is_some() {
                    item
                } else {
                    item.disabled()
                }
            })
            .collect();
        let picker = Picker::new(
            viewport,
            open.anchor,
            "Open Remote connection",
            "Search Remote connections...",
            state.search_input(),
            caret_visibility,
            picker_items,
            state.scroll_state(),
            PickerIds::new(
                parent,
                REMOTE_CONNECTION_PICKER,
                REMOTE_CONNECTION_SEARCH_INPUT,
            ),
            PickerStyle::new(
                palette.surface,
                button_style,
                palette.session_search_style(),
                palette.picker_scroll_view_style(),
                Size::new(PICKER_CONTENT_WIDTH, REMOTE_CONNECTION_ITEM_HEIGHT),
                PICKER_VISIBLE_ITEM_COUNT,
            ),
            text_layout,
            dispatch,
        );
        Some(Self { picker })
    }

    #[cfg(test)]
    pub const fn bounds(&self) -> Rect {
        self.picker.bounds()
    }

    pub const fn search_caret_bounds(&self) -> Option<Rect> {
        self.picker.search_caret_bounds()
    }

    pub const fn item_viewport_bounds(&self) -> Rect {
        self.picker.item_viewport_bounds()
    }

    pub fn scroll_metrics(&self) -> Option<ScrollMetrics> {
        self.picker.scroll_metrics()
    }
}

impl Component for RemoteConnectionPicker {
    fn element(&self) -> ComponentElement {
        self.picker.element()
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        self.picker.interaction_node(element)
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, element: &ComputedElement) {
        self.picker.compose(context, element);
    }

    fn paint(&self, scene: &mut UiScene) {
        self.picker.paint(scene);
    }
}

pub fn remote_connection_item_id(index: usize) -> ElementId {
    ElementId::scoped(
        REMOTE_CONNECTION_PICKER_SCOPE,
        FIRST_REMOTE_CONNECTION_ITEM.saturating_add(index as u32),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use ash_remote::RemoteDirPath;
    use ash_remote::SshHost;
    use ash_remote::SshTarget;
    use zui::ui::{AccessibilityRole, InteractionFrame, UiDispatch, UiFrame};
    use zui::ui::{CaretVisibility, TextInputLayoutEngine};

    #[test]
    fn picker_sorts_filters_and_activates_canonical_connection_names() {
        let mut state = RemoteConnectionPickerState::default();
        state.open(
            Rect::from_xywh(40.0, 640.0, 80.0, 24.0),
            vec![
                connection("zulu", "zulu.example", "/srv/backend"),
                connection("alpha", "build.example", "/work/frontend"),
            ],
            false,
            Some(crate::remote::interaction::REMOTE_UI_ROOT),
        );

        assert_eq!(
            state.activate(0),
            Some(RemoteConnectionPickerAction::Manage)
        );
        assert!(state.items()[1].label.starts_with("alpha · build.example"));
        assert_eq!(
            state.activate(1),
            Some(RemoteConnectionPickerAction::Connect(
                RemoteConnectionName::parse("alpha").unwrap()
            ))
        );
        state.apply_search(TextInputCommand::Insert("BACK".into()));
        assert_eq!(state.items().len(), 1);
        assert!(state.items()[0].label.contains("/srv/backend"));
        assert_eq!(
            state.activate(0),
            Some(RemoteConnectionPickerAction::Connect(
                RemoteConnectionName::parse("zulu").unwrap()
            ))
        );
        assert_eq!(
            state.dismiss(),
            Some(crate::remote::interaction::REMOTE_UI_ROOT)
        );
    }

    #[test]
    fn empty_catalogs_offer_management_and_unmatched_searches_are_passive() {
        let mut state = RemoteConnectionPickerState::default();
        state.open(
            Rect::from_xywh(40.0, 640.0, 80.0, 24.0),
            Vec::new(),
            false,
            None,
        );
        assert_eq!(state.items()[0].label, "Manage Remote connections…");
        assert_eq!(
            state.activate(0),
            Some(RemoteConnectionPickerAction::Manage)
        );
        assert!(state.first_action_id().is_some());

        state.open(
            Rect::from_xywh(40.0, 640.0, 80.0, 24.0),
            vec![connection("build", "build.example", "/srv/project")],
            false,
            None,
        );
        state.apply_search(TextInputCommand::Insert("missing".into()));
        assert_eq!(state.items()[0].label, "No matching Remote connections");
        assert!(state.activate(0).is_none());
    }

    #[test]
    fn picker_is_modal_and_stays_above_its_anchor() {
        let anchor = Rect::from_xywh(40.0, 640.0, 80.0, 24.0);
        let mut state = RemoteConnectionPickerState::default();
        state.open(
            anchor,
            vec![connection("build", "build.example", "/srv/project")],
            false,
            None,
        );
        let style = crate::remote::test_style();
        let dispatch = UiDispatch::default();
        let mut text_layout = TextInputLayoutEngine::new();
        let picker = RemoteConnectionPicker::new(
            Rect::from_xywh(0.0, 0.0, 1_000.0, 700.0),
            &state,
            CaretVisibility::Visible,
            style,
            &mut text_layout,
            &dispatch,
            crate::remote::interaction::REMOTE_UI_ROOT,
        )
        .unwrap();
        let mut frame = UiFrame::<InteractionFrame>::new(style.surface);
        frame.draw_component(&picker);
        let nodes = frame.interaction().accessibility_nodes(&dispatch);

        assert!(picker.bounds().bottom() <= anchor.origin.y);
        assert_eq!(nodes[0].role, AccessibilityRole::Menu);
        assert!(
            nodes
                .iter()
                .any(|node| node.role == AccessibilityRole::TextInput)
        );
    }

    fn connection(name: &str, host: &str, dir: &str) -> RemoteConnectionEntry {
        RemoteConnectionEntry::new(
            RemoteConnectionName::parse(name).unwrap(),
            SshTarget::new(
                SshHost::parse(host).unwrap(),
                RemoteDirPath::parse(dir).unwrap(),
            ),
        )
    }
}
