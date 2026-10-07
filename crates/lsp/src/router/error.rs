use lsp_types::Uri;

use super::{EditorDocumentRevision, LanguageServerName};
use crate::LanguageServerError;

pub(super) const MAX_ID_BYTES: usize = 128;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum LanguageServerRouterError {
    #[error("invalid language server name `{value}`; expected 1-{maximum_bytes} non-control bytes")]
    InvalidServerName { value: String, maximum_bytes: usize },
    #[error("invalid language ID `{value}`; expected 1-{maximum_bytes} non-control bytes")]
    InvalidLanguageId { value: String, maximum_bytes: usize },
    #[error("language server `{server}` has no language IDs")]
    EmptyLanguageSet { server: LanguageServerName },
    #[error("language server `{server}` is already registered")]
    ServerAlreadyRegistered { server: LanguageServerName },
    #[error("language ID `{language_id}` is already routed to `{server}`")]
    LanguageAlreadyRegistered {
        language_id: String,
        server: LanguageServerName,
    },
    #[error("language ID `{language_id}` has no registered server")]
    LanguageNotRegistered { language_id: String },
    #[error("language server `{server}` is not registered")]
    ServerNotRegistered { server: LanguageServerName },
    #[error("document `{uri:?}` is already open in the language router")]
    DocumentAlreadyOpen { uri: Uri },
    #[error("document `{uri:?}` is not open in the language router")]
    DocumentNotOpen { uri: Uri },
    #[error("document `{uri:?}` language changed from `{expected}` to `{received}`")]
    DocumentLanguageChanged {
        uri: Uri,
        expected: String,
        received: String,
    },
    #[error("document `{uri:?}` editor revision {received:?} is not newer than {current:?}")]
    StaleEditorRevision {
        uri: Uri,
        current: EditorDocumentRevision,
        received: EditorDocumentRevision,
    },
    #[error("language server `{server}` incarnation overflowed")]
    IncarnationOverflow { server: LanguageServerName },
    #[error(transparent)]
    Runtime(#[from] LanguageServerError),
}

pub(super) fn validate_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_ID_BYTES
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
