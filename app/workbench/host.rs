//! Workbench state and content-binding coordination.

use std::collections::HashMap;

use crate::ClosedTab;
use crate::Pane;
use crate::PaneGroupId;
use crate::PaneInput;
use crate::PaneInputId;
use crate::PaneInputKind;
use crate::PanePart;
use crate::PaneResizeState;
use crate::PaneSplitDirection;
use crate::PaneSplitId;
use crate::TabContextMenuAction;
use crate::TabContextMenuActivation;
use crate::TabContextMenuState;
use crate::TabInput;
use crate::TabInputChange;
use crate::TabInputKey;
use crate::Workbench;
use crate::WorkbenchLayoutState;
use ash_ui_components::SashOrientation;
use ash_ui_components::SashState;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollMetrics;
use ash_ui_components::ScrollView;
use ash_ui_components::ScrollbarController;
use ash_ui_components::ScrollbarInteractionOutcome;
use ash_ui_components::ScrollbarPresentation;
use std::time::Instant;
use zui::ui::ElementId;
use zui::ui::HoverPresence;
use zui::ui::Point;
use zui::ui::Rect;
use zui::ui::SplitViewResizeSnapshot;
use zui::ui::TextInputCommand;
use zui::ui::TextInputCompositionEvent;

/// Stable identity of one content input mounted in a Workbench pane.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct PaneKey {
    tab: TabInputKey,
    pane: PaneGroupId,
    input: PaneInputId,
}

impl PaneKey {
    /// Creates the binding key for one pane input.
    pub const fn new(tab: TabInputKey, pane: PaneGroupId, input: PaneInputId) -> Self {
        Self { tab, pane, input }
    }

    /// Returns the owning top-level tab.
    pub const fn tab(&self) -> &TabInputKey {
        &self.tab
    }

    /// Returns the owning pane group.
    pub const fn pane(&self) -> PaneGroupId {
        self.pane
    }
}

struct BindingEntry<B> {
    id: u64,
    binding: B,
}

struct PaneHost<B> {
    bindings: HashMap<PaneKey, BindingEntry<B>>,
    next_binding_id: u64,
}

impl<B> PaneHost<B> {
    fn new() -> Self {
        Self {
            bindings: HashMap::new(),
            next_binding_id: 1,
        }
    }

    fn insert(&mut self, key: PaneKey, binding: B) -> Option<B> {
        let id = self.allocate_binding_id();
        let previous = self
            .bindings
            .insert(key, BindingEntry { id, binding })
            .map(|entry| entry.binding);
        previous
    }

    fn ensure_with(&mut self, key: PaneKey, create: impl FnOnce() -> B) -> &mut B {
        if !self.bindings.contains_key(&key) {
            let id = self.allocate_binding_id();
            self.bindings.insert(
                key.clone(),
                BindingEntry {
                    id,
                    binding: create(),
                },
            );
        }
        &mut self
            .bindings
            .get_mut(&key)
            .expect("ensured pane input binding must be present")
            .binding
    }

    fn remove(&mut self, key: &PaneKey) -> Option<B> {
        self.bindings.remove(key).map(|entry| entry.binding)
    }

    fn remove_panes(&mut self, tab: &TabInputKey, panes: &[Pane]) -> Vec<B> {
        panes
            .iter()
            .filter_map(|pane| self.remove(&PaneKey::new(tab.clone(), pane.id(), pane.input_id())))
            .collect()
    }

    fn remove_tab(&mut self, tab: &TabInputKey) -> Vec<B> {
        let bindings = std::mem::take(&mut self.bindings);
        let mut removed = Vec::new();
        for (key, entry) in bindings {
            if key.tab() == tab {
                removed.push(entry);
            } else {
                self.bindings.insert(key, entry);
            }
        }
        removed.sort_by_key(|entry| entry.id);
        removed.into_iter().map(|entry| entry.binding).collect()
    }

    fn binding(&self, key: &PaneKey) -> Option<&B> {
        self.bindings.get(key).map(|entry| &entry.binding)
    }

    fn mount<'a>(
        &'a self,
        tab: &TabInputKey,
        pane_part: &'a PanePart,
        pane: PaneGroupId,
    ) -> Option<PaneMount<'a, B>> {
        let input_id = pane_part.active_input_id(pane)?;
        let input = pane_part.active_input(pane)?;
        let key = PaneKey::new(tab.clone(), pane, input_id);
        let (key, entry) = self.bindings.get_key_value(&key)?;
        Some(PaneMount {
            key,
            input,
            binding: &entry.binding,
        })
    }

    fn allocate_binding_id(&mut self) -> u64 {
        let id = self.next_binding_id;
        self.next_binding_id = self
            .next_binding_id
            .checked_add(1)
            .expect("pane binding identity space exhausted");
        id
    }
}

/// Immutable mounted content selected by one pane group.
pub struct PaneMount<'a, B> {
    key: &'a PaneKey,
    input: &'a PaneInput,
    binding: &'a B,
}

impl<'a, B> Copy for PaneMount<'a, B> {}

impl<'a, B> Clone for PaneMount<'a, B> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<'a, B> PaneMount<'a, B> {
    /// Returns the complete content identity.
    pub const fn key(&self) -> &'a PaneKey {
        self.key
    }

    /// Returns the stable pane group identity.
    pub const fn pane_id(&self) -> PaneGroupId {
        self.key.pane()
    }

    /// Returns the selected content kind.
    pub const fn kind(&self) -> PaneInputKind {
        self.input.kind()
    }

    /// Returns the capability-owned runtime binding.
    pub const fn binding(&self) -> &'a B {
        self.binding
    }
}

/// Result of selecting or opening content in a pane group.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PaneActivation {
    current: PaneKey,
}

impl PaneActivation {
    /// Returns the selected content identity.
    pub const fn current(&self) -> &PaneKey {
        &self.current
    }
}

/// Pane-group teardown result, including every detached capability binding.
pub struct ClosedPane<B> {
    panes: Vec<Pane>,
    bindings: Vec<B>,
    active_pane: PaneGroupId,
}

impl<B> ClosedPane<B> {
    /// Returns all removed logical inputs.
    pub fn panes(&self) -> &[Pane] {
        &self.panes
    }

    /// Returns the pane selected after teardown.
    pub const fn active_pane(&self) -> PaneGroupId {
        self.active_pane
    }

    /// Consumes the result and returns detached capability bindings.
    pub fn into_bindings(self) -> Vec<B> {
        self.bindings
    }
}

/// Sole mutation boundary for Workbench state and content bindings.
pub struct WorkbenchHost<B> {
    workbench: Workbench,
    pane_host: PaneHost<B>,
    layout: WorkbenchLayoutState,
    tab_container_scrollbar: ScrollbarController,
    pane_resize: Option<PaneResizeState>,
    tab_context_menu: TabContextMenuState,
}

/// Application-facing result of activating a Workbench-owned tab menu item.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TabContextMenuOutcome {
    Ignored,
    Changed,
    Fork(TabInputKey),
    Archive(TabInputKey),
    Delete(TabInputKey),
    Focus(ElementId),
}

impl<B> Default for WorkbenchHost<B> {
    fn default() -> Self {
        Self::new()
    }
}

impl<B> WorkbenchHost<B> {
    /// Creates an empty coordinator.
    pub fn new() -> Self {
        Self {
            workbench: Workbench::new(),
            pane_host: PaneHost::new(),
            layout: WorkbenchLayoutState::default(),
            tab_container_scrollbar: ScrollbarController::default(),
            pane_resize: None,
            tab_context_menu: TabContextMenuState::default(),
        }
    }

    /// Returns the immutable Workbench model used for presentation queries.
    pub const fn workbench(&self) -> &Workbench {
        &self.workbench
    }

    /// Selects the active product mode in the Sidebar header.
    pub fn set_sidebar_mode(&mut self, mode: crate::SidebarMode) -> bool {
        self.workbench.set_sidebar_mode(mode)
    }

    /// Expands or collapses a named Session group in the Sidebar.
    pub fn toggle_sidebar_group(&mut self, group: crate::TabGroupId) -> bool {
        self.workbench.toggle_sidebar_group(group)
    }

    /// Returns the Workbench-owned tab menu presentation state.
    pub const fn tab_context_menu(&self) -> &TabContextMenuState {
        &self.tab_context_menu
    }

    /// Opens the actions menu for one known tab.
    pub fn open_tab_context_menu(
        &mut self,
        tab: TabInputKey,
        position: Point,
        restore_focus: Option<ElementId>,
    ) -> bool {
        if self.workbench.sidebar_part().input(&tab).is_none() {
            return false;
        }
        if self.workbench.sidebar_part().is_tab_pinned(&tab) {
            self.tab_context_menu
                .open_pinned(tab, position, restore_focus);
        } else {
            self.tab_context_menu
                .open_unpinned(tab, position, restore_focus);
        }
        true
    }

    /// Opens the Session-name editor beside its name in the directory details view.
    pub fn open_tab_rename(
        &mut self,
        tab: TabInputKey,
        anchor: Rect,
        restore_focus: Option<ElementId>,
    ) -> bool {
        let Some(input) = self.workbench.sidebar_part().input(&tab) else {
            return false;
        };
        let title = self.workbench.sidebar_part().tab_name(input).to_owned();
        let pinned = self.workbench.sidebar_part().is_tab_pinned(&tab);
        self.tab_context_menu
            .open_rename(tab, anchor, restore_focus, pinned, &title);
        true
    }

    /// Dismisses the tab menu and returns the element that previously owned focus.
    pub fn dismiss_tab_context_menu(&mut self) -> Option<ElementId> {
        self.tab_context_menu.dismiss()
    }

    /// Opens the tab group submenu without moving keyboard focus into it.
    pub fn open_tab_context_menu_groups(&mut self) -> bool {
        self.tab_context_menu.open_group_menu()
    }

    pub(crate) fn close_tab_context_menu_groups(&mut self) -> bool {
        self.tab_context_menu.close_group_menu()
    }

    /// Applies one tab-menu item to Workbench-owned state.
    pub fn activate_tab_context_menu(&mut self, id: ElementId) -> TabContextMenuOutcome {
        match self.tab_context_menu.activate(id) {
            TabContextMenuActivation::Ignored => TabContextMenuOutcome::Ignored,
            TabContextMenuActivation::OpenGroupMenu => {
                let target = self.tab_context_menu.target_tab();
                let source =
                    target.and_then(|target| self.workbench.sidebar_part().input_group(target));
                let focus = self
                    .workbench
                    .sidebar_part()
                    .groups()
                    .iter()
                    .find(|group| Some(group.id()) != source)
                    .map(|group| crate::tab_group_menu_element_id(group.id()))
                    .unwrap_or(crate::TAB_CONTEXT_MENU_MOVE_TO_NEW_GROUP);
                TabContextMenuOutcome::Focus(focus)
            }
            TabContextMenuActivation::TogglePin(tab) => {
                let changed = self.workbench.toggle_tab_pin(&tab).is_some();
                self.tab_context_menu.dismiss();
                if changed {
                    TabContextMenuOutcome::Changed
                } else {
                    TabContextMenuOutcome::Ignored
                }
            }
            TabContextMenuActivation::Fork(tab) => {
                self.tab_context_menu.dismiss();
                TabContextMenuOutcome::Fork(tab)
            }
            TabContextMenuActivation::Archive(tab) => {
                self.tab_context_menu.dismiss();
                TabContextMenuOutcome::Archive(tab)
            }
            TabContextMenuActivation::ConfirmDelete => {
                TabContextMenuOutcome::Focus(TabContextMenuAction::Delete.element_id())
            }
            TabContextMenuActivation::Delete(tab) => {
                self.tab_context_menu.dismiss();
                TabContextMenuOutcome::Delete(tab)
            }
            TabContextMenuActivation::MoveToGroup(tab, group) => {
                let index = self
                    .workbench
                    .sidebar_part()
                    .group(group)
                    .map(|group| group.inputs().len())
                    .unwrap_or(0);
                let changed = self.workbench.move_tab_to_group(&tab, group, index);
                self.tab_context_menu.dismiss();
                if changed {
                    TabContextMenuOutcome::Changed
                } else {
                    TabContextMenuOutcome::Ignored
                }
            }
            TabContextMenuActivation::MoveToNewGroup(tab) => {
                let changed = self
                    .workbench
                    .move_tab_to_new_group(&tab, "New group")
                    .is_some();
                self.tab_context_menu.dismiss();
                if changed {
                    TabContextMenuOutcome::Changed
                } else {
                    TabContextMenuOutcome::Ignored
                }
            }
            TabContextMenuActivation::BeginRename(tab) => {
                let title = self
                    .workbench
                    .sidebar_part()
                    .input(&tab)
                    .map(|input| self.workbench.sidebar_part().tab_name(input).to_owned());
                if let Some(title) = title {
                    self.tab_context_menu.set_rename_text(&title);
                    TabContextMenuOutcome::Focus(crate::TAB_RENAME_INPUT)
                } else {
                    TabContextMenuOutcome::Ignored
                }
            }
        }
    }

    pub fn apply_tab_rename(&mut self, command: TextInputCommand) -> bool {
        self.tab_context_menu.apply_rename(command)
    }

    pub fn apply_tab_rename_composition(&mut self, event: TextInputCompositionEvent) -> bool {
        self.tab_context_menu.apply_rename_composition(event)
    }

    pub fn commit_tab_rename(&mut self) -> bool {
        let Some((tab, title)) = self.tab_context_menu.take_rename() else {
            return false;
        };
        let changed = self.workbench.rename_tab(&tab, title);
        if changed {
            self.tab_context_menu.dismiss();
        }
        changed
    }

    /// Returns the body-mounted Tab Container presentation state.
    pub const fn tab_container_state(&self) -> crate::TabContainerState {
        self.layout.tab_container()
    }

    /// Returns the inspector presentation state.
    pub const fn inspector_state(&self) -> crate::InspectorPartState {
        self.layout.inspector()
    }

    pub fn toggle_tab_container(&mut self) {
        self.layout.toggle_tab_container();
        self.tab_container_scrollbar.cancel();
        self.sync_tab_container_scrollbar_presentation();
    }

    pub fn scroll_tab_container(&mut self, command: ScrollCommand, metrics: ScrollMetrics) -> bool {
        self.layout.scroll_tab_container(command, metrics)
    }

    pub fn tab_container_scrollbar_pointer_moved(
        &mut self,
        view: ScrollView,
        point: Point,
        now: Instant,
    ) -> ScrollbarInteractionOutcome {
        let outcome = self.tab_container_scrollbar.pointer_moved(
            view,
            self.layout.tab_container_scroll_state_mut(),
            point,
            now,
        );
        self.sync_tab_container_scrollbar_presentation();
        outcome
    }

    pub fn press_tab_container_scrollbar(
        &mut self,
        view: ScrollView,
        point: Point,
        now: Instant,
    ) -> ScrollbarInteractionOutcome {
        let outcome = self.tab_container_scrollbar.press(
            view,
            self.layout.tab_container_scroll_state_mut(),
            point,
            now,
        );
        self.sync_tab_container_scrollbar_presentation();
        outcome
    }

    pub fn release_tab_container_scrollbar(
        &mut self,
        view: ScrollView,
        point: Point,
        now: Instant,
    ) -> ScrollbarInteractionOutcome {
        let outcome = self.tab_container_scrollbar.release(view, point, now);
        self.sync_tab_container_scrollbar_presentation();
        outcome
    }

    pub fn tab_container_scrollbar_pointer_left(&mut self, now: Instant) -> bool {
        let changed = self.tab_container_scrollbar.pointer_left(now);
        self.sync_tab_container_scrollbar_presentation();
        changed
    }

    pub fn tab_container_scrollbar_activity(&mut self, now: Instant) {
        self.tab_container_scrollbar.activity(now);
        self.sync_tab_container_scrollbar_presentation();
    }

    pub fn advance_tab_container_scrollbar(&mut self, now: Instant) -> bool {
        let changed = self.tab_container_scrollbar.advance(now);
        self.sync_tab_container_scrollbar_presentation();
        changed
    }

    pub const fn tab_container_scrollbar_deadline(&self) -> Option<Instant> {
        self.tab_container_scrollbar.next_deadline()
    }

    pub fn cancel_tab_container_scrollbar(&mut self) {
        self.tab_container_scrollbar.cancel();
        self.sync_tab_container_scrollbar_presentation();
    }

    fn sync_tab_container_scrollbar_presentation(&mut self) {
        let presentation: ScrollbarPresentation = self.tab_container_scrollbar.presentation();
        self.layout
            .set_tab_container_scrollbar_presentation(presentation);
    }

    pub fn expand_inspector(&mut self) {
        self.layout.expand_inspector();
    }

    pub fn collapse_inspector(&mut self) {
        self.layout.collapse_inspector();
    }

    pub const fn tab_container_is_resizing(&self) -> bool {
        self.layout.tab_container_is_resizing()
    }

    pub const fn inspector_is_resizing(&self) -> bool {
        self.layout.inspector_is_resizing()
    }

    pub fn start_tab_container_resize(
        &mut self,
        viewport_width: f32,
        point: Point,
        now: Instant,
    ) -> bool {
        self.layout
            .start_tab_container_resize(viewport_width, point, now)
    }

    pub fn resize_tab_container(&mut self, point: Point) -> bool {
        self.layout.resize_tab_container(point)
    }

    pub fn finish_tab_container_resize(&mut self, presence: HoverPresence, now: Instant) -> bool {
        self.layout.finish_tab_container_resize(presence, now)
    }

    pub fn cancel_tab_container_resize(&mut self) -> bool {
        self.layout.cancel_tab_container_resize()
    }

    pub fn start_inspector_resize(
        &mut self,
        snapshot: SplitViewResizeSnapshot,
        point: Point,
        now: Instant,
    ) -> bool {
        self.layout.start_inspector_resize(snapshot, point, now)
    }

    pub fn resize_inspector(&mut self, point: Point) -> bool {
        self.layout.resize_inspector(point)
    }

    pub fn finish_inspector_resize(&mut self, presence: HoverPresence, now: Instant) -> bool {
        self.layout.finish_inspector_resize(presence, now)
    }

    pub fn cancel_inspector_resize(&mut self) -> bool {
        self.layout.cancel_inspector_resize()
    }

    pub fn tab_sash_pointer_presence(&mut self, presence: HoverPresence, now: Instant) -> bool {
        self.layout.tab_sash_pointer_presence(presence, now)
    }

    pub fn inspector_sash_pointer_presence(
        &mut self,
        presence: HoverPresence,
        now: Instant,
    ) -> bool {
        self.layout.inspector_sash_pointer_presence(presence, now)
    }

    pub fn advance_layout_sashes(&mut self, now: Instant) -> bool {
        self.layout.advance_sashes(now)
    }

    pub const fn inspector_sash_state(&self) -> SashState {
        self.layout.inspector_sash_state()
    }

    pub const fn tab_sash_deadline(&self) -> Option<Instant> {
        self.layout.tab_sash_deadline()
    }

    pub const fn inspector_sash_deadline(&self) -> Option<Instant> {
        self.layout.inspector_sash_deadline()
    }

    pub const fn pane_resize_split(&self) -> Option<PaneSplitId> {
        match &self.pane_resize {
            Some(resize) => Some(resize.split()),
            None => None,
        }
    }

    pub const fn pane_resize_orientation(&self) -> Option<SashOrientation> {
        match &self.pane_resize {
            Some(resize) => Some(resize.orientation()),
            None => None,
        }
    }

    pub fn start_pane_resize(
        &mut self,
        tab: TabInputKey,
        split: PaneSplitId,
        orientation: SashOrientation,
        snapshot: SplitViewResizeSnapshot,
        point: Point,
        now: Instant,
    ) -> bool {
        if self.pane_resize.is_some() {
            return false;
        }
        let Some(resize) = PaneResizeState::new(tab, split, orientation, snapshot, point, now)
        else {
            return false;
        };
        self.pane_resize = Some(resize);
        true
    }

    pub fn resize_pane(&mut self, point: Point) -> bool {
        let Some(resize) = self.pane_resize.as_mut() else {
            return false;
        };
        let Some(ratio) = resize.ratio_at(point) else {
            return false;
        };
        let tab = resize.tab().clone();
        let split = resize.split();
        self.workbench.resize_split(&tab, split, ratio)
    }

    pub fn finish_pane_resize(&mut self, presence: HoverPresence, now: Instant) -> bool {
        let Some(mut resize) = self.pane_resize.take() else {
            return false;
        };
        resize.finish(presence, now)
    }

    pub fn cancel_pane_resize(&mut self) -> bool {
        let Some(mut resize) = self.pane_resize.take() else {
            return false;
        };
        resize.cancel()
    }

    /// Returns the binding for one exact pane input.
    pub fn binding(&self, key: &PaneKey) -> Option<&B> {
        self.pane_host.binding(key)
    }

    /// Resolves the selected input and binding for one pane group.
    pub fn mount(&self, tab: &TabInputKey, pane: PaneGroupId) -> Option<PaneMount<'_, B>> {
        let pane_part = self.workbench.pane_part(tab)?;
        self.pane_host.mount(tab, pane_part, pane)
    }

    /// Resolves the active pane input and binding.
    pub fn active_mount(&self) -> Option<PaneMount<'_, B>> {
        let tab = self.workbench.sidebar_part().active_tab_key()?;
        let pane_part = self.workbench.pane_part(tab)?;
        self.pane_host
            .mount(tab, pane_part, pane_part.active_group())
    }

    /// Inserts or refreshes a Session tab and creates its first content binding atomically.
    pub fn upsert_session_input_with(
        &mut self,
        tab_input: TabInput,
        initial_input: PaneInput,
        create_binding: impl FnOnce() -> B,
    ) -> TabInputChange {
        let change = self
            .workbench
            .upsert_session_input(tab_input, initial_input);
        if let TabInputChange::Added(tab) = &change {
            self.bind_initial_input(tab, create_binding());
        }
        change
    }

    /// Inserts or refreshes a catalog Session without changing the selected tab.
    pub fn upsert_catalog_session_input_with(
        &mut self,
        tab_input: TabInput,
        initial_input: PaneInput,
        create_binding: impl FnOnce() -> B,
    ) -> TabInputChange {
        let change = self
            .workbench
            .upsert_catalog_session_input(tab_input, initial_input);
        if let TabInputChange::Added(tab) = &change {
            self.bind_initial_input(tab, create_binding());
        }
        change
    }

    fn bind_initial_input(&mut self, tab: &TabInputKey, binding: B) {
        let part = self
            .workbench
            .pane_part(tab)
            .expect("new tab must own a pane part");
        let pane = part.root_group();
        let input = part
            .active_input_id(pane)
            .expect("new tab must own its initial pane input");
        let previous = self
            .pane_host
            .insert(PaneKey::new(tab.clone(), pane, input), binding);
        assert!(
            previous.is_none(),
            "new pane input must not replace a binding"
        );
    }

    /// Ensures the root pane and returns its binding for capability-specific attachment.
    pub fn ensure_root_binding_with(
        &mut self,
        tab: TabInputKey,
        input: PaneInput,
        create_binding: impl FnOnce() -> B,
    ) -> Option<(PaneKey, &mut B)> {
        if self.workbench.pane_container(&tab).is_none() {
            return None;
        }
        let pane = self.workbench.ensure_root_pane(tab.clone(), input);
        let input = self.workbench.pane_part(&tab)?.active_input_id(pane)?;
        let key = PaneKey::new(tab, pane, input);
        let binding = self.pane_host.ensure_with(key.clone(), create_binding);
        Some((key, binding))
    }

    /// Opens an input once or selects its existing group-local identity.
    pub fn open_or_activate_input_with(
        &mut self,
        tab: &TabInputKey,
        pane: PaneGroupId,
        input: PaneInput,
        create_binding: impl FnOnce() -> B,
    ) -> Option<PaneActivation> {
        let part = self.workbench.pane_part(tab)?;
        let group = part.group(pane)?;
        let existing = group
            .input_ids()
            .into_iter()
            .find(|id| group.input(*id) == Some(&input));

        let input_id = match existing {
            Some(input_id) => {
                let activated = self.workbench.activate_input(tab, pane, input_id);
                assert!(activated, "resolved pane input must activate");
                input_id
            }
            None => {
                let input_id = self.workbench.open_input(tab, pane, input)?;
                let previous_binding = self
                    .pane_host
                    .insert(PaneKey::new(tab.clone(), pane, input_id), create_binding());
                assert!(
                    previous_binding.is_none(),
                    "new pane input must not replace a binding"
                );
                input_id
            }
        };
        let activated = self.workbench.activate_pane(tab, pane);
        assert!(activated, "resolved pane must activate");
        let current = PaneKey::new(tab.clone(), pane, input_id);
        Some(PaneActivation { current })
    }

    /// Adds an input to a pane group without changing the group's active input.
    pub fn ensure_input_with(
        &mut self,
        tab: &TabInputKey,
        pane: PaneGroupId,
        input: PaneInput,
        create_binding: impl FnOnce() -> B,
    ) -> Option<PaneKey> {
        let part = self.workbench.pane_part(tab)?;
        let group = part.group(pane)?;
        if let Some(input_id) = group
            .input_ids()
            .into_iter()
            .find(|id| group.input(*id) == Some(&input))
        {
            return Some(PaneKey::new(tab.clone(), pane, input_id));
        }
        let input_id = self.workbench.add_input(tab, pane, input)?;
        let key = PaneKey::new(tab.clone(), pane, input_id);
        let previous_binding = self.pane_host.insert(key.clone(), create_binding());
        assert!(
            previous_binding.is_none(),
            "new pane input must not replace a binding"
        );
        Some(key)
    }

    /// Creates a sibling pane with its first content binding as one operation.
    pub fn try_split_active_with<E>(
        &mut self,
        input: PaneInput,
        direction: PaneSplitDirection,
        create_binding: impl FnOnce() -> Result<B, E>,
    ) -> Result<Option<PaneKey>, E> {
        let Some(tab) = self.workbench.sidebar_part().active_tab_key().cloned() else {
            return Ok(None);
        };
        let binding = create_binding()?;
        let pane = self
            .workbench
            .create_pane_with_direction(input, direction)
            .expect("validated active tab must create a pane");
        let input = self
            .workbench
            .pane_part(&tab)
            .and_then(|part| part.active_input_id(pane))
            .expect("new pane must own its initial input");
        let key = PaneKey::new(tab, pane, input);
        let previous = self.pane_host.insert(key.clone(), binding);
        assert!(
            previous.is_none(),
            "new pane input must not replace a binding"
        );
        Ok(Some(key))
    }

    /// Closes the active pane group and detaches every binding owned by its inputs.
    pub fn close_active_pane(&mut self) -> Option<ClosedPane<B>> {
        self.cancel_pane_resize();
        let tab = self.workbench.sidebar_part().active_tab_key()?.clone();
        let panes = self.workbench.destroy_pane()?;
        let bindings = self.pane_host.remove_panes(&tab, &panes);
        let active_pane = self.workbench.pane_part(&tab)?.active_group();
        Some(ClosedPane {
            panes,
            bindings,
            active_pane,
        })
    }

    /// Closes a top-level tab and detaches every binding owned by it.
    pub fn close_tab(&mut self, tab: &TabInputKey) -> Option<(ClosedTab, Vec<B>)> {
        if self
            .pane_resize
            .as_ref()
            .is_some_and(|resize| resize.tab() == tab)
        {
            self.cancel_pane_resize();
        }
        let closed = self.workbench.close_tab(tab)?;
        let bindings = self.pane_host.remove_tab(tab);
        Some((closed, bindings))
    }

    /// Activates a known top-level tab.
    pub fn activate_tab(&mut self, tab: TabInputKey) -> bool {
        self.workbench.activate_tab(tab)
    }

    /// Activates the Settings tab.
    pub fn activate_settings(&mut self) -> bool {
        self.workbench.activate_settings()
    }

    /// Returns to the last selected Session tab.
    pub fn activate_last_session(&mut self) -> bool {
        self.workbench.activate_last_session()
    }

    /// Activates a pane group.
    pub fn activate_pane(&mut self, tab: &TabInputKey, pane: PaneGroupId) -> bool {
        self.workbench.activate_pane(tab, pane)
    }

    /// Selects the next pane group.
    pub fn focus_next_pane(&mut self, tab: &TabInputKey) -> Option<PaneGroupId> {
        self.workbench.focus_next_pane(tab)
    }

    /// Selects the previous pane group.
    pub fn focus_previous_pane(&mut self, tab: &TabInputKey) -> Option<PaneGroupId> {
        self.workbench.focus_previous_pane(tab)
    }

    /// Toggles one Session tab's pinned state.
    pub fn toggle_tab_pin(&mut self, key: &TabInputKey) -> Option<bool> {
        self.workbench.toggle_tab_pin(key)
    }

    /// Moves one tab into a newly created named group.
    pub fn move_tab_to_new_group(
        &mut self,
        key: &TabInputKey,
        label: impl Into<String>,
    ) -> Option<crate::TabGroupId> {
        self.workbench.move_tab_to_new_group(key, label)
    }
}
