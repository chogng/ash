use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use serde_json::Value;

const STATUS_LINE_KEY: &str = "statusLine";
const SHOW_GIT_CHANGES_AS_DIFF_KEY: &str = "showGitChangesAsDiff";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum StatusLineItem {
    Permissions,
    Model,
    CacheHitRate,
    ReferenceCost,
    Memory,
    Cpu,
    GitBranch,
    GitChanges,
    Context,
}

impl StatusLineItem {
    pub(crate) const ALL: [Self; 9] = [
        Self::Permissions,
        Self::Model,
        Self::CacheHitRate,
        Self::ReferenceCost,
        Self::Memory,
        Self::Cpu,
        Self::GitBranch,
        Self::GitChanges,
        Self::Context,
    ];

    pub(crate) fn from_id(id: &str) -> Option<Self> {
        match id {
            "context" => Some(Self::Context),
            "permissions" => Some(Self::Permissions),
            "model" => Some(Self::Model),
            "cache-hit-rate" => Some(Self::CacheHitRate),
            "reference-cost" => Some(Self::ReferenceCost),
            "memory" => Some(Self::Memory),
            "cpu" => Some(Self::Cpu),
            "git-branch" => Some(Self::GitBranch),
            "git-changes" => Some(Self::GitChanges),
            _ => None,
        }
    }

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::Context => "context",
            Self::Permissions => "permissions",
            Self::Model => "model",
            Self::CacheHitRate => "cache-hit-rate",
            Self::ReferenceCost => "reference-cost",
            Self::Memory => "memory",
            Self::Cpu => "cpu",
            Self::GitBranch => "git-branch",
            Self::GitChanges => "git-changes",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Context => "Context",
            Self::Permissions => "Permissions",
            Self::Model => "Model",
            Self::CacheHitRate => "Cache hit rate",
            Self::ReferenceCost => "Reference cost",
            Self::Memory => "Memory",
            Self::Cpu => "CPU",
            Self::GitBranch => "Git branch",
            Self::GitChanges => "Git changes",
        }
    }

    pub(crate) fn description(self) -> &'static str {
        match self {
            Self::Context => "Current Thread context usage",
            Self::Permissions => "Current permission mode",
            Self::Model => "Configured model",
            Self::CacheHitRate => "Cached input as a share of total input",
            Self::ReferenceCost => "Current Thread accumulated reference cost",
            Self::Memory => "Local TUI, App Server, and child-process resident memory",
            Self::Cpu => "Local TUI, App Server, and child-process CPU share",
            Self::GitBranch => "Current Git branch",
            Self::GitChanges => "Working tree changes",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) enum StatusLineStyle {
    #[default]
    Compact,
    Rich,
}

impl StatusLineStyle {
    pub(crate) const fn next(self) -> Self {
        match self {
            Self::Compact => Self::Rich,
            Self::Rich => Self::Compact,
        }
    }

    pub(crate) const fn id(self) -> &'static str {
        match self {
            Self::Compact => "compact",
            Self::Rich => "rich",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StatusLineSettings {
    items: Vec<StatusLineItem>,
    style: StatusLineStyle,
    show_git_changes_as_diff: bool,
}

impl StatusLineSettings {
    pub(crate) fn from_tui(section: &FrontendConfigDto) -> Result<Self, String> {
        let mut settings = Self::default();
        if let Some(value) = section.0.get(STATUS_LINE_KEY) {
            let values = value.as_array().ok_or_else(|| {
                "invalid [tui].statusLine: expected an array of item names".to_owned()
            })?;
            let mut items = Vec::with_capacity(values.len());
            for value in values {
                let id = value.as_str().ok_or_else(|| {
                    "invalid [tui].statusLine: every item name must be a string".to_owned()
                })?;
                let item = StatusLineItem::from_id(id)
                    .ok_or_else(|| format!("invalid [tui].statusLine item `{id}`"))?;
                if items.contains(&item) {
                    return Err(format!("invalid [tui].statusLine: duplicate item `{id}`"));
                }
                items.push(item);
            }
            settings.items = items;
        }
        if let Some(value) = section.0.get(SHOW_GIT_CHANGES_AS_DIFF_KEY) {
            settings.show_git_changes_as_diff = value.as_bool().ok_or_else(|| {
                "invalid [tui].showGitChangesAsDiff: expected a boolean".to_owned()
            })?;
        }
        if let Some(value) = section.0.get("statusLineStyle") {
            settings.style = match value.as_str() {
                Some("compact") => StatusLineStyle::Compact,
                Some("rich") => StatusLineStyle::Rich,
                _ => return Err("invalid [tui].statusLineStyle: expected compact or rich".into()),
            };
        }
        Ok(settings)
    }

    pub(crate) fn write_to_tui(&self, section: &FrontendConfigDto) -> FrontendConfigDto {
        let mut values = section.0.clone();
        values.insert(
            STATUS_LINE_KEY.into(),
            Value::Array(
                self.items
                    .iter()
                    .map(|item| Value::String(item.id().into()))
                    .collect(),
            ),
        );
        values.insert(
            SHOW_GIT_CHANGES_AS_DIFF_KEY.into(),
            Value::Bool(self.show_git_changes_as_diff),
        );
        values.insert(
            "statusLineStyle".into(),
            Value::String(self.style.id().into()),
        );
        FrontendConfigDto(values)
    }

    pub(crate) const fn style(&self) -> StatusLineStyle {
        self.style
    }

    pub(crate) fn set_style(&mut self, style: StatusLineStyle) {
        self.style = style;
    }

    pub(crate) fn enabled(&self, item: StatusLineItem) -> bool {
        self.items.contains(&item)
    }

    pub(crate) fn items(&self) -> impl Iterator<Item = StatusLineItem> + '_ {
        self.items.iter().copied()
    }

    pub(crate) fn set(&mut self, item: StatusLineItem, enabled: bool) {
        if enabled {
            if !self.items.contains(&item) {
                self.items.push(item);
            }
        } else {
            self.items.retain(|candidate| *candidate != item);
        }
    }

    pub(crate) const fn show_git_changes_as_diff(&self) -> bool {
        self.show_git_changes_as_diff
    }

    pub(crate) fn set_show_git_changes_as_diff(&mut self, show: bool) {
        self.show_git_changes_as_diff = show;
    }
}

impl Default for StatusLineSettings {
    fn default() -> Self {
        Self {
            items: vec![
                StatusLineItem::Permissions,
                StatusLineItem::Model,
                StatusLineItem::GitBranch,
                StatusLineItem::GitChanges,
            ],
            show_git_changes_as_diff: false,
            style: StatusLineStyle::default(),
        }
    }
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
