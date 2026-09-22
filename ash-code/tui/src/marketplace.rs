mod request;
pub(crate) use request::execute;

use crate::keymap::bindings;
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
            capability_kind: kind,
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
    Filters,
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
                error: failure,
            } => {
                title = "Marketplace".to_owned();
                push(
                    &mut items,
                    &mut actions,
                    "installed",
                    "Installed packages / Plugins",
                    "Manage exact installed versions",
                    Action::Request(Command::Installed),
                );
                push(
                    &mut items,
                    &mut actions,
                    "filters",
                    "Filter capabilities",
                    &format!(
                        "{}{}",
                        params
                            .capability_kind
                            .map(kind_label)
                            .unwrap_or("All capabilities"),
                        params
                            .language_id
                            .as_ref()
                            .map(|id| format!(" · language: {id}"))
                            .unwrap_or_default()
                    ),
                    Action::Filters,
                );
                for package in packages {
                    push(
                        &mut items,
                        &mut actions,
                        &package.id,
                        &package.display_name,
                        &format!(
                            "{} · {} · {}",
                            package.id, package.version, package.description
                        ),
                        Action::Request(Command::Review {
                            package_id: package.id.clone(),
                            version: Some(package.version),
                            installation_id: None,
                        }),
                    );
                }
                search = Some(params);
                error = failure;
            }
            Page::Installed {
                packages,
                selected: focus,
            } => {
                title = "Plugins · Installed packages".to_owned();
                push(
                    &mut items,
                    &mut actions,
                    "browse",
                    "Browse Marketplace",
                    "Find skills, plugins, MCP, connectors and language servers",
                    Action::Request(Command::browse(None)),
                );
                push(
                    &mut items,
                    &mut actions,
                    "refresh",
                    "Refresh installed packages",
                    "Reads local installations; no catalog connection required",
                    Action::Request(Command::Installed),
                );
                for package in packages {
                    let state = if package.state == MarketplaceInstallationStateDto::PendingRemoval
                    {
                        "waiting for consumers to release"
                    } else {
                        "installed"
                    };
                    push(
                        &mut items,
                        &mut actions,
                        &package.installation_id,
                        &format!("{} · {}", package.package.id, package.package.version),
                        &format!("{state} · {}", package.installation_id),
                        Action::InstalledPackage(package.clone()),
                    );
                }
                selected = focus;
            }
            Page::Review {
                details,
                installation_id,
            } => {
                title = format!("Review package · {}", details.display_name);
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
                items.push(ListSelectionItem::new(&details.package.id));
                items.push(ListSelectionItem::new(format!(
                    "Version {} · License {}",
                    details.package.version, details.license
                )));
                items.push(ListSelectionItem::new(match details.source { ash_app_server_protocol::protocol::marketplace::MarketplacePackageSourceDto::Official => "Source: official", ash_app_server_protocol::protocol::marketplace::MarketplacePackageSourceDto::ThirdParty => "Source: third party" }));
                items.push(ListSelectionItem::new(&details.description));
                for capability in &details.capabilities {
                    items.push(ListSelectionItem::new(format!(
                        "{} · {}",
                        kind_label(capability.kind),
                        capability.id
                    )));
                    if capability.permissions.is_empty() {
                        items.push(ListSelectionItem::new("  Permissions: none declared"));
                    }
                    for permission in &capability.permissions {
                        items.push(ListSelectionItem::new(format!(
                            "  Permission: {permission}"
                        )));
                    }
                    if let Some(provider) = &capability.authentication_provider {
                        items.push(ListSelectionItem::new(format!(
                            "  Authentication: {provider}"
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
        let mut model = ListSelectionModel::new(title, vec![ListSelectionGroup::new("", items)])
            .without_tab_bar()
            .with_activation(bindings::ACCEPT);
        if search.is_some() {
            model = model.with_input(SearchBoxModel::new("Search Marketplace; Enter to search"));
        }
        let mut list = ListSelection::new(model, actions);
        if let Some(params) = &search {
            list.state_mut().focus_search();
            list.handle_paste(params.query.clone());
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
            input_hints: crate::widgets::key_hint::KeyHints::compact()
                .with_compact_action("Enter", "search")
                .with_compact_action("Esc", "return"),
        }
    }

    pub(crate) fn begin_request(&mut self) {
        self.pending = true;
        self.list.state_mut().set_message(Some("Loading…".into()));
    }
    pub(crate) fn fail(&mut self, error: String) {
        self.pending = false;
        self.list.state_mut().set_message(Some(error));
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
        self.search
            .clone()
            .map(Command::Browse)
            .or_else(|| self.installed().then_some(Command::Installed))
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
        match self.list.handle_key(key) {
            ListSelectionOutcome::Activate(Action::Request(command)) => {
                ListSelectionOutcome::Activate(command)
            }
            ListSelectionOutcome::Activate(Action::Filters) => {
                self.filters();
                ListSelectionOutcome::Consumed
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

    fn filters(&mut self) {
        let mut actions = BTreeMap::new();
        let mut items = Vec::new();
        for kind in [
            None,
            Some(Kind::Skill),
            Some(Kind::Mcp),
            Some(Kind::Connector),
            Some(Kind::Executable),
            Some(Kind::Language),
            Some(Kind::Theme),
            Some(Kind::Localization),
            Some(Kind::Asset),
        ] {
            let label = kind.map(kind_label).unwrap_or("All capabilities");
            push(
                &mut items,
                &mut actions,
                label,
                label,
                "Search all package types, including bundled capabilities",
                Action::Request(Command::browse(kind)),
            );
        }
        push(
            &mut items,
            &mut actions,
            "plugins",
            "Plugin packages",
            "Filter by package type",
            Action::Request(Command::Browse(MarketplaceSearchParams {
                package_type: Some("plugin".into()),
                ..Default::default()
            })),
        );
        self.list = ListSelection::new(
            ListSelectionModel::new(
                "Marketplace · Capabilities",
                vec![ListSelectionGroup::new("", items)],
            )
            .without_tab_bar()
            .with_activation(bindings::ACCEPT),
            actions,
        );
        self.view = View::Other;
        self.search = None;
        self.back = Some(Command::browse(None));
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
            ListSelectionItem::new(&package.package.id).with_description(format!(
                "{} · {}",
                package.package.version, package.installation_id
            )),
        );
        for capability in &package.capabilities {
            items.push(
                ListSelectionItem::new(format!(
                    "{} · {}",
                    kind_label(capability.kind),
                    capability.id
                ))
                .with_description(format!(
                    "Permissions: {}",
                    if capability.permissions.is_empty() {
                        "none declared".into()
                    } else {
                        capability.permissions.join(", ")
                    }
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
    }
}

fn push(
    items: &mut Vec<ListSelectionItem>,
    actions: &mut BTreeMap<ListSelectionItemId, Action>,
    id: &str,
    label: &str,
    description: &str,
    action: Action,
) {
    let id = ListSelectionItemId::new(id);
    let item = ListSelectionItem::new(label).with_id(id.clone());
    items.push(if description.is_empty() {
        item
    } else {
        item.with_description(description)
    });
    actions.insert(id, action);
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
