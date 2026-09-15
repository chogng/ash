use super::suite::ResolvedFilePath;
use super::suite::limit_matches;
use ash_async_utils::CancellationToken;
use ash_core::ToolExecutionOutput;
use core_api::CoreError;

/// Model-facing formatting only. Engine selection and index ownership belong to grep.
pub(super) fn execute(
    search: &dyn grep::Search,
    pattern: String,
    path: &ResolvedFilePath,
    glob: Option<String>,
    case_insensitive: bool,
    cancellation: &CancellationToken,
) -> Result<ToolExecutionOutput, CoreError> {
    let mut include_patterns = Vec::new();
    let mut exclude_patterns = super::LOCAL_DENIED_GLOBS
        .iter()
        .map(|s| (*s).to_owned())
        .collect::<Vec<_>>();
    if let Some(glob) = glob {
        match glob.strip_prefix('!') {
            Some(exclude) => exclude_patterns.push(exclude.to_owned()),
            None => include_patterns.push(glob),
        }
    }
    let query = grep::Query {
        query: pattern,
        pattern: grep::Pattern::Regex,
        case_sensitivity: if case_insensitive {
            grep::CaseSensitivity::Insensitive
        } else {
            grep::CaseSensitivity::Sensitive
        },
        scope: path.relative.clone(),
        include_patterns,
        exclude_patterns,
        max_results: 100,
        freshness: grep::Freshness::Indexed,
    };
    let result = match search.search(&path.root, &query, cancellation) {
        Ok(result) => result,
        Err(grep::Error::Cancelled(reason)) => return Err(CoreError::Cancelled(reason)),
        Err(error) => return Ok(ToolExecutionOutput::Failure(error.to_string())),
    };
    if result.matches.is_empty() {
        return Ok(ToolExecutionOutput::Success(
            match result.freshness {
                grep::Freshness::Indexed => {
                    "no matches in indexed files (filesystem updates are applied asynchronously)"
                }
                grep::Freshness::Current => "no matches",
            }
            .into(),
        ));
    }
    let text = result
        .matches
        .into_iter()
        .map(|found| {
            format!(
                "{}:{}:{}",
                path.root.canonical_path().join(found.path).display(),
                found.line_number,
                found.content
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let mut output = limit_matches(&text, 500);
    if result.limit_hit {
        output.push_str("\n[more than 100 matches, showing first 100]");
    }
    Ok(ToolExecutionOutput::Success(output))
}
