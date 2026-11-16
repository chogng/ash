use super::*;

#[path = "../tests/support/mod.rs"]
mod support;
use support::fixture;

struct TestResult {
    page: PdfPage,
    image: Vec<u8>,
    modified: Option<Vec<u8>>,
}

fn execute(bytes: &[u8], edit: Option<PdfAnnotationEdit>) -> TestResult {
    static NATIVE: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = NATIVE.lock().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source.pdf");
    let image = directory.path().join("page.png");
    let modified = edit.as_ref().map(|_| directory.path().join("modified.pdf"));
    std::fs::write(&source, bytes).unwrap();
    let pdfium = engine::bind().unwrap();
    let document = pdfium.load_pdf_from_byte_slice(bytes, None).unwrap();
    let result = engine::execute(
        &document,
        EngineRequest {
            source,
            image: image.clone(),
            modified: modified.clone(),
            page: 1,
            dimension: 800,
            output: PdfOutput::Image,
            edit,
        },
        "test-source",
        bytes.len(),
    )
    .unwrap();
    TestResult {
        page: result.page,
        image: std::fs::read(image).unwrap(),
        modified: modified.map(|path| std::fs::read(path).unwrap()),
    }
}

#[test]
fn reads_text_and_renders_real_pdf_pixels() {
    let result = execute(&fixture(0), None);
    assert!(result.page.text.contains("aspdf native review"));
    assert!(!result.page.characters.is_empty());
    assert_eq!(result.page.page_count, 1);
    let png = result.image;
    let image = image::load_from_memory(&png).unwrap().to_rgb8();
    assert!(
        image
            .pixels()
            .any(|pixel| pixel.0.iter().any(|channel| *channel < 100))
    );
}

#[test]
fn standard_annotations_round_trip_and_use_rotated_page_coordinates() {
    for rotation in [0, 90, 180, 270] {
        let bounds = PdfRect {
            x: 0.15,
            y: 0.25,
            width: 0.25,
            height: 0.1,
        };
        let highlight = execute(
            &fixture(rotation),
            Some(PdfAnnotationEdit::Highlight {
                bounds: bounds.clone(),
                contents: "Check the evidence".into(),
            }),
        );
        let bytes = highlight.modified.unwrap();
        let reopened = execute(&bytes, None);
        let annotation = &reopened.page.annotations[0];
        assert_eq!(annotation.kind, "Highlight");
        assert_eq!(annotation.contents, "Check the evidence");
        assert!(
            (annotation.bounds.x - bounds.x).abs() < 0.02,
            "rotation={rotation}"
        );
        assert!(
            (annotation.bounds.y - bounds.y).abs() < 0.02,
            "rotation={rotation}"
        );
        let updated = execute(
            &bytes,
            Some(PdfAnnotationEdit::Update {
                index: 0,
                contents: "Reviewed".into(),
            }),
        );
        let bytes = updated.modified.unwrap();
        assert_eq!(
            execute(&bytes, None).page.annotations[0].contents,
            "Reviewed"
        );
        let deleted = execute(&bytes, Some(PdfAnnotationEdit::Delete { index: 0 }));
        assert!(
            execute(&deleted.modified.unwrap(), None)
                .page
                .annotations
                .is_empty()
        );
        let note = execute(
            &bytes,
            Some(PdfAnnotationEdit::Note {
                bounds,
                contents: "Reviewer note".into(),
            }),
        );
        assert!(
            execute(&note.modified.unwrap(), None)
                .page
                .annotations
                .iter()
                .any(|annotation| annotation.contents == "Reviewer note")
        );
    }
}

#[test]
fn imports_are_bounded_and_connection_owned() {
    let service = PdfService::new(std::path::PathBuf::from("unused"));
    service.open(1, "document", 4).unwrap();
    assert!(matches!(
        service.append(2, "document", 0, b"data"),
        Err(PdfError::NotFound)
    ));
    assert!(matches!(
        service.append(1, "document", 1, b"data"),
        Err(PdfError::Invalid)
    ));
    assert_eq!(service.append(1, "document", 0, b"data").unwrap(), 4);
    assert!(matches!(
        service.open(1, "document", 4),
        Err(PdfError::Conflict)
    ));
    assert!(matches!(
        service.read(1, "document", 1, false, None, 0, 4),
        Err(PdfError::Conflict)
    ));
    service.close_owner(1);
    assert!(matches!(
        service.read(1, "document", 0, false, None, 0, 4),
        Err(PdfError::NotFound)
    ));
}
