use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpClientError;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_http_client::ProxyPolicy;
use ash_http_client::UreqHttpClient;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Arc;

struct NoDownload;
impl HttpClient for NoDownload {
    fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        panic!("offline hosting must not download an already available package");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires ASH_MEDIA_PACKAGE, ASH_LIVEKIT_PACKAGE and ASH_TEST_COLLABORATION_SERVER"]
async fn local_host_installs_sfu_then_connects_media_and_releases_services() {
    let home = tempfile::tempdir().unwrap();
    let store = home.path().join("capabilities/livekit");
    assert!(!store.exists());
    // Ordinary audio and speech initialization must not install the call hosting server.
    assert!(resolve(home.path(), "ash-voice-host", &NoDownload).is_file());
    let relative = std::path::Path::new("relative.onnx");
    assert!(matches!(
        realtime_voice::recognizer::Recognizer::open(
            &recognizer_executable(),
            relative,
            relative,
            relative,
            realtime_voice::recognizer::RecognitionMode::Dictation
        ),
        Err(ref error) if error == "invalid media capability response"
    ));
    assert!(!store.exists());
    let server = call::LocalDeployment::livekit_server(home.path(), &NoDownload).unwrap();
    assert!(server.starts_with(store.canonicalize().unwrap()));
    assert_eq!(
        call::LocalDeployment::livekit_server(home.path(), &NoDownload).unwrap(),
        server
    );
    let deployment = call::LocalDeployment::start(
        &call::ServicePaths {
            media: server,
            collaboration: PathBuf::from(
                std::env::var_os("ASH_TEST_COLLABORATION_SERVER").unwrap(),
            )
            .canonicalize()
            .unwrap(),
        },
        &home.path().join("calls.sqlite3"),
    )
    .unwrap();
    let client = call::CallClient::new(
        deployment.url(),
        call::MemberCredential::generate(),
        Arc::new(
            UreqHttpClient::with_config(
                HttpClientConfig::default().with_proxy_policy(ProxyPolicy::Direct),
            )
            .unwrap(),
        ),
    )
    .unwrap();
    client
        .create(deployment.administrator(), "hosting-split")
        .unwrap();
    let grant = client.join("host").unwrap();
    assert!(grant.microphone);
    let room = livekit_client::MediaRoom::connect(
        &provider_executable(),
        &grant.server_url,
        &grant.participant_token,
        livekit_client::AudioPublication::Microphone,
    )
    .await
    .unwrap();
    room.send_audio(&[800; 480]).await.unwrap();
    room.close().await.unwrap();
    let signal = url::Url::parse(&grant.server_url).unwrap().port().unwrap();
    let control = url::Url::parse(deployment.url()).unwrap().port().unwrap();
    drop(deployment);
    assert!(TcpStream::connect(("127.0.0.1", signal)).is_err());
    assert!(TcpStream::connect(("127.0.0.1", control)).is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires ASH_DEV_RUNTIME_ROOT with HTTPS media binding, ASH_TEST_MEDIA_CA (DER), ASH_LIVEKIT_PACKAGE, ASH_TEST_COLLABORATION_SERVER; unset media executable overrides"]
async fn downloaded_media_runs_from_requested_profile_and_does_not_install_sfu() {
    let home = tempfile::tempdir().unwrap();
    let store = home.path().join("capabilities");
    // Capturing a network/profile context is inert: no install lock, cache or process.
    let certificates = ash_http_client::CertificateBundle::from_der(vec![
        std::fs::read(std::env::var_os("ASH_TEST_MEDIA_CA").unwrap()).unwrap(),
    ])
    .unwrap();
    let config = HttpClientConfig::default()
        .with_proxy_policy(ProxyPolicy::Direct)
        .with_tls_policy(ash_http_client::TlsPolicy::CustomOnly(certificates))
        .with_response_body_limit(
            ash_http_client::ResponseBodyLimit::new(
                std::num::NonZeroUsize::new(128 * 1024 * 1024).unwrap(),
            )
            .unwrap(),
        );
    let http = UreqHttpClient::with_config(config).unwrap();
    assert!(!store.exists());
    let audio = resolve(home.path(), "ash-voice-host", &http);
    let provider = resolve(home.path(), "ash-livekit-client", &NoDownload);
    assert!(audio.starts_with(store.canonicalize().unwrap()));
    assert_eq!(resolve(home.path(), "ash-voice-host", &NoDownload), audio);
    let sources = livekit_client::screen_sources(&provider).unwrap();
    assert!(
        sources
            .iter()
            .all(|source| source.width > 0 && source.height > 0)
    );
    // Load inference through the downloaded worker, with normal invalid-model semantics.
    let relative = std::path::Path::new("invalid.onnx");
    assert!(matches!(
        realtime_voice::recognizer::Recognizer::open(
            &resolve(home.path(), "ash-realtime-voice", &NoDownload),
            relative,
            relative,
            relative,
            realtime_voice::recognizer::RecognitionMode::Dictation
        ),
        Err(ref error) if error == "invalid media capability response"
    ));
    assert!(!store.join("livekit").exists());

    // A separate host supplies the external room; the joining profile needs no SFU.
    let host_home = tempfile::tempdir().unwrap();
    let deployment = call::LocalDeployment::start(
        &call::ServicePaths {
            media: call::LocalDeployment::livekit_server(host_home.path(), &NoDownload).unwrap(),
            collaboration: PathBuf::from(
                std::env::var_os("ASH_TEST_COLLABORATION_SERVER").unwrap(),
            )
            .canonicalize()
            .unwrap(),
        },
        &host_home.path().join("calls.sqlite3"),
    )
    .unwrap();
    let client = call::CallClient::new(
        deployment.url(),
        call::MemberCredential::generate(),
        Arc::new(
            UreqHttpClient::with_config(
                HttpClientConfig::default().with_proxy_policy(ProxyPolicy::Direct),
            )
            .unwrap(),
        ),
    )
    .unwrap();
    client
        .create(deployment.administrator(), "download-test")
        .unwrap();
    let grant = client.join("downloaded-provider").unwrap();
    let room = livekit_client::MediaRoom::connect(
        &provider,
        &grant.server_url,
        &grant.participant_token,
        livekit_client::AudioPublication::Microphone,
    )
    .await
    .unwrap();
    room.send_audio(&[900; 480]).await.unwrap();
    room.close().await.unwrap();
    assert!(!store.join("livekit").exists());
    drop(deployment);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires ASH_DEV_RUNTIME_ROOT with bundled media, ASH_LIVEKIT_PACKAGE, ASH_TEST_COLLABORATION_SERVER; unset media executable overrides"]
async fn bundled_desktop_media_works_with_network_denied_and_leaves_profile_uninstalled() {
    let home = tempfile::tempdir().unwrap();
    let audio = resolve(home.path(), "ash-voice-host", &NoDownload);
    assert!(!audio.starts_with(home.path()));
    let network = ash_http_client::OutboundNetworkSnapshot::with_policy(
        HttpClientConfig::default(),
        ash_http_client::OutboundNetworkPolicy::new(ash_http_client::NetworkAccess::Hosts(
            std::collections::BTreeSet::new(),
        )),
    )
    .unwrap();
    let http = ash_http_client::ReqwestHttpClient::with_network(network).unwrap();
    let provider = resolve(home.path(), "ash-livekit-client", &http);
    assert_eq!(resolve(home.path(), "ash-voice-host", &http), audio);
    livekit_client::screen_sources(&provider).unwrap();
    let invalid = std::path::Path::new("relative.onnx");
    assert!(matches!(
        realtime_voice::recognizer::Recognizer::open(
            &provider,
            invalid,
            invalid,
            invalid,
            realtime_voice::recognizer::RecognitionMode::Dictation
        ),
        Err(ref error) if error == "invalid media capability response"
    ));
    assert!(!home.path().join("capabilities").exists());

    // The room is hosted by another profile; joining it must not install an SFU here.
    let host_home = tempfile::tempdir().unwrap();
    let deployment = call::LocalDeployment::start(
        &call::ServicePaths {
            media: call::LocalDeployment::livekit_server(host_home.path(), &NoDownload).unwrap(),
            collaboration: PathBuf::from(
                std::env::var_os("ASH_TEST_COLLABORATION_SERVER").unwrap(),
            )
            .canonicalize()
            .unwrap(),
        },
        &host_home.path().join("calls.sqlite3"),
    )
    .unwrap();
    let client = call::CallClient::new(
        deployment.url(),
        call::MemberCredential::generate(),
        Arc::new(
            UreqHttpClient::with_config(
                HttpClientConfig::default().with_proxy_policy(ProxyPolicy::Direct),
            )
            .unwrap(),
        ),
    )
    .unwrap();
    client
        .create(deployment.administrator(), "bundled-desktop")
        .unwrap();
    let grant = client.join("desktop").unwrap();
    let room = livekit_client::MediaRoom::connect(
        &provider,
        &grant.server_url,
        &grant.participant_token,
        livekit_client::AudioPublication::Microphone,
    )
    .await
    .unwrap();
    room.send_audio(&[900; 480]).await.unwrap();
    room.close().await.unwrap();
    assert!(!home.path().join("capabilities").exists());
    drop(deployment);
}

fn provider_executable() -> std::path::PathBuf {
    std::env::var_os("ASH_LIVEKIT_CLIENT_PATH")
        .map(std::path::PathBuf::from)
        .expect("exact packaged provider executable")
}

fn resolve(home: &std::path::Path, binary: &str, http: &dyn HttpClient) -> PathBuf {
    let offline = std::env::var_os("ASH_MEDIA_PACKAGE").map(PathBuf::from);
    let source = match offline.as_deref() {
        Some(path) => ash_package_store::CapabilitySource::Directory(path),
        None => ash_package_store::CapabilitySource::ProductBound,
    };
    ash_package_store::resolve_capability_executable(home, "media", binary, source, http).unwrap()
}

fn recognizer_executable() -> PathBuf {
    std::env::var_os("ASH_RECOGNIZER_PATH")
        .map(PathBuf::from)
        .expect("exact recognition executable")
}
