use crate::ui::text::FontCatalogError;

pub(crate) fn configure_font_database(database: &mut cosmic_text::fontdb::Database) {
    database.set_sans_serif_family(".SF NS");
    database.set_monospace_family(".SF NS Mono");

    let unsupported_faces = database
        .faces()
        .filter(|face| face.post_script_name == "GB18030Bitmap")
        .map(|face| face.id)
        .collect::<Vec<_>>();
    for face_id in unsupported_faces {
        database.remove_face(face_id);
    }
}

pub(crate) fn system_family_names() -> Result<Vec<String>, FontCatalogError> {
    let font_system = cosmic_text::FontSystem::new();
    Ok(font_system
        .db()
        .faces()
        .flat_map(|face| face.families.iter().map(|family| family.0.clone()))
        .collect())
}
