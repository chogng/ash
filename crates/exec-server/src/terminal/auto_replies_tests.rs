use super::*;

fn rule(pattern: &str, reply: &str) -> TerminalAutoReply {
    TerminalAutoReply {
        match_text: pattern.into(),
        reply: reply.into(),
    }
}

#[test]
fn exact_raw_matching_spans_chunks_and_utf8_with_bounded_prefixes() {
    let mut replies = AutoReplies::new(vec![rule("ababa提示\x1b[0m?", "y\r")]).unwrap();
    let now = Instant::now();
    let mut sent = Vec::new();
    for chunk in "noiseabababa提示\x1b[0m?".as_bytes().chunks(1) {
        replies.process(chunk, now, |reply| {
            sent.push(reply.to_vec());
            true
        });
    }
    assert_eq!(sent, vec![b"y\r".to_vec()]);
    assert!(replies.rules[0].matched < replies.rules[0].pattern.len());
}

#[test]
fn cooldown_survives_chunk_boundaries_and_full_input_does_not_count_as_sent() {
    let mut replies = AutoReplies::new(vec![rule("?", "yes")]).unwrap();
    let now = Instant::now();
    let mut sent = 0;
    replies.process(b"?", now, |_| false);
    replies.process(b"???", now, |_| {
        sent += 1;
        true
    });
    replies.process(b"?", now + Duration::from_millis(999), |_| {
        sent += 1;
        true
    });
    assert_eq!(sent, 1);
    replies.process(b"??", now + Duration::from_secs(1), |_| {
        sent += 1;
        true
    });
    assert_eq!(sent, 2);
    replies.clear();
    replies.process(b"?", now + Duration::from_secs(2), |_| {
        sent += 1;
        true
    });
    assert_eq!(sent, 2);
}

#[test]
fn unchanged_reinstallation_retains_partial_match_and_cooldown() {
    let mut replies = AutoReplies::new(vec![rule("Confirm?", "yes")]).unwrap();
    let now = Instant::now();
    let mut sent = 0;
    replies.process(b"Con", now, |_| panic!("partial prompt cannot reply"));
    replies.replace(AutoReplies::new(vec![rule("Confirm?", "yes")]).unwrap());
    replies.process(b"firm?", now, |_| {
        sent += 1;
        true
    });
    replies.replace(AutoReplies::new(vec![rule("Confirm?", "yes")]).unwrap());
    replies.process(b"Confirm?", now + Duration::from_millis(100), |_| {
        sent += 1;
        true
    });
    assert_eq!(sent, 1);
}

#[test]
fn invalid_rules_are_rejected_before_replacing_existing_rules() {
    for rules in [
        vec![rule("", "yes")],
        vec![rule("?", "")],
        vec![rule("?", "yes"), rule("?", "no")],
        vec![rule(&"x".repeat(MAX_RULE_BYTES + 1), "yes")],
        vec![rule("?", &"y".repeat(MAX_RULE_BYTES + 1))],
        (0..MAX_RULES + 1)
            .map(|index| rule(&index.to_string(), "yes"))
            .collect(),
        (0..MAX_RULES)
            .map(|index| rule(&format!("{index}{}", "x".repeat(3000)), &"y".repeat(3000)))
            .collect(),
    ] {
        assert!(matches!(
            AutoReplies::new(rules),
            Err(TerminalError::InvalidInput)
        ));
    }
}
