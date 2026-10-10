use std::num::NonZeroU32;
use std::num::NonZeroU64;
use std::time::Duration;

use crate::ExtensionHostError;

/// Hard process limits that a platform launcher must attest it has installed before spawn.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HardResourceLimits {
    pub maximum_memory_bytes: NonZeroU64,
    pub maximum_cpu_time: Duration,
    pub maximum_processes: NonZeroU32,
}

/// Independent V8 budgets. These bound JavaScript storage, not the process address space.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct JavaScriptMemoryLimits {
    pub heap_bytes: std::num::NonZeroUsize,
    pub array_buffer_bytes: std::num::NonZeroUsize,
}

impl Default for JavaScriptMemoryLimits {
    fn default() -> Self {
        Self {
            heap_bytes: std::num::NonZeroUsize::new(64 * 1024 * 1024).unwrap(),
            array_buffer_bytes: std::num::NonZeroUsize::new(64 * 1024 * 1024).unwrap(),
        }
    }
}

/// Required isolation level for an extension runtime process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessIsolationPolicy {
    /// Fail closed unless the launcher enforces the requested sandbox and hard resource limits.
    RequirePlatformEnforcement(HardResourceLimits),
    /// Product-owned V8 process: no direct filesystem, network or child processes;
    /// separate heap/backing-store budgets and per-request execution deadlines.
    RequireJavaScriptEnforcement(JavaScriptMemoryLimits),
    /// Standard VS Code extensions run with user-level Node capabilities after exact-package
    /// execution consent. The supervisor still enforces protocol quotas, deadlines and revocation;
    /// this policy does not claim V8 confinement or a whole-process memory limit.
    AuthorizedNode,
    /// Explicit opt-in for trusted local development. Never use for installed third-party code.
    TrustedDevelopment,
}

/// Bounded process, protocol, lifecycle, and restart policy for one extension runtime.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionHostLimits {
    pub maximum_frame_bytes: usize,
    pub maximum_payload_bytes: usize,
    pub maximum_registrations: usize,
    pub maximum_in_flight_requests: usize,
    pub maximum_in_flight_control_requests: usize,
    pub maximum_stderr_bytes: usize,
    pub maximum_output_event_count: usize,
    pub maximum_output_bytes: usize,
    pub maximum_argument_count: usize,
    pub maximum_argument_bytes: usize,
    pub maximum_environment_entries: usize,
    pub maximum_environment_bytes: usize,
    pub startup_timeout: Duration,
    pub request_timeout: Duration,
    pub cancellation_grace: Duration,
    pub shutdown_timeout: Duration,
    pub isolation: ProcessIsolationPolicy,
}

impl ExtensionHostLimits {
    /// Wire validation is shared with SDK clients; execution limits remain host-owned.
    pub fn protocol_limits(&self) -> extension_protocol::ProtocolLimits {
        extension_protocol::ProtocolLimits {
            maximum_frame_bytes: self.maximum_frame_bytes,
            maximum_payload_bytes: self.maximum_payload_bytes,
            maximum_registrations: self.maximum_registrations,
        }
    }

    pub fn validate(&self) -> Result<(), ExtensionHostError> {
        if self.maximum_frame_bytes == 0 {
            return Err(ExtensionHostError::InvalidLimits(
                "maximum frame bytes must be non-zero",
            ));
        }
        if self.maximum_payload_bytes == 0 || self.maximum_payload_bytes > self.maximum_frame_bytes
        {
            return Err(ExtensionHostError::InvalidLimits(
                "maximum payload bytes must fit inside a frame",
            ));
        }
        if self.maximum_registrations == 0
            || self.maximum_in_flight_requests == 0
            || self.maximum_in_flight_control_requests == 0
        {
            return Err(ExtensionHostError::InvalidLimits(
                "registration and in-flight request limits must be non-zero",
            ));
        }
        if self.maximum_stderr_bytes == 0
            || self.maximum_output_event_count == 0
            || self.maximum_output_bytes == 0
        {
            return Err(ExtensionHostError::InvalidLimits(
                "maximum stderr and Output limits must be non-zero",
            ));
        }
        if self.maximum_argument_count == 0
            || self.maximum_argument_bytes == 0
            || self.maximum_environment_entries == 0
            || self.maximum_environment_bytes == 0
        {
            return Err(ExtensionHostError::InvalidLimits(
                "process argument and environment limits must be non-zero",
            ));
        }
        if self.startup_timeout.is_zero()
            || self.request_timeout.is_zero()
            || self.cancellation_grace.is_zero()
            || self.shutdown_timeout.is_zero()
        {
            return Err(ExtensionHostError::InvalidLimits(
                "lifecycle deadlines must be non-zero",
            ));
        }
        if let ProcessIsolationPolicy::RequirePlatformEnforcement(resources) = self.isolation
            && resources.maximum_cpu_time.is_zero()
        {
            return Err(ExtensionHostError::InvalidLimits(
                "maximum CPU time must be non-zero",
            ));
        }
        Ok(())
    }
}

impl Default for ExtensionHostLimits {
    fn default() -> Self {
        let protocol = extension_protocol::ProtocolLimits::default();
        Self {
            maximum_frame_bytes: protocol.maximum_frame_bytes,
            maximum_payload_bytes: protocol.maximum_payload_bytes,
            maximum_registrations: protocol.maximum_registrations,
            maximum_in_flight_requests: 32,
            maximum_in_flight_control_requests: 8,
            maximum_stderr_bytes: 256 * 1024,
            maximum_output_event_count: 4096,
            maximum_output_bytes: 512 * 1024,
            maximum_argument_count: 128,
            maximum_argument_bytes: 32 * 1024,
            maximum_environment_entries: 64,
            maximum_environment_bytes: 32 * 1024,
            startup_timeout: Duration::from_secs(10),
            request_timeout: Duration::from_secs(30),
            cancellation_grace: Duration::from_secs(2),
            shutdown_timeout: Duration::from_secs(5),
            isolation: ProcessIsolationPolicy::RequirePlatformEnforcement(HardResourceLimits {
                maximum_memory_bytes: NonZeroU64::new(512 * 1024 * 1024)
                    .expect("the default memory limit is non-zero"),
                maximum_cpu_time: Duration::from_secs(300),
                maximum_processes: NonZeroU32::new(1)
                    .expect("the default process limit is non-zero"),
            }),
        }
    }
}

#[cfg(test)]
#[path = "limits_tests.rs"]
mod tests;
