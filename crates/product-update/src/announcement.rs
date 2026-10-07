use crate::UpdateError;
use crate::UpdateProduct;
use chrono::NaiveDate;
use semver::Version;
use semver::VersionReq;
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::time::Duration;

/// Publisher-authored plain text, keyed by the exact UI locale (for example `zh-CN`).
/// A missing locale means the announcement is not displayed in that language.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Announcement(BTreeMap<String, String>);

impl Announcement {
    pub fn text(&self, locale: &str) -> Option<&str> {
        self.0.get(locale).map(String::as_str)
    }
}

/// The installed client identity; remote sessions still use the local client's version and OS.
pub struct AnnouncementContext<'a> {
    pub product: UpdateProduct,
    pub version: &'a Version,
    pub os: &'a str,
    pub date: NaiveDate,
}

/// Validated remote announcement rules in publishing order.
pub struct AnnouncementDocument(Vec<Rule>);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    announcements: Vec<RawRule>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRule {
    content: BTreeMap<String, String>,
    target_app: UpdateProduct,
    version_requirement: Option<String>,
    from_date: Option<String>,
    to_date: Option<String>,
    target_oses: Option<Vec<String>>,
}

struct Rule {
    content: Announcement,
    product: UpdateProduct,
    versions: Option<VersionReq>,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    oses: Option<Vec<String>>,
}

impl AnnouncementDocument {
    /// Fetches at most 64 KiB within two seconds. HTTP is allowed only for loopback feeds.
    pub fn fetch(endpoint: &str) -> Result<Self, UpdateError> {
        let url = url::Url::parse(endpoint)
            .map_err(|error| UpdateError::new(format!("invalid announcement URL: {error}")))?;
        let loopback = match url.host() {
            Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
            Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
            Some(url::Host::Domain(_)) | None => false,
        };
        if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(UpdateError::new(
                "announcement URL must be credential-free HTTPS or loopback HTTP",
            ));
        }
        let response = ureq::AgentBuilder::new()
            .redirects(0)
            .build()
            .get(endpoint)
            .set("User-Agent", "Ash-Announcements")
            .timeout(Duration::from_secs(2))
            .call()
            .map_err(|error| UpdateError::new(format!("could not fetch announcements: {error}")))?;
        let mut bytes = Vec::new();
        response
            .into_reader()
            .take(64 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| UpdateError::new(format!("could not read announcements: {error}")))?;
        if bytes.len() > 64 * 1024 {
            return Err(UpdateError::new("announcement document exceeds 64 KiB"));
        }
        let text = std::str::from_utf8(&bytes).map_err(|error| {
            UpdateError::new(format!("announcement document is not UTF-8: {error}"))
        })?;
        Self::parse(text)
    }

    /// Rejects the whole document on invalid rules, including terminal control characters.
    pub fn parse(text: &str) -> Result<Self, UpdateError> {
        if text.len() > 64 * 1024 {
            return Err(UpdateError::new("announcement document exceeds 64 KiB"));
        }
        let raw: Document = toml::from_str(text)
            .map_err(|error| UpdateError::new(format!("invalid announcement document: {error}")))?;
        raw.announcements
            .into_iter()
            .map(Rule::parse)
            .collect::<Result<Vec<_>, _>>()
            .map(Self)
    }

    /// The last eligible entry wins. Dates are UTC, start-inclusive and end-exclusive.
    pub fn select(&self, context: &AnnouncementContext<'_>) -> Option<Announcement> {
        self.0
            .iter()
            .rev()
            .find(|rule| {
                rule.product == context.product
                    && rule
                        .versions
                        .as_ref()
                        .is_none_or(|versions| versions.matches(context.version))
                    && rule.from.is_none_or(|from| context.date >= from)
                    && rule.to.is_none_or(|to| context.date < to)
                    && rule
                        .oses
                        .as_ref()
                        .is_none_or(|oses| oses.iter().any(|os| os == context.os))
            })
            .map(|rule| rule.content.clone())
    }
}

impl Rule {
    fn parse(raw: RawRule) -> Result<Self, UpdateError> {
        if raw.content.is_empty()
            || raw.content.iter().any(|(locale, text)| {
                locale.is_empty()
                    || text.trim().is_empty()
                    || text.chars().count() > 1024
                    || text.chars().any(|ch| ch.is_control() && ch != '\n')
            })
        {
            return Err(UpdateError::new(
                "announcement content must have nonempty locales and plain text of at most 1024 characters",
            ));
        }
        let date = |value: String| {
            let date = NaiveDate::parse_from_str(&value, "%Y-%m-%d")
                .map_err(|error| UpdateError::new(format!("invalid announcement date: {error}")))?;
            if date.to_string() != value {
                return Err(UpdateError::new("announcement date must use YYYY-MM-DD"));
            }
            Ok(date)
        };
        let from = raw.from_date.map(date).transpose()?;
        let to = raw.to_date.map(date).transpose()?;
        if matches!((from, to), (Some(from), Some(to)) if from >= to) {
            return Err(UpdateError::new(
                "announcement end date must follow its start date",
            ));
        }
        if raw.target_oses.as_ref().is_some_and(|oses| {
            oses.is_empty()
                || oses
                    .iter()
                    .any(|os| !matches!(os.as_str(), "macos" | "linux" | "windows"))
        }) {
            return Err(UpdateError::new(
                "announcement target OS must be macos, linux or windows",
            ));
        }
        Ok(Self {
            content: Announcement(raw.content),
            product: raw.target_app,
            versions: raw
                .version_requirement
                .map(|value| {
                    VersionReq::parse(&value).map_err(|error| {
                        UpdateError::new(format!("invalid announcement version range: {error}"))
                    })
                })
                .transpose()?,
            from,
            to,
            oses: raw.target_oses,
        })
    }
}

#[cfg(test)]
#[path = "announcement_tests.rs"]
mod tests;
