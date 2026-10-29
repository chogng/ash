use super::ExtensionClientOperation;
use super::ExtensionClientRequest;
use super::ExtensionClientResult;
use crate::HostErrorCode;
use crate::ProtocolLimits;
use crate::RequestContext;
use serde_json::Value;
use serde_json::json;

#[test]
fn private_storage_contract_has_only_key_operations_and_redacts_secrets() {
    for request in [
        json!({"service":"storageGet","key":"one"}),
        json!({"service":"storageSet","key":"one","value":null}),
        json!({"service":"storageDelete","key":"one"}),
        json!({"service":"secretLoad","key":"token"}),
        json!({"service":"secretStore","key":"token","value":[1,2,3]}),
        json!({"service":"secretDelete","key":"token"}),
    ] {
        let wire = json!({"operation":"coreService","request":request});
        let operation: ExtensionClientOperation = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&operation).unwrap(), wire);
        assert!(!format!("{operation:?}").contains("token"));
        let mut forged = wire;
        forged["request"]["namespace"] = json!("other");
        assert!(serde_json::from_value::<ExtensionClientOperation>(forged).is_err());
    }
    for service in ["storageRead", "storageUpdate", "secretChanges"] {
        assert!(
            serde_json::from_value::<ExtensionClientOperation>(
                json!({"operation":"coreService","request":{"service":service}})
            )
            .is_err()
        );
    }
    let response = crate::services::CoreServiceResponse::StorageValue {
        value: Value::Null,
        found: true,
    };
    assert_eq!(
        serde_json::to_value(response).unwrap(),
        json!({"service":"storageValue","value":null,"found":true})
    );
    let response = crate::services::CoreServiceResponse::SecretLoaded {
        value: Some(b"synthetic-secret".to_vec()),
    };
    assert_eq!(format!("{response:?}"), "CoreServiceResponse([REDACTED])");
}

#[test]
fn backend_state_watch_is_opt_in_and_keeps_legacy_calls_unchanged() {
    for wire in [
        json!({"operation":"backendState","capability":"git.repository","after":3}),
        json!({"operation":"backendState","capability":"git.repository","after":3,"waitForChange":true}),
        json!({"operation":"backendState","capability":"git.repository","after":3,"waitForChange":false}),
    ] {
        let operation: ExtensionClientOperation = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(operation).unwrap(), wire);
    }
    assert!(serde_json::from_value::<ExtensionClientOperation>(json!({"operation":"backendState","capability":"git.repository","after":3,"waitForChange":"yes"})).is_err());
}

#[test]
fn notification_buttons_round_trip_and_legacy_messages_keep_their_wire_shape() {
    for wire in [
        json!({"operation":"showMessage","message":"Git failed","severity":"error"}),
        json!({"operation":"showMessage","message":"Git failed","severity":"error","items":["Output","Retry"]}),
    ] {
        let operation: ExtensionClientOperation = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&operation).unwrap(), wire);
        ExtensionClientRequest {
            context: RequestContext::new(1, 2, 3),
            call_id: 1,
            operation,
        }
        .validate(&ProtocolLimits::default())
        .unwrap();
    }
    for items in [vec![String::new()], vec!["Action".to_owned(); 17]] {
        let operation = ExtensionClientOperation::ShowMessage {
            message: "Choose".into(),
            severity: super::ExtensionMessageSeverity::Warning,
            items,
        };
        assert!(
            ExtensionClientRequest {
                context: RequestContext::new(1, 2, 3),
                call_id: 1,
                operation,
            }
            .validate(&ProtocolLimits::default())
            .is_err()
        );
    }
}

#[test]
fn quick_pick_preserves_descriptions_and_rejects_invalid_peer_items() {
    let wire = json!({"operation":"showQuickPick","placeholder":"Choose a branch","items":[{"label":"main"},{"label":"occupied","description":"origin/occupied","detail":"Checked out in another worktree"}]});
    let operation: ExtensionClientOperation = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(serde_json::to_value(&operation).unwrap(), wire);
    ExtensionClientRequest {
        context: RequestContext::new(1, 2, 3),
        call_id: 1,
        operation,
    }
    .validate(&ProtocolLimits::default())
    .unwrap();
    for item in [
        json!("main"),
        json!({"label":4}),
        json!({"label":"main","detail":false}),
        json!({"label":"main","owner":"forged"}),
    ] {
        assert!(
            serde_json::from_value::<ExtensionClientOperation>(
                json!({"operation":"showQuickPick","placeholder":"Choose","items":[item]})
            )
            .is_err()
        );
    }
}

#[test]
fn resource_operations_round_trip_and_reject_invalid_uris_and_forged_owners() {
    for operation in ["readResourceFile", "statResource", "readResourceDirectory"] {
        let wire = json!({"operation": operation, "uri": "vfs://workspace/folder/file.md"});
        let decoded: ExtensionClientOperation = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(&decoded).unwrap(), wire);
        ExtensionClientRequest {
            context: RequestContext::new(1, 2, 3),
            call_id: 1,
            operation: decoded,
        }
        .validate(&ProtocolLimits::default())
        .unwrap();
        let mut forged = wire;
        forged["extensionId"] = json!("another-owner");
        assert!(serde_json::from_value::<ExtensionClientOperation>(forged).is_err());
        for uri in [
            String::new(),
            "relative/file.md".into(),
            "file:/bad\0path".into(),
            format!("file:/{}", "a".repeat(8192)),
        ] {
            let request = ExtensionClientRequest {
                context: RequestContext::new(1, 2, 3),
                call_id: 1,
                operation: serde_json::from_value(json!({"operation":operation,"uri":uri}))
                    .unwrap(),
            };
            assert!(request.validate(&ProtocolLimits::default()).is_err());
        }
    }
}

#[test]
fn command_results_distinguish_void_from_explicit_json_values_and_accept_older_clients() {
    for (value, has_value) in [
        (Value::Null, false),
        (Value::Null, true),
        (json!(false), true),
        (json!(0), true),
    ] {
        let wire = json!({"result":"command","value":value,"hasValue":has_value});
        let result: ExtensionClientResult = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(result).unwrap(), wire);
    }
    assert_eq!(
        serde_json::from_value::<ExtensionClientResult>(json!({"result":"command","value":null}))
            .unwrap(),
        ExtensionClientResult::Command {
            value: Value::Null,
            has_value: true
        }
    );
    assert!(
        serde_json::from_value::<ExtensionClientResult>(
            json!({"result":"command","value":null,"hasValue":"false"})
        )
        .is_err()
    );
}

#[test]
fn task_queries_and_execution_handles_preserve_filters_and_reject_forged_owners() {
    for operation in [
        json!({"operation":"fetchTasks","version":"2.0.0","taskType":"builder"}),
        json!({"operation":"executeTask","task":null,"taskId":"workspace:build"}),
        json!({"operation":"executeTask","taskId":null,"task":{"id":"explicit","execution":{"type":"process","program":"compiler","args":["$HOME",""]}}}),
        json!({"operation":"terminateTask","executionId":"run-1"}),
    ] {
        let request: ExtensionClientOperation = serde_json::from_value(operation.clone()).unwrap();
        assert_eq!(serde_json::to_value(request).unwrap(), operation);
        let mut forged = operation;
        forged["extensionId"] = json!("other");
        assert!(serde_json::from_value::<ExtensionClientOperation>(forged).is_err());
    }
    let result = ExtensionClientResult::Tasks {
        sequence: 3,
        tasks: vec![json!({"id":"workspace:build","definition":{"type":"builder","target":false}})],
        executions: vec![json!({"id":"run-1","active":true})],
    };
    assert_eq!(
        serde_json::from_value::<ExtensionClientResult>(serde_json::to_value(&result).unwrap())
            .unwrap(),
        result
    );
}

#[test]
fn edited_custom_tasks_select_a_catalog_callback_and_reject_ambiguous_process_selections() {
    for (operation, valid) in [
        (
            json!({"operation":"executeTask","taskId":"catalog-custom","task":{"id":"edited","execution":{"type":"custom","id":"edited"}}}),
            true,
        ),
        (
            json!({"operation":"executeTask","taskId":"catalog-process","task":{"id":"edited","execution":{"type":"process","program":"compiler","args":[]}}}),
            false,
        ),
        (
            json!({"operation":"executeTask","taskId":null,"task":null}),
            false,
        ),
        (
            json!({"operation":"executeTask","taskId":"","task":{"execution":{"type":"custom"}}}),
            false,
        ),
        (
            json!({"operation":"executeTask","taskId":"custom","task":[]}),
            false,
        ),
    ] {
        let request = ExtensionClientRequest {
            context: RequestContext::new(1, 1, 1),
            call_id: 1,
            operation: serde_json::from_value(operation).unwrap(),
        };
        assert_eq!(request.validate(&ProtocolLimits::default()).is_ok(), valid);
    }
}

#[test]
fn status_bar_updates_round_trip_and_reject_duplicate_ids_and_forged_owners() {
    let value = json!({
        "context": {"protocolVersion":1,"requestId":41,"incarnation":3,"activationGeneration":7},
        "callId":9, "operation": {"operation":"setStatusBarEntries","registrationId":"status","revision":2,"entries":[{
            "id":"item.1","text":"Ready","tooltip":null,"ariaLabel":"Run","alignment":"right","priority":1.5,
            "command":{"command":"example.run","arguments":[{"value":2}]}
        }]}
    });
    let request: ExtensionClientRequest = serde_json::from_value(value.clone()).unwrap();
    request.validate(&ProtocolLimits::default()).unwrap();
    assert_eq!(serde_json::to_value(request).unwrap(), value);
    let mut duplicate = value.clone();
    duplicate["operation"]["entries"] = json!([
        value["operation"]["entries"][0],
        value["operation"]["entries"][0]
    ]);
    assert!(
        serde_json::from_value::<ExtensionClientRequest>(duplicate)
            .unwrap()
            .validate(&ProtocolLimits::default())
            .is_err()
    );
    let mut invalid = value.clone();
    invalid["operation"]["revision"] = json!(0);
    assert!(
        serde_json::from_value::<ExtensionClientRequest>(invalid)
            .unwrap()
            .validate(&ProtocolLimits::default())
            .is_err()
    );
    let mut forged = value;
    forged["operation"]["extensionId"] = json!("other");
    assert!(serde_json::from_value::<ExtensionClientRequest>(forged).is_err());
}

#[test]
fn diagnostic_replacements_preserve_versions_and_reject_forged_ownership_and_invalid_ranges() {
    let value = json!({
        "context": {"protocolVersion":1,"requestId":41,"incarnation":3,"activationGeneration":7},
        "callId":9, "operation": {"operation":"setDiagnostics","collection":"lint","entries":[{
            "uri":"file:///main.ts", "version":7, "diagnostics":[{
                "start":{"line":0,"character":2}, "end":{"line":0,"character":4},
                "message":"Check this", "severity":"warning", "source":"test", "code":null
            }]
        }]}
    });
    let request: ExtensionClientRequest = serde_json::from_value(value.clone()).unwrap();
    request.validate(&ProtocolLimits::default()).unwrap();
    assert_eq!(serde_json::to_value(&request).unwrap(), value);
    let mut merge = value.clone();
    merge["operation"]["merge"] = json!(true);
    let update: ExtensionClientRequest = serde_json::from_value(merge.clone()).unwrap();
    update.validate(&ProtocolLimits::default()).unwrap();
    assert_eq!(serde_json::to_value(update).unwrap(), merge);
    let mut invalid = value.clone();
    invalid["operation"]["entries"][0]["diagnostics"][0]["end"]["character"] = json!(1);
    assert!(
        serde_json::from_value::<ExtensionClientRequest>(invalid)
            .unwrap()
            .validate(&ProtocolLimits::default())
            .is_err()
    );
    let mut forged = value;
    forged["operation"]["extensionId"] = json!("other");
    assert!(serde_json::from_value::<ExtensionClientRequest>(forged).is_err());
}

#[test]
fn workspace_read_preserves_parent_identity_and_has_a_distinct_disk_result() {
    let request = ExtensionClientRequest {
        context: RequestContext {
            protocol_version: 1,
            request_id: 41,
            incarnation: 3,
            activation_generation: 7,
        },
        call_id: 9,
        operation: ExtensionClientOperation::ReadWorkspaceFile {
            path: "src/main.rs".into(),
        },
    };
    request.validate(&ProtocolLimits::default()).unwrap();
    let value = serde_json::to_value(&request).unwrap();
    assert_eq!(
        value,
        json!({"context":{"protocolVersion":1,"requestId":41,"incarnation":3,"activationGeneration":7},"callId":9,"operation":{"operation":"readWorkspaceFile","path":"src/main.rs"}})
    );
    assert_eq!(
        serde_json::from_value::<ExtensionClientRequest>(value).unwrap(),
        request
    );
    assert_eq!(
        serde_json::to_value(ExtensionClientResult::File {
            text: "on disk".into()
        })
        .unwrap(),
        json!({"result":"file","text":"on disk"})
    );
    assert!(
        serde_json::from_value::<ExtensionClientOperation>(
            json!({"operation":"readWorkspaceFile","path":"src/main.rs","extensionId":"forged"})
        )
        .is_err()
    );
    assert_eq!(
        serde_json::to_value(HostErrorCode::PermissionDenied).unwrap(),
        json!("permissionDenied")
    );
}

#[test]
fn debug_session_operations_preserve_null_arguments_and_reject_forged_owners() {
    for operation in [
        json!({"operation":"listDebugSessions"}),
        json!({"operation":"setDebugSessionName","sessionId":"debug-1","name":"Renamed session"}),
        json!({"operation":"addDebugBreakpoints","breakpoints":[{"kind":"source","id":"source-1","uri":"file:///workspace/main.ts","line":2,"column":4,"enabled":true}]}),
        json!({"operation":"removeDebugBreakpoints","breakpointIds":["source-1"]}),
        json!({"operation":"getDebugProtocolBreakpoint","sessionId":"debug-1","breakpointId":"source-1"}),
        json!({"operation":"startDebugging","folder":"file:///workspace","configuration":"Launch"}),
        json!({"operation":"startDebugging","folder":null,"configuration":{"name":"Explicit","type":"builder","request":"launch"}}),
        json!({"operation":"startDebugging","folder":null,"configuration":"Child","options":{"parentSessionId":"parent","noDebug":false,"consoleMode":1,"lifecycleManagedByParent":true,"suppressSaveBeforeStart":true}}),
        json!({"operation":"stopDebugging","sessionId":null}),
        json!({"operation":"debugCustomRequest","sessionId":"debug-1","command":"echo","arguments":null,"hasArguments":true}),
    ] {
        let decoded: ExtensionClientOperation = serde_json::from_value(operation.clone()).unwrap();
        let request = ExtensionClientRequest {
            context: RequestContext::new(1, 1, 1),
            call_id: 1,
            operation: decoded,
        };
        request.validate(&ProtocolLimits::default()).unwrap();
        assert_eq!(serde_json::to_value(request.operation).unwrap(), operation);
        let mut forged = operation;
        forged["extensionId"] = json!("other");
        assert!(serde_json::from_value::<ExtensionClientOperation>(forged).is_err());
    }
    for configuration in [Value::Null, json!(false), json!([])] {
        let request = ExtensionClientRequest {
            context: RequestContext::new(1, 1, 1),
            call_id: 1,
            operation: ExtensionClientOperation::StartDebugging {
                folder: None,
                configuration,
                options: None,
            },
        };
        assert!(request.validate(&ProtocolLimits::default()).is_err());
    }
    for has_body in [false, true] {
        let response = ExtensionClientResult::DebugResponse {
            value: Value::Null,
            has_body,
        };
        assert_eq!(
            serde_json::from_value::<ExtensionClientResult>(
                serde_json::to_value(&response).unwrap()
            )
            .unwrap(),
            response
        );
    }
}

#[test]
fn debug_session_options_reject_invalid_values_before_dispatch() {
    for options in [
        json!({"parentSessionId":""}),
        json!({"parentSessionId":"parent\u{0}"}),
        json!({"consoleMode":2}),
        json!({"consoleMode":-1}),
        json!({"noDebug":"true"}),
        json!({"lifecycleManagedByParent":1}),
        json!({"suppressSaveBeforeStart":1}),
        json!({"unknown":true}),
    ] {
        let wire = json!({"operation":"startDebugging","folder":null,"configuration":"Child","options":options});
        if let Ok(operation) = serde_json::from_value(wire) {
            let request = ExtensionClientRequest {
                context: RequestContext::new(1, 1, 1),
                call_id: 1,
                operation,
            };
            assert!(request.validate(&ProtocolLimits::default()).is_err());
        }
    }
}

#[test]
fn lifecycle_calls_are_strictly_fenced_and_share_operation_validation() {
    let value = serde_json::json!({ "context": {"protocolVersion": 1, "incarnation": 2, "activationGeneration": 3}, "callId": 4, "operation": {"operation": "executeCommand", "command": "test.run", "arguments": []} });
    let request: super::ExtensionBackgroundClientRequest =
        serde_json::from_value(value.clone()).unwrap();
    request.validate(&crate::ProtocolLimits::default()).unwrap();
    assert!(matches!(
        serde_json::from_value::<crate::ExtensionHostStdoutFrame>(value.clone()).unwrap(),
        crate::ExtensionHostStdoutFrame::BackgroundClientRequest(_)
    ));
    for field in ["requestId", "connectionId", "extensionId"] {
        let mut forged = value.clone();
        forged["context"][field] = serde_json::json!(99);
        assert!(serde_json::from_value::<super::ExtensionBackgroundClientRequest>(forged).is_err());
    }
    let mut invalid = request.clone();
    invalid.context.incarnation = 0;
    assert!(invalid.validate(&crate::ProtocolLimits::default()).is_err());
    invalid = request;
    invalid.operation = super::ExtensionClientOperation::RemoveDebugBreakpoints {
        breakpoint_ids: vec![String::new()],
    };
    assert!(invalid.validate(&crate::ProtocolLimits::default()).is_err());
}

#[test]
fn initialization_reads_cannot_select_another_window_or_inject_facts() {
    let request: ExtensionClientOperation =
        serde_json::from_value(json!({"operation":"readInitialization"})).unwrap();
    assert!(matches!(
        request,
        ExtensionClientOperation::ReadInitialization {}
    ));
    for key in ["connectionId", "initialization", "extensionId"] {
        let mut invalid = json!({"operation":"readInitialization"});
        invalid[key] = json!(42);
        assert!(serde_json::from_value::<ExtensionClientOperation>(invalid).is_err());
    }
}

#[test]
fn terminal_requests_validate_identity_and_process_boundaries() {
    for operation in [
        json!({"operation":"createTerminal","name":"Debug","cwd":"/workspace","env":{"REMOVED":null},"command":"pnpm dev"}),
        json!({"operation":"createTerminal","name":"Debug","cwd":null,"env":{},"appendEnv":{"NODE_OPTIONS":" --require=debug.cjs"},"command":null}),
        json!({"operation":"readTerminal","terminalId":"owned","afterSequence":0}),
        json!({"operation":"disposeTerminal","terminalId":"owned"}),
    ] {
        let request = ExtensionClientRequest {
            context: RequestContext::new(1, 1, 1),
            call_id: 1,
            operation: serde_json::from_value(operation).unwrap(),
        };
        request.validate(&ProtocolLimits::default()).unwrap();
    }
    for operation in [
        json!({"operation":"createTerminal","name":"Debug","cwd":null,"env":{"INVALID=KEY":"value"},"command":null}),
        json!({"operation":"createTerminal","name":"Debug","cwd":null,"env":{"MODE":"bad\u{0}value"},"command":null}),
        json!({"operation":"createTerminal","name":"Debug","cwd":null,"env":{},"appendEnv":{"INVALID=KEY":"value"},"command":null}),
        json!({"operation":"disposeTerminal","terminalId":""}),
    ] {
        let request = ExtensionClientRequest {
            context: RequestContext::new(1, 1, 1),
            call_id: 1,
            operation: serde_json::from_value(operation).unwrap(),
        };
        assert!(request.validate(&ProtocolLimits::default()).is_err());
    }
}
