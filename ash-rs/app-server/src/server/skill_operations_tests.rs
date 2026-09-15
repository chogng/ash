use super::*;
use crate::local::ProviderModelService;
use ash_core::InMemoryThreadStore;
use ash_core::ThreadController;
use ash_model_provider::EchoModel;
use base64::Engine;
use std::sync::Arc;

struct EmptySkillConfig;

impl ash_skills_extension::SkillConfigSnapshotProvider for EmptySkillConfig {
    fn snapshot(&self) -> Result<ash_config::SkillsConfig, String> {
        Ok(ash_config::SkillsConfig::default())
    }
}

fn server(root: &std::path::Path) -> AppServer {
    let threads = Arc::new(ThreadController::with_store(Arc::new(
        InMemoryThreadStore::default(),
    )));
    AppServer::new(
        threads,
        Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
    )
    .with_skill_runtime(
        ash_skills_extension::BuiltInSkillSource::Root(root.to_path_buf()),
        Arc::new(EmptySkillConfig),
        None,
    )
    .unwrap()
}

fn call(
    server: &AppServer,
    connection: &mut crate::server::ConnectionState,
    id: u64,
    method: &str,
    params: Value,
) -> Value {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    });
    serde_json::from_str(&server.handle_json(connection, &request.to_string())).unwrap()
}

#[test]
fn skill_resources_are_digest_pinned_connection_owned_and_safely_typed() {
    let root = tempfile::tempdir().unwrap();
    let skill = root.path().join("media");
    std::fs::create_dir_all(skill.join("assets")).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: media\ndescription: Provides media assets when requested.\n---\n# Media\n",
    )
    .unwrap();
    let png = b"\x89PNG\r\n\x1a\nfixture".to_vec();
    std::fs::write(skill.join("assets/logo.png"), &png).unwrap();
    std::fs::write(skill.join("assets/not-really.png"), b"plain text").unwrap();
    std::fs::write(
        skill.join("assets/active.svg"),
        b"<svg><script>alert(1)</script></svg>",
    )
    .unwrap();

    let server = server(root.path());
    let mut owner = server.connection();
    let initialized = call(
        &server,
        &mut owner,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );
    assert!(initialized.get("result").is_some());
    let listed = call(&server, &mut owner, 2, "skills/list", serde_json::json!({}));
    let skill_id = listed["result"]["skills"][0]["id"].clone();
    let skill_content_digest = listed["result"]["skills"][0]["contentDigest"].clone();

    let opened = call(
        &server,
        &mut owner,
        3,
        "skill/resource/open",
        serde_json::json!({
            "skillId": skill_id,
            "skillContentDigest": skill_content_digest,
            "path": "assets/logo.png"
        }),
    );
    assert_eq!(opened["result"]["path"], "assets/logo.png");
    assert_eq!(opened["result"]["kind"], "asset");
    assert_eq!(opened["result"]["resource"]["mimeType"], "image/png");
    assert_eq!(opened["result"]["resource"]["size"], png.len());
    let resource_id = opened["result"]["resource"]["resourceId"].as_str().unwrap();
    let read = call(
        &server,
        &mut owner,
        4,
        "resource/read",
        serde_json::json!({
            "resourceId": resource_id,
            "offset": 0,
            "maxBytes": 262144
        }),
    );
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(read["result"]["dataBase64"].as_str().unwrap())
            .unwrap(),
        png
    );

    let mut other_connection = server.connection();
    call(
        &server,
        &mut other_connection,
        5,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "other", "version": "1"},
            "capabilities": {}
        }),
    );
    let denied = call(
        &server,
        &mut other_connection,
        6,
        "resource/read",
        serde_json::json!({
            "resourceId": resource_id,
            "offset": 0,
            "maxBytes": 1
        }),
    );
    assert_eq!(denied["error"]["message"], "ResourceNotOwner");

    let active = call(
        &server,
        &mut owner,
        7,
        "skill/resource/open",
        serde_json::json!({
            "skillId": listed["result"]["skills"][0]["id"].clone(),
            "skillContentDigest": listed["result"]["skills"][0]["contentDigest"].clone(),
            "path": "assets/active.svg"
        }),
    );
    assert_eq!(
        active["result"]["resource"]["mimeType"],
        "application/octet-stream"
    );

    let mismatched_signature = call(
        &server,
        &mut owner,
        8,
        "skill/resource/open",
        serde_json::json!({
            "skillId": listed["result"]["skills"][0]["id"].clone(),
            "skillContentDigest": listed["result"]["skills"][0]["contentDigest"].clone(),
            "path": "assets/not-really.png"
        }),
    );
    assert_eq!(
        mismatched_signature["result"]["resource"]["mimeType"],
        "application/octet-stream"
    );
}

#[test]
fn skill_resource_open_rejects_path_traversal_and_stale_digest() {
    let root = tempfile::tempdir().unwrap();
    let skill = root.path().join("review");
    std::fs::create_dir_all(skill.join("references")).unwrap();
    std::fs::write(
        skill.join("SKILL.md"),
        "---\nname: review\ndescription: Reviews changes when requested.\n---\n# Review\n",
    )
    .unwrap();
    std::fs::write(skill.join("references/checks.md"), "checks").unwrap();
    let server = server(root.path());
    let mut connection = server.connection();
    call(
        &server,
        &mut connection,
        1,
        "initialize",
        serde_json::json!({
            "clientInfo": {"name": "test", "version": "1"},
            "capabilities": {}
        }),
    );
    let listed = call(
        &server,
        &mut connection,
        2,
        "skills/list",
        serde_json::json!({}),
    );
    let skill_id = listed["result"]["skills"][0]["id"].clone();

    let traversal = call(
        &server,
        &mut connection,
        3,
        "skill/resource/open",
        serde_json::json!({
            "skillId": skill_id,
            "skillContentDigest": listed["result"]["skills"][0]["contentDigest"].clone(),
            "path": "../outside"
        }),
    );
    assert_eq!(traversal["error"]["message"], "InvalidParams");

    let stale = call(
        &server,
        &mut connection,
        4,
        "skill/resource/open",
        serde_json::json!({
            "skillId": listed["result"]["skills"][0]["id"].clone(),
            "skillContentDigest": format!("sha256:{}", "0".repeat(64)),
            "path": "references/checks.md"
        }),
    );
    assert_eq!(stale["error"]["message"], "SkillOperationFailed");
}
