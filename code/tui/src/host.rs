pub(crate) mod browser;
pub(crate) mod clipboard;
pub(crate) mod mermaid_preview;
mod termination;
pub(crate) mod text_editor;
pub(crate) mod transcript_export;

/// A completed host operation delivered to the TUI state owner.
pub(crate) enum Event {
    ClipboardImageRead {
        target: crate::thread::composer::DraftTarget,
        result: Result<clipboard::ClipboardImage, String>,
    },
    ClipboardImageAvailabilityChanged(clipboard::ClipboardImageAvailability),
    OperationCompleted(Result<String, String>),
    ProcessResourcesSampled(ash_memory_diagnostics::ProcessResourcesReading),
    TopTipNoticeShown(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    OpenTextFile {
        path: std::path::PathBuf,
    },
    CopyLastResponse,
    CopyText(String),
    ExportTranscript {
        requested_path: Option<std::path::PathBuf>,
    },
    ReadClipboardImage {
        target: crate::thread::composer::DraftTarget,
    },
    RefreshClipboardImageAvailability,
}

pub(crate) enum Operation {
    OpenTextFile {
        path: std::path::PathBuf,
        language: crate::nls::Language,
    },
    CopyLastResponse(Result<String, String>),
    CopyText {
        text: String,
        language: crate::nls::Language,
    },
    ExportTranscript {
        root: std::path::PathBuf,
        requested_path: Option<std::path::PathBuf>,
        markdown: String,
    },
    ReadClipboardImage {
        target: crate::thread::composer::DraftTarget,
    },
    RefreshClipboardImageAvailability,
}

impl Operation {
    pub(crate) const fn name(&self) -> &'static str {
        match self {
            Self::OpenTextFile { .. } => "ash-tui-open-text-file",
            Self::CopyText { .. } => "ash-tui-copy-text",
            Self::CopyLastResponse(_) => "ash-tui-copy-last-response",
            Self::ExportTranscript { .. } => "ash-tui-export-transcript",
            Self::ReadClipboardImage { .. } => "ash-tui-read-clipboard-image",
            Self::RefreshClipboardImageAvailability => {
                "ash-tui-refresh-clipboard-image-availability"
            }
        }
    }

    pub(crate) fn execute(self) -> Event {
        match self {
            Self::OpenTextFile { path, language } => {
                Event::OperationCompleted(text_editor::open(&path, language))
            }
            Self::CopyText { text, language } => match clipboard::write_text(&text) {
                Ok(()) => Event::TopTipNoticeShown(crate::nls::localize_owned(
                    language,
                    "Required domains copied",
                )),
                Err(_) => Event::OperationCompleted(Err(crate::nls::localize_owned(
                    language,
                    "Could not copy required domains",
                ))),
            },
            Self::CopyLastResponse(response) => copy_last_response(response),
            Self::ExportTranscript {
                root,
                requested_path,
                markdown,
            } => export_transcript(root, requested_path, markdown),
            Self::ReadClipboardImage { target } => Event::ClipboardImageRead {
                target,
                result: clipboard::read_image(),
            },
            Self::RefreshClipboardImageAvailability => {
                Event::ClipboardImageAvailabilityChanged(clipboard::image_availability())
            }
        }
    }
}

fn copy_last_response(response: Result<String, String>) -> Event {
    match response.and_then(|response| {
        let char_count = response.chars().count();
        clipboard::write_text(&response).map(|()| char_count)
    }) {
        Ok(char_count) => {
            Event::TopTipNoticeShown(format!("Copied {char_count} chars to clipboard"))
        }
        Err(error) => Event::OperationCompleted(Err(error)),
    }
}

fn export_transcript(
    root: std::path::PathBuf,
    requested_path: Option<std::path::PathBuf>,
    markdown: String,
) -> Event {
    let result = if markdown.is_empty() {
        Err("there is no conversation to export".to_owned())
    } else {
        transcript_export::write(&root, requested_path.as_deref(), &markdown)
            .map(|path| format!("Exported conversation to {}", path.display()))
    };
    Event::OperationCompleted(result)
}

pub(crate) use termination::TerminationSource;
