use crate::ToolBindingId;
use crate::ToolDefinitionDigest;
use crate::ToolExposure;
use crate::ToolInvocationKind;
use crate::ToolPayload;
use crate::ToolRegistrySnapshot;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;

/// Model-visible identifier used only inside one code-mode tool projection.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CodeModeToolName(String);

impl CodeModeToolName {
    /// Maps a callable tool name to a safe JavaScript property name.
    pub fn from_tool_name(name: &str) -> Result<Self, CodeModeProjectionError> {
        let name = normalize_code_name(name);
        if matches!(
            name.as_str(),
            "__proto__" | "prototype" | "constructor" | "exec" | "wait"
        ) {
            return Err(CodeModeProjectionError(format!(
                "reserved Code Mode tool name: {}",
                name.as_str()
            )));
        }
        Ok(name)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Pure code-mode definition projected from one ordinary callable tool.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeModeToolDefinition {
    pub name: CodeModeToolName,
    pub description: String,
    pub input_schema: Value,
}

/// Exact mapping used to route a code-mode name back to one frozen ordinary tool binding.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeModeToolBinding {
    pub code_name: CodeModeToolName,
    pub binding_id: ToolBindingId,
    pub definition_digest: ToolDefinitionDigest,
    pub definition: CodeModeToolDefinition,
}

/// Deterministic, collision-checked code-mode view over one frozen registry generation.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeModeProjection {
    registry_generation: u64,
    bindings: Vec<CodeModeToolBinding>,
    by_code_name: BTreeMap<CodeModeToolName, usize>,
}

impl CodeModeProjection {
    pub fn from_registry(registry: &ToolRegistrySnapshot) -> Result<Self, CodeModeProjectionError> {
        let mut bindings = registry
            .entries()
            .iter()
            .filter(|entry| {
                matches!(
                    entry.exposure(),
                    ToolExposure::Direct | ToolExposure::Deferred
                )
            })
            .filter_map(|entry| {
                let ToolInvocationKind::Function { input_schema } = entry.definition().invocation()
                else {
                    return None;
                };
                let code_name = normalize_code_name(entry.definition().name().as_str());
                let definition = CodeModeToolDefinition {
                    name: code_name.clone(),
                    description: format!(
                        "{}\nCode mode: await tools.{}(<arguments>)",
                        entry.definition().description(),
                        code_name.as_str()
                    ),
                    input_schema: input_schema.as_value().clone(),
                };
                Some(CodeModeToolBinding {
                    code_name,
                    binding_id: entry.binding().id().clone(),
                    definition_digest: entry.binding().definition_digest().clone(),
                    definition,
                })
            })
            .collect::<Vec<_>>();
        for binding in &bindings {
            CodeModeToolName::from_tool_name(binding.code_name.as_str())?;
        }
        bindings.sort_by(|left, right| left.code_name.cmp(&right.code_name));
        if let Some(window) = bindings
            .windows(2)
            .find(|window| window[0].code_name == window[1].code_name)
        {
            return Err(CodeModeProjectionError(format!(
                "code-mode name collision for '{}'",
                window[0].code_name.as_str()
            )));
        }
        let by_code_name = bindings
            .iter()
            .enumerate()
            .map(|(index, binding)| (binding.code_name.clone(), index))
            .collect();
        Ok(Self {
            registry_generation: registry.generation().get(),
            bindings,
            by_code_name,
        })
    }

    pub fn registry_generation(&self) -> u64 {
        self.registry_generation
    }

    pub fn bindings(&self) -> &[CodeModeToolBinding] {
        &self.bindings
    }

    pub fn resolve(&self, name: &CodeModeToolName) -> Option<&CodeModeToolBinding> {
        self.by_code_name
            .get(name)
            .map(|index| &self.bindings[*index])
    }
}

/// One nested code-mode request before Core gives it a durable Tool Call identity.
#[derive(Clone, Debug, PartialEq)]
pub struct CodeModeNestedCall {
    pub code_name: CodeModeToolName,
    pub arguments: Value,
}

impl CodeModeNestedCall {
    pub fn payload(&self) -> ToolPayload {
        ToolPayload::FunctionArguments(self.arguments.clone())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CodeModeProjectionError(String);

impl fmt::Display for CodeModeProjectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for CodeModeProjectionError {}

fn normalize_code_name(name: &str) -> CodeModeToolName {
    let mut normalized = String::with_capacity(name.len());
    for character in name.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            normalized.push(character.to_ascii_lowercase());
        } else {
            normalized.push_str("__");
        }
    }
    CodeModeToolName(normalized)
}

#[cfg(test)]
#[path = "code_mode_tests.rs"]
mod tests;
