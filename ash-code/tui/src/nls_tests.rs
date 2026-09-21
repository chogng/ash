use super::Language;
use super::Message;
use super::localize;
use super::text;

#[test]
fn product_chrome_keys_are_unique() {
    let mut keys = std::collections::BTreeSet::new();
    let mut duplicates = Vec::new();
    for translation in super::UI_TRANSLATIONS {
        if !keys.insert(translation.english) {
            duplicates.push(translation.english);
        }
    }
    assert!(duplicates.is_empty(), "duplicate NLS keys: {duplicates:?}");
}

#[test]
fn languages_cycle_in_both_directions() {
    let languages = [
        Language::English,
        Language::Japanese,
        Language::Chinese,
        Language::French,
    ];

    assert_eq!(
        languages.map(Language::next),
        [
            Language::Japanese,
            Language::Chinese,
            Language::French,
            Language::English,
        ]
    );
    assert_eq!(
        languages.map(Language::previous),
        [
            Language::French,
            Language::English,
            Language::Japanese,
            Language::Chinese,
        ]
    );
}

#[test]
fn product_chrome_is_localized_without_changing_source_content() {
    assert_eq!(localize(Language::Chinese, "Dashboard"), "仪表盘");
    assert_eq!(localize(Language::Japanese, "close"), "閉じる");
    assert_eq!(
        localize(Language::French, "Search help"),
        "Rechercher dans l’aide"
    );
    assert_eq!(localize(Language::Chinese, "All (12)"), "全部 (12)");
    assert_eq!(
        localize(Language::Chinese, "Reading: on · Model saving: off"),
        "读取: 开启 · 模型保存: 关闭"
    );
    assert_eq!(
        localize(
            Language::Chinese,
            "Discover Skills from this directory (3 found); requires Read files"
        ),
        "从此目录发现技能（3 个）；需要读取文件权限"
    );
    assert_eq!(
        localize(Language::Chinese, "Acme Cloud"),
        "Acme Cloud",
        "server-provided content remains unchanged"
    );
}

#[test]
fn nls_exposes_language_autonyms_and_typed_config_messages() {
    assert_eq!(Language::English.label(), "English");
    assert_eq!(Language::Japanese.label(), "日本語");
    assert_eq!(Language::Chinese.label(), "中文");
    assert_eq!(Language::French.label(), "Français");
    assert_eq!(
        text(Language::Chinese, Message::ConfigLanguageDescription),
        "切换界面语言"
    );
}
