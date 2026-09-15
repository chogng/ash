use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use url::Url;
use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewPhase;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::ApprovalRequest;
use ash_action_policy::Capability;
use ash_action_policy::CapabilityKind;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use core_api::ActionPolicyService;
use core_api::BrowserAction;
use core_api::BrowserCapability;
use core_api::BrowserObserveRequest;
use core_api::BrowserTargetId;
use core_api::CoreError;
use core_api::CreateBrowserTargetRequest;
use core_api::BrowserElementTarget;
use core_api::BrowserTextInputTarget;
use ash_core::ToolAuthorization;
use ash_core::ToolService;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;

const BROWSER_POLICY_REVISION: &str = "browser-host-user-approval-v1";
const MAX_URL_LENGTH: usize = 8192;

const OPEN_SCHEMA: &str = r#"{"type":"object","properties":{"url":{"type":"string","description":"HTTPS, loopback HTTP, or about:blank URL to open."}},"required":["url"],"additionalProperties":false}"#;
const OBSERVE_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"include_dom_snapshot":{"type":"boolean"},"include_screenshot":{"type":"boolean"}},"required":["target_id","include_dom_snapshot","include_screenshot"],"additionalProperties":false}"#;
const NAVIGATE_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"url":{"type":"string"}},"required":["target_id","url"],"additionalProperties":false}"#;
const ELEMENT_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"node_id":{"type":"string","description":"backendDOMNodeId returned by browser_observe."}},"required":["target_id","node_id"],"additionalProperties":false}"#;
const TYPE_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"node_id":{"type":["string","null"],"description":"backendDOMNodeId to focus, or null to type into the focused element."},"text":{"type":"string"}},"required":["target_id","node_id","text"],"additionalProperties":false}"#;
const SCROLL_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"delta_x":{"type":"number"},"delta_y":{"type":"number"}},"required":["target_id","delta_x","delta_y"],"additionalProperties":false}"#;
const TARGET_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"}},"required":["target_id"],"additionalProperties":false}"#;

pub(crate) struct BrowserToolService<B> {
    browser: Arc<B>,
    definitions: Vec<ToolDefinition>,
}

impl<B> BrowserToolService<B> {
    pub(crate) fn new(browser: Arc<B>) -> Self {
        Self {
            browser,
            definitions: vec![
                definition(
                    "browser_open",
                    "Open an isolated embedded browser target and return its stable target ID.",
                    OPEN_SCHEMA,
                ),
                definition(
                    "browser_observe",
                    "Read the current page state, accessibility tree, and optional DOM or screenshot resources.",
                    OBSERVE_SCHEMA,
                ),
                definition(
                    "browser_navigate",
                    "Navigate an existing browser target to an allowed URL.",
                    NAVIGATE_SCHEMA,
                ),
                definition(
                    "browser_click",
                    "Click an element by backend DOM node ID from the latest observation.",
                    ELEMENT_SCHEMA,
                ),
                definition(
                    "browser_type",
                    "Focus an optional backend DOM node and insert text.",
                    TYPE_SCHEMA,
                ),
                definition(
                    "browser_scroll",
                    "Scroll the page by CSS-pixel deltas.",
                    SCROLL_SCHEMA,
                ),
                definition(
                    "browser_back",
                    "Navigate one browser target backward when history authorizations.",
                    TARGET_SCHEMA,
                ),
                definition(
                    "browser_reload",
                    "Reload one browser target.",
                    TARGET_SCHEMA,
                ),
                definition(
                    "browser_screenshot",
                    "Capture the browser target as a PNG App Server resource.",
                    TARGET_SCHEMA,
                ),
                definition(
                    "browser_close",
                    "Close exactly one browser target and release its host ownership.",
                    TARGET_SCHEMA,
                ),
            ],
        }
    }

    fn materialize(&self, call: &ToolCall) -> Result<BrowserToolRequest, CoreError> {
        match call.name.as_str() {
            "browser_open" => {
                let arguments: OpenArguments = decode(call)?;
                Ok(BrowserToolRequest::Open {
                    url: normalize_browser_url(&arguments.url)?,
                })
            }
            "browser_observe" => {
                let arguments: ObserveArguments = decode(call)?;
                Ok(BrowserToolRequest::Observe {
                    target_id: target_id(arguments.target_id)?,
                    include_dom_snapshot: arguments.include_dom_snapshot,
                    include_screenshot: arguments.include_screenshot,
                })
            }
            "browser_navigate" => {
                let arguments: NavigateArguments = decode(call)?;
                Ok(BrowserToolRequest::Navigate {
                    target_id: target_id(arguments.target_id)?,
                    url: normalize_browser_url(&arguments.url)?,
                })
            }
            "browser_click" => {
                let arguments: ElementArguments = decode(call)?;
                Ok(BrowserToolRequest::Click {
                    target_id: target_id(arguments.target_id)?,
                    target: element_target(arguments.node_id)?,
                })
            }
            "browser_type" => {
                let arguments: TypeArguments = decode(call)?;
                if arguments.text.is_empty() {
                    return Err(CoreError::Policy(
                        "browser_type text must not be empty".into(),
                    ));
                }
                Ok(BrowserToolRequest::TypeText {
                    target_id: target_id(arguments.target_id)?,
                    target: arguments
                        .node_id
                        .map(element_target)
                        .transpose()?
                        .map_or(BrowserTextInputTarget::FocusedElement, BrowserTextInputTarget::Element),
                    text: arguments.text,
                })
            }
            "browser_scroll" => {
                let arguments: ScrollArguments = decode(call)?;
                if !arguments.delta_x.is_finite() || !arguments.delta_y.is_finite() {
                    return Err(CoreError::Policy(
                        "browser scroll deltas must be finite".into(),
                    ));
                }
                Ok(BrowserToolRequest::Scroll {
                    target_id: target_id(arguments.target_id)?,
                    delta_x: arguments.delta_x,
                    delta_y: arguments.delta_y,
                })
            }
            "browser_back" => Ok(BrowserToolRequest::GoBack {
                target_id: target_id(decode::<TargetArguments>(call)?.target_id)?,
            }),
            "browser_reload" => Ok(BrowserToolRequest::Reload {
                target_id: target_id(decode::<TargetArguments>(call)?.target_id)?,
            }),
            "browser_screenshot" => Ok(BrowserToolRequest::Screenshot {
                target_id: target_id(decode::<TargetArguments>(call)?.target_id)?,
            }),
            "browser_close" => Ok(BrowserToolRequest::Close {
                target_id: target_id(decode::<TargetArguments>(call)?.target_id)?,
            }),
            _ => Err(CoreError::Policy(format!(
                "browser tool is not available: {}",
                call.name
            ))),
        }
    }

    fn review(
        &self,
        call: &ToolCall,
        request: &BrowserToolRequest,
    ) -> Result<ActionReviewRequest, CoreError> {
        let canonical = serde_json::to_vec(&json!({
            "tool": call.name,
            "arguments": call.arguments,
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::BrowserInteraction,
                request.summary(),
                CapabilitySet::new([Capability::new(
                    CapabilityKind::UserInterface,
                    request.capability_scope(),
                )]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, call.name.to_string()),
            SandboxCompatibility::NotApplicable {
                reason: "the Electron browser host is outside the local process sandbox".into(),
            },
            ActionPolicyRevision::new(BROWSER_POLICY_REVISION),
        ))
    }
}

impl<B: BrowserCapability> ToolService for BrowserToolService<B> {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.definitions.clone()
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        let request = self.materialize(call)?;
        self.review(call, &request)
    }

    fn execute(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let output = match self.materialize(call)? {
            BrowserToolRequest::Open { url } => {
                let created = self
                    .browser
                    .create_target(CreateBrowserTargetRequest { url }, cancellation)
                    .map_err(browser_error)?;
                json!({ "target_id": created.target_id.0 })
            }
            BrowserToolRequest::Observe {
                target_id,
                include_dom_snapshot,
                include_screenshot,
            } => observation_json(
                self.browser
                    .observe(
                        BrowserObserveRequest {
                            target_id,
                            include_accessibility_tree: true,
                            include_dom_snapshot,
                            include_screenshot,
                        },
                        cancellation,
                    )
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::Screenshot { target_id } => observation_json(
                self.browser
                    .observe(
                        BrowserObserveRequest {
                            target_id,
                            include_accessibility_tree: false,
                            include_dom_snapshot: false,
                            include_screenshot: true,
                        },
                        cancellation,
                    )
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::Navigate { target_id, url } => action_json(
                self.browser
                    .perform(BrowserAction::Navigate { target_id, url }, cancellation)
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::Click { target_id, target } => action_json(
                self.browser
                    .perform(BrowserAction::Click { target_id, target }, cancellation)
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::TypeText {
                target_id,
                target,
                text,
            } => action_json(
                self.browser
                    .perform(
                        BrowserAction::TypeText {
                            target_id,
                            target,
                            text,
                        },
                        cancellation,
                    )
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::Scroll {
                target_id,
                delta_x,
                delta_y,
            } => action_json(
                self.browser
                    .perform(
                        BrowserAction::Scroll {
                            target_id,
                            delta_x,
                            delta_y,
                        },
                        cancellation,
                    )
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::GoBack { target_id } => action_json(
                self.browser
                    .perform(BrowserAction::GoBack { target_id }, cancellation)
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::Reload { target_id } => action_json(
                self.browser
                    .perform(BrowserAction::Reload { target_id }, cancellation)
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::Close { target_id } => {
                self.browser
                    .close_target(target_id.clone(), cancellation)
                    .map_err(browser_error)?;
                json!({ "target_id": target_id.0, "closed": true })
            }
        };
        serde_json::to_string_pretty(&output)
            .map(ToolExecutionOutput::Success)
            .map_err(|error| CoreError::Execution(error.to_string()))
    }
}

pub(crate) struct BrowserToolPolicy;

impl ActionPolicyService for BrowserToolPolicy {
    fn revision(&self) -> String {
        BROWSER_POLICY_REVISION.into()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        if request.action_policy_revision().as_str() != BROWSER_POLICY_REVISION
            || request.provenance().source() != &ActionSource::BuiltInTool
            || request.action().kind() != &ActionKind::BrowserInteraction
            || !matches!(request.phase(), ActionReviewPhase::Initial)
            || !matches!(
                request.sandbox(),
                SandboxCompatibility::NotApplicable { .. }
            )
            || request.action().required_capabilities().iter().count() != 1
            || request
                .action()
                .required_capabilities()
                .iter()
                .any(|capability| {
                    capability.kind() != &CapabilityKind::UserInterface
                        || capability.scope().trim().is_empty()
                })
        {
            return Err(CoreError::Policy(
                "browser tool policy rejected an action outside its exact review contract".into(),
            ));
        }
        Ok(ExecutionDecision::AskUser(ApprovalRequest::new(
            request.action().digest().clone(),
            request.action().required_capabilities().clone(),
            "browser actions operate the visible Electron browser and require one-time approval",
        )))
    }
}

enum BrowserToolRequest {
    Open {
        url: String,
    },
    Observe {
        target_id: BrowserTargetId,
        include_dom_snapshot: bool,
        include_screenshot: bool,
    },
    Navigate {
        target_id: BrowserTargetId,
        url: String,
    },
    Click {
        target_id: BrowserTargetId,
        target: BrowserElementTarget,
    },
    TypeText {
        target_id: BrowserTargetId,
        target: BrowserTextInputTarget,
        text: String,
    },
    Scroll {
        target_id: BrowserTargetId,
        delta_x: f64,
        delta_y: f64,
    },
    GoBack {
        target_id: BrowserTargetId,
    },
    Reload {
        target_id: BrowserTargetId,
    },
    Screenshot {
        target_id: BrowserTargetId,
    },
    Close {
        target_id: BrowserTargetId,
    },
}

impl BrowserToolRequest {
    fn target_id(&self) -> Option<&BrowserTargetId> {
        match self {
            Self::Open { .. } => None,
            Self::Observe { target_id, .. }
            | Self::Navigate { target_id, .. }
            | Self::Click { target_id, .. }
            | Self::TypeText { target_id, .. }
            | Self::Scroll { target_id, .. }
            | Self::GoBack { target_id }
            | Self::Reload { target_id }
            | Self::Screenshot { target_id }
            | Self::Close { target_id } => Some(target_id),
        }
    }

    fn capability_scope(&self) -> &str {
        self.target_id()
            .map_or("new-browser-target", |target| &target.0)
    }

    fn summary(&self) -> String {
        match self {
            Self::Open { url } => format!("open browser target at {url}"),
            Self::Observe { target_id, .. } => format!("observe browser target {}", target_id.0),
            Self::Navigate { target_id, url } => {
                format!("navigate browser target {} to {url}", target_id.0)
            }
            Self::Click { target_id, .. } => format!("click in browser target {}", target_id.0),
            Self::TypeText { target_id, .. } => format!("type into browser target {}", target_id.0),
            Self::Scroll { target_id, .. } => format!("scroll browser target {}", target_id.0),
            Self::GoBack { target_id } => format!("go back in browser target {}", target_id.0),
            Self::Reload { target_id } => format!("reload browser target {}", target_id.0),
            Self::Screenshot { target_id } => format!("capture browser target {}", target_id.0),
            Self::Close { target_id } => format!("close browser target {}", target_id.0),
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OpenArguments {
    url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ObserveArguments {
    target_id: String,
    include_dom_snapshot: bool,
    include_screenshot: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NavigateArguments {
    target_id: String,
    url: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ElementArguments {
    target_id: String,
    node_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TypeArguments {
    target_id: String,
    node_id: Option<String>,
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScrollArguments {
    target_id: String,
    delta_x: f64,
    delta_y: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TargetArguments {
    target_id: String,
}

fn definition(name: &str, description: &str, parameters: &str) -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(name).expect("static browser tool name is valid"),
        description: description.into(),
        parameters: serde_json::from_str(parameters).expect("static browser tool schema is valid"),
        strict: true,
    }
}

fn decode<T: for<'de> Deserialize<'de>>(call: &ToolCall) -> Result<T, CoreError> {
    serde_json::from_value(call.arguments.clone())
        .map_err(|error| CoreError::Policy(format!("invalid {} arguments: {error}", call.name)))
}

fn target_id(value: String) -> Result<BrowserTargetId, CoreError> {
    if value.trim().is_empty() || value.len() > 256 {
        return Err(CoreError::Policy("browser target ID is invalid".into()));
    }
    Ok(BrowserTargetId(value))
}

fn element_target(value: String) -> Result<BrowserElementTarget, CoreError> {
    let bytes = value.as_bytes();
    if !bytes
        .first()
        .is_some_and(|byte| byte.is_ascii_digit() && *byte != b'0')
        || !bytes.iter().all(u8::is_ascii_digit)
        || value.parse::<u64>().is_err()
    {
        return Err(CoreError::Policy(
            "browser node ID must be a positive backend DOM node ID".into(),
        ));
    }
    Ok(BrowserElementTarget { node_id: value })
}

fn normalize_browser_url(value: &str) -> Result<String, CoreError> {
    if value.is_empty() || value.len() > MAX_URL_LENGTH {
        return Err(CoreError::Policy("browser URL length is invalid".into()));
    }
    let url = Url::parse(value).map_err(|_| CoreError::Policy("browser URL is invalid".into()))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CoreError::Policy(
            "browser URL credentials are not allowed".into(),
        ));
    }
    let loopback_http =
        url.scheme() == "http" && matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !loopback_http && url.as_str() != "about:blank" {
        return Err(CoreError::Policy(
            "browser URL must use HTTPS, loopback HTTP, or about:blank".into(),
        ));
    }
    Ok(url.into())
}

fn action_json(result: core_api::BrowserActionResult) -> Value {
    json!({ "target_id": result.target_id.0 })
}

fn observation_json(observation: core_api::BrowserObservation) -> Value {
    let screenshot = observation.screenshot.map(|resource| {
        json!({
            "resource_id": resource.resource_id,
            "mime_type": resource.mime_type,
            "size": resource.size,
            "digest": resource.digest,
        })
    });
    json!({
        "target_id": observation.target_id.0,
        "url": observation.url,
        "title": observation.title,
        "loading": observation.loading,
        "accessibility_tree": observation.accessibility_tree,
        "dom_snapshot": observation.dom_snapshot,
        "screenshot": screenshot,
    })
}

fn browser_error(error: core_api::BrowserError) -> CoreError {
    match error {
        core_api::BrowserError::PolicyDenied(reason) => CoreError::Policy(reason),
        core_api::BrowserError::Cancelled(reason) => CoreError::Cancelled(reason),
        other => CoreError::Execution(other.to_string()),
    }
}

#[cfg(test)]
#[path = "browser_tool_tests.rs"]
mod tests;
