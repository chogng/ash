mod request;
pub(crate) use request::execute;

use crate::keymap::bindings;
use crate::nls::Language;
use crate::nls::Text;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionState;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_protocol::protocol::marketplace::MarketplaceCapabilityKindDto as Kind;
use ash_app_server_protocol::protocol::marketplace::MarketplaceInstallationStateDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceInstalledPackageDto;
use ash_app_server_protocol::protocol::marketplace::MarketplacePackageDetailsDto;
use ash_app_server_protocol::protocol::marketplace::MarketplacePackageSummaryDto;
use ash_app_server_protocol::protocol::marketplace::MarketplaceSearchParams;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    Browse(MarketplaceSearchParams),
    Installed,
    Review {
        package_id: String,
        version: Option<String>,
        installation_id: Option<String>,
    },
    Install {
        package_id: String,
        version: String,
    },
    Update {
        installation_id: String,
        version: String,
    },
    Uninstall {
        installation_id: String,
    },
}

impl Command {
    pub(crate) fn browse(kind: Option<Kind>) -> Self {
        Self::Browse(MarketplaceSearchParams {
            capability_kind: Some(kind.unwrap_or(Kind::Skill)),
            ..Default::default()
        })
    }
}

pub(crate) struct Event(pub(crate) Page);

#[derive(Debug)]
pub(crate) enum Page {
    Catalog {
        params: MarketplaceSearchParams,
        packages: Vec<MarketplacePackageSummaryDto>,
        installed: Vec<MarketplaceInstalledPackageDto>,
        error: Option<String>,
    },
    Installed {
        packages: Vec<MarketplaceInstalledPackageDto>,
        selected: Option<String>,
    },
    Review {
        details: MarketplacePackageDetailsDto,
        installation_id: Option<String>,
    },
}

#[derive(Clone, Copy)]
enum Removal {
    Review,
    Confirm,
}

#[derive(Clone, Debug)]
enum Action {
    Request(Command),
    InstalledPackage(MarketplaceInstalledPackageDto),
    ConfirmRemoval(MarketplaceInstalledPackageDto),
}

#[derive(Debug, PartialEq)]
enum View {
    Catalog,
    Installed,
    Other,
}

/// Owns Marketplace navigation; all package mutations belong to the App Server.
#[derive(Debug)]
pub(crate) struct Panel {
    list: ListSelection<Action>,
    view: View,
    pending: bool,
    input_hints: crate::widgets::key_hint::KeyHints,
    search: Option<MarketplaceSearchParams>,
    back: Option<Command>,
    language: Language,
    browse_hints: crate::widgets::key_hint::KeyHints,
    installed_hints: crate::widgets::key_hint::KeyHints,
    pending_hints: crate::widgets::key_hint::KeyHints,
}

impl Panel {
    pub(crate) fn new(page: Page) -> Self {
        let view = match &page {
            Page::Catalog { .. } => View::Catalog,
            Page::Installed { .. } => View::Installed,
            Page::Review { .. } => View::Other,
        };
        let mut actions = BTreeMap::new();
        let mut items = Vec::new();
        let mut search = None;
        let mut back = None;
        let mut selected = None;
        let mut error = None;
        let title;
        match page {
            Page::Catalog {
                params,
                packages,
                installed,
                error: failure,
            } => {
                title = Text::from("Marketplace");
                catalog_items(&mut items, &mut actions, &params, &packages, &installed);
                search = Some(params);
                error = failure;
            }
            Page::Installed {
                packages,
                selected: focus,
            } => {
                title = "Marketplace".into();
                let params = MarketplaceSearchParams {
                    package_type: Some("plugin".into()),
                    ..Default::default()
                };
                catalog_items(&mut items, &mut actions, &params, &[], &packages);
                search = Some(params);
                selected = focus;
            }
            Page::Review {
                details,
                installation_id,
            } => {
                title = Text::template(
                    "Review package · {0}",
                    vec![Text::literal(&details.display_name)],
                );
                let returning = if installation_id.is_some() {
                    Command::Installed
                } else {
                    Command::browse(None)
                };
                push(
                    &mut items,
                    &mut actions,
                    "cancel",
                    "Cancel",
                    "Return without changing installations",
                    Action::Request(returning.clone()),
                );
                back = Some(returning);
                items.push(ListSelectionItem::new(Text::literal(&details.package.id)));
                items.push(ListSelectionItem::new(Text::template(
                    "Version {0} · License {1}",
                    vec![
                        Text::literal(&details.package.version),
                        Text::literal(&details.license),
                    ],
                )));
                items.push(ListSelectionItem::new(match details.source { ash_app_server_protocol::protocol::marketplace::MarketplacePackageSourceDto::Official => "Source: official", ash_app_server_protocol::protocol::marketplace::MarketplacePackageSourceDto::ThirdParty => "Source: third party" }));
                items.push(ListSelectionItem::new(Text::literal(&details.description)));
                for capability in &details.capabilities {
                    items.push(ListSelectionItem::new(Text::template(
                        "{0} · {1}",
                        vec![
                            kind_label(capability.kind).into(),
                            Text::literal(&capability.id),
                        ],
                    )));
                    if capability.permissions.is_empty() {
                        items.push(ListSelectionItem::new("  Permissions: none declared"));
                    }
                    for permission in &capability.permissions {
                        items.push(ListSelectionItem::new(Text::template(
                            "  Permission: {0}",
                            vec![Text::literal(permission)],
                        )));
                    }
                    if let Some(provider) = &capability.authentication_provider {
                        items.push(ListSelectionItem::new(Text::template(
                            "  Authentication: {0}",
                            vec![Text::literal(provider)],
                        )));
                    }
                }
                let command = match installation_id {
                    Some(installation_id) => Command::Update {
                        installation_id,
                        version: details.package.version,
                    },
                    None => Command::Install {
                        package_id: details.package.id,
                        version: details.package.version,
                    },
                };
                push(
                    &mut items,
                    &mut actions,
                    "confirm",
                    "Confirm whole-package installation",
                    "All listed capabilities are installed together",
                    Action::Request(command),
                );
            }
        }
        let active_tab = if view == View::Installed {
            Tab::Plugins
        } else {
            search.as_ref().map(Tab::from_params).unwrap_or(Tab::Skills)
        };
        let groups = if view == View::Other {
            vec![ListSelectionGroup::new("", items)]
        } else {
            Tab::ALL
                .into_iter()
                .map(|tab| {
                    ListSelectionGroup::new(
                        tab.label(),
                        if tab == active_tab {
                            std::mem::take(&mut items)
                        } else {
                            Vec::new()
                        },
                    )
                })
                .collect()
        };
        let mut model = ListSelectionModel::new(title, groups)
            .with_empty_message("No packages in this view")
            .with_activation(bindings::ACCEPT);
        if view == View::Other {
            model = model.without_tab_bar();
        } else {
            model = model.with_expandable_descriptions();
        }
        if search.is_some() {
            model = model.with_input(SearchBoxModel::new("Search Marketplace; Enter to search"));
        }
        let mut list = ListSelection::new(model, actions);
        if view != View::Other {
            list.state_mut().focus_pointer(
                &crate::widgets::list_selection::ListSelectionPointerTarget::Tab(
                    active_tab.index(),
                ),
            );
        }
        if let Some(params) = &search {
            list.state_mut().focus_search();
            list.handle_paste(params.query.clone());
            if let Some(id) = list
                .state()
                .visible_items()
                .iter()
                .find_map(|item| item.id().cloned())
            {
                list.state_mut().focus_item(&id);
            }
        }
        if let Some(selected) = selected {
            list.state_mut()
                .focus_item(&ListSelectionItemId::new(selected));
        }
        list.state_mut().set_message(error);
        Self {
            list,
            view,
            search,
            back,
            pending: false,
            language: Language::English,
            browse_hints: crate::widgets::key_hint::KeyHints::compact()
                .with_compact_action("/", "search")
                .with_compact_action("←/→", "details")
                .with_compact_action("i", "install")
                .with_compact_action("r", "refresh"),
            installed_hints: crate::widgets::key_hint::KeyHints::compact()
                .with_compact_action("/", "search")
                .with_compact_action("←/→", "details")
                .with_compact_action("u", "uninstall")
                .with_compact_action("r", "refresh"),
            pending_hints: crate::widgets::key_hint::KeyHints::compact()
                .with_compact_action("/", "search")
                .with_compact_action("←/→", "details")
                .with_compact_action("r", "refresh"),
            input_hints: crate::widgets::key_hint::KeyHints::compact()
                .with_compact_action("Enter", "search")
                .with_compact_action("Esc", "return"),
        }
    }

    pub(crate) fn localize(&mut self, language: Language) {
        self.language = language;
        self.list.state_mut().localize(language);
    }

    pub(crate) fn begin_request(&mut self) {
        self.pending = true;
        self.list
            .state_mut()
            .set_message(Some(crate::nls::localize_owned(self.language, "Loading…")));
    }
    pub(crate) fn fail(&mut self, error: String) {
        self.pending = false;
        let loaded_tab = match self.view {
            View::Catalog => self.search.as_ref().map(Tab::from_params),
            View::Installed => Some(Tab::Plugins),
            View::Other => None,
        };
        if let Some(tab) = loaded_tab
            && tab.index() != self.state().active_tab_index()
        {
            self.list.state_mut().focus_pointer(
                &crate::widgets::list_selection::ListSelectionPointerTarget::Tab(tab.index()),
            );
        }
        self.list
            .state_mut()
            .set_message(Some(crate::nls::localize_owned(self.language, error)));
    }
    pub(crate) fn state(&self) -> &ListSelectionState {
        self.list.state()
    }
    pub(crate) fn state_mut(&mut self) -> &mut ListSelectionState {
        self.list.state_mut()
    }
    pub(crate) fn key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        if self.pending {
            &bindings::CLOSE_HINTS
        } else if self
            .state()
            .search()
            .is_some_and(|input| input.input_active())
        {
            &self.input_hints
        } else if self.view != View::Other {
            if self.state().tabs_focused() {
                self.list.key_hints()
            } else {
                match self
                    .state()
                    .selected_item()
                    .and_then(ListSelectionItem::id)
                    .and_then(|id| self.list.action(id))
                {
                    Some(Action::InstalledPackage(package))
                        if package.state == MarketplaceInstallationStateDto::PendingRemoval =>
                    {
                        &self.pending_hints
                    }
                    Some(Action::InstalledPackage(_)) => &self.installed_hints,
                    _ => &self.browse_hints,
                }
            }
        } else {
            self.list.key_hints()
        }
    }
    pub(crate) fn handle_paste(&mut self, text: String) {
        if !self.pending {
            self.list.handle_paste(text);
        }
    }
    pub(crate) fn installed(&self) -> bool {
        self.view == View::Installed
    }

    pub(crate) fn refresh(&self) -> Option<Command> {
        if self.pending
            || self.back.is_some()
            || self
                .state()
                .search()
                .is_some_and(|input| input.input_active())
        {
            return None;
        }
        if self.installed() {
            Some(Command::Installed)
        } else {
            self.search.clone().map(Command::Browse)
        }
    }

    pub(crate) fn handle_key(&mut self, key: KeyEvent) -> ListSelectionOutcome<Command> {
        if self.pending {
            return if key.kind == KeyEventKind::Press && bindings::CANCEL.matches(key) {
                ListSelectionOutcome::Dismiss
            } else {
                ListSelectionOutcome::Consumed
            };
        }
        if key.kind == KeyEventKind::Press
            && key.modifiers.is_empty()
            && self.view != View::Other
            && !self
                .state()
                .search()
                .is_some_and(|search| search.input_active())
        {
            match key.code {
                crossterm::event::KeyCode::Char('r') => {
                    return self.refresh().map_or(
                        ListSelectionOutcome::Consumed,
                        ListSelectionOutcome::Activate,
                    );
                }
                crossterm::event::KeyCode::Char('i') if self.state().items_focused() => {
                    if let Some(Action::Request(command @ Command::Review { .. })) = self
                        .state()
                        .selected_item()
                        .and_then(ListSelectionItem::id)
                        .and_then(|id| self.list.action(id))
                    {
                        return ListSelectionOutcome::Activate(command.clone());
                    }
                }
                crossterm::event::KeyCode::Char('u') if self.state().items_focused() => {
                    if let Some(Action::InstalledPackage(package)) = self
                        .state()
                        .selected_item()
                        .and_then(ListSelectionItem::id)
                        .and_then(|id| self.list.action(id))
                        .cloned()
                    {
                        if package.state == MarketplaceInstallationStateDto::Installed {
                            self.installed_package(package, Removal::Confirm);
                        }
                        return ListSelectionOutcome::Consumed;
                    }
                }
                _ => {}
            }
        }
        if key.kind == KeyEventKind::Press
            && bindings::ACCEPT.matches(key)
            && self
                .state()
                .search()
                .is_some_and(|search| search.input_active())
            && let Some(mut params) = self.search.clone()
        {
            params.query = self.state().query().trim().into();
            return ListSelectionOutcome::Activate(Command::Browse(params));
        }
        let tab = self.state().active_tab_index();
        let outcome = self.list.handle_key(key);
        if self.view != View::Other && tab != self.state().active_tab_index() {
            return ListSelectionOutcome::Activate(self.tab_command());
        }
        match outcome {
            ListSelectionOutcome::Activate(Action::Request(command)) => {
                ListSelectionOutcome::Activate(command)
            }
            ListSelectionOutcome::Activate(Action::InstalledPackage(package)) => {
                self.installed_package(package, Removal::Review);
                ListSelectionOutcome::Consumed
            }
            ListSelectionOutcome::Activate(Action::ConfirmRemoval(package)) => {
                self.installed_package(package, Removal::Confirm);
                ListSelectionOutcome::Consumed
            }
            ListSelectionOutcome::Dismiss => self
                .back
                .clone()
                .map(ListSelectionOutcome::Activate)
                .unwrap_or(ListSelectionOutcome::Dismiss),
            _ => ListSelectionOutcome::Consumed,
        }
    }

    pub(crate) fn select_tab(&mut self, index: usize) -> Option<Command> {
        if self.pending || self.view == View::Other {
            return None;
        }
        let previous = self.state().active_tab_index();
        self.list
            .state_mut()
            .focus_pointer(&crate::widgets::list_selection::ListSelectionPointerTarget::Tab(index));
        (previous != self.state().active_tab_index()).then(|| self.tab_command())
    }

    fn tab_command(&self) -> Command {
        let tab = Tab::ALL[self.state().active_tab_index()];
        let mut params = self.search.clone().unwrap_or_default();
        params.query = self.state().query().trim().into();
        params.package_type = (tab == Tab::Plugins).then(|| "plugin".into());
        params.capability_kind = tab.kind();
        if tab != Tab::Executables {
            params.language_id = None;
        }
        Command::Browse(params)
    }

    fn installed_package(&mut self, package: MarketplaceInstalledPackageDto, removal: Removal) {
        let mut actions = BTreeMap::new();
        let mut items = Vec::new();
        push(
            &mut items,
            &mut actions,
            "back",
            "Back to installed packages",
            "",
            Action::Request(Command::Installed),
        );
        items.push(
            ListSelectionItem::new(Text::literal(&package.package.id)).with_description(
                Text::literal(format!(
                    "{} · {}",
                    package.package.version, package.installation_id
                )),
            ),
        );
        for capability in &package.capabilities {
            items.push(
                ListSelectionItem::new(Text::template(
                    "{0} · {1}",
                    vec![
                        kind_label(capability.kind).into(),
                        Text::literal(&capability.id),
                    ],
                ))
                .with_description(Text::template(
                    "Permissions: {0}",
                    vec![if capability.permissions.is_empty() {
                        "none declared".into()
                    } else {
                        Text::literal(capability.permissions.join(", "))
                    }],
                )),
            );
        }
        if package.state == MarketplaceInstallationStateDto::Installed {
            if matches!(removal, Removal::Confirm) {
                push(
                    &mut items,
                    &mut actions,
                    "remove",
                    "Confirm whole-package removal",
                    "Removal waits until all consumers release this version",
                    Action::Request(Command::Uninstall {
                        installation_id: package.installation_id.clone(),
                    }),
                );
            } else {
                push(
                    &mut items,
                    &mut actions,
                    "update",
                    "Review latest version",
                    "Review capabilities and permissions before updating",
                    Action::Request(Command::Review {
                        package_id: package.package.id.clone(),
                        version: None,
                        installation_id: Some(package.installation_id.clone()),
                    }),
                );
                push(
                    &mut items,
                    &mut actions,
                    "remove",
                    "Uninstall this version…",
                    "Removes all capabilities in this installed package",
                    Action::ConfirmRemoval(package),
                );
            }
        } else {
            items.push(ListSelectionItem::new(
                "Pending removal · waiting for consumers to release",
            ));
        }
        self.list = ListSelection::new(
            ListSelectionModel::new(
                if matches!(removal, Removal::Confirm) {
                    "Confirm removal"
                } else {
                    "Installed package"
                },
                vec![ListSelectionGroup::new("", items)],
            )
            .without_tab_bar()
            .with_activation(bindings::ACCEPT),
            actions,
        );
        self.view = View::Other;
        self.search = None;
        self.back = Some(Command::Installed);
        self.localize(self.language);
    }
}

fn push(
    items: &mut Vec<ListSelectionItem>,
    actions: &mut BTreeMap<ListSelectionItemId, Action>,
    id: &str,
    label: impl Into<Text>,
    description: impl Into<Text>,
    action: Action,
) {
    let description = description.into();
    let id = ListSelectionItemId::new(id);
    let item = ListSelectionItem::new(label).with_id(id.clone());
    items.push(if description.is_empty() {
        item
    } else {
        item.with_description(description)
    });
    actions.insert(id, action);
}

fn catalog_items(
    items: &mut Vec<ListSelectionItem>,
    actions: &mut BTreeMap<ListSelectionItemId, Action>,
    params: &MarketplaceSearchParams,
    packages: &[MarketplacePackageSummaryDto],
    installed: &[MarketplaceInstalledPackageDto],
) {
    let matching_installed = installed.iter().filter(|package| {
        (params.package_type.as_deref() == Some("plugin")
            || params.capability_kind.is_none()
            || package
                .capabilities
                .iter()
                .any(|capability| Some(capability.kind) == params.capability_kind))
            && (params.query.is_empty()
                || packages.iter().any(|summary| {
                    summary.id == package.package.id
                        && (summary
                            .display_name
                            .to_lowercase()
                            .contains(&params.query.to_lowercase())
                            || summary
                                .description
                                .to_lowercase()
                                .contains(&params.query.to_lowercase()))
                })
                || package
                    .package
                    .id
                    .to_lowercase()
                    .contains(&params.query.to_lowercase()))
    });
    let mut installed_count = 0;
    for package in matching_installed {
        if installed_count == 0 {
            items.push(ListSelectionItem::new("Installed").as_section_heading());
        }
        installed_count += 1;
        let summary = packages.iter().find(|summary| {
            summary.id == package.package.id && summary.version == package.package.version
        });
        let name = summary.map_or_else(
            || {
                package
                    .package
                    .id
                    .split('@')
                    .next()
                    .unwrap_or(&package.package.id)
            },
            |summary| summary.display_name.as_str(),
        );
        let description = summary.map_or("—", |summary| summary.description.as_str());
        push(
            items,
            actions,
            &package.installation_id,
            Text::literal(name),
            package_details(&package.package.id, description, &package.package.version),
            Action::InstalledPackage(package.clone()),
        );
    }
    let mut available_count = 0;
    for package in packages {
        if installed.iter().any(|installed| {
            installed.package.id == package.id && installed.package.version == package.version
        }) {
            continue;
        }
        if available_count == 0 {
            items.push(ListSelectionItem::new("Not installed").as_section_heading());
        }
        available_count += 1;
        push(
            items,
            actions,
            &package.id,
            Text::literal(&package.display_name),
            package_details(&package.id, &package.description, &package.version),
            Action::Request(Command::Review {
                package_id: package.id.clone(),
                version: Some(package.version.clone()),
                installation_id: None,
            }),
        );
    }
}

fn package_details(id: &str, description: &str, version: &str) -> Text {
    Text::template(
        "Source: {0}\nDescription: {1}\nVersion: {2}",
        vec![
            Text::literal(id.rsplit_once('@').map_or("—", |(_, source)| source)),
            Text::literal(description),
            Text::literal(version),
        ],
    )
}

fn kind_label(kind: Kind) -> &'static str {
    match kind {
        Kind::Skill => "Skills",
        Kind::Mcp => "MCP",
        Kind::Connector => "Connectors",
        Kind::Theme => "Themes",
        Kind::Language => "Languages",
        Kind::Localization => "Localizations",
        Kind::Executable => "Executables",
        Kind::Asset => "Assets",
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Tab {
    Skills,
    Plugins,
    Mcp,
    Connectors,
    Executables,
    Languages,
    Themes,
    Localizations,
    Assets,
}

impl Tab {
    const ALL: [Self; 9] = [
        Self::Skills,
        Self::Plugins,
        Self::Mcp,
        Self::Connectors,
        Self::Executables,
        Self::Languages,
        Self::Themes,
        Self::Localizations,
        Self::Assets,
    ];
    fn index(self) -> usize {
        Self::ALL.iter().position(|tab| *tab == self).unwrap()
    }
    fn kind(self) -> Option<Kind> {
        match self {
            Self::Plugins => None,
            Self::Skills => Some(Kind::Skill),
            Self::Mcp => Some(Kind::Mcp),
            Self::Connectors => Some(Kind::Connector),
            Self::Executables => Some(Kind::Executable),
            Self::Languages => Some(Kind::Language),
            Self::Themes => Some(Kind::Theme),
            Self::Localizations => Some(Kind::Localization),
            Self::Assets => Some(Kind::Asset),
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Plugins => "Plugins",
            _ => kind_label(self.kind().unwrap()),
        }
    }
    fn from_params(params: &MarketplaceSearchParams) -> Self {
        if params.package_type.as_deref() == Some("plugin") {
            return Self::Plugins;
        }
        params
            .capability_kind
            .and_then(|kind| Self::ALL.into_iter().find(|tab| tab.kind() == Some(kind)))
            .unwrap_or(Self::Skills)
    }
}
