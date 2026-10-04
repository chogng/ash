use crate::nls::Text;
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
                "chatgpt-subscription"
                    | "kimi-subscription"
                    | "xai-subscription"
                    | "bigmodel-coding-plan"
                    | "zai-coding-plan"
                    | "bigmodel-start-plan"
                    | "zai-start-plan"
            )
        })
        .collect();
    if accounts.is_empty() {
        return Ok(message("Sign in to a subscription: /config > Providers."));
    }
    let mut groups = Vec::new();
    let mut reconnect = None;
    for account in accounts {
        let name = match account.provider.as_str() {
            "xai-subscription" => "xAI",
            "kimi-subscription" => "Kimi",
            "bigmodel-coding-plan" => "BigModel",
            "zai-coding-plan" => "Z.AI",
            "bigmodel-start-plan" => "BigModel Start Plan",
            "zai-start-plan" => "Z.AI Start Plan",
            _ => "ChatGPT",
        };
        if account.status != AccountStatusDto::Ready {
            reconnect.get_or_insert(name);
            continue;
        }
        // Each subscription owns its result; one provider's failure must not hide
        // successful queries or prevent the remaining accounts from being read.
        let group = match client.read_account_rate_limits(AccountRateLimitsReadParams {
            provider: account.provider,
            account_id: account.account_id,
        }) {
            Ok(usage) => choices(usage),
            Err(error) => ListSelectionGroup::new(name, vec![detail("Status", query_error(error))]),
        };
        groups.push(group);
    }
    if groups.is_empty() {
        return Ok(message(&format!(
            "Reconnect {} in /config > Providers.",
            reconnect.expect("all subscription accounts are unavailable")
        )));
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
    let (provider, plan_label) = match usage.provider.as_str() {
        "kimi-subscription" => ("Kimi", "Kimi plan"),
        "bigmodel-coding-plan" => ("BigModel", "BigModel plan"),
        "zai-coding-plan" => ("Z.AI", "Z.AI plan"),
        "bigmodel-start-plan" => ("BigModel Start Plan", "BigModel plan"),
        "zai-start-plan" => ("Z.AI Start Plan", "Z.AI plan"),
        _ => ("ChatGPT", "ChatGPT plan"),
    };
    let mut items = vec![detail(
        plan_label,
        usage.plan.unwrap_or_else(|| "Not reported".into()),
    )];
    if usage.limits.is_empty() {
        items.push(detail("Limits", "Not reported"));
    }
    for limit in usage.limits {
        let name = limit.name.as_deref().unwrap_or(&limit.id);
        let name = if limit.id == "codex" { "Codex" } else { name };
        let heading = if limit.id == "codex" || limit.model.is_some() {
            Text::template("{0} quota", vec![Text::literal(name)])
        } else {
            Text::from(name)
        };
        items.push(ListSelectionItem::new(heading).as_section_divider());
        // Display names and model IDs may differ only in casing; retain a model
        // row when it adds information, such as the model covered by gpt-reserve.
        if let Some(model) = limit.model
            && !name.eq_ignore_ascii_case(&model)
        {
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
            let reset = window
                .resets_at
                .and_then(|seconds| i64::try_from(seconds).ok())
                .and_then(|seconds| DateTime::from_timestamp(seconds, 0))
                .map(|time| time.format("%Y-%m-%d %H:%M UTC").to_string())
                .unwrap_or_else(|| "Not reported".into());
            items.push(detail("Resets", reset));
        }
    }
    if provider == "ChatGPT" {
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
    }
    ListSelectionGroup::new(provider, items)
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
