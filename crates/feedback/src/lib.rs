//! Reviewable diagnostic bundles and explicit uploads of exactly the reviewed bytes.

use diagnostics::DiagnosticSnapshot;
use feedback_contract::PreparedFeedback;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

struct Bundle {
    prepared: PreparedFeedback,
    created: Instant,
}

/// Owns bounded pending bundles; connection close removes that connection's unsubmitted data.
#[derive(Default)]
pub struct Feedback {
    pending: Mutex<BTreeMap<(u64, String), Bundle>>,
}

impl Feedback {
    pub fn prepare(
        &self,
        owner: u64,
        endpoint: &str,
        snapshot: DiagnosticSnapshot,
    ) -> Result<PreparedFeedback, String> {
        let url = url::Url::parse(endpoint).map_err(|_| "invalid feedback endpoint")?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || url.query().is_some()
        {
            return Err(
                "feedback endpoint must be HTTPS without credentials, query or fragment".into(),
            );
        }
        let content = format!(
            "{}\n",
            serde_json::to_string_pretty(&snapshot).map_err(|error| error.to_string())?
        );
        let endpoint = url.to_string();
        let digest = format!("{:x}", Sha256::digest(format!("{endpoint}\n{content}")));
        let prepared = PreparedFeedback {
            digest: digest.clone(),
            endpoint,
            content,
        };
        let mut pending = self.pending.lock().map_err(|_| "feedback lock poisoned")?;
        pending.retain(|_, bundle| bundle.created.elapsed() < Duration::from_secs(900));
        if pending.len() >= 16 && !pending.contains_key(&(owner, digest.clone())) {
            return Err("too many pending feedback bundles".into());
        }
        pending.insert(
            (owner, digest),
            Bundle {
                prepared: prepared.clone(),
                created: Instant::now(),
            },
        );
        Ok(prepared)
    }

    /// Sends the exact reviewed digest once. A failed or uncertain upload requires preparing again.
    /// The caller must obtain the user's explicit approval before invoking this method.
    pub fn upload(
        &self,
        owner: u64,
        digest: &str,
        client: &dyn ash_client::OperationClient,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<(), String> {
        let bundle = self
            .pending
            .lock()
            .map_err(|_| "feedback lock poisoned")?
            .remove(&(owner, digest.to_owned()))
            .ok_or("feedback bundle is absent or belongs to another connection")?;
        if bundle.created.elapsed() >= Duration::from_secs(900) {
            return Err("feedback bundle expired".into());
        }
        let request = ash_client::ClientRequest::post(
            bundle.prepared.endpoint,
            vec![
                ash_http_client::HttpHeader::new("content-type", "application/json"),
                ash_http_client::HttpHeader::new("idempotency-key", digest),
            ],
            bundle.prepared.content.into_bytes(),
            ash_client::RetryPolicy::never(),
        )
        .map_err(|error| error.to_string())?;
        let response = client
            .execute_with_cancellation(&request, cancellation)
            .map_err(|_| "feedback upload failed")?;
        if !response.is_success() {
            return Err(format!(
                "feedback upload returned HTTP {}",
                response.status()
            ));
        }
        Ok(())
    }

    pub fn close(&self, owner: u64) {
        self.pending
            .lock()
            .expect("feedback lock poisoned")
            .retain(|(connection, _), _| *connection != owner);
    }
}

#[cfg(test)]
#[path = "feedback_tests.rs"]
mod tests;
