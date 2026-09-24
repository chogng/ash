use cosmic_text::{FontSystem, fontdb};

use super::platform;

pub(crate) fn new_font_system() -> FontSystem {
    let locale = sys_locale::get_locale().unwrap_or_else(|| String::from("en-US"));
    let mut database = fontdb::Database::new();
    database.load_system_fonts();
    platform::configure_font_database(&mut database);
    FontSystem::new_with_locale_and_db(locale, database)
}

#[cfg(test)]
#[path = "system_tests.rs"]
mod tests;
