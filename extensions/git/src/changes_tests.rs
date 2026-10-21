use super::working_file_resource;
use serde_json::json;

#[test]
fn diff_open_file_retains_live_and_snapshot_working_resource_identity() {
    for resource in [
        "file:///work/main.ts",
        "file:///C:/work/space%20name.ts",
        "ash-remote://host/work/main.ts",
    ] {
        assert_eq!(
            working_file_resource(&json!({"resource": resource})).as_deref(),
            Some(resource)
        );
        let mut snapshot = url::Url::parse("git-change:/staged/main.ts").unwrap();
        snapshot.query_pairs_mut().append_pair("resource", resource);
        assert_eq!(
            working_file_resource(&json!({"resource": snapshot.as_str()})).as_deref(),
            Some(resource)
        );
    }
    assert_eq!(
        working_file_resource(&json!({"resource": "git-change:/missing"})),
        None
    );
    assert_eq!(
        working_file_resource(&json!({"resource": "not a URI"})),
        None
    );
}
