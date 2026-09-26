//! TUI display languages and localized messages.

use serde::Deserialize;
use serde::Serialize;
use std::borrow::Cow;

/// Keeps a translatable template separate from verbatim names, paths and user content.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Text {
    source: String,
    arguments: Option<Vec<Text>>,
    value: String,
}

impl Text {
    pub(crate) fn literal(value: impl Into<String>) -> Self {
        let value = value.into();
        Self {
            source: value.clone(),
            arguments: None,
            value,
        }
    }

    pub(crate) fn template(source: &str, arguments: Vec<Text>) -> Self {
        let mut text = Self {
            source: source.into(),
            arguments: Some(arguments),
            value: String::new(),
        };
        text.localize(Language::English);
        text
    }

    pub(crate) fn localize(&mut self, language: Language) {
        let Some(arguments) = &mut self.arguments else {
            return;
        };
        for argument in arguments.iter_mut() {
            argument.localize(language);
        }
        let template = localize(language, &self.source);
        self.value.clear();
        let mut rest: &str = template.as_ref();
        while let Some(start) = rest.find('{') {
            self.value.push_str(&rest[..start]);
            rest = &rest[start..];
            if let Some(end) = rest.find('}')
                && let Ok(index) = rest[1..end].parse::<usize>()
                && let Some(argument) = arguments.get(index)
            {
                self.value.push_str(argument);
                rest = &rest[end + 1..];
            } else {
                self.value.push('{');
                rest = &rest[1..];
            }
        }
        self.value.push_str(rest);
    }
}

impl std::ops::Deref for Text {
    type Target = str;
    fn deref(&self) -> &str {
        &self.value
    }
}

impl<T: Into<String>> From<T> for Text {
    fn from(source: T) -> Self {
        let source = source.into();
        Self {
            value: source.clone(),
            source,
            arguments: Some(Vec::new()),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) enum Language {
    #[serde(rename = "en")]
    English,
    #[serde(rename = "ja")]
    Japanese,
    #[serde(rename = "zh-CN")]
    Chinese,
    #[serde(rename = "fr")]
    French,
}

impl Language {
    pub(crate) const fn label(self) -> &'static str {
        match self {
            Self::English => "English",
            Self::Japanese => "日本語",
            Self::Chinese => "中文",
            Self::French => "Français",
        }
    }

    pub(crate) const fn next(self) -> Self {
        match self {
            Self::English => Self::Japanese,
            Self::Japanese => Self::Chinese,
            Self::Chinese => Self::French,
            Self::French => Self::English,
        }
    }

    pub(crate) const fn previous(self) -> Self {
        match self {
            Self::English => Self::French,
            Self::Japanese => Self::English,
            Self::Chinese => Self::Japanese,
            Self::French => Self::Chinese,
        }
    }
}

pub(crate) const fn text(language: Language, message: Message) -> &'static str {
    match language {
        Language::English => english(message),
        Language::Japanese => japanese(message),
        Language::Chinese => chinese(message),
        Language::French => french(message),
    }
}

impl Default for Language {
    fn default() -> Self {
        Self::English
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Message {
    ConfigIssues,

    ConfigTitle,
    ConfigScreenMode,
    ConfigScreenModeDescription,
    ConfigGeneral,
    ConfigProviders,
    ConfigSubscriptions,
    ConfigApi,
    ConfigAdvisor,
    ConfigAdvisorEnabled,
    ConfigAdvisorEnabledDescription,
    ConfigAdvisorNoModel,
    ConfigAdvisorModel,
    ConfigAdvisorDescription,
    ConfigAdvisorOff,
    ConfigAdvisorOn,
    ConfigAdvisorClear,
    ConfigAdvisorModelUnavailable,
    ConfigVimMode,
    ConfigVimModeDescription,
    ConfigKeyHintStyle,
    ConfigKeyHintContrast,
    ConfigKeyHintMuted,
    ConfigKeyHintContrastDescription,
    ConfigKeyHintMutedDescription,
    ConfigGlyphSet,
    ConfigGlyphSetDescription,
    ConfigGlyphPowerline,
    ConfigGlyphPlain,
    ConfigMemoryDiagnostics,
    ConfigMemoryDiagnosticsDescription,
    ConfigAutoUpdate,
    ConfigAutoUpdateDescription,
    ConfigUpdateLatest,
    ConfigUpdateStable,
    ConfigUpdateNever,
    ConfigGitChangesAsDiff,
    ConfigGitChangesAsDiffDescription,
    ConfigGitAutoFetch,
    ConfigGitAutoFetchDescription,
    ConfigGitAutoFetchPeriod,
    ConfigGitAutoFetchPeriodDescription,
    ConfigGitFetchOff,
    ConfigGitFetchDefault,
    ConfigGitFetchAll,
    ConfigStatusLineStyle,
    ConfigStatusLineSimple,
    ConfigStatusLineExpressive,
    ConfigStatusLineSimpleDescription,
    ConfigStatusLineExpressiveDescription,
    ConfigLanguage,
    ConfigLanguageDescription,
    ConfigSearch,
    ConfigNoMatches,
}

const fn english(message: Message) -> &'static str {
    match message {
        Message::ConfigIssues => "Issues",

        Message::ConfigTitle => "Config",
        Message::ConfigScreenMode => "Screen mode",
        Message::ConfigScreenModeDescription => "Use a full screen or keep terminal history",
        Message::ConfigGeneral => "General",
        Message::ConfigProviders => "Providers",
        Message::ConfigSubscriptions => "Subscriptions",
        Message::ConfigApi => "API",
        Message::ConfigAdvisor => "Advisor",
        Message::ConfigAdvisorEnabled => "Enable Advisor",
        Message::ConfigAdvisorEnabledDescription => "Ask the selected model for second opinions",
        Message::ConfigAdvisorNoModel => "Choose a model",
        Message::ConfigAdvisorModel => "Advisor model",
        Message::ConfigAdvisorDescription => "Model used for second opinions",
        Message::ConfigAdvisorOff => "Off",
        Message::ConfigAdvisorOn => "On",
        Message::ConfigAdvisorClear => "Clear saved model",
        Message::ConfigAdvisorModelUnavailable => "Advisor model is unavailable",
        Message::ConfigVimMode => "Vim mode",
        Message::ConfigVimModeDescription => "Use Vim editing in ChatInput",
        Message::ConfigKeyHintStyle => "Key hint style",
        Message::ConfigKeyHintContrast => "Contrast",
        Message::ConfigKeyHintMuted => "Muted",
        Message::ConfigKeyHintContrastDescription => "Emphasize keys over their descriptions",
        Message::ConfigKeyHintMutedDescription => "Show the entire hint with equal emphasis",
        Message::ConfigGlyphSet => "Git branch marker",
        Message::ConfigGlyphSetDescription => "Choose a marker supported by your terminal font",
        Message::ConfigGlyphPowerline => "Powerline",
        Message::ConfigGlyphPlain => "Plain text",
        Message::ConfigMemoryDiagnostics => "Memory diagnostics",
        Message::ConfigMemoryDiagnosticsDescription => {
            "Continuously collect bounded memory evidence"
        }
        Message::ConfigAutoUpdate => "Automatic updates",
        Message::ConfigAutoUpdateDescription => "Choose release cadence",
        Message::ConfigUpdateLatest => "Latest",
        Message::ConfigUpdateStable => "Stable",
        Message::ConfigUpdateNever => "Never",
        Message::ConfigGitChangesAsDiff => "Show Git changes as diff",
        Message::ConfigGitChangesAsDiffDescription => {
            "Show added and deleted lines instead of changed files"
        }
        Message::ConfigGitAutoFetch => "Automatic Git fetch",
        Message::ConfigGitAutoFetchDescription => {
            "Fetch remote updates without changing local files"
        }
        Message::ConfigGitAutoFetchPeriod => "Git fetch interval",
        Message::ConfigGitAutoFetchPeriodDescription => "Seconds between automatic fetches",
        Message::ConfigGitFetchOff => "Off",
        Message::ConfigGitFetchDefault => "Default remote",
        Message::ConfigGitFetchAll => "All remotes",
        Message::ConfigStatusLineStyle => "Status bar style",
        Message::ConfigStatusLineSimple => "Simple",
        Message::ConfigStatusLineExpressive => "Expressive",
        Message::ConfigStatusLineSimpleDescription => "Text and numbers, clean and easy to read",
        Message::ConfigStatusLineExpressiveDescription => "Emoji and progress bars at a glance",
        Message::ConfigLanguage => "Language",
        Message::ConfigLanguageDescription => "Change the interface language",
        Message::ConfigSearch => "Search configuration",
        Message::ConfigNoMatches => "No matching configuration",
    }
}

const fn japanese(message: Message) -> &'static str {
    match message {
        Message::ConfigIssues => "Issues",

        Message::ConfigTitle => "設定",
        Message::ConfigScreenMode => "画面モード",
        Message::ConfigScreenModeDescription => "全画面表示またはターミナル履歴を保持",
        Message::ConfigGeneral => "一般",
        Message::ConfigProviders => "プロバイダー",
        Message::ConfigSubscriptions => "サブスクリプション",
        Message::ConfigApi => "API",
        Message::ConfigAdvisor => "アドバイザー",
        Message::ConfigAdvisorEnabled => "アドバイザーを有効にする",
        Message::ConfigAdvisorEnabledDescription => "選択したモデルにセカンドオピニオンを依頼する",
        Message::ConfigAdvisorNoModel => "モデルを選択",
        Message::ConfigAdvisorModel => "アドバイザーモデル",
        Message::ConfigAdvisorDescription => "セカンドオピニオンに使用するモデル",
        Message::ConfigAdvisorOff => "オフ",
        Message::ConfigAdvisorOn => "オン",
        Message::ConfigAdvisorClear => "保存したモデルを消去",
        Message::ConfigAdvisorModelUnavailable => "アドバイザーモデルは使用できません",
        Message::ConfigVimMode => "Vim モード",
        Message::ConfigVimModeDescription => "ChatInput で Vim 編集を使用する",
        Message::ConfigKeyHintStyle => "キーヒントの表示",
        Message::ConfigKeyHintContrast => "強調",
        Message::ConfigKeyHintMuted => "控えめ",
        Message::ConfigKeyHintContrastDescription => "説明よりキーを強調する",
        Message::ConfigKeyHintMutedDescription => "ヒント全体を同じ強さで表示する",
        Message::ConfigGlyphSet => "Git ブランチの記号",
        Message::ConfigGlyphSetDescription => "端末のフォントで表示できる記号を選ぶ",
        Message::ConfigGlyphPowerline => "Powerline",
        Message::ConfigGlyphPlain => "テキスト",
        Message::ConfigMemoryDiagnostics => "メモリ診断",
        Message::ConfigMemoryDiagnosticsDescription => {
            "上限付きのメモリ診断データを継続的に収集する"
        }
        Message::ConfigAutoUpdate => "自動更新",
        Message::ConfigAutoUpdateDescription => "リリース頻度を選択する",
        Message::ConfigUpdateLatest => "最新",
        Message::ConfigUpdateStable => "安定版",
        Message::ConfigUpdateNever => "なし",
        Message::ConfigGitChangesAsDiff => "Git の変更を差分で表示",
        Message::ConfigGitChangesAsDiffDescription => {
            "変更されたファイルではなく、追加・削除された行を表示する"
        }
        Message::ConfigGitAutoFetch => "Git の自動取得",
        Message::ConfigGitAutoFetchDescription => {
            "ローカルファイルを変更せずにリモートの更新を取得する"
        }
        Message::ConfigGitAutoFetchPeriod => "Git 取得間隔",
        Message::ConfigGitAutoFetchPeriodDescription => "自動取得の間隔（秒）",
        Message::ConfigGitFetchOff => "オフ",
        Message::ConfigGitFetchDefault => "既定のリモート",
        Message::ConfigGitFetchAll => "すべてのリモート",
        Message::ConfigStatusLineStyle => "ステータスバーの表示",
        Message::ConfigStatusLineSimple => "シンプル",
        Message::ConfigStatusLineExpressive => "華やか",
        Message::ConfigStatusLineSimpleDescription => "文字と数値ですっきり表示",
        Message::ConfigStatusLineExpressiveDescription => "絵文字と進捗バーでひと目で確認",
        Message::ConfigLanguage => "言語",
        Message::ConfigLanguageDescription => "インターフェースの言語を変更する",
        Message::ConfigSearch => "設定を検索",
        Message::ConfigNoMatches => "一致する設定がありません",
    }
}

const fn chinese(message: Message) -> &'static str {
    match message {
        Message::ConfigIssues => "议题",

        Message::ConfigTitle => "配置",
        Message::ConfigScreenMode => "屏幕模式",
        Message::ConfigScreenModeDescription => "使用全屏界面或保留终端历史",
        Message::ConfigGeneral => "通用",
        Message::ConfigProviders => "提供商",
        Message::ConfigSubscriptions => "订阅",
        Message::ConfigApi => "API",
        Message::ConfigAdvisor => "顾问",
        Message::ConfigAdvisorEnabled => "启用顾问",
        Message::ConfigAdvisorEnabledDescription => "让所选模型提供第二意见",
        Message::ConfigAdvisorNoModel => "选择模型",
        Message::ConfigAdvisorModel => "顾问模型",
        Message::ConfigAdvisorDescription => "用于提供第二意见的模型",
        Message::ConfigAdvisorOff => "关闭",
        Message::ConfigAdvisorOn => "开启",
        Message::ConfigAdvisorClear => "清除已保存的模型",
        Message::ConfigAdvisorModelUnavailable => "顾问模型不可用",
        Message::ConfigVimMode => "Vim 模式",
        Message::ConfigVimModeDescription => "在 ChatInput 中使用 Vim 编辑",
        Message::ConfigKeyHintStyle => "按键提示风格",
        Message::ConfigKeyHintContrast => "对比",
        Message::ConfigKeyHintMuted => "弱化",
        Message::ConfigKeyHintContrastDescription => "突出按键，弱化说明",
        Message::ConfigKeyHintMutedDescription => "按相同强度显示整条提示",
        Message::ConfigGlyphSet => "Git 分支标识",
        Message::ConfigGlyphSetDescription => "选择终端字体支持的分支标识",
        Message::ConfigGlyphPowerline => "Powerline",
        Message::ConfigGlyphPlain => "纯文本",
        Message::ConfigMemoryDiagnostics => "内存诊断",
        Message::ConfigMemoryDiagnosticsDescription => "持续收集有界的内存诊断数据",
        Message::ConfigAutoUpdate => "自动更新",
        Message::ConfigAutoUpdateDescription => "选择版本更新节奏",
        Message::ConfigUpdateLatest => "最新",
        Message::ConfigUpdateStable => "稳定",
        Message::ConfigUpdateNever => "从不",
        Message::ConfigGitChangesAsDiff => "以差异显示 Git 更改",
        Message::ConfigGitChangesAsDiffDescription => "显示新增和删除的行，而不是已更改的文件",
        Message::ConfigGitAutoFetch => "自动获取 Git 更新",
        Message::ConfigGitAutoFetchDescription => "获取远端更新，不更改本地文件",
        Message::ConfigGitAutoFetchPeriod => "Git 获取间隔",
        Message::ConfigGitAutoFetchPeriodDescription => "两次自动获取之间的秒数",
        Message::ConfigGitFetchOff => "关闭",
        Message::ConfigGitFetchDefault => "默认远端",
        Message::ConfigGitFetchAll => "所有远端",
        Message::ConfigStatusLineStyle => "状态栏风格",
        Message::ConfigStatusLineSimple => "简洁",
        Message::ConfigStatusLineExpressive => "生动",
        Message::ConfigStatusLineSimpleDescription => "文字与数值，清爽易读",
        Message::ConfigStatusLineExpressiveDescription => "加入表情与进度条，一眼看清状态",
        Message::ConfigLanguage => "语言",
        Message::ConfigLanguageDescription => "切换界面语言",
        Message::ConfigSearch => "搜索配置",
        Message::ConfigNoMatches => "没有匹配的配置",
    }
}

const fn french(message: Message) -> &'static str {
    match message {
        Message::ConfigIssues => "Issues",

        Message::ConfigTitle => "Configuration",
        Message::ConfigScreenMode => "Mode d’écran",
        Message::ConfigScreenModeDescription => "Plein écran ou historique du terminal",
        Message::ConfigGeneral => "Général",
        Message::ConfigProviders => "Fournisseurs",
        Message::ConfigSubscriptions => "Abonnements",
        Message::ConfigApi => "API",
        Message::ConfigAdvisor => "Conseiller",
        Message::ConfigAdvisorEnabled => "Activer le conseiller",
        Message::ConfigAdvisorEnabledDescription => "Demander un second avis au modèle choisi",
        Message::ConfigAdvisorNoModel => "Choisir un modèle",
        Message::ConfigAdvisorModel => "Modèle conseiller",
        Message::ConfigAdvisorDescription => "Modèle utilisé pour un second avis",
        Message::ConfigAdvisorOff => "Désactivé",
        Message::ConfigAdvisorOn => "Activé",
        Message::ConfigAdvisorClear => "Effacer le modèle enregistré",
        Message::ConfigAdvisorModelUnavailable => "Modèle conseiller indisponible",
        Message::ConfigVimMode => "Mode Vim",
        Message::ConfigVimModeDescription => "Utiliser l’édition Vim dans ChatInput",
        Message::ConfigKeyHintStyle => "Style des raccourcis",
        Message::ConfigKeyHintContrast => "Contraste",
        Message::ConfigKeyHintMuted => "Atténué",
        Message::ConfigKeyHintContrastDescription => "Mettre les touches en valeur",
        Message::ConfigKeyHintMutedDescription => "Afficher toute l’aide avec la même intensité",
        Message::ConfigGlyphSet => "Repère de branche Git",
        Message::ConfigGlyphSetDescription => {
            "Choisir un repère pris en charge par la police du terminal"
        }
        Message::ConfigGlyphPowerline => "Powerline",
        Message::ConfigGlyphPlain => "Texte simple",
        Message::ConfigMemoryDiagnostics => "Diagnostic mémoire",
        Message::ConfigMemoryDiagnosticsDescription => {
            "Collecter en continu des données de diagnostic mémoire limitées"
        }
        Message::ConfigAutoUpdate => "Mises à jour automatiques",
        Message::ConfigAutoUpdateDescription => "Choisir le rythme des versions",
        Message::ConfigUpdateLatest => "Dernière",
        Message::ConfigUpdateStable => "Stable",
        Message::ConfigUpdateNever => "Jamais",
        Message::ConfigGitChangesAsDiff => "Afficher les modifications Git sous forme de diff",
        Message::ConfigGitChangesAsDiffDescription => {
            "Afficher les lignes ajoutées et supprimées au lieu des fichiers modifiés"
        }
        Message::ConfigGitAutoFetch => "Récupération Git automatique",
        Message::ConfigGitAutoFetchDescription => {
            "Récupérer les mises à jour sans modifier les fichiers locaux"
        }
        Message::ConfigGitAutoFetchPeriod => "Intervalle de récupération Git",
        Message::ConfigGitAutoFetchPeriodDescription => {
            "Secondes entre deux récupérations automatiques"
        }
        Message::ConfigGitFetchOff => "Désactivé",
        Message::ConfigGitFetchDefault => "Dépôt distant par défaut",
        Message::ConfigGitFetchAll => "Tous les dépôts distants",
        Message::ConfigStatusLineStyle => "Style de la barre d’état",
        Message::ConfigStatusLineSimple => "Simple",
        Message::ConfigStatusLineExpressive => "Expressif",
        Message::ConfigStatusLineSimpleDescription => "Du texte et des chiffres, faciles à lire",
        Message::ConfigStatusLineExpressiveDescription => "Des emoji et des barres de progression",
        Message::ConfigLanguage => "Langue",
        Message::ConfigLanguageDescription => "Changer la langue de l’interface",
        Message::ConfigSearch => "Rechercher dans la configuration",
        Message::ConfigNoMatches => "Aucune configuration correspondante",
    }
}

#[derive(Clone, Copy)]
struct Translation {
    english: &'static str,
    japanese: &'static str,
    chinese: &'static str,
    french: &'static str,
}

const fn translation(
    english: &'static str,
    japanese: &'static str,
    chinese: &'static str,
    french: &'static str,
) -> Translation {
    Translation {
        english,
        japanese,
        chinese,
        french,
    }
}

/// Product-owned TUI chrome. Server-provided names, user content, model output, paths, command
/// identifiers, and code are intentionally absent so they remain byte-for-byte source text.
const UI_TRANSLATIONS: &[Translation] = &[
    translation(
        "Ask the configured advisor for a second opinion",
        "設定済みのアドバイザーにセカンドオピニオンを聞く",
        "向已配置的顾问征求第二意见",
        "Demander un second avis au conseiller configuré",
    ),
    translation("continue", "続行", "继续", "continuer"),
    translation(
        "No matching commands",
        "一致するコマンドはありません",
        "没有匹配的命令",
        "Aucune commande correspondante",
    ),
    translation("Marketplace", "マーケットプレイス", "扩展市场", "Catalogue"),
    translation("Installed", "インストール済み", "已安装", "Installés"),
    translation("Not installed", "未インストール", "未安装", "Non installés"),
    translation("installed", "インストール済み", "已安装", "installé"),
    translation("install", "インストール", "安装", "installer"),
    translation("uninstall", "アンインストール", "卸载", "désinstaller"),
    translation(
        "Source: {0}\nDescription: {1}\nVersion: {2}",
        "提供元: {0}\n説明: {1}\nバージョン: {2}",
        "来源：{0}\n描述：{1}\n版本：{2}",
        "Source : {0}\nDescription : {1}\nVersion : {2}",
    ),
    translation("Available", "利用可能", "可用", "Disponibles"),
    translation("Configured", "設定済み", "已配置", "Configurés"),
    translation("Languages", "言語", "编程语言", "Langages"),
    translation(
        "Localizations",
        "言語パック",
        "语言包",
        "Packs linguistiques",
    ),
    translation("Executables", "実行プログラム", "可执行程序", "Exécutables"),
    translation("Assets", "リソース", "资源", "Ressources"),
    translation("enabled", "有効", "已启用", "activé"),
    translation("disabled", "無効", "已停用", "désactivé"),
    translation("built-in", "組み込み", "内置", "intégré"),
    translation("user", "ユーザー", "用户", "utilisateur"),
    translation("directory", "ディレクトリ", "目录", "répertoire"),
    translation("plugin", "プラグイン", "插件", "plugin"),
    translation("marketplace", "マーケットプレイス", "扩展市场", "catalogue"),
    translation(
        "Get skills",
        "スキルを入手",
        "获取技能",
        "Obtenir des compétences",
    ),
    translation(
        "Get MCP servers",
        "MCP サーバーを入手",
        "获取 MCP 服务器",
        "Obtenir des serveurs MCP",
    ),
    translation(
        "Get connectors",
        "コネクターを入手",
        "获取连接器",
        "Obtenir des connecteurs",
    ),
    translation("All ({0})", "すべて ({0})", "全部 ({0})", "Tous ({0})"),
    translation(
        "Enabled ({0})",
        "有効 ({0})",
        "已启用 ({0})",
        "Activés ({0})",
    ),
    translation(
        "Disabled ({0})",
        "無効 ({0})",
        "已停用 ({0})",
        "Désactivés ({0})",
    ),
    translation(
        "Refresh installed packages",
        "インストール済みパッケージを更新",
        "刷新已安装包",
        "Actualiser les paquets installés",
    ),
    translation(
        "Reads local installations; no catalog connection required",
        "ローカルのインストールを表示、カタログ接続は不要",
        "读取本地安装记录，无需连接目录",
        "Lit les installations locales, sans connexion au catalogue",
    ),
    translation(
        "waiting for consumers to release",
        "使用中の機能の終了を待機",
        "等待使用中的功能释放",
        "en attente de libération par les utilisateurs du paquet",
    ),
    translation(
        "Review package · {0}",
        "パッケージを確認 · {0}",
        "检查软件包 · {0}",
        "Vérifier le paquet · {0}",
    ),
    translation(
        "Return without changing installations",
        "インストールを変更せずに戻る",
        "返回，不更改安装",
        "Revenir sans modifier les installations",
    ),
    translation(
        "Version {0} · License {1}",
        "バージョン {0} · ライセンス {1}",
        "版本 {0} · 许可证 {1}",
        "Version {0} · Licence {1}",
    ),
    translation(
        "Source: official",
        "提供元: 公式",
        "来源：官方",
        "Source : officielle",
    ),
    translation(
        "Source: third party",
        "提供元: サードパーティー",
        "来源：第三方",
        "Source : tierce",
    ),
    translation(
        "  Permissions: none declared",
        "  権限: 宣言なし",
        "  权限：未声明",
        "  Autorisations : aucune déclarée",
    ),
    translation(
        "  Permission: {0}",
        "  権限: {0}",
        "  权限：{0}",
        "  Autorisation : {0}",
    ),
    translation(
        "  Authentication: {0}",
        "  認証: {0}",
        "  身份验证：{0}",
        "  Authentification : {0}",
    ),
    translation(
        "Confirm whole-package installation",
        "パッケージ全体のインストールを確認",
        "确认安装整个包",
        "Confirmer l’installation du paquet complet",
    ),
    translation(
        "All listed capabilities are installed together",
        "記載の機能はまとめてインストールされます",
        "列出的所有能力将一起安装",
        "Toutes les capacités listées sont installées ensemble",
    ),
    translation(
        "No packages in this view",
        "表示するパッケージはありません",
        "此页暂无软件包",
        "Aucun paquet dans cette vue",
    ),
    translation(
        "Search Marketplace; Enter to search",
        "マーケットプレイスを検索、Enter で実行",
        "搜索扩展市场，按 Enter 搜索",
        "Rechercher dans le catalogue, puis Entrée",
    ),
    translation(
        "Back to installed packages",
        "インストール済みパッケージに戻る",
        "返回已安装包",
        "Retour aux paquets installés",
    ),
    translation(
        "Permissions: {0}",
        "権限: {0}",
        "权限：{0}",
        "Autorisations : {0}",
    ),
    translation("none declared", "宣言なし", "未声明", "aucune déclarée"),
    translation(
        "Confirm whole-package removal",
        "パッケージ全体の削除を確認",
        "确认卸载整个包",
        "Confirmer la suppression du paquet complet",
    ),
    translation(
        "Removal waits until all consumers release this version",
        "使用中の機能がこのバージョンを解放してから削除",
        "使用中的功能释放此版本后才会卸载",
        "La suppression attend que cette version ne soit plus utilisée",
    ),
    translation(
        "Review latest version",
        "最新バージョンを確認",
        "检查最新版本",
        "Vérifier la dernière version",
    ),
    translation(
        "Review capabilities and permissions before updating",
        "更新前に機能と権限を確認",
        "更新前检查能力和权限",
        "Vérifier les capacités et autorisations avant la mise à jour",
    ),
    translation(
        "Uninstall this version…",
        "このバージョンを削除…",
        "卸载此版本…",
        "Désinstaller cette version…",
    ),
    translation(
        "Removes all capabilities in this installed package",
        "このパッケージの全機能を削除",
        "移除此安装包中的所有能力",
        "Supprime toutes les capacités de ce paquet installé",
    ),
    translation(
        "Pending removal · waiting for consumers to release",
        "削除待ち · 使用中の機能の終了を待機",
        "待卸载 · 等待使用中的功能释放",
        "Suppression en attente · en attente de libération",
    ),
    translation(
        "Confirm removal",
        "削除を確認",
        "确认卸载",
        "Confirmer la suppression",
    ),
    translation(
        "Installed package",
        "インストール済みパッケージ",
        "已安装包",
        "Paquet installé",
    ),
    translation(
        "Find language servers in Marketplace",
        "マーケットプレイスで言語サーバーを探す",
        "在扩展市场查找语言服务器",
        "Rechercher des serveurs de langage dans le catalogue",
    ),
    translation(
        "Match the exact language route in the package manifest",
        "パッケージが対応する正確な言語 ID で検索",
        "按包声明的精确语言 ID 匹配",
        "Rechercher l’identifiant exact du langage déclaré par le paquet",
    ),
    translation(
        "Configure a server by ID",
        "ID でサーバーを設定",
        "按 ID 配置服务器",
        "Configurer un serveur par identifiant",
    ),
    translation(
        "Set mode and optional program path",
        "有効状態と任意のプログラムパスを設定",
        "设置启用状态和可选程序路径",
        "Définir l’activation et le chemin facultatif du programme",
    ),
    translation(
        "Refresh servers",
        "サーバーを更新",
        "刷新服务器",
        "Actualiser les serveurs",
    ),
    translation(
        "Lists enabled, resolved servers without starting processes",
        "有効で実行可能なサーバーを表示、プロセスは起動しません",
        "列出已启用且程序可用的服务器，不启动进程",
        "Liste les serveurs activés et résolus sans démarrer de processus",
    ),
    translation(
        "Available · {0}",
        "利用可能 · {0}",
        "可用 · {0}",
        "Disponible · {0}",
    ),
    translation(
        "provider executable",
        "提供元の実行プログラム",
        "提供方程序",
        "exécutable du fournisseur",
    ),
    translation(
        "Current directory",
        "現在のディレクトリ",
        "当前目录",
        "Répertoire actuel",
    ),
    translation(
        "Inspect servers in this directory",
        "このディレクトリのサーバーを確認",
        "查看此目录的服务器",
        "Examiner les serveurs de ce répertoire",
    ),
    translation(
        "Filter server IDs",
        "サーバー ID を絞り込む",
        "筛选服务器 ID",
        "Filtrer les identifiants des serveurs",
    ),
    translation(
        "No language servers in this view",
        "表示する言語サーバーはありません",
        "此页暂无语言服务器",
        "Aucun serveur de langage dans cette vue",
    ),
    translation(
        "Directory: {0}",
        "ディレクトリ: {0}",
        "目录：{0}",
        "Répertoire : {0}",
    ),
    translation(
        "Find language servers",
        "言語サーバーを探す",
        "查找语言服务器",
        "Rechercher des serveurs de langage",
    ),
    translation(
        "Language ID, for example rust or typescript",
        "言語 ID（例: rust、typescript）",
        "语言 ID，例如 rust 或 typescript",
        "Identifiant du langage, par exemple rust ou typescript",
    ),
    translation(
        "Configure language server",
        "言語サーバーを設定",
        "配置语言服务器",
        "Configurer le serveur de langage",
    ),
    translation(
        "Server ID, for example rust-analyzer",
        "サーバー ID（例: rust-analyzer）",
        "服务器 ID，例如 rust-analyzer",
        "Identifiant du serveur, par exemple rust-analyzer",
    ),
    translation(
        "Language server program",
        "言語サーバーのプログラム",
        "语言服务器程序",
        "Programme du serveur de langage",
    ),
    translation(
        "Absolute executable path",
        "実行プログラムの絶対パス",
        "可执行文件的绝对路径",
        "Chemin absolu de l’exécutable",
    ),
    translation(
        "Back to language servers",
        "言語サーバーに戻る",
        "返回语言服务器",
        "Retour aux serveurs de langage",
    ),
    translation(
        "Disable server",
        "サーバーを無効にする",
        "停用服务器",
        "Désactiver le serveur",
    ),
    translation(
        "Enable server",
        "サーバーを有効にする",
        "启用服务器",
        "Activer le serveur",
    ),
    translation("Currently {0}", "現在 {0}", "当前{0}", "Actuellement {0}"),
    translation(
        "Set program path",
        "プログラムパスを設定",
        "设置程序路径",
        "Définir le chemin du programme",
    ),
    translation(
        "Using provider executable",
        "提供元の実行プログラムを使用",
        "使用提供方程序",
        "Utilise l’exécutable du fournisseur",
    ),
    translation(
        "Use provider executable",
        "提供元の実行プログラムを使う",
        "使用提供方程序",
        "Utiliser l’exécutable du fournisseur",
    ),
    translation(
        "Keep the current enabled/disabled setting",
        "現在の有効・無効設定を維持",
        "保留当前启用或停用状态",
        "Conserver le réglage d’activation actuel",
    ),
    translation(
        "Restore provider defaults",
        "提供元の既定値に戻す",
        "恢复提供方默认值",
        "Rétablir les valeurs du fournisseur",
    ),
    translation(
        "Remove this explicit configuration",
        "この明示的な設定を削除",
        "删除此显式配置",
        "Supprimer cette configuration explicite",
    ),
    translation(
        "Language server · {0}",
        "言語サーバー · {0}",
        "语言服务器 · {0}",
        "Serveur de langage · {0}",
    ),
    translation(
        "find and install Marketplace packages",
        "マーケットプレイスのパッケージを検索・インストール",
        "查找和安装扩展市场中的包",
        "rechercher et installer des paquets du catalogue",
    ),
    translation(
        "manage installed packages and exact versions",
        "インストール済みパッケージとバージョンを管理",
        "管理已安装包及其具体版本",
        "gérer les paquets installés et leurs versions exactes",
    ),
    translation(
        "browse and manage skills",
        "スキルを参照・管理",
        "浏览和管理技能",
        "parcourir et gérer les compétences",
    ),
    translation(
        "manage language servers and find packages",
        "言語サーバーを管理・パッケージを検索",
        "管理语言服务器并查找软件包",
        "gérer les serveurs de langage et rechercher des paquets",
    ),
    translation("<query>", "<検索語>", "<搜索词>", "<recherche>"),
    translation(
        "<language-id>",
        "<言語 ID>",
        "<语言 ID>",
        "<identifiant-langage>",
    ),
    translation(
        "This App Server does not support capability and language filters",
        "この App Server は機能・言語フィルターに対応していません",
        "此 App Server 不支持能力和语言筛选",
        "Cet App Server ne prend pas en charge les filtres de capacité et de langage",
    ),
    translation(
        "Allow model recall and saving; existing memories are kept when off",
        "モデルの記憶の読み書きを許可。オフでも既存の記憶は保持",
        "允许模型读取和保存记忆；关闭后保留已有内容",
        "Autoriser la lecture et l’enregistrement ; conserver les mémoires à l’arrêt",
    ),
    translation("Personal", "個人", "个人", "Personnel"),
    translation("Projects", "プロジェクト", "项目", "Projets"),
    translation(
        "Search this scope",
        "この範囲を検索",
        "搜索当前范围",
        "Rechercher dans ce périmètre",
    ),
    translation(
        "User maintained",
        "ユーザー管理",
        "用户维护",
        "Gérée par vous",
    ),
    translation(
        "Model maintained",
        "モデル管理",
        "模型维护",
        "Gérée par le modèle",
    ),
    translation(
        "+ New Memory",
        "+ 新しい記憶",
        "+ 新建记忆",
        "+ Nouvelle mémoire",
    ),
    translation(
        "No memories yet.",
        "記憶はまだありません。",
        "暂无记忆。",
        "Aucune mémoire pour le moment.",
    ),
    translation("Load more", "さらに読み込む", "加载更多", "Charger plus"),
    translation(
        "No authorized scope in this tab.",
        "このタブに許可された範囲はありません。",
        "此页签没有已授权的范围。",
        "Aucun périmètre autorisé dans cet onglet.",
    ),
    translation(
        "No matching memories. Change the search or clear it.",
        "検索を変更または消去してください。",
        "没有匹配的记忆，请修改或清空搜索。",
        "Aucune mémoire trouvée. Modifier ou effacer la recherche.",
    ),
    translation(
        "No memories in this scope. Press n to add one.",
        "この範囲に記憶はありません。n で追加。",
        "当前范围没有记忆，按 n 新增。",
        "Aucune mémoire ici. Appuyer sur n pour en ajouter.",
    ),
    translation(
        "Memories off · c Config",
        "記憶はオフ · c 設定",
        "记忆已关闭 · c 配置",
        "Mémoires désactivées · c Configuration",
    ),
    translation(
        "Saving makes this memory user maintained.",
        "保存後はユーザーが管理します。",
        "保存后由用户维护，模型不能再覆盖。",
        "Après enregistrement, cette mémoire sera gérée par vous.",
    ),
    translation(
        "Memory actions",
        "記憶の操作",
        "记忆操作",
        "Actions des mémoires",
    ),
    translation(
        "Choose scope",
        "範囲を選択",
        "选择范围",
        "Choisir un périmètre",
    ),
    translation(
        "Scope permissions",
        "範囲の権限",
        "范围授权",
        "Autorisations du périmètre",
    ),
    translation(
        "Refresh memories",
        "記憶を更新",
        "刷新记忆",
        "Actualiser les mémoires",
    ),
    translation(
        "Open Config",
        "設定を開く",
        "打开配置",
        "Ouvrir la configuration",
    ),
    translation(
        "Model reading",
        "モデルの読み取り",
        "模型读取",
        "Lecture par le modèle",
    ),
    translation(
        "Unsaved changes",
        "未保存の変更",
        "未保存的修改",
        "Modifications non enregistrées",
    ),
    translation(
        "Continue editing",
        "編集を続ける",
        "继续编辑",
        "Continuer à modifier",
    ),
    translation(
        "Discard changes",
        "変更を破棄",
        "放弃修改",
        "Abandonner les modifications",
    ),
    translation(
        "Delete this memory?",
        "この記憶を削除しますか？",
        "删除这条记忆？",
        "Supprimer cette mémoire ?",
    ),
    translation(
        "Latest memory version",
        "最新の記憶",
        "记忆的最新版本",
        "Dernière version de la mémoire",
    ),
    translation(
        "Title and content are required.",
        "タイトルと内容を入力してください。",
        "请填写标题和正文。",
        "Le titre et le contenu sont requis.",
    ),
    translation(
        "The title takes one line.",
        "タイトルは1行です。",
        "标题只能占一行。",
        "Le titre doit tenir sur une ligne.",
    ),
    translation(
        "Content is limited to 16384 UTF-8 bytes.",
        "内容は16384 UTF-8バイトまでです。",
        "正文最多 16384 个 UTF-8 字节。",
        "Le contenu est limité à 16384 octets UTF-8.",
    ),
    translation(
        "The title is limited to 256 characters.",
        "タイトルは256文字までです。",
        "标题最多 256 个字符。",
        "Le titre est limité à 256 caractères.",
    ),
    translation(
        "Tab fields · Ctrl+S save · Esc back",
        "Tab フィールド · Ctrl+S 保存 · Esc 戻る",
        "Tab 切换字段 · Ctrl+S 保存 · Esc 返回",
        "Tab champs · Ctrl+S enregistrer · Esc retour",
    ),
    translation(
        "This memory changed. View the latest version before saving your draft.",
        "記憶が変更されました。保存前に最新版を確認してください。",
        "这条记忆已被修改，请查看最新版本后再保存草稿。",
        "Cette mémoire a changé. Consultez la dernière version avant d’enregistrer.",
    ),
    translation(
        "This memory was deleted. Your draft is kept.",
        "記憶は削除されました。下書きは保持されています。",
        "这条记忆已被删除，草稿仍然保留。",
        "Cette mémoire a été supprimée. Votre brouillon est conservé.",
    ),
    translation(
        "Memories changed. Your draft is kept.",
        "記憶が変更されました。下書きは保持されています。",
        "记忆已有变化，草稿仍然保留。",
        "Les mémoires ont changé. Votre brouillon est conservé.",
    ),
    translation(
        "Search is limited to 512 characters.",
        "検索は512文字までです。",
        "搜索最多 512 个字符。",
        "La recherche est limitée à 512 caractères.",
    ),
    translation("above", "上", "上方", "au-dessus"),
    translation("below", "下", "下方", "en dessous"),
    translation("active", "有効", "活动", "actif"),
    translation("archived", "アーカイブ済み", "已归档", "archivé"),
    translation("cancelled", "キャンセル済み", "已取消", "annulé"),
    translation("collecting", "収集中", "正在收集", "collecte en cours"),
    translation("completed", "完了", "已完成", "terminé"),
    translation("connecting", "接続中", "正在连接", "connexion"),
    translation("failed", "失敗", "失败", "échec"),
    translation("idle", "待機中", "空闲", "inactif"),
    translation("loaded", "読み込み済み", "已加载", "chargés"),
    translation("needs input", "入力待ち", "需要输入", "saisie requise"),
    translation("not connected", "未接続", "未连接", "non connecté"),
    translation("queued", "待機中", "已排队", "en attente"),
    translation("read only", "読み取り専用", "只读", "lecture seule"),
    translation(
        "ready for review",
        "レビュー待ち",
        "等待审阅",
        "prêt à relire",
    ),
    translation("running", "実行中", "运行中", "en cours"),
    translation("satisfied", "完了", "已满足", "satisfait"),
    translation("stopped", "停止", "已停止", "arrêté"),
    translation("unavailable", "利用不可", "不可用", "indisponible"),
    translation("unknown", "不明", "未知", "inconnu"),
    translation("waiting", "待機中", "等待中", "en attente"),
    translation("working", "処理中", "工作中", "en cours"),
    translation(
        "waiting for next key",
        "次のキーを待っています",
        "正在等待下一个按键",
        "en attente de la touche suivante",
    ),
    translation(
        "Add an alternate chord",
        "代替コードを追加",
        "添加备用组合键",
        "Ajouter une séquence alternative",
    ),
    translation(
        "Add an alternate key",
        "代替キーを追加",
        "添加备用按键",
        "Ajouter une touche alternative",
    ),
    translation(
        "Add memory",
        "メモリを追加",
        "添加记忆",
        "Ajouter une mémoire",
    ),
    translation(
        "Add project folder",
        "プロジェクトフォルダーを追加",
        "添加项目文件夹",
        "Ajouter un dossier de projet",
    ),
    translation(
        "Added directory",
        "ディレクトリを追加しました",
        "已添加目录",
        "Dossier ajouté",
    ),
    translation(
        "Added project folder",
        "プロジェクトフォルダーを追加しました",
        "已添加项目文件夹",
        "Dossier de projet ajouté",
    ),
    translation(
        "Adding directory…",
        "ディレクトリを追加中…",
        "正在添加目录…",
        "Ajout du dossier…",
    ),
    translation("Agent", "エージェント", "智能体", "Agent"),
    translation("All", "すべて", "全部", "Tous"),
    translation(
        "Approval required",
        "承認が必要です",
        "需要批准",
        "Approbation requise",
    ),
    translation(
        "Approve once",
        "今回のみ承認",
        "仅批准一次",
        "Approuver une fois",
    ),
    translation("Archived", "アーカイブ", "已归档", "Archivées"),
    translation("Branches", "ブランチ", "分支", "Branches"),
    translation(
        "Project branches",
        "プロジェクトのブランチ",
        "项目分支",
        "Branches du projet",
    ),
    translation(
        "Project branches and worktrees",
        "プロジェクトのブランチとワークツリー",
        "项目分支与工作树",
        "Branches et arbres de travail du projet",
    ),
    translation(
        "Project worktrees",
        "プロジェクトのワークツリー",
        "项目工作树",
        "Arbres de travail du projet",
    ),
    translation(
        "Search worktrees",
        "ワークツリーを検索",
        "搜索工作树",
        "Rechercher des arbres de travail",
    ),
    translation(
        "No matching worktrees",
        "一致するワークツリーはありません",
        "没有匹配的工作树",
        "Aucun arbre de travail correspondant",
    ),
    translation(
        "Create at HEAD · no session",
        "HEAD から作成 · セッションなし",
        "基于 HEAD 创建 · 不启动会话",
        "Créer à HEAD · sans session",
    ),
    translation("Detached at", "デタッチ位置", "分离于", "Détaché à"),
    translation(
        "Enter to open",
        "Enter で開く",
        "按 Enter 打开",
        "Entrée pour ouvrir",
    ),
    translation(
        "Used by another session",
        "別のセッションで使用中",
        "由其他会话使用",
        "Utilisé par une autre session",
    ),
    translation(
        "Worktree is locked",
        "ワークツリーはロックされています",
        "工作树已锁定",
        "L'arbre de travail est verrouillé",
    ),
    translation(
        "Worktree is missing",
        "ワークツリーが見つかりません",
        "工作树不存在",
        "L'arbre de travail est introuvable",
    ),
    translation(
        "Worktree ownership is invalid",
        "ワークツリーの所有情報が無効です",
        "工作树归属信息无效",
        "La propriété de l'arbre de travail est invalide",
    ),
    translation(
        "Working directory is missing",
        "作業ディレクトリが見つかりません",
        "工作目录不存在",
        "Le répertoire de travail est introuvable",
    ),
    translation(
        "Worktree created. Enter to open it.",
        "ワークツリーを作成しました。Enter で開きます。",
        "工作树已创建。按 Enter 打开。",
        "Arbre de travail créé. Appuyez sur Entrée pour l'ouvrir.",
    ),
    translation(
        "Delete worktree",
        "ワークツリーを削除",
        "删除工作树",
        "Supprimer l'arbre de travail",
    ),
    translation(
        "Requires a clean linked worktree with no task.",
        "変更がなくタスクに紐付いていないリンク済みワークツリーだけを削除できます。",
        "只能删除没有改动且未绑定任务的关联工作树。",
        "Seuls les arbres de travail liés, propres et sans tâche peuvent être supprimés.",
    ),
    translation(
        "Cannot delete the current worktree.",
        "現在のワークツリーは削除できません。",
        "不能删除当前工作树。",
        "Impossible de supprimer l'arbre de travail actuel.",
    ),
    translation(
        "Worktree deleted.",
        "ワークツリーを削除しました。",
        "工作树已删除。",
        "Arbre de travail supprimé.",
    ),
    translation(
        "Could not delete worktree. It may have changes or be in use.",
        "ワークツリーを削除できませんでした。変更があるか使用中の可能性があります。",
        "无法删除工作树；它可能有未提交的改动或正在使用。",
        "Impossible de supprimer l'arbre de travail. Il peut contenir des modifications ou être utilisé.",
    ),
    translation(
        "Could not read project worktrees.",
        "プロジェクトのワークツリーを読み取れませんでした。",
        "无法读取项目工作树。",
        "Impossible de lire les arbres de travail du projet.",
    ),
    translation(
        "Could not open worktree. It may have changed or is in use.",
        "ワークツリーを開けません。変更されたか、使用中の可能性があります。",
        "无法打开工作树；它可能已变化或正在使用。",
        "Impossible d'ouvrir l'arbre de travail. Il a peut-être changé ou est utilisé.",
    ),
    translation(
        "The connected App Server does not support worktree management. Restart it to use the current version.",
        "接続中の App Server はワークツリー管理に対応していません。再起動してください。",
        "当前 App Server 不支持工作树管理。请重启以使用当前版本。",
        "L'App Server connecté ne prend pas en charge les arbres de travail. Redémarrez-le.",
    ),
    translation(
        "At HEAD · no checkout change",
        "HEAD から作成 · チェックアウトは変更しません",
        "基于 HEAD · 不切换工作树",
        "Depuis HEAD · sans changer d'arbre de travail",
    ),
    translation(
        "In another worktree",
        "別のワークツリーで使用中",
        "已在其他工作树中检出",
        "Dans un autre arbre de travail",
    ),
    translation(
        "Switch · worktree use unknown",
        "切り替え · ワークツリーの使用状況は不明",
        "切换 · 工作树占用情况未知",
        "Changer · utilisation des arbres de travail inconnue",
    ),
    translation(
        "Branch is checked out in another worktree",
        "ブランチは別のワークツリーでチェックアウトされています",
        "该分支已在其他工作树中检出",
        "La branche est extraite dans un autre arbre de travail",
    ),
    translation(
        "Delete branch",
        "ブランチを削除",
        "删除分支",
        "Supprimer la branche",
    ),
    translation(
        "Only merged branches can be deleted. This cannot be undone.",
        "マージ済みのブランチだけを削除できます。この操作は元に戻せません。",
        "只能删除已合并的分支；此操作无法撤销。",
        "Seules les branches fusionnées peuvent être supprimées. Cette action est irréversible.",
    ),
    translation(
        "Cannot delete a checked-out branch.",
        "チェックアウト中のブランチは削除できません。",
        "不能删除已检出的分支。",
        "Impossible de supprimer une branche extraite.",
    ),
    translation(
        "Branch deleted.",
        "ブランチを削除しました。",
        "分支已删除。",
        "Branche supprimée.",
    ),
    translation(
        "Could not delete branch. It may be unmerged or checked out.",
        "ブランチを削除できませんでした。未マージかチェックアウト中の可能性があります。",
        "无法删除分支；它可能尚未合并或仍被检出。",
        "Impossible de supprimer la branche. Elle peut être non fusionnée ou extraite.",
    ),
    translation(
        "Create a branch at HEAD without switching worktrees.",
        "ワークツリーを切り替えずに HEAD にブランチを作成します。",
        "基于 HEAD 创建分支，不切换工作树。",
        "Créer une branche à HEAD sans changer d'arbre de travail.",
    ),
    translation(
        "Could not switch branch. Check uncommitted changes and worktree use.",
        "ブランチを切り替えられませんでした。未コミットの変更とワークツリーの使用状況を確認してください。",
        "无法切换分支。请检查未提交的更改及其他工作树的占用情况。",
        "Impossible de changer de branche. Vérifiez les modifications et les arbres de travail.",
    ),
    translation(
        "Could not create branch. Check the branch name and whether it already exists.",
        "ブランチを作成できませんでした。名前と既存のブランチを確認してください。",
        "无法创建分支。请检查分支名称及是否已存在。",
        "Impossible de créer la branche. Vérifiez son nom et si elle existe déjà.",
    ),
    translation(
        "The connected App Server does not support this branch action. Restart it to use the current version.",
        "接続中の App Server はこのブランチ操作に対応していません。再起動して現在のバージョンを使用してください。",
        "当前连接的 App Server 不支持此分支操作。请重启以使用当前版本。",
        "L'App Server connecté ne prend pas en charge cette action. Redémarrez-le pour utiliser la version actuelle.",
    ),
    translation(
        "Git is unavailable for this project.",
        "このプロジェクトでは Git を利用できません。",
        "此项目无法使用 Git。",
        "Git est indisponible pour ce projet.",
    ),
    translation(
        "This project is not a Git repository.",
        "このプロジェクトは Git リポジトリではありません。",
        "此项目不是 Git 仓库。",
        "Ce projet n'est pas un dépôt Git.",
    ),
    translation(
        "Could not read project branches.",
        "プロジェクトのブランチを読み取れませんでした。",
        "无法读取项目分支。",
        "Impossible de lire les branches du projet.",
    ),
    translation(
        "Created branch is no longer available.",
        "作成したブランチは利用できなくなりました。",
        "新建分支已不可用。",
        "La branche créée n'est plus disponible.",
    ),
    translation(
        "Git request failed.",
        "Git リクエストに失敗しました。",
        "Git 请求失败。",
        "La requête Git a échoué.",
    ),
    translation("Branch name", "ブランチ名", "分支名称", "Nom de la branche"),
    translation(
        "Create branch",
        "ブランチを作成",
        "创建分支",
        "Créer une branche",
    ),
    translation(
        "Enter a branch name",
        "ブランチ名を入力してください",
        "请输入分支名称",
        "Saisissez un nom de branche",
    ),
    translation(
        "Enter a branch name after ash/",
        "ash/ の後にブランチ名を入力してください",
        "请在 ash/ 后输入分支名称",
        "Saisissez un nom de branche après ash/",
    ),
    translation(
        "New worktree",
        "新しいワークツリー",
        "新建工作树",
        "Nouvel arbre de travail",
    ),
    translation(
        "Worktree name",
        "ワークツリー名",
        "工作树名称",
        "Nom de l'arbre de travail",
    ),
    translation(
        "Create worktree",
        "ワークツリーを作成",
        "创建工作树",
        "Créer l'arbre de travail",
    ),
    translation(
        "Worktree created at",
        "ワークツリーの作成先:",
        "工作树已创建于",
        "Arbre de travail créé à",
    ),
    translation(
        "Create at HEAD. No session starts.",
        "HEAD から作成します。セッションは開始しません。",
        "从 HEAD 创建，不启动会话。",
        "Créer à HEAD. Aucune session ne démarre.",
    ),
    translation(
        "Use 1–64 letters, numbers, '-' or '_'",
        "1～64 文字の英数字、'-'、'_' を使用してください",
        "请使用 1–64 个英文字母、数字、'-' 或 '_'",
        "Utilisez 1 à 64 lettres, chiffres, '-' ou '_'",
    ),
    translation(
        "New branch",
        "新しいブランチ",
        "新建分支",
        "Nouvelle branche",
    ),
    translation(
        "Cancel sign-in",
        "サインインをキャンセル",
        "取消登录",
        "Annuler la connexion",
    ),
    translation(
        "ChatGPT subscription",
        "ChatGPT サブスクリプション",
        "ChatGPT 订阅",
        "Abonnement ChatGPT",
    ),
    translation(
        "Clear user shortcuts",
        "ユーザーショートカットを消去",
        "清除用户快捷键",
        "Effacer les raccourcis utilisateur",
    ),
    translation("Closed", "終了", "已关闭", "Fermés"),
    translation("Commands", "コマンド", "命令", "Commandes"),
    translation(
        "Complete provider name and Base URL to save",
        "保存するにはプロバイダー名とベース URL を入力してください",
        "请填写提供商名称和基础 URL 后再保存",
        "Renseignez le fournisseur et l’URL de base avant d’enregistrer",
    ),
    translation("Connected", "接続済み", "已连接", "Connectés"),
    translation("Connection", "接続", "连接", "Connexion"),
    translation("Connectors", "コネクター", "连接器", "Connecteurs"),
    translation(
        "Context usage",
        "コンテキスト使用量",
        "上下文用量",
        "Utilisation du contexte",
    ),
    translation("Current", "現在", "当前", "Actuelle"),
    translation(
        "Custom commands",
        "カスタムコマンド",
        "自定义命令",
        "Commandes personnalisées",
    ),
    translation("Dashboard", "ダッシュボード", "仪表盘", "Tableau de bord"),
    translation("Decline", "拒否", "拒绝", "Refuser"),
    translation("Diagnostics", "診断", "诊断", "Diagnostics"),
    translation("Directories", "ディレクトリ", "目录", "Dossiers"),
    translation(
        "Directory already added",
        "ディレクトリは追加済みです",
        "目录已添加",
        "Dossier déjà ajouté",
    ),
    translation(
        "Disconnect from Ash",
        "Ash から切断",
        "断开 Ash 连接",
        "Se déconnecter d’Ash",
    ),
    translation(
        "Duplicate pinned model",
        "固定済みモデルが重複しています",
        "固定模型重复",
        "Modèle épinglé en double",
    ),
    translation(
        "Enter a directory path",
        "ディレクトリパスを入力",
        "输入目录路径",
        "Saisir le chemin du dossier",
    ),
    translation("Enter code", "コードを入力", "输入代码", "Saisir le code"),
    translation("Error", "エラー", "错误", "Erreur"),
    translation(
        "File read",
        "ファイル読み取り",
        "读取文件",
        "Lecture de fichier",
    ),
    translation(
        "File write",
        "ファイル書き込み",
        "写入文件",
        "Écriture de fichier",
    ),
    translation("Fork", "フォーク", "派生", "Fork"),
    translation("Help", "ヘルプ", "帮助", "Aide"),
    translation(
        "Help and shortcuts",
        "ヘルプとショートカット",
        "帮助与快捷键",
        "Aide et raccourcis",
    ),
    translation("ID", "ID", "ID", "ID"),
    translation("Issues", "Issue", "议题", "Tickets"),
    translation("Keymap", "キーマップ", "快捷键", "Raccourcis"),
    translation(
        "Language servers",
        "言語サーバー",
        "语言服务器",
        "Serveurs de langage",
    ),
    translation("Lifecycle", "ライフサイクル", "生命周期", "Cycle de vie"),
    translation(
        "Loading context…",
        "コンテキストを読み込み中…",
        "正在加载上下文…",
        "Chargement du contexte…",
    ),
    translation(
        "Loading branches…",
        "ブランチを読み込み中…",
        "正在加载分支…",
        "Chargement des branches…",
    ),
    translation(
        "Loading issues...",
        "Issue を読み込み中...",
        "正在加载议题...",
        "Chargement des tickets...",
    ),
    translation(
        "Loading Project folders…",
        "プロジェクトフォルダーを読み込み中…",
        "正在加载项目文件夹…",
        "Chargement des dossiers de projet…",
    ),
    translation("Loading…", "読み込み中…", "正在加载…", "Chargement…"),
    translation("MCP", "MCP", "MCP", "MCP"),
    translation("Memories", "メモリ", "记忆", "Mémoires"),
    translation(
        "Refresh permissions",
        "権限を更新",
        "刷新权限",
        "Actualiser les permissions",
    ),
    translation(
        "Permissions changed. Refresh permissions before retrying.",
        "権限が変更されました。更新してから再試行してください。",
        "权限已变更，请刷新权限后重试。",
        "Les permissions ont changé. Actualisez-les avant de réessayer.",
    ),
    translation(
        "Memories off",
        "メモリはオフ",
        "记忆已关闭",
        "Mémoires désactivées",
    ),
    translation("Cancel", "キャンセル", "取消", "Annuler"),
    translation("Startup", "起動情報", "启动信息", "Démarrage"),
    translation("Branch", "ブランチ", "分支", "Branche"),
    translation("Forked from", "フォーク元", "派生自", "Dérivé de"),
    translation("Join", "参加", "加入", "Jonction"),
    translation(
        "Delivered result",
        "配信済み結果",
        "已交付结果",
        "Résultat livré",
    ),
    translation(
        "Custom color themes",
        "カスタム配色テーマ",
        "自定义配色主题",
        "Thèmes de couleurs personnalisés",
    ),
    translation(
        "No custom color themes found",
        "カスタム配色テーマが見つかりません",
        "未找到自定义配色主题",
        "Aucun thème de couleurs personnalisé",
    ),
    translation(
        "Diff preview",
        "差分プレビュー",
        "差异预览",
        "Aperçu du diff",
    ),
    translation(
        "Syntax palette",
        "構文パレット",
        "语法配色",
        "Palette syntaxique",
    ),
    translation(
        "Auto (match terminal)",
        "自動（ターミナルに合わせる）",
        "自动（匹配终端）",
        "Auto (selon le terminal)",
    ),
    translation("Dark mode", "ダークモード", "深色模式", "Mode sombre"),
    translation("Light mode", "ライトモード", "浅色模式", "Mode clair"),
    translation(
        "Custom color theme",
        "カスタム配色テーマ",
        "自定义配色主题",
        "Thème de couleurs personnalisé",
    ),
    translation(
        "User-defined",
        "ユーザー定義",
        "用户定义",
        "Défini par l’utilisateur",
    ),
    translation(
        "API usage billing",
        "API 使用量課金",
        "API 用量计费",
        "Facturation à l’usage de l’API",
    ),
    translation("Subscription", "サブスクリプション", "订阅", "Abonnement"),
    translation("Local", "ローカル", "本地", "Local"),
    translation("Enterprise", "エンタープライズ", "企业", "Entreprise"),
    translation(
        "Access unknown",
        "アクセス不明",
        "访问方式未知",
        "Accès inconnu",
    ),
    translation(
        "Model pinned",
        "モデルを固定しました",
        "模型已固定",
        "Modèle épinglé",
    ),
    translation(
        "Model unpinned",
        "モデルの固定を解除しました",
        "模型已取消固定",
        "Modèle désépinglé",
    ),
    translation(
        "The key is hidden and stored in the profile secret store",
        "キーは非表示でプロファイルのシークレットストアに保存されます",
        "密钥将被隐藏并存储在配置文件的机密存储中",
        "La clé est masquée et stockée dans le coffre de secrets du profil",
    ),
    translation(
        "Enter API key",
        "API キーを入力",
        "输入 API 密钥",
        "Saisir la clé API",
    ),
    translation(
        "New custom provider",
        "新しいカスタムプロバイダー",
        "新建自定义提供商",
        "Nouveau fournisseur personnalisé",
    ),
    translation(
        "Read files",
        "ファイルを読み取り",
        "读取文件",
        "Lire les fichiers",
    ),
    translation(
        "Watch file changes",
        "ファイル変更を監視",
        "监视文件更改",
        "Surveiller les modifications",
    ),
    translation(
        "Browse files",
        "ファイルを参照",
        "浏览文件",
        "Parcourir les fichiers",
    ),
    translation(
        "Search files",
        "ファイルを検索",
        "搜索文件",
        "Rechercher dans les fichiers",
    ),
    translation(
        "Load instructions",
        "指示を読み込み",
        "加载指令",
        "Charger les instructions",
    ),
    translation(
        "Load config",
        "設定を読み込み",
        "加载配置",
        "Charger la configuration",
    ),
    translation("LSP", "LSP", "语言服务", "LSP"),
    translation("Hooks", "フック", "钩子", "Hooks"),
    translation("Plugins", "プラグイン", "插件", "Plugins"),
    translation(
        "Inspect repository",
        "リポジトリを調査",
        "检查仓库",
        "Inspecter le dépôt",
    ),
    translation(
        "Mutate repository",
        "リポジトリを変更",
        "更改仓库",
        "Modifier le dépôt",
    ),
    translation(
        "Allow read_file, grep and glob",
        "read_file、grep、glob を許可",
        "允许 read_file、grep 和 glob",
        "Autoriser read_file, grep et glob",
    ),
    translation(
        "Allow file-writing tools and apply_patch",
        "ファイル書き込みツールと apply_patch を許可",
        "允许文件写入工具和 apply_patch",
        "Autoriser les outils d’écriture et apply_patch",
    ),
    translation(
        "Allow shell-command and Session terminals",
        "shell-command とセッションターミナルを許可",
        "允许 shell-command 和会话终端",
        "Autoriser shell-command et les terminaux de session",
    ),
    translation(
        "Watch this directory for file changes",
        "このディレクトリの変更を監視",
        "监视此目录中的文件更改",
        "Surveiller les modifications de ce dossier",
    ),
    translation(
        "Show this directory in file browsing surfaces",
        "ファイル参照画面にこのディレクトリを表示",
        "在文件浏览界面中显示此目录",
        "Afficher ce dossier dans les navigateurs de fichiers",
    ),
    translation(
        "Search file contents in this directory",
        "このディレクトリ内のファイル内容を検索",
        "搜索此目录中的文件内容",
        "Rechercher dans le contenu des fichiers de ce dossier",
    ),
    translation(
        "Load .ash/instructions and .ash/agents",
        ".ash/instructions と .ash/agents を読み込み",
        "加载 .ash/instructions 和 .ash/agents",
        "Charger .ash/instructions et .ash/agents",
    ),
    translation(
        "Load configuration supplied by this directory",
        "このディレクトリが提供する設定を読み込み",
        "加载此目录提供的配置",
        "Charger la configuration fournie par ce dossier",
    ),
    translation(
        "Use language servers for this directory; starting them also requires Run commands",
        "このディレクトリで言語サーバーを使用；起動にはコマンド実行も必要",
        "为此目录使用语言服务器；启动还需要运行命令权限",
        "Utiliser les serveurs de langage pour ce dossier ; leur démarrage exige aussi l’exécution de commandes",
    ),
    translation(
        "Read repository metadata and status",
        "リポジトリのメタデータと状態を読み取り",
        "读取仓库元数据和状态",
        "Lire les métadonnées et l’état du dépôt",
    ),
    translation(
        "Change repository state",
        "リポジトリの状態を変更",
        "更改仓库状态",
        "Modifier l’état du dépôt",
    ),
    translation(
        "Enter one directory path without control characters",
        "制御文字を含まないディレクトリパスを 1 つ入力",
        "输入一个不含控制字符的目录路径",
        "Saisissez un chemin de dossier sans caractères de contrôle",
    ),
    translation(
        "This memory changed. Refresh and select it again; your draft is kept.",
        "このメモリは変更されました。更新して再選択してください；下書きは保持されます。",
        "此记忆已更改。请刷新后重新选择；草稿已保留。",
        "Cette mémoire a changé. Actualisez et resélectionnez-la ; votre brouillon est conservé.",
    ),
    translation(
        "The memory list changed. Refresh the list.",
        "メモリ一覧が変更されました。一覧を更新してください。",
        "记忆列表已更改。请刷新列表。",
        "La liste des mémoires a changé. Actualisez-la.",
    ),
    translation(
        "This memory was deleted. Refresh the list.",
        "このメモリは削除されました。一覧を更新してください。",
        "此记忆已删除。请刷新列表。",
        "Cette mémoire a été supprimée. Actualisez la liste.",
    ),
    translation(
        "Check the title, content and memory reference.",
        "タイトル、内容、メモリ参照を確認してください。",
        "请检查标题、内容和记忆引用。",
        "Vérifiez le titre, le contenu et la référence mémoire.",
    ),
    translation(
        "Discover Skills from this directory",
        "このディレクトリからスキルを検出（",
        "从此目录发现技能（",
        "Découvrir les compétences de ce dossier (",
    ),
    translation(
        "Authorize MCP declarations",
        "MCP 宣言を承認（",
        "授权 MCP 声明（",
        "Autoriser les déclarations MCP (",
    ),
    translation(
        "Discover Hooks",
        "フックを検出（",
        "发现钩子（",
        "Découvrir les hooks (",
    ),
    translation(
        "Authorize Plugin requests",
        "プラグイン要求を承認（",
        "授权插件请求（",
        "Autoriser les demandes de plugin (",
    ),
    translation("reset", "リセット", "重置", "réinitialiser"),
    translation(
        "remove provider",
        "プロバイダーを削除",
        "移除提供商",
        "supprimer le fournisseur",
    ),
    translation(
        "image in clipboard",
        "クリップボードに画像があります",
        "剪贴板中有图片",
        "image dans le presse-papiers",
    ),
    translation(
        "Add a directory to this project",
        "このプロジェクトにディレクトリを追加",
        "向此项目添加目录",
        "Ajouter un dossier à ce projet",
    ),
    translation(
        "restore before this turn; keep the original branch",
        "このターンの前に復元；元のブランチは保持",
        "恢复到此轮之前；保留原分支",
        "restaurer avant ce tour ; conserver la branche d’origine",
    ),
    translation(
        "Search message checkpoints",
        "メッセージチェックポイントを検索",
        "搜索消息检查点",
        "Rechercher les points de contrôle",
    ),
    translation(
        "Search MCP servers",
        "MCP サーバーを検索",
        "搜索 MCP 服务器",
        "Rechercher les serveurs MCP",
    ),
    translation(
        "Search available skills",
        "利用可能なスキルを検索",
        "搜索可用技能",
        "Rechercher les compétences disponibles",
    ),
    translation(
        "Search saved sessions",
        "保存済みセッションを検索",
        "搜索已保存的会话",
        "Rechercher les sessions enregistrées",
    ),
    translation(
        "Search project folders",
        "プロジェクトフォルダーを検索",
        "搜索项目文件夹",
        "Rechercher les dossiers de projet",
    ),
    translation("Model", "モデル", "模型", "Modèle"),
    translation(
        "Model calls",
        "モデル呼び出し",
        "模型调用",
        "Appels du modèle",
    ),
    translation(
        "Modify files",
        "ファイルを変更",
        "修改文件",
        "Modifier les fichiers",
    ),
    translation("Network", "ネットワーク", "网络", "Réseau"),
    translation("New", "新規", "新建", "Nouveau"),
    translation(
        "No custom commands available",
        "利用可能なカスタムコマンドはありません",
        "没有可用的自定义命令",
        "Aucune commande personnalisée",
    ),
    translation(
        "No directories",
        "ディレクトリがありません",
        "没有目录",
        "Aucun dossier",
    ),
    translation(
        "No keymap diagnostics",
        "キーマップ診断はありません",
        "没有快捷键诊断",
        "Aucun diagnostic de raccourci",
    ),
    translation(
        "No matching branches",
        "一致するブランチがありません",
        "没有匹配的分支",
        "Aucune branche correspondante",
    ),
    translation(
        "No matching Connectors",
        "一致するコネクターがありません",
        "没有匹配的连接器",
        "Aucun connecteur correspondant",
    ),
    translation(
        "No matching help entries",
        "一致するヘルプ項目がありません",
        "没有匹配的帮助条目",
        "Aucune aide correspondante",
    ),
    translation(
        "No matching items",
        "一致する項目がありません",
        "没有匹配项",
        "Aucun élément correspondant",
    ),
    translation(
        "No matching shortcuts",
        "一致するショートカットがありません",
        "没有匹配的快捷键",
        "Aucun raccourci correspondant",
    ),
    translation(
        "No configured models · Configure a provider in /config",
        "設定済みのモデルがありません · /config でプロバイダーを設定してください",
        "没有已配置的模型 · 请在 /config 中配置提供商",
        "Aucun modèle configuré · Configurez un fournisseur dans /config",
    ),
    translation(
        "No sessions yet",
        "セッションはまだありません",
        "还没有会话",
        "Aucune session",
    ),
    translation(
        "No test result received",
        "テスト結果を受信できませんでした",
        "未收到测试结果",
        "Aucun résultat de test reçu",
    ),
    translation(
        "No threads",
        "スレッドがありません",
        "没有线程",
        "Aucun fil",
    ),
    translation("Not connected", "未接続", "未连接", "Non connectés"),
    translation(
        "Not signed in",
        "サインインしていません",
        "未登录",
        "Non connecté",
    ),
    translation("Open", "未解決", "开放", "Ouverts"),
    translation(
        "Open in your browser",
        "ブラウザーで開く",
        "在浏览器中打开",
        "Ouvrir dans le navigateur",
    ),
    translation(
        "Open Mermaid in browser",
        "Mermaid をブラウザーで開く",
        "在浏览器中打开 Mermaid",
        "Ouvrir Mermaid dans le navigateur",
    ),
    translation(
        "Could not prepare Mermaid preview",
        "Mermaid のプレビューを準備できませんでした",
        "无法准备 Mermaid 预览",
        "Impossible de préparer l’aperçu Mermaid",
    ),
    translation(
        "Browser opened",
        "ブラウザーを開きました",
        "已打开浏览器",
        "Navigateur ouvert",
    ),
    translation(
        "Could not open browser",
        "ブラウザーを開けませんでした",
        "无法打开浏览器",
        "Impossible d’ouvrir le navigateur",
    ),
    translation("Parent", "親", "父级", "Parent"),
    translation("Passed", "成功", "已通过", "Réussi"),
    translation(
        "Other models",
        "その他のモデル",
        "其他模型",
        "Autres modèles",
    ),
    translation("Models", "モデル", "模型", "Modèles"),
    translation(
        "No models available",
        "利用可能なモデルはありません",
        "没有可用模型",
        "Aucun modèle disponible",
    ),
    translation(
        "Could not load models",
        "モデルを読み込めませんでした",
        "无法加载模型",
        "Impossible de charger les modèles",
    ),
    translation(
        "Loading models…",
        "モデルを読み込み中…",
        "正在加载模型…",
        "Chargement des modèles…",
    ),
    translation("Pinned", "固定済み", "已固定", "Épinglées"),
    translation("Plan", "プラン", "计划", "Plan"),
    translation("Preview", "プレビュー", "预览", "Aperçu"),
    translation("Processes", "プロセス", "进程", "Processus"),
    translation("Profile", "プロファイル", "配置档", "Profil"),
    translation(
        "Project folder already added",
        "プロジェクトフォルダーは追加済みです",
        "项目文件夹已添加",
        "Dossier de projet déjà ajouté",
    ),
    translation("Quit", "終了", "退出", "Quitter"),
    translation(
        "Reading issue...",
        "Issue を読み込み中...",
        "正在读取议题...",
        "Lecture du ticket...",
    ),
    translation(
        "Record shortcut",
        "ショートカットを記録",
        "录制快捷键",
        "Enregistrer le raccourci",
    ),
    translation(
        "Remove directory",
        "ディレクトリを削除",
        "移除目录",
        "Retirer le dossier",
    ),
    translation(
        "Replace user shortcut with a chord",
        "ユーザーショートカットをコードで置換",
        "用组合键替换用户快捷键",
        "Remplacer par une séquence",
    ),
    translation(
        "Replace user shortcut with a key",
        "ユーザーショートカットをキーで置換",
        "用按键替换用户快捷键",
        "Remplacer par une touche",
    ),
    translation("Resume", "再開", "恢复", "Reprendre"),
    translation(
        "Resume session",
        "セッションを再開",
        "恢复会话",
        "Reprendre une session",
    ),
    translation("Root", "ルート", "根", "Racine"),
    translation(
        "Run commands",
        "コマンドを実行",
        "运行命令",
        "Exécuter des commandes",
    ),
    translation("Saved", "保存しました", "已保存", "Enregistré"),
    translation("Saving…", "保存中…", "正在保存…", "Enregistrement…"),
    translation(
        "Search branches",
        "ブランチを検索",
        "搜索分支",
        "Rechercher des branches",
    ),
    translation(
        "Search configuration",
        "設定を検索",
        "搜索配置",
        "Rechercher dans la configuration",
    ),
    translation(
        "Search connectors",
        "コネクターを検索",
        "搜索连接器",
        "Rechercher des connecteurs",
    ),
    translation(
        "Search help",
        "ヘルプを検索",
        "搜索帮助",
        "Rechercher dans l’aide",
    ),
    translation(
        "Search keywords or #number",
        "キーワードまたは #番号を検索",
        "搜索关键词或 #编号",
        "Rechercher des mots-clés ou un n°",
    ),
    translation(
        "Search models",
        "モデルを検索",
        "搜索模型",
        "Rechercher des modèles",
    ),
    translation(
        "Search shortcuts",
        "ショートカットを検索",
        "搜索快捷键",
        "Rechercher des raccourcis",
    ),
    translation(
        "Select a model or enter a model ID before testing",
        "テスト前にモデルを選択するかモデル ID を入力してください",
        "测试前请选择模型或输入模型 ID",
        "Sélectionnez un modèle ou saisissez son ID avant le test",
    ),
    translation(
        "Select one or more issues with Space.",
        "Space で 1 件以上の Issue を選択してください。",
        "请用空格键选择一个或多个议题。",
        "Sélectionnez un ou plusieurs tickets avec Espace.",
    ),
    translation("Session", "セッション", "会话", "Session"),
    translation(
        "Session details",
        "セッション詳細",
        "会话详情",
        "Détails de la session",
    ),
    translation("Session ID", "セッション ID", "会话 ID", "ID de session"),
    translation("Settings", "設定", "设置", "Paramètres"),
    translation("Shortcuts", "ショートカット", "快捷键", "Raccourcis"),
    translation(
        "Sign in with ChatGPT",
        "ChatGPT でサインイン",
        "使用 ChatGPT 登录",
        "Se connecter avec ChatGPT",
    ),
    translation(
        "Sign in with Kimi",
        "Kimi でサインイン",
        "使用 Kimi 登录",
        "Se connecter avec Kimi",
    ),
    translation(
        "Sign in with Super Grok",
        "Super Grok でサインイン",
        "使用 Super Grok 登录",
        "Se connecter avec Super Grok",
    ),
    translation(
        "Signed in to Super Grok",
        "Super Grok にサインインしました",
        "已登录 Super Grok",
        "Connecté à Super Grok",
    ),
    translation(
        "Disconnected from Super Grok in Ash",
        "Ash で Super Grok から切断しました",
        "已在 Ash 中断开 Super Grok 连接",
        "Déconnecté de Super Grok dans Ash",
    ),
    translation(
        "Signed in to Kimi",
        "Kimi にサインインしました",
        "已登录 Kimi",
        "Connecté à Kimi",
    ),
    translation(
        "Disconnected from Kimi in Ash",
        "Ash で Kimi から切断しました",
        "已在 Ash 中断开 Kimi 连接",
        "Déconnecté de Kimi dans Ash",
    ),
    translation(
        "Coding plan enabled",
        "コーディングプランは有効",
        "Coding Plan 已启用",
        "Forfait de code activé",
    ),
    translation(
        "Coding plan not enabled",
        "コーディングプランは未有効",
        "Coding Plan 未启用",
        "Forfait de code non activé",
    ),
    translation(
        "Sign in with BigModel",
        "BigModel でサインイン",
        "使用 BigModel 登录",
        "Se connecter avec BigModel",
    ),
    translation(
        "Enter the API key from your BigModel Coding Plan",
        "BigModel Coding Plan の API キーを入力してください",
        "请输入 BigModel Coding Plan 的 API 密钥",
        "Saisissez la clé API de votre offre BigModel Coding Plan",
    ),
    translation(
        "Enable BigModel",
        "BigModel を有効化",
        "启用 BigModel",
        "Activer BigModel",
    ),
    translation(
        "Disable BigModel",
        "BigModel を無効化",
        "停用 BigModel",
        "Désactiver BigModel",
    ),
    translation("Skills", "スキル", "技能", "Compétences"),
    translation(
        "Start a task below, or continue a previous session.",
        "下でタスクを開始するか、以前のセッションを続けます。",
        "在下方开始任务，或继续之前的会话。",
        "Démarrez une tâche ci-dessous ou reprenez une session.",
    ),
    translation(
        "Starting Issue session...",
        "Issue セッションを開始中...",
        "正在启动议题会话...",
        "Démarrage de la session du ticket...",
    ),
    translation(
        "Starting session…",
        "セッションを開始中…",
        "正在启动会话…",
        "Démarrage de la session…",
    ),
    translation("Status", "ステータス", "状态", "État"),
    translation("Usage", "使用量", "额度", "Utilisation"),
    translation(
        "ChatGPT plan",
        "ChatGPT プラン",
        "ChatGPT 套餐",
        "Abonnement ChatGPT",
    ),
    translation("Limits", "利用上限", "额度限制", "Limites"),
    translation("Windows", "集計期間", "额度窗口", "Périodes"),
    translation("Resets", "リセット", "重置时间", "Réinitialisation"),
    translation("Credits", "クレジット", "点数", "Crédits"),
    translation("Unlimited", "無制限", "无限制", "Illimités"),
    translation("Not reported", "情報なし", "未提供", "Non communiqué"),
    translation("Availability", "利用状況", "可用状态", "Disponibilité"),
    translation("Limit reached", "上限に到達", "已达上限", "Limite atteinte"),
    translation(
        "No credits available",
        "クレジットなし",
        "无可用点数",
        "Aucun crédit disponible",
    ),
    translation(
        "Available; balance not reported",
        "利用可能・残高情報なし",
        "可用；余额未提供",
        "Disponibles ; solde non communiqué",
    ),
    translation(
        "Run /usage to refresh",
        "/usage で更新",
        "运行 /usage 刷新",
        "Relancer /usage pour actualiser",
    ),
    translation(
        "show ChatGPT quota and reset times",
        "ChatGPT の利用上限とリセット時刻を表示",
        "查看 ChatGPT 额度和重置时间",
        "afficher les quotas ChatGPT et leur réinitialisation",
    ),
    translation(
        "Sign in to ChatGPT: /config > Providers.",
        "/config > プロバイダーで ChatGPT にログインしてください。",
        "在 /config > 提供商中登录 ChatGPT 后查看额度。",
        "Connectez-vous à ChatGPT dans /config > Fournisseurs pour consulter les quotas.",
    ),
    translation(
        "Reconnect ChatGPT in /config > Providers.",
        "/config > プロバイダーで ChatGPT に再接続してください。",
        "ChatGPT 登录需要处理。打开 /config > 提供商重新连接。",
        "Reconnectez-vous à ChatGPT dans /config > Fournisseurs.",
    ),
    translation(
        "ChatGPT account changed. Run /usage again.",
        "ChatGPT アカウントが変更されました。/usage を再実行してください。",
        "ChatGPT 账号已切换，请重新运行 /usage。",
        "Le compte ChatGPT a changé. Relancez /usage.",
    ),
    translation(
        "Could not load ChatGPT usage. Run /usage to retry.",
        "ChatGPT の使用量を取得できませんでした。/usage で再試行してください。",
        "无法读取 ChatGPT 额度，请运行 /usage 重试。",
        "Impossible de lire les quotas ChatGPT. Relancez /usage.",
    ),
    translation("Status line", "ステータスライン", "状态栏", "Barre d’état"),
    translation("Submitting…", "送信中…", "正在提交…", "Envoi…"),
    translation("Switch", "切り替え", "切换", "Changer"),
    translation(
        "Switch branch",
        "ブランチを切り替え",
        "切换分支",
        "Changer de branche",
    ),
    translation(
        "Switch project folder",
        "プロジェクトフォルダーを切り替え",
        "切换项目文件夹",
        "Changer de dossier de projet",
    ),
    translation(
        "System configuration",
        "システム設定",
        "系统配置",
        "Configuration système",
    ),
    translation("Test", "テスト", "测试", "Tester"),
    translation("Testing…", "テスト中…", "正在测试…", "Test…"),
    translation(
        "The response belongs to another session.",
        "応答は別のセッションに属しています。",
        "响应属于另一个会话。",
        "La réponse appartient à une autre session.",
    ),
    translation("Theme", "テーマ", "主题", "Thème"),
    translation("Thread", "スレッド", "线程", "Fil"),
    translation("Thread ID", "スレッド ID", "线程 ID", "ID du fil"),
    translation("Threads", "スレッド", "线程", "Fils"),
    translation("Total", "合計", "总计", "Total"),
    translation("Total usage", "合計使用量", "总用量", "Utilisation totale"),
    translation(
        "Type keywords/#number",
        "キーワード/#番号を入力",
        "输入关键词/#编号",
        "Saisir des mots-clés ou un n°",
    ),
    translation("User", "ユーザー", "用户", "Utilisateur"),
    translation(
        "User interface",
        "ユーザーインターフェース",
        "用户界面",
        "Interface utilisateur",
    ),
    translation(
        "Waiting for the request result",
        "リクエスト結果を待っています",
        "正在等待请求结果",
        "En attente du résultat",
    ),
    translation(
        "completed · choose Main or another Subagent",
        "完了 · Main または別のサブエージェントを選択",
        "已完成 · 请选择 Main 或其他子智能体",
        "terminé · choisissez Main ou un autre sous-agent",
    ),
    translation(
        "Type a new task · Tab actions · Esc return",
        "新しいタスクを入力 · Tab 操作 · Esc 戻る",
        "输入新任务 · Tab 操作 · Esc 返回",
        "Saisissez une nouvelle tâche · Tab actions · Échap retour",
    ),
    translation(
        "Type a task · Tab actions",
        "タスクを入力 · Tab 操作",
        "输入任务 · Tab 操作",
        "Saisissez une tâche · Tab actions",
    ),
    translation(
        "Type a task to begin, or use Tab to choose an action.",
        "タスクを入力して開始するか、Tab で操作を選択します。",
        "输入任务以开始，或按 Tab 选择操作。",
        "Saisissez une tâche ou utilisez Tab pour choisir une action.",
    ),
    translation("Workspace", "ワークスペース", "工作区", "Espace de travail"),
    translation("Working…", "処理中…", "正在处理…", "Traitement…"),
    translation("actions", "操作", "操作", "actions"),
    translation("ago", "前", "前", "il y a"),
    translation("add", "追加", "添加", "ajouter"),
    translation("answer", "回答", "回答", "répondre"),
    translation("apply", "適用", "应用", "appliquer"),
    translation("archive", "アーカイブ", "归档", "archiver"),
    translation("back", "戻る", "返回", "retour"),
    translation("cancel", "キャンセル", "取消", "annuler"),
    translation("change", "変更", "更改", "modifier"),
    translation("choose", "選択", "选择", "choisir"),
    translation("close", "閉じる", "关闭", "fermer"),
    translation("collapse", "折りたたむ", "折叠", "réduire"),
    translation("commands", "コマンド", "命令", "commandes"),
    translation("create", "作成", "创建", "créer"),
    translation("confirm", "確定", "确认", "confirmer"),
    translation(
        "connect/disconnect",
        "接続/切断",
        "连接/断开",
        "connecter/déconnecter",
    ),
    translation(
        "cycle policy",
        "ポリシー切替",
        "切换策略",
        "changer de politique",
    ),
    translation("delete", "削除", "删除", "supprimer"),
    translation("details", "詳細", "详情", "détails"),
    translation("edit", "編集", "编辑", "modifier"),
    translation(
        "editing in progress",
        "編集中",
        "正在编辑",
        "modification en cours",
    ),
    translation("expand", "展開", "展开", "développer"),
    translation("input", "入力", "输入", "saisie"),
    translation("interrupt", "中断", "中断", "interrompre"),
    translation("move", "移動", "移动", "déplacer"),
    translation("move down", "下へ移動", "下移", "descendre"),
    translation("move up", "上へ移動", "上移", "monter"),
    translation("more", "件", "项", "de plus"),
    translation("navigate", "移動", "导航", "naviguer"),
    translation("next", "次へ", "下一个", "suivant"),
    translation("open", "開く", "打开", "ouvrir"),
    translation("page down", "次のページ", "下一页", "page suivante"),
    translation("page up", "前のページ", "上一页", "page précédente"),
    translation("paste", "貼り付け", "粘贴", "coller"),
    translation("permissions", "権限", "权限", "autorisations"),
    translation("pin", "固定", "固定", "épingler"),
    translation("preview", "プレビュー", "预览", "aperçu"),
    translation("previous", "前へ", "上一个", "précédent"),
    translation("refresh", "更新", "刷新", "actualiser"),
    translation("remove", "削除", "移除", "retirer"),
    translation("restore", "復元", "恢复", "restaurer"),
    translation("resume", "再開", "恢复", "reprendre"),
    translation("return", "戻る", "返回", "retour"),
    translation(
        "return to input",
        "入力に戻る",
        "返回输入",
        "retour à la saisie",
    ),
    translation("rewind", "巻き戻す", "回退", "rembobiner"),
    translation("save", "保存", "保存", "enregistrer"),
    translation("scroll", "スクロール", "滚动", "défiler"),
    translation("search", "検索", "搜索", "rechercher"),
    translation("select", "選択", "选择", "sélectionner"),
    translation("selected", "選択済み", "已选择", "sélectionnés"),
    translation("send", "送信", "发送", "envoyer"),
    translation("send now", "今すぐ送信", "立即发送", "envoyer maintenant"),
    translation("start", "開始", "启动", "démarrer"),
    translation("state", "状態", "状态", "état"),
    translation("switch", "切り替え", "切换", "changer"),
    translation("tabs", "タブ", "标签页", "onglets"),
    translation("test", "テスト", "测试", "tester"),
    translation("toggle", "切り替え", "切换", "basculer"),
    translation("view details", "詳細を表示", "查看详情", "voir les détails"),
    translation(
        "Answer in the input below",
        "下の入力欄で回答",
        "在下方输入框中回答",
        "Répondez dans le champ ci-dessous",
    ),
    translation("Queue", "キュー", "队列", "File"),
    translation(
        "Type your own answer",
        "自分で入力",
        "自己输入",
        "Saisir votre réponse",
    ),
    translation("editing", "編集中", "正在编辑", "modification"),
    translation("paused", "一時停止", "已暂停", "en pause"),
    translation("sending", "送信中", "正在发送", "envoi"),
    translation("to interrupt", "で中断", "可中断", "pour interrompre"),
    translation("total", "合計", "总计", "au total"),
    translation("Actions", "操作", "操作", "Actions"),
    translation(
        "Attach clipboard image",
        "クリップボード画像を添付",
        "附加剪贴板图片",
        "Joindre l’image du presse-papiers",
    ),
    translation(
        "Available context window",
        "利用可能なコンテキスト",
        "可用上下文窗口",
        "Fenêtre de contexte disponible",
    ),
    translation(
        "Cached input",
        "キャッシュ済み入力",
        "缓存输入",
        "Entrée en cache",
    ),
    translation(
        "Cached input share",
        "キャッシュ入力の割合",
        "缓存输入占比",
        "Part d’entrée en cache",
    ),
    translation(
        "Cache writes",
        "キャッシュ書き込み",
        "缓存写入",
        "Écritures en cache",
    ),
    translation(
        "Checkpoints",
        "チェックポイント",
        "检查点",
        "Points de contrôle",
    ),
    translation(
        "Copy last response",
        "最後の応答をコピー",
        "复制上一条回复",
        "Copier la dernière réponse",
    ),
    translation(
        "Cycle approval mode",
        "承認モードを切り替え",
        "切换批准模式",
        "Changer le mode d’approbation",
    ),
    translation("Disabled", "無効", "已禁用", "Désactivés"),
    translation("Enabled", "有効", "已启用", "Activés"),
    translation(
        "Full context window",
        "コンテキスト全体",
        "完整上下文窗口",
        "Fenêtre de contexte complète",
    ),
    translation(
        "Input tokens",
        "入力トークン",
        "输入令牌",
        "Jetons d’entrée",
    ),
    translation(
        "Interrupt or quit",
        "中断または終了",
        "中断或退出",
        "Interrompre ou quitter",
    ),
    translation("Manage", "管理", "管理", "Gérer"),
    translation(
        "No color themes available",
        "利用可能なカラーテーマはありません",
        "没有可用的颜色主题",
        "Aucun thème de couleur",
    ),
    translation(
        "No matching MCP servers",
        "一致する MCP サーバーがありません",
        "没有匹配的 MCP 服务器",
        "Aucun serveur MCP correspondant",
    ),
    translation(
        "No matching project folders",
        "一致するプロジェクトフォルダーがありません",
        "没有匹配的项目文件夹",
        "Aucun dossier de projet correspondant",
    ),
    translation(
        "No matching sessions",
        "一致するセッションがありません",
        "没有匹配的会话",
        "Aucune session correspondante",
    ),
    translation(
        "No matching skills",
        "一致するスキルがありません",
        "没有匹配的技能",
        "Aucune compétence correspondante",
    ),
    translation(
        "No message checkpoints available",
        "利用可能なメッセージチェックポイントはありません",
        "没有可用的消息检查点",
        "Aucun point de contrôle de message",
    ),
    translation(
        "Open rewind checkpoints",
        "巻き戻しチェックポイントを開く",
        "打开回退检查点",
        "Ouvrir les points de rembobinage",
    ),
    translation(
        "Output tokens",
        "出力トークン",
        "输出令牌",
        "Jetons de sortie",
    ),
    translation(
        "P to pin/unpin",
        "P で固定/解除",
        "按 P 固定/取消固定",
        "P pour épingler/désépingler",
    ),
    translation(
        "Reasoning output",
        "推論出力",
        "推理输出",
        "Sortie de raisonnement",
    ),
    translation(
        "Reference cost",
        "参考コスト",
        "参考成本",
        "Coût de référence",
    ),
    translation(
        "Remaining context window",
        "残りコンテキスト",
        "剩余上下文窗口",
        "Fenêtre de contexte restante",
    ),
    translation("Rewind", "巻き戻し", "回退", "Rembobiner"),
    translation(
        "Rewind escape gesture",
        "巻き戻しの Esc 操作",
        "回退退出手势",
        "Geste d’échappement du rembobinage",
    ),
    translation("Sessions", "セッション", "会话", "Sessions"),
    translation("Suspend Ash", "Ash を一時停止", "挂起 Ash", "Suspendre Ash"),
    translation("Themes", "テーマ", "主题", "Thèmes"),
    translation(
        "Automatic model",
        "自動モデル",
        "自动模型",
        "Modèle automatique",
    ),
    translation(
        "Build anything",
        "何でも作れます",
        "构建任何内容",
        "Créez ce que vous voulez",
    ),
    translation(
        "Provider name",
        "プロバイダー名",
        "提供商名称",
        "Nom du fournisseur",
    ),
    translation("Base URL", "ベース URL", "基础 URL", "URL de base"),
    translation("API key", "API キー", "API 密钥", "Clé API"),
    translation("Model ID", "モデル ID", "模型 ID", "ID du modèle"),
    translation("API type", "API タイプ", "API 类型", "Type d’API"),
    translation(
        "Model context window",
        "モデルのコンテキストウィンドウ",
        "模型上下文窗口",
        "Fenêtre de contexte du modèle",
    ),
    translation(
        "API key (optional)",
        "API キー（任意）",
        "API 密钥（可选）",
        "Clé API (facultative)",
    ),
    translation(
        "Key saved · Enter to replace",
        "キー保存済み · Enter で置換",
        "密钥已保存 · 按 Enter 替换",
        "Clé enregistrée · Entrée pour remplacer",
    ),
    translation(
        "Leave empty to use the selected built-in model",
        "選択中の組み込みモデルを使う場合は空欄",
        "留空以使用已选择的内置模型",
        "Laisser vide pour utiliser le modèle intégré sélectionné",
    ),
    translation(
        "Provider name must contain 1 to 80 characters",
        "プロバイダー名は 1〜80 文字で入力してください",
        "提供商名称必须包含 1 到 80 个字符",
        "Le nom du fournisseur doit contenir entre 1 et 80 caractères",
    ),
    translation(
        "Enter a valid model ID",
        "有効なモデル ID を入力してください",
        "请输入有效的模型 ID",
        "Saisissez un ID de modèle valide",
    ),
    translation(
        "Enter a valid HTTP or HTTPS base URL",
        "有効な HTTP または HTTPS のベース URL を入力してください",
        "请输入有效的 HTTP 或 HTTPS 基础 URL",
        "Saisissez une URL de base HTTP ou HTTPS valide",
    ),
    translation(
        "Use an HTTP or HTTPS URL without credentials, query or fragment",
        "認証情報、クエリ、フラグメントを含まない HTTP または HTTPS URL を使用してください",
        "请使用不含凭据、查询参数或片段的 HTTP 或 HTTPS URL",
        "Utilisez une URL HTTP ou HTTPS sans identifiants, requête ni fragment",
    ),
    translation(
        "The endpoint path does not match the selected API type",
        "エンドポイントのパスが選択した API タイプと一致しません",
        "端点路径与所选 API 类型不匹配",
        "Le chemin du point de terminaison ne correspond pas au type d’API sélectionné",
    ),
    translation(
        "Configuration changed elsewhere · Reopen this form before saving",
        "別の場所で設定が変更されました · 保存前にこのフォームを開き直してください",
        "配置已在其他位置更改 · 保存前请重新打开此表单",
        "La configuration a changé ailleurs · Rouvrez ce formulaire avant d’enregistrer",
    ),
    translation(
        "Sign-in cancelled",
        "サインインをキャンセルしました",
        "登录已取消",
        "Connexion annulée",
    ),
    translation(
        "Disconnected from ChatGPT in Ash",
        "Ash で ChatGPT から切断しました",
        "已在 Ash 中断开 ChatGPT 连接",
        "Déconnecté de ChatGPT dans Ash",
    ),
    translation(
        "Signed in to ChatGPT",
        "ChatGPT にサインインしました",
        "已登录 ChatGPT",
        "Connecté à ChatGPT",
    ),
    translation("Signed in", "サインイン済み", "已登录", "Connecté"),
    translation(
        "Sign in again",
        "再度サインイン",
        "重新登录",
        "Se reconnecter",
    ),
    translation("Account", "アカウント", "账户", "Compte"),
    translation(
        "Account not loaded",
        "アカウント未読み込み",
        "账户未加载",
        "Compte non chargé",
    ),
    translation(
        "Filter memories and actions",
        "メモリと操作を絞り込み",
        "筛选记忆和操作",
        "Filtrer les mémoires et les actions",
    ),
    translation(
        "Open memory reference",
        "メモリ参照を開く",
        "打开记忆引用",
        "Ouvrir une référence mémoire",
    ),
    translation(
        "Paste an exact memory: reference",
        "正確な memory: 参照を貼り付け",
        "粘贴准确的 memory: 引用",
        "Coller une référence memory: exacte",
    ),
    translation(
        "Save a preference or reusable decision",
        "設定または再利用可能な決定を保存",
        "保存偏好或可复用的决定",
        "Enregistrer une préférence ou une décision réutilisable",
    ),
    translation(
        "Search all memories in this scope",
        "このスコープ内の全メモリを検索",
        "搜索此范围内的所有记忆",
        "Rechercher toutes les mémoires de cette portée",
    ),
    translation(
        "Enable memory reading",
        "メモリ読み取りを有効化",
        "启用记忆读取",
        "Activer la lecture des mémoires",
    ),
    translation(
        "Disable memory reading",
        "メモリ読み取りを無効化",
        "禁用记忆读取",
        "Désactiver la lecture des mémoires",
    ),
    translation(
        "Controls automatic recall and model searches",
        "自動呼び出しとモデル検索を制御",
        "控制自动回忆和模型搜索",
        "Contrôle le rappel automatique et les recherches du modèle",
    ),
    translation(
        "Enable model saving",
        "モデルによる保存を有効化",
        "启用模型保存",
        "Activer l’enregistrement par le modèle",
    ),
    translation(
        "Disable model saving",
        "モデルによる保存を無効化",
        "禁用模型保存",
        "Désactiver l’enregistrement par le modèle",
    ),
    translation(
        "Save durable facts in this scope",
        "このスコープに永続的な情報を保存",
        "在此范围中保存持久信息",
        "Enregistrer des faits durables dans cette portée",
    ),
    translation("Next page", "次のページ", "下一页", "Page suivante"),
    translation(
        "Back to scopes",
        "スコープに戻る",
        "返回范围",
        "Retour aux portées",
    ),
    translation(
        "View full content",
        "全文を表示",
        "查看完整内容",
        "Afficher le contenu complet",
    ),
    translation(
        "Edit memory",
        "メモリを編集",
        "编辑记忆",
        "Modifier la mémoire",
    ),
    translation(
        "Delete memory",
        "メモリを削除",
        "删除记忆",
        "Supprimer la mémoire",
    ),
    translation(
        "Back to list",
        "一覧に戻る",
        "返回列表",
        "Retour à la liste",
    ),
    translation(
        "Delete this memory",
        "このメモリを削除",
        "删除此记忆",
        "Supprimer cette mémoire",
    ),
    translation(
        "Memory title",
        "メモリのタイトル",
        "记忆标题",
        "Titre de la mémoire",
    ),
    translation(
        "Memory content",
        "メモリの内容",
        "记忆内容",
        "Contenu de la mémoire",
    ),
    translation(
        "Search memories",
        "メモリを検索",
        "搜索记忆",
        "Rechercher les mémoires",
    ),
    translation(
        "This field takes one line.",
        "このフィールドは 1 行のみです。",
        "此字段只能输入一行。",
        "Ce champ n’accepte qu’une ligne.",
    ),
    translation(
        "Ctrl+S save · Ctrl+A clear · Esc cancel",
        "Ctrl+S 保存 · Ctrl+A 消去 · Esc キャンセル",
        "Ctrl+S 保存 · Ctrl+A 清空 · Esc 取消",
        "Ctrl+S enregistrer · Ctrl+A effacer · Échap annuler",
    ),
    translation("on", "オン", "开启", "activé"),
    translation("off", "オフ", "关闭", "désactivé"),
    translation("Reading", "読み取り", "读取", "Lecture"),
    translation(
        "Model saving",
        "モデルによる保存",
        "模型保存",
        "Enregistrement par le modèle",
    ),
    translation("Revision", "リビジョン", "修订", "Révision"),
    translation(
        "Editing takes user ownership",
        "編集するとユーザー所有になります",
        "编辑后将归用户所有",
        "La modification transfère la propriété à l’utilisateur",
    ),
    translation("UTF-8 bytes", "UTF-8 バイト", "UTF-8 字节", "octets UTF-8"),
    translation("characters", "文字", "字符", "caractères"),
    translation(
        "ask permissions on",
        "許可を確認",
        "请求权限",
        "demande d’autorisations",
    ),
    translation(
        "auto review on",
        "自動レビュー",
        "自动审阅",
        "révision automatique",
    ),
    translation(
        "bypass permissions on",
        "許可を省略",
        "绕过权限",
        "autorisations contournées",
    ),
    translation("current", "現在", "当前", "actuel"),
    translation(
        "search input history; Enter edits the match, Esc restores the draft",
        "入力履歴を検索；Enter で一致項目を編集し、Esc で下書きを復元",
        "搜索输入历史；Enter 编辑匹配项，Esc 恢复草稿",
        "rechercher dans l’historique ; Entrée modifie le résultat, Échap restaure le brouillon",
    ),
    translation(
        "open rewind checkpoints when the input is empty",
        "入力が空のとき巻き戻しチェックポイントを開く",
        "输入为空时打开回退检查点",
        "ouvrir les points de rembobinage lorsque la saisie est vide",
    ),
    translation(
        "navigate focused lists or read-only content; letters remain text in editors",
        "フォーカス中の一覧または読み取り専用内容を移動；エディターでは文字を入力",
        "浏览聚焦的列表或只读内容；在编辑器中按字母仍会输入文字",
        "parcourir les listes actives ou le contenu en lecture seule ; les lettres restent du texte dans les éditeurs",
    ),
    translation(
        "jump or page within the focused list or reading view",
        "フォーカス中の一覧または閲覧ビュー内で先頭・末尾やページを移動",
        "在聚焦的列表或阅读视图中跳转或翻页",
        "sauter ou changer de page dans la liste active ou la vue de lecture",
    ),
    translation(
        "focus search in a searchable panel; Enter or Esc returns to its list",
        "検索可能なパネルで検索にフォーカス；Enter または Esc で一覧に戻る",
        "在可搜索面板中聚焦搜索；Enter 或 Esc 返回列表",
        "activer la recherche dans un panneau ; Entrée ou Échap revient à la liste",
    ),
    translation(
        "switch panel tabs from tabs, lists or search",
        "タブ、一覧、検索からパネルのタブを切り替え",
        "从标签、列表或搜索中切换面板标签页",
        "changer d’onglet depuis les onglets, listes ou la recherche",
    ),
    translation(
        "return one interaction level; pending approval/query requires an explicit answer",
        "操作を 1 段階戻る；保留中の承認や質問には明示的な回答が必要",
        "返回上一层交互；待处理的批准或提问需要明确回答",
        "revenir d’un niveau ; une approbation ou question en attente exige une réponse explicite",
    ),
    translation("custom", "カスタム", "自定义", "personnalisé"),
    translation(
        "ask the Agent to create or inspect a pull request",
        "エージェントにプルリクエストの作成または確認を依頼",
        "让智能体创建或检查拉取请求",
        "demander à l’agent de créer ou d’examiner une pull request",
    ),
    translation(
        "select issues to develop together",
        "一緒に開発する Issue を選択",
        "选择要一起开发的议题",
        "sélectionner les tickets à développer ensemble",
    ),
    translation(
        "show the active session, thread, and model",
        "現在のセッション、スレッド、モデルを表示",
        "显示当前会话、线程和模型",
        "afficher la session, le fil et le modèle actifs",
    ),
    translation(
        "choose the items shown in the status line",
        "ステータスラインに表示する項目を選択",
        "选择状态栏中显示的项目",
        "choisir les éléments affichés dans la barre d’état",
    ),
    translation(
        "open Dashboard",
        "ダッシュボードを開く",
        "打开仪表盘",
        "ouvrir le tableau de bord",
    ),
    translation(
        "focus the current Session Thread list",
        "現在のセッションのスレッド一覧にフォーカス",
        "聚焦当前会话的线程列表",
        "activer la liste des fils de la session actuelle",
    ),
    translation(
        "manage memories, reading consent and model saving",
        "メモリ、読み取り同意、モデルによる保存を管理",
        "管理记忆、读取许可和模型保存",
        "gérer les mémoires, le consentement de lecture et l’enregistrement par le modèle",
    ),
    translation(
        "browse configured skill sources",
        "設定済みのスキルソースを参照",
        "浏览已配置的技能来源",
        "parcourir les sources de compétences configurées",
    ),
    translation(
        "list configured MCP tools",
        "設定済みの MCP ツールを一覧表示",
        "列出已配置的 MCP 工具",
        "lister les outils MCP configurés",
    ),
    translation(
        "show external service connections",
        "外部サービス接続を表示",
        "显示外部服务连接",
        "afficher les connexions aux services externes",
    ),
    translation(
        "list or resume a saved session",
        "保存済みセッションを一覧表示または再開",
        "列出或恢复已保存的会话",
        "lister ou reprendre une session enregistrée",
    ),
    translation(
        "archive the current session and start a new chat",
        "現在のセッションをアーカイブして新しいチャットを開始",
        "归档当前会话并开始新聊天",
        "archiver la session actuelle et démarrer une nouvelle discussion",
    ),
    translation(
        "return to an earlier message checkpoint",
        "以前のメッセージチェックポイントに戻る",
        "返回较早的消息检查点",
        "revenir à un point de contrôle antérieur",
    ),
    translation(
        "show the current configuration",
        "現在の設定を表示",
        "显示当前配置",
        "afficher la configuration actuelle",
    ),
    translation(
        "show the current startup context",
        "現在の起動コンテキストを表示",
        "显示当前启动上下文",
        "afficher le contexte de démarrage actuel",
    ),
    translation(
        "return to the home page",
        "ホームページに戻る",
        "返回主页",
        "revenir à l’accueil",
    ),
    translation(
        "add or manage a session directory",
        "セッションディレクトリを追加または管理",
        "添加或管理会话目录",
        "ajouter ou gérer un dossier de session",
    ),
    translation(
        "move this session to a new working directory",
        "このセッションを新しい作業ディレクトリへ移動",
        "将此会话移至新的工作目录",
        "déplacer cette session vers un nouveau dossier de travail",
    ),
    translation(
        "copy this conversation and switch to the new branch",
        "この会話をコピーして新しいブランチへ切り替え",
        "复制此对话并切换到新分支",
        "copier cette conversation et passer à la nouvelle branche",
    ),
    translation(
        "copy to an independent session; optionally run a prompt in the background",
        "独立したセッションにコピー；必要に応じてバックグラウンドでプロンプトを実行",
        "复制到独立会话；可选择在后台运行提示词",
        "copier vers une session indépendante ; exécuter éventuellement une demande en arrière-plan",
    ),
    translation(
        "show shortcuts and commands",
        "ショートカットとコマンドを表示",
        "显示快捷键和命令",
        "afficher les raccourcis et commandes",
    ),
    translation(
        "browse and customize terminal shortcuts",
        "ターミナルショートカットを参照・カスタマイズ",
        "浏览并自定义终端快捷键",
        "parcourir et personnaliser les raccourcis du terminal",
    ),
    translation(
        "export this conversation as Markdown",
        "この会話を Markdown としてエクスポート",
        "将此对话导出为 Markdown",
        "exporter cette conversation en Markdown",
    ),
    translation(
        "show or set the preferred provider/model",
        "優先プロバイダー／モデルを表示または設定",
        "显示或设置首选提供商/模型",
        "afficher ou définir le fournisseur/modèle préféré",
    ),
    translation(
        "show or set the terminal color theme",
        "ターミナルのカラーテーマを表示または設定",
        "显示或设置终端配色主题",
        "afficher ou définir le thème de couleurs du terminal",
    ),
    translation(
        "start a new chat",
        "新しいチャットを開始",
        "开始新聊天",
        "démarrer une nouvelle discussion",
    ),
    translation("quit Ash", "Ash を終了", "退出 Ash", "quitter Ash"),
];

pub(crate) fn localize<'a>(language: Language, source: &'a str) -> Cow<'a, str> {
    if language == Language::English {
        return Cow::Borrowed(source);
    }
    if let Some(value) = UI_TRANSLATIONS
        .iter()
        .find(|translation| translation.english == source)
    {
        return Cow::Borrowed(match language {
            Language::English => value.english,
            Language::Japanese => value.japanese,
            Language::Chinese => value.chinese,
            Language::French => value.french,
        });
    }
    if let Some((remaining, used)) = source.split_once("% left (")
        && let Some(used) = used.strip_suffix("% used)")
    {
        return Cow::Owned(match language {
            Language::English => source.to_owned(),
            Language::Japanese => format!("残り {remaining}%（使用済み {used}%）"),
            Language::Chinese => format!("剩余 {remaining}%（已用 {used}%）"),
            Language::French => format!("{remaining}% restants ({used}% utilisés)"),
        });
    }
    if let Some(duration) = source.strip_suffix(" window") {
        return Cow::Owned(match language {
            Language::English => source.to_owned(),
            Language::Japanese => format!("{duration} の期間"),
            Language::Chinese => format!("{duration} 额度"),
            Language::French => format!("Période de {duration}"),
        });
    }
    for prefix in ["All", "Connected", "Not connected", "Enabled", "Disabled"] {
        if let Some(count) = source
            .strip_prefix(prefix)
            .and_then(|suffix| suffix.strip_prefix(" ("))
            .and_then(|suffix| suffix.strip_suffix(')'))
        {
            return Cow::Owned(format!("{} ({count})", localize(language, prefix)));
        }
    }
    for (prefix, separator) in [
        ("connected as", " "),
        ("reconnect", " "),
        ("unavailable", ": "),
        ("Unavailable", ": "),
        ("Reading", ": "),
        ("Model saving", ": "),
    ] {
        if let Some(value) = source.strip_prefix(&format!("{prefix}{separator}")) {
            let value = if matches!(prefix, "Reading" | "Model saving") {
                localize(language, value)
            } else {
                Cow::Borrowed(value)
            };
            return Cow::Owned(format!("{}{separator}{value}", localize(language, prefix)));
        }
    }
    if let Some((label, condition)) = source.split_once(" when ") {
        let localized = localize(language, label);
        if &*localized != label {
            return Cow::Owned(format!("{localized} when {condition}"));
        }
    }
    if let Some(display_name) = source.strip_suffix(" API key") {
        return Cow::Owned(match language {
            Language::English => source.to_owned(),
            Language::Japanese => format!("{display_name} API キー"),
            Language::Chinese => format!("{display_name} API 密钥"),
            Language::French => format!("Clé API {display_name}"),
        });
    }
    if let Some(palette) = source.strip_prefix("Syntax palette: ") {
        return Cow::Owned(format!(
            "{}: {palette}",
            localize(language, "Syntax palette")
        ));
    }
    for (prefix, suffix, japanese, chinese, french) in [
        (
            "Discover Skills from this directory (",
            " found); requires Read files",
            "件）；ファイル読み取りが必要",
            " 个）；需要读取文件权限",
            " trouvées) ; exige la lecture des fichiers",
        ),
        (
            "Authorize MCP declarations (",
            " found); connect them separately",
            "件）を承認；接続は個別に行います",
            " 个）；请分别连接",
            " trouvées) ; les connecter séparément",
        ),
        (
            "Discover Hooks (",
            " found); running them also requires Run commands",
            "件）；実行にはコマンド実行も必要",
            " 个）；运行还需要运行命令权限",
            " trouvés) ; leur exécution exige aussi les commandes",
        ),
        (
            "Authorize Plugin requests (",
            " found); installation stays separate",
            "件）を承認；インストールは別に行います",
            " 个）；安装仍需单独进行",
            " trouvées) ; l’installation reste séparée",
        ),
    ] {
        if let Some(count) = source
            .strip_prefix(prefix)
            .and_then(|rest| rest.strip_suffix(suffix))
        {
            return Cow::Owned(match language {
                Language::English => source.to_owned(),
                Language::Japanese => format!(
                    "{}{count}{japanese}",
                    localize(language, prefix.trim_end_matches('(').trim_end())
                ),
                Language::Chinese => format!(
                    "{}{count}{chinese}",
                    localize(language, prefix.trim_end_matches('(').trim_end())
                ),
                Language::French => format!(
                    "{}{count}{french}",
                    localize(language, prefix.trim_end_matches('(').trim_end())
                ),
            });
        }
    }
    if let Some(revision) = source.strip_prefix("Revision ") {
        let revision = if let Some((number, suffix)) = revision.split_once(" · ") {
            format!("{number} · {}", localize(language, suffix))
        } else {
            revision.to_owned()
        };
        return Cow::Owned(format!("{} {revision}", localize(language, "Revision")));
    }
    if let Some(rest) = source.strip_prefix("This field is limited to ")
        && let Some((limit, unit)) = rest.strip_suffix('.').and_then(|rest| rest.split_once(' '))
    {
        let unit = localize(language, unit);
        return Cow::Owned(match language {
            Language::English => format!("This field is limited to {limit} {unit}."),
            Language::Japanese => format!("このフィールドは {limit} {unit}までです。"),
            Language::Chinese => format!("此字段最多可输入 {limit} {unit}。"),
            Language::French => format!("Ce champ est limité à {limit} {unit}."),
        });
    }
    for separator in ["  ·  ", " · "] {
        if source.contains(separator) {
            let parts = source.split(separator).collect::<Vec<_>>();
            let localized = parts
                .iter()
                .map(|part| localize(language, part))
                .collect::<Vec<_>>();
            if parts
                .iter()
                .zip(&localized)
                .any(|(part, localized)| *part != &**localized)
            {
                return Cow::Owned(
                    localized
                        .iter()
                        .map(|part| &**part)
                        .collect::<Vec<&str>>()
                        .join(separator),
                );
            }
        }
    }
    Cow::Borrowed(source)
}

pub(crate) fn localize_owned(language: Language, source: impl AsRef<str>) -> String {
    localize(language, source.as_ref()).into_owned()
}

#[cfg(test)]
#[path = "nls_tests.rs"]
mod tests;
