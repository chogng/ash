use std::io;
use std::io::Read;
use std::io::Write;
use std::num::NonZeroU64;

use super::RemoteRuntimeInstallDisposition;

/// A stable phase emitted while one immutable Remote runtime is being installed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteRuntimeInstallProgress {
    /// The local archive and its release-bound metadata are being validated before SSH starts.
    ValidatingArtifact,
    /// The host platform is being probed before any artifact bytes are uploaded.
    ProbingPlatform,
    /// The validated archive is being streamed through the local OpenSSH process.
    Uploading {
        /// Bytes accepted by the OpenSSH stdin stream.
        transferred_bytes: u64,
        /// Exact compressed size from trusted release metadata.
        total_bytes: NonZeroU64,
    },
    /// The Remote host is validating and atomically committing the uploaded package.
    FinalizingRemoteInstall,
    /// The immutable runtime is ready, either newly installed or reused by content identity.
    Complete {
        /// Whether this request installed new bytes or reused an existing ready object.
        disposition: RemoteRuntimeInstallDisposition,
    },
}

pub(super) fn upload_archive(
    archive: &mut impl Read,
    destination: &mut impl Write,
    total_bytes: NonZeroU64,
    report_progress: &mut impl FnMut(RemoteRuntimeInstallProgress),
) -> io::Result<u64> {
    let mut transferred_bytes = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    report_progress(RemoteRuntimeInstallProgress::Uploading {
        transferred_bytes,
        total_bytes,
    });
    loop {
        let read = archive.read(&mut buffer)?;
        if read == 0 {
            return Ok(transferred_bytes);
        }
        let mut written = 0;
        while written < read {
            let count = destination.write(&buffer[written..read])?;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "OpenSSH upload stdin accepted zero bytes",
                ));
            }
            written += count;
            transferred_bytes += count as u64;
            report_progress(RemoteRuntimeInstallProgress::Uploading {
                transferred_bytes,
                total_bytes,
            });
        }
    }
}
