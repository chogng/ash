use crate::RequestError;
use crate::client::Client;
use async_utils::CancellationToken;
use client::OperationClient;
use client::ResolvedApiTarget;
use serde::Deserialize;
use serde_json::Value;

const KEY_NAME: &str = "ash-coding-plan";

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaLimit {
    #[serde(rename = "type")]
    pub kind: String,
    pub percentage: Option<f64>,
    pub unit: Option<u32>,
    pub number: Option<u32>,
    pub next_reset_time: Option<u64>,
}

/// Current limits reported by the Coding Plan monitor endpoint.
pub fn read_quota(
    transport: &dyn OperationClient,
    target: &ResolvedApiTarget,
    cancellation: &CancellationToken,
) -> Result<Vec<QuotaLimit>, RequestError> {
    let http = Client::new(transport, target)?;
    let response: Value = http.get(
        http.endpoint(["api", "monitor", "usage", "quota", "limit"])?,
        &[],
        cancellation,
    )?;
    let limits = data(&response)?
        .get("limits")
        .cloned()
        .ok_or(RequestError::InvalidResponse)?;
    serde_json::from_value(limits).map_err(|_| RequestError::InvalidResponse)
}

pub(super) fn issue_api_key(
    transport: &dyn OperationClient,
    target: &ResolvedApiTarget,
    require_secret: bool,
    cancellation: &CancellationToken,
) -> Result<String, RequestError> {
    let http = Client::new(transport, target)?;
    let customer: Value = http.get(
        http.endpoint(["api", "biz", "customer", "getCustomerInfo"])?,
        &[],
        cancellation,
    )?;
    let organizations = data(&customer)?
        .get("organizations")
        .and_then(Value::as_array)
        .ok_or(RequestError::InvalidResponse)?;
    let organization = select_scope(organizations, "organizationName", "默认机构")?;
    let organization_id = nonempty(&organization["organizationId"])?;
    let projects = organization["projects"]
        .as_array()
        .ok_or(RequestError::InvalidResponse)?;
    let project = select_scope(projects, "projectName", "默认项目")?;
    let project_id = nonempty(&project["projectId"])?;
    let path = [
        "api",
        "biz",
        "v1",
        "organization",
        organization_id,
        "projects",
        project_id,
        "api_keys",
    ];
    let listed: Value = http.get(http.endpoint(path)?, &[], cancellation)?;
    let keys = data(&listed)?
        .as_array()
        .ok_or(RequestError::InvalidResponse)?;
    let key = if let Some(key) = keys
        .iter()
        .find(|entry| entry["name"].as_str() == Some(KEY_NAME))
    {
        nonempty(&key["apiKey"])?.to_owned()
    } else {
        let created: Value = http.post(
            http.endpoint(path)?,
            &serde_json::json!({"name": KEY_NAME}),
            cancellation,
        )?;
        nonempty(&data(&created)?["apiKey"])?.to_owned()
    };
    let secret: Value = http.get(
        http.endpoint([
            "api",
            "biz",
            "v1",
            "organization",
            organization_id,
            "projects",
            project_id,
            "api_keys",
            "copy",
            key.as_str(),
        ])?,
        &[],
        cancellation,
    )?;
    let secret = data(&secret)?["secretKey"].as_str().unwrap_or("").trim();
    if secret.is_empty() {
        if require_secret {
            return Err(RequestError::InvalidResponse);
        }
        return Ok(key);
    }
    Ok(format!("{key}.{secret}"))
}

pub(super) fn data(value: &Value) -> Result<&Value, RequestError> {
    if !matches!(value.get("code"), None | Some(Value::Null))
        && !matches!(value["code"].as_i64(), Some(0 | 200))
        && !matches!(value["code"].as_str(), Some("0" | "200"))
    {
        return Err(RequestError::InvalidResponse);
    }
    value.get("data").ok_or(RequestError::InvalidResponse)
}

fn nonempty(value: &Value) -> Result<&str, RequestError> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .ok_or(RequestError::InvalidResponse)
}

// A single scope is unambiguous. With several scopes, only the exact default
// name identifies the intended billing owner; array order is not an account choice.
fn select_scope<'a>(
    entries: &'a [Value],
    name_field: &str,
    default_name: &str,
) -> Result<&'a Value, RequestError> {
    if entries.len() == 1 {
        return Ok(&entries[0]);
    }
    let mut defaults = entries
        .iter()
        .filter(|entry| entry[name_field].as_str() == Some(default_name));
    let selected = defaults.next().ok_or(RequestError::InvalidResponse)?;
    if defaults.next().is_some() {
        return Err(RequestError::InvalidResponse);
    }
    Ok(selected)
}
