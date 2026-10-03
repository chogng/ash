use ash_file_access::Dir;
use ec4rs::PropertiesSource;
use ec4rs::property::EndOfLine;
use std::io;
use std::ops::Range;
use std::path::Path;

/// Text conventions shared by Agent patch, replacement, and full-file writes.
/// Existing content takes precedence over project settings so an ordinary edit
/// cannot silently convert a file or add/remove its final newline.
pub struct TextFileFormat {
    eol: &'static str,
    final_newline: Option<bool>,
}

impl TextFileFormat {
    /// Preferred line ending for newly inserted text.
    pub fn eol(&self) -> &'static str {
        self.eol
    }

    pub fn for_existing(text: &str) -> Self {
        let crlf = text.matches("\r\n").count();
        let lf = text.matches('\n').count() - crlf;
        let cr = text.matches('\r').count() - crlf;
        let eol = if crlf > lf && crlf >= cr {
            "\r\n"
        } else if cr > lf {
            "\r"
        } else {
            "\n"
        };
        Self {
            eol,
            final_newline: Some(text.ends_with(['\r', '\n'])),
        }
    }

    /// Resolves EditorConfig only inside the host-selected directory. Pattern
    /// matching and inheritance use the EditorConfig parser, including `unset`.
    pub fn for_new_file(dir: &Dir, path: &Path) -> io::Result<Self> {
        let mut configs = Vec::new();
        for parent in path.ancestors().skip(1) {
            let config = parent.join(".editorconfig");
            dir.resolve_for_write(&config).map_err(io::Error::other)?;
            let bytes = match dir.directory().handle().read(&config) {
                Ok(bytes) => bytes,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
            };
            let parser =
                ec4rs::ConfigParser::new(io::Cursor::new(bytes)).map_err(io::Error::other)?;
            let is_root = parser.is_root;
            configs.push((parent, parser));
            if is_root {
                break;
            }
        }
        let mut properties = ec4rs::Properties::new();
        for (parent, mut parser) in configs.into_iter().rev() {
            parser
                .apply_to(
                    &mut properties,
                    path.strip_prefix(parent).map_err(io::Error::other)?,
                )
                .map_err(io::Error::other)?;
        }
        let eol = match properties.get::<EndOfLine>() {
            Ok(EndOfLine::Lf) | Err(_) => "\n",
            Ok(EndOfLine::CrLf) => "\r\n",
            Ok(EndOfLine::Cr) => "\r",
        };
        let final_newline = match properties
            .get_raw_for_key("insert_final_newline")
            .into_str()
            .to_ascii_lowercase()
            .as_str()
        {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        };
        Ok(Self { eol, final_newline })
    }

    /// Converts model text for a full-file write, including the file's EOF rule.
    pub fn normalize(&self, text: &str) -> String {
        self.finish_edit(self.normalize_fragment(text))
    }

    /// Restores the EOF convention without rewriting untouched line endings.
    pub fn finish_edit(&self, mut text: String) -> String {
        match self.final_newline {
            Some(true) if !text.is_empty() && !text.ends_with(['\r', '\n']) => {
                text.push_str(self.eol)
            }
            Some(false) => text.truncate(text.trim_end_matches(['\r', '\n']).len()),
            Some(true) | None => {}
        }
        text
    }

    /// Matches model text independently of newline spelling, returning byte
    /// ranges in the original file so replacements leave untouched bytes intact.
    pub fn matching_ranges(text: &str, needle: &str) -> Vec<Range<usize>> {
        let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
        let needle = needle.replace("\r\n", "\n").replace('\r', "\n");
        let mut removed_cr = Vec::new();
        for (index, _) in text.match_indices("\r\n") {
            removed_cr.push(index + 1 - removed_cr.len());
        }
        let original_offset =
            |offset| offset + removed_cr.partition_point(|boundary| *boundary <= offset);
        normalized
            .match_indices(&needle)
            .map(|(start, matched)| original_offset(start)..original_offset(start + matched.len()))
            .collect()
    }

    /// Converts replacement text without changing whether that fragment ends a line.
    pub fn normalize_fragment(&self, text: &str) -> String {
        text.replace("\r\n", "\n")
            .replace('\r', "\n")
            .replace('\n', self.eol)
    }
}
