//! CLI copy uses the terminal locale without loading a product profile during help or launch.

#[derive(Clone, Copy)]
pub(crate) enum Message {
    AppAbout,
    Workspace,
    AppPath,
    InvalidWorkspace,
    InvalidApp,
    AppMissing,
    LaunchFailed,
}

pub(crate) fn text(message: Message) -> &'static str {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    localized(message, &locale)
}

pub(crate) fn format(message: Message, argument: impl AsRef<str>) -> String {
    text(message).replacen("{0}", argument.as_ref(), 1)
}

fn localized(message: Message, locale: &str) -> &'static str {
    let language = locale.split(['-', '_', '.']).next().unwrap_or_default();
    match (message, language) {
        (Message::AppAbout, "zh") => "打开 Ash 桌面应用及指定工作区。",
        (Message::Workspace, "zh") => "要打开的目录、文件或工作区文件。",
        (Message::AppPath, "zh") => "Ash 桌面可执行文件或 macOS .app 的路径。",
        (Message::InvalidWorkspace, "zh") => "无法打开工作区路径：{0}",
        (Message::InvalidApp, "zh") => "无效的 Ash 桌面应用路径：{0}",
        (Message::AppMissing, "zh") => {
            "未找到 Ash 桌面应用。请安装 Ash，或使用 --app-path 指定应用路径。"
        }
        (Message::LaunchFailed, "zh") => "无法启动 Ash 桌面应用：{0}",
        (Message::AppAbout, "ja") => "Ash デスクトップアプリで指定したワークスペースを開きます。",
        (Message::Workspace, "ja") => "開くフォルダー、ファイル、またはワークスペースファイル。",
        (Message::AppPath, "ja") => "Ash デスクトップ実行ファイルまたは macOS .app のパス。",
        (Message::InvalidWorkspace, "ja") => "ワークスペースのパスを開けません：{0}",
        (Message::InvalidApp, "ja") => "Ash デスクトップアプリのパスが無効です：{0}",
        (Message::AppMissing, "ja") => {
            "Ash デスクトップアプリが見つかりません。Ash をインストールするか、--app-path で指定してください。"
        }
        (Message::LaunchFailed, "ja") => "Ash デスクトップアプリを起動できません：{0}",
        (Message::AppAbout, "fr") => {
            "Ouvrir l’application de bureau Ash et l’espace de travail indiqué."
        }
        (Message::Workspace, "fr") => "Dossier, fichier ou fichier d’espace de travail à ouvrir.",
        (Message::AppPath, "fr") => "Chemin de l’exécutable de bureau Ash ou du .app macOS.",
        (Message::InvalidWorkspace, "fr") => {
            "Impossible d’ouvrir le chemin de l’espace de travail : {0}"
        }
        (Message::InvalidApp, "fr") => "Chemin de l’application de bureau Ash non valide : {0}",
        (Message::AppMissing, "fr") => {
            "Application de bureau Ash introuvable. Installez Ash ou indiquez son chemin avec --app-path."
        }
        (Message::LaunchFailed, "fr") => "Impossible de lancer l’application de bureau Ash : {0}",
        (Message::AppAbout, _) => "Open the Ash desktop app and the selected workspace.",
        (Message::Workspace, _) => "Folder, file, or workspace file to open.",
        (Message::AppPath, _) => "Path to the Ash desktop executable or macOS .app bundle.",
        (Message::InvalidWorkspace, _) => "Could not open workspace path: {0}",
        (Message::InvalidApp, _) => "Invalid Ash desktop app path: {0}",
        (Message::AppMissing, _) => {
            "Ash desktop app was not found. Install Ash or select its path with --app-path."
        }
        (Message::LaunchFailed, _) => "Could not launch the Ash desktop app: {0}",
    }
}
