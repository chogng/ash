use crate::CommandEvidence;
use crate::CommandRecord;
use crate::CommandSource;
use crate::EnvironmentEntry;
use crate::SourceKind;
use crate::scan;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

fn extract(record: &CommandRecord) -> Option<(BTreeSet<String>, BTreeSet<String>)> {
    let arguments: serde_json::Value = serde_json::from_str(&record.arguments_json).ok()?;
    let (program, words) = match record.tool.as_str() {
        "shell-command" | "shell-session" => {
            if record.tool == "shell-session" && arguments["action"] != "start" {
                return None;
            }
            let program = arguments["program"].as_str()?;
            let words = arguments["arguments"]
                .as_array()?
                .iter()
                .filter_map(serde_json::Value::as_str)
                .collect::<Vec<_>>();
            (program, words)
        }
        "exec_command" => ("", vec![arguments["cmd"].as_str()?]),
        "shell" | "run_command" => match &arguments["command"] {
            serde_json::Value::String(text) => ("", vec![text.as_str()]),
            serde_json::Value::Array(words) => {
                let words = words
                    .iter()
                    .filter_map(serde_json::Value::as_str)
                    .collect::<Vec<_>>();
                (*words.first()?, words.into_iter().skip(1).collect())
            }
            _ => return None,
        },
        _ => return None,
    };
    let mut names = BTreeSet::new();
    let mut targets = BTreeSet::new();
    if !program.is_empty() {
        add_name(&mut names, program);
    }
    for word in &words {
        // This is fact extraction, not a shell safety parser. Ordinary arguments, comments,
        // bodies and environment assignments never become persistent command descriptions.
        for segment in word.split([';', '|', '&', '\n']) {
            let tokens = segment.split_whitespace().collect::<Vec<_>>();
            if program.is_empty()
                || matches!(
                    program.rsplit('/').next(),
                    Some("sh" | "bash" | "zsh" | "fish")
                )
            {
                if let Some(name) = tokens.iter().find(|token| !token.contains('=')) {
                    add_name(&mut names, name);
                }
            }
            for token in tokens {
                if let Some(target) = target(
                    token,
                    names.iter().any(|name| {
                        matches!(name.as_str(), "ssh" | "scp" | "rsync" | "curl" | "wget")
                    }),
                ) {
                    targets.insert(target);
                }
            }
        }
    }
    if names.is_empty() {
        return None;
    }
    Some((names, targets))
}

/// Scan coverage and model input are separate budgets: many calls reduce to bounded facts.
pub(super) fn observations(records: &[CommandRecord]) -> (Vec<EnvironmentEntry>, usize) {
    struct Fact {
        name: String,
        occurrences: u32,
        sources: BTreeMap<String, CommandSource>,
    }
    let mut groups = [
        BTreeMap::<String, Fact>::new(),
        BTreeMap::<String, Fact>::new(),
    ];
    for record in records {
        let Some((names, targets)) = extract(record) else {
            continue;
        };
        for (group, values) in groups.iter_mut().zip([names, targets]) {
            for name in values {
                let fact = group.entry(name.clone()).or_insert_with(|| Fact {
                    name,
                    occurrences: 0,
                    sources: BTreeMap::new(),
                });
                fact.occurrences += 1;
                let source = &record.source;
                let old = fact
                    .sources
                    .entry(source.session_id.clone())
                    .or_insert_with(|| source.clone());
                if (
                    source.recorded_at_unix_ms,
                    source.sequence,
                    &source.thread_id,
                ) > (old.recorded_at_unix_ms, old.sequence, &old.thread_id)
                {
                    *old = source.clone();
                }
            }
        }
    }
    let available = groups.iter().map(BTreeMap::len).sum();
    let mut entries = Vec::new();
    for (category, group) in ["command", "target"].into_iter().zip(groups) {
        let mut facts = group.into_values().collect::<Vec<_>>();
        // Session coverage precedes raw frequency so one long chat cannot monopolize the facts.
        facts.sort_by(|left, right| {
            right
                .sources
                .len()
                .cmp(&left.sources.len())
                .then_with(|| right.occurrences.cmp(&left.occurrences))
                .then_with(|| left.name.cmp(&right.name))
        });
        for fact in facts.into_iter().take(20) {
            let session_count = fact.sources.len() as u32;
            let mut samples = fact.sources.into_values().collect::<Vec<_>>();
            samples.sort_by(|left, right| {
                right
                    .recorded_at_unix_ms
                    .cmp(&left.recorded_at_unix_ms)
                    .then_with(|| right.sequence.cmp(&left.sequence))
                    .then_with(|| left.thread_id.cmp(&right.thread_id))
            });
            samples.truncate(3);
            let evidence = CommandEvidence {
                occurrences: fact.occurrences,
                session_count,
                samples,
            };
            let label = format!("{category}:{}", fact.name);
            let mut entry =
                scan::observation(SourceKind::RecentCommand, label.clone(), fact.name.clone());
            entry.title = fact.name;
            entry.source.id = scan::digest(format!("RecentCommand:{label}").as_bytes());
            entry.id = entry.source.id.clone();
            entry.source.revision =
                scan::digest(&serde_json::to_vec(&evidence).expect("history evidence serializes"));
            entry.source.command = Some(evidence);
            entries.push(entry);
        }
    }
    (entries, available)
}

fn add_name(names: &mut BTreeSet<String>, text: &str) {
    let name = text
        .trim_matches(['\'', '"'])
        .rsplit('/')
        .next()
        .unwrap_or("");
    if !name.is_empty()
        && name.len() <= 64
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
    {
        names.insert(name.into());
    }
}

fn target(text: &str, allow_bare: bool) -> Option<String> {
    let text = text.trim_matches(['\'', '"', '(', ')', ',', '<', '>']);
    if let Ok(url) = url::Url::parse(text) {
        if matches!(url.scheme(), "https" | "http" | "ssh" | "s3" | "gs" | "az") {
            let host = url.host_str()?;
            let port = url
                .port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default();
            return Some(format!("{}://{host}{port}", url.scheme()));
        }
        return None;
    }
    let host = text.rsplit('@').next()?.split(':').next()?;
    if (allow_bare || text.contains('@'))
        && host.len() <= 253
        && host.contains('.')
        && !host.contains('=')
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
    {
        Some(host.into())
    } else {
        None
    }
}
