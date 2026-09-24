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
fn shared_management_commands_have_translated_descriptions_and_argument_hints() {
    for command in ash_slash_commands::ProductSlashCommand::ALL {
        let definition = command.definition();
        for language in [Language::Chinese, Language::Japanese, Language::French] {
            assert_ne!(
                localize(language, &definition.description),
                definition.description
            );
            if let Some(hint) = &definition.argument_hint {
                assert_ne!(&*localize(language, hint), hint);
            }
        }
    }
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
fn templates_translate_labels_and_preserve_literal_arguments_across_languages() {
    let mut text = super::Text::template(
        "Permissions: {0}",
        vec![super::Text::literal("Skills · {0} /tools/program")],
    );
    text.localize(Language::Chinese);
    assert_eq!(&*text, "权限：Skills · {0} /tools/program");
    text.localize(Language::French);
    assert_eq!(&*text, "Autorisations : Skills · {0} /tools/program");
    text.localize(Language::English);
    assert_eq!(&*text, "Permissions: Skills · {0} /tools/program");
}

#[test]
fn product_chrome_is_localized_without_changing_source_content() {
    assert_eq!(
        localize(Language::Chinese, "65% left (35% used)"),
        "剩余 65%（已用 35%）"
    );
    assert_eq!(localize(Language::Chinese, "5h window"), "5h 额度");
    assert_eq!(localize(Language::Chinese, "Dashboard"), "仪表盘");
    assert_eq!(localize(Language::Japanese, "close"), "閉じる");
    assert_eq!(
        localize(Language::Chinese, "Browser opened"),
        "已打开浏览器"
    );
    assert_eq!(
        localize(Language::Chinese, "Could not open browser"),
        "无法打开浏览器"
    );
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
