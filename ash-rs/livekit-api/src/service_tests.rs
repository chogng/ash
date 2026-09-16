use super::*;
use livekit_sdk_api::access_token::TokenVerifier;

const KEY: &str = "test-key";
const SECRET: &str = "test-secret-at-least-thirty-two-bytes";

fn service() -> MediaService {
    MediaService::new(
        "ws://127.0.0.1:7880",
        "http://127.0.0.1:7880",
        KEY.into(),
        SecretValue::new(SECRET.as_bytes().to_vec()),
    )
    .unwrap()
}

#[test]
fn token_has_only_requested_room_permissions() {
    let credential = service()
        .issue_join(
            "room-1",
            "member-1",
            MediaPermissions {
                microphone: true,
                subscribe: true,
                screen: false,
            },
        )
        .unwrap();
    let claims = TokenVerifier::with_api_key(KEY, SECRET)
        .verify(credential.token())
        .unwrap();
    assert_eq!(claims.sub, "member-1");
    assert_eq!(claims.video.room, "room-1");
    assert!(claims.video.room_join);
    assert!(claims.video.can_publish);
    assert!(claims.video.can_subscribe);
    assert_eq!(claims.video.can_publish_sources, ["microphone"]);
    assert!(!claims.video.can_publish_data);
    assert!(!claims.video.room_admin);
    assert!(!claims.video.room_create);
    assert!(!claims.video.can_update_own_metadata);
    assert!(claims.exp - claims.nbf <= JOIN_TOKEN_TTL.as_secs() as usize);
}

#[test]
fn listener_cannot_publish_and_token_cannot_be_verified_with_other_key() {
    let credential = service()
        .issue_join(
            "room-1",
            "listener",
            MediaPermissions {
                subscribe: true,
                ..Default::default()
            },
        )
        .unwrap();
    let claims = TokenVerifier::with_api_key(KEY, SECRET)
        .verify(credential.token())
        .unwrap();
    assert!(!claims.video.can_publish);
    assert!(claims.video.can_publish_sources.is_empty());
    assert!(
        TokenVerifier::with_api_key("other", SECRET)
            .verify(credential.token())
            .is_err()
    );
}

#[test]
fn endpoint_and_identity_boundaries_are_checked() {
    for url in [
        "ws://example.com:7880",
        "wss://user:secret@example.com",
        "wss://example.com?token=abc",
        "file:///tmp/server",
    ] {
        assert!(validate_url(url, &["ws", "wss"]).is_err(), "{url}");
    }
    for url in [
        "wss://example.com:443",
        "ws://127.0.0.1:7880",
        "ws://[::1]:7880",
    ] {
        assert!(validate_url(url, &["ws", "wss"]).is_ok(), "{url}");
    }
    assert!(
        service()
            .issue_join("../room", "member", MediaPermissions::default())
            .is_err()
    );
    assert!(
        service()
            .issue_join("room", "", MediaPermissions::default())
            .is_err()
    );
}
