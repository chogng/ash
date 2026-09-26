use super::RemainingContextWindow;
use super::StatusPanel;
use super::StatusViewData;
use super::status_panel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_protocol::ModelContextUsageSource;
use ash_protocol::ModelRef;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;

pub(crate) struct StatusRequestScope<'a> {
    pub(crate) session_id: &'a SessionId,
    pub(crate) thread_id: &'a ThreadId,
}

pub(crate) fn load_status_panel<T>(
    client: &mut AppServerClient<T>,
    scope: Option<StatusRequestScope<'_>>,
) -> Result<StatusPanel, ClientError>
where
    T: JsonRpcTransport,
{
    let Some(scope) = scope else {
        let config = client.read_config()?;
        let catalog = client.list_builtin_models()?;
        let entry = config.model.as_ref().and_then(|selected| {
            catalog.models.iter().find(|entry| {
                entry.model.provider.as_str() == selected.provider
                    && entry.model.model.as_str() == selected.model
            })
        });
        let summary = crate::models::ModelSummary::from_catalog(
            config.model.clone(),
            config.model_reasoning_effort,
            Some(&catalog),
        );
        let label = summary.model_label();
        return Ok(status_panel(StatusViewData {
            model: &label,
            full_context_window: entry.and_then(|entry| entry.context_window).map(u64::from),
            available_context_window: entry
                .and_then(|entry| entry.available_context_window)
                .map(u64::from),
            remaining_context_window: RemainingContextWindow::Unknown,
            usage: &ash_protocol::ModelUsageSummary::default(),
            reference_cost: &ash_protocol::ModelReferenceCostSummary::default(),
            session_id: "Not started",
            thread_id: "Not started",
        }));
    };
    let thread = client
        .read_session_thread(SessionThreadReadParams {
            session_id: scope.session_id.clone(),
            thread_id: scope.thread_id.clone(),
            history: None,
        })?
        .thread;
    let model = thread.turns.last().and_then(|turn| turn.model.as_ref());
    let models = client.list_builtin_models()?;
    let model_entry =
        model.and_then(|model| models.models.iter().find(|entry| &entry.model == model));
    let available = model_entry
        .and_then(|entry| entry.available_context_window)
        .map(u64::from);
    let remaining = remaining_context_window(available, model, &thread);
    let model = model
        .map(|model| format!("{}/{}", model.provider, model.model))
        .unwrap_or_else(|| "not configured".into());

    Ok(status_panel(StatusViewData {
        model: &model,
        full_context_window: model_entry
            .and_then(|entry| entry.context_window)
            .map(u64::from),
        available_context_window: available,
        remaining_context_window: remaining,
        usage: &thread.usage,
        reference_cost: &thread.reference_cost,
        session_id: scope.session_id.as_str(),
        thread_id: scope.thread_id.as_str(),
    }))
}

fn remaining_context_window(
    available: Option<u64>,
    model: Option<&ModelRef>,
    thread: &ash_protocol::Thread,
) -> RemainingContextWindow {
    let Some(available) = available else {
        return RemainingContextWindow::Unknown;
    };
    let Some(latest_turn) = thread.turns.last() else {
        return RemainingContextWindow::Exact {
            remaining_tokens: available,
            available_tokens: available,
        };
    };
    if latest_turn.model.as_ref() != model {
        return RemainingContextWindow::Unknown;
    }
    let Some(usage) = latest_turn.context_usage.as_ref() else {
        return RemainingContextWindow::Unknown;
    };
    let remaining = available.saturating_sub(usage.used_tokens);
    match usage.source {
        ModelContextUsageSource::ProviderReported => RemainingContextWindow::Exact {
            remaining_tokens: remaining,
            available_tokens: available,
        },
        ModelContextUsageSource::Estimated => RemainingContextWindow::Estimated {
            remaining_tokens: remaining,
            available_tokens: available,
        },
    }
}

#[cfg(test)]
#[path = "panel_request_tests.rs"]
mod tests;
