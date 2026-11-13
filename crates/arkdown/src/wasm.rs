use crate::Document;
use crate::Error;
use crate::MAX_SOURCE_BYTES;
use crate::SourceIndex;
use crate::TextEdit;
use crate::Transaction;
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
