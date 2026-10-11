use super::Message;
use super::localized;

#[test]
fn update_package_failure_uses_the_clients_language_and_keeps_the_detail() {
    let detail = "package file digest does not match: bin/ash";
    assert_eq!(
        localized(Message::UpdatePackageFailed, "zh_CN.UTF-8").replace("{0}", detail),
        "无法准备更新包：package file digest does not match: bin/ash"
    );
    for language in ["en", "ja", "fr"] {
        assert!(localized(Message::UpdatePackageFailed, language).contains("{0}"));
    }
}
