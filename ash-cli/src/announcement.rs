use ash_product_update::AnnouncementContext;
use ash_product_update::AnnouncementDocument;
use ash_product_update::UpdateProduct;
use chrono::Utc;
use semver::Version;

const ENDPOINT: &str = "https://raw.githubusercontent.com/chogng/ash/main/announcement_tip.toml";

pub(super) fn start() -> Result<ash_tui::TuiAnnouncement, String> {
    let source = ash_tui::TuiAnnouncement::default();
    let endpoint = match std::env::var("ASH_ANNOUNCEMENT_URL") {
        Ok(endpoint) => endpoint,
        Err(std::env::VarError::NotPresent) => ENDPOINT.into(),
        Err(std::env::VarError::NotUnicode(_)) => return Ok(source),
    };
    if endpoint.is_empty() {
        return Ok(source);
    }
    let published = source.clone();
    // The client host owns this one-shot request; reconnects reuse its published value.
    // An unavailable feed contributes no announcement and never blocks the terminal.
    std::thread::Builder::new()
        .name("ash-announcement".into())
        .spawn(move || {
            let Ok(document) = AnnouncementDocument::fetch(&endpoint) else {
                return;
            };
            let version = Version::parse(build_info::VERSION).expect("build version is semantic");
            if let Some(announcement) = document.select(&AnnouncementContext {
                product: UpdateProduct::AshCode,
                version: &version,
                os: std::env::consts::OS,
                date: Utc::now().date_naive(),
            }) {
                published.publish(announcement);
            }
        })
        .map_err(|error| error.to_string())?;
    Ok(source)
}
