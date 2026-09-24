use crate::app_server::AppServerRequestHandle;
use crate::workbench_event::WorkbenchEvent;
use ash_app_server_client::MemoryRecording;
use ash_commands::AppCommandId;
use ash_memory_diagnostics::MemoryMetric;
use ash_memory_diagnostics::MemoryMetricKind;
use ash_memory_diagnostics::MemoryProduct;
use ash_memory_diagnostics::MemoryReport;
use ash_memory_diagnostics::MemoryStatus;
use ash_memory_diagnostics::MemoryUnavailable;
use zui::app::ApplicationHandle;
use zui::runtime::BackgroundExecutor;
use zui::runtime::Task;
use zui::runtime::TaskScope;
use zui::services::FileDialogHandle;
use zui::services::FileDialogOptions;
use zui::services::MessageDialogHandle;
use zui::services::MessageDialogRequest;

pub(crate) enum MemoryCompletion {
    Operation {
        recording: Option<Box<MemoryRecording>>,
        message: Result<String, String>,
    },
    MessageClosed(Result<(), String>),
}

pub(crate) struct MemoryUi {
    objects: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    diagnostics: zui::devtools::DiagnosticsHandle,
    recording: Option<Box<MemoryRecording>>,
    task: Option<Task>,
    executor: BackgroundExecutor<WorkbenchEvent>,
    messages: MessageDialogHandle,
    files: FileDialogHandle,
}

impl MemoryUi {
    pub(crate) fn new(application: &ApplicationHandle<WorkbenchEvent>) -> Self {
        Self {
            objects: Default::default(),
            diagnostics: application.diagnostics(),
            recording: None,
            task: None,
            executor: application.background_executor(),
            messages: application.services().message_dialogs(),
            files: application.services().file_dialogs(),
        }
    }

    pub(crate) fn update_counters(&self, objects: usize) {
        self.objects
            .store(objects, std::sync::atomic::Ordering::Relaxed);
    }

    pub(crate) fn execute(
        &mut self,
        command: AppCommandId,
        client: Option<AppServerRequestHandle>,
    ) {
        if self.task.is_some() {
            return;
        }
        let Some(mut client) = client else {
            self.show("Memory diagnostics require a connected backend.".into());
            return;
        };
        match command {
            AppCommandId::StartMemoryDiagnostics => {
                if self.recording.as_ref().is_some_and(|recording| {
                    recording
                        .report()
                        .is_ok_and(|report| report.status == MemoryStatus::Recording)
                }) {
                    self.show("Memory diagnostics are already recording.".into());
                    return;
                }
                let diagnostics = self.diagnostics.clone();
                let objects = std::sync::Arc::clone(&self.objects);
                let request_id = format!(
                    "gui-memory-{}",
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                );
                self.task = Some(self.executor.spawn(TaskScope::Application, async move {
                    let result = MemoryRecording::start(
                        client,
                        MemoryProduct::RustGui,
                        request_id,
                        move || {
                            let snapshot = diagnostics.snapshot();
                            let rendering = snapshot
                                .windows
                                .iter()
                                .map(|window| window.renderer_memory)
                                .collect::<Option<Vec<_>>>();
                            let render_count = |kind, value| MemoryMetric {
                                kind,
                                value,
                                unavailable: value
                                    .is_none()
                                    .then_some(MemoryUnavailable::Unsupported),
                            };
                            vec![
                                render_count(
                                    MemoryMetricKind::GpuResources,
                                    rendering.as_ref().map(|values| {
                                        values.iter().map(|value| value.gpu_resources as u64).sum()
                                    }),
                                ),
                                render_count(
                                    MemoryMetricKind::RenderCacheEntries,
                                    rendering.as_ref().map(|values| {
                                        values.iter().map(|value| value.cache_entries as u64).sum()
                                    }),
                                ),
                                MemoryMetric {
                                    kind: MemoryMetricKind::UiObjects,
                                    value: Some(
                                        objects.load(std::sync::atomic::Ordering::Relaxed) as u64
                                    ),
                                    unavailable: None,
                                },
                                MemoryMetric {
                                    kind: MemoryMetricKind::Windows,
                                    value: Some(snapshot.windows.len() as u64),
                                    unavailable: None,
                                },
                                MemoryMetric {
                                    kind: MemoryMetricKind::Tasks,
                                    value: Some(snapshot.active_tasks as u64),
                                    unavailable: None,
                                },
                                MemoryMetric {
                                    kind: MemoryMetricKind::GpuEstimatedBytes,
                                    value: None,
                                    unavailable: Some(MemoryUnavailable::Unsupported),
                                },
                                MemoryMetric {
                                    kind: MemoryMetricKind::CacheBytes,
                                    value: None,
                                    unavailable: Some(MemoryUnavailable::Unsupported),
                                },
                            ]
                        },
                    );
                    WorkbenchEvent::Memory(match result {
                        Ok(recording) => MemoryCompletion::Operation {
                            message: recording.report().map(|report| describe(&report)),
                            recording: Some(Box::new(recording)),
                        },
                        Err(error) => MemoryCompletion::Operation {
                            message: Err(error),
                            recording: None,
                        },
                    })
                }));
            }
            AppCommandId::ReadMemoryDiagnostics => {
                let message = self
                    .recording
                    .as_ref()
                    .ok_or_else(|| "Start memory diagnostics first.".to_owned())
                    .and_then(|recording| recording.report())
                    .map(|report| describe(&report));
                self.show(message.unwrap_or_else(|error| error));
            }
            AppCommandId::StopMemoryDiagnostics => {
                let Some(mut recording) = self.recording.take() else {
                    self.show("Start memory diagnostics first.".into());
                    return;
                };
                self.task = Some(self.executor.spawn(TaskScope::Application, async move {
                    let message = recording.stop().map(|report| describe(&report));
                    WorkbenchEvent::Memory(MemoryCompletion::Operation {
                        recording: Some(recording),
                        message,
                    })
                }));
            }
            AppCommandId::ExportMemoryDiagnostics => {
                let Some(recording) = &self.recording else {
                    self.show("Start memory diagnostics first.".into());
                    return;
                };
                let id = recording.session_id().to_owned();
                let files = self.files.clone();
                self.task = Some(self.executor.spawn(TaskScope::Application, async move {
                    let message = async {
                        use std::io::Write;
                        let path = files
                            .save_file(
                                FileDialogOptions::new()
                                    .with_suggested_file_name("memory-diagnostics.json"),
                            )
                            .await
                            .map_err(|error| error.to_string())?;
                        let Some(path) = path else {
                            return Ok(String::new());
                        };
                        let bytes = client.export_memory_bytes(id)?;
                        let mut file = std::fs::OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&path)
                            .map_err(|error| error.to_string())?;
                        file.write_all(&bytes).map_err(|error| error.to_string())?;
                        Ok(format!("Memory report exported to {}", path.display()))
                    }
                    .await;
                    WorkbenchEvent::Memory(MemoryCompletion::Operation {
                        recording: None,
                        message,
                    })
                }));
            }
            _ => {}
        }
    }

    pub(crate) fn finish(&mut self, completion: MemoryCompletion) {
        self.task = None;
        let MemoryCompletion::Operation { recording, message } = completion else {
            if let MemoryCompletion::MessageClosed(Err(error)) = completion {
                eprintln!("Could not display memory diagnostic result: {error}");
            }
            return;
        };
        if let Some(recording) = recording {
            self.recording = Some(recording);
        }
        let message = message.unwrap_or_else(|error| format!("Memory diagnostics: {error}"));
        if !message.is_empty() {
            self.show(message);
        }
    }

    fn show(&mut self, message: String) {
        let future = self
            .messages
            .show(MessageDialogRequest::new("Memory diagnostics", message));
        self.task = Some(self.executor.spawn(TaskScope::Application, async move {
            let result = future.await.map(|_| ()).map_err(|error| error.to_string());
            WorkbenchEvent::Memory(MemoryCompletion::MessageClosed(result))
        }));
    }
}

fn describe(report: &MemoryReport) -> String {
    let mut message = format!(
        "{:?} · {} seconds · {} targets\nGrowth is evidence for investigation, not proof of a leak.\nUI objects count retained fragments. GPU resources count retained wgpu handles; render cache entries count image, icon and text-buffer caches. Driver and cache byte sizes are unavailable.",
        report.status,
        report.elapsed_ms / 1000,
        report.targets.len()
    );
    for target in &report.targets {
        message.push_str(&format!(
            "\n{:?} / {:?} / PID {}: {} samples",
            target.origin,
            target.role,
            target
                .process_id
                .map(|id| id.to_string())
                .unwrap_or_else(|| "unavailable".into()),
            target.samples
        ));
        for metric in &target.latest.metrics {
            let value = metric
                .value
                .map(|value| value.to_string())
                .unwrap_or_else(|| {
                    metric
                        .unavailable
                        .map(|reason| format!("{reason:?}"))
                        .unwrap_or_else(|| "Unavailable".into())
                });
            message.push_str(&format!("\n  {:?}: {}", metric.kind, value));
        }
        for trend in &target.trends {
            message.push_str(&format!("\n  {:?}: {:?}", trend.kind, trend.finding));
        }
    }
    message
}
