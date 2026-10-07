//! Profile preference for the Session dashboard; focus and collapsed groups remain runtime state.

use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use serde::Deserialize;
use serde::Serialize;

pub(crate) const GROUPING_KEY: &str = "sessionGrouping";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SessionGrouping {
    Project,
    #[default]
    Status,
    Model,
}

impl SessionGrouping {
    pub(crate) fn from_tui(section: &FrontendConfigDto) -> Result<Self, String> {
        match section.0.get(GROUPING_KEY) {
            None => Ok(Self::default()),
            Some(value) => serde_json::from_value(value.clone()).map_err(|_| {
                "Invalid [tui].sessionGrouping: expected project, status, or model.".into()
            }),
        }
    }

    pub(crate) const fn next(self) -> Self {
        match self {
            Self::Project => Self::Status,
            Self::Status => Self::Model,
            Self::Model => Self::Project,
        }
    }

    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::Project => "Project",
            Self::Status => "Status",
            Self::Model => "Model",
        }
    }
}
