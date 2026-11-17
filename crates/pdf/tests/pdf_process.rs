//! Real helper-process acceptance and a native service fixture for the browser integration.
use ash_pdf::PdfService;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use serde_json::json;
use std::io::BufRead;
use std::io::Write;

mod support;

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some(ash_pdf::WORKER_ARGUMENT) => {
            if let Err(error) = ash_pdf::run_worker() {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        Some("--fixture") => serve(),
        _ => {
            let service = PdfService::new(std::env::current_exe().unwrap());
            service.open(1, "malformed", 4).unwrap();
            service.append(1, "malformed", 0, b"nope").unwrap();
            assert!(service.page(1, "malformed", 0, 1, 800, None).is_err());
            service.close_owner(1);
            assert!(service.page(1, "malformed", 0, 1, 800, None).is_err());
            real_document_acceptance(&service);
            println!("aspdf helper rejects malformed input and releases connection resources");
        }
    }
}

fn serve() {
    let service = PdfService::new(std::env::current_exe().unwrap());
    for line in std::io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let result = dispatch(&service, &request);
        let reply = match result {
            Ok(result) => json!({ "id": request["id"], "result": result }),
            Err(error) => json!({ "id": request["id"], "error": error }),
        };
        println!("{reply}");
        std::io::stdout().flush().unwrap();
    }
}

fn dispatch(service: &PdfService, request: &Value) -> Result<Value, String> {
    let params = &request["params"];
    let id = params["documentId"].as_str().ok_or("Missing document ID")?;
    let number = |key: &str| {
        params[key]
            .as_u64()
            .map(|value| value as usize)
            .ok_or_else(|| key.to_string())
    };
    let fail = |error: ash_pdf::PdfError| error.to_string();
    match request["method"].as_str().ok_or("Missing method")? {
        "pdf/process" => {
            let bytes = STANDARD
                .decode(params["dataBase64"].as_str().ok_or("Missing bytes")?)
                .map_err(|error| error.to_string())?;
            let output = match params["output"].as_str() {
                Some("text") => ash_pdf::PdfOutput::Text,
                Some("image") => ash_pdf::PdfOutput::Image,
                _ => return Err("Missing PDF output mode".into()),
            };
            let (page, image, modified) = service
                .process(&bytes, number("page")? as u32, output, None, || false)
                .map_err(fail)?;
            Ok(json!({ "page": page, "imageBytes": image.len(), "modified": modified.is_some() }))
        }
        "pdf/open" => {
            service.open(1, id, number("size")?).map_err(fail)?;
            Ok(Value::Null)
        }
        "pdf/append" => {
            let bytes = STANDARD
                .decode(params["dataBase64"].as_str().ok_or("Missing bytes")?)
                .map_err(|error| error.to_string())?;
            Ok(
                json!({ "nextOffset": service.append(1, id, number("offset")?, &bytes).map_err(fail)? }),
            )
        }
        "pdf/page" => {
            let edit = serde_json::from_value(params["edit"].clone())
                .map_err(|error| error.to_string())?;
            let page = service
                .page(
                    1,
                    id,
                    number("revision")? as u32,
                    number("page")? as u32,
                    number("dimension")? as u32,
                    edit,
                )
                .map_err(fail)?;
            serde_json::to_value(page).map_err(|error| error.to_string())
        }
        "pdf/read" => {
            let (bytes, eof) = service
                .read(
                    1,
                    id,
                    number("revision")? as u32,
                    params["image"].as_bool().ok_or("Missing image flag")?,
                    params["imageSha256"].as_str(),
                    number("offset")?,
                    number("maxBytes")?,
                )
                .map_err(fail)?;
            Ok(json!({ "dataBase64": STANDARD.encode(bytes), "eof": eof }))
        }
        "pdf/close" => {
            service.close(1, id);
            Ok(Value::Null)
        }
        _ => Err("Unknown fixture method".into()),
    }
}

fn real_document_acceptance(service: &PdfService) {
    use ash_pdf::PdfAnnotationEdit;
    use ash_pdf::PdfOutput;
    use sha2::Digest;
    let source = support::fixture(90);
    let original_digest = format!("{:x}", sha2::Sha256::digest(&source));
    let mut original = None;
    // Three open documents exceed the two-helper pool; revisit each after eviction.
    for id in ["first", "second", "third"] {
        service.open(2, id, source.len()).unwrap();
        service.append(2, id, 0, &source).unwrap();
        original = Some(service.page(2, id, 0, 1, 800, None).unwrap());
    }
    let checks = std::cell::Cell::new(0);
    let cancelled = service.render_page(2, "third", 0, 1, 1024, &|| {
        checks.set(checks.get() + 1);
        checks.get() >= 4
    });
    assert!(matches!(cancelled, Err(ash_pdf::PdfError::Cancelled)));
    assert_eq!(
        service
            .render_page(2, "third", 0, 1, 1024, &|| false)
            .unwrap()
            .page,
        1
    );
    for id in ["first", "second", "third", "first"] {
        let page = service.page(2, id, 0, 1, 512, None).unwrap();
        assert_eq!(page.sha256, original_digest);
        assert!(page.text.contains("aspdf native review"));
        let (image, eof) = service
            .read(
                2,
                id,
                0,
                true,
                Some(&page.image_sha256),
                0,
                ash_pdf::MAX_CHUNK_BYTES,
            )
            .unwrap();
        assert!(eof && image.starts_with(b"\x89PNG"));
        assert_eq!(
            service.page(2, id, 0, 1, 512, None).unwrap().image_sha256,
            page.image_sha256
        );
    }
    let original = original.unwrap();
    let edited = service
        .page(
            2,
            "first",
            0,
            1,
            800,
            Some(PdfAnnotationEdit::Note {
                bounds: ash_pdf::PdfRect {
                    x: 0.1,
                    y: 0.2,
                    width: 0.1,
                    height: 0.1,
                },
                contents: "retained after eviction".into(),
            }),
        )
        .unwrap();
    assert_eq!(edited.revision, 1);
    assert_ne!(edited.sha256, original.sha256);
    assert!(
        service
            .page(
                2,
                "first",
                1,
                1,
                800,
                Some(PdfAnnotationEdit::Delete { index: 100 })
            )
            .is_err()
    );
    let reopened = service.page(2, "first", 1, 1, 512, None).unwrap();
    let (bytes, eof) = service
        .read(2, "first", 1, false, None, 0, ash_pdf::MAX_CHUNK_BYTES)
        .unwrap();
    assert!(eof);
    assert_eq!(
        reopened.sha256,
        format!("{:x}", sha2::Sha256::digest(&bytes))
    );
    assert_eq!(reopened.annotations[0].contents, "retained after eviction");
    service.close_owner(2);
    let (text, image, modified) = service
        .process(&source, 1, PdfOutput::Text, None, || false)
        .unwrap();
    assert!(text.text.contains("aspdf native review") && image.is_empty() && modified.is_none());
    assert!(text.characters.is_empty());
    assert_eq!(text.image_size, 0);
    assert!(matches!(
        service.process(&source, 1, PdfOutput::Image, None, || true),
        Err(ash_pdf::PdfError::Cancelled)
    ));
}
