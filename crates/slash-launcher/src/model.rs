use std::collections::BTreeSet;
use std::fmt;

/// One displayable item supplied by a product-owned Slash Launcher list.
///
/// `id` is opaque to the launcher and must remain stable enough for the product to resolve the
/// selected item back to its own typed action, command, Skill, or other target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashLauncherItem {
    id: String,
    label: String,
    description: String,
    keywords: Vec<String>,
}

impl SlashLauncherItem {
    pub fn new(
        id: impl Into<String>,
        label: impl Into<String>,
        description: impl Into<String>,
    ) -> Result<Self, SlashLauncherError> {
        let id = id.into();
        validate_id("item", &id)?;
        let label = label.into();
        validate_visible_text("item label", &label)?;
        Ok(Self {
            id,
            label,
            description: description.into(),
            keywords: Vec::new(),
        })
    }

    /// Adds searchable aliases without changing the item's visible label or stable identity.
    pub fn with_keywords(
        mut self,
        keywords: impl IntoIterator<Item = impl Into<String>>,
    ) -> Result<Self, SlashLauncherError> {
        for keyword in keywords {
            let keyword = keyword.into();
            validate_visible_text("item keyword", &keyword)?;
            if !self.keywords.contains(&keyword) {
                self.keywords.push(keyword);
            }
        }
        Ok(self)
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn keywords(&self) -> &[String] {
        &self.keywords
    }

    pub(crate) fn matches(&self, query: &str) -> bool {
        query.is_empty()
            || starts_with_case_insensitive(&self.label, query)
            || self
                .keywords
                .iter()
                .any(|keyword| starts_with_case_insensitive(keyword, query))
    }
}

/// One product-selected list in a composed Slash Launcher snapshot.
///
/// Lists may represent Slash Commands, Skills, product actions, or future item kinds. The launcher
/// treats all targets as opaque and preserves the caller's list and item order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashLauncherList {
    id: String,
    title: String,
    items: Vec<SlashLauncherItem>,
}

impl SlashLauncherList {
    pub fn new(
        id: impl Into<String>,
        title: impl Into<String>,
        items: impl IntoIterator<Item = SlashLauncherItem>,
    ) -> Result<Self, SlashLauncherError> {
        let id = id.into();
        validate_id("list", &id)?;
        let title = title.into();
        validate_visible_text("list title", &title)?;
        let items = items.into_iter().collect::<Vec<_>>();
        let mut item_ids = BTreeSet::new();
        for item in &items {
            if !item_ids.insert(item.id()) {
                return Err(SlashLauncherError(format!(
                    "duplicate Slash Launcher item id '{}' in list '{}'",
                    item.id(),
                    id
                )));
            }
        }
        Ok(Self { id, title, items })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn items(&self) -> &[SlashLauncherItem] {
        &self.items
    }
}

/// Validation failure while constructing a Slash Launcher list or snapshot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlashLauncherError(pub String);

impl fmt::Display for SlashLauncherError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SlashLauncherError {}

fn validate_id(kind: &str, value: &str) -> Result<(), SlashLauncherError> {
    if value.is_empty()
        || value.trim() != value
        || value
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err(SlashLauncherError(format!(
            "Slash Launcher {kind} id must be a non-empty opaque token"
        )));
    }
    Ok(())
}

fn validate_visible_text(kind: &str, value: &str) -> Result<(), SlashLauncherError> {
    if value.trim().is_empty() {
        return Err(SlashLauncherError(format!(
            "Slash Launcher {kind} must not be blank"
        )));
    }
    Ok(())
}

fn starts_with_case_insensitive(value: &str, query: &str) -> bool {
    value
        .to_lowercase()
        .starts_with(query.to_lowercase().as_str())
}

#[cfg(test)]
#[path = "model_tests.rs"]
mod tests;
