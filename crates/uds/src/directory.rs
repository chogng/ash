use crate::IpcListener;
use crate::IpcStream;
use std::fs::File;
use std::io;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

#[cfg(unix)]
use crate::unix as platform;
#[cfg(windows)]
use crate::windows as platform;

/// A current-user-only socket directory validated through an open directory handle.
/// Keep it alive while operating on its endpoint. Windows pins the directory against deletion
/// and replacement. Unix permission checks assume the owning user controls the parent directory.
#[derive(Clone, Debug)]
pub struct SocketDirectory {
    path: PathBuf,
    _handle: Arc<File>,
}

impl SocketDirectory {
    /// Creates a new private directory; an existing path is an error. The parent must exist.
    pub fn create(path: &Path) -> io::Result<Self> {
        platform::create_private_directory(path)?;
        Self::open(path)
    }

    /// Creates a private directory if absent, or verifies an existing one without changing it.
    pub fn prepare(path: &Path) -> io::Result<Self> {
        match Self::create(path) {
            Ok(directory) => Ok(directory),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Self::open(path),
            Err(error) => Err(error),
        }
    }

    /// Validates an existing directory without creating it or changing its permissions.
    pub fn open(path: &Path) -> io::Result<Self> {
        let (path, handle) = platform::open_private_directory(path)?;
        Ok(Self {
            path,
            _handle: Arc::new(handle),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Resolves an endpoint identity. Windows hashes this identity into a fixed-length pipe name;
    /// no socket file is created in this directory.
    pub fn socket_path(&self, name: &Path) -> io::Result<PathBuf> {
        validate_name(name)?;
        let path = self.path.join(name);
        Ok(path)
    }

    /// Binds one new socket. The caller must retain this directory until the listener closes.
    pub fn bind(&self, name: &Path) -> io::Result<IpcListener> {
        let path = self.socket_path(name)?;
        let listener = IpcListener::bind(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
        }
        Ok(listener)
    }

    /// Connects to the local endpoint. Unix rejects symlinks and ordinary files.
    /// The caller must inspect the peer identity before exchanging application data.
    pub fn connect(&self, name: &Path) -> io::Result<IpcStream> {
        let path = self.socket_path(name)?;
        #[cfg(unix)]
        validate_socket(&path)?;
        IpcStream::connect(path)
    }

    /// Removes a Unix socket path after its owner has established that no live listener uses it.
    #[cfg(unix)]
    pub fn remove_socket(&self, name: &Path) -> io::Result<()> {
        let path = self.socket_path(name)?;
        match validate_socket(&path) {
            Ok(()) => std::fs::remove_file(path),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
        }
    }
}

fn validate_name(name: &Path) -> io::Result<()> {
    let mut components = name.components();
    let bytes = name.as_os_str().as_encoded_bytes();
    if !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || bytes.contains(&0)
        || (cfg!(windows) && bytes.contains(&b':'))
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "socket name must be one path component",
        ));
    }
    Ok(())
}

#[cfg(unix)]
fn validate_socket(path: &Path) -> io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    #[cfg(unix)]
    let socket = {
        use std::os::unix::fs::FileTypeExt;
        metadata.file_type().is_socket()
    };
    if socket {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "endpoint is not a socket path",
        ))
    }
}
