use super::CatalogEntry;
use super::ReasoningLevel;
use std::io::BufRead;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;

// Codex checks its cache identity against the current login before returning model/list.
// Reading that API avoids treating a previous account's models_cache.json as current.
pub(super) fn local_models(cache_path: &Path) -> Option<Vec<CatalogEntry>> {
    if !cache_path.is_file() {
        return None;
    }
    let home = cache_path.parent()?;
    let mut child = Command::new(codex_binary())
        .arg("app-server")
        .arg("--stdio")
        .env("CODEX_HOME", home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value.get("id") == Some(&serde_json::json!(2)) {
                let models: Option<Vec<CatalogEntry>> = value
                    .get("result")
                    .and_then(|result| result.get("data"))
                    .and_then(|data| serde_json::from_value::<Vec<CodexModel>>(data.clone()).ok())
                    .map(|models| {
                        models
                            .into_iter()
                            .map(CodexModel::into_catalog_entry)
                            .collect()
                    });
                let _ = sender.send(models);
                return;
            }
        }
        let _ = sender.send(None);
    });
    let requests = concat!(
        "{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"ash-catalog-import\",\"version\":\"1\"},\"capabilities\":{}}}\n",
        "{\"method\":\"initialized\",\"params\":{}}\n",
        "{\"id\":2,\"method\":\"model/list\",\"params\":{}}\n"
    );
    let models = if stdin.write_all(requests.as_bytes()).is_ok() && stdin.flush().is_ok() {
        receiver
            .recv_timeout(Duration::from_secs(10))
            .ok()
            .flatten()
    } else {
        None
    };
    let _ = child.kill();
    let _ = child.wait();
    models.filter(|models| !models.is_empty())
}

fn codex_binary() -> PathBuf {
    if cfg!(target_os = "macos") {
        for path in [
            "/Applications/ChatGPT.app/Contents/Resources/codex",
            "/Applications/Codex.app/Contents/Resources/codex",
        ] {
            if Path::new(path).is_file() {
                return PathBuf::from(path);
            }
        }
    }
    PathBuf::from("codex")
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexModel {
    id: String,
    display_name: String,
    hidden: bool,
    default_reasoning_effort: Option<String>,
    #[serde(default)]
    supported_reasoning_efforts: Vec<CodexReasoningEffort>,
}

impl CodexModel {
    fn into_catalog_entry(self) -> CatalogEntry {
        CatalogEntry {
            slug: self.id,
            display_name: Some(self.display_name),
            visibility: (!self.hidden).then_some("list".into()),
            context_window: None,
            default_reasoning_level: self.default_reasoning_effort,
            supported_reasoning_levels: self
                .supported_reasoning_efforts
                .into_iter()
                .map(|effort| ReasoningLevel {
                    effort: effort.reasoning_effort,
                })
                .collect(),
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodexReasoningEffort {
    reasoning_effort: String,
}

#[cfg(test)]
#[path = "codex_tests.rs"]
mod tests;
