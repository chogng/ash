use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionModel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::account::AccountRateLimitWindowDto;
use ash_app_server_protocol::protocol::account::AccountRateLimitsReadParams;
use ash_app_server_protocol::protocol::account::AccountRateLimitsReadResult;
use ash_app_server_protocol::protocol::account::AccountStatusDto;
use chrono::DateTime;

pub(crate) enum Event {
    Opened(ListSelectionModel),
}

pub(crate) fn load<T: JsonRpcTransport>(client: &mut AppServerClient<T>) -> Result<Event, String> {
    let accounts = client.read_accounts().map_err(query_error)?;
    let accounts: Vec<_> = accounts
        .accounts
        .into_iter()
        .filter(|account| {
            matches!(
                account.provider.as_str(),
                "openai-chatgpt" | "xai-subscription"
            )
        })
        .collect();
    if accounts.is_empty() {
        return Ok(message("Sign in to ChatGPT or xAI: /config > Providers."));
    }
    let mut groups = Vec::new();
    for account in accounts {
        let name = if account.provider == "xai-subscription" {
            "xAI"
        } else {
            "ChatGPT"
        };
        if account.status != AccountStatusDto::Ready {
            return Ok(message(&format!(
                "Reconnect {name} in /config > Providers."
            )));
        }
        let usage = client
            .read_account_rate_limits(AccountRateLimitsReadParams {
                provider: account.provider,
                account_id: account.account_id,
            })
            .map_err(query_error)?;
        groups.push(choices(usage));
    }
    let single = groups.len() == 1;
    let mut model =
        ListSelectionModel::new("Usage", groups).with_key_hint_note("Run /usage to refresh");
    if single {
        model = model.without_tab_bar();
    }
    Ok(Event::Opened(model))
}

fn query_error(error: ClientError) -> String {
    match error {
        ClientError::Server { message, .. } if message == "AccountChanged" => {
            "Account changed. Run /usage again.".into()
        }
        ClientError::Server { message, .. }
            if matches!(
                message.as_str(),
                "AccountAuthenticationRequired" | "AccountUnavailable"
            ) =>
        {
            "Reconnect the account in /config > Providers.".into()
        }
        _ => "Could not load account usage. Run /usage to retry.".into(),
    }
}

fn message(text: &str) -> Event {
    Event::Opened(
        ListSelectionModel::new("Usage", vec![ListSelectionGroup::new("", vec![])])
            .without_tab_bar()
            .with_empty_message(text),
    )
}

fn choices(usage: AccountRateLimitsReadResult) -> ListSelectionGroup {
    if let Some(xai) = usage.xai {
        return xai_choices(usage.plan, xai);
    }
    let mut items = vec![detail(
        "ChatGPT plan",
        usage.plan.unwrap_or_else(|| "Not reported".into()),
    )];
    if usage.limits.is_empty() {
        items.push(detail("Limits", "Not reported"));
    }
    for limit in usage.limits {
        let name = limit.name.as_deref().unwrap_or(&limit.id);
        items.push(ListSelectionItem::new(if limit.id == "codex" {
            "Codex".to_owned()
        } else {
            name.to_owned()
        }));
        if let Some(model) = limit.model {
            items.push(detail("Model", model));
        }
        if limit.limit_reached == Some(true) {
            items.push(detail("Availability", "Limit reached"));
        } else if limit.allowed == Some(false) {
            items.push(detail("Availability", "Unavailable"));
        }
        if limit.primary.is_none() && limit.secondary.is_none() {
            items.push(detail("Windows", "Not reported"));
        }
        for window in [limit.primary, limit.secondary].into_iter().flatten() {
            items.push(window_item(&window));
            let reset = i64::try_from(window.resets_at)
                .ok()
                .and_then(|seconds| DateTime::from_timestamp(seconds, 0))
                .map(|time| time.format("%Y-%m-%d %H:%M UTC").to_string())
                .unwrap_or_else(|| "Unavailable".into());
            items.push(detail("Resets", reset));
        }
    }
    let credits = match usage.credits {
        None => "Not reported".into(),
        Some(credits) if credits.unlimited => "Unlimited".into(),
        Some(credits) => match credits.balance {
            Some(balance) => balance,
            None if credits.has_credits => "Available; balance not reported".into(),
            None => "No credits available".into(),
        },
    };
    items.push(detail("Credits", credits));
    ListSelectionGroup::new("ChatGPT", items)
}

fn window_item(window: &AccountRateLimitWindowDto) -> ListSelectionItem {
    let mut seconds = window.window_seconds;
    let mut duration = Vec::new();
    for (unit, suffix) in [(86400, "d"), (3600, "h"), (60, "m"), (1, "s")] {
        if seconds >= unit {
            duration.push(format!("{}{suffix}", seconds / unit));
            seconds %= unit;
        }
    }
    let label = if duration.is_empty() {
        "Window".into()
    } else {
        format!("{} window", duration.join(" "))
    };
    detail(
        &label,
        format!(
            "{}% left ({}% used)",
            100_u32.saturating_sub(window.used_percent),
            window.used_percent
        ),
    )
}

fn detail(label: &str, value: impl Into<String>) -> ListSelectionItem {
    ListSelectionItem::new(label).with_description(value)
}

fn xai_choices(
    plan: Option<String>,
    usage: ash_app_server_protocol::protocol::account::AccountXaiUsageDto,
) -> ListSelectionGroup {
    let mut items = vec![detail(
        "xAI plan",
        plan.unwrap_or_else(|| "Not reported".into()),
    )];
    items.push(detail(
        "Access",
        match usage.allowed {
            Some(true) => "Available",
            Some(false) => "Unavailable",
            None => "Not reported",
        },
    ));
    if let Some(message) = usage.message {
        items.push(detail("Status", message));
    }
    items.push(detail(
        "Credits used",
        usage
            .used_percent
            .map(|value| format!("{value}%"))
            .unwrap_or_else(|| "Not reported".into()),
    ));
    items.push(detail(
        "Period",
        match usage.period_type.as_deref() {
            Some("USAGE_PERIOD_TYPE_WEEKLY") => "Weekly",
            Some("USAGE_PERIOD_TYPE_MONTHLY") => "Monthly",
            Some(value) => value,
            None => "Not reported",
        },
    ));
    items.push(detail(
        "Resets",
        usage.period_end.unwrap_or_else(|| "Not reported".into()),
    ));
    for (label, cents) in [
        ("Prepaid", usage.prepaid_cents),
        ("On-demand used", usage.on_demand_used_cents),
        ("On-demand cap", usage.on_demand_cap_cents),
    ] {
        items.push(detail(
            label,
            cents
                .map(|value| dollars(&value))
                .unwrap_or_else(|| "Not reported".into()),
        ));
    }
    ListSelectionGroup::new("xAI", items)
}

// The backend supplies canonical integer cents; format decimal USD without floating point.
fn dollars(cents: &str) -> String {
    let (sign, digits) = match cents.strip_prefix('-') {
        Some(digits) => ("-", digits),
        None => ("", cents),
    };
    let amount = match digits.len() {
        1 => format!("0.0{digits}"),
        2 => format!("0.{digits}"),
        _ => {
            let (whole, fraction) = digits.split_at(digits.len() - 2);
            format!("{whole}.{fraction}")
        }
    };
    format!("USD {sign}{amount}")
}
