use std::ffi::OsString;

use super::second_instance_urls;
use crate::app::ProtocolScheme;
use crate::app::SecondInstance;

#[test]
fn accepted_protocol_arguments_from_second_instances_preserve_argument_order() {
    let accepted = [ProtocolScheme::new("zui").unwrap()];
    let event = SecondInstance::new(
        [
            OsString::from("zui-bin"),
            OsString::from("https://example.com/ignored"),
            OsString::from("zui://open/first"),
            OsString::from("not-a-url"),
            OsString::from("zui://open/second"),
        ],
        "/tmp",
    );

    let urls = second_instance_urls(&accepted, &event);

    assert_eq!(
        urls.iter().map(|url| url.as_str()).collect::<Vec<_>>(),
        ["zui://open/first", "zui://open/second"]
    );
}
