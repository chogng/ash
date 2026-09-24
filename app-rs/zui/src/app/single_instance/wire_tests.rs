use std::ffi::OsString;
use std::path::PathBuf;

use super::MAX_MESSAGE_BYTES;
use super::decode;
use super::encode;
use crate::app::SecondInstance;

#[test]
fn invocation_round_trips_without_utf8_conversion() {
    let arguments = vec![OsString::from("sample-app"), OsString::from("--new-window")];
    #[cfg(unix)]
    let arguments = {
        use std::os::unix::ffi::OsStringExt;

        let mut arguments = arguments;
        arguments.push(OsString::from_vec(vec![b'n', b'o', b'n', 0xff]));
        arguments
    };
    let event = SecondInstance::new(arguments, PathBuf::from("/tmp/project"))
        .with_additional_data([0, 1, 2, 255]);

    assert_eq!(decode(&encode(&event).unwrap()).unwrap(), event);
}

#[test]
fn oversized_invocations_are_rejected() {
    let event = SecondInstance::new(["sample-app"], "/tmp")
        .with_additional_data(vec![0; MAX_MESSAGE_BYTES]);

    let error = encode(&event).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
}

#[test]
fn malformed_invocations_are_rejected() {
    let event = SecondInstance::new(["sample-app"], "/tmp");
    let mut encoded = encode(&event).unwrap();
    encoded.push(0);

    assert_eq!(
        decode(&encoded).unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
    assert_eq!(
        decode(b"not-zui").unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
}
