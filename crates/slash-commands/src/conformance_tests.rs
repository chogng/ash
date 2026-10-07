use serde::Deserialize;

use crate::{SlashCommandCatalog, SlashCommandDefinition, SlashCommandInput};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    definitions: Vec<SlashCommandDefinition>,
    matching: Vec<MatchingCase>,
    inputs: Vec<InputCase>,
    invalid_definitions: Vec<SlashCommandDefinition>,
}

#[derive(Deserialize)]
struct MatchingCase {
    query: String,
    names: Vec<String>,
}

#[derive(Deserialize)]
struct InputCase {
    text: String,
    kind: String,
    name: Option<String>,
    arguments: Option<String>,
}

#[test]
fn rust_core_matches_cross_runtime_conformance_fixture() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../fixtures/conformance.json")).unwrap();
    let catalog = SlashCommandCatalog::new(fixture.definitions).unwrap();

    for case in fixture.matching {
        assert_eq!(
            catalog
                .matching(&case.query)
                .iter()
                .map(|command| command.name.clone())
                .collect::<Vec<_>>(),
            case.names
        );
    }
    for case in fixture.inputs {
        let invocation = SlashCommandInput::for_submission(&case.text, &catalog).invocation();
        match case.kind.as_str() {
            "command" => {
                let invocation = invocation.unwrap();
                assert_eq!(Some(invocation.command.name.as_str()), case.name.as_deref());
                assert_eq!(
                    Some(&case.text[invocation.arguments_range]),
                    case.arguments.as_deref()
                );
            }
            "message" | "unknown" => assert!(invocation.is_none()),
            kind => panic!("unsupported fixture input kind {kind}"),
        }
    }
    for definition in fixture.invalid_definitions {
        assert!(SlashCommandCatalog::new([definition]).is_err());
    }
}
