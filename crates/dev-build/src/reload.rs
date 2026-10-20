use crate::ABI_VERSION;
use crate::MAX_MESSAGE_BYTES;
use crate::WriteResponse;
use libloading::Library;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::ffi::c_void;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

type Invoke = unsafe extern "C" fn(*const u8, usize, WriteResponse, *mut c_void) -> i32;
type InvokeUsize = unsafe extern "C" fn(usize, *mut usize) -> i32;

#[derive(Clone, Copy, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImageKind {
    #[default]
    Json,
    Usize,
    UsizeCode,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub version: u32,
    pub sha256: String,
    #[serde(default)]
    pub kind: ImageKind,
}

pub(crate) fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

pub(crate) fn image_path(directory: &Path, sha256: &str) -> PathBuf {
    directory
        .join("objects")
        .join(format!("{sha256}.{}", std::env::consts::DLL_EXTENSION))
}

pub(crate) struct Module {
    entry: Entry,
    // Function pointers cannot outlive the image. Arc<Module> spans every invocation.
    _storage: Storage,
}

enum Storage {
    Library { _library: Library },
    Code { _code: crate::machine::Code },
}

enum Entry {
    Json(Invoke),
    Usize(InvokeUsize),
}

impl Module {
    pub(crate) fn load(directory: &Path, manifest: &Manifest) -> Result<Self, String> {
        if manifest.version != ABI_VERSION
            || manifest.sha256.len() != 64
            || !manifest
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err("invalid development module manifest".into());
        }
        let path = image_path(directory, &manifest.sha256);
        let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
        if digest(&bytes) != manifest.sha256 {
            return Err("development module checksum mismatch".into());
        }
        if manifest.kind == ImageKind::UsizeCode {
            let code = crate::machine::Code::load(&bytes)?;
            let entry = Entry::Usize(code.usize_entry()?);
            return Ok(Self {
                entry,
                _storage: Storage::Code { _code: code },
            });
        }
        // SAFETY: the opt-in development directory contains native code authored by
        // the developer. Its content is checked before loading and never overwritten.
        let library = unsafe { Library::new(&path) }.map_err(|error| error.to_string())?;
        // SAFETY: these are versioned C exports, with no Rust layout or allocation ABI.
        let version =
            unsafe { library.get::<unsafe extern "C" fn() -> u32>(b"ash_dev_abi_version\0") }
                .map_err(|error| error.to_string())?;
        // SAFETY: the version query takes no input and returns a fixed-width integer.
        if unsafe { version() } != ABI_VERSION {
            return Err("development module ABI version mismatch".into());
        }
        // SAFETY: each manifest kind names a separate, versioned C signature.
        let entry = match manifest.kind {
            ImageKind::Json => Entry::Json(
                *unsafe { library.get::<Invoke>(b"ash_dev_invoke_v1\0") }
                    .map_err(|error| error.to_string())?,
            ),
            ImageKind::Usize => Entry::Usize(
                *unsafe { library.get::<InvokeUsize>(b"ash_dev_usize_v1\0") }
                    .map_err(|error| error.to_string())?,
            ),
            ImageKind::UsizeCode => unreachable!(),
        };
        Ok(Self {
            entry,
            _storage: Storage::Library { _library: library },
        })
    }

    fn call(&self, input: &[u8]) -> Result<Vec<u8>, String> {
        let Entry::Json(invoke) = self.entry else {
            return Err("development module does not accept JSON".into());
        };
        if input.len() > MAX_MESSAGE_BYTES {
            return Err("development module input exceeds its byte budget".into());
        }
        let mut response = Response {
            bytes: None,
            invalid: false,
        };
        // SAFETY: the input and response context stay live until the synchronous
        // entry returns. The module is retained by the caller's Arc throughout.
        let status = unsafe {
            invoke(
                input.as_ptr(),
                input.len(),
                receive,
                (&raw mut response).cast(),
            )
        };
        if status != 0 || response.invalid {
            return Err(format!(
                "development module invocation failed (status {status})"
            ));
        }
        response
            .bytes
            .ok_or_else(|| "development module returned no response".into())
    }
}

/// A request retains one function generation, with no filesystem work per row.
/// Only scalar values cross the C ABI; the loaded image owns no host allocations.
pub struct UsizeFunction {
    module: Arc<Module>,
}

impl UsizeFunction {
    pub fn call(&self, input: usize) -> Result<usize, String> {
        let Entry::Usize(invoke) = self.module.entry else {
            return Err("development module does not accept usize".into());
        };
        let mut output = 0;
        // SAFETY: the output lives through the synchronous call and the Arc retains
        // the image. ABI v1 catches function panics before returning to this frame.
        let status = unsafe { invoke(input, &raw mut output) };
        if status == 0 {
            Ok(output)
        } else {
            Err(format!("development function failed (status {status})"))
        }
    }
}

struct Response {
    bytes: Option<Vec<u8>>,
    invalid: bool,
}

unsafe extern "C" fn receive(context: *mut c_void, bytes: *const u8, length: usize) {
    // SAFETY: call supplies its own Response and retains it through this callback.
    let response = unsafe { &mut *context.cast::<Response>() };
    if response.bytes.is_some() || length > MAX_MESSAGE_BYTES || (bytes.is_null() && length != 0) {
        response.invalid = true;
        return;
    }
    response.bytes = Some(if length == 0 {
        Vec::new()
    } else {
        // SAFETY: ABI v1 requires readable bytes until this callback returns.
        unsafe { std::slice::from_raw_parts(bytes, length) }.to_vec()
    });
}

#[derive(Default)]
struct State {
    manifest: Option<Vec<u8>>,
    module: Option<Arc<Module>>,
}

/// Selects immutable native modules while keeping the last loadable generation.
///
/// Directory contents are trusted development code. Requests share only the short
/// selection lock; the domain runs outside it, and old images unload after their
/// last concurrent call. Failed builds never replace `current.json`.
pub struct ReloadableModule {
    directory: PathBuf,
    kind: ImageKind,
    state: Mutex<State>,
}

impl ReloadableModule {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            kind: ImageKind::Json,
            state: Mutex::new(State::default()),
        }
    }

    pub fn new_usize(directory: PathBuf) -> Self {
        Self {
            directory,
            kind: ImageKind::Usize,
            state: Mutex::new(State::default()),
        }
    }

    pub fn call(&self, input: &[u8]) -> Result<Vec<u8>, String> {
        self.select()?.call(input)
    }

    pub fn usize_function(&self) -> Result<UsizeFunction, String> {
        let module = self.select()?;
        if !matches!(module.entry, Entry::Usize(_)) {
            return Err("development module has the wrong function signature".into());
        }
        Ok(UsizeFunction { module })
    }

    fn select(&self) -> Result<Arc<Module>, String> {
        {
            let mut state = self.state.lock().map_err(|error| error.to_string())?;
            let path = self.directory.join("current.json");
            let manifest = std::fs::File::open(path).and_then(|file| {
                let mut bytes = Vec::new();
                file.take(1025).read_to_end(&mut bytes)?;
                if bytes.len() > 1024 {
                    return Err(std::io::Error::other(
                        "development module manifest exceeds its byte budget",
                    ));
                }
                Ok(bytes)
            });
            if state.module.is_none()
                && let Err(error) = &manifest
            {
                return Err(error.to_string());
            }
            if let Ok(manifest) = manifest
                && state.manifest.as_ref() != Some(&manifest)
            {
                let candidate = serde_json::from_slice::<Manifest>(&manifest)
                    .map_err(|error| error.to_string())
                    .and_then(|manifest| {
                        if manifest.kind != self.kind
                            && !(self.kind == ImageKind::Usize
                                && manifest.kind == ImageKind::UsizeCode)
                        {
                            return Err("development module signature changed".into());
                        }
                        Module::load(&self.directory, &manifest)
                    });
                match candidate {
                    Ok(module) => state.module = Some(Arc::new(module)),
                    Err(error) => eprintln!("[ash-build] Rejected module: {error}"),
                }
                state.manifest = Some(manifest);
            }
            state
                .module
                .clone()
                .ok_or_else(|| "no loadable development module".to_string())
        }
    }
}
