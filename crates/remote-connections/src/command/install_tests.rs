use std::num::NonZeroU64;

use crate::RemoteRuntimeInstallDisposition;
use crate::RemoteRuntimeInstallProgress;

use super::progress_json;

#[test]
fn progress_is_a_stable_json_lines_record() {
    assert_eq!(
        progress_json(RemoteRuntimeInstallProgress::Uploading {
            transferred_bytes: 32,
            total_bytes: NonZeroU64::new(64).unwrap(),
        }),
        r#"{"kind":"remoteRuntimeInstallProgress","phase":"uploading","transferredBytes":32,"totalBytes":64}"#
    );
    assert_eq!(
        progress_json(RemoteRuntimeInstallProgress::Complete {
            disposition: RemoteRuntimeInstallDisposition::Reused,
        }),
        r#"{"kind":"remoteRuntimeInstallProgress","phase":"complete","disposition":"reused"}"#
    );
}
