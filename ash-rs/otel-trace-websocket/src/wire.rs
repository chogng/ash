use opentelemetry::Array;
use opentelemetry::InstrumentationScope;
use opentelemetry::KeyValue;
use opentelemetry::Value;
use opentelemetry::trace::Event;
use opentelemetry::trace::Link;
use opentelemetry::trace::SpanKind;
use opentelemetry::trace::Status;
use opentelemetry_sdk::Resource;
use opentelemetry_sdk::trace::SpanData;
use serde::Serialize;
use serde::Serializer;
use serde::ser::SerializeMap;
use std::fmt::Display;
use std::io;
use std::io::Write;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub(super) fn encode(span: &SpanData, resource: &Resource, sequence: u64) -> io::Result<String> {
    let mut output = BoundedFrame(Vec::new());
    serde_json::to_writer(
        &mut output,
        &Frame {
            span,
            resource,
            sequence,
        },
    )?;
    Ok(String::from_utf8(output.0).expect("JSON is UTF-8"))
}

struct Frame<'a> {
    span: &'a SpanData,
    resource: &'a Resource,
    sequence: u64,
}

impl Serialize for Frame<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let span = self.span;
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("type", "span")?;
        map.serialize_entry("sequence", &Text(self.sequence))?;
        map.serialize_entry("traceId", &Text(span.span_context.trace_id()))?;
        map.serialize_entry("spanId", &Text(span.span_context.span_id()))?;
        map.serialize_entry("parentSpanId", &Text(span.parent_span_id))?;
        map.serialize_entry("parentIsRemote", &span.parent_span_is_remote)?;
        map.serialize_entry("traceFlags", &span.span_context.trace_flags().to_u8())?;
        map.serialize_entry("traceState", &span.span_context.trace_state().header())?;
        map.serialize_entry("name", &span.name)?;
        map.serialize_entry(
            "kind",
            match span.span_kind {
                SpanKind::Client => "Client",
                SpanKind::Server => "Server",
                SpanKind::Producer => "Producer",
                SpanKind::Consumer => "Consumer",
                SpanKind::Internal => "Internal",
            },
        )?;
        map.serialize_entry("startTimeUnixNano", &timestamp(span.start_time))?;
        map.serialize_entry("endTimeUnixNano", &timestamp(span.end_time))?;
        map.serialize_entry("attributes", &attributes(&span.attributes))?;
        map.serialize_entry("droppedAttributes", &span.dropped_attributes_count)?;
        map.serialize_entry("events", &Items(|| span.events.iter().map(SpanEvent)))?;
        map.serialize_entry("droppedEvents", &span.events.dropped_count)?;
        map.serialize_entry("links", &Items(|| span.links.iter().map(SpanLink)))?;
        map.serialize_entry("droppedLinks", &span.links.dropped_count)?;
        map.serialize_entry("status", &SpanStatus(&span.status))?;
        map.serialize_entry("scope", &Scope(&span.instrumentation_scope))?;
        map.serialize_entry("resource", &SpanResource(self.resource))?;
        map.end()
    }
}

struct SpanEvent<'a>(&'a Event);

impl Serialize for SpanEvent<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("name", &self.0.name)?;
        map.serialize_entry("timeUnixNano", &timestamp(self.0.timestamp))?;
        map.serialize_entry("attributes", &attributes(&self.0.attributes))?;
        map.serialize_entry("droppedAttributes", &self.0.dropped_attributes_count)?;
        map.end()
    }
}

struct SpanLink<'a>(&'a Link);

impl Serialize for SpanLink<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("traceId", &Text(self.0.span_context.trace_id()))?;
        map.serialize_entry("spanId", &Text(self.0.span_context.span_id()))?;
        map.serialize_entry("traceFlags", &self.0.span_context.trace_flags().to_u8())?;
        map.serialize_entry("traceState", &self.0.span_context.trace_state().header())?;
        map.serialize_entry("attributes", &attributes(&self.0.attributes))?;
        map.serialize_entry("droppedAttributes", &self.0.dropped_attributes_count)?;
        map.end()
    }
}

struct SpanStatus<'a>(&'a Status);

impl Serialize for SpanStatus<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self.0 {
            Status::Unset => map.serialize_entry("code", "unset")?,
            Status::Ok => map.serialize_entry("code", "ok")?,
            Status::Error { description } => {
                map.serialize_entry("code", "error")?;
                map.serialize_entry("description", description)?;
            }
        }
        map.end()
    }
}

struct Scope<'a>(&'a InstrumentationScope);

impl Serialize for Scope<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("name", self.0.name())?;
        map.serialize_entry("version", &self.0.version())?;
        map.serialize_entry("schemaUrl", &self.0.schema_url())?;
        map.serialize_entry(
            "attributes",
            &Items(|| {
                self.0.attributes().map(|value| Attribute {
                    key: value.key.as_str(),
                    value: AttributeValue(&value.value),
                })
            }),
        )?;
        map.end()
    }
}

struct SpanResource<'a>(&'a Resource);

impl Serialize for SpanResource<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("schemaUrl", &self.0.schema_url())?;
        map.serialize_entry(
            "attributes",
            &Items(|| {
                self.0.iter().map(|(key, value)| Attribute {
                    key: key.as_str(),
                    value: AttributeValue(value),
                })
            }),
        )?;
        map.end()
    }
}

fn timestamp(time: SystemTime) -> String {
    match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_nanos().to_string(),
        Err(error) => format!("-{}", error.duration().as_nanos()),
    }
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

fn attributes(values: &[KeyValue]) -> impl Serialize + '_ {
    Items(move || {
        values.iter().map(|attribute| Attribute {
            key: attribute.key.as_str(),
            value: AttributeValue(&attribute.value),
        })
    })
}

#[derive(Serialize)]
struct Attribute<'a> {
    key: &'a str,
    value: AttributeValue<'a>,
}

struct AttributeValue<'a>(&'a Value);

impl Serialize for AttributeValue<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(2))?;
        let kind = match self.0 {
            Value::Bool(_) => "bool",
            Value::I64(_) => "int",
            Value::F64(_) => "double",
            Value::String(_) => "string",
            Value::Array(Array::Bool(_)) => "bool[]",
            Value::Array(Array::I64(_)) => "int[]",
            Value::Array(Array::F64(_)) => "double[]",
            Value::Array(Array::String(_)) => "string[]",
            _ => {
                return Err(serde::ser::Error::custom(
                    "unsupported trace attribute type",
                ));
            }
        };
        map.serialize_entry("type", kind)?;
        // Decimal strings preserve i64 precision and non-finite float values in browsers.
        match self.0 {
            Value::Bool(value) => map.serialize_entry("value", value)?,
            Value::I64(value) => map.serialize_entry("value", &Text(value))?,
            Value::F64(value) => map.serialize_entry("value", &Text(value))?,
            Value::String(value) => map.serialize_entry("value", value.as_str())?,
            Value::Array(Array::Bool(values)) => map.serialize_entry("value", values)?,
            Value::Array(Array::I64(values)) => {
                map.serialize_entry("value", &Items(|| values.iter().map(Text)))?
            }
            Value::Array(Array::F64(values)) => {
                map.serialize_entry("value", &Items(|| values.iter().map(Text)))?
            }
            Value::Array(Array::String(values)) => map.serialize_entry(
                "value",
                &Items(|| values.iter().map(|value| value.as_str())),
            )?,
            _ => unreachable!("attribute type checked above"),
        }
        map.end()
    }
}

struct Text<T>(T);

impl<T: Display> Serialize for Text<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

struct Items<I>(I);

impl<F, I> Serialize for Items<F>
where
    F: Fn() -> I,
    I: Iterator,
    I::Item: Serialize,
{
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq((self.0)())
    }
}

#[cfg(test)]
#[path = "wire_tests.rs"]
mod tests;
