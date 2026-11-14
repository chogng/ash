use crate::Document;
use crate::Error;
use crate::MAX_SOURCE_BYTES;
use crate::Operation;
use crate::SourceIndex;
use crate::TextEdit;
use crate::Transaction;
use crate::operation_edits;
use crate::parse;
use crate::render_html;
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// Read-only projection for hosts whose existing text model owns persistence and
/// history. No parallel writable Rust document survives this call.
#[wasm_bindgen(js_name = parseMarkdownJson)]
pub fn parse_markdown_json(source: &str) -> Result<String, JsValue> {
    encode(&parse(source).map_err(js_error)?)
}

/// Disposable read-only cache; the host text model remains the source authority.
#[wasm_bindgen(js_name = ArkdownProjection)]
#[derive(Default)]
pub struct BrowserProjection {
    projection: crate::incremental::Projection,
}

#[wasm_bindgen(js_class = ArkdownProjection)]
impl BrowserProjection {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    #[wasm_bindgen(js_name = parseJson)]
    pub fn parse_json(&mut self, source: &str) -> Result<String, JsValue> {
        encode(&self.projection.parse(source).map_err(js_error)?)
    }
}

/// Normalizes and validates a proposal before the Workbench text model commits
/// it. The host must still check its own version before publishing the edits.
#[wasm_bindgen(js_name = validateMarkdownEditsJson)]
pub fn validate_markdown_edits_json(source: &str, json: &str) -> Result<String, JsValue> {
    if json.len() > MAX_SOURCE_BYTES {
        return Err(js_error(Error::SourceTooLarge {
            bytes: json.len(),
            limit: MAX_SOURCE_BYTES,
        }));
    }
    let edits: Vec<TextEdit> = serde_json::from_str(json).map_err(|error| {
        js_error(Error::InvalidRequest {
            message: error.to_string(),
        })
    })?;
    let mut document = Document::new(source).map_err(js_error)?;
    encode(
        &document
            .apply(Transaction {
                expected_revision: 0,
                edits,
            })
            .map_err(js_error)?
            .edits,
    )
}

/// Returns structural edits for a host-owned text model without mutating it.
#[wasm_bindgen(js_name = markdownOperationEditsJson)]
pub fn markdown_operation_edits_json(source: &str, json: &str) -> Result<String, JsValue> {
    let operation: Operation = decode(json)?;
    encode(&operation_edits(source, operation).map_err(js_error)?)
}

fn decode<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, JsValue> {
    if json.len() > MAX_SOURCE_BYTES {
        return Err(js_error(Error::SourceTooLarge {
            bytes: json.len(),
            limit: MAX_SOURCE_BYTES,
        }));
    }
    serde_json::from_str(json).map_err(|error| {
        js_error(Error::InvalidRequest {
            message: error.to_string(),
        })
    })
}

/// Thin browser boundary; source and history live exclusively in the Rust core.
#[wasm_bindgen(js_name = ArkdownDocument)]
pub struct BrowserDocument {
    document: Document,
}

#[wasm_bindgen(js_class = ArkdownDocument)]
impl BrowserDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(source: String) -> Result<BrowserDocument, JsValue> {
        Ok(Self {
            document: Document::new(source).map_err(js_error)?,
        })
    }

    #[wasm_bindgen(getter)]
    pub fn source(&self) -> String {
        self.document.source().to_owned()
    }

    #[wasm_bindgen(getter)]
    pub fn revision(&self) -> u32 {
        self.document.revision()
    }

    #[wasm_bindgen(getter, js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.document.can_undo()
    }

    #[wasm_bindgen(getter, js_name = canRedo)]
    pub fn can_redo(&self) -> bool {
        self.document.can_redo()
    }

    #[wasm_bindgen(js_name = snapshotJson)]
    pub fn snapshot_json(&self) -> Result<String, JsValue> {
        encode(&self.document.snapshot().map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = applyTransactionJson)]
    pub fn apply_transaction_json(&mut self, json: &str) -> Result<String, JsValue> {
        if json.len() > MAX_SOURCE_BYTES {
            return Err(js_error(Error::SourceTooLarge {
                bytes: json.len(),
                limit: MAX_SOURCE_BYTES,
            }));
        }
        let transaction: Transaction = serde_json::from_str(json).map_err(|error| {
            js_error(Error::InvalidRequest {
                message: error.to_string(),
            })
        })?;
        encode(&self.document.apply(transaction).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = applyOperationJson)]
    pub fn apply_operation_json(
        &mut self,
        expected_revision: f64,
        json: &str,
    ) -> Result<String, JsValue> {
        let expected_revision = revision(expected_revision)?;
        let operation: Operation = decode(json)?;
        let edits = operation_edits(self.document.source(), operation).map_err(js_error)?;
        encode(
            &self
                .document
                .apply(Transaction {
                    expected_revision,
                    edits,
                })
                .map_err(js_error)?,
        )
    }

    pub fn undo(&mut self, expected_revision: f64) -> Result<String, JsValue> {
        let revision = revision(expected_revision)?;
        encode(&self.document.undo(revision).map_err(js_error)?)
    }

    pub fn redo(&mut self, expected_revision: f64) -> Result<String, JsValue> {
        let revision = revision(expected_revision)?;
        encode(&self.document.redo(revision).map_err(js_error)?)
    }

    #[wasm_bindgen(js_name = renderHtml)]
    pub fn render_html(&self) -> Result<String, JsValue> {
        render_html(self.document.source()).map_err(js_error)
    }

    #[wasm_bindgen(js_name = previousGrapheme)]
    pub fn previous_grapheme(&self, offset: f64) -> Result<u32, JsValue> {
        SourceIndex::new(self.document.source())
            .map_err(js_error)?
            .previous_grapheme(revision(offset)?)
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = nextGrapheme)]
    pub fn next_grapheme(&self, offset: f64) -> Result<u32, JsValue> {
        SourceIndex::new(self.document.source())
            .map_err(js_error)?
            .next_grapheme(revision(offset)?)
            .map_err(js_error)
    }
}

/// Independent collaborative session. This is an alternative source/history owner
/// to a Workbench TextModel, never a second writable owner attached to that model.
#[wasm_bindgen(js_name = ArkdownBuffer)]
pub struct BrowserBuffer {
    document: crate::Buffer,
}

#[wasm_bindgen(js_class = ArkdownBuffer)]
impl BrowserBuffer {
    #[wasm_bindgen(constructor)]
    pub fn new(client_id: f64, source: &str) -> Result<BrowserBuffer, JsValue> {
        if !client_id.is_finite()
            || client_id.fract() != 0.0
            || !(1.0..=9_007_199_254_740_991.0).contains(&client_id)
        {
            return Err(js_error(Error::InvalidRequest {
                message: "Client ID must be a nonzero JavaScript-safe integer".to_owned(),
            }));
        }
        Ok(Self {
            document: crate::Buffer::new(client_id as u64, source).map_err(js_error)?,
        })
    }
    #[wasm_bindgen(getter)]
    pub fn source(&self) -> String {
        self.document.source()
    }
    #[wasm_bindgen(getter)]
    pub fn revision(&self) -> u32 {
        self.document.revision()
    }
    #[wasm_bindgen(getter, js_name = canUndo)]
    pub fn can_undo(&self) -> bool {
        self.document.can_undo()
    }
    #[wasm_bindgen(getter, js_name = canRedo)]
    pub fn can_redo(&self) -> bool {
        self.document.can_redo()
    }
    #[wasm_bindgen(js_name = applyTransactionJson)]
    pub fn apply_transaction_json(&mut self, json: &str) -> Result<String, JsValue> {
        encode(&self.document.apply(decode(json)?).map_err(js_error)?)
    }
    #[wasm_bindgen(js_name = applyOperationJson)]
    pub fn apply_operation_json(
        &mut self,
        expected_revision: f64,
        json: &str,
    ) -> Result<String, JsValue> {
        let edits = operation_edits(&self.document.source(), decode(json)?).map_err(js_error)?;
        encode(
            &self
                .document
                .apply(Transaction {
                    expected_revision: revision(expected_revision)?,
                    edits,
                })
                .map_err(js_error)?,
        )
    }
    #[wasm_bindgen(js_name = applyUpdate)]
    pub fn apply_update(&mut self, update: &[u8]) -> Result<String, JsValue> {
        encode(&self.document.apply_update(update).map_err(js_error)?)
    }
    #[wasm_bindgen(js_name = previewJson)]
    pub fn preview_json(&self, json: &str, vector: &[u8]) -> Result<String, JsValue> {
        encode(
            &self
                .document
                .preview(decode(json)?, vector)
                .map_err(js_error)?,
        )
    }
    #[wasm_bindgen(js_name = stateVector)]
    pub fn state_vector(&self) -> Vec<u8> {
        self.document.state_vector()
    }
    #[wasm_bindgen(js_name = encodeUpdate)]
    pub fn encode_update(&self, vector: &[u8]) -> Result<Vec<u8>, JsValue> {
        self.document.encode_update(vector).map_err(js_error)
    }
    pub fn undo(&mut self, expected_revision: f64) -> Result<String, JsValue> {
        encode(
            &self
                .document
                .undo(revision(expected_revision)?)
                .map_err(js_error)?,
        )
    }
    pub fn redo(&mut self, expected_revision: f64) -> Result<String, JsValue> {
        encode(
            &self
                .document
                .redo(revision(expected_revision)?)
                .map_err(js_error)?,
        )
    }
}
fn revision(number: f64) -> Result<u32, JsValue> {
    if !number.is_finite()
        || number.fract() != 0.0
        || !(0.0..=f64::from(u32::MAX)).contains(&number)
    {
        return Err(js_error(Error::InvalidRequest {
            message: "Expected an unsigned 32-bit integer".to_owned(),
        }));
    }
    Ok(number as u32)
}

fn js_error(error: Error) -> JsValue {
    JsValue::from_str(&serde_json::to_string(&error).expect("core errors are serializable"))
}

fn encode(value: &impl Serialize) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(|error| {
        js_error(Error::InvalidRequest {
            message: error.to_string(),
        })
    })
}
