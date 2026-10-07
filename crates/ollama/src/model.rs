use semver::Version;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OllamaModelDetails {
    pub format: Option<String>,
    pub family: Option<String>,
    pub families: Vec<String>,
    pub parameter_size: Option<String>,
    pub quantization_level: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OllamaModel {
    pub name: String,
    pub size: Option<u64>,
    pub digest: Option<String>,
    pub modified_at: Option<String>,
    pub details: Option<OllamaModelDetails>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OllamaStatus {
    pub version: Version,
    pub models: Vec<OllamaModel>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OllamaModelInfo {
    pub capabilities: Option<Vec<String>>,
}

impl OllamaModelInfo {
    pub fn supports(&self, capability: &str) -> Option<bool> {
        self.capabilities
            .as_ref()
            .map(|capabilities| capabilities.iter().any(|candidate| candidate == capability))
    }
}
