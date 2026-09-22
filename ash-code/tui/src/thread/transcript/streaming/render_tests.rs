use super::*;
use crate::render::test_context;

fn plain(_: usize, _: &str, code: &str) -> Vec<Line<'static>> {
    code.lines()
        .map(|line| Line::raw(line.to_owned()))
        .collect()
}

#[test]
fn every_stream_boundary_matches_a_fresh_render_including_references_and_tables() {
    let source = "# Title\n\n[reference][target]\n\n| Name | State |\n| --- | --- |\n| 中文 | pending |\n| next | complete |\n\n~~~rust\nfn main() {\n}\n~~~\n\n[target]: https://example.com\n";
    let mut streaming = StreamingRender::default();
    for end in source
        .char_indices()
        .map(|(index, _)| index)
        .chain(std::iter::once(source.len()))
    {
        let partial = &source[..end];
        let actual = streaming.render("message", partial, 28, test_context(), &mut plain);
        let fresh =
            StreamingRender::default().render("message", partial, 28, test_context(), &mut plain);
        assert_eq!(actual, fresh, "source boundary {end}");
    }
}

#[test]
fn unchanged_blocks_are_not_highlighted_again_and_replacements_drop_stale_content() {
    let mut streaming = StreamingRender::default();
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
    assert!(streaming.entries.is_empty());
}

#[test]
fn resize_and_theme_changes_rebuild_the_rendered_blocks() {
    let mut streaming = StreamingRender::default();
    let source = "```rust\nlet value = 100;\n```";
    let mut calls = 0;
    let mut highlight = |index, language: &str, code: &str| {
        calls += 1;
        plain(index, language, code)
    };
    streaming.render("message", source, 40, test_context(), &mut highlight);
    let resized = streaming.render("message", source, 8, test_context(), &mut highlight);
    assert!(resized.iter().all(|row| row.line.width() <= 8));
    let theme = crate::render::RenderTheme::fallback();
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
        let mut streaming = StreamingRender::default();
        for end in source
            .char_indices()
            .map(|(index, _)| index)
            .chain([source.len()])
        {
            let partial = &source[..end];
            let actual = streaming.render("diagram", partial, 70, test_context(), &mut plain);
            let fresh = StreamingRender::default().render(
                "diagram",
                partial,
                70,
                test_context(),
                &mut plain,
            );
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
                StreamingRender::default().render(
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
