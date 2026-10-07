use super::*;

#[test]
fn flowchart_preserves_direction_labels_and_shared_nodes() {
    for (direction, arrow) in [("LR", "▶"), ("RL", "◀"), ("TB", "▼"), ("BT", "▲")] {
        let rows = render(
            &format!("flowchart {direction}\nA[检查] --> B[Build]\nB --> C[Done]"),
            100,
        )
        .unwrap();
        let text = rows.join("\n");
        assert!(text.contains(arrow), "{text}");
        for label in ["检查", "Build", "Done"] {
            assert_eq!(text.matches(label).count(), 1, "{text}");
        }
        assert!(rows.iter().all(|line| line.width() <= 100));
        if direction == "LR" || direction == "TB" {
            assert!(text.find("检查") < text.find("Done"), "{text}");
        } else {
            assert!(text.find("Done") < text.find("检查"), "{text}");
        }
    }
    let diamond = render("flowchart TD\nA --> B\nA --> C\nB --> D\nC --> D", 80)
        .unwrap()
        .join("\n");
    assert_eq!(diamond.matches('D').count(), 1);
    assert!(diamond.contains('┬'));
    let labeled = render("graph LR\nA[one; two] -->|next| B", 80)
        .unwrap()
        .join("\n");
    assert!(labeled.contains("one; two"));
    assert!(labeled.contains("next"));
}

#[test]
fn sequence_keeps_participants_message_order_and_return_direction() {
    let rows = render("sequenceDiagram\nparticipant U as 用户\nparticipant S as Server\nU->>S: request\nS-->>U: reply\nS->>S: cache", 90).unwrap();
    let text = rows.join("\n");
    assert!(text.contains("用户"));
    assert!(text.contains("Server"));
    assert!(text.find("request") < text.find("reply"));
    assert!(text.find("reply") < text.find("cache"));
    assert!(text.contains("▶"));
    assert!(text.contains("◀"));
    assert!(text.contains("┄"));
}

#[test]
fn invalid_unsupported_and_oversized_input_never_produces_a_partial_diagram() {
    for source in [
        "pie\n\"x\" : 10",
        "flowchart LR\nA[unfinished",
        "flowchart TB\nsubgraph nested\nA --> B\nend",
        "flowchart LR\nA([stadium])",
        "flowchart LR\nA{unclosed",
        "stateDiagram-v2\nstate Nested {\nA --> B\n}",
        "stateDiagram-v2\nstate C <<choice>>",
        "stateDiagram-v2\nA --> B\nnote right of B: text",
        "flowchart LR\nA --> B\nclick A \"https://example.com\"",
        "sequenceDiagram\nA->>B: hello\nloop repeat\nend",
        "sequenceDiagram\nA--xA: reply",
        "flowchart LR\nA[<script>]",
        "flowchart LR\nA[\u{1b}[31m]",
    ] {
        assert!(render(source, 100).is_err(), "{source}");
    }
    assert_eq!(
        render("flowchart LR\nA[Long label] --> B[Another label]", 8),
        Err(RenderError::Width)
    );
    assert_eq!(render(&"a".repeat(65537), 100), Err(RenderError::Limit));
}

#[test]
fn unicode_prefixes_and_narrow_widths_do_not_panic() {
    for source in [
        "flowchart BT\nA[你好] -->|前进| B[café]",
        "sequenceDiagram\n甲->>B: test",
        "sequenceDiagram\nA->>B: café\nB-->>A: 👍",
        "flowchart RL; A(检查) --> B{通过}; B -.->|重试| A",
        "stateDiagram-v2\ndirection LR\n[*] --> Ready\nReady --> Ready: 再试\nReady --> [*]",
        "stateDiagram-v2\ndirection LR\n[*] --> [*]: 完成",
        "sequenceDiagram\nA-->>A: 缓存",
    ] {
        for end in source
            .char_indices()
            .map(|(index, _)| index)
            .chain([source.len()])
        {
            for width in [0, 1, 8, 80] {
                if let Ok(rows) = render(&source[..end], width) {
                    assert!(rows.iter().all(|row| row.width() <= width));
                }
            }
        }
    }
}

#[test]
fn shapes_and_quoted_labels_keep_their_meaning() {
    for direction in ["LR", "RL", "TB", "BT"] {
        let text = render(&format!("flowchart {direction}; A(检查) --> B{{通过}}; B -->|yes| C[完成]; B -.->|no| D[终止]"), 100).unwrap().join("\n");
        for glyph in ["╭", "╰", "╱", "╲", "< 通过 >", "yes", "no"] {
            assert!(text.contains(glyph), "missing {glyph}:\n{text}");
        }
        assert!(text.contains('┄') || text.contains('┆'), "{text}");
        assert_eq!(text.matches("检查").count(), 1);
    }
    let quoted = render(r#"graph LR; A["a ]; b"] -->|"next; ]"| B("ok (yes)")"#, 100)
        .unwrap()
        .join("\n");
    for label in ["a ]; b", "next; ]", "ok (yes)"] {
        assert!(quoted.contains(label), "{quoted}");
    }
}

#[test]
fn graph_resources_bound_nodes_edges_and_large_decision_layouts() {
    let nodes = (0..65)
        .map(|n| format!("N{n}"))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        render(&format!("flowchart TB\n{nodes}"), 100),
        Err(RenderError::Limit)
    );
    let edges = "A --> A\n".repeat(129);
    assert_eq!(
        render(&format!("stateDiagram-v2\n{edges}"), 100),
        Err(RenderError::Limit)
    );
    let decisions = (0..64)
        .map(|n| format!("N{n}{{{}}}", "x".repeat(160)))
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(
        render(&format!("flowchart LR\n{decisions}"), 1000),
        Err(RenderError::Limit)
    );
}

#[test]
fn return_self_and_long_edges_render_in_every_direction() {
    for (direction, arrow) in [("LR", '▶'), ("RL", '◀'), ("TB", '▼'), ("BT", '▲')] {
        for edges in [
            "A --> B\nB -->|retry| A",
            "A -->|again| A",
            "A --> B --> C\nA -->|skip| C",
        ] {
            let text = render(&format!("flowchart {direction}\n{edges}"), 160)
                .unwrap()
                .join("\n");
            let label = if edges.contains("retry") {
                "retry"
            } else if edges.contains("again") {
                "again"
            } else {
                "skip"
            };
            assert!(text.contains(label), "{text}");
            assert_eq!(text.matches('A').count(), 1, "{text}");
            assert!(text.contains(arrow), "{text}");
            assert!(!text.contains("-->"), "{text}");
        }
    }
}

#[test]
fn state_transitions_keep_distinct_start_and_end_and_named_states() {
    for direction in ["LR", "RL", "TB", "BT"] {
        let text = render(&format!("stateDiagram-v2\ndirection {direction}\n[*] --> Ready\nstate \"等待\" as Ready\nReady --> Work: run\nWork: 处理\nWork --> Ready: retry\nWork --> [*]"), 160).unwrap().join("\n");
        for label in ["等待", "处理", "run", "retry", "●", "◉"] {
            assert_eq!(text.matches(label).count(), 1, "{text}");
        }
        assert!(!text.contains("Ready"), "{text}");
        assert!(text.contains('╭'), "{text}");
    }
    for direction in ["LR", "RL", "TB", "BT"] {
        for suffix in ["", ": done"] {
            let text = render(
                &format!("stateDiagram\ndirection {direction}\n[*] --> [*]{suffix}"),
                80,
            )
            .unwrap()
            .join("\n");
            assert!(text.contains('●') && text.contains('◉'), "{text}");
        }
    }
}

#[test]
fn dashed_self_message_keeps_its_return_arrow_and_own_lifeline() {
    let text = render(
        "sequenceDiagram\nparticipant A\nparticipant B\nA-->>A: lookup\nA->>B: send",
        80,
    )
    .unwrap()
    .join("\n");
    assert!(text.contains('┄') && text.contains('┆'), "{text}");
    assert_eq!(text.matches('◀').count(), 1, "{text}");
    assert_eq!(text.matches('▶').count(), 1, "{text}");
    assert!(text.find("lookup") < text.find("send"), "{text}");
    assert!(
        !text.contains('┤'),
        "self loop must not reach B's lifeline:\n{text}"
    );
}
