use super::StatusPanel;
use super::StatusViewData;
use super::status_panel;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
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
        return initial_status_panel(client, "Not started", "Not started");
    };
    let thread = client
        .read_session_thread(SessionThreadReadParams {
            session_id: scope.session_id.clone(),
            thread_id: scope.thread_id.clone(),
            history: None,
        })?
        .thread;
    if thread.turns.is_empty() {
        return initial_status_panel(client, scope.session_id.as_str(), scope.thread_id.as_str());
    }
    let model = thread.turns.last().and_then(|turn| turn.model.as_ref());
    let model = model
        .map(|model| format!("{}/{}", model.provider, model.model))
        .unwrap_or_else(|| "not configured".into());

    Ok(status_panel(StatusViewData {
        model: &model,
        usage: &thread.usage,
        reference_cost: &thread.reference_cost,
        session_id: scope.session_id.as_str(),
        thread_id: scope.thread_id.as_str(),
    }))
}

fn initial_status_panel<T: JsonRpcTransport>(
    client: &mut AppServerClient<T>,
    session_id: &str,
    thread_id: &str,
) -> Result<StatusPanel, ClientError> {
    let config = client.read_config()?;
    let catalog = client.list_models()?;
    let summary = crate::models::ModelSummary::from_catalog(
        config.model.clone(),
        config.model_reasoning_effort,
        Some(&catalog),
    );
    let label = summary.model_label();
    Ok(status_panel(StatusViewData {
        model: &label,
        usage: &ash_protocol::ModelUsageSummary::default(),
        reference_cost: &ash_protocol::ModelReferenceCostSummary::default(),
        session_id,
        thread_id,
    }))
}
