//! Diagnostic cursor helpers kept outside the product-facing session API.

use super::*;

/// A session-bound, versioned path cursor. The caller retains its directory registration.
pub(super) struct FileCursor {
    process: std::sync::Weak<process::Server>,
    root: PathBuf,
    view: Option<String>,
    next: Option<Value>,
    epoch: Option<u64>,
    deadline: Instant,
    complete: bool,
    pub(super) buffered: std::vec::IntoIter<PathBuf>,
}

impl Session {
    /// Collects metadata-only file names independently of content admission and readiness.
    /// Streaming consumers use `file_cursor` and keep only their bounded result set.
    pub(super) fn files(&self, cancellation: &CancellationToken) -> Result<Vec<PathBuf>, Error> {
        let mut cursor = self.file_cursor(cancellation)?;
        let mut files = Vec::new();
        while let Some(path) = self.next_file(&mut cursor, cancellation)? {
            files.push(path);
        }
        Ok(files)
    }

    /// Starts one versioned cursor; retain this session's directory authorization until it is dropped.
    pub(super) fn file_cursor(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<FileCursor, Error> {
        let deadline = Instant::now() + TIMEOUT;
        check(cancellation, deadline)?;
        self.synchronize_files(cancellation, deadline)?;
        let view = match &self.registration {
            Registration::Shared { view, .. } => Some(view.clone()),
            Registration::Directory => None,
            Registration::Released => return Err(failed("search registration was released")),
        };
        Ok(FileCursor {
            process: std::sync::Arc::downgrade(&self.process),
            root: self.root.clone(),
            view,
            next: None,
            epoch: None,
            deadline,
            complete: false,
            buffered: Vec::new().into_iter(),
        })
    }

    /// Consumes bounded pages from the same file snapshot; changes between pages fail explicitly.
    pub(super) fn next_file(
        &self,
        cursor: &mut FileCursor,
        cancellation: &CancellationToken,
    ) -> Result<Option<PathBuf>, Error> {
        check(cancellation, cursor.deadline)?;
        let view = match &self.registration {
            Registration::Shared { view, .. } => Some(view.as_str()),
            Registration::Directory => None,
            Registration::Released => return Err(failed("search registration was released")),
        };
        if !cursor
            .process
            .ptr_eq(&std::sync::Arc::downgrade(&self.process))
            || cursor.root != self.root
            || cursor.view.as_deref() != view
        {
            return Err(failed("file cursor belongs to another registration"));
        }
        if let Some(path) = cursor.buffered.next() {
            return Ok(Some(path));
        }
        if cursor.complete {
            return Ok(None);
        }
        let result = loop {
            match self.rpc(
                "files/page",
                json!({"page_size":1024,"cursor":cursor.next}),
                cancellation,
                cursor.deadline,
            ) {
                Ok(value) => break value,
                Err(Error::NotReady(_)) if cursor.epoch.is_none() => {
                    check(cancellation, cursor.deadline)?;
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(error) => return Err(error),
            }
        };
        if result["files_ready"] != true {
            return Err(failed("file snapshot is not ready"));
        }
        let epoch = result["epoch"]
            .as_u64()
            .ok_or_else(|| failed("invalid filename snapshot epoch"))?;
        if cursor.epoch.is_some_and(|previous| previous != epoch) {
            return Err(failed("file snapshot changed between pages"));
        }
        let paths: Vec<PathBuf> = serde_json::from_value(result["files"].clone())?;
        if paths.len() > 1024 {
            return Err(failed("file page exceeds its requested bound"));
        }
        for path in &paths {
            validate_relative(path)?;
            if path.as_os_str().is_empty() {
                return Err(failed("tgrep returned an empty file path"));
            }
        }
        let next = result
            .get("cursor")
            .ok_or_else(|| failed("missing file cursor"))?
            .clone();
        cursor.complete = next.is_null();
        if !cursor.complete {
            let previous = cursor
                .next
                .as_ref()
                .and_then(|value| value["offset"].as_u64())
                .unwrap_or(0);
            if paths.is_empty()
                || next["epoch"].as_u64() != Some(epoch)
                || !next["offset"]
                    .as_u64()
                    .is_some_and(|offset| offset > previous)
            {
                return Err(failed("file cursor did not advance"));
            }
            cursor.next = Some(next);
        }
        cursor.epoch = Some(epoch);
        cursor.buffered = paths.into_iter();
        Ok(cursor.buffered.next())
    }
}
