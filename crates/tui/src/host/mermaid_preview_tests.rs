use super::MermaidPreviews;
use std::fs;
use url::Url;

#[test]
fn closed_mermaid_block_creates_a_durable_browser_document() {
    let profile = tempfile::tempdir().unwrap();
    let source = "flowchart LR\nA[<script>alert('x')</script>] --> B";
    let message = format!("Diagram\n\n```mermaid\n{source}\n```\n");
    let mut previews = MermaidPreviews::new(profile.path());
    previews.prepare_message("agent-1", 1, &message).unwrap();
    let url = previews.links().url(&format!("{source}\n")).unwrap();
    let document = fs::read_to_string(Url::parse(&url).unwrap().to_file_path().unwrap()).unwrap();
    assert!(document.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
    assert!(!document.contains("<script>alert('x')</script>"));
    assert!(document.contains("mermaid@11.16.1"));

    let mut reopened = MermaidPreviews::new(profile.path());
    reopened.prepare_message("agent-1", 1, &message).unwrap();
    assert_eq!(reopened.links().url(&format!("{source}\n")), Some(url));
}

#[test]
fn unfinished_blocks_and_non_mermaid_blocks_do_not_create_previews() {
    let profile = tempfile::tempdir().unwrap();
    let mut previews = MermaidPreviews::new(profile.path());
    previews
        .prepare_message("agent-1", 1, "```mermaid\nflowchart LR\nA --> B")
        .unwrap();
    previews
        .prepare_message("agent-2", 1, "```rust\nfn main() {}\n```")
        .unwrap();
    assert!(previews.links().url("flowchart LR\nA --> B\n").is_none());
    assert!(!profile.path().join("ash-code/mermaid-previews").exists());
}

#[test]
fn failed_preparation_can_retry_the_same_message_revision_and_publishes_only_ready_links() {
    let profile = tempfile::tempdir().unwrap();
    let blocked = profile.path().join("ash-code");
    fs::write(&blocked, "not a directory").unwrap();
    let mut previews = MermaidPreviews::new(profile.path());
    let message = "```mermaid\nflowchart LR\nA --> B\n```";
    let source = "flowchart LR\nA --> B\n";
    assert!(previews.prepare_message("agent", 1, message).is_err());
    assert!(previews.links().url(source).is_none());
    fs::remove_file(blocked).unwrap();
    previews.prepare_message("agent", 1, message).unwrap();
    let url = previews.links().url(source).unwrap().to_owned();
    let path = Url::parse(&url).unwrap().to_file_path().unwrap();
    assert!(path.is_file());
    fs::remove_file(path).unwrap();
    // Layout reads the published address, never the filesystem.
    assert_eq!(previews.links().url(source), Some(url.as_str()));
    previews.reset_message_revisions();
    assert!(previews.links().url(source).is_none());
}
