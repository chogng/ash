//! Host-local log persistence independent of business connections and Node runtimes.

pub mod contract;

use contract::*;
use std::collections::BTreeSet;
#[cfg(unix)]
use std::collections::VecDeque;
use std::fs;
#[cfg(unix)]
use std::fs::File;
use std::fs::Metadata;
use std::fs::OpenOptions;
use std::io;
use std::io::BufRead;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::time::UNIX_EPOCH;

const MAX_FRAME_BYTES: u64 = 8 * 1024 * 1024;
const MAX_READ_BYTES: u64 = 1024 * 1024;
#[cfg(unix)]
const MAX_OPEN_LOGS: usize = 32;

#[derive(Debug)]
enum Error {
    Invalid(String),
    Io(io::Error),
    NotOpen,
    WriteFailed(String),
}

impl From<io::Error> for Error {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl Error {
    fn response(self) -> HostLogResponse {
        let (reason, message) = match self {
            Self::Invalid(message) => (HostLogFailure::InvalidRequest, message),
            Self::Io(error) => (HostLogFailure::Io, error.to_string()),
            Self::NotOpen => (HostLogFailure::NotOpen, "Desktop logger is not open".into()),
            Self::WriteFailed(message) => (HostLogFailure::Io, message),
        };
        HostLogResponse::Failure { reason, message }
    }
}

struct Store {
    root: PathBuf,
    session: PathBuf,
    max_file_bytes: u64,
    retained_sessions: usize,
    process_id: u32,
    sources: BTreeSet<String>,
    #[cfg(unix)]
    appenders: VecDeque<LogAppender>,
    app_server_log: Option<PathBuf>,
    write_failure: Option<String>,
    closed: bool,
}

#[cfg(unix)]
struct LogAppender {
    source: String,
    file: File,
    metadata: Metadata,
}

impl Store {
    fn open(
        root: &str,
        max_file_bytes: u32,
        retained_sessions: u32,
        process_id: u32,
    ) -> Result<Self, Error> {
        if !Path::new(root).is_absolute()
            || !(1..=64 * 1024 * 1024).contains(&max_file_bytes)
            || !(1..=1000).contains(&retained_sessions)
            || process_id == 0
        {
            return Err(Error::Invalid(
                "Invalid log retention limits or host identity".into(),
            ));
        }
        fs::create_dir_all(root)?;
        let root = fs::canonicalize(root)?;
        let random = format!("{:032x}", rand::random::<u128>());
        let session = root.join(format!(
            "{}-{}-{}-{}-{}-{}",
            chrono::Utc::now().format("%Y%m%dT%H%M%S%3f"),
            &random[..8],
            &random[8..12],
            &random[12..16],
            &random[16..20],
            &random[20..]
        ));
        fs::create_dir(&session)?;
        fs::write(session.join(format!(".active-{}", std::process::id())), b"")?;
        Ok(Self {
            root,
            session,
            max_file_bytes: max_file_bytes.into(),
            retained_sessions: retained_sessions as usize,
            process_id,
            sources: BTreeSet::new(),
            #[cfg(unix)]
            appenders: VecDeque::new(),
            app_server_log: None,
            write_failure: None,
            closed: false,
        })
    }

    fn append(&mut self, source: &str, entry: HostLogEntry) -> Result<(), Error> {
        if entry.category.trim().is_empty()
            || entry.category.len() > 256
            || entry.message.trim().is_empty()
            || entry.message.len() > 1024 * 1024
            || entry
                .error
                .as_ref()
                .is_some_and(|error| error.len() > 1024 * 1024)
        {
            return Err(Error::Invalid("Invalid log entry".into()));
        }
        let mut record = serde_json::to_value(entry).expect("log entry is serializable");
        record["source"] = source.into();
        record["processId"] = self.process_id.into();
        let mut line = serde_json::to_vec(&record).expect("log record is serializable");
        line.push(b'\n');
        if line.len() as u64 > self.max_file_bytes {
            return Err(Error::Invalid("Log entry exceeds file limit".into()));
        }
        let result = self.append_bytes(source, &line);
        if let Err(Error::Io(error)) = &result {
            self.write_failure.get_or_insert_with(|| error.to_string());
        }
        result
    }

    fn append_bytes(&mut self, source: &str, bytes: &[u8]) -> Result<(), Error> {
        if self.closed {
            return Err(Error::NotOpen);
        }
        if !valid_source(source) {
            return Err(Error::Invalid("Invalid log source".into()));
        }
        let path = self.session.join(format!("{source}.log"));
        #[cfg(unix)]
        let cached = self
            .appenders
            .iter()
            .position(|appender| appender.source == source)
            .and_then(|index| self.appenders.remove(index));
        // The owned handle can stay open, while the pathname check keeps external rotation,
        // truncation, deletion and redirection visible to the next append.
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() => Some(metadata),
            Ok(_) => return Err(Error::Invalid("Log source must be a regular file".into())),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let size = metadata.as_ref().map_or(0, Metadata::len);
        if size > 0 && size + bytes.len() as u64 > self.max_file_bytes {
            #[cfg(unix)]
            drop(cached);
            remove_if_exists(&path.with_extension("log.2"))?;
            match fs::rename(path.with_extension("log.1"), path.with_extension("log.2")) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            fs::rename(&path, path.with_extension("log.1"))?;
        } else {
            #[cfg(unix)]
            if let Some(mut appender) = cached
                && metadata.as_ref().is_some_and(|metadata| {
                    use std::os::unix::fs::MetadataExt;
                    metadata.dev() == appender.metadata.dev()
                        && metadata.ino() == appender.metadata.ino()
                })
            {
                appender.file.write_all(bytes)?;
                self.appenders.push_back(appender);
                return Ok(());
            }
        }
        let mut options = OpenOptions::new();
        options.create(true).append(true);
        no_follow(&mut options);
        let mut file = options.open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(Error::Invalid("Log source must be a regular file".into()));
        }
        file.write_all(bytes)?;
        #[cfg(unix)]
        {
            if self.appenders.len() == MAX_OPEN_LOGS {
                self.appenders.pop_front();
            }
            self.appenders.push_back(LogAppender {
                source: source.into(),
                file,
                metadata,
            });
        }
        self.sources.insert(source.into());
        Ok(())
    }

    fn list(
        &mut self,
        window_source: &str,
        app_server_log: Option<String>,
    ) -> Result<Vec<HostLogFile>, Error> {
        // An empty source is observable even when all startup records are filtered out.
        self.append_bytes(window_source, b"")?;
        self.app_server_log = match app_server_log {
            Some(path) if Path::new(&path).is_absolute() => Some(PathBuf::from(path)),
            Some(_) => return Err(Error::Invalid("Invalid App Server log path".into())),
            None => None,
        };
        let mut sessions = self.sessions()?;
        sessions.sort_by(|left, right| right.cmp(left));
        let mut files = Vec::new();
        for session in sessions {
            for entry in fs::read_dir(self.root.join(&session))? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if !entry.file_type()?.is_file() {
                    continue;
                }
                let Some(source) = file_source(&name) else {
                    continue;
                };
                let live = self
                    .session
                    .file_name()
                    .is_some_and(|current| current == session.as_str())
                    && name.ends_with(".log");
                files.push(HostLogFile {
                    id: format!("{session}/{name}"),
                    current_window: live && source == window_source,
                    source: source.into(),
                    format: HostLogFormat::Jsonl,
                    live,
                });
            }
        }
        if self.app_server_log.is_some() {
            files.insert(
                0,
                HostLogFile {
                    id: "app-server".into(),
                    source: "app-server".into(),
                    format: HostLogFormat::Text,
                    live: true,
                    current_window: false,
                },
            );
        }
        Ok(files)
    }

    fn read(&self, id: &str, cursor: Option<HostLogCursor>) -> Result<HostLogReadResult, Error> {
        if cursor.as_ref().is_some_and(|cursor| {
            cursor.generation.len() > 128 || cursor.offset > 9_007_199_254_740_991
        }) {
            return Err(Error::Invalid("Invalid log cursor".into()));
        }
        let path = if id == "app-server" {
            self.app_server_log
                .clone()
                .ok_or_else(|| Error::Invalid("Unknown App Server log source".into()))?
        } else {
            let parts: Vec<_> = id.split('/').collect();
            if parts.len() != 2 || !valid_session(parts[0]) || file_source(parts[1]).is_none() {
                return Err(Error::Invalid("Invalid log file identity".into()));
            }
            let directory = self.root.join(parts[0]);
            if fs::canonicalize(&directory)? != directory {
                return Err(Error::Invalid("Invalid log session directory".into()));
            }
            directory.join(parts[1])
        };
        if !fs::symlink_metadata(&path)?.is_file() {
            return Err(Error::Invalid("Log source must be a regular file".into()));
        }
        let mut options = OpenOptions::new();
        options.read(true);
        no_follow(&mut options);
        let mut file = options.open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(Error::Invalid("Log source must be a regular file".into()));
        }
        let generation = file_generation(&metadata);
        let same_file = cursor.as_ref().is_some_and(|cursor| {
            cursor.generation == generation && cursor.offset <= metadata.len()
        });
        let requested = if same_file {
            cursor.as_ref().expect("same-file cursor").offset
        } else {
            0
        };
        let start = requested.max(metadata.len().saturating_sub(MAX_READ_BYTES));
        file.seek(SeekFrom::Start(start))?;
        let mut bytes = Vec::new();
        file.take(MAX_READ_BYTES).read_to_end(&mut bytes)?;
        let end = bytes
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map_or(0, |position| position + 1);
        let first = if start > requested {
            bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(bytes.len(), |position| position + 1)
        } else {
            0
        };
        Ok(HostLogReadResult {
            text: if end > first {
                String::from_utf8_lossy(&bytes[first..end]).into_owned()
            } else {
                String::new()
            },
            cursor: HostLogCursor {
                generation,
                offset: start + end as u64,
            },
            gap: start > requested || cursor.is_some() && !same_file,
        })
    }

    fn sessions(&self) -> Result<Vec<String>, Error> {
        let mut sessions = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type()?.is_dir() && valid_session(&name) {
                sessions.push(name);
            }
        }
        Ok(sessions)
    }

    fn clean_up(&self) -> Result<(), Error> {
        let mut sessions = self.sessions()?;
        sessions.sort_by(|left, right| right.cmp(left));
        let system = sysinfo::System::new_all();
        let mut retained = 0;
        for session in sessions {
            let path = self.root.join(session);
            if path == self.session {
                continue;
            }
            let active = fs::read_dir(&path)?.filter_map(Result::ok).any(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .and_then(|name| name.strip_prefix(".active-"))
                    .and_then(|pid| pid.parse::<u32>().ok())
                    .is_some_and(|pid| system.process(sysinfo::Pid::from_u32(pid)).is_some())
            });
            if active {
                continue;
            }
            retained += 1;
            if retained >= self.retained_sessions {
                fs::remove_dir_all(path)?;
            }
        }
        Ok(())
    }

    fn flush(&self) -> Result<(), Error> {
        if let Some(error) = &self.write_failure {
            return Err(Error::WriteFailed(error.clone()));
        }
        for source in &self.sources {
            let mut options = OpenOptions::new();
            options.write(true);
            no_follow(&mut options);
            options
                .open(self.session.join(format!("{source}.log")))?
                .sync_all()?;
        }
        Ok(())
    }

    fn close(&mut self) -> Result<(), Error> {
        let result = self.flush();
        self.closed = true;
        self.release_marker()?;
        result
    }

    fn release_marker(&self) -> io::Result<()> {
        remove_if_exists(&self.session.join(format!(".active-{}", std::process::id())))
    }
}

impl Drop for Store {
    fn drop(&mut self) {
        let _ = self.release_marker();
    }
}

fn valid_source(source: &str) -> bool {
    source == "main"
        || source.strip_prefix("window-").is_some_and(|id| {
            !id.starts_with('0')
                && !id.is_empty()
                && id.bytes().all(|byte| byte.is_ascii_digit())
                && id.len() <= 10
        })
}

fn file_source(name: &str) -> Option<&str> {
    let base = name
        .strip_suffix(".1")
        .or_else(|| name.strip_suffix(".2"))
        .unwrap_or(name);
    base.strip_suffix(".log")
        .filter(|source| valid_source(source))
}

fn valid_session(name: &str) -> bool {
    name.len() == 55
        && name.bytes().enumerate().all(|(index, byte)| match index {
            8 => byte == b'T',
            18 | 27 | 32 | 37 | 42 => byte == b'-',
            0..=17 => byte.is_ascii_digit(),
            _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
        })
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn no_follow(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(not(unix))]
    let _ = options;
}

fn file_generation(metadata: &fs::Metadata) -> String {
    let created = metadata
        .created()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |time| time.as_nanos());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}:{}:{created}", metadata.dev(), metadata.ino())
    }
    #[cfg(not(unix))]
    format!("{created}")
}

/// Runs one ordered private pipe. EOF releases the host session without starting any business server.
pub fn run_stdio() -> Result<(), String> {
    serve(io::stdin().lock(), io::stdout().lock()).map_err(|error| error.to_string())
}

fn serve(mut input: impl BufRead, mut output: impl Write) -> io::Result<()> {
    let mut store: Option<Store> = None;
    loop {
        let mut frame = Vec::new();
        let bytes = input
            .by_ref()
            .take(MAX_FRAME_BYTES + 1)
            .read_until(b'\n', &mut frame)?;
        if bytes == 0 {
            return Ok(());
        }
        if bytes as u64 > MAX_FRAME_BYTES || frame.last() != Some(&b'\n') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Invalid host log frame",
            ));
        }
        let request = serde_json::from_slice::<HostLogRequest>(&frame);
        let close = matches!(&request, Ok(HostLogRequest::Close));
        let result = request
            .map_err(|_| Error::Invalid("Invalid host log request".into()))
            .and_then(|request| {
                if let HostLogRequest::Initialize {
                    logs_home,
                    max_file_bytes,
                    retained_sessions,
                    process_id,
                } = request
                {
                    if store.is_some() {
                        return Err(Error::Invalid(
                            "Host log session is already initialized".into(),
                        ));
                    }
                    let opened =
                        Store::open(&logs_home, max_file_bytes, retained_sessions, process_id)?;
                    let session_path = opened.session.to_string_lossy().into_owned();
                    store = Some(opened);
                    return Ok(HostLogResponse::Initialized {
                        version: 1,
                        session_path,
                    });
                }
                let store = store.as_mut().ok_or(Error::NotOpen)?;
                match request {
                    HostLogRequest::Initialize { .. } => unreachable!("handled initialization"),
                    HostLogRequest::Append { source, entry } => {
                        store.append(&source, entry)?;
                        Ok(HostLogResponse::Ok)
                    }
                    HostLogRequest::List {
                        window_source,
                        app_server_log,
                    } => Ok(HostLogResponse::Listed {
                        files: store.list(&window_source, app_server_log)?,
                    }),
                    HostLogRequest::Read { id, cursor } => Ok(HostLogResponse::Read {
                        result: store.read(&id, cursor)?,
                    }),
                    HostLogRequest::CleanUp => {
                        store.clean_up()?;
                        Ok(HostLogResponse::Ok)
                    }
                    HostLogRequest::Flush => {
                        store.flush()?;
                        Ok(HostLogResponse::Ok)
                    }
                    HostLogRequest::Close => {
                        store.close()?;
                        Ok(HostLogResponse::Ok)
                    }
                }
            });
        serde_json::to_writer(&mut output, &result.unwrap_or_else(Error::response))?;
        output.write_all(b"\n")?;
        output.flush()?;
        if close {
            return Ok(());
        }
    }
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
