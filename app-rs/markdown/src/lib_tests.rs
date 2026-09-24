use ash_ui_components::{ScrollAxis, ScrollCommand, ScrollDelta, ScrollMetrics, ScrollState};
use zui::ui::{Color, Component, FontFamily, FontStyle, FontWeight, Point, Rect, Size, UiScene};

use super::{
    MarkdownDocument, MarkdownError, MarkdownImages, MarkdownLayoutEngine, MarkdownLinkError,
    MarkdownLinkPolicy, MarkdownLinkScheme, MarkdownPresentation, MarkdownSearchCase,
    MarkdownSelection, MarkdownSemanticRole, MarkdownStyle, MarkdownTextPosition,
    SyntectMarkdownHighlighter, decode_markdown_image,
};
use crate::document::MarkdownBlockKind;
use image::ImageEncoder;
use zui::ui::ImageId;

#[test]
fn parses_commonmark_blocks_and_retains_inline_semantics() {
    let document = MarkdownDocument::parse(
        "# Heading\n\nPlain **bold** *italic* `code` [link](https://example.com).",
    )
    .unwrap();

    assert_eq!(document.block_count(), 2);
    let MarkdownBlockKind::Heading { level, runs } = &document.blocks[0].kind else {
        panic!("first block must be a heading");
    };
    assert_eq!(*level, 1);
    assert_eq!(runs[0].text, "Heading");
    let MarkdownBlockKind::Paragraph(runs) = &document.blocks[1].kind else {
        panic!("second block must be a paragraph");
    };
    assert!(
        runs.iter()
            .any(|run| run.text == "bold" && run.format.strong)
    );
    assert!(
        runs.iter()
            .any(|run| run.text == "italic" && run.format.emphasis)
    );
    assert!(runs.iter().any(|run| run.text == "code" && run.format.code));
    assert!(runs.iter().any(|run| {
        run.text == "link" && run.format.link.as_deref() == Some("https://example.com")
    }));
}

#[test]
fn parses_lists_quotes_code_tables_and_task_markers() {
    let document = MarkdownDocument::parse(
        "> - [x] complete\n\
         > - pending\n\n\
         ```rust\nfn main() {}\n```\n\n\
         | A | B |\n| - | - |\n| 1 | 2 |",
    )
    .unwrap();

    assert!(
        document.blocks.iter().any(|block| {
            block.context.quote_depth == 1
                && block.context.marker.as_deref() == Some("☑")
                && matches!(block.kind, MarkdownBlockKind::Paragraph(_))
        }),
        "{:#?}",
        document.blocks
    );
    assert!(document.blocks.iter().any(|block| {
        matches!(
            &block.kind,
            MarkdownBlockKind::CodeBlock {
                language: Some(language),
                text,
            } if language == "rust" && text == "fn main() {}"
        )
    }));
    let table = document.blocks.iter().find_map(|block| match &block.kind {
        MarkdownBlockKind::Table(table) => Some(table),
        _ => None,
    });
    let table = table.expect("table must remain a structured block");
    assert_eq!(table.column_count(), 2);
    assert_eq!(table.rows.len(), 2);
    assert!(table.rows[0].header);
    assert!(!table.rows[1].header);
    assert_eq!(table.rows[0].cells[0][0].text, "A");
    assert_eq!(table.rows[1].cells[1][0].text, "2");
}

#[test]
fn list_marker_is_preserved_for_non_paragraph_blocks() {
    let document = MarkdownDocument::parse("- ### Nested heading").unwrap();

    assert!(matches!(
        &document.blocks[0],
        crate::document::MarkdownBlock {
            kind: MarkdownBlockKind::Heading { level: 3, .. },
            context,
        } if context.marker.as_deref() == Some("•")
    ));
}

#[test]
fn raw_html_is_visible_text_and_oversized_input_is_rejected() {
    let document = MarkdownDocument::parse("<script>alert('visible')</script>").unwrap();
    let MarkdownBlockKind::Paragraph(runs) = &document.blocks[0].kind else {
        panic!("raw HTML must be projected as visible text");
    };
    assert_eq!(
        runs.iter().map(|run| run.text.as_str()).collect::<String>(),
        "<script>alert('visible')</script>"
    );

    let error = MarkdownDocument::parse(&"x".repeat(4 * 1024 * 1024 + 1)).unwrap_err();
    assert!(matches!(error, MarkdownError::InputTooLarge { .. }));
}

#[test]
fn layout_paints_rich_text_and_block_surfaces() {
    let document = MarkdownDocument::parse(
        "## Title\n\n**bold** *italic* `code`\n\n> quoted\n\n```rs\nlet x = 1;\n```",
    )
    .unwrap();
    let bounds = Rect::from_xywh(10.0, 20.0, 260.0, 400.0);
    let mut engine = MarkdownLayoutEngine::new();
    let markdown = engine.layout(
        bounds,
        &document,
        ScrollState::default(),
        &MarkdownStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    markdown.paint(&mut scene);

    assert!(markdown.content_height() > 0.0);
    assert!(scene.text_blocks().iter().any(|block| {
        block
            .spans()
            .iter()
            .any(|span| span.text() == "bold" && span.style().weight() == FontWeight::Bold)
    }));
    assert!(scene.text_blocks().iter().any(|block| {
        block
            .spans()
            .iter()
            .any(|span| span.text() == "italic" && span.style().style() == FontStyle::Italic)
    }));
    assert!(scene.text_blocks().iter().any(|block| {
        block
            .spans()
            .iter()
            .any(|span| span.text() == "code" && span.style().family() == &FontFamily::Monospace)
    }));
    assert!(scene.rects().len() >= 2);
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "let x = 1;")
    );
}

#[test]
fn wrapping_and_viewport_scrolling_share_clamped_content_geometry() {
    let document = MarkdownDocument::parse(
        "A deliberately long paragraph that wraps over several visual lines in a narrow viewport.\n\n\
         Another paragraph keeps the document taller than its viewport.",
    )
    .unwrap();
    let bounds = Rect::from_xywh(0.0, 0.0, 110.0, 40.0);
    let style = MarkdownStyle::light();
    let mut engine = MarkdownLayoutEngine::new();
    let initial = engine.layout(bounds, &document, ScrollState::default(), &style);
    let mut scroll = ScrollState::default();

    assert!(initial.content_height() > bounds.size.height);
    let metrics = ScrollMetrics::new(
        bounds.size,
        Size::new(bounds.size.width, initial.content_height()),
    );
    assert!(scroll.apply(
        ScrollCommand::ByPixels(ScrollDelta::vertical(10_000.0)),
        metrics,
        ScrollAxis::Vertical,
    ));
    let scrolled = engine.layout(bounds, &document, scroll, &style);

    assert_eq!(
        scrolled.vertical_offset(),
        initial.content_height() - bounds.size.height
    );
}

#[test]
fn inline_decorations_links_and_table_cells_use_shaped_geometry() {
    let document = MarkdownDocument::parse(
        "before `code` [link](https://example.com) and ~~old~~\n\n\
         | First | Second column |\n| --- | --- |\n| one | two |",
    )
    .unwrap();
    let inline_background = Color::rgb(250, 220, 230);
    let style = MarkdownStyle::light().with_inline_code_background(inline_background);
    let mut engine = MarkdownLayoutEngine::new();
    let markdown = engine.layout(
        Rect::from_xywh(5.0, 10.0, 280.0, 300.0),
        &document,
        ScrollState::default(),
        &style,
    );
    let link = &markdown.links()[0];
    let first_fragment = link.bounds()[0];
    let hit = Point::new(
        first_fragment.origin.x + first_fragment.size.width * 0.5,
        first_fragment.origin.y + first_fragment.size.height * 0.5,
    );
    let mut scene = UiScene::new(Color::WHITE);

    markdown.paint(&mut scene);

    assert_eq!(link.destination(), "https://example.com");
    assert_eq!(
        markdown.link_at(hit).map(|link| link.destination()),
        Some("https://example.com")
    );
    assert!(
        scene
            .rects()
            .iter()
            .any(|rect| rect.fill() == inline_background)
    );
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "First")
    );
    assert!(
        scene
            .text_blocks()
            .iter()
            .any(|block| block.text() == "Second column")
    );
    assert!(
        scene
            .text_blocks()
            .iter()
            .all(|block| !block.text().contains(" | "))
    );
}

#[test]
fn link_activation_requires_an_explicit_safe_scheme_policy() {
    let https = MarkdownLinkPolicy::safe_default()
        .evaluate("https://example.com/docs")
        .unwrap();
    assert_eq!(
        https.url().map(|url| url.as_str()),
        Some("https://example.com/docs")
    );
    assert!(matches!(
        MarkdownLinkPolicy::safe_default().evaluate("javascript:alert(1)"),
        Err(MarkdownLinkError::UnsupportedScheme(_))
    ));
    assert!(matches!(
        MarkdownLinkPolicy::safe_default().evaluate("https://user:secret@example.com"),
        Err(MarkdownLinkError::CredentialsNotAllowed)
    ));
    assert!(
        MarkdownLinkPolicy::safe_default()
            .allow(MarkdownLinkScheme::Mailto)
            .evaluate("mailto:hello@example.com")
            .is_ok()
    );
    assert_eq!(
        MarkdownLinkPolicy::safe_default()
            .evaluate("#fn-note")
            .unwrap()
            .fragment(),
        Some("fn-note")
    );
}

#[test]
fn parses_images_math_and_footnotes_as_document_features() {
    let document = MarkdownDocument::parse(
        "![diagram](https://example.com/a.png \"Architecture\")\n\n\
         Inline $x^2$.\n\n$$\\int_0^1 x dx$$\n\n\
         A note.[^n]\n\n[^n]: Footnote body.",
    )
    .unwrap();

    let image = document.images().next().unwrap();
    assert_eq!(image.alt(), "diagram");
    assert_eq!(image.title(), "Architecture");
    assert!(document.blocks.iter().any(|block| {
        matches!(
            &block.kind,
            MarkdownBlockKind::Math { text, display: true } if text == "\\int_0^1 x dx"
        )
    }));
    assert!(document.blocks.iter().any(|block| {
        block.context.footnote.as_deref() == Some("n") && block.plain_text() == "Footnote body."
    }));
}

#[test]
fn paints_inline_and_display_math_as_typeset_images() {
    let document =
        MarkdownDocument::parse("Inline $\\frac{1}{2}$ formula.\n\n$$\\int_0^1 x^2 dx$$").unwrap();
    let mut engine = MarkdownLayoutEngine::new();
    let markdown = engine.layout(
        Rect::from_xywh(0.0, 0.0, 320.0, 240.0),
        &document,
        ScrollState::default(),
        &MarkdownStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);

    markdown.paint(&mut scene);

    assert_eq!(scene.images().len(), 2);
    assert!(
        scene
            .images()
            .iter()
            .all(|image| !image.bounds().is_empty())
    );
    assert!(
        markdown
            .semantics()
            .children()
            .iter()
            .filter(|node| node.role() == MarkdownSemanticRole::Math)
            .count()
            >= 2
    );
    let math_selection = MarkdownSelection::new(
        MarkdownTextPosition::new(1, 0),
        MarkdownTextPosition::new(1, "\\int".len()),
    );
    assert_eq!(document.text_for_selection(math_selection), "\\int");
    assert!(!markdown.selection_bounds(math_selection).is_empty());
}

#[test]
fn decodes_authorized_images_and_paints_them_through_the_scene() {
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[255, 0, 0, 255], 1, 1, image::ExtendedColorType::Rgba8)
        .unwrap();
    let image = decode_markdown_image(ImageId::new(42), &png).unwrap();
    let document = MarkdownDocument::parse("before ![red](memory://red) after").unwrap();
    assert_eq!(document.images().count(), 1);
    assert_eq!(
        document.text_for_selection(MarkdownSelection::new(
            MarkdownTextPosition::new(0, 0),
            MarkdownTextPosition::new(0, "before red after".len()),
        )),
        "before red after"
    );
    let mut images = MarkdownImages::new();
    images.insert("memory://red", image);
    let presentation = MarkdownPresentation::new().with_images(images);
    let mut engine = MarkdownLayoutEngine::new();
    let markdown = engine.layout_with(
        Rect::from_xywh(0.0, 0.0, 200.0, 200.0),
        &document,
        ScrollState::default(),
        &MarkdownStyle::light(),
        &presentation,
    );
    let mut scene = UiScene::new(Color::WHITE);

    markdown.paint(&mut scene);

    assert_eq!(scene.images().len(), 1);
}

#[test]
fn syntax_highlighting_projects_colored_code_spans() {
    let document = MarkdownDocument::parse("```rust\nfn main() { let answer = 42; }\n```").unwrap();
    let mut engine =
        MarkdownLayoutEngine::new().with_syntax_highlighter(SyntectMarkdownHighlighter::new());
    let markdown = engine.layout(
        Rect::from_xywh(0.0, 0.0, 400.0, 200.0),
        &document,
        ScrollState::default(),
        &MarkdownStyle::light(),
    );
    let mut scene = UiScene::new(Color::WHITE);
    markdown.paint(&mut scene);

    let code = scene
        .text_blocks()
        .iter()
        .find(|block| block.text().contains("answer"))
        .unwrap();
    assert!(code.spans().len() > 2);
    assert!(
        code.spans()
            .iter()
            .any(|span| span.style().color() != MarkdownStyle::light().body().color())
    );
}

#[test]
fn search_selection_copy_hit_testing_and_semantics_share_layout_geometry() {
    let document = MarkdownDocument::parse("# Alpha\n\nbeta 世界 beta").unwrap();
    let matches = document.search("BETA", MarkdownSearchCase::Insensitive);
    assert_eq!(matches.len(), 2);
    let selection = MarkdownSelection::new(
        MarkdownTextPosition::new(1, 0),
        MarkdownTextPosition::new(1, "beta 世界".len()),
    );
    assert_eq!(document.text_for_selection(selection), "beta 世界");
    let presentation = MarkdownPresentation::new()
        .with_search_matches(matches)
        .with_selection(selection);
    let mut engine = MarkdownLayoutEngine::new();
    let markdown = engine.layout_with(
        Rect::from_xywh(10.0, 20.0, 240.0, 200.0),
        &document,
        ScrollState::default(),
        &MarkdownStyle::light(),
        &presentation,
    );
    let selection_bounds = markdown.selection_bounds(selection);
    assert!(!selection_bounds.is_empty());
    let first = selection_bounds[0];
    let point = Point::new(
        first.origin.x + first.size.width * 0.5,
        first.origin.y + first.size.height * 0.5,
    );
    assert_eq!(
        markdown
            .text_position_at(point)
            .map(|position| position.block()),
        Some(1)
    );
    assert_eq!(markdown.semantics().role(), MarkdownSemanticRole::Document);
    assert!(markdown.fragment_bounds("alpha").is_some());
    assert!(
        markdown
            .semantics()
            .children()
            .iter()
            .any(|node| node.role() == MarkdownSemanticRole::Heading && node.level() == Some(1))
    );
}
