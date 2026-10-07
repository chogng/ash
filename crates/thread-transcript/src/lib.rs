//! Backend-owned assembly of render-neutral Thread transcript entries.

mod accumulator;
mod model;

pub use accumulator::TranscriptAccumulator;
pub use accumulator::TranscriptApplyResult;
pub use model::ThreadTranscriptChange;
pub use model::ThreadTranscriptEntry;
pub use model::ThreadTranscriptSnapshot;
pub use model::ThreadTranscriptUpdateEnvelope;

#[cfg(test)]
#[path = "transcript_tests.rs"]
mod tests;
