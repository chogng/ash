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
        "flowchart TB\nA --> B\nB --> A",
        "flowchart LR\nA --> B\nclick A \"https://example.com\"",
        "sequenceDiagram\nA->>B: hello\nloop repeat\nend",
        "sequenceDiagram\nA-->>A: reply",
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
