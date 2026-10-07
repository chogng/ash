use std::collections::{BTreeMap, HashMap};

use lsp_types::Uri;

use crate::{
    DocumentSave, DocumentSaveSync, DocumentVersion, LanguageServerClient, LanguageServerError,
};

mod error;
mod types;

pub use error::LanguageServerRouterError;
pub use types::{
    EditorDocumentRevision, LanguageDocumentSnapshot, LanguageServerIncarnation,
    LanguageServerName, LanguageServerPreviousShutdown, LanguageServerReplacement,
    LanguageServerRoute, LanguageServerShutdownFailure, RoutedDocumentVersion,
};

/// Host-owned single-server-per-language document router.
///
/// The router never discovers or launches a server. Callers register already initialized clients.
/// It serializes full editor snapshots into each routed server, preserves the exact editor/LSP
/// revision binding, and switches to a replacement only after replaying its current documents.
/// Callers must gate events from the replacement host until [`Self::replace_server`] succeeds.
#[derive(Default)]
pub struct LanguageServerDocumentRouter {
    servers: BTreeMap<LanguageServerName, RoutedServer>,
    language_routes: HashMap<String, LanguageServerName>,
    documents: HashMap<Uri, RoutedDocument>,
}

impl LanguageServerDocumentRouter {
    pub fn register(
        &mut self,
        route: LanguageServerRoute,
        client: LanguageServerClient,
    ) -> Result<(), LanguageServerRouterError> {
        if self.servers.contains_key(&route.name) {
            return Err(LanguageServerRouterError::ServerAlreadyRegistered { server: route.name });
        }
        for language_id in &route.language_ids {
            if let Some(server) = self.language_routes.get(language_id) {
                return Err(LanguageServerRouterError::LanguageAlreadyRegistered {
                    language_id: language_id.clone(),
                    server: server.clone(),
                });
            }
        }
        let name = route.name;
        for language_id in route.language_ids {
            self.language_routes.insert(language_id, name.clone());
        }
        self.servers.insert(
            name,
            RoutedServer {
                client,
                incarnation: LanguageServerIncarnation::INITIAL,
            },
        );
        Ok(())
    }

    pub async fn open_document(
        &mut self,
        snapshot: LanguageDocumentSnapshot,
    ) -> Result<RoutedDocumentVersion, LanguageServerRouterError> {
        if self.documents.contains_key(&snapshot.uri) {
            return Err(LanguageServerRouterError::DocumentAlreadyOpen { uri: snapshot.uri });
        }
        let server_name = self
            .language_routes
            .get(&snapshot.language_id)
            .cloned()
            .ok_or_else(|| LanguageServerRouterError::LanguageNotRegistered {
                language_id: snapshot.language_id.clone(),
            })?;
        let server = self
            .servers
            .get(&server_name)
            .expect("language route always names a registered server");
        let server_version = server
            .client
            .open_document(
                snapshot.uri.clone(),
                snapshot.language_id.clone(),
                snapshot.text.clone(),
            )
            .await?;
        let version = RoutedDocumentVersion {
            editor_revision: snapshot.editor_revision,
            server_incarnation: server.incarnation,
            server_version,
        };
        self.documents.insert(
            snapshot.uri,
            RoutedDocument {
                server_name,
                language_id: snapshot.language_id,
                editor_revision: snapshot.editor_revision,
                server_version,
                text: snapshot.text,
            },
        );
        Ok(version)
    }

    pub async fn update_document(
        &mut self,
        snapshot: LanguageDocumentSnapshot,
    ) -> Result<RoutedDocumentVersion, LanguageServerRouterError> {
        let document = self.documents.get(&snapshot.uri).ok_or_else(|| {
            LanguageServerRouterError::DocumentNotOpen {
                uri: snapshot.uri.clone(),
            }
        })?;
        if document.language_id != snapshot.language_id {
            return Err(LanguageServerRouterError::DocumentLanguageChanged {
                uri: snapshot.uri,
                expected: document.language_id.clone(),
                received: snapshot.language_id,
            });
        }
        if snapshot.editor_revision <= document.editor_revision {
            return Err(LanguageServerRouterError::StaleEditorRevision {
                uri: snapshot.uri,
                current: document.editor_revision,
                received: snapshot.editor_revision,
            });
        }
        let server_name = document.server_name.clone();
        let server = self
            .servers
            .get(&server_name)
            .expect("open document always names a registered server");
        let server_version = server
            .client
            .change_document(
                &snapshot.uri,
                crate::DocumentChange::Full(snapshot.text.clone()),
            )
            .await?;
        let document = self
            .documents
            .get_mut(&snapshot.uri)
            .expect("document remains open while update is serialized");
        document.editor_revision = snapshot.editor_revision;
        document.server_version = server_version;
        document.text = snapshot.text;
        Ok(RoutedDocumentVersion {
            editor_revision: document.editor_revision,
            server_incarnation: server.incarnation,
            server_version,
        })
    }

    pub async fn save_document(&self, uri: &Uri) -> Result<(), LanguageServerRouterError> {
        let document = self
            .documents
            .get(uri)
            .ok_or_else(|| LanguageServerRouterError::DocumentNotOpen { uri: uri.clone() })?;
        let server = self
            .servers
            .get(&document.server_name)
            .expect("open document always names a registered server");
        let save = match server.client.initialization().document_sync.save {
            DocumentSaveSync::IncludeText => DocumentSave::WithText(&document.text),
            DocumentSaveSync::WithoutText => DocumentSave::WithoutText,
            DocumentSaveSync::None => {
                return Err(LanguageServerRouterError::Runtime(
                    LanguageServerError::UnsupportedDocumentOperation(
                        "text document save synchronization",
                    ),
                ));
            }
        };
        server.client.save_document(uri, save).await?;
        Ok(())
    }

    pub async fn close_document(&mut self, uri: &Uri) -> Result<(), LanguageServerRouterError> {
        let document = self
            .documents
            .get(uri)
            .ok_or_else(|| LanguageServerRouterError::DocumentNotOpen { uri: uri.clone() })?;
        let client = self
            .servers
            .get(&document.server_name)
            .expect("open document always names a registered server")
            .client
            .clone();
        client.close_document(uri).await?;
        self.documents.remove(uri);
        Ok(())
    }

    pub fn document_version(
        &self,
        uri: &Uri,
    ) -> Result<RoutedDocumentVersion, LanguageServerRouterError> {
        let document = self
            .documents
            .get(uri)
            .ok_or_else(|| LanguageServerRouterError::DocumentNotOpen { uri: uri.clone() })?;
        let server = self
            .servers
            .get(&document.server_name)
            .expect("open document always names a registered server");
        Ok(RoutedDocumentVersion {
            editor_revision: document.editor_revision,
            server_incarnation: server.incarnation,
            server_version: document.server_version,
        })
    }

    pub fn client_for_document(
        &self,
        uri: &Uri,
    ) -> Result<&LanguageServerClient, LanguageServerRouterError> {
        let document = self
            .documents
            .get(uri)
            .ok_or_else(|| LanguageServerRouterError::DocumentNotOpen { uri: uri.clone() })?;
        Ok(&self
            .servers
            .get(&document.server_name)
            .expect("open document always names a registered server")
            .client)
    }

    /// Returns the initialized client registered for one language without requiring an open document.
    pub fn client_for_language(
        &self,
        language_id: &str,
    ) -> Result<&LanguageServerClient, LanguageServerRouterError> {
        let server_name = self.language_routes.get(language_id).ok_or_else(|| {
            LanguageServerRouterError::LanguageNotRegistered {
                language_id: language_id.into(),
            }
        })?;
        Ok(&self
            .servers
            .get(server_name)
            .expect("language route always names a registered server")
            .client)
    }

    /// Returns the initialized client for one registered server route.
    pub fn client_for_server(
        &self,
        server_name: &LanguageServerName,
    ) -> Result<&LanguageServerClient, LanguageServerRouterError> {
        Ok(&self
            .servers
            .get(server_name)
            .ok_or_else(|| LanguageServerRouterError::ServerNotRegistered {
                server: server_name.clone(),
            })?
            .client)
    }

    pub async fn replace_server(
        &mut self,
        name: &LanguageServerName,
        replacement: LanguageServerClient,
    ) -> Result<LanguageServerReplacement, LanguageServerRouterError> {
        let current = self.servers.get(name).ok_or_else(|| {
            LanguageServerRouterError::ServerNotRegistered {
                server: name.clone(),
            }
        })?;
        let next_incarnation = current.incarnation.next(name)?;
        let mut snapshots: Vec<_> = self
            .documents
            .iter()
            .filter(|(_, document)| &document.server_name == name)
            .map(|(uri, document)| {
                (
                    uri.clone(),
                    document.language_id.clone(),
                    document.text.clone(),
                )
            })
            .collect();
        snapshots.sort_by_key(|snapshot| snapshot.0.to_string());
        let mut replayed = Vec::new();
        for (uri, language_id, text) in &snapshots {
            match replacement
                .open_document(uri.clone(), language_id.clone(), text.clone())
                .await
            {
                Ok(version) => replayed.push((uri.clone(), version)),
                Err(error) => {
                    for (uri, _) in &replayed {
                        let _ = replacement.close_document(uri).await;
                    }
                    let _ = replacement.shutdown().await;
                    return Err(error.into());
                }
            }
        }
        let old = {
            let server = self
                .servers
                .get_mut(name)
                .expect("server remains registered during replacement");
            let old = std::mem::replace(&mut server.client, replacement);
            server.incarnation = next_incarnation;
            old
        };
        for (uri, version) in replayed {
            let document = self
                .documents
                .get_mut(&uri)
                .expect("replayed document remains routed");
            document.server_version = version;
        }
        let previous_shutdown = match old.shutdown().await {
            Ok(()) => LanguageServerPreviousShutdown::Clean,
            Err(error) => LanguageServerPreviousShutdown::Failed(error.to_string()),
        };
        Ok(LanguageServerReplacement {
            incarnation: next_incarnation,
            replayed_documents: snapshots.len(),
            previous_shutdown,
        })
    }

    /// Remove a server whose protocol transport has already closed.
    ///
    /// The route and all of its document bindings are discarded before the disconnected process
    /// is terminated. A supervisor may then register a fresh client and replay authoritative
    /// editor snapshots without reusing stale router text.
    pub async fn remove_disconnected_server(
        &mut self,
        name: &LanguageServerName,
    ) -> Result<usize, LanguageServerRouterError> {
        let server = self.servers.remove(name).ok_or_else(|| {
            LanguageServerRouterError::ServerNotRegistered {
                server: name.clone(),
            }
        })?;
        self.language_routes.retain(|_, server| server != name);
        let before = self.documents.len();
        self.documents
            .retain(|_, document| &document.server_name != name);
        let removed_documents = before - self.documents.len();
        server.client.abort_disconnected().await;
        Ok(removed_documents)
    }

    pub async fn shutdown(self) -> Vec<LanguageServerShutdownFailure> {
        let mut failures = Vec::new();
        for (server, routed) in self.servers {
            if let Err(error) = routed.client.shutdown().await {
                failures.push(LanguageServerShutdownFailure {
                    server,
                    message: error.to_string(),
                });
            }
        }
        failures
    }
}

struct RoutedServer {
    client: LanguageServerClient,
    incarnation: LanguageServerIncarnation,
}

struct RoutedDocument {
    server_name: LanguageServerName,
    language_id: String,
    editor_revision: EditorDocumentRevision,
    server_version: DocumentVersion,
    text: String,
}
