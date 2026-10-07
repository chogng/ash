use crate::GeneratedImage;
use base64::Engine;
use protocol::SessionId;
use protocol::ThreadId;
use sha2::Digest;
use sha2::Sha256;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;

pub(crate) struct Artifacts {
    root: PathBuf,
}
impl Artifacts {
    pub(crate) fn open(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        Ok(Self { root })
    }
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }
    pub(crate) fn save(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        image: &GeneratedImage,
        cancellation: &async_utils::CancellationToken,
    ) -> Result<PathBuf, String> {
        cancellation.check().map_err(|e| e.reason().to_string())?;
        let bytes = decode(image)?;
        let suffix = match image.mime_type.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/webp" => "webp",
            _ => return Err("unsupported image format".into()),
        };
        let path = self.root.join(format!(
            "{}-{:x}.{suffix}",
            scope(session, thread),
            Sha256::digest(&bytes)
        ));
        let mut temporary =
            tempfile::NamedTempFile::new_in(&self.root).map_err(|e| e.to_string())?;
        temporary
            .write_all(&bytes)
            .and_then(|_| temporary.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        cancellation.check().map_err(|e| e.reason().to_string())?;
        match temporary.persist_noclobber(&path) {
            Ok(_) => {}
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                if fs::symlink_metadata(&path)
                    .map_err(|e| e.to_string())?
                    .file_type()
                    .is_symlink()
                    || fs::read(&path).map_err(|e| e.to_string())? != bytes
                {
                    return Err("image artifact content conflict".into());
                }
            }
            Err(error) => return Err(error.error.to_string()),
        }
        Ok(path)
    }
    pub(crate) fn read(
        &self,
        session: &SessionId,
        thread: &ThreadId,
        path: &str,
    ) -> Result<String, String> {
        let requested = Path::new(path);
        let path = if requested.is_absolute() {
            requested.to_path_buf()
        } else {
            self.root.join(requested)
        };
        if path.parent() != Some(self.root.as_path())
            || !path
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| name.starts_with(&format!("{}-", scope(session, thread))))
        {
            return Err("image reference is not an artifact of this Thread".into());
        }
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 5_000_000 {
            return Err("invalid image artifact reference".into());
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        let mime = match path.extension().and_then(|e| e.to_str()) {
            Some("png") => "image/png",
            Some("jpg") => "image/jpeg",
            Some("webp") => "image/webp",
            _ => return Err("unknown artifact format".into()),
        };
        Ok(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    }
}
fn scope(session: &SessionId, thread: &ThreadId) -> String {
    let mut hash = Sha256::new();
    hash.update(session.as_str());
    hash.update([0]);
    hash.update(thread.as_str());
    format!("{:x}", hash.finalize())
}
fn decode(image: &GeneratedImage) -> Result<Vec<u8>, String> {
    if image.base64.len() > 7_000_000 || image.revised_prompt.len() > 32_000 {
        return Err("generated image exceeds response limits".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&image.base64)
        .map_err(|_| "invalid image base64")?;
    let valid = match image.mime_type.as_str() {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        _ => false,
    };
    if !valid || bytes.len() > 5_000_000 {
        return Err("generated image format does not match its bytes".into());
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    reader
        .decode()
        .map_err(|_| "generated image cannot be decoded within its resource limits")?;
    Ok(bytes)
}
