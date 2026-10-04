use super::ConfigSelectionAction;
use crate::client::new_command_id;
use crate::keymap::bindings;
use crate::nls::Language;
use crate::nls::Text;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use ash_app_server_protocol::protocol::diagnostics::NetworkCheckDto;
use ash_app_server_protocol::protocol::diagnostics::NetworkCheckOutcomeDto;
use ash_app_server_protocol::protocol::diagnostics::NetworkDiagnosticsRunResult;
use ash_app_server_protocol::protocol::diagnostics::NetworkFailureDto;
use ash_app_server_protocol::protocol::diagnostics::NetworkPurposeDto;
use ash_app_server_protocol::protocol::diagnostics::NetworkReadResult;
use ash_app_server_protocol::protocol::diagnostics::NetworkRouteDto;
use ash_protocol::CommandId;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

const REFRESH: bindings::Keybinding = bindings::NETWORK_REFRESH;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Operation {
    Domains,
    Diagnose,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Request {
    pub id: CommandId,
    pub operation: Operation,
}

pub(crate) struct Reply {
    pub id: CommandId,
    pub result: Result<Report, String>,
}

pub(crate) struct Report {
    pub network: NetworkReadResult,
    pub checks: Vec<NetworkCheckDto>,
}

impl From<NetworkDiagnosticsRunResult> for Report {
    fn from(result: NetworkDiagnosticsRunResult) -> Self {
        Self {
            network: result.network,
            checks: result.checks,
        }
    }
}

#[derive(Debug)]
pub(crate) struct Panel {
    pub selection: ListSelection<ConfigSelectionAction>,
    pending: Option<CommandId>,
    operation: Operation,
    language: Language,
}

impl Panel {
    pub fn new(operation: Operation, language: Language) -> (Self, Request) {
        let mut panel = Self {
            selection: ListSelection::new(model(Vec::new(), language, false), BTreeMap::new()),
            pending: None,
            operation,
            language,
        };
        let request = panel.begin(operation);
        (panel, request)
    }

    pub fn begin(&mut self, operation: Operation) -> Request {
        let id = new_command_id("network-diagnostics");
        self.operation = operation;
        self.pending = Some(id.clone());
        let model = model(
            vec![ListSelectionItem::new("Checking configured services…")],
            self.language,
            false,
        );
        self.selection.replace(model, BTreeMap::new());
        Request { id, operation }
    }

    pub fn complete(&mut self, reply: Reply, language: Language) {
        if self.pending.as_ref() != Some(&reply.id) {
            return;
        }
        self.pending = None;
        self.language = language;
        let mut actions = BTreeMap::new();
        let mut items = Vec::new();
        let refresh = ListSelectionItemId::new("network-refresh");
        actions.insert(
            refresh.clone(),
            ConfigSelectionAction::Network(self.operation),
        );
        items.push(
            ListSelectionItem::new(match self.operation {
                Operation::Domains => "Refresh required domains",
                Operation::Diagnose => "Run diagnostics again",
            })
            .with_id(refresh),
        );
        match reply.result {
            Err(_) => items.push(ListSelectionItem::new(
                "Could not run network diagnostics. Retry from this page.",
            )),
            Ok(report) => {
                let domains = required_domains(&report.network);
                if !domains.is_empty() {
                    let copy = ListSelectionItemId::new("network-copy-domains");
                    actions.insert(
                        copy.clone(),
                        ConfigSelectionAction::CopyRequiredDomains(domains.join("\n")),
                    );
                    items.push(ListSelectionItem::new("Copy required domains").with_id(copy));
                }
                if report.network.targets.is_empty() {
                    items.push(ListSelectionItem::new("No configured network services."));
                }
                let connections: BTreeSet<_> = report
                    .network
                    .targets
                    .iter()
                    .map(|target| target.connection.as_str())
                    .collect();
                for connection in connections {
                    let name = &report
                        .network
                        .targets
                        .iter()
                        .find(|target| target.connection == connection)
                        .expect("connection comes from the target list")
                        .display_name;
                    items.push(ListSelectionItem::new(Text::literal(name)).as_section_divider());
                    for target in report
                        .network
                        .targets
                        .iter()
                        .filter(|target| target.connection == connection)
                    {
                        let purpose = match target.purpose {
                            NetworkPurposeDto::Model => "Model service",
                            NetworkPurposeDto::SignIn => "Sign-in service",
                            NetworkPurposeDto::Usage => "Usage service",
                            NetworkPurposeDto::Service => "Product service",
                        };
                        let route = match &target.route {
                            NetworkRouteDto::Direct => Text::from("Direct connection"),
                            NetworkRouteDto::Blocked => Text::from("Blocked by network policy"),
                            NetworkRouteDto::Proxy { host, port } => Text::template(
                                "Proxy: {0}",
                                vec![Text::literal(authority(host, *port))],
                            ),
                        };
                        items.push(ListSelectionItem::new(Text::template(
                            "{0}: {1}",
                            vec![
                                Text::from(purpose),
                                Text::literal(authority(&target.host, target.port)),
                            ],
                        )));
                        items.push(ListSelectionItem::new(route));
                        if let Some(check) = report
                            .checks
                            .iter()
                            .find(|check| check.target_id.as_deref() == Some(&target.id))
                        {
                            items.push(ListSelectionItem::new(outcome(&check.outcome)));
                        }
                    }
                    for check in report
                        .checks
                        .iter()
                        .filter(|check| check.connection == connection && check.target_id.is_none())
                    {
                        items.push(ListSelectionItem::new(Text::template(
                            "Account usage: {0}",
                            vec![outcome(&check.outcome)],
                        )));
                    }
                }
                if self.operation == Operation::Diagnose {
                    items.push(ListSelectionItem::new(
                        "Checks HTTP reachability and account usage.",
                    ));
                    items.push(ListSelectionItem::new(
                        "Model generation and streaming are not tested.",
                    ));
                }
            }
        }
        self.selection
            .replace(model(items, self.language, true), actions);
    }

    pub fn handle_key(&mut self, key: crate::keymap::KeyEvent) -> super::ConfigEditorOutcome {
        if REFRESH.matches(key) && self.selection.state().items_focused() && self.pending.is_none()
        {
            return super::ConfigEditorOutcome::Network(self.begin(self.operation));
        }
        match self.selection.handle_key(key) {
            ListSelectionOutcome::Activate(ConfigSelectionAction::Network(operation)) => {
                super::ConfigEditorOutcome::Network(self.begin(operation))
            }
            ListSelectionOutcome::Activate(action) => super::ConfigEditorOutcome::Action(action),
            ListSelectionOutcome::Dismiss => super::ConfigEditorOutcome::Dismiss,
            _ => super::ConfigEditorOutcome::Consumed,
        }
    }
}

fn model(items: Vec<ListSelectionItem>, language: Language, ready: bool) -> ListSelectionModel {
    let mut model = ListSelectionModel::new("Network", vec![ListSelectionGroup::new("", items)])
        .without_tab_bar()
        .with_dismiss(bindings::RETURN_LIST);
    if ready {
        model = model
            .with_activation(bindings::ACCEPT)
            .with_key_hint_action(REFRESH);
    }
    model.localize(language);
    model
}

fn authority(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn required_domains(network: &NetworkReadResult) -> Vec<String> {
    network
        .targets
        .iter()
        .map(|target| target.host.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn outcome(outcome: &NetworkCheckOutcomeDto) -> Text {
    match outcome {
        NetworkCheckOutcomeDto::Reachable { http_status } => Text::template(
            "HTTP reachable · status {0}",
            vec![Text::literal(http_status.to_string())],
        ),
        NetworkCheckOutcomeDto::AccountAvailable => Text::from("Account usage available"),
        NetworkCheckOutcomeDto::Failed { failure } => Text::from(match failure {
            NetworkFailureDto::Dns => "DNS lookup failed",
            NetworkFailureDto::Proxy => "Proxy connection or tunnel failed",
            NetworkFailureDto::Tls => "TLS certificate or handshake failed",
            NetworkFailureDto::CertificateConfiguration => {
                "System certificate verifier could not be created"
            }
            NetworkFailureDto::Connect => "Connection failed",
            NetworkFailureDto::Timeout => "Connection timed out",
            NetworkFailureDto::Policy => "Blocked by network policy",
            NetworkFailureDto::Configuration => "Invalid connection configuration",
            NetworkFailureDto::Request => "HTTP request or response failed",
            NetworkFailureDto::Authentication => "Account needs to be reconnected",
            NetworkFailureDto::AccountChanged => "Account changed; run diagnostics again",
            NetworkFailureDto::AccountOperation => "Account usage query failed",
        }),
    }
}

#[cfg(test)]
#[path = "network_tests.rs"]
mod tests;
