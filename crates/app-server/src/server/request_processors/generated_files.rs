use super::ConnectionAuthority;
use super::RpcError;
use super::UpdateBroker;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::fs::FsDirectoryTarget;
use ash_app_server_protocol::protocol::fs::FsResolvePathResult;
use ash_app_server_protocol::protocol::generated_files::GeneratedFileChanged;
use ash_app_server_protocol::protocol::generated_files::GeneratedFileDto;
use ash_app_server_protocol::protocol::generated_files::GeneratedFileListParams;
use ash_app_server_protocol::protocol::generated_files::GeneratedFileListResult;
use ash_app_server_protocol::protocol::generated_files::GeneratedFileRegisterParams;
use ash_app_server_protocol::protocol::generated_files::GeneratedFileRegisterResult;
use ash_app_server_protocol::protocol::generated_files::GeneratedFileSourceDto;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_system::ExactFileSystem;
use ash_file_system::FileSystem;
use ash_state::GeneratedFileError;
use ash_state::GeneratedFileRecord;
use ash_state::GeneratedFileRegistration;
use ash_state::GeneratedFileRegistrationOutcome;
use ash_state::GeneratedFileSource;
use ash_state::NATIVE_GENERATED_FILE_CLIENT;
use ash_state::SqliteGeneratedFileStore;
use serde_json::Value;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

const WEB_FILE_ROUTE: &str = "generated-file:";

#[derive(Clone, Default)]
pub(super) struct GeneratedFileRequestProcessor {
    store: Option<Arc<SqliteGeneratedFileStore>>,
    native_directory: Option<PathBuf>,
}

impl GeneratedFileRequestProcessor {
    pub(super) fn new(
        store: Arc<SqliteGeneratedFileStore>,
        native_directory: Option<PathBuf>,
    ) -> Self {
        Self {
            store: Some(store),
            native_directory: native_directory.map(|path| dunce::simplified(&path).to_owned()),
        }
    }

    pub(super) fn is_available(&self, authority: ConnectionAuthority) -> bool {
        self.store.is_some()
            && (authority == ConnectionAuthority::ProductHost
                || authority == ConnectionAuthority::Browser && self.native_directory.is_some())
    }

    pub(super) fn publish_native(&self, updates: &UpdateBroker) {
        let (Some(store), Some(directory)) = (&self.store, &self.native_directory) else {
            return;
        };
        let ids = match store.pending_native_ids() {
            Ok(ids) => ids,
            Err(error) => {
                eprintln!("Could not read pending generated documents: {error}");
                return;
            }
        };
        if ids.is_empty() {
            return;
        }
        if let Err(error) = prepare_native_directory(directory) {
            eprintln!("Could not open the generated document directory: {error}");
            return;
        }
        let mut changed = false;
        for id in ids {
            match publish_native_file(store, directory, &id) {
                Ok(inserted) => changed |= inserted,
                Err(error) => eprintln!("Could not publish a generated document: {error}"),
            }
        }
        if changed {
            updates.publish_generated_file_changed(GeneratedFileChanged {
                client_id: NATIVE_GENERATED_FILE_CLIENT.into(),
            });
        }
    }

    pub(super) fn web_file_route(&self, path: &Path) -> Option<FsResolvePathResult> {
        let root = self.native_directory.as_ref()?;
        if path.parent()? != root {
            return None;
        }
        let id = path.file_name()?.to_str()?.strip_suffix(".md")?;
        self.published_native_directory(id)?;
        Some(FsResolvePathResult {
            root: root.clone(),
            exact_file: Some(true),
            target: FsDirectoryTarget::Environment {
                dir_id: format!("{WEB_FILE_ROUTE}{id}"),
            },
        })
    }

    pub(super) fn web_file_system(
        &self,
        route: Option<&str>,
    ) -> Result<Option<Arc<dyn FileSystem>>, RpcError> {
        let Some(id) = route.and_then(|route| route.strip_prefix(WEB_FILE_ROUTE)) else {
            return Ok(None);
        };
        let directory = self
            .published_native_directory(id)
            .ok_or_else(permission_required)?;
        let dir = open_native_directory(directory).map_err(|_| permission_required())?;
        let grant = Grant::for_environment(
            dir,
            GrantSource::HostConfiguration,
            Permissions::new([
                Permission::BrowseFiles,
                Permission::ReadFiles,
                Permission::WriteFiles,
            ]),
        );
        let name = native_file_name(id);
        let files = ExactFileSystem::new(grant, Path::new(&name))
            .map_err(super::fs_operations::file_system_error)?;
        Ok(Some(Arc::new(files)))
    }

    fn published_native_directory(&self, id: &str) -> Option<&Path> {
        if !self.store.as_ref()?.has_native_file(id).ok()? {
            return None;
        }
        self.native_directory.as_deref()
    }

    pub(super) fn register(
        &self,
        authority: ConnectionAuthority,
        params: &Value,
        updates: &UpdateBroker,
    ) -> Result<Value, RpcError> {
        let params: GeneratedFileRegisterParams = decode(params)?;
        if authority != ConnectionAuthority::ProductHost {
            return Err(permission_required());
        }
        let store = self.store.as_deref().ok_or_else(unavailable)?;
        if params.client_id == NATIVE_GENERATED_FILE_CLIENT {
            return Err(permission_required());
        }
        let file = params.file;
        let registration = GeneratedFileRegistration {
            id: file.id,
            resource: file.resource,
            title: file.title,
            content_type: file.content_type,
            source: GeneratedFileSource {
                provider_id: file.source.provider_id,
                account_id: file.source.account_id,
                session_id: file.source.session_id,
                thread_id: file.source.thread_id,
                item_id: file.source.item_id,
                part_id: file.source.part_id,
            },
        };
        let file = match store
            .register(&params.client_id, &registration)
            .map_err(generated_file_error)?
        {
            GeneratedFileRegistrationOutcome::Created(file) => {
                updates.publish_generated_file_changed(GeneratedFileChanged {
                    client_id: params.client_id,
                });
                file
            }
            GeneratedFileRegistrationOutcome::Existing(file) => file,
        };
        result(&GeneratedFileRegisterResult { file: record(file) })
    }

    pub(super) fn list(
        &self,
        authority: ConnectionAuthority,
        params: &Value,
        updates: &UpdateBroker,
    ) -> Result<Value, RpcError> {
        let params: GeneratedFileListParams = decode(params)?;
        let (client_id, browser_directory) = match authority {
            ConnectionAuthority::ProductHost => (params.client_id.as_str(), None),
            ConnectionAuthority::Browser => (
                NATIVE_GENERATED_FILE_CLIENT,
                Some(
                    self.native_directory
                        .as_deref()
                        .ok_or_else(permission_required)?,
                ),
            ),
            ConnectionAuthority::Client | ConnectionAuthority::RemoteHost => {
                return Err(permission_required());
            }
        };
        let store = self.store.as_deref().ok_or_else(unavailable)?;
        self.publish_native(updates);
        let files = store
            .list(client_id, params.account_ids.as_deref().unwrap_or_default())
            .map_err(generated_file_error)?
            .into_iter()
            .filter_map(|entry| {
                let mut dto = record(entry);
                if let Some(directory) = browser_directory {
                    let resource =
                        url::Url::from_file_path(directory.join(native_file_name(&dto.id))).ok()?;
                    dto.resource = resource.to_string();
                }
                Some(dto)
            })
            .collect();
        result(&GeneratedFileListResult { files })
    }
}

fn native_file_name(id: &str) -> String {
    format!("{id}.md")
}

fn open_native_directory(directory: &Path) -> std::io::Result<Dir> {
    let dir = Dir::open_local(directory).map_err(std::io::Error::other)?;
    if dir.canonical_path() != directory {
        return Err(std::io::Error::other(
            "generated document directory resolves outside its profile path",
        ));
    }
    Ok(dir)
}

fn prepare_native_directory(directory: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    open_native_directory(directory)?;
    Ok(())
}

fn publish_native_file(
    store: &SqliteGeneratedFileStore,
    directory: &Path,
    id: &str,
) -> Result<bool, GeneratedFileError> {
    let Some(markdown) = store.pending_native_markdown(id)? else {
        return Ok(false);
    };
    let name = native_file_name(id);
    ash_utils_path::ensure_file_atomically(&directory.join(&name), markdown.as_bytes())
        .map_err(|error| GeneratedFileError::Storage(error.to_string()))?;
    store.finish_native_publication(id, &format!("ash-userdata:/user/generated-files/{name}"))
}

fn permission_required() -> RpcError {
    RpcError::new(-32001, AppServerErrorName::PermissionRequired)
}

fn unavailable() -> RpcError {
    RpcError::new(-32002, AppServerErrorName::GeneratedFileUnavailable)
}

fn record(record: GeneratedFileRecord) -> GeneratedFileDto {
    let file = record.file;
    GeneratedFileDto {
        id: file.id,
        resource: file.resource,
        title: file.title,
        content_type: file.content_type,
        source: GeneratedFileSourceDto {
            provider_id: file.source.provider_id,
            account_id: file.source.account_id,
            session_id: file.source.session_id,
            thread_id: file.source.thread_id,
            item_id: file.source.item_id,
            part_id: file.source.part_id,
        },
        created_at: record.created_at,
    }
}

fn generated_file_error(error: GeneratedFileError) -> RpcError {
    match error {
        GeneratedFileError::Invalid => {
            RpcError::new(-32602, AppServerErrorName::GeneratedFileInvalid)
        }
        GeneratedFileError::Conflict => {
            RpcError::new(-32003, AppServerErrorName::GeneratedFileConflict)
        }
        GeneratedFileError::Storage(detail) => RpcError::with_details(
            -32000,
            AppServerErrorName::GeneratedFileOperationFailed,
            detail,
        ),
    }
}

#[cfg(test)]
#[path = "generated_files_tests.rs"]
mod tests;
