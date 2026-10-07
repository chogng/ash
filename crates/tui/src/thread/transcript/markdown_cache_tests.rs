use super::*;
use crate::render::RenderTheme;
use crate::render::ThemePalette;
use crate::render::test_context;
use crate::thread::transcript::CellView;
use crate::thread::transcript::MessageRole;
use ash_terminal_detection::ColorLevel;

fn plain(_: usize, _: &str, code: &str) -> Vec<Line<'static>> {
    code.lines()
        .map(|line| Line::raw(line.to_owned()))
        .collect()
}

#[test]
fn every_stream_boundary_matches_a_fresh_render_including_references_and_tables() {
    let source = "# Title\n\n[reference][target]\n\n| Name | State |\n| --- | --- |\n| 中文 | pending |\n| next | complete |\n\n~~~rust\nfn main() {\n}\n~~~\n\n[target]: https://example.com\n";
    let streaming = MarkdownCache::default();
    for end in source
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(source.len()))
    {
        let partial = &source[..end];
        let actual = streaming.render("message", partial, 28, test_context(), &mut plain);
        let fresh =
            MarkdownCache::default().render("message", partial, 28, test_context(), &mut plain);
        assert_eq!(actual, fresh, "source boundary {end}");
    }
}

#[test]
fn unchanged_blocks_are_not_highlighted_again_and_replacements_drop_stale_content() {
    let streaming = MarkdownCache::default();
    let mut calls = 0;
    let mut highlight = |index, language: &str, code: &str| {
        calls += 1;
        plain(index, language, code)
    };
    streaming.render(
        "message",
        "```rs\nlet x = 1;\n```\n\nhello",
        40,
        test_context(),
        &mut highlight,
    );
    streaming.render(
        "message",
        "```rs\nlet x = 1;\n```\n\nhello world",
        40,
        test_context(),
        &mut highlight,
    );
    assert_eq!(calls, 1);
    let replaced = streaming.render("message", "replacement", 40, test_context(), &mut plain);
    assert_eq!(
        replaced
            .iter()
            .map(|row| row.line.to_string())
            .collect::<String>(),
        "replacement"
    );
    streaming.retain(&HashSet::new());
    assert!(streaming.entries.borrow().is_empty());
}

#[test]
fn resize_and_theme_changes_rebuild_the_rendered_blocks() {
    let streaming = MarkdownCache::default();
    let source = "```rust\nlet value = 100;\n```";
    let mut calls = 0;
    let mut highlight = |index, language: &str, code: &str| {
        calls += 1;
        plain(index, language, code)
    };
    streaming.render("message", source, 40, test_context(), &mut highlight);
    let resized = streaming.render("message", source, 8, test_context(), &mut highlight);
    assert!(resized.iter().all(|row| row.line.width() <= 8));
    let theme = RenderTheme::from_palette(ThemePalette::initial(), ColorLevel::TrueColor);
    streaming.render(
        "message",
        source,
        8,
        RenderContext::new(&theme, 99),
        &mut highlight,
    );
    assert_eq!(calls, 3);
}

#[test]
fn mermaid_streaming_closure_resize_and_replacement_match_fresh_render() {
    for (source, marker) in [
        ("```mermaid\nflowchart LR\nA[检查] --> B[Build]\n```", '┌'),
        (
            "```mermaid\nflowchart LR\nA(检查) --> B{通过}\nB -->|retry| A\n```",
            '╭',
        ),
        (
            "```mermaid\nstateDiagram-v2\n[*] --> Ready\nReady --> Ready: 重试\nReady --> [*]\n```",
            '●',
        ),
        ("```mermaid\nsequenceDiagram\nA-->>A: 查询\n```", '┆'),
    ] {
        let streaming = MarkdownCache::default();
        for end in source
            .char_indices()
            .map(|(index, _)| index)
            .chain([source.len()])
        {
            let partial = &source[..end];
            let actual = streaming.render("diagram", partial, 70, test_context(), &mut plain);
            let fresh =
                MarkdownCache::default().render("diagram", partial, 70, test_context(), &mut plain);
            assert_eq!(actual, fresh, "source boundary {end}");
            let has_diagram = actual
                .iter()
                .any(|row| row.line.to_string().contains(marker));
            assert_eq!(
                has_diagram,
                end == source.len(),
                "source boundary {end}: {source}"
            );
        }
        for width in [8, 70] {
            assert_eq!(
                streaming.render("diagram", source, width, test_context(), &mut plain),
                MarkdownCache::default().render(
                    "diagram",
                    source,
                    width,
                    test_context(),
                    &mut plain
                ),
            );
        }
        let replaced = streaming.render("diagram", "replaced", 70, test_context(), &mut plain);
        assert_eq!(replaced[0].line.to_string(), "replaced");
    }
}

#[test]
fn transcript_code_blocks_reuse_incremental_parser_state() {
    let cache = MarkdownCache::default();
    let context = test_context();
    let message = CellView::plain(MessageRole::Agent, String::new())
        .with_cell_id("streaming-agent")
        .with_render_revision(1);
    let first = "fn main() {\n";
    let complete = "fn main() {\n    let value = 1;\n}\n";

    cache.highlight_code_block(message.cell_id.as_deref(), 0, "rust", first, context);
    let rendered =
        cache.highlight_code_block(message.cell_id.as_deref(), 0, "rust", complete, context);

    assert_eq!(
        rendered,
        crate::render::highlight_code(complete, "rust", context.into())
    );
}

#[test]
fn prepared_preview_and_language_changes_invalidate_reused_markdown_blocks() {
    let cache = MarkdownCache::default();
    let source = "```mermaid\nflowchart LR\nA --> B\n```";
    let absent = cache.render("diagram", source, 60, test_context(), &mut plain);
    assert!(absent.iter().all(|line| line.links.is_empty()));
    let mut links = crate::render::links::PreviewLinks::default();
    links.insert(
        "flowchart LR\nA --> B\n",
        "file:///tmp/prepared-diagram.html".into(),
    );
    let english = test_context().with_preview_links(&links);
    let prepared = cache.render("diagram", source, 60, english, &mut plain);
    assert!(prepared.iter().any(|line| !line.links.is_empty()));
    let chinese = english.with_language(crate::nls::Language::Chinese);
    let translated = cache.render("diagram", source, 60, chinese, &mut plain);
    assert_ne!(translated, prepared);
    assert_eq!(
        translated,
        MarkdownCache::default().render("diagram", source, 60, chinese, &mut plain)
    );
    links.clear();
    let removed = cache.render(
        "diagram",
        source,
        60,
        test_context().with_preview_links(&links),
        &mut plain,
    );
    assert!(removed.iter().all(|line| line.links.is_empty()));
}
