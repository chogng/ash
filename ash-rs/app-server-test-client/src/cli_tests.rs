use super::*;

#[test]
fn transport_options_reject_ambiguous_or_unused_settings() {
    for args in [
        vec![
            "client",
            "--server-bin",
            "server",
            "--url",
            "ws://127.0.0.1:4222",
            "initialize",
        ],
        vec!["client", "--token", "secret", "initialize"],
        vec![
            "client",
            "--url",
            "ws://127.0.0.1:4222",
            "--home",
            "profile",
            "initialize",
        ],
        vec![
            "client",
            "--url",
            "ws://127.0.0.1:4222",
            "--workspace",
            "dir",
            "initialize",
        ],
        vec!["client", "--timeout", "0", "initialize"],
    ] {
        assert!(Cli::try_parse_from(args).is_err());
    }
}

#[test]
fn invalid_requests_are_rejected_before_connecting() {
    for (method, params) in [
        ("initialize", "{}"),
        (" ", "{}"),
        ("model/list", "[]"),
        ("model/list", "{"),
    ] {
        assert!(
            PreparedCommand::new(Command::Request {
                method: method.into(),
                params: params.into(),
                watch: false,
            })
            .is_err()
        );
    }
    assert!(
        PreparedCommand::new(Command::Watch {
            session_id: Some(String::new())
        })
        .is_err()
    );
}

#[test]
fn model_list_selects_the_requested_catalog_view() {
    for (args, expected_view) in [
        (vec!["client", "model-list"], "discovered"),
        (
            vec!["client", "model-list", "--view", "built-in"],
            "builtIn",
        ),
    ] {
        let cli = Cli::try_parse_from(args).unwrap();
        let PreparedCommand::Request { method, params, .. } =
            PreparedCommand::new(cli.command).unwrap()
        else {
            panic!("model-list must prepare a request");
        };
        assert_eq!(method, ClientMethod::ModelList.as_str());
        assert_eq!(params, serde_json::json!({"view": expected_view}));
    }
}
