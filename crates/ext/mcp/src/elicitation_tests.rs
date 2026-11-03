use std::collections::BTreeMap;

use ash_protocol::UserInputAnswer;

use super::*;

#[test]
fn form_projection_preserves_exact_field_ids_and_converts_typed_answers() {
    let form = FormRequest::from_schema(
        "Configure the calendar event".into(),
        serde_json::json!({
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "title": "Title",
                    "description": "Event title",
                    "minLength": 1,
                    "maxLength": 80
                },
                "reminders": {
                    "type": "integer",
                    "title": "Reminders",
                    "minimum": 0,
                    "maximum": 5
                },
                "notify": {
                    "type": "boolean",
                    "title": "Notify"
                },
                "visibility": {
                    "type": "string",
                    "title": "Visibility",
                    "oneOf": [
                        {"const": "private", "title": "Private"},
                        {"const": "team", "title": "Team"}
                    ]
                }
            },
            "required": ["title", "reminders", "notify", "visibility"]
        }),
    )
    .unwrap();
    let request = form.request();
    assert_eq!(request.questions.len(), 4);
    assert!(request.questions.iter().all(|question| question.required));
    assert_eq!(request.questions[0].id, "notify");
    assert_eq!(request.questions[0].options[0].label, "true");
    let content = form
        .parse_answers(BTreeMap::from([
            (
                "title".into(),
                UserInputAnswer {
                    value: "Planning".into(),
                },
            ),
            ("reminders".into(), UserInputAnswer { value: "2".into() }),
            (
                "notify".into(),
                UserInputAnswer {
                    value: "true".into(),
                },
            ),
            (
                "visibility".into(),
                UserInputAnswer {
                    value: "team".into(),
                },
            ),
        ]))
        .unwrap();
    assert_eq!(
        Value::Object(content),
        serde_json::json!({
            "title": "Planning",
            "reminders": 2,
            "notify": true,
            "visibility": "team"
        })
    );
}

#[test]
fn optional_form_fields_preserve_absence_empty_values_and_explicit_false() {
    let form = FormRequest::from_schema(
        "Configure an event".into(),
        serde_json::json!({
            "type": "object",
            "properties": {
                "name": {"type": "string", "minLength": 1},
                "note": {"type": "string", "minLength": 2},
                "visibility": {"type": "string", "enum": ["private", "team"]},
                "notify": {"type": "boolean"}
            },
            "required": ["name"]
        }),
    )
    .unwrap();
    for question in &form.request().questions {
        assert_eq!(question.required, question.id == "name");
    }
    let mut answers = BTreeMap::from([(
        "name".into(),
        UserInputAnswer {
            value: "Planning".into(),
        },
    )]);
    assert_eq!(
        Value::Object(form.parse_answers(answers.clone()).unwrap()),
        serde_json::json!({"name": "Planning"})
    );
    for id in ["note", "visibility", "notify"] {
        answers.insert(
            id.into(),
            UserInputAnswer {
                value: String::new(),
            },
        );
    }
    assert_eq!(
        Value::Object(form.parse_answers(answers.clone()).unwrap()),
        serde_json::json!({"name": "Planning"})
    );
    answers.get_mut("notify").unwrap().value = "false".into();
    assert_eq!(
        Value::Object(form.parse_answers(answers.clone()).unwrap()),
        serde_json::json!({"name": "Planning", "notify": false})
    );
    answers.get_mut("visibility").unwrap().value = "unknown".into();
    assert!(form.parse_answers(answers).is_err());
    assert!(form.parse_answers(BTreeMap::new()).is_err());
}

#[test]
fn form_projection_rejects_sensitive_fields_and_invalid_typed_answers() {
    assert!(
        FormRequest::from_schema(
            "Authenticate".into(),
            serde_json::json!({
                "type": "object",
                "properties": {"api_token": {"type": "string"}},
                "required": ["api_token"]
            }),
        )
        .is_err()
    );

    let form = FormRequest::from_schema(
        "Choose a count".into(),
        serde_json::json!({
            "type": "object",
            "properties": {"count": {"type": "integer", "minimum": 1, "maximum": 3}},
            "required": ["count"]
        }),
    )
    .unwrap();
    assert!(
        form.parse_answers(BTreeMap::from([(
            "count".into(),
            UserInputAnswer { value: "4".into() }
        )]))
        .is_err()
    );
}
