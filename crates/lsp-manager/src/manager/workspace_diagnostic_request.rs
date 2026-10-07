use ash_async_utils::CancellationSource;
use ash_lsp::lsp_types::PartialResultParams;
use ash_lsp::lsp_types::WorkDoneProgressParams;
use ash_lsp::lsp_types::WorkspaceDiagnosticParams;
use ash_lsp::lsp_types::request::WorkspaceDiagnosticRequest;

use super::InFlightLanguageRequest;
use super::Supervisor;
use super::SupervisorCommand;
use super::request_runtime::supports_request;
use crate::LanguageDirectoryDiagnostics;
use crate::LanguageRequestId;
use crate::LanguageRequestKind;
use crate::workspace_diagnostics::project_workspace_diagnostics;
use crate::{LanguageRequestMetricOutcome, LspManagerNotification, LspManagerRequestResult};

impl Supervisor {
    pub(super) fn begin_workspace_diagnostics(
        &mut self,
        id: LanguageRequestId,
        language_id: String,
    ) {
        let Some((server, server_epoch)) = self.server_for_language(&language_id) else {
            self.emit_unsupported_workspace_diagnostics(id, language_id);
            return;
        };
        let Ok(client) = self.router.client_for_language(&language_id).cloned() else {
            self.emit_unsupported_workspace_diagnostics(id, language_id);
            return;
        };
        if !supports_request(&client, LanguageRequestKind::WorkspaceDiagnostics) {
            self.emit_unsupported_workspace_diagnostics(id, language_id);
            return;
        }
        let encoding = client.initialization().position_encoding.clone();
        let generation = self.generation;
        let commands = self.commands.clone();
        let completion_language_id = language_id.clone();
        let kind = LanguageRequestKind::WorkspaceDiagnostics;
        let cold_for_incarnation =
            self.observed_request_kinds
                .insert((server.clone(), server_epoch, kind));
        let started = std::time::Instant::now();
        let cancellation = CancellationSource::new();
        let cancellation_token = cancellation.token();
        let completion_server = server.clone();
        let _ = tokio::spawn(async move {
            let result = client
                .request_with_cancellation::<WorkspaceDiagnosticRequest>(
                    WorkspaceDiagnosticParams {
                        identifier: None,
                        previous_result_ids: Vec::new(),
                        work_done_progress_params: WorkDoneProgressParams::default(),
                        partial_result_params: PartialResultParams::default(),
                    },
                    &cancellation_token,
                )
                .await
                .map_err(|error| error.to_string())
                .and_then(|response| {
                    project_workspace_diagnostics(id, language_id, &encoding, response)
                });
            let _ = commands.send(SupervisorCommand::DirectoryDiagnosticsCompleted {
                id,
                language_id: completion_language_id,
                server: completion_server,
                generation,
                server_epoch,
                result,
            });
        });
        self.in_flight_requests.insert(
            id,
            InFlightLanguageRequest {
                cancellation,
                kind,
                server,
                server_epoch,
                configuration_generation: self.configuration.generation,
                service_generation: generation,
                cold_for_incarnation,
                started,
            },
        );
    }

    pub(super) fn complete_workspace_diagnostics(
        &mut self,
        id: LanguageRequestId,
        language_id: String,
        server: ash_lsp::LanguageServerName,
        generation: u64,
        server_epoch: u64,
        result: Result<LanguageDirectoryDiagnostics, String>,
    ) {
        let Some(tracking) = self.in_flight_requests.remove(&id) else {
            return;
        };
        if tracking.cancellation.token().is_cancelled() {
            self.record_request_metric(tracking, LanguageRequestMetricOutcome::Cancelled, 0);
            return;
        }
        if generation != self.generation
            || !self.servers.get(&server).is_some_and(|managed| {
                managed.epoch == server_epoch && managed.phase == super::ManagedServerPhase::Ready
            })
        {
            self.record_request_metric(tracking, LanguageRequestMetricOutcome::StaleDiscarded, 0);
            return;
        }
        match result {
            Ok(result) => {
                self.record_request_metric(
                    tracking,
                    LanguageRequestMetricOutcome::Delivered,
                    result.diagnostics.len(),
                );
                self.emit_request_result(LspManagerRequestResult::DirectoryDiagnostics(result));
            }
            Err(message) => {
                self.record_request_metric(tracking, LanguageRequestMetricOutcome::Failed, 0);
                self.emit_notification(LspManagerNotification::ServerMessage {
                    server: server.to_string(),
                    severity: super::LanguageServerMessageSeverity::Error,
                    source: super::LanguageServerMessageSource::Service,
                    show: false,
                    message,
                });
                self.emit_unsupported_workspace_diagnostics(id, language_id);
            }
        }
    }

    fn emit_unsupported_workspace_diagnostics(
        &self,
        request_id: LanguageRequestId,
        language_id: String,
    ) {
        self.emit_request_result(LspManagerRequestResult::DirectoryDiagnostics(
            LanguageDirectoryDiagnostics {
                request_id,
                language_id,
                supported: false,
                diagnostics: Vec::new(),
            },
        ));
    }
}
