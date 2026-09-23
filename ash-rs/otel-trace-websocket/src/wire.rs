use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use opentelemetry_proto::tonic::trace::v1::ResourceSpans;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SpanData;
use std::io;
use std::io::Write;

pub(super) fn encode(span: SpanData, resource: &Resource) -> io::Result<String> {
    let request = ExportTraceServiceRequest {
        resource_spans: vec![ResourceSpans::new(span, &resource.into())],
    };
    let mut output = BoundedFrame(Vec::new());
    serde_json::to_writer(&mut output, &request)?;
    Ok(String::from_utf8(output.0).expect("JSON is UTF-8"))
}

struct BoundedFrame(Vec<u8>);

impl Write for BoundedFrame {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if bytes.len() > super::MAX_FRAME_BYTES - self.0.len() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "trace span exceeds 64 KiB",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
