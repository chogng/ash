use ash_api::ModelRequest;

// ZCode's Start Plan checks these two separate system blocks before accepting a request.
// Verified with Ash's own login and headers: removing either block or merging them into one
// returns 405 / 3012. No desktop context, device metadata or source-client headers are needed.
// Text matches ZCode 3.14.3, as recorded in magpie's 901fd87e zcode_prompt.json.
// Keep the caller's instructions after this provider-owned prelude, and its turns/tools intact.
const PREFIX: &str = "You are ZCode, an interactive coding agent";
const HARNESS: &str = r#"
You are an interactive ZCode agent that helps users with software engineering tasks.

IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.

# Harness
- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.
- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.
- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.
- Reference code as `file_path:line_number` — it's clickable.
"#;

pub(crate) const SYSTEM_PRELUDE: &[&str] = &[PREFIX, HARNESS];

/// Local input accounting includes the fixed prelude even though its wire blocks are separate.
pub(crate) fn measurement_request(request: &ModelRequest) -> ModelRequest {
    let mut request = request.clone();
    let own = request.instructions.as_deref().unwrap_or_default();
    request.instructions = Some(format!("{PREFIX}\n\n{HARNESS}\n\n{own}"));
    request
}
