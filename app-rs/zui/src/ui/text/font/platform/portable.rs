use crate::ui::text::FontCatalogError;

pub(crate) fn configure_font_database(database: &mut cosmic_text::fontdb::Database) {
    #[cfg(target_os = "windows")]
    {
        database.set_sans_serif_family("Segoe UI");
        database.set_monospace_family("Consolas");
    }

    #[cfg(not(target_os = "windows"))]
    let _ = database;
}

pub(crate) fn system_family_names() -> Result<Vec<String>, FontCatalogError> {
    let font_system = cosmic_text::FontSystem::new();
    Ok(font_system
        .db()
        .faces()
        .flat_map(|face| face.families.iter().map(|family| family.0.clone()))
        .collect())
}
