use super::*;

#[test]
fn requests_cannot_supply_a_user_or_add_an_unrecognized_operation() {
    for request in [
        r#"{"operation":"status","ownerSid":"S-1-5-18"}"#,
        r#"{"operation":"run","command":"cmd.exe"}"#,
        r#"{"operation":"remove","approved":"abc","root":"C:\\other"}"#,
    ] {
        assert!(serde_json::from_str::<Request>(request).is_err());
    }
}

#[test]
fn approval_and_runner_identity_survive_the_wire() {
    let message = Message {
        version: PROTOCOL_VERSION,
        request: Request::Setup {
            runner: PathBuf::from("C:/Ash/bin/ash-windows-sandbox.exe"),
            slots: 2,
            approved: "approved-plan-digest".into(),
        },
    };
    let bytes = serde_json::to_vec(&message).unwrap();
    let decoded: Message = serde_json::from_slice(&bytes).unwrap();
    match decoded.request {
        Request::Setup {
            runner,
            slots,
            approved,
        } => {
            assert_eq!(runner, PathBuf::from("C:/Ash/bin/ash-windows-sandbox.exe"));
            assert_eq!(slots, 2);
            assert_eq!(approved, "approved-plan-digest");
        }
        _ => panic!("request changed during serialization"),
    }
}
