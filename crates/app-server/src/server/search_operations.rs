use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::search::ContentSearchCancelParams;
use ash_app_server_protocol::protocol::search::ContentSearchCaseSensitivity as ContentSearchProtocolCaseSensitivity;
use ash_app_server_protocol::protocol::search::ContentSearchFreshness;
use ash_app_server_protocol::protocol::search::ContentSearchIndexStats;
use ash_app_server_protocol::protocol::search::ContentSearchMatch as ContentSearchProtocolMatch;
use ash_app_server_protocol::protocol::search::ContentSearchMatchRange as ContentSearchProtocolMatchRange;
use ash_app_server_protocol::protocol::search::ContentSearchPatternKind;
use ash_app_server_protocol::protocol::search::ContentSearchReadParams;
use ash_app_server_protocol::protocol::search::ContentSearchReadResult;
use ash_app_server_protocol::protocol::search::ContentSearchStartParams;
use ash_app_server_protocol::protocol::search::ContentSearchStartResult;
use ash_app_server_protocol::protocol::search::FileGlobCancelParams;
use ash_app_server_protocol::protocol::search::FileGlobParams;
use ash_app_server_protocol::protocol::search::FileGlobResult;
use ash_app_server_protocol::protocol::search::FileGlobTarget;
use ash_async_utils::CancellationToken;
use ash_file_access::Permission;
use grep::CaseSensitivity as ContentSearchCaseSensitivity;
use grep::JobError as ContentSearchError;
use grep::Owner as ContentSearchOwner;
use grep::Page as ContentSearchPage;
use grep::Pattern as ContentSearchPattern;
use grep::Query as ContentSearchQuery;
use serde_json::Value;

impl AppServer {
    pub(super) fn file_glob(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: FileGlobParams = decode(params)?;
        let authorization = match params.target {
            FileGlobTarget::Workspace { dir_id } => {
                let runtime = self
                    .env_runtime
                    .read()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                runtime
                    .dirs
                    .get(&dir_id)
                    .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?
                    .authorize(Permission::SearchFiles)
                    .map_err(|_| RpcError::new(-32043, AppServerErrorName::PermissionRequired))?
            }
            FileGlobTarget::Session { session_id, path } => self
                .session_dir_authorization(&session_id, &path, Permission::SearchFiles)
                .map_err(|error| {
                    if error.code == -32064 {
                        RpcError::new(-32043, AppServerErrorName::PermissionRequired)
                    } else {
                        error
                    }
                })?,
        };
        let query = file_search::GlobQuery {
            scope: Default::default(),
            include_patterns: params.include_patterns,
            exclude_patterns: params.exclude_patterns,
            max_results: params.max_results,
        };
        // Hold the grant lease for the scan; directory replacement/revocation waits for admitted I/O.
        let found = authorization
            .execute(
                authorization.subject(),
                authorization.dir(),
                Permission::SearchFiles,
                || {
                    self.file_search
                        .glob(authorization.dir(), &query, cancellation)
                },
            )
            .map_err(|_| RpcError::new(-32043, AppServerErrorName::PermissionRequired))?
            .map_err(file_glob_error)?;
        let paths = found
            .paths
            .into_iter()
            .map(|path| {
                path.components()
                    .map(|part| part.as_os_str().to_str().expect("glob returns UTF-8 paths"))
                    .collect::<Vec<_>>()
                    .join("/")
            })
            .collect();
        result(&FileGlobResult {
            paths,
            total_matches: found.total_matches,
        })
    }

    pub(super) fn file_glob_cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: FileGlobCancelParams = decode(params)?;
        if params.operation_id.is_empty() || params.operation_id.chars().count() > 128 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        self.request_cancellations
            .cancel_operation(connection.connection_id, params.operation_id);
        self.request_scheduler.cancel_waiting_requests();
        result(&())
    }

    pub(super) fn grep_index_status(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let (service, root) = self.grep_index_context()?;
        let snapshot = service
            .index_status(&root, &ash_async_utils::CancellationSource::new().token())
            .map_err(|_| RpcError::new(-32050, AppServerErrorName::SearchUnavailable))?;
        result(&grep_status(snapshot))
    }

    pub(super) fn grep_index_rebuild(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        let (service, root) = self.grep_index_context()?;
        let snapshot = service
            .rebuild_index(&root, &ash_async_utils::CancellationSource::new().token())
            .map_err(|_| RpcError::new(-32050, AppServerErrorName::SearchUnavailable))?;
        result(&grep_status(snapshot))
    }

    pub(super) fn content_search_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ContentSearchStartParams = decode(params)?;
        let dir_id = params.dir_id.clone();
        let search =
            self.search_service_for_request(dir_id.as_deref(), params.session_directory.as_ref())?;
        let search_id = search
            .start(search_owner(connection), search_query(params))
            .map_err(search_error)?;
        result(&ContentSearchStartResult { search_id })
    }

    pub(super) fn content_search_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ContentSearchReadParams = decode(params)?;
        let dir_id = params.dir_id;
        let search =
            self.search_service_for_request(dir_id.as_deref(), params.session_directory.as_ref())?;
        let search_id = params.search_id;
        let page = search
            .read(
                search_owner(connection),
                &search_id,
                params.after_match,
                params.max_matches,
            )
            .map_err(search_error)?;
        result(&search_page(search_id, page))
    }

    pub(super) fn content_search_cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ContentSearchCancelParams = decode(params)?;
        self.search_service_for_request(
            params.dir_id.as_deref(),
            params.session_directory.as_ref(),
        )?
        .cancel(search_owner(connection), &params.search_id)
        .map_err(search_error)?;
        result(&())
    }

    fn search_service_for_request(
        &self,
        dir_id: Option<&str>,
        session_directory: Option<
            &ash_app_server_protocol::protocol::environment::SessionDirSelector,
        >,
    ) -> Result<std::sync::Arc<grep::Jobs>, RpcError> {
        match (dir_id, session_directory) {
            (Some(_), Some(_)) => Err(RpcError::new(-32602, AppServerErrorName::InvalidParams)),
            (_, Some(selector)) => self.content_search_service_for_session_directory(selector),
            (_, None) => self.content_search_service_for(dir_id),
        }
    }
}

fn search_owner(connection: &ConnectionState) -> ContentSearchOwner {
    ContentSearchOwner::new(connection.connection_id)
}

fn search_query(params: ContentSearchStartParams) -> ContentSearchQuery {
    ContentSearchQuery {
        query: params.query,
        pattern: match params.pattern_kind {
            ContentSearchPatternKind::Literal => ContentSearchPattern::Literal,
            ContentSearchPatternKind::Regex => ContentSearchPattern::Regex,
        },
        case_sensitivity: match params.case_sensitivity {
            ContentSearchProtocolCaseSensitivity::Smart => ContentSearchCaseSensitivity::Smart,
            ContentSearchProtocolCaseSensitivity::Sensitive => {
                ContentSearchCaseSensitivity::Sensitive
            }
            ContentSearchProtocolCaseSensitivity::Insensitive => {
                ContentSearchCaseSensitivity::Insensitive
            }
        },
        include_patterns: params.include_patterns,
        exclude_patterns: params.exclude_patterns,
        max_results: params.max_results,
        scope: Default::default(),
        freshness: match params.freshness.unwrap_or_default() {
            ContentSearchFreshness::Indexed => grep::Freshness::Indexed,
            ContentSearchFreshness::Current => grep::Freshness::Current,
        },
    }
}

fn search_page(search_id: String, page: ContentSearchPage) -> ContentSearchReadResult {
    ContentSearchReadResult {
        search_id,
        matches: page
            .matches
            .into_iter()
            .map(|search_match| ContentSearchProtocolMatch {
                path: search_match.path,
                line_number: search_match.line_number,
                preview: search_match.content.clone(),
                ranges: search_match
                    .ranges
                    .into_iter()
                    .map(|range| ContentSearchProtocolMatchRange {
                        start: search_match.content[..range.start].encode_utf16().count(),
                        end: search_match.content[..range.end].encode_utf16().count(),
                    })
                    .collect(),
            })
            .collect(),
        next_match: page.next_match,
        completed: page.completed,
        limit_hit: page.limit_hit,
        error: page.error,
        index_stats: page.index_stats.map(|stats| ContentSearchIndexStats {
            query_plan: stats.query_plan,
            raw_candidates: stats.raw_candidates,
            candidates: stats.candidates,
            total_files: stats.total_files,
        }),
        freshness: page.freshness.map(|freshness| match freshness {
            grep::Freshness::Indexed => ContentSearchFreshness::Indexed,
            grep::Freshness::Current => ContentSearchFreshness::Current,
        }),
    }
}

fn search_error(error: ContentSearchError) -> RpcError {
    match error {
        ContentSearchError::InvalidInput => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        ContentSearchError::NotFound => RpcError::new(-32051, AppServerErrorName::SearchNotFound),
        ContentSearchError::NotOwner => RpcError::new(-32052, AppServerErrorName::SearchNotOwner),
        ContentSearchError::Busy => RpcError::new(-32053, AppServerErrorName::SearchBusy),
        ContentSearchError::Unavailable => {
            RpcError::new(-32050, AppServerErrorName::SearchUnavailable)
        }
    }
}

#[cfg(test)]
#[path = "search_operations_tests.rs"]
mod tests;

fn grep_status(
    status: grep::IndexStatus,
) -> ash_app_server_protocol::protocol::search::GrepIndexStatusResult {
    ash_app_server_protocol::protocol::search::GrepIndexStatusResult {
        enabled: status.enabled,
        active: status.active,
        indexing: status.indexing,
        ready: status.ready,
        indexed_file_count: status.indexed_file_count,
        watcher_active: status.watcher_active,
    }
}

fn file_glob_error(error: file_search::Error) -> RpcError {
    match error {
        file_search::Error::InvalidInput(_) => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        file_search::Error::Cancelled(_) => {
            RpcError::new(-32800, AppServerErrorName::RequestCancelled)
        }
        file_search::Error::Failed(_) => {
            RpcError::new(-32050, AppServerErrorName::SearchUnavailable)
        }
    }
}
