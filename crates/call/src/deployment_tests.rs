use super::*;
use ash_http_client::HttpClientConfig;
use ash_http_client::ProxyPolicy;
use ash_http_client::UreqHttpClient;
use std::sync::Arc;

#[test]
#[ignore = "requires ASH_TEST_LIVEKIT_SERVER and ASH_TEST_COLLABORATION_SERVER"]
fn local_deployment_issues_real_media_grants_and_releases_both_listeners() {
    let directory = tempfile::tempdir().unwrap();
    let deployment = LocalDeployment::start(
        &ServicePaths {
            media: PathBuf::from(
                std::env::var_os("ASH_TEST_LIVEKIT_SERVER").expect("media server"),
            )
            .canonicalize()
            .unwrap(),
            collaboration: PathBuf::from(
                std::env::var_os("ASH_TEST_COLLABORATION_SERVER").expect("collaboration server"),
            )
            .canonicalize()
            .unwrap(),
        },
        &directory.path().join("calls.sqlite3"),
    )
    .unwrap();
    let client = crate::CallClient::new(
        deployment.url(),
        MemberCredential::generate(),
        Arc::new(
            UreqHttpClient::with_config(
                HttpClientConfig::default().with_proxy_policy(ProxyPolicy::Direct),
            )
            .unwrap(),
        ),
    )
    .unwrap();
    let created = client.create(deployment.administrator(), "create").unwrap();
    let grant = client.join("device").unwrap();
    assert_eq!(
        (created.id, grant.microphone, grant.member.role),
        (grant.call.id, true, crate::CallRole::Owner)
    );
    let signal = url::Url::parse(&grant.server_url).unwrap().port().unwrap();
    let control = url::Url::parse(deployment.url()).unwrap().port().unwrap();
    drop(deployment);
    assert!(TcpStream::connect(("127.0.0.1", signal)).is_err());
    assert!(TcpStream::connect(("127.0.0.1", control)).is_err());
}
