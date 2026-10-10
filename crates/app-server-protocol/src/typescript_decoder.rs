use serde_json::Map;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::PathBuf;

pub(crate) fn generate(schema: &Value) -> Vec<(PathBuf, String)> {
    // The decoder validates named definitions, never the exported schema's aggregate root.
    let mut runtime_schema = serde_json::json!({ "$defs": schema["$defs"] });
    retain_decoder_definitions(&mut runtime_schema, DECODER_ROOTS);
    remove_annotations(&mut runtime_schema);
    // Growing extension contracts must not duplicate identical validation definitions in
    // the renderer's bounded chunk. Public schema names and wire validation stay unchanged.
    runtime_schema.sort_all_objects();
    deduplicate_definitions(&mut runtime_schema, DECODER_ROOTS);
    share_inline_schemas(&mut runtime_schema);
    compact_definition_names(&mut runtime_schema, DECODER_ROOTS);
    // With preserve_order, removing annotations can swap the remaining object keys.
    runtime_schema.sort_all_objects();
    // Keep validation data in separate modules so the renderer can split growing contracts
    // without changing validation or putting the complete schema in one bounded chunk.
    let definitions = runtime_schema["$defs"].as_object().unwrap();
    let shards = schema_shards(definitions, 200_000);
    let mut files = Vec::new();
    let mut imports = String::new();
    let mut spreads = Vec::new();
    for (index, literal) in shards.into_iter().enumerate() {
        let name = format!("AppServerProtocolSchema{index}");
        imports.push_str(&format!(
            "import {{ definitions as definitions{index} }} from './{name}.js';\n"
        ));
        spreads.push(format!(
            "...definitions{index} as Readonly<Record<string, JsonSchema>>"
        ));
        files.push((
            PathBuf::from(format!("{name}.ts")),
            format!(
                "{}export const definitions: unknown = JSON.parse({literal});\n",
                crate::export::GENERATED_TYPESCRIPT_HEADER
            ),
        ));
    }
    files.push((
        PathBuf::from("AppServerProtocolDecoder.ts"),
        include_str!("typescript_decoder.template.ts")
            .replace("__SCHEMA_IMPORTS__", &imports)
            .replace("__SCHEMA_DEFINITIONS__", &spreads.join(", "))
            .replace("\r\n", "\n"),
    ));
    files
}

/// Bound the encoded source, including JSON string escaping. Each definition stays intact
/// so cross-module references continue to resolve through the decoder's single definition map.
fn schema_shards(definitions: &Map<String, Value>, max_bytes: usize) -> Vec<String> {
    let mut shards = Vec::new();
    let mut entries = Vec::new();
    let mut bytes = 4; // Encoded empty object: "{}".
    for (name, definition) in definitions {
        let entry = format!(
            "{}:{}",
            serde_json::to_string(name).unwrap(),
            serde_json::to_string(definition).unwrap()
        );
        let encoded_bytes = serde_json::to_string(&entry).unwrap().len() - 2;
        assert!(
            encoded_bytes + 4 <= max_bytes,
            "decoder definition {name} exceeds its module budget"
        );
        let separator = usize::from(!entries.is_empty());
        if bytes + separator + encoded_bytes > max_bytes {
            shards.push(serde_json::to_string(&format!("{{{}}}", entries.join(","))).unwrap());
            entries.clear();
            bytes = 4;
        }
        bytes += usize::from(!entries.is_empty()) + encoded_bytes;
        entries.push(entry);
    }
    if !entries.is_empty() {
        shards.push(serde_json::to_string(&format!("{{{}}}", entries.join(","))).unwrap());
    }
    shards
}

/// Documentation remains in the exported schema; decoding only ships validation data.
/// Visit schema positions explicitly: a payload property or enum value named `description`
/// is application data and must never be removed by a recursive object-key filter.
fn remove_annotations(schema: &mut Value) {
    visit_schema(schema, &mut |object| {
        // The runtime decoder validates numeric bounds and string patterns, but does not
        // interpret JSON Schema format annotations (for example uint64 or uuid).
        for annotation in [
            "description",
            "title",
            "$comment",
            "examples",
            "default",
            "format",
        ] {
            object.remove(annotation);
        }
    });
}

const DECODER_ROOTS: &[&str] = &[
    "AppServerListenInfo",
    "ClientRequestSchema",
    "ClientResultSchema",
    "ServerNotificationSchema",
    "HostRequestSchema",
    "HostResultSchema",
    "AppServerError",
    "JsonRpcError",
];

fn deduplicate_definitions(schema: &mut Value, roots: &[&str]) {
    let definitions = schema["$defs"]
        .as_object()
        .expect("decoder schema must contain definitions");
    let mut names: Vec<_> = definitions.keys().cloned().collect();
    // Preserve every public entry point, preferring it over an identical internal definition.
    names.sort_by_key(|name| (!roots.contains(&name.as_str()), name.clone()));
    let mut canonical: BTreeMap<String, String> = BTreeMap::new();
    let mut aliases: BTreeMap<String, String> = BTreeMap::new();
    for name in names {
        let fingerprint =
            serde_json::to_string(&definitions[&name]).expect("schema definition must serialize");
        if let Some(previous) = canonical.get(&fingerprint) {
            if !roots.contains(&name.as_str()) {
                aliases.insert(name, previous.clone());
            }
        } else {
            canonical.insert(fingerprint, name);
        }
    }
    visit_schema(schema, &mut |object| {
        if let Some(reference) = object.get_mut("$ref")
            && let Some(target) = reference
                .as_str()
                .and_then(|reference| reference.strip_prefix("#/$defs/"))
            && let Some(canonical) = aliases.get(target)
        {
            *reference = Value::String(format!("#/$defs/{canonical}"));
        }
    });
    schema["$defs"]
        .as_object_mut()
        .expect("decoder schema must contain definitions")
        .retain(|name, _| !aliases.contains_key(name));
}

/// Factor repeated validation subtrees, including inline result fields. Dispatch envelopes
/// stay inline because the decoder indexes their method property before validation.
fn share_inline_schemas(schema: &mut Value) {
    let mut counts = BTreeMap::<String, usize>::new();
    visit_schema(schema, &mut |object| {
        if object
            .get("properties")
            .and_then(Value::as_object)
            .is_some_and(|properties| properties.contains_key("method"))
        {
            return;
        }
        let fingerprint = serde_json::to_string(object).expect("schema object must serialize");
        // A local reference and its definition must save bytes even with only two uses.
        if fingerprint.len() >= 120 {
            *counts.entry(fingerprint).or_default() += 1;
        }
    });
    let factors: BTreeMap<String, String> = counts
        .into_iter()
        .filter(|(_, count)| *count > 1)
        .enumerate()
        .map(|(index, (fingerprint, _))| (fingerprint, format!("shared{index}")))
        .collect();
    let rewrite = |object: &mut Map<String, Value>| {
        let fingerprint = serde_json::to_string(object).expect("schema object must serialize");
        if let Some(name) = factors.get(&fingerprint) {
            object.clear();
            object.insert("$ref".into(), Value::String(format!("#/$defs/{name}")));
        }
    };
    let mut definitions = Map::new();
    for (fingerprint, name) in &factors {
        let mut definition: Value =
            serde_json::from_str(fingerprint).expect("schema fingerprint must parse");
        let mut root = true;
        visit_schema(&mut definition, &mut |object| {
            if root {
                root = false;
            } else {
                rewrite(object);
            }
        });
        definitions.insert(name.clone(), definition);
    }
    visit_schema(schema, &mut |object| rewrite(object));
    schema["$defs"]
        .as_object_mut()
        .expect("decoder definitions must exist")
        .extend(definitions);
}

/// Only decoder entry points need public names; internal references never enter the wire contract.
/// Rewrite schema references, not payload keys or literal values that happen to contain `$ref`.
fn compact_definition_names(schema: &mut Value, roots: &[&str]) {
    let mut names: Vec<String> = schema["$defs"]
        .as_object()
        .expect("decoder schema must contain definitions")
        .keys()
        .cloned()
        .collect();
    names.sort();
    let aliases: BTreeMap<String, String> = names
        .into_iter()
        .enumerate()
        .map(|(index, name)| {
            let alias = if roots.contains(&name.as_str()) {
                name.clone()
            } else {
                index.to_string()
            };
            (name, alias)
        })
        .collect();
    visit_schema(schema, &mut |object| {
        if let Some(reference) = object.get_mut("$ref") {
            let target = reference
                .as_str()
                .and_then(|value| value.strip_prefix("#/$defs/"))
                .expect("decoder schema references must use local definitions");
            let alias = aliases
                .get(target)
                .expect("decoder schema reference must resolve to a definition");
            *reference = Value::String(format!("#/$defs/{alias}"));
        }
    });
    let definitions = schema["$defs"]
        .as_object_mut()
        .expect("decoder schema must contain definitions");
    for (name, definition) in std::mem::take(definitions) {
        definitions.insert(aliases[&name].clone(), definition);
    }
}

/// Keep the transitive reference closure of the decoder entry points, including cycles.
fn retain_decoder_definitions(schema: &mut Value, roots: &[&str]) {
    let definitions = schema["$defs"]
        .as_object_mut()
        .expect("protocol schema must contain definitions");
    let mut retained = BTreeSet::new();
    let mut pending: Vec<String> = roots.iter().map(|name| (*name).to_owned()).collect();
    while let Some(name) = pending.pop() {
        if !retained.insert(name.clone()) {
            continue;
        }
        let definition = definitions
            .get_mut(&name)
            .expect("decoder schema reference must resolve to a definition");
        visit_schema(definition, &mut |object| {
            if let Some(reference) = object.get("$ref").and_then(Value::as_str) {
                let target = reference
                    .strip_prefix("#/$defs/")
                    .expect("decoder schema references must use local definitions");
                pending.push(target.to_owned());
            }
        });
    }
    definitions.retain(|name, _| retained.contains(name));
}

// Only schema positions are traversed: const/enum payloads may contain literal $ref keys.
fn visit_schema(schema: &mut Value, visitor: &mut impl FnMut(&mut Map<String, Value>)) {
    let Some(object) = schema.as_object_mut() else {
        return;
    };
    visitor(object);
    for keyword in [
        "$defs",
        "definitions",
        "properties",
        "patternProperties",
        "dependentSchemas",
    ] {
        if let Some(children) = object.get_mut(keyword).and_then(Value::as_object_mut) {
            for child in children.values_mut() {
                visit_schema(child, visitor);
            }
        }
    }
    for keyword in ["oneOf", "anyOf", "allOf", "prefixItems"] {
        if let Some(children) = object.get_mut(keyword).and_then(Value::as_array_mut) {
            for child in children {
                visit_schema(child, visitor);
            }
        }
    }
    for keyword in [
        "items",
        "additionalProperties",
        "unevaluatedProperties",
        "contains",
        "not",
        "propertyNames",
        "if",
        "then",
        "else",
    ] {
        if let Some(child) = object.get_mut(keyword) {
            visit_schema(child, visitor);
        }
    }
}

#[cfg(test)]
#[path = "typescript_decoder_tests.rs"]
mod tests;
