use thiserror::Error;
use url::Url;

/// Link schemes that a product explicitly permits Markdown to activate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MarkdownLinkScheme {
    Https,
    Http,
    Mailto,
}

/// URL policy applied after hit testing and before any host-side external open.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarkdownLinkPolicy {
    schemes: Vec<MarkdownLinkScheme>,
}

impl MarkdownLinkPolicy {
    /// Creates the safe default: HTTPS links only.
    pub fn safe_default() -> Self {
        Self {
            schemes: vec![MarkdownLinkScheme::Https],
        }
    }

    pub fn allow(mut self, scheme: MarkdownLinkScheme) -> Self {
        if !self.schemes.contains(&scheme) {
            self.schemes.push(scheme);
        }
        self
    }

    pub fn evaluate(&self, destination: &str) -> Result<MarkdownLinkTarget, MarkdownLinkError> {
        if let Some(fragment) = destination.strip_prefix('#') {
            if fragment.is_empty() || fragment.chars().any(char::is_control) {
                return Err(MarkdownLinkError::InvalidFragment);
            }
            return Ok(MarkdownLinkTarget {
                url: None,
                fragment: Some(fragment.to_owned()),
            });
        }
        let url = Url::parse(destination).map_err(|_| MarkdownLinkError::InvalidUrl)?;
        if !url.username().is_empty() || url.password().is_some() {
            return Err(MarkdownLinkError::CredentialsNotAllowed);
        }
        let scheme = match url.scheme() {
            "https" => MarkdownLinkScheme::Https,
            "http" => MarkdownLinkScheme::Http,
            "mailto" => MarkdownLinkScheme::Mailto,
            other => return Err(MarkdownLinkError::UnsupportedScheme(other.to_owned())),
        };
        if !self.schemes.contains(&scheme) {
            return Err(MarkdownLinkError::SchemeDenied(scheme));
        }
        Ok(MarkdownLinkTarget {
            url: Some(url),
            fragment: None,
        })
    }
}

impl Default for MarkdownLinkPolicy {
    fn default() -> Self {
        Self::safe_default()
    }
}

/// Validated URL that the host may pass to its platform URL opener.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarkdownLinkTarget {
    url: Option<Url>,
    fragment: Option<String>,
}

impl MarkdownLinkTarget {
    pub fn url(&self) -> Option<&Url> {
        self.url.as_ref()
    }

    pub fn fragment(&self) -> Option<&str> {
        self.fragment.as_deref()
    }
}

#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum MarkdownLinkError {
    #[error("link is not an absolute URL")]
    InvalidUrl,
    #[error("document fragment is empty or contains control characters")]
    InvalidFragment,
    #[error("link contains embedded credentials")]
    CredentialsNotAllowed,
    #[error("link scheme {0} is unsupported")]
    UnsupportedScheme(String),
    #[error("link scheme {0:?} is denied by policy")]
    SchemeDenied(MarkdownLinkScheme),
}
