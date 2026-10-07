//! Exact provider, connection, and model identities.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use serde::Deserializer;
use std::fmt;

macro_rules! model_identifier {
    ($name:ident, $label:literal) => {
        #[derive(Clone, Debug, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, InvalidModelIdentity> {
                let value = value.into();
                if value.trim().is_empty() {
                    return Err(InvalidModelIdentity(
                        concat!($label, " must not be empty").into(),
                    ));
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: Deserializer<'de>,
            {
                Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
            }
        }
    };
}

model_identifier!(ProviderId, "provider ID");
model_identifier!(ModelId, "model ID");
model_identifier!(ModelConnectionId, "model connection ID");

#[derive(Clone, Debug, Deserialize, Eq, Hash, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider: ProviderId,
    pub model: ModelId,
}

impl ModelRef {
    pub fn new(provider: ProviderId, model: ModelId) -> Self {
        Self { provider, model }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidModelIdentity(pub String);

impl fmt::Display for InvalidModelIdentity {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for InvalidModelIdentity {}
