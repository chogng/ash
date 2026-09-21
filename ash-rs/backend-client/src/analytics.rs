use crate::BackendClient;
use crate::RequestError;
use crate::analytics_types::CreditUsageEventsResponse;
use crate::analytics_types::CurrentUserCreditUsageResponse;
use crate::analytics_types::DailyProductSurfaceUsageResponse;
use crate::analytics_types::DailySkillUsageMetricsResponse;
use crate::analytics_types::DailyWorkspaceUsageCountResponse;
use crate::analytics_types::PluginUsageMetricsResponse;
use async_utils::CancellationToken;
use serde::Deserialize;

/// Endpoint-specific account reports; dates are inclusive UTC dates supplied by the caller.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AnalyticsReport<'a> {
    Usage,
    EnterpriseTokens,
    Credits,
    WorkspaceCredits,
    EnterpriseCredits { breakdown: &'a str },
    Messages,
    Plugins { limit: u8 },
    Skills { limit: u8 },
}

#[derive(Clone, Debug, PartialEq)]
pub enum AnalyticsResponse {
    Usage(DailyProductSurfaceUsageResponse),
    Credits(CreditUsageEventsResponse),
    EnterpriseCredits(CurrentUserCreditUsageResponse),
    Messages(DailyWorkspaceUsageCountResponse),
    Plugins(PluginUsageMetricsResponse),
    Skills(DailySkillUsageMetricsResponse),
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct PlanLimitHistory {
    pub data_as_of: Option<String>,
    pub coverage_start: Option<String>,
    pub coverage_complete: bool,
    pub approximate: Option<bool>,
    pub boundary_tolerance_seconds: Option<u32>,
    pub periods: Vec<PlanLimitPeriod>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct PlanLimitPeriod {
    pub id: String,
    pub window_minutes: u32,
    pub plan_type: String,
    pub starts_at: String,
    pub ends_at: String,
    pub accounting_complete: bool,
    pub used_basis_points: Option<f64>,
    pub breakdowns: Option<Vec<PlanLimitBreakdown>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct PlanLimitBreakdown {
    pub dimension: String,
    pub rows: Vec<PlanLimitValue>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct PlanLimitValue {
    pub key: String,
    pub basis_points: f64,
}

impl BackendClient<'_> {
    pub fn read_analytics(
        &self,
        report: AnalyticsReport<'_>,
        start_date: &str,
        end_date: &str,
        cancellation: &CancellationToken,
    ) -> Result<AnalyticsResponse, RequestError> {
        let path = match report {
            AnalyticsReport::Usage => ["usage", "daily-token-usage-breakdown"],
            AnalyticsReport::Credits => ["usage", "credit-usage-events"],
            AnalyticsReport::WorkspaceCredits | AnalyticsReport::EnterpriseTokens => {
                ["usage", "daily-workspace-user-token-usage-breakdown"]
            }
            AnalyticsReport::EnterpriseCredits { .. } => {
                ["usage", "daily-workspace-user-credit-usage"]
            }
            AnalyticsReport::Messages => ["analytics", "daily-workspace-usage-counts"],
            AnalyticsReport::Plugins { .. } => ["analytics", "daily-plugin-usage-metrics"],
            AnalyticsReport::Skills { .. } => ["analytics", "daily-skill-usage-metrics"],
        };
        let mut url = self.endpoint(&path)?;
        // Credit events have no date filter in the backend contract.
        if report != AnalyticsReport::Credits {
            if !valid_date(start_date) || !valid_date(end_date) || start_date > end_date {
                return Err(RequestError::InvalidRequest);
            }
            url.query_pairs_mut()
                .append_pair("start_date", start_date)
                .append_pair("end_date", end_date);
            match report {
                AnalyticsReport::EnterpriseCredits { breakdown } => {
                    if breakdown.trim().is_empty() {
                        return Err(RequestError::InvalidRequest);
                    }
                    url.query_pairs_mut().append_pair("breakdown", breakdown);
                }
                _ => {
                    url.query_pairs_mut().append_pair("group_by", "day");
                }
            }
        }
        if matches!(
            report,
            AnalyticsReport::Messages
                | AnalyticsReport::Plugins { .. }
                | AnalyticsReport::Skills { .. }
        ) {
            url.query_pairs_mut().append_pair("workspace_user", "true");
        }
        match report {
            AnalyticsReport::EnterpriseTokens => {
                url.query_pairs_mut()
                    .append_pair("breakdown_by", "model")
                    .append_pair("modes", "codex")
                    .append_pair("modes", "work");
            }
            AnalyticsReport::Plugins { limit } | AnalyticsReport::Skills { limit } => {
                if limit == 0 {
                    return Err(RequestError::InvalidRequest);
                }
                let key = if matches!(report, AnalyticsReport::Plugins { .. }) {
                    "top_plugin_limit"
                } else {
                    "top_skill_limit"
                };
                url.query_pairs_mut().append_pair(key, &limit.to_string());
            }
            _ => {}
        }
        match report {
            AnalyticsReport::Usage
            | AnalyticsReport::EnterpriseTokens
            | AnalyticsReport::WorkspaceCredits => self
                .get(url, &[], cancellation)
                .map(AnalyticsResponse::Usage),
            AnalyticsReport::Credits => self
                .get(url, &[], cancellation)
                .map(AnalyticsResponse::Credits),
            AnalyticsReport::EnterpriseCredits { .. } => self
                .get(url, &[], cancellation)
                .map(AnalyticsResponse::EnterpriseCredits),
            AnalyticsReport::Messages => self
                .get(url, &[], cancellation)
                .map(AnalyticsResponse::Messages),
            AnalyticsReport::Plugins { .. } => self
                .get(url, &[], cancellation)
                .map(AnalyticsResponse::Plugins),
            AnalyticsReport::Skills { .. } => self
                .get(url, &[], cancellation)
                .map(AnalyticsResponse::Skills),
        }
    }

    /// Reads seven days of historical allowance. HTTP 404 means the report is unavailable.
    pub fn read_plan_limit_history(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<Option<PlanLimitHistory>, RequestError> {
        let mut url = self.endpoint(&["usage", "plan_limit_history"])?;
        url.query_pairs_mut().append_pair("days", "7");
        match self.get(url, &[], cancellation) {
            Ok(history) => Ok(Some(history)),
            Err(RequestError::HttpStatus(404)) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return false;
    }
    let number = |start: usize, end: usize| {
        bytes[start..end]
            .iter()
            .fold(0_u32, |value, digit| value * 10 + u32::from(digit - b'0'))
    };
    let year = number(0, 4);
    let month = number(5, 7);
    let day = number(8, 10);
    let days = match month {
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        _ => return false,
    };
    year > 0 && day > 0 && day <= days
}

#[cfg(test)]
#[path = "analytics_tests.rs"]
mod tests;
