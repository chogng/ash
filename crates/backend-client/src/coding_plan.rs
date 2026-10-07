use crate::RequestError;
use crate::client::Client;
use async_utils::CancellationToken;
use backend_models::coding_plan::ApiKey;
use backend_models::coding_plan::ApiKeySecret;
use backend_models::coding_plan::BusinessResponse;
use backend_models::coding_plan::CreateApiKeyRequest;
use backend_models::coding_plan::Customer;
use backend_models::coding_plan::Quota;
use backend_models::coding_plan::QuotaLimit;
use backend_models::coding_plan::ResponseCode;
use client::OperationClient;
use client::ResolvedApiTarget;

const KEY_NAME: &str = "ash-coding-plan";

/// Current limits reported by the Coding Plan monitor endpoint.
pub fn read_quota(
    transport: &dyn OperationClient,
    target: &ResolvedApiTarget,
    cancellation: &CancellationToken,
) -> Result<Vec<QuotaLimit>, RequestError> {
    let http = Client::new(transport, target)?;
    let response: BusinessResponse<Quota> = http.get(
        http.endpoint(["api", "monitor", "usage", "quota", "limit"])?,
        &[],
        cancellation,
    )?;
    Ok(data(response)?.limits)
}

pub(super) fn issue_api_key(
    transport: &dyn OperationClient,
    target: &ResolvedApiTarget,
    require_secret: bool,
    cancellation: &CancellationToken,
) -> Result<String, RequestError> {
    let http = Client::new(transport, target)?;
    let response: BusinessResponse<Customer> = http.get(
        http.endpoint(["api", "biz", "customer", "getCustomerInfo"])?,
        &[],
        cancellation,
    )?;
    let customer = data(response)?;
    let organization = select_scope(
        &customer.organizations,
        |entry| entry.organization_name.as_deref(),
        "默认机构",
    )?;
    let organization_id = nonempty(&organization.organization_id)?;
    let project = select_scope(
        &organization.projects,
        |entry| entry.project_name.as_deref(),
        "默认项目",
    )?;
    let project_id = nonempty(&project.project_id)?;
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
    let listed: BusinessResponse<Vec<ApiKey>> =
        http.get(http.endpoint(path)?, &[], cancellation)?;
    let keys = data(listed)?;
    let key = if let Some(key) = keys
        .iter()
        .find(|entry| entry.name.as_deref() == Some(KEY_NAME))
    {
        nonempty(&key.api_key)?.to_owned()
    } else {
        let created: BusinessResponse<ApiKey> = http.post(
            http.endpoint(path)?,
            &CreateApiKeyRequest { name: KEY_NAME },
            cancellation,
        )?;
        nonempty(&data(created)?.api_key)?.to_owned()
    };
    let response: BusinessResponse<ApiKeySecret> = http.get(
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
    let secret = data(response)?;
    let secret = secret.secret_key.as_deref().unwrap_or("").trim();
    if secret.is_empty() {
        if require_secret {
            return Err(RequestError::InvalidResponse);
        }
        return Ok(key);
    }
    Ok(format!("{key}.{secret}"))
}

pub(super) fn data<T>(response: BusinessResponse<T>) -> Result<T, RequestError> {
    let successful = match response.code {
        None | Some(ResponseCode::Number(0 | 200)) => true,
        Some(ResponseCode::Text(code)) => matches!(code.as_str(), "0" | "200"),
        Some(ResponseCode::Number(_)) => false,
    };
    if successful {
        Ok(response.data)
    } else {
        Err(RequestError::InvalidResponse)
    }
}

fn nonempty(value: &str) -> Result<&str, RequestError> {
    if value.trim().is_empty() {
        Err(RequestError::InvalidResponse)
    } else {
        Ok(value)
    }
}

// A single scope is unambiguous. With several scopes, only the exact default
// name identifies the intended billing owner; array order is not an account choice.
fn select_scope<'a, T>(
    entries: &'a [T],
    name: impl Fn(&T) -> Option<&str>,
    default_name: &str,
) -> Result<&'a T, RequestError> {
    if entries.len() == 1 {
        return Ok(&entries[0]);
    }
    let mut defaults = entries
        .iter()
        .filter(|entry| name(entry) == Some(default_name));
    let selected = defaults.next().ok_or(RequestError::InvalidResponse)?;
    if defaults.next().is_some() {
        return Err(RequestError::InvalidResponse);
    }
    Ok(selected)
}
