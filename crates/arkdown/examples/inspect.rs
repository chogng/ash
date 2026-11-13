use ash_arkdown::Document;
use ash_arkdown::Transaction;
use ash_arkdown::render_html;
use serde::Deserialize;
use std::io::Read;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    source: String,
    #[serde(default)]
    transactions: Vec<Transaction>,
}

/// JSON-in/JSON-out native host used to exercise the same core as the WASM adapter.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin()
        .take((ash_arkdown::MAX_SOURCE_BYTES + 1) as u64)
        .read_to_string(&mut input)?;
    if input.len() > ash_arkdown::MAX_SOURCE_BYTES {
        return Err("request exceeds document limit".into());
    }
    let input: Input = serde_json::from_str(&input)?;
    let mut document = Document::new(input.source)?;
    let mut changes = Vec::new();
    for transaction in input.transactions {
        changes.push(document.apply(transaction)?);
    }
    println!(
        "{}",
        serde_json::to_string(&serde_json::json!({
            "snapshot": document.snapshot()?, "html": render_html(document.source())?, "changes": changes,
        }))?
    );
    Ok(())
}
