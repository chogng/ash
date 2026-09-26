use super::*;
use crate::render::test_context;

fn render_text(source: &str, width: usize) -> Vec<HyperlinkLine> {
    let context = test_context();
    let mut output = Vec::new();
    for block in blocks(source) {
        if !output.is_empty() {
            output.push(HyperlinkLine::default());
        }
        output.extend(render(&block, width, context, &mut |_, language, code| {
            crate::render::highlight_code(code, language, context.into())
        }));
    }
    output
}

#[test]
fn markdown_preserves_structure_styles_and_link_targets() {
    let rows = render_text(
        "# Heading\n\n**bold** and *italic* and ~~gone~~ [site](https://example.com)\n\n> quote\n\n- [x] done\n- next\n\n~~~rust\nfn main() {}\n~~~",
        70,
    );
    let text = rows
        .iter()
        .map(|row| row.line.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    crate::tui_assert_snapshot!("markdown_structure", text);
    assert!(
        rows[0]
            .line
            .spans
            .iter()
            .any(|span| span.style.add_modifier.contains(Modifier::BOLD))
    );
    assert!(
        rows.iter()
            .flat_map(|row| &row.links)
            .any(|link| link.destination == "https://example.com/")
    );
    assert!(
        rows.iter()
            .flat_map(|row| &row.line.spans)
            .any(|span| span.style.fg == Some(test_context().keyword()))
    );
}

#[test]
fn task_lists_replace_bullets_and_align_wrapped_text() {
    let rows = render_text(
        "- [ ] open item with several words\n  - [x] nested task\n- [x] done\n- ordinary\n\n9. [x] numbered item with several words\n10. [ ]\n",
        20,
    );
    let text = rows
        .iter()
        .map(|row| row.line.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(rows.iter().all(|row| row.line.width() <= 20));
    assert!(text.contains("☐ open item"), "{text}");
    assert!(text.contains("☑ done"), "{text}");
    assert!(text.contains("  ☑ nested task"), "{text}");
    assert!(text.contains("• ordinary"), "{text}");
    assert!(text.contains("9. ☑ numbered"), "{text}");
    assert!(text.contains("10. ☐"), "{text}");
    assert!(!text.contains("• ☑"), "{text}");
    crate::tui_assert_snapshot!("task_list_checkboxes_and_wrapping", text);
}

#[test]
fn tables_reflow_to_records_and_preserve_links() {
    let source = "| Name | Result |\n| :--- | ---: |\n| [中文](https://example.com) | complete |\n| beta | pending |";
    for width in [40, 12] {
        let rows = render_text(source, width);
        assert!(rows.iter().all(|row| row.line.width() <= width));
        assert!(
            rows.iter()
                .flat_map(|row| &row.links)
                .any(|link| link.destination == "https://example.com/")
        );
        let text = rows
            .iter()
            .map(|row| row.line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        if width == 40 {
            crate::tui_assert_snapshot!("markdown_table", text);
        } else {
            crate::tui_assert_snapshot!("markdown_table_records", text);
        }
    }
}

#[test]
fn local_links_remain_copyable_and_never_become_arbitrary_file_actions() {
    let rows = render_text("[source](src/main.rs) [script](file:///tmp/run.sh)", 80);
    assert!(rows.iter().all(|row| row.links.is_empty()));
    let text = rows
        .iter()
        .map(|row| row.line.to_string())
        .collect::<String>();
    assert!(text.contains("src/main.rs"));
    assert!(text.contains("file:///tmp/run.sh"));
}

#[test]
fn code_blank_lines_and_nested_lists_stay_inside_the_content_width() {
    let rows = render_text(
        "```rust\nfn main() {\n\n    run();\n}\n```\n\n10. first item with a long label\n    - nested item",
        18,
    );
    assert!(rows.iter().all(|row| row.line.width() <= 18), "{rows:?}");
    let text = rows
        .iter()
        .map(|row| row.line.to_string())
        .collect::<Vec<_>>();
    assert!(text.iter().any(|line| line.is_empty()));
    assert!(text.iter().any(|line| line.contains("run();")));
}

#[test]
fn code_link_labels_keep_their_destination_and_list_continuations_align() {
    let rows = render_text(
        "[`docs`](https://example.com/docs)\n\n- one two three four",
        12,
    );
    assert_eq!(rows[0].links[0].destination, "https://example.com/docs");
    assert_eq!(rows[2].line.to_string(), "• one two ");
    assert!(rows[3].line.to_string().starts_with("  three"));
}

#[test]
fn mermaid_diagrams_render_after_closing_and_keep_theme_and_container_width() {
    let source = "Flow\n\n```mermaid\nflowchart LR\nA[输入] -->|check| B[Build]\n```\n\nSequence\n\n```mermaid\nsequenceDiagram\nparticipant U as User\nparticipant S as Service\nU->>S: ask\nS-->>U: result\n```";
    let rows = render_text(source, 72);
    let text = rows
        .iter()
        .map(|row| row.line.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(text.contains("┌"));
    assert!(!text.contains("flowchart"));
    assert!(!text.contains("sequenceDiagram"));
    crate::tui_assert_snapshot!("markdown_mermaid", text);
    let mut buffer = ratatui::buffer::Buffer::empty(ratatui::layout::Rect::new(0, 0, 72, 40));
    ratatui::widgets::Widget::render(
        ratatui::widgets::Paragraph::new(
            rows.iter().map(|row| row.line.clone()).collect::<Vec<_>>(),
        ),
        buffer.area,
        &mut buffer,
    );
    let border = buffer
        .content
        .iter()
        .find(|cell| cell.symbol() == "┌")
        .unwrap();
    assert_eq!(border.fg, test_context().r#type());
    let nested = render_text("> - ```mermaid\n>   flowchart TD\n>   A --> B\n>   ```", 24);
    assert!(nested.iter().all(|row| row.line.width() <= 24));
    assert!(nested.iter().any(|row| row.line.to_string().contains('┌')));
}

#[test]
fn mermaid_browser_link_uses_only_ash_created_preview_files() {
    let profile = tempfile::tempdir().unwrap();
    let mut previews = crate::render::MermaidPreviews::new(profile.path());
    let source = "```mermaid\nflowchart LR\nA --> B\n```";
    previews.prepare_message("agent-1", 1, source).unwrap();
    let context = test_context().with_mermaid_previews(&previews);
    let rows = blocks(source)
        .iter()
        .flat_map(|block| {
            render(block, 60, context, &mut |_, language, code| {
                crate::render::highlight_code(code, language, context.into())
            })
        })
        .collect::<Vec<_>>();
    let link = rows
        .iter()
        .flat_map(|row| &row.links)
        .find(|link| link.destination.starts_with("file://"))
        .unwrap();
    assert!(
        rows.iter()
            .any(|row| row.line.to_string().contains("Open Mermaid in browser"))
    );
    assert!(link.destination.ends_with(".html"));
    let chinese = test_context()
        .with_language(crate::nls::Language::Chinese)
        .with_mermaid_previews(&previews);
    let translated = blocks(source)
        .iter()
        .flat_map(|block| {
            render(block, 60, chinese, &mut |_, language, code| {
                crate::render::highlight_code(code, language, chinese.into())
            })
        })
        .map(|row| row.line.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    assert!(translated.contains("在浏览器中打开 Mermaid"));
    crate::tui_assert_snapshot!(
        "markdown_mermaid_browser_preview",
        rows.iter()
            .map(|row| row.line.to_string())
            .collect::<Vec<_>>()
            .join("\n")
    );

    let untrusted = render_text("[open](file:///tmp/arbitrary.html)", 60);
    assert!(untrusted.iter().all(|row| row.links.is_empty()));
}

#[test]
fn mermaid_shapes_cycles_states_and_dashed_self_messages_render_as_diagrams() {
    let source = "Flow\n\n```mermaid\nflowchart LR\nA(检查) --> B{通过}\nB -->|yes| C[完成]\nB -.->|retry| A\n```\n\nState\n\n```mermaid\nstateDiagram-v2\ndirection LR\n[*] --> Ready\nstate \"等待\" as Ready\nReady --> Work: run\nWork: 处理\nWork --> Ready: retry\nWork --> [*]\n```\n\nSequence\n\n```mermaid\nsequenceDiagram\nparticipant S as Service\nS-->>S: lookup\n```";
    let rows = render_text(source, 72);
    let text = rows
        .iter()
        .map(|row| row.line.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    for header in ["flowchart", "stateDiagram", "sequenceDiagram"] {
        assert!(!text.contains(header), "{text}");
    }
    assert!(rows.iter().all(|row| row.line.width() <= 72));
    for label in ["检查", "通过", "完成", "等待", "处理", "lookup"] {
        assert_eq!(text.matches(label).count(), 1, "{text}");
    }
    let mut buffer =
        ratatui::buffer::Buffer::empty(ratatui::layout::Rect::new(0, 0, 72, rows.len() as u16));
    ratatui::widgets::Widget::render(
        ratatui::widgets::Paragraph::new(rows.into_iter().map(|row| row.line).collect::<Vec<_>>()),
        buffer.area,
        &mut buffer,
    );
    for glyph in ["╭", "╱", "●", "◉", "┄", "┆"] {
        let cell = buffer
            .content
            .iter()
            .find(|cell| cell.symbol() == glyph)
            .unwrap();
        assert_eq!(cell.fg, test_context().r#type(), "{glyph}");
    }
    crate::tui_assert_snapshot!("markdown_mermaid_states_and_cycles", text);
}

#[test]
fn mermaid_open_fences_unsupported_syntax_and_small_width_keep_source() {
    for source in [
        "```mermaid\nflowchart LR\nA --> B",
        "````mermaid\nflowchart LR\nA --> B\n```",
        "~~~mermaid\nflowchart LR\nA --> B\n```",
        "```mermaid\nflowchart LR\nA --> B\n``` trailing",
        "> ```mermaid\n> flowchart LR\n> A --> B\n\noutside",
        "```mermaid\npie\n\"one\" : 1\n```",
    ] {
        let text = render_text(source, 70)
            .iter()
            .map(|row| row.line.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!text.contains('┌'), "{text}");
        assert!(text.contains("flowchart") || text.contains("pie"), "{text}");
    }
    let small = render_text("```mermaid\nflowchart LR\nA[Long] --> B[Wide]\n```", 10);
    assert!(small.iter().all(|row| row.line.width() <= 10));
    assert!(small.iter().all(|row| !row.line.to_string().contains('┌')));
    let tilde = render_text("~~~mermaid\nflowchart TD\nA --> B\n~~~", 40);
    assert!(tilde.iter().any(|row| row.line.to_string().contains('┌')));
}
