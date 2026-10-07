use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use ash_async_utils::CancellationToken;
use lsp_types::notification::Notification;
use lsp_types::request::Request;
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::LanguageServerError;
use crate::driver::DriverCommand;

pub(crate) struct RawClient {
    pub(crate) commands: mpsc::Sender<DriverCommand>,
    next_request_id: AtomicU64,
}

impl RawClient {
    pub(crate) fn new(commands: mpsc::Sender<DriverCommand>) -> Self {
        Self {
            commands,
            next_request_id: AtomicU64::new(1),
        }
    }

    pub(crate) async fn request<R>(
        &self,
        params: R::Params,
        timeout: Duration,
    ) -> Result<R::Result, LanguageServerError>
    where
        R: Request,
    {
        let params = serde_json::to_value(params)
            .map_err(|error| LanguageServerError::InvalidMessage(error.to_string()))?;
        let result = self.request_value(R::METHOD, params, timeout, None).await?;
        serde_json::from_value(result).map_err(|source| LanguageServerError::InvalidResult {
            method: R::METHOD.into(),
            source,
        })
    }

    pub(crate) async fn request_with_cancellation<R>(
        &self,
        params: R::Params,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<R::Result, LanguageServerError>
    where
        R: Request,
    {
        let params = serde_json::to_value(params)
            .map_err(|error| LanguageServerError::InvalidMessage(error.to_string()))?;
        let result = self
            .request_value(R::METHOD, params, timeout, Some(cancellation))
            .await?;
        serde_json::from_value(result).map_err(|source| LanguageServerError::InvalidResult {
            method: R::METHOD.into(),
            source,
        })
    }

    async fn request_value(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancellation: Option<&CancellationToken>,
    ) -> Result<Value, LanguageServerError> {
        if cancellation.is_some_and(CancellationToken::is_cancelled) {
            return Err(LanguageServerError::Cancelled {
                operation: method.into(),
            });
        }
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        let id = i64::try_from(id).map_err(|_| {
            LanguageServerError::InvalidMessage("request ID space exhausted".into())
        })?;
        let (completion, response) = oneshot::channel();
        let operation = async {
            self.commands
                .send(DriverCommand::Request {
                    id,
                    method: method.into(),
                    params,
                    completion,
                })
                .await
                .map_err(|_| LanguageServerError::ConnectionClosed)?;
            response
                .await
                .map_err(|_| LanguageServerError::ConnectionClosed)?
        };
        let result = if let Some(cancellation) = cancellation {
            tokio::select! {
                result = tokio::time::timeout(timeout, operation) => result,
                _ = cancellation.cancelled() => {
                    self.send_cancellation(id).await;
                    return Err(LanguageServerError::Cancelled {
                        operation: method.into(),
                    });
                }
            }
        } else {
            tokio::time::timeout(timeout, operation).await
        };
        match result {
            Ok(result) => result,
            Err(_) => {
                self.send_cancellation(id).await;
                Err(LanguageServerError::Timeout {
                    operation: method.into(),
                    duration: timeout,
                })
            }
        }
    }

    async fn send_cancellation(&self, id: i64) {
        let cancellation = DriverCommand::CancelRequest { id };
        if let Err(mpsc::error::TrySendError::Full(cancellation)) =
            self.commands.try_send(cancellation)
        {
            let commands = self.commands.clone();
            tokio::spawn(async move {
                let _ = commands.send(cancellation).await;
            });
        }
    }

    pub(crate) async fn notify<N>(&self, params: N::Params) -> Result<(), LanguageServerError>
    where
        N: Notification,
    {
        let params = serde_json::to_value(params)
            .map_err(|error| LanguageServerError::InvalidMessage(error.to_string()))?;
        self.notify_value(N::METHOD, params).await
    }

    async fn notify_value(&self, method: &str, params: Value) -> Result<(), LanguageServerError> {
        let (completion, response) = oneshot::channel();
        self.commands
            .send(DriverCommand::Notification {
                method: method.into(),
                params,
                completion,
            })
            .await
            .map_err(|_| LanguageServerError::ConnectionClosed)?;
        response
            .await
            .map_err(|_| LanguageServerError::ConnectionClosed)?
    }
}
