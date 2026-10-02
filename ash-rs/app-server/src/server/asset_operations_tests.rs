use super::AppServer;
use super::ConnectionState;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

const PNG: &[u8] = &[
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 1, 8, 6, 0,
    0, 0, 244, 34, 127, 138, 0, 0, 0, 14, 73, 68, 65, 84, 120, 156, 99, 248, 207, 192, 240, 31, 4,
    1, 16, 248, 3, 253, 78, 149, 193, 111, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
];
const ASSET: &str = "11111111-1111-4111-8111-111111111111";
const VERSION: &str = "22222222-2222-4222-8222-222222222222";

fn rpc(server: &AppServer, connection: &mut ConnectionState, method: &str, params: Value) -> Value {
    static NEXT_ID: AtomicU64 = AtomicU64::new(1);
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let response = server.handle_json(
        connection,
        &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string(),
    );
    let value: Value = serde_json::from_str(&response).unwrap();
    if method == "asset/import/start" {
        assert!(value.get("result").is_some(), "{value}");
    }
    value
}

fn initialize(server: &AppServer) -> ConnectionState {
    let mut connection = server.connection();
    let result = rpc(
        server,
        &mut connection,
        "initialize",
        json!({"clientInfo":{"name":"asset-test","version":"1"},"capabilities":{"notifications":true}}),
    );
    assert!(result.get("result").is_some(), "{result}");
    connection
}

#[test]
fn asset_rpc_uploads_are_isolated_but_committed_versions_survive_connection_close() {
    let temp = tempfile::tempdir().unwrap();
    let server = AppServer::new(
        Arc::new(ash_core::ThreadController::with_store(Arc::new(
            ash_core::InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(
            ash_model_provider::EchoModel,
        ))),
    )
    .with_local_assets(&temp.path().join("state.sqlite"))
    .unwrap();
    let mut first = initialize(&server);
    let mut second = initialize(&server);
    assert_eq!(
        rpc(
            &server,
            &mut first,
            "asset/import/start",
            json!({"assetId":ASSET,"versionId":VERSION,"name":"product.png","source":"file:///product.png","size":PNG.len()})
        )["result"]["maxChunkBytes"],
        assets::MAX_CHUNK_BYTES
    );
    assert_eq!(
        rpc(
            &server,
            &mut second,
            "asset/import/write",
            json!({"versionId":VERSION,"offset":0,"dataBase64":STANDARD.encode(PNG)})
        )["error"]["data"]["kind"],
        "AssetNotFound"
    );
    assert_eq!(
        rpc(
            &server,
            &mut first,
            "asset/import/write",
            json!({"versionId":VERSION,"offset":0,"dataBase64":STANDARD.encode(PNG)})
        )["result"]["nextOffset"],
        PNG.len()
    );
    let version = rpc(
        &server,
        &mut first,
        "asset/import/finish",
        json!({"versionId":VERSION}),
    )["result"]
        .clone();
    assert_eq!(version["width"], 2);
    server.close_connection(first);
    assert_eq!(
        rpc(
            &server,
            &mut second,
            "asset/version",
            json!({"assetId":ASSET,"versionId":VERSION})
        )["result"],
        version
    );
    let bytes = rpc(
        &server,
        &mut second,
        "asset/read",
        json!({"assetId":ASSET,"versionId":VERSION,"offset":0,"maxBytes":196608}),
    );
    assert_eq!(
        STANDARD
            .decode(bytes["result"]["dataBase64"].as_str().unwrap())
            .unwrap(),
        PNG
    );
    assert_eq!(bytes["result"]["eof"], true);
}

#[test]
fn asset_catalog_rpc_persists_organization_and_rejects_unknown_membership_atomically() {
    let temp = tempfile::tempdir().unwrap();
    let server = AppServer::new(
        Arc::new(ash_core::ThreadController::with_store(Arc::new(
            ash_core::InMemoryThreadStore::default(),
        ))),
        Arc::new(crate::local::ProviderModelService::new(Arc::new(
            ash_model_provider::EchoModel,
        ))),
    )
    .with_local_assets(&temp.path().join("state.sqlite"))
    .unwrap();
    let mut connection = initialize(&server);
    rpc(
        &server,
        &mut connection,
        "asset/import/start",
        json!({"assetId":ASSET,"versionId":VERSION,"name":"product.png","source":"file:///product.png","size":PNG.len()}),
    );
    rpc(
        &server,
        &mut connection,
        "asset/import/write",
        json!({"versionId":VERSION,"offset":0,"dataBase64":STANDARD.encode(PNG)}),
    );
    rpc(
        &server,
        &mut connection,
        "asset/import/finish",
        json!({"versionId":VERSION}),
    );
    let collection = "44444444-4444-4444-8444-444444444444";
    assert!(
        rpc(
            &server,
            &mut connection,
            "asset/collection/create",
            json!({"id":collection,"name":"Brand"})
        )
        .get("result")
        .is_some()
    );
    assert!(
        rpc(
            &server,
            &mut connection,
            "asset/catalog/update",
            json!({"assetId":ASSET,"favorite":true,"collectionIds":[collection]})
        )
        .get("result")
        .is_some()
    );
    let catalog = rpc(&server, &mut connection, "asset/catalog", json!({}))["result"].clone();
    assert_eq!(catalog["entries"][0]["version"]["versionId"], VERSION);
    assert_eq!(catalog["entries"][0]["favorite"], true);
    assert_eq!(catalog["entries"][0]["collectionIds"], json!([collection]));
    assert_eq!(
        rpc(
            &server,
            &mut connection,
            "asset/catalog/update",
            json!({"assetId":ASSET,"favorite":false,"collectionIds":["55555555-5555-4555-8555-555555555555"]})
        )["error"]["data"]["kind"],
        "AssetNotFound"
    );
    assert_eq!(
        rpc(&server, &mut connection, "asset/catalog", json!({}))["result"],
        catalog
    );
    assert!(
        rpc(
            &server,
            &mut connection,
            "asset/collection/delete",
            json!({"id":collection})
        )
        .get("result")
        .is_some()
    );
    assert_eq!(
        rpc(&server, &mut connection, "asset/catalog", json!({}))["result"]["entries"][0]["collectionIds"],
        json!([])
    );
}
