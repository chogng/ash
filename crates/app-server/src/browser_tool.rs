use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ApprovalRequest;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_core::ToolAuthorization;
use ash_core::ToolService;
use ash_protocol::ActionDigest;
use ash_protocol::ActionKind;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::ActionProvenance;
use ash_protocol::ActionReviewPhase;
use ash_protocol::ActionSource;
use ash_protocol::Capability;
use ash_protocol::CapabilityKind;
use ash_protocol::CapabilitySet;
use ash_protocol::ToolCall;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use core_api::ActionPolicyService;
use core_api::BrowserAction;
use core_api::BrowserCapability;
use core_api::BrowserCdpOperation;
use core_api::BrowserElementTarget;
use core_api::BrowserObserveRequest;
use core_api::BrowserTargetId;
use core_api::BrowserTextInputTarget;
use core_api::CoreError;
use core_api::CreateBrowserTargetRequest;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use url::Url;

const BROWSER_POLICY_REVISION: &str = "browser-host-user-approval-v1";
const MAX_URL_LENGTH: usize = 8192;

const OPEN_SCHEMA: &str = r#"{"type":"object","properties":{"url":{"type":"string","description":"HTTPS, loopback HTTP, or about:blank URL to open."}},"required":["url"],"additionalProperties":false}"#;
const OBSERVE_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"include_dom_snapshot":{"type":"boolean"},"include_screenshot":{"type":"boolean"}},"required":["target_id","include_dom_snapshot","include_screenshot"],"additionalProperties":false}"#;
const NAVIGATE_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"url":{"type":"string"}},"required":["target_id","url"],"additionalProperties":false}"#;
const ELEMENT_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"node_id":{"type":"string","description":"backendDOMNodeId returned by browser_observe."}},"required":["target_id","node_id"],"additionalProperties":false}"#;
const TYPE_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"node_id":{"type":["string","null"],"description":"backendDOMNodeId to focus, or null to type into the focused element."},"text":{"type":"string"}},"required":["target_id","node_id","text"],"additionalProperties":false}"#;
const SCROLL_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"delta_x":{"type":"number"},"delta_y":{"type":"number"}},"required":["target_id","delta_x","delta_y"],"additionalProperties":false}"#;
const TARGET_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"}},"required":["target_id"],"additionalProperties":false}"#;

const DRAG_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"source_node_id":{"type":"string"},"destination_node_id":{"type":"string"}},"required":["target_id","source_node_id","destination_node_id"],"additionalProperties":false}"#;
const DIALOG_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"accept":{"type":"boolean"},"prompt_text":{"type":["string","null"]}},"required":["target_id","accept","prompt_text"],"additionalProperties":false}"#;
const SCRIPT_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"code":{"type":"string","minLength":1,"maxLength":32768}},"required":["target_id","code"],"additionalProperties":false}"#;
const CDP_SCHEMA: &str = r#"{"type":"object","properties":{"target_id":{"type":"string"},"method":{"type":"string","minLength":1,"maxLength":256},"params_json":{"type":"string","description":"JSON object containing CDP command parameters."},"session_id":{"type":["string","null"],"description":"Flattened CDP session ID, or null to select the page automatically (browser and Target commands use the logical browser)."}},"required":["target_id","method","params_json","session_id"],"additionalProperties":false}"#;
const LIST_SCHEMA: &str =
    r#"{"type":"object","properties":{},"required":[],"additionalProperties":false}"#;

pub(crate) struct BrowserToolService {
    browser: Arc<crate::browser_host::BrowserHost>,
    definitions: Vec<ToolDefinition>,
}

impl BrowserToolService {
    pub(crate) fn new(browser: Arc<crate::browser_host::BrowserHost>) -> Self {
        Self {
            browser,
            definitions: vec![
                definition(
                    "browser_cdp",
                    "Send a Chrome DevTools Protocol command. Requires the user's advanced CDP setting. Access is limited to this task's isolated Agent pages and contexts; Ash workbench targets and user pages are excluded. Page domains select target_id automatically; use session_id for child targets. Events are buffered for browser_cdp_events. New targets also return browserViewId for the semantic browser tools. Network requests retain the task's network policy.",
                    CDP_SCHEMA,
                ),
                definition(
                    "browser_cdp_events",
                    "Drain buffered CDP events for this task, including a dropped-event count. Enable the relevant CDP domain with browser_cdp first.",
                    TARGET_SCHEMA,
                ),
                definition(
                    "browser_cdp_close",
                    "Release this task's CDP subscriptions and contexts without closing its ordinary browser pages.",
                    TARGET_SCHEMA,
                ),
                definition(
                    "browser_list_pages",
                    "List browser pages owned by or explicitly shared with this task.",
                    LIST_SCHEMA,
                ),
                definition(
                    "browser_hover",
                    "Hover an observed backend DOM node in one browser target.",
                    ELEMENT_SCHEMA,
                ),
                definition(
                    "browser_drag",
                    "Drag between two observed backend DOM nodes in one browser target.",
                    DRAG_SCHEMA,
                ),
                definition(
                    "browser_handle_dialog",
                    "Accept or dismiss the current JavaScript dialog, optionally supplying prompt text.",
                    DIALOG_SCHEMA,
                ),
                definition(
                    "browser_run_playwright",
                    "Run concise JavaScript against the provided page facade in the page's isolated Chromium world. Supports page title/url/content/evaluate and Playwright locators, click/hover/fill/press, keyboard/mouse actions and text queries. No Node APIs, other pages, files, browser contexts or raw CDP. Execution is bounded to five seconds; return a JSON-serializable result.",
                    SCRIPT_SCHEMA,
                ),
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
            "browser_cdp" => {
                let args: CdpArguments = decode(call)?;
                let mut parts = args.method.split('.');
                if !parts.next().is_some_and(|part| {
                    !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
                }) || !parts.next().is_some_and(|part| {
                    !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
                }) || parts.next().is_some()
                    || args.method.len() > 256
                    || args.params_json.len() > 1024 * 1024
                    || args
                        .session_id
                        .as_ref()
                        .is_some_and(|id| id.is_empty() || id.len() > 256)
                {
                    return Err(CoreError::Policy("invalid CDP command".into()));
                }
                let params = serde_json::from_str(&args.params_json).map_err(|_| {
                    CoreError::Policy("CDP parameters must be a JSON object".into())
                })?;
                Ok(BrowserToolRequest::Interaction(BrowserAction::Cdp {
                    target_id: target_id(args.target_id)?,
                    operation: BrowserCdpOperation::Command {
                        method: args.method,
                        params,
                        session_id: args.session_id,
                    },
                }))
            }
            "browser_cdp_events" | "browser_cdp_close" => {
                let args: TargetArguments = decode(call)?;
                Ok(BrowserToolRequest::Interaction(BrowserAction::Cdp {
                    target_id: target_id(args.target_id)?,
                    operation: if call.name.as_str() == "browser_cdp_events" {
                        BrowserCdpOperation::ReadEvents
                    } else {
                        BrowserCdpOperation::Close
                    },
                }))
            }
            "browser_list_pages" => {
                let _: EmptyArguments = decode(call)?;
                Ok(BrowserToolRequest::List)
            }
            "browser_hover" => {
                let args: ElementArguments = decode(call)?;
                Ok(BrowserToolRequest::Interaction(BrowserAction::Hover {
                    target_id: target_id(args.target_id)?,
                    target: element_target(args.node_id)?,
                }))
            }
            "browser_drag" => {
                let args: DragArguments = decode(call)?;
                Ok(BrowserToolRequest::Interaction(BrowserAction::Drag {
                    target_id: target_id(args.target_id)?,
                    source: element_target(args.source_node_id)?,
                    destination: element_target(args.destination_node_id)?,
                }))
            }
            "browser_handle_dialog" => {
                let args: DialogArguments = decode(call)?;
                if args
                    .prompt_text
                    .as_ref()
                    .is_some_and(|text| text.len() > 32768)
                {
                    return Err(CoreError::Policy("browser prompt text is too large".into()));
                }
                Ok(BrowserToolRequest::Interaction(
                    BrowserAction::HandleDialog {
                        target_id: target_id(args.target_id)?,
                        accept: args.accept,
                        prompt_text: args.prompt_text,
                    },
                ))
            }
            "browser_run_playwright" => {
                let args: ScriptArguments = decode(call)?;
                if args.code.trim().is_empty() || args.code.len() > 32768 {
                    return Err(CoreError::Policy(
                        "browser script must contain between 1 and 32768 bytes".into(),
                    ));
                }
                Ok(BrowserToolRequest::Interaction(
                    BrowserAction::RunPlaywright {
                        target_id: target_id(args.target_id)?,
                        code: args.code,
                    },
                ))
            }
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
                    target: arguments.node_id.map(element_target).transpose()?.map_or(
                        BrowserTextInputTarget::FocusedElement,
                        BrowserTextInputTarget::Element,
                    ),
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

impl ToolService for BrowserToolService {
    fn tool_set(&self, _: &ash_protocol::ToolName) -> Option<&'static str> {
        Some("core.browser")
    }

    fn tool_category(&self, _: &ash_protocol::ToolName) -> Option<ash_protocol::ToolCategory> {
        Some(ash_protocol::ToolCategory::Browser)
    }

    fn definitions(&self) -> Vec<ToolDefinition> {
        self.definitions.clone()
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        let request = self.materialize(call)?;
        self.review(call, &request)
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Err(CoreError::Execution(
            "Browser tools require an originating task and browser host".into(),
        ))
    }

    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        facts: &ash_core::ToolExecutionFacts,
    ) -> Result<ActionReviewRequest, CoreError> {
        self.browser_for(facts)?;
        self.prepare(call)
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ash_core::ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_request(call, cancellation, &self.browser_for(facts)?)
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ash_core::ToolExecutionFacts,
        _: &mut dyn ash_core::ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_with_facts(call, authorization, cancellation, facts)
    }

    fn execute_streaming_with_facts_and_interactions(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ash_core::ToolExecutionFacts,
        interactions: Arc<dyn ash_core::ToolInteractionService>,
        _: &mut dyn ash_core::ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let lease = self
            .browser_for(facts)?
            .with_network_policy(
                crate::network_policy::ExecutionNetworkPolicy::new(
                    self.prepare(call)?,
                    interactions,
                ),
                cancellation,
            )
            .map_err(browser_error)?;
        self.execute_request(call, cancellation, &lease.host)
    }
}

impl BrowserToolService {
    fn browser_for(
        &self,
        facts: &ash_core::ToolExecutionFacts,
    ) -> Result<crate::browser_host::BrowserHost, CoreError> {
        let identity = facts
            .execution_identity()
            .ok_or_else(|| CoreError::Execution("Browser tools require a task identity".into()))?;
        self.browser
            .for_turn(identity.thread_id(), identity.turn_id())
            .map_err(browser_error)
    }

    fn execute_request(
        &self,
        call: &ToolCall,
        cancellation: &CancellationToken,
        browser: &dyn BrowserCapability,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let output = match self.materialize(call)? {
            BrowserToolRequest::List => {
                json!({ "pages": browser.list_targets(cancellation).map_err(browser_error)?.into_iter().map(|page| json!({ "target_id": page.target_id.0, "url": page.url, "title": page.title, "loading": page.loading })).collect::<Vec<_>>() })
            }
            BrowserToolRequest::Interaction(action) => action_json(
                browser
                    .perform(action, cancellation)
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::Open { url } => {
                let created = browser
                    .create_target(CreateBrowserTargetRequest { url }, cancellation)
                    .map_err(browser_error)?;
                json!({ "target_id": created.target_id.0 })
            }
            BrowserToolRequest::Observe {
                target_id,
                include_dom_snapshot,
                include_screenshot,
            } => observation_json(
                browser
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
                browser
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
                browser
                    .perform(BrowserAction::Navigate { target_id, url }, cancellation)
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::Click { target_id, target } => action_json(
                browser
                    .perform(BrowserAction::Click { target_id, target }, cancellation)
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::TypeText {
                target_id,
                target,
                text,
            } => action_json(
                browser
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
                browser
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
                browser
                    .perform(BrowserAction::GoBack { target_id }, cancellation)
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::Reload { target_id } => action_json(
                browser
                    .perform(BrowserAction::Reload { target_id }, cancellation)
                    .map_err(browser_error)?,
            ),
            BrowserToolRequest::Close { target_id } => {
                browser
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
            || !matches!(
                request.action().kind(),
                ActionKind::BrowserInteraction | ActionKind::NetworkRequest
            )
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
                    capability.kind()
                        != if request.action().kind() == &ActionKind::NetworkRequest {
                            &CapabilityKind::Network
                        } else {
                            &CapabilityKind::UserInterface
                        }
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
    List,
    Interaction(BrowserAction),
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
            Self::Open { .. } | Self::List => None,
            Self::Interaction(action) => Some(match action {
                BrowserAction::Cdp { target_id, .. }
                | BrowserAction::Navigate { target_id, .. }
                | BrowserAction::Click { target_id, .. }
                | BrowserAction::Hover { target_id, .. }
                | BrowserAction::Drag { target_id, .. }
                | BrowserAction::HandleDialog { target_id, .. }
                | BrowserAction::RunPlaywright { target_id, .. }
                | BrowserAction::TypeText { target_id, .. }
                | BrowserAction::Scroll { target_id, .. }
                | BrowserAction::GoBack { target_id }
                | BrowserAction::Reload { target_id } => target_id,
            }),
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
        if matches!(self, Self::List) {
            return "browser-page-list";
        }
        self.target_id()
            .map_or("new-browser-target", |target| &target.0)
    }

    fn summary(&self) -> String {
        match self {
            Self::List => "list browser pages available to this task".into(),
            Self::Interaction(BrowserAction::Cdp {
                target_id,
                operation: BrowserCdpOperation::Command { method, .. },
            }) => format!("send CDP {method} for browser target {}", target_id.0),
            Self::Interaction(_) => format!(
                "operate browser target {}",
                self.target_id().expect("interaction has a target").0
            ),
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyArguments {}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DragArguments {
    target_id: String,
    source_node_id: String,
    destination_node_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DialogArguments {
    target_id: String,
    accept: bool,
    prompt_text: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ScriptArguments {
    target_id: String,
    code: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CdpArguments {
    target_id: String,
    method: String,
    params_json: String,
    session_id: Option<String>,
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
    json!({ "target_id": result.target_id.0, "output": result.output })
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
