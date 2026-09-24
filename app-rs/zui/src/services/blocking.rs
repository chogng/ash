use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use futures::channel::oneshot;
use futures::executor::ThreadPool;

use super::SystemServiceError;

static SERVICE_POOL: OnceLock<Result<ThreadPool, String>> = OnceLock::new();

pub(super) type ServiceFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, SystemServiceError>> + Send + 'static>>;

#[derive(Clone, Copy, Debug, Default)]
pub(super) struct BlockingServiceExecutor;

impl BlockingServiceExecutor {
    pub(super) fn spawn<T, F>(&self, service: &'static str, task: F) -> ServiceFuture<T>
    where
        T: Send + 'static,
        F: FnOnce() -> Result<T, SystemServiceError> + Send + 'static,
    {
        let pool = match service_pool() {
            Ok(pool) => pool,
            Err(message) => {
                let error = SystemServiceError::backend(service, std::io::Error::other(message));
                return Box::pin(async move { Err(error) });
            }
        };
        let (response, result) = oneshot::channel();
        pool.spawn_ok(async move {
            let _ = response.send(task());
        });
        Box::pin(async move {
            result.await.map_err(|_| {
                SystemServiceError::backend(
                    service,
                    std::io::Error::other("service worker stopped before returning a result"),
                )
            })?
        })
    }
}

fn service_pool() -> Result<ThreadPool, String> {
    SERVICE_POOL
        .get_or_init(|| {
            ThreadPool::builder()
                .name_prefix("zui-service-")
                .create()
                .map_err(|error| error.to_string())
        })
        .clone()
}

#[cfg(test)]
#[path = "blocking_tests.rs"]
mod tests;
