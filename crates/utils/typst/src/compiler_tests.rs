use super::*;

#[test]
fn font_collections_preserve_each_face_and_shared_backing_bytes() {
    // TTC table offsets are absolute within the collection, unlike standalone
    // font offsets. Reuse bundled fonts to test both CFF and TrueType faces.
    let sources = typst_assets::fonts().collect::<Vec<_>>();
    let sources = [sources[0], sources[16]];
    let mut collection = Vec::from(&b"ttcf\0\x01\0\0\0\0\0\x02"[..]);
    collection.resize(20, 0);
    for (index, source) in sources.iter().enumerate() {
        while collection.len() % 4 != 0 {
            collection.push(0);
        }
        let offset = collection.len();
        collection[12 + index * 4..16 + index * 4].copy_from_slice(&(offset as u32).to_be_bytes());
        collection.extend_from_slice(source);
        let tables = u16::from_be_bytes(source[4..6].try_into().unwrap()) as usize;
        for table in 0..tables {
            let position = offset + 12 + table * 16 + 8;
            let old = u32::from_be_bytes(collection[position..position + 4].try_into().unwrap());
            collection[position..position + 4]
                .copy_from_slice(&(old + offset as u32).to_be_bytes());
        }
    }
    let data = Bytes::new(collection);
    let faces = Font::iter(data.clone()).collect::<Vec<_>>();
    assert_eq!(faces.len(), 2);
    assert!(Font::new(data, 2).is_none());
    for (index, face) in faces.iter().enumerate() {
        assert_eq!(face.index(), index as u32);
        assert_eq!(face.data().as_ptr(), faces[0].data().as_ptr());
        assert_eq!(
            face.info(),
            Font::new(Bytes::new(sources[index]), 0).unwrap().info()
        );
        let instance = face.clone().instantiate(
            Default::default(),
            typst::layout::Abs::pt(12.0),
            &typst::text::FontVariations::default(),
        );
        let gid = instance.ttf().glyph_index('A').unwrap();
        assert!(instance.x_advance(gid.0).unwrap().get() > 0.0);
        assert!(instance.ttf().glyph_bounding_box(gid).is_some());
    }
}

#[test]
fn complex_scripts_keep_joining_rtl_clusters_and_font_fallback() {
    use typst::layout::Frame;
    use typst::layout::FrameItem;

    fn check(frame: &Frame, arabic: &mut bool, hebrew: &mut bool, fallback: &mut bool) {
        for (_, item) in frame.items() {
            match item {
                FrameItem::Group(group) => check(&group.frame, arabic, hebrew, fallback),
                FrameItem::Text(text) => {
                    for glyph in &text.glyphs {
                        assert_ne!(glyph.id, 0, "missing glyph in {:?}", text.text);
                        assert!(glyph.x_advance.get().is_finite());
                    }
                    if text.text.contains('س') {
                        *arabic = true;
                        assert!(
                            text.glyphs
                                .windows(2)
                                .any(|pair| pair[0].range.start > pair[1].range.start)
                        );
                        // Joining must select contextual forms, rather than just
                        // mapping Arabic Unicode code points to isolated glyphs.
                        assert!(text.glyphs.iter().any(|glyph| {
                            text.text[glyph.range()].chars().next().is_some_and(|ch| {
                                text.font
                                    .ttf()
                                    .glyph_index(ch)
                                    .is_some_and(|isolated| isolated.0 != glyph.id)
                            })
                        }));
                    }
                    if text.text.contains('ש') {
                        *hebrew = true;
                        assert!(
                            text.glyphs
                                .windows(2)
                                .any(|pair| pair[0].range.start > pair[1].range.start)
                        );
                    }
                    if text.text.contains('A') {
                        *fallback = true;
                        assert_eq!(text.font.font().info().family, "Libertinus Serif");
                    }
                }
                _ => {}
            }
        }
    }

    let compiler = TypstCompiler::new();
    let source = r#"#set text(font: "DejaVu Sans Mono", lang: "ar", dir: rtl)
سلام
#set text(font: "Libertinus Serif", lang: "he", dir: rtl)
שלום
#set text(font: ("missing ash font", "Libertinus Serif"), lang: "en", dir: ltr)
Ash fallback"#;
    let world = InMemoryWorld::new(&compiler, source);
    let document = typst::compile(&world)
        .output
        .expect("complex-script sample compiles");
    let pdf = typst_pdf::pdf(&document, &PdfOptions::default()).unwrap();
    let mut arabic = false;
    let mut hebrew = false;
    let mut fallback = false;
    for page in document.pages() {
        check(&page.frame, &mut arabic, &mut hebrew, &mut fallback);
    }
    assert!(arabic && hebrew && fallback);
    assert!(pdf.starts_with(b"%PDF-"));
}

#[test]
fn compiles_ligatures_math_and_svg_text() {
    use typst::layout::Frame;
    use typst::layout::FrameItem;

    fn check_frame(frame: &Frame, glyph_count: &mut usize, ligature: &mut bool) {
        assert!(frame.width().to_pt().is_finite());
        assert!(frame.height().to_pt().is_finite());
        for (_, item) in frame.items() {
            match item {
                FrameItem::Group(group) => check_frame(&group.frame, glyph_count, ligature),
                FrameItem::Text(text) => {
                    for glyph in &text.glyphs {
                        assert_ne!(glyph.id, 0, "missing glyph for {:?}", text.text);
                        assert!(glyph.x_advance.get().is_finite());
                        assert!(glyph.y_advance.get().is_finite());
                        let cluster = &text.text[glyph.range()];
                        if !cluster.chars().all(char::is_whitespace) {
                            // Use Typst's public text geometry to check the shaped
                            // glyph's outline without depending on its font parser.
                            let mut single_glyph = text.clone();
                            single_glyph.glyphs = vec![glyph.clone()];
                            let bounds = single_glyph.bbox();
                            assert!(
                                bounds.size().x.to_pt().is_finite()
                                    && bounds.size().y.to_pt().is_finite(),
                                "visible cluster {cluster:?} must have an outline"
                            );
                        }
                        *glyph_count += 1;
                        *ligature |= matches!(cluster, "ffi" | "ff" | "fi");
                    }
                }
                _ => {}
            }
        }
    }

    let compiler = TypstCompiler::new();
    let source = r#"#set text(font: "Libertinus Serif")
office affine café é
$ lr((frac(1, sum_(i=1)^n i))) + hat(x) + sqrt(x^2 + y^2) + integral_0^1 f(x) dif x $
#image(bytes("<svg xmlns='http://www.w3.org/2000/svg' width='140' height='30'><text x='0' y='20' font-family='Libertinus Serif'>SVG office</text></svg>"))"#;
    let world = InMemoryWorld::new(&compiler, source);
    let compiled = typst::compile(&world);
    assert!(compiled.warnings.is_empty(), "{:?}", compiled.warnings);
    let document = compiled.output.expect("font and SVG sample compiles");
    let pdf = typst_pdf::pdf(&document, &PdfOptions::default()).unwrap();
    let mut glyph_count = 0;
    let mut ligature = false;
    for page in document.pages() {
        check_frame(&page.frame, &mut glyph_count, &mut ligature);
    }
    assert!(
        glyph_count > 30,
        "text and stretched math must produce glyphs"
    );
    assert!(ligature, "Latin ligatures must still be shaped");
    assert!(pdf.starts_with(b"%PDF-"));
}

const CSL_STYLE: &str = r#"<style xmlns="http://purl.org/net/xbiblio/csl" version="1.0" class="in-text">
  <info>
    <title>Ash test style</title>
    <id>https://example.invalid/ash-test-style</id>
    <updated>2026-10-10T00:00:00+00:00</updated>
  </info>
  <citation><layout><text variable="title"/></layout></citation>
  <bibliography><layout><text variable="title"/></layout></bibliography>
</style>"#;

fn bibliography_source(style: &str) -> String {
    format!(
        r#"A citation: @paper.
#bibliography(
  bytes("@article{{paper, title={{Test Paper}}, author={{Doe, Jane}}, year={{2026}}}}"),
  style: bytes({style:?}),
)"#
    )
}

#[test]
fn compiles_in_memory_bibliography_with_custom_xml_style() {
    let outcome = TypstCompiler::new()
        .compile(&bibliography_source(CSL_STYLE))
        .unwrap();

    let TypstCompileOutcome::Success(success) = outcome else {
        panic!("custom CSL style should compile: {outcome:?}");
    };
    assert!(success.pdf.starts_with(b"%PDF-"));
    assert!(success.warnings.is_empty(), "{:?}", success.warnings);
}

#[test]
fn rejects_xml_style_with_excessive_namespace_declarations() {
    // This exercises quick-xml's namespace allocation limit through the actual
    // compiler boundary. The vulnerable parser accepted unbounded declarations.
    let compiler = TypstCompiler::new();
    for extra_namespaces in [255, 256] {
        let declarations = (0..extra_namespaces)
            .map(|index| format!("xmlns:n{index}=\"urn:ash:test:{index}\" "))
            .collect::<String>();
        let style = CSL_STYLE.replacen("<style ", &format!("<style {declarations}"), 1);
        let outcome = compiler.compile(&bibliography_source(&style)).unwrap();

        match (extra_namespaces, outcome) {
            (255, TypstCompileOutcome::Success(success)) => {
                assert!(success.pdf.starts_with(b"%PDF-"));
            }
            (256, TypstCompileOutcome::Failed { diagnostics }) => {
                // citationberg reports the deserialization path rather than the
                // underlying namespace error; assert the consumer's actual contract.
                assert!(diagnostics.iter().any(|diagnostic| {
                    diagnostic.message.starts_with("failed to load CSL style")
                        && diagnostic.range.is_some()
                }));
            }
            (_, outcome) => panic!(
                "256 total namespaces must compile, 257 must fail; extra={extra_namespaces}: {outcome:?}"
            ),
        }
    }
}

#[test]
fn compiles_highlighted_code_with_bundled_and_custom_syntaxes() {
    let source = r#"```rust
fn main() { println!("Ash"); }
```
#set raw(syntaxes: (bytes("%YAML 1.2\n---\nname: Ash Test\nscope: source.ash-test\nfile_extensions: [ashtest]\ncontexts:\n  main:\n    - match: '\\bhello\\b'\n      scope: keyword.control\n"),))
```ashtest
hello world
```"#;
    let outcome = TypstCompiler::new().compile(source).unwrap();

    let TypstCompileOutcome::Success(success) = outcome else {
        panic!("bundled and custom YAML syntax definitions should compile: {outcome:?}");
    };
    assert!(success.pdf.starts_with(b"%PDF-"));
    assert!(success.warnings.is_empty(), "{:?}", success.warnings);
}

#[test]
fn reports_invalid_custom_yaml_syntax_as_a_source_diagnostic() {
    let source = r#"#set raw(syntaxes: (bytes("%YAML 1.2\n---\nname: [unterminated\n"),))
```ashtest
hello world
```"#;
    let outcome = TypstCompiler::new().compile(source).unwrap();

    let TypstCompileOutcome::Failed { diagnostics } = outcome else {
        panic!("invalid YAML syntax should return a diagnostic: {outcome:?}");
    };
    assert!(diagnostics.iter().any(|diagnostic| {
        diagnostic.message.contains("failed to parse syntax") && diagnostic.range.is_some()
    }));
}

#[test]
fn compiles_a_paper_fragment_to_pdf() {
    let outcome = TypstCompiler::new()
        .compile("= A Paper\n\nA formula: $x^2 + y^2 = z^2$.")
        .unwrap();

    let TypstCompileOutcome::Success(success) = outcome else {
        panic!("valid source should compile");
    };
    assert!(success.pdf.starts_with(b"%PDF-"));
}

#[test]
fn reports_source_diagnostics_with_byte_ranges() {
    let outcome = TypstCompiler::new().compile("#let =").unwrap();

    let TypstCompileOutcome::Failed { diagnostics } = outcome else {
        panic!("invalid source should return diagnostics");
    };
    assert!(!diagnostics.is_empty());
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.range.is_some())
    );
}

#[test]
fn denies_host_file_access() {
    let outcome = TypstCompiler::new()
        .compile("#read(\"secret.txt\")")
        .unwrap();

    let TypstCompileOutcome::Failed { diagnostics } = outcome else {
        panic!("host file access should fail");
    };
    assert!(
        diagnostics
            .iter()
            .any(|diagnostic| diagnostic.message.contains("access denied"))
    );
}

#[test]
fn rejects_sources_over_the_byte_limit() {
    let source = "a".repeat(MAX_TYPST_SOURCE_BYTES + 1);
    assert_eq!(
        TypstCompiler::new().compile(&source),
        Err(TypstCompileError::SourceTooLarge {
            actual_bytes: MAX_TYPST_SOURCE_BYTES + 1,
            max_bytes: MAX_TYPST_SOURCE_BYTES,
        })
    );
}
