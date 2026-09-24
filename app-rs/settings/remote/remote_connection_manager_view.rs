use ash_ui_components::Button;
use ash_ui_components::ButtonSelection;
use ash_ui_components::ButtonState;
use ash_ui_components::InputBox;
use ash_ui_components::InteractionRegion;
use ash_ui_components::ListView;
use ash_ui_components::ScrollMetrics;
use zui::ui::AccessibilityRole;
use zui::ui::AccessibilitySelection;
use zui::ui::Border;
use zui::ui::CaretVisibility;
use zui::ui::Color;
use zui::ui::Component;
use zui::ui::ComponentContext;
use zui::ui::ComponentElement;
use zui::ui::ComputedElement;
use zui::ui::CornerRadii;
use zui::ui::CursorFeedback;
use zui::ui::Element;
use zui::ui::ElementId;
use zui::ui::FocusBehavior;
use zui::ui::FontWeight;
use zui::ui::NavigationAxis;
use zui::ui::NavigationGroupId;
use zui::ui::NodeAction;
use zui::ui::PaintRect;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::Size;
use zui::ui::TextBlock;
use zui::ui::TextInputLayoutEngine;
use zui::ui::TextStyle;
use zui::ui::UiDispatch;
use zui::ui::UiNode;
use zui::ui::UiScene;

use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_CLOSE;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_CONNECT;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_DELETE;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_DIRECTORY;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_HOST;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_ITEM_HEIGHT;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_LIST;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_NAME;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_NEW;
use crate::remote::remote_connection_manager::REMOTE_CONNECTION_MANAGER_SAVE;
use crate::remote::remote_connection_manager::RemoteConnectionManagerField;
use crate::remote::remote_connection_manager::RemoteConnectionManagerState;
use crate::remote::remote_connection_manager::remote_connection_manager_item_id;
use crate::remote::style::RemoteUiStyle;

#[path = "remote_connection_manager_style.rs"]
mod style;
use style::CONTENT_INSET;
use style::PANEL_HEIGHT;
use style::PANEL_MARGIN;
use style::PANEL_WIDTH;
use style::TITLE_HEIGHT;
use style::action_button_style;
use style::close_bounds;
use style::connect_bounds;
use style::delete_bounds;
use style::input_bounds;
use style::input_style;
use style::list_bounds;
use style::list_button_style;
use style::new_bounds;
use style::save_bounds;
use style::status_bounds;

#[path = "remote_connection_manager_interaction.rs"]
mod interaction;
use interaction::button_region;
use interaction::input_region;
use interaction::input_state;
use interaction::status_region;

pub struct RemoteConnectionManager<'a> {
    viewport: Rect,
    panel: Rect,
    modal: bool,
    state: &'a RemoteConnectionManagerState,
    palette: RemoteUiStyle,
    dispatch: &'a UiDispatch,
    parent: ElementId,
    list: ListView,
    name_input: InputBox,
    host_input: InputBox,
    dir_input: InputBox,
}

impl<'a> RemoteConnectionManager<'a> {
    pub fn new(
        viewport: Rect,
        state: &'a RemoteConnectionManagerState,
        caret_visibility: CaretVisibility,
        palette: RemoteUiStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &'a UiDispatch,
        parent: ElementId,
    ) -> Option<Self> {
        if !state.is_dialog() {
            return None;
        }
        let width = PANEL_WIDTH.min((viewport.size.width - PANEL_MARGIN * 2.0).max(1.0));
        let height = PANEL_HEIGHT.min((viewport.size.height - PANEL_MARGIN * 2.0).max(1.0));
        let panel = Rect::from_xywh(
            viewport.origin.x + (viewport.size.width - width) * 0.5,
            viewport.origin.y + (viewport.size.height - height) * 0.5,
            width,
            height,
        );
        Some(Self::build(
            viewport,
            panel,
            true,
            state,
            caret_visibility,
            palette,
            text_layout,
            dispatch,
            parent,
        ))
    }

    /// Creates the non-modal connection editor mounted by the Remote Settings section.
    #[allow(clippy::too_many_arguments)]
    pub fn new_settings(
        panel: Rect,
        state: &'a RemoteConnectionManagerState,
        caret_visibility: CaretVisibility,
        palette: RemoteUiStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &'a UiDispatch,
        parent: ElementId,
    ) -> Option<Self> {
        if !state.is_settings() {
            return None;
        }
        let panel = Rect::from_xywh(
            panel.origin.x,
            panel.origin.y,
            PANEL_WIDTH.min(panel.size.width.max(1.0)),
            PANEL_HEIGHT.min(panel.size.height.max(1.0)),
        );
        Some(Self::build(
            panel,
            panel,
            false,
            state,
            caret_visibility,
            palette,
            text_layout,
            dispatch,
            parent,
        ))
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        viewport: Rect,
        panel: Rect,
        modal: bool,
        state: &'a RemoteConnectionManagerState,
        caret_visibility: CaretVisibility,
        palette: RemoteUiStyle,
        text_layout: &mut TextInputLayoutEngine,
        dispatch: &'a UiDispatch,
        parent: ElementId,
    ) -> Self {
        let list = ListView::new(
            list_bounds(panel),
            state.connections().len(),
            REMOTE_CONNECTION_MANAGER_ITEM_HEIGHT,
            state.scroll_state(),
            palette.file_list_scroll_view_style(),
        );
        let input_style = input_style(palette);
        let name_input = InputBox::new(
            input_bounds(panel, RemoteConnectionManagerField::Name),
            "build-server",
            input_state(dispatch, REMOTE_CONNECTION_MANAGER_NAME, caret_visibility),
            input_style.clone(),
            state.input(RemoteConnectionManagerField::Name),
            text_layout,
        );
        let host_input = InputBox::new(
            input_bounds(panel, RemoteConnectionManagerField::Host),
            "OpenSSH host alias",
            input_state(dispatch, REMOTE_CONNECTION_MANAGER_HOST, caret_visibility),
            input_style.clone(),
            state.input(RemoteConnectionManagerField::Host),
            text_layout,
        );
        let dir_input = InputBox::new(
            input_bounds(panel, RemoteConnectionManagerField::Directory),
            "/absolute/remote/dir",
            input_state(
                dispatch,
                REMOTE_CONNECTION_MANAGER_DIRECTORY,
                caret_visibility,
            ),
            input_style,
            state.input(RemoteConnectionManagerField::Directory),
            text_layout,
        );
        Self {
            viewport,
            panel,
            modal,
            state,
            palette,
            dispatch,
            parent,
            list,
            name_input,
            host_input,
            dir_input,
        }
    }

    pub fn caret_bounds(&self, field: RemoteConnectionManagerField) -> Option<Rect> {
        match field {
            RemoteConnectionManagerField::Name => self.name_input.caret_bounds(),
            RemoteConnectionManagerField::Host => self.host_input.caret_bounds(),
            RemoteConnectionManagerField::Directory => self.dir_input.caret_bounds(),
        }
    }

    pub fn list_scroll_metrics(&self) -> ScrollMetrics {
        self.list.scroll_view().metrics()
    }

    pub const fn list_viewport_bounds(&self) -> Rect {
        self.list.scroll_view().bounds()
    }

    #[cfg(test)]
    pub const fn panel_bounds(&self) -> Rect {
        self.panel
    }

    fn interaction_regions(&self) -> Vec<InteractionRegion> {
        let navigation = NavigationGroupId::new(REMOTE_CONNECTION_MANAGER);
        let mut regions = vec![
            InteractionRegion::new(
                "RemoteConnectionManagerList",
                REMOTE_CONNECTION_MANAGER_LIST,
                self.list_viewport_bounds(),
                AccessibilityRole::List,
                "Saved Remote connections",
            )
            .with_parent(REMOTE_CONNECTION_MANAGER),
        ];
        if self.modal {
            regions.push(button_region(
                REMOTE_CONNECTION_MANAGER_CLOSE,
                close_bounds(self.panel),
                if self.state.is_launching() {
                    "Cancel Remote window launch and close"
                } else {
                    "Close Remote connection manager"
                },
                navigation,
                true,
            ));
        }
        regions.extend([
            button_region(
                REMOTE_CONNECTION_MANAGER_NEW,
                new_bounds(self.panel),
                "Create a new Remote connection",
                navigation,
                self.state.can_mutate(),
            ),
            input_region(
                REMOTE_CONNECTION_MANAGER_NAME,
                self.name_input.bounds(),
                "Connection name",
                self.state.input(RemoteConnectionManagerField::Name).text(),
                navigation,
            ),
            input_region(
                REMOTE_CONNECTION_MANAGER_HOST,
                self.host_input.bounds(),
                "OpenSSH host alias",
                self.state.input(RemoteConnectionManagerField::Host).text(),
                navigation,
            ),
            input_region(
                REMOTE_CONNECTION_MANAGER_DIRECTORY,
                self.dir_input.bounds(),
                "Absolute Remote Directory path",
                self.state
                    .input(RemoteConnectionManagerField::Directory)
                    .text(),
                navigation,
            ),
            button_region(
                REMOTE_CONNECTION_MANAGER_DELETE,
                delete_bounds(self.panel),
                self.state.delete_label(),
                navigation,
                self.state.can_delete(),
            ),
            button_region(
                REMOTE_CONNECTION_MANAGER_SAVE,
                save_bounds(self.panel),
                "Save Remote connection",
                navigation,
                self.state.can_mutate(),
            ),
            button_region(
                REMOTE_CONNECTION_MANAGER_CONNECT,
                connect_bounds(self.panel),
                "Connect in a new app window",
                navigation,
                self.state.can_connect(),
            ),
        ]);
        for index in self.list.visible_range() {
            let Some(bounds) = self.list.item_bounds(index) else {
                continue;
            };
            let entry = &self.state.connections()[index];
            regions.push(
                InteractionRegion::new(
                    "RemoteConnectionManagerItem",
                    remote_connection_manager_item_id(index),
                    bounds.intersection(self.list_viewport_bounds()),
                    AccessibilityRole::ListItem,
                    format!(
                        "{}, {}, {}",
                        entry.name().as_str(),
                        entry.target().host().as_str(),
                        entry.target().dir().as_str()
                    ),
                )
                .with_parent(REMOTE_CONNECTION_MANAGER_LIST)
                .with_cursor(CursorFeedback::Pointer)
                .with_focus(FocusBehavior::TabStop)
                .with_action(NodeAction::Activate)
                .with_navigation(navigation, NavigationAxis::Vertical)
                .with_selection(
                    if self.state.selected_name() == Some(entry.name()) {
                        AccessibilitySelection::Selected
                    } else {
                        AccessibilitySelection::Unselected
                    },
                ),
            );
        }
        if let Some((status, _)) = self.state.status() {
            regions.push(status_region(status_bounds(self.panel), status));
        }
        regions
    }

    fn button_state(&self, id: ElementId, enabled: bool) -> ButtonState {
        if !enabled {
            ButtonState::Disabled
        } else if self.dispatch.is_pressed(id) {
            ButtonState::Pressed
        } else if self.dispatch.is_focused(id) {
            ButtonState::Focused
        } else if self.dispatch.is_hovered(id) {
            ButtonState::Hovered
        } else {
            ButtonState::Resting
        }
    }

    fn paint_content(&self, scene: &mut UiScene) {
        if self.modal {
            scene.draw_rect(PaintRect::new(self.viewport, Color::rgba(0, 0, 0, 76)));
        }
        scene.draw_rect(
            PaintRect::new(self.panel, self.palette.surface)
                .with_border(Border::uniform(1.0, self.palette.border))
                .with_corner_radii(CornerRadii::uniform(8.0)),
        );
        draw_text(
            scene,
            "Remote Connections",
            Rect::from_xywh(
                self.panel.origin.x + CONTENT_INSET,
                self.panel.origin.y + 18.0,
                self.panel.size.width - CONTENT_INSET * 2.0 - 40.0,
                TITLE_HEIGHT,
            ),
            TextStyle::new(18.0, self.palette.text)
                .with_line_height(TITLE_HEIGHT)
                .with_weight(FontWeight::Bold),
        );
        draw_text(
            scene,
            "Targets are credential-free; app invokes your local OpenSSH configuration.",
            Rect::from_xywh(
                self.panel.origin.x + CONTENT_INSET,
                self.panel.origin.y + 45.0,
                self.panel.size.width - CONTENT_INSET * 2.0,
                18.0,
            ),
            TextStyle::new(12.0, self.palette.text_muted).with_line_height(18.0),
        );
        scene.draw_rect(
            PaintRect::new(list_bounds(self.panel), self.palette.surface_raised)
                .with_border(Border::uniform(1.0, self.palette.border))
                .with_corner_radii(CornerRadii::uniform(4.0)),
        );
        if self.state.connections().is_empty() {
            draw_text(
                scene,
                "No saved connections",
                list_bounds(self.panel),
                TextStyle::new(12.0, self.palette.text_muted).with_line_height(20.0),
            );
        } else {
            self.list.draw(scene, |scene, layout| {
                let index = layout.index();
                let entry = &self.state.connections()[index];
                let id = remote_connection_manager_item_id(index);
                let selected = self.state.selected_name() == Some(entry.name());
                let button = Button::new(
                    layout.bounds(),
                    entry.name().as_str(),
                    self.button_state(id, true),
                    list_button_style(self.palette),
                )
                .with_selection(if selected {
                    ButtonSelection::Selected
                } else {
                    ButtonSelection::Unselected
                });
                scene.draw_component(&button);
            });
        }
        for (field, label) in [
            (RemoteConnectionManagerField::Name, "Name"),
            (RemoteConnectionManagerField::Host, "SSH host"),
            (RemoteConnectionManagerField::Directory, "Remote Directory"),
        ] {
            let bounds = input_bounds(self.panel, field);
            draw_text(
                scene,
                label,
                Rect::from_xywh(
                    bounds.origin.x,
                    bounds.origin.y - 21.0,
                    bounds.size.width,
                    18.0,
                ),
                TextStyle::new(12.0, self.palette.text_muted).with_line_height(18.0),
            );
        }
        scene.draw_component(&self.name_input);
        scene.draw_component(&self.host_input);
        scene.draw_component(&self.dir_input);
        if let Some((status, error)) = self.state.status() {
            draw_text(
                scene,
                status,
                status_bounds(self.panel),
                TextStyle::new(
                    12.0,
                    if error {
                        self.palette.error
                    } else {
                        self.palette.text_muted
                    },
                )
                .with_line_height(18.0),
            );
        }
        let mut actions = vec![
            (
                REMOTE_CONNECTION_MANAGER_NEW,
                new_bounds(self.panel),
                "New Connection",
                self.state.can_mutate(),
                false,
            ),
            (
                REMOTE_CONNECTION_MANAGER_DELETE,
                delete_bounds(self.panel),
                self.state.delete_label(),
                self.state.can_delete(),
                false,
            ),
            (
                REMOTE_CONNECTION_MANAGER_SAVE,
                save_bounds(self.panel),
                "Save",
                self.state.can_mutate(),
                true,
            ),
            (
                REMOTE_CONNECTION_MANAGER_CONNECT,
                connect_bounds(self.panel),
                "Connect",
                self.state.can_connect(),
                true,
            ),
        ];
        if self.modal {
            actions.insert(
                0,
                (
                    REMOTE_CONNECTION_MANAGER_CLOSE,
                    close_bounds(self.panel),
                    "×",
                    true,
                    false,
                ),
            );
        }
        for (id, bounds, label, enabled, primary) in actions {
            scene.draw_component(&Button::new(
                bounds,
                label,
                self.button_state(id, enabled),
                action_button_style(self.palette, primary),
            ));
        }
    }
}

impl Component for RemoteConnectionManager<'_> {
    fn element(&self) -> ComponentElement {
        Element::leaf("RemoteConnectionManager")
            .in_bounds(self.panel)
            .with_identity(REMOTE_CONNECTION_MANAGER)
    }

    fn interaction_node(&self, element: &ComputedElement) -> Option<UiNode> {
        Some(
            UiNode::new(
                REMOTE_CONNECTION_MANAGER,
                element.bounds(),
                AccessibilityRole::Group,
                "Remote connection manager",
            )
            .with_parent(self.parent),
        )
    }

    fn compose(&self, context: &mut ComponentContext<'_, '_>, _element: &ComputedElement) {
        if self.modal {
            context.set_modal_root(REMOTE_CONNECTION_MANAGER);
        }
        for region in self.interaction_regions() {
            context.draw_component(&region);
        }
        self.paint_content(context.scene_mut());
    }

    fn paint(&self, scene: &mut UiScene) {
        self.paint_content(scene);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ash_remote::RemoteDirPath;
    use ash_remote::SshHost;
    use ash_remote::SshTarget;
    use ash_remote_connections::RemoteConnectionEntry;
    use ash_remote_connections::RemoteConnectionName;
    use zui::ui::{InteractionFrame, UiFrame};

    #[test]
    fn manager_exposes_form_list_and_action_accessibility() {
        let style = crate::remote::test_style();
        let mut state = RemoteConnectionManagerState::default();
        state.open(
            vec![RemoteConnectionEntry::new(
                RemoteConnectionName::parse("build").unwrap(),
                SshTarget::new(
                    SshHost::parse("build.example").unwrap(),
                    RemoteDirPath::parse("/srv/project").unwrap(),
                ),
            )],
            None,
        );
        let dispatch = UiDispatch::default();
        let mut text_layout = TextInputLayoutEngine::new();
        let manager = RemoteConnectionManager::new(
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
        frame.draw_component(&manager);
        let nodes = frame.interaction().accessibility_nodes(&dispatch);

        assert!(nodes.iter().any(|node| {
            node.id == REMOTE_CONNECTION_MANAGER_NAME && node.role == AccessibilityRole::TextInput
        }));
        assert!(nodes.iter().any(|node| {
            node.id == REMOTE_CONNECTION_MANAGER_LIST && node.role == AccessibilityRole::List
        }));
        assert!(nodes.iter().any(|node| {
            node.id == REMOTE_CONNECTION_MANAGER_SAVE && node.role == AccessibilityRole::Button
        }));
        assert!(manager.panel_bounds().size.width <= 720.0);
    }

    #[test]
    fn settings_surface_embeds_inputs_without_a_modal_close_action() {
        let style = crate::remote::test_style();
        let mut state = RemoteConnectionManagerState::default();
        state.open_settings(vec![RemoteConnectionEntry::new(
            RemoteConnectionName::parse("build").unwrap(),
            SshTarget::new(
                SshHost::parse("build.example").unwrap(),
                RemoteDirPath::parse("/srv/project").unwrap(),
            ),
        )]);
        let dispatch = UiDispatch::default();
        let mut text_layout = TextInputLayoutEngine::new();
        let panel = Rect::from_xywh(250.0, 80.0, 720.0, 470.0);
        let manager = RemoteConnectionManager::new_settings(
            panel,
            &state,
            CaretVisibility::Visible,
            style,
            &mut text_layout,
            &dispatch,
            crate::SETTINGS_PAGE,
        )
        .unwrap();
        let mut frame = UiFrame::<InteractionFrame>::new(style.surface);
        let host_id = ElementId::scoped(99, 1);
        let host = InteractionRegion::new(
            "SettingsSibling",
            host_id,
            Rect::from_xywh(0.0, 0.0, 100.0, 40.0),
            AccessibilityRole::Button,
            "Settings sibling",
        )
        .with_focus(FocusBehavior::TabStop)
        .with_action(NodeAction::Activate);

        frame.draw_component(&host);
        frame.draw_component(&manager);

        assert_eq!(manager.panel_bounds(), panel);
        assert!(frame.interaction().focus_order().any(|id| id == host_id));
        assert!(
            frame
                .interaction()
                .node(REMOTE_CONNECTION_MANAGER_NAME)
                .is_some()
        );
        assert!(
            frame
                .interaction()
                .node(REMOTE_CONNECTION_MANAGER_HOST)
                .is_some()
        );
        assert!(
            frame
                .interaction()
                .node(REMOTE_CONNECTION_MANAGER_DIRECTORY)
                .is_some()
        );
        assert!(
            frame
                .interaction()
                .node(REMOTE_CONNECTION_MANAGER_CLOSE)
                .is_none()
        );
    }
}

fn draw_text(scene: &mut UiScene, text: &str, bounds: Rect, style: TextStyle) {
    scene.draw_text(TextBlock::new(
        text,
        Point::new(bounds.origin.x, bounds.origin.y),
        Size::new(bounds.size.width, bounds.size.height),
        style,
    ));
}
