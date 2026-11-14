use super::call;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

fn registration() -> Value {
    json!({"clientId":"ui", "file":{
        "id":"a".repeat(64), "resource":"ash-profile:/generated/review.md",
        "title":"Review", "contentType":"text/markdown",
        "source":{"providerId":"provider", "accountId":null, "sessionId":"session",
            "threadId":"thread", "itemId":"item", "partId":"part"}
    }})
}

fn initialize(server: &crate::AppServer, connection: &mut crate::ConnectionState) {
    let response = call(
        server,
        connection,
        json!({"jsonrpc":"2.0", "id":1,
            "method":"initialize", "params":{"clientInfo":{"name":"generated-files-test", "version":"1"}, "capabilities":{}}
        }),
    );
    assert!(response.get("result").is_some(), "{response}");
}

fn list(
    server: &crate::AppServer,
    connection: &mut crate::ConnectionState,
    client_id: &str,
    request_id: u64,
) -> Value {
    call(
        server,
        connection,
        json!({"jsonrpc":"2.0", "id":request_id,
            "method":"artifactCatalog/list", "params":{"clientId":client_id}
        }),
    )
}

#[test]
fn artifact_catalog_rpc_persists_profile_references_and_isolates_namespaces() {
    let profile = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let open = || super::directory_test_server(profile.path(), directory.path());
    let first = open();
    let mut writer = first.product_host_connection();
    initialize(&first, &mut writer);
    let response = call(
        &first,
        &mut writer,
        json!({"jsonrpc":"2.0", "id":2,
            "method":"artifactCatalog/register", "params":registration()
        }),
    );
    assert!(response.get("result").is_some(), "{response}");
    let file = response["result"]["file"].clone();
    assert!(file["source"]["accountId"].is_null());
    assert!(file["createdAt"].as_i64().unwrap() > 0);
    first.close_connection(writer);
    drop(first);
    let reopened = open();
    let mut reader = reopened.product_host_connection();
    initialize(&reopened, &mut reader);
    assert_eq!(
        list(&reopened, &mut reader, "ui", 2)["result"]["files"],
        json!([file])
    );
    assert_eq!(
        list(&reopened, &mut reader, "other-ui", 3)["result"]["files"],
        json!([])
    );
    let retry = call(
        &reopened,
        &mut reader,
        json!({"jsonrpc":"2.0", "id":4,
            "method":"artifactCatalog/register", "params":registration()
        }),
    );
    assert_eq!(retry["result"]["file"], file);
    let mut conflicting = registration();
    conflicting["file"]["source"]["itemId"] = json!("other");
    let conflict = call(
        &reopened,
        &mut reader,
        json!({"jsonrpc":"2.0", "id":5,
            "method":"artifactCatalog/register", "params":conflicting
        }),
    );
    assert_eq!(conflict["error"]["data"]["kind"], "ArtifactCatalogConflict");
    assert_eq!(conflict["error"]["code"], -32003);
    reopened.close_connection(reader);
}

#[test]
fn artifact_catalog_rpc_invalidates_initialized_product_hosts_across_directory_scopes() {
    let profile = tempfile::tempdir().unwrap();
    let directories = [tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap()];
    let runtime = Arc::new(crate::LocalProfileRuntime::open(profile.path()).unwrap());
    let open = |directory: &std::path::Path| {
        crate::open_app_server(
            crate::AppServerOptions::new(profile.path())
                .with_profile_runtime(runtime.clone())
                .with_dir_root(directory)
                .without_built_in_skills()
                .with_agent_model_service(Arc::new(crate::local::ProviderModelService::new(
                    Arc::new(super::EchoModel),
                ))),
            ash_app_server_diff::compute,
        )
        .unwrap()
    };
    let first = open(directories[0].path());
    let second = open(directories[1].path());
    let mut writer = first.product_host_connection();
    let mut observer = second.product_host_connection();
    let mut untrusted = second.connection();
    let mut pending = second.product_host_connection();
    initialize(&first, &mut writer);
    initialize(&second, &mut observer);
    initialize(&second, &mut untrusted);
    first.drain_notifications(&mut writer);
    second.drain_notifications(&mut observer);
    second.drain_notifications(&mut untrusted);
    let denied = list(&second, &mut untrusted, "ui", 2);
    assert_eq!(denied["error"]["data"]["kind"], "PermissionRequired");
    let response = call(
        &first,
        &mut writer,
        json!({"jsonrpc":"2.0", "id":2,
            "method":"artifactCatalog/register", "params":registration()
        }),
    );
    assert!(response.get("result").is_some(), "{response}");
    let notifications = |server: &crate::AppServer, connection: &mut crate::ConnectionState| {
        server
            .drain_notifications(connection)
            .into_iter()
            .map(|value| serde_json::from_str::<Value>(&value).unwrap())
            .filter(|value| value["method"] == "artifactCatalog/changed")
            .collect::<Vec<_>>()
    };
    assert_eq!(
        notifications(&second, &mut observer),
        vec![json!({
            "jsonrpc":"2.0", "method":"artifactCatalog/changed", "params":{"clientId":"ui"}
        })]
    );
    assert!(notifications(&second, &mut untrusted).is_empty());
    assert!(notifications(&second, &mut pending).is_empty());
    assert_eq!(
        list(&second, &mut observer, "ui", 3)["result"]["files"],
        json!([response["result"]["file"]])
    );
    let retry = call(
        &second,
        &mut observer,
        json!({"jsonrpc":"2.0", "id":4,
            "method":"artifactCatalog/register", "params":registration()
        }),
    );
    assert_eq!(retry["result"], response["result"]);
    assert!(notifications(&second, &mut observer).is_empty());
    first.close_connection(writer);
    second.close_connection(observer);
    second.close_connection(untrusted);
    second.close_connection(pending);
}
