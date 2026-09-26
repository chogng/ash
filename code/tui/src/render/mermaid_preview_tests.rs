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
    let url = previews.url(&format!("{source}\n")).unwrap();
    let document = fs::read_to_string(Url::parse(&url).unwrap().to_file_path().unwrap()).unwrap();
    assert!(document.contains("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;"));
    assert!(!document.contains("<script>alert('x')</script>"));
    assert!(document.contains("mermaid@11.16.1"));

    let reopened = MermaidPreviews::new(profile.path());
    assert_eq!(reopened.url(&format!("{source}\n")), Some(url));
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
    assert!(previews.url("flowchart LR\nA --> B\n").is_none());
    assert!(!profile.path().join("ash-code/mermaid-previews").exists());
}
