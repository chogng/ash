fn main() -> Result<(), Box<dyn std::error::Error>> {
    let check = match std::env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [] => false,
        [argument] if argument == "--check" => true,
        _ => return Err("usage: generate-model-catalog-schema [--check]".into()),
    };
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("models.schema.json");
    let contents = format!(
        "{}\n",
        serde_json::to_string_pretty(&model_provider_info::model_catalog_schema())?
    );
    if check {
        if std::fs::read_to_string(&path)? != contents {
            return Err(
                "model catalog schema is outdated; run just generate-model-catalog-schema".into(),
            );
        }
    } else {
        std::fs::write(path, contents)?;
    }
    Ok(())
}
