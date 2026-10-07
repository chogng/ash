use crate::BindingPriority;
use crate::BindingSet;
use crate::BindingSource;
use crate::HostPlatform;
use crate::KeyStroke;
use crate::KeybindingResolver;
use crate::LogicalKey;
use crate::Modifiers;
use crate::ResolveResult;
use crate::parse_key_sequence;
use crate::serialize_key_sequence;
use std::collections::HashMap;
use std::collections::HashSet;
use tinyjson::JsonValue;

struct ConformanceFixtures {
    parser: Vec<ParserFixture>,
    resolver: Vec<ResolverFixture>,
}

struct ParserFixture {
    input: String,
    valid: bool,
    canonical: Option<String>,
    chords: Option<usize>,
}

struct ResolverFixture {
    name: String,
    context: Vec<String>,
    events: Vec<EventFixture>,
    rules: Vec<RuleFixture>,
    result: ResolverResultFixture,
}

struct EventFixture {
    key: String,
    control: bool,
    shift: bool,
    alt: bool,
    meta: bool,
}

struct RuleFixture {
    binding: String,
    command: Option<String>,
    block: bool,
    source: SourceFixture,
    priority: i32,
    when: Option<String>,
}

#[derive(Clone, Copy)]
enum SourceFixture {
    Builtin,
    Workbench,
    User,
}

struct ResolverResultFixture {
    kind: String,
    command: Option<String>,
}

#[test]
fn shared_parser_fixtures_match_the_rust_implementation() {
    let fixtures = load_fixtures();
    for fixture in fixtures.parser {
        let parsed = parse_key_sequence(&fixture.input);
        assert_eq!(
            parsed.is_ok(),
            fixture.valid,
            "unexpected validity for {:?}",
            fixture.input
        );
        if let Ok(parsed) = parsed {
            assert_eq!(
                Some(parsed.chords().len()),
                fixture.chords,
                "unexpected chord count for {:?}",
                fixture.input
            );
            assert_eq!(
                Some(serialize_key_sequence(&parsed)),
                fixture.canonical,
                "unexpected canonical form for {:?}",
                fixture.input
            );
        }
    }
}

#[test]
fn shared_resolver_fixtures_match_the_rust_implementation() {
    let fixtures = load_fixtures();
    for fixture in fixtures.resolver {
        let mut bindings = BindingSet::default();
        for rule in fixture.rules {
            let keybinding = parse_key_sequence(&rule.binding)
                .unwrap_or_else(|error| panic!("{} has an invalid binding: {error}", fixture.name));
            let source = match rule.source {
                SourceFixture::Builtin => BindingSource::Builtin,
                SourceFixture::Workbench => BindingSource::Workbench,
                SourceFixture::User => BindingSource::User,
            };
            if rule.block {
                bindings.register_blocker(
                    keybinding,
                    rule.when,
                    source,
                    BindingPriority::new(rule.priority),
                );
            } else {
                bindings.register_command(
                    keybinding,
                    rule.command
                        .unwrap_or_else(|| panic!("{} command rule has no command", fixture.name)),
                    rule.when,
                    source,
                    BindingPriority::new(rule.priority),
                );
            }
        }
        let context = fixture.context.into_iter().collect::<HashSet<_>>();
        let events = fixture
            .events
            .into_iter()
            .map(key_stroke)
            .collect::<Vec<_>>();
        let result = KeybindingResolver::new(&bindings, HostPlatform::Windows).resolve(
            &context,
            &events,
            |when, context| when.as_ref().is_none_or(|key| context.contains(key)),
        );
        let (kind, command) = match result {
            ResolveResult::NoMatch => ("noMatch", None),
            ResolveResult::PendingChord { .. } => ("pending", None),
            ResolveResult::Command { command, .. } => ("command", Some(command)),
            ResolveResult::Blocked { .. } => ("blocked", None),
        };
        assert_eq!(
            kind, fixture.result.kind,
            "unexpected kind for {}",
            fixture.name
        );
        assert_eq!(
            command, fixture.result.command,
            "unexpected command for {}",
            fixture.name
        );
    }
}

fn key_stroke(event: EventFixture) -> KeyStroke {
    let mut modifiers = Modifiers::none();
    if event.control {
        modifiers = modifiers.with_control();
    }
    if event.shift {
        modifiers = modifiers.with_shift();
    }
    if event.alt {
        modifiers = modifiers.with_alt();
    }
    if event.meta {
        modifiers = modifiers.with_meta();
    }
    KeyStroke::new(
        LogicalKey::new(event.key).expect("fixture event key must not be empty"),
        None,
        modifiers,
    )
}

fn load_fixtures() -> ConformanceFixtures {
    let contents = include_str!("../../../resources/keybindings/conformance.json");
    let root = contents
        .parse::<JsonValue>()
        .expect("shared keybinding fixtures must be valid JSON");
    ConformanceFixtures {
        parser: array_field(&root, "parser")
            .iter()
            .map(parser_fixture)
            .collect(),
        resolver: array_field(&root, "resolver")
            .iter()
            .map(resolver_fixture)
            .collect(),
    }
}

fn parser_fixture(value: &JsonValue) -> ParserFixture {
    ParserFixture {
        input: string_field(value, "input"),
        valid: boolean_field(value, "valid").unwrap_or(false),
        canonical: optional_string_field(value, "canonical"),
        chords: optional_integer_field(value, "chords").map(|value| value as usize),
    }
}

fn resolver_fixture(value: &JsonValue) -> ResolverFixture {
    ResolverFixture {
        name: string_field(value, "name"),
        context: optional_array_field(value, "context")
            .unwrap_or_default()
            .iter()
            .map(string_value)
            .collect(),
        events: array_field(value, "events")
            .iter()
            .map(event_fixture)
            .collect(),
        rules: array_field(value, "rules")
            .iter()
            .map(rule_fixture)
            .collect(),
        result: resolver_result_fixture(field(value, "result")),
    }
}

fn event_fixture(value: &JsonValue) -> EventFixture {
    EventFixture {
        key: string_field(value, "key"),
        control: boolean_field(value, "control").unwrap_or(false),
        shift: boolean_field(value, "shift").unwrap_or(false),
        alt: boolean_field(value, "alt").unwrap_or(false),
        meta: boolean_field(value, "meta").unwrap_or(false),
    }
}

fn rule_fixture(value: &JsonValue) -> RuleFixture {
    RuleFixture {
        binding: string_field(value, "binding"),
        command: optional_string_field(value, "command"),
        block: boolean_field(value, "block").unwrap_or(false),
        source: match string_field(value, "source").as_str() {
            "builtin" => SourceFixture::Builtin,
            "workbench" => SourceFixture::Workbench,
            "user" => SourceFixture::User,
            source => panic!("unknown fixture binding source {source:?}"),
        },
        priority: integer_field(value, "priority") as i32,
        when: optional_string_field(value, "when"),
    }
}

fn resolver_result_fixture(value: &JsonValue) -> ResolverResultFixture {
    ResolverResultFixture {
        kind: string_field(value, "kind"),
        command: optional_string_field(value, "command"),
    }
}

fn object(value: &JsonValue) -> &HashMap<String, JsonValue> {
    value.get().expect("fixture value must be an object")
}

fn field<'a>(value: &'a JsonValue, name: &str) -> &'a JsonValue {
    object(value)
        .get(name)
        .unwrap_or_else(|| panic!("fixture object must contain {name:?}"))
}

fn optional_field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a JsonValue> {
    object(value).get(name)
}

fn array_field<'a>(value: &'a JsonValue, name: &str) -> &'a [JsonValue] {
    field(value, name)
        .get::<Vec<JsonValue>>()
        .map(Vec::as_slice)
        .unwrap_or_else(|| panic!("fixture field {name:?} must be an array"))
}

fn optional_array_field<'a>(value: &'a JsonValue, name: &str) -> Option<&'a [JsonValue]> {
    optional_field(value, name).map(|value| {
        value
            .get::<Vec<JsonValue>>()
            .map(Vec::as_slice)
            .unwrap_or_else(|| panic!("fixture field {name:?} must be an array"))
    })
}

fn string_field(value: &JsonValue, name: &str) -> String {
    string_value(field(value, name))
}

fn optional_string_field(value: &JsonValue, name: &str) -> Option<String> {
    optional_field(value, name).map(string_value)
}

fn string_value(value: &JsonValue) -> String {
    value
        .get::<String>()
        .cloned()
        .expect("fixture value must be a string")
}

fn boolean_field(value: &JsonValue, name: &str) -> Option<bool> {
    optional_field(value, name).map(|value| {
        *value
            .get::<bool>()
            .unwrap_or_else(|| panic!("fixture field {name:?} must be a boolean"))
    })
}

fn integer_field(value: &JsonValue, name: &str) -> i64 {
    optional_integer_field(value, name)
        .unwrap_or_else(|| panic!("fixture object must contain integer field {name:?}"))
}

fn optional_integer_field(value: &JsonValue, name: &str) -> Option<i64> {
    optional_field(value, name).map(|value| {
        let number = *value
            .get::<f64>()
            .unwrap_or_else(|| panic!("fixture field {name:?} must be a number"));
        assert!(
            number.fract() == 0.0 && number >= i64::MIN as f64 && number <= i64::MAX as f64,
            "fixture field {name:?} must be an integer",
        );
        number as i64
    })
}
