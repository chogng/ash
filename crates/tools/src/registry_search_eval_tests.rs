use super::*;
use crate::ToolInputSchema;
use crate::ToolOutputSchema;
use crate::ToolSchemaMode;
use serde_json::json;
use std::collections::BTreeSet;

struct EvalTool {
    name: &'static str,
    description: &'static str,
    catalog: &'static str,
    schema_hint: &'static str,
}

const TOOLS: &[EvalTool] = &[
    EvalTool {
        name: "read_file",
        description: "Read the contents of a accessible file by path without changing it.",
        catalog: "coding accessible filesystem",
        schema_hint: "file path and optional line range",
    },
    EvalTool {
        name: "write_file",
        description: "Create or completely replace a accessible file with new content.",
        catalog: "coding accessible filesystem",
        schema_hint: "file path and complete content",
    },
    EvalTool {
        name: "edit_file",
        description: "Replace exact existing text in a accessible file.",
        catalog: "coding accessible filesystem",
        schema_hint: "file path old text and replacement text",
    },
    EvalTool {
        name: "grep",
        description: "Search file contents for a regular expression or text pattern.",
        catalog: "coding file search",
        schema_hint: "regex pattern and directory path",
    },
    EvalTool {
        name: "glob",
        description: "Find files by file name or glob path pattern.",
        catalog: "coding file search",
        schema_hint: "glob pattern and directory path",
    },
    EvalTool {
        name: "shell_command",
        description: "Run an approved shell command in the selected directory.",
        catalog: "coding terminal process",
        schema_hint: "shell command and working directory",
    },
    EvalTool {
        name: "apply_patch",
        description: "Apply a structured patch to add update or delete files.",
        catalog: "coding accessible filesystem",
        schema_hint: "unified patch containing file changes",
    },
    EvalTool {
        name: "git_status",
        description: "Show repository working tree status and changed files.",
        catalog: "coding source control git",
        schema_hint: "repository path",
    },
    EvalTool {
        name: "git_diff",
        description: "Show line changes and differences in tracked files.",
        catalog: "coding source control git",
        schema_hint: "repository path and optional revision",
    },
    EvalTool {
        name: "github_list_pull_requests",
        description: "List GitHub pull requests for a repository.",
        catalog: "github source control remote",
        schema_hint: "repository owner state and pagination",
    },
    EvalTool {
        name: "github_create_pull_request",
        description: "Create or open a new GitHub pull request from a branch.",
        catalog: "github source control remote",
        schema_hint: "repository owner branch title and body",
    },
    EvalTool {
        name: "github_merge_pull_request",
        description: "Merge an existing GitHub pull request.",
        catalog: "github source control remote",
        schema_hint: "repository owner pull request number",
    },
    EvalTool {
        name: "slack_search_messages",
        description: "Search Slack messages and channel history.",
        catalog: "slack communication",
        schema_hint: "message query channel and time range",
    },
    EvalTool {
        name: "slack_send_message",
        description: "Send a message to a Slack channel.",
        catalog: "slack communication",
        schema_hint: "channel and message text",
    },
    EvalTool {
        name: "calendar_list_events",
        description: "List calendar events and meetings in a time range.",
        catalog: "calendar scheduling",
        schema_hint: "start time end time and calendar",
    },
    EvalTool {
        name: "calendar_create_event",
        description: "Create a calendar event or schedule a meeting.",
        catalog: "calendar scheduling",
        schema_hint: "meeting title attendees start and end time",
    },
    EvalTool {
        name: "browser_open_page",
        description: "Open a website URL in the browser.",
        catalog: "browser web navigation",
        schema_hint: "website URL",
    },
    EvalTool {
        name: "browser_click",
        description: "Click a visible element or link in the browser.",
        catalog: "browser web interaction",
        schema_hint: "element reference or link text",
    },
    EvalTool {
        name: "database_query_readonly",
        description: "Run a read-only SQL query without changing database data.",
        catalog: "database SQL data",
        schema_hint: "SQL query and database name",
    },
    EvalTool {
        name: "database_execute_migration",
        description: "Apply a database schema migration that changes tables.",
        catalog: "database SQL schema",
        schema_hint: "migration statements and database name",
    },
];

struct EvalCase {
    query: &'static str,
    relevant: &'static [&'static str],
}

const LEXICAL_CASES: &[EvalCase] = &[
    EvalCase {
        query: "read_file",
        relevant: &["read_file"],
    },
    EvalCase {
        query: "read accessible file by path",
        relevant: &["read_file"],
    },
    EvalCase {
        query: "replace exact text in file",
        relevant: &["edit_file"],
    },
    EvalCase {
        query: "replace complete file contents",
        relevant: &["write_file"],
    },
    EvalCase {
        query: "find filenames with a glob pattern",
        relevant: &["glob"],
    },
    EvalCase {
        query: "search regex inside file contents",
        relevant: &["grep"],
    },
    EvalCase {
        query: "run shell command",
        relevant: &["shell_command"],
    },
    EvalCase {
        query: "apply structured file patch",
        relevant: &["apply_patch"],
    },
    EvalCase {
        query: "show working tree status",
        relevant: &["git_status"],
    },
    EvalCase {
        query: "show repository line differences",
        relevant: &["git_diff"],
    },
    EvalCase {
        query: "list github pull requests",
        relevant: &["github_list_pull_requests"],
    },
    EvalCase {
        query: "open new github pull request from branch",
        relevant: &["github_create_pull_request"],
    },
    EvalCase {
        query: "merge github pull request",
        relevant: &["github_merge_pull_request"],
    },
    EvalCase {
        query: "find slack channel history",
        relevant: &["slack_search_messages"],
    },
    EvalCase {
        query: "send slack channel message",
        relevant: &["slack_send_message"],
    },
    EvalCase {
        query: "list calendar meetings in a time range",
        relevant: &["calendar_list_events"],
    },
    EvalCase {
        query: "schedule calendar meeting with attendees",
        relevant: &["calendar_create_event"],
    },
    EvalCase {
        query: "open website URL in browser",
        relevant: &["browser_open_page"],
    },
    EvalCase {
        query: "click browser link",
        relevant: &["browser_click"],
    },
    EvalCase {
        query: "run read only SQL query",
        relevant: &["database_query_readonly"],
    },
    EvalCase {
        query: "change tables with schema migration",
        relevant: &["database_execute_migration"],
    },
    EvalCase {
        query: "read_file query",
        relevant: &["read_file"],
    },
    EvalCase {
        query: "write_file text",
        relevant: &["write_file"],
    },
    EvalCase {
        query: "git status diff",
        relevant: &["git_status"],
    },
];

const SEMANTIC_CHALLENGES: &[EvalCase] = &[
    EvalCase {
        query: "inspect source without modifying it",
        relevant: &["read_file"],
    },
    EvalCase {
        query: "appointments coming up",
        relevant: &["calendar_list_events"],
    },
    EvalCase {
        query: "把当前分支提交审核",
        relevant: &["github_create_pull_request"],
    },
    EvalCase {
        query: "alter table layout",
        relevant: &["database_execute_migration"],
    },
    EvalCase {
        query: "locate occurrences across source code",
        relevant: &["grep"],
    },
];

const MULTILINGUAL_SEMANTIC_CASES: &[EvalCase] = &[
    EvalCase {
        query: "查看接下来的日程安排",
        relevant: &["calendar_list_events"],
    },
    EvalCase {
        query: "把当前分支提交审核",
        relevant: &["github_create_pull_request"],
    },
    EvalCase {
        query: "在代码里找所有出现位置",
        relevant: &["grep"],
    },
    EvalCase {
        query: "浏览文件内容但不要修改",
        relevant: &["read_file"],
    },
    EvalCase {
        query: "给团队频道发一条消息",
        relevant: &["slack_send_message"],
    },
    EvalCase {
        query: "运行只读数据库查询",
        relevant: &["database_query_readonly"],
    },
    EvalCase {
        query: "更新数据库表结构",
        relevant: &["database_execute_migration"],
    },
    EvalCase {
        query: "打开这个网页",
        relevant: &["browser_open_page"],
    },
    EvalCase {
        query: "看看仓库里哪些文件被改了",
        relevant: &["git_status"],
    },
    EvalCase {
        query: "应用这段文件补丁",
        relevant: &["apply_patch"],
    },
];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct RetrievalMetrics {
    cases: usize,
    top_1_hits: usize,
    top_3_hits: usize,
    mean_reciprocal_rank_millis: usize,
}

impl RetrievalMetrics {
    fn top_1_percent(self) -> usize {
        self.top_1_hits * 100 / self.cases
    }

    fn top_3_percent(self) -> usize {
        self.top_3_hits * 100 / self.cases
    }
}

#[test]
fn bm25_search_beats_or_matches_uniform_token_overlap_on_representative_tools() {
    let snapshot = evaluation_snapshot();
    let bm25 = evaluate(LEXICAL_CASES, |query| bm25_ranking(&snapshot, query));
    let uniform = evaluate(LEXICAL_CASES, uniform_token_overlap_ranking);
    let semantic = evaluate(SEMANTIC_CHALLENGES, |query| bm25_ranking(&snapshot, query));

    eprintln!(
        "tool-search eval: bm25 top1={}%, top3={}%, mrr={:.3}; uniform top1={}%, top3={}%, mrr={:.3}; semantic-challenge top1={}%, top3={}%, mrr={:.3}",
        bm25.top_1_percent(),
        bm25.top_3_percent(),
        bm25.mean_reciprocal_rank_millis as f64 / 1_000.0,
        uniform.top_1_percent(),
        uniform.top_3_percent(),
        uniform.mean_reciprocal_rank_millis as f64 / 1_000.0,
        semantic.top_1_percent(),
        semantic.top_3_percent(),
        semantic.mean_reciprocal_rank_millis as f64 / 1_000.0,
    );

    assert!(bm25.top_1_percent() >= 90, "{bm25:?}");
    assert_eq!(bm25.top_3_percent(), 100, "{bm25:?}");
    assert!(bm25.mean_reciprocal_rank_millis >= 950, "{bm25:?}");
    assert!(bm25.top_1_hits >= uniform.top_1_hits);
    assert!(bm25.top_3_hits >= uniform.top_3_hits);
    assert!(bm25.mean_reciprocal_rank_millis >= uniform.mean_reciprocal_rank_millis);
}

#[test]
fn bm25_keeps_lexical_precision_in_a_catalog_larger_than_one_hundred_tools() {
    let snapshot = scaled_evaluation_snapshot();
    let metrics = evaluate(LEXICAL_CASES, |query| bm25_ranking(&snapshot, query));

    eprintln!(
        "scaled tool-search eval: tools={}, top1={}%, top3={}%, mrr={:.3}",
        snapshot.search_documents().len(),
        metrics.top_1_percent(),
        metrics.top_3_percent(),
        metrics.mean_reciprocal_rank_millis as f64 / 1_000.0,
    );

    assert!(snapshot.search_documents().len() > 100);
    assert!(metrics.top_1_percent() >= 90, "{metrics:?}");
    assert!(metrics.top_3_percent() >= 95, "{metrics:?}");
}

#[test]
fn controlled_semantic_ranking_adds_multilingual_recall_without_replacing_bm25() {
    let snapshot = scaled_evaluation_snapshot();
    let lexical = evaluate(MULTILINGUAL_SEMANTIC_CASES, |query| {
        bm25_ranking(&snapshot, query)
    });
    let hybrid = evaluate(MULTILINGUAL_SEMANTIC_CASES, |query| {
        hybrid_ranking(&snapshot, query, controlled_semantic_ranking(query))
    });

    eprintln!(
        "multilingual controlled eval: lexical top1={}%, top3={}%, mrr={:.3}; hybrid top1={}%, top3={}%, mrr={:.3}",
        lexical.top_1_percent(),
        lexical.top_3_percent(),
        lexical.mean_reciprocal_rank_millis as f64 / 1_000.0,
        hybrid.top_1_percent(),
        hybrid.top_3_percent(),
        hybrid.mean_reciprocal_rank_millis as f64 / 1_000.0,
    );

    assert!(hybrid.top_1_hits > lexical.top_1_hits);
    assert!(hybrid.top_3_percent() >= 90, "{hybrid:?}");
    assert!(hybrid.mean_reciprocal_rank_millis > lexical.mean_reciprocal_rank_millis);
}

fn evaluation_snapshot() -> ToolRegistrySnapshot {
    let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(1));
    for tool in TOOLS {
        builder.register(evaluation_registration(tool)).unwrap();
    }
    builder.build().unwrap()
}

fn scaled_evaluation_snapshot() -> ToolRegistrySnapshot {
    let mut builder = ToolRegistryBuilder::new(ToolRegistryGeneration::new(2));
    for tool in TOOLS {
        builder.register(evaluation_registration(tool)).unwrap();
    }
    for index in 0..140 {
        let family = match index % 7 {
            0 => "issue comment archive",
            1 => "calendar availability preference",
            2 => "database backup snapshot",
            3 => "slack member profile",
            4 => "browser screenshot capture",
            5 => "git branch protection",
            _ => "runtime telemetry shard",
        };
        let name = format!("connector_{index:03}_archive_record");
        let description = format!(
            "Archive one {family} record for synthetic enterprise connector number {index}."
        );
        builder
            .register(generated_registration(&name, &description, family))
            .unwrap();
    }
    builder.build().unwrap()
}

fn evaluation_registration(tool: &EvalTool) -> ToolRegistryRegistration {
    let definition = ToolDefinition::function(
        ToolName::new(tool.name).unwrap(),
        tool.description,
        ToolInputSchema::parse(json!({
            "type": "object",
            "properties": {
                "input": {
                    "type": "string",
                    "description": tool.schema_hint
                }
            }
        }))
        .unwrap(),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::Strict,
        ToolLoading::Deferred,
    )
    .unwrap();
    ToolRegistryRegistration::new(
        definition,
        ToolRuntimeKey::new(format!("eval:{}", tool.name)).unwrap(),
        ToolExposure::Deferred,
        ToolSearchMetadata::new(tool.catalog).unwrap(),
    )
    .unwrap()
}

fn generated_registration(
    name: &str,
    description: &str,
    catalog: &str,
) -> ToolRegistryRegistration {
    let definition = ToolDefinition::function(
        ToolName::new(name).unwrap(),
        description,
        ToolInputSchema::parse(json!({
            "type": "object",
            "properties": {
                "record_id": {
                    "type": "string",
                    "description": "synthetic archive record identifier"
                }
            }
        }))
        .unwrap(),
        ToolOutputSchema::Unspecified,
        ToolSchemaMode::Strict,
        ToolLoading::Deferred,
    )
    .unwrap();
    ToolRegistryRegistration::new(
        definition,
        ToolRuntimeKey::new(format!("eval:{name}")).unwrap(),
        ToolExposure::Deferred,
        ToolSearchMetadata::new(catalog).unwrap(),
    )
    .unwrap()
}

fn bm25_ranking(snapshot: &ToolRegistrySnapshot, query: &str) -> Vec<String> {
    snapshot
        .search(&ToolSearchQuery::new(query, ToolSearchLimit::new(32).unwrap()).unwrap())
        .matches()
        .iter()
        .map(|matched| matched.loadable().definition().name().as_str().to_owned())
        .collect()
}

fn hybrid_ranking(
    snapshot: &ToolRegistrySnapshot,
    query: &str,
    semantic_ranking: Vec<ToolName>,
) -> Vec<String> {
    snapshot
        .search_hybrid(
            &ToolSearchQuery::new(query, ToolSearchLimit::new(32).unwrap()).unwrap(),
            &semantic_ranking,
        )
        .matches()
        .iter()
        .map(|matched| matched.loadable().definition().name().as_str().to_owned())
        .collect()
}

fn controlled_semantic_ranking(query: &str) -> Vec<ToolName> {
    let target = MULTILINGUAL_SEMANTIC_CASES
        .iter()
        .find(|case| case.query == query)
        .and_then(|case| case.relevant.first())
        .expect("controlled eval query has a labeled target");
    std::iter::once(*target)
        .chain(
            TOOLS
                .iter()
                .map(|tool| tool.name)
                .filter(|name| name != target),
        )
        .map(|name| ToolName::new(name).unwrap())
        .collect()
}

fn uniform_token_overlap_ranking(query: &str) -> Vec<String> {
    let query_terms = tokenize(query).into_iter().collect::<BTreeSet<_>>();
    let mut ranked = TOOLS
        .iter()
        .filter_map(|tool| {
            let document = format!(
                "{} {} {} {}",
                tool.name, tool.description, tool.catalog, tool.schema_hint
            );
            let document_terms = tokenize(&document).into_iter().collect::<BTreeSet<_>>();
            let score = query_terms.intersection(&document_terms).count();
            (score > 0).then_some((tool.name, score))
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|(left_name, left_score), (right_name, right_score)| {
        right_score
            .cmp(left_score)
            .then_with(|| left_name.cmp(right_name))
    });
    ranked
        .into_iter()
        .map(|(name, _)| name.to_owned())
        .collect()
}

fn tokenize(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut previous_was_lowercase = false;
    for character in value.chars() {
        if character.is_alphanumeric() {
            if character.is_uppercase() && previous_was_lowercase && !current.is_empty() {
                tokens.push(current.to_lowercase());
                current.clear();
            }
            previous_was_lowercase = character.is_lowercase();
            current.extend(character.to_lowercase());
        } else {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            previous_was_lowercase = false;
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn evaluate(cases: &[EvalCase], mut rank: impl FnMut(&str) -> Vec<String>) -> RetrievalMetrics {
    let mut top_1_hits = 0;
    let mut top_3_hits = 0;
    let mut reciprocal_rank_millis = 0;
    for case in cases {
        let ranking = rank(case.query);
        let first_relevant_rank = ranking
            .iter()
            .position(|name| case.relevant.contains(&name.as_str()));
        if first_relevant_rank == Some(0) {
            top_1_hits += 1;
        }
        if first_relevant_rank.is_some_and(|rank| rank < 3) {
            top_3_hits += 1;
        }
        if let Some(rank) = first_relevant_rank {
            reciprocal_rank_millis += 1_000 / (rank + 1);
        }
    }
    RetrievalMetrics {
        cases: cases.len(),
        top_1_hits,
        top_3_hits,
        mean_reciprocal_rank_millis: reciprocal_rank_millis / cases.len(),
    }
}
