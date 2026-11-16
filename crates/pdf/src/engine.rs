use crate::EngineRequest;
use crate::EngineResult;
use crate::PdfAnnotation;
use crate::PdfAnnotationEdit;
use crate::PdfCharacter;
use crate::PdfPage;
use crate::PdfRect;
use pdfium_render::prelude::*;
use sha2::Digest;
use sha2::Sha256;
use std::io::BufRead;
use std::io::Cursor;
use std::io::Write;

pub(super) fn library_path() -> Result<std::path::PathBuf, String> {
    let name = Pdfium::pdfium_platform_library_name();
    let context = ash_install_context::InstallContext::current();
    if let Some(path) = context.bundled_resource(std::path::Path::new("pdfium").join(&name)) {
        return Ok(path);
    }
    if context.package_layout().is_none() {
        if let Some(directory) = option_env!("ASH_PDFIUM_LIBRARY_DIR") {
            let path = std::path::Path::new(directory).join(name);
            if path.is_file() {
                return Ok(path);
            }
        }
    }
    Err("aspdf's bundled PDFium library is unavailable".into())
}

pub(super) fn serve() -> Result<(), String> {
    let mut input = std::io::BufReader::new(std::io::stdin());
    let first = read_request(&mut input)?.ok_or("Missing PDF operation")?;
    let pdfium = bind()?;
    let metadata = std::fs::metadata(&first.source).map_err(|error| error.to_string())?;
    if metadata.len() == 0 || metadata.len() > crate::MAX_FILE_BYTES as u64 {
        return Err("Invalid PDF size".into());
    }
    let mut document = pdfium
        .load_pdf_from_file(&first.source, None)
        .map_err(pdf_error)?;
    // Hash the source once, not once per page. The PDFium reader retains its own file.
    let mut file = std::fs::File::open(&first.source).map_err(|error| error.to_string())?;
    let mut hash = Sha256::new();
    std::io::copy(&mut file, &mut hash).map_err(|error| error.to_string())?;
    let mut sha256 = format!("{:x}", hash.finalize());
    let mut file_size = metadata.len() as usize;
    let mut request = Some(first);
    while let Some(operation) = request {
        let modified = operation.modified.clone();
        let result = execute(&document, operation, &sha256, file_size);
        let success = result.is_ok();
        if let Ok(result) = &result {
            sha256 = result.page.sha256.clone();
            file_size = result.page.file_size;
            if let Some(path) = modified {
                document = pdfium
                    .load_pdf_from_byte_vec(
                        std::fs::read(path).map_err(|error| error.to_string())?,
                        None,
                    )
                    .map_err(pdf_error)?;
            }
        }
        let mut output = std::io::stdout().lock();
        serde_json::to_writer(&mut output, &result).map_err(|error| error.to_string())?;
        output.write_all(b"\n").map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
        if !success {
            break;
        }
        request = read_request(&mut input)?;
    }
    Ok(())
}

fn read_request(input: &mut impl BufRead) -> Result<Option<EngineRequest>, String> {
    use std::io::Read;
    let mut bytes = Vec::new();
    input
        .take(64 * 1024)
        .read_until(b'\n', &mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() {
        return Ok(None);
    }
    if bytes.last() != Some(&b'\n') {
        return Err("PDF operation exceeds input budget".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| error.to_string())
}

pub(super) fn bind() -> Result<Pdfium, String> {
    match Pdfium::bind_to_library(library_path()?) {
        Ok(bindings) => Ok(Pdfium::new(bindings)),
        // Serialized unit tests share the process-global binding.
        Err(PdfiumError::PdfiumLibraryBindingsAlreadyInitialized) => Ok(Pdfium::default()),
        Err(error) => Err(pdf_error(error)),
    }
}

pub(super) fn execute(
    document: &PdfDocument<'_>,
    request: EngineRequest,
    sha256: &str,
    file_size: usize,
) -> Result<EngineResult, String> {
    if request.page == 0
        || !(256..=2048).contains(&request.dimension)
        || request.edit.is_some() != request.modified.is_some()
    {
        return Err("Invalid PDF operation".into());
    }
    let page_index = i32::try_from(request.page - 1).map_err(|_| "Page is outside this PDF")?;
    let mut page = document.pages().get(page_index).map_err(pdf_error)?;
    let scale = request.dimension as f32 / page.width().value.max(page.height().value);
    let width = (page.width().value * scale).round().max(1.0) as i32;
    let height = (page.height().value * scale).round().max(1.0) as i32;
    let config = PdfRenderConfig::new()
        .set_fixed_size(width, height)
        .render_annotations(true);
    if let Some(edit) = &request.edit {
        let rotation = match page.rotation().map_err(pdf_error)? {
            PdfPageRenderRotation::None => 0,
            PdfPageRenderRotation::Degrees90 => 90,
            PdfPageRenderRotation::Degrees180 => 180,
            PdfPageRenderRotation::Degrees270 => 270,
        };
        let extended = match edit {
            PdfAnnotationEdit::Ink { points } => {
                if !(2..=1024).contains(&points.len())
                    || points.iter().any(|point| {
                        !point.x.is_finite()
                            || !point.y.is_finite()
                            || !(0.0..=1.0).contains(&point.x)
                            || !(0.0..=1.0).contains(&point.y)
                    })
                {
                    return Err("Invalid ink stroke".into());
                }
                let points = points
                    .iter()
                    .map(|point| {
                        page.pixels_to_points(
                            (point.x * width as f32).round() as i32,
                            (point.y * height as f32).round() as i32,
                            &config,
                        )
                        .map(|(x, y)| (x.value, y.value))
                        .map_err(pdf_error)
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                Some(crate::annotations::Edit::Ink { points })
            }
            PdfAnnotationEdit::Text { bounds, contents } => {
                validate_contents(contents)?;
                let rect = annotation_rect(&page, &config, width, height, bounds)?;
                Some(crate::annotations::Edit::Text {
                    rect: [
                        rect.left().value,
                        rect.bottom().value,
                        rect.right().value,
                        rect.top().value,
                    ],
                    contents,
                    rotation,
                })
            }
            PdfAnnotationEdit::Update { index, contents }
                if page
                    .annotations()
                    .get(*index as usize)
                    .map_err(pdf_error)?
                    .annotation_type()
                    == PdfPageAnnotationType::FreeText =>
            {
                validate_contents(contents)?;
                Some(crate::annotations::Edit::UpdateText {
                    index: *index as usize,
                    contents,
                    rotation,
                })
            }
            PdfAnnotationEdit::Update { .. }
            | PdfAnnotationEdit::Delete { .. }
            | PdfAnnotationEdit::Highlight { .. }
            | PdfAnnotationEdit::Note { .. } => None,
        };
        if let Some(edit) = extended {
            let bytes = crate::annotations::apply(
                &document.save_to_bytes().map_err(pdf_error)?,
                request.page,
                edit,
            )?;
            if bytes.len() > crate::MAX_FILE_BYTES {
                return Err("Modified PDF exceeds the file budget".into());
            }
            std::fs::write(
                request
                    .modified
                    .as_ref()
                    .ok_or("Missing modified PDF path")?,
                &bytes,
            )
            .map_err(|error| error.to_string())?;
            let pdfium = Pdfium::default();
            let edited = pdfium
                .load_pdf_from_byte_vec(bytes.clone(), None)
                .map_err(pdf_error)?;
            let request = EngineRequest {
                edit: None,
                modified: None,
                ..request
            };
            return execute(
                &edited,
                request,
                &format!("{:x}", Sha256::digest(&bytes)),
                bytes.len(),
            );
        }
    }
    // Coordinate conversion uses exactly the same dimensions as the single raster pass.
    if let Some(edit) = &request.edit {
        apply_edit(&mut page, &config, width, height, edit)?;
    }
    let text = page.text().map_err(pdf_error)?;
    let all: String = text
        .chars()
        .iter()
        .take(60_000)
        .filter_map(|character| character.unicode_string())
        .collect();
    let characters = if matches!(request.output, crate::PdfOutput::Image) {
        text.chars()
            .iter()
            .take(20_000)
            .filter_map(|character| {
                let text = character.unicode_string()?;
                let bounds = character.tight_bounds().ok()?;
                Some(PdfCharacter {
                    text,
                    bounds: displayed_rect(&page, &config, width, height, bounds).ok()?,
                })
            })
            .collect()
    } else {
        Vec::new()
    };
    let annotations = page
        .annotations()
        .iter()
        .take(2_000)
        .enumerate()
        .map(|(index, annotation)| {
            Ok(PdfAnnotation {
                index: index as u32,
                kind: format!("{:?}", annotation.annotation_type()),
                contents: annotation
                    .contents()
                    .unwrap_or_default()
                    .chars()
                    .take(8192)
                    .collect(),
                author: annotation
                    .creator()
                    .unwrap_or_default()
                    .chars()
                    .take(512)
                    .collect(),
                bounds: displayed_rect(
                    &page,
                    &config,
                    width,
                    height,
                    annotation.bounds().map_err(pdf_error)?,
                )?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let image = if matches!(request.output, crate::PdfOutput::Image) {
        let image = page
            .render_with_config(&config)
            .map_err(pdf_error)?
            .as_image()
            .map_err(pdf_error)?;
        let mut png = Cursor::new(Vec::new());
        image
            .write_to(&mut png, image::ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        png.into_inner()
    } else {
        Vec::new()
    };
    if image.len() > 16 * 1024 * 1024 {
        return Err("Rendered page exceeds the image budget".into());
    }
    if !image.is_empty() {
        std::fs::write(&request.image, &image).map_err(|error| error.to_string())?;
    }
    let modified = if let Some(path) = &request.modified {
        let bytes = document.save_to_bytes().map_err(pdf_error)?;
        if bytes.len() > crate::MAX_FILE_BYTES {
            return Err("Modified PDF exceeds the file budget".into());
        }
        std::fs::write(path, &bytes).map_err(|error| error.to_string())?;
        Some((format!("{:x}", Sha256::digest(&bytes)), bytes.len()))
    } else {
        None
    };
    let (sha256, file_size) = modified.unwrap_or_else(|| (sha256.into(), file_size));
    let result = PdfPage {
        revision: 0,
        sha256,
        page_count: document.pages().len() as u32,
        page: request.page,
        width: width as u32,
        height: height as u32,
        width_points: page.width().value,
        height_points: page.height().value,
        text: all.chars().take(60_000).collect(),
        text_truncated: text.len() > 60_000
            || matches!(request.output, crate::PdfOutput::Image) && text.len() > 20_000,
        characters,
        annotations,
        annotations_truncated: page.annotations().len() > 2_000,
        image_size: image.len(),
        image_sha256: format!("{:x}", Sha256::digest(&image)),
        file_size,
    };
    Ok(EngineResult { page: result })
}

fn displayed_rect(
    page: &pdfium_render::prelude::PdfPage<'_>,
    config: &PdfRenderConfig,
    width: i32,
    height: i32,
    rect: pdfium_render::prelude::PdfRect,
) -> Result<PdfRect, String> {
    let points = [
        (rect.left(), rect.bottom()),
        (rect.left(), rect.top()),
        (rect.right(), rect.bottom()),
        (rect.right(), rect.top()),
    ];
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for (x, y) in points {
        let (x, y) = page.points_to_pixels(x, y, config).map_err(pdf_error)?;
        xs.push(x as f32 / width as f32);
        ys.push(y as f32 / height as f32);
    }
    let x = xs.iter().copied().fold(f32::INFINITY, f32::min);
    let y = ys.iter().copied().fold(f32::INFINITY, f32::min);
    Ok(PdfRect {
        x,
        y,
        width: xs.into_iter().fold(f32::NEG_INFINITY, f32::max) - x,
        height: ys.into_iter().fold(f32::NEG_INFINITY, f32::max) - y,
    })
}

fn apply_edit(
    page: &mut pdfium_render::prelude::PdfPage<'_>,
    config: &PdfRenderConfig,
    width: i32,
    height: i32,
    edit: &PdfAnnotationEdit,
) -> Result<(), String> {
    match edit {
        PdfAnnotationEdit::Highlight { bounds, contents }
        | PdfAnnotationEdit::Note { bounds, contents } => {
            validate_contents(contents)?;
            let rect = annotation_rect(page, config, width, height, bounds)?;
            match edit {
                PdfAnnotationEdit::Highlight { .. } => {
                    let mut annotation = page
                        .annotations_mut()
                        .create_highlight_annotation()
                        .map_err(pdf_error)?;
                    annotation.set_bounds(rect).map_err(pdf_error)?;
                    annotation
                        .attachment_points_mut()
                        .create_attachment_point_at_end(PdfQuadPoints::from_rect(&rect))
                        .map_err(pdf_error)?;
                    annotation
                        .set_stroke_color(PdfColor::new(255, 210, 40, 128))
                        .map_err(pdf_error)?;
                    annotation.set_contents(contents).map_err(pdf_error)?;
                    annotation.set_creator("aspdf").map_err(pdf_error)?;
                }
                PdfAnnotationEdit::Note { .. } => {
                    let mut annotation = page
                        .annotations_mut()
                        .create_text_annotation(contents)
                        .map_err(pdf_error)?;
                    annotation.set_bounds(rect).map_err(pdf_error)?;
                    annotation.set_creator("aspdf").map_err(pdf_error)?;
                }
                PdfAnnotationEdit::Text { .. }
                | PdfAnnotationEdit::Ink { .. }
                | PdfAnnotationEdit::Update { .. }
                | PdfAnnotationEdit::Delete { .. } => {
                    unreachable!()
                }
            }
        }
        PdfAnnotationEdit::Ink { .. } | PdfAnnotationEdit::Text { .. } => {
            unreachable!("Dictionary edits are applied before rendering")
        }
        PdfAnnotationEdit::Update { index, contents } => {
            validate_contents(contents)?;
            page.annotations()
                .get(*index as usize)
                .map_err(pdf_error)?
                .set_contents(contents)
                .map_err(pdf_error)?;
        }
        PdfAnnotationEdit::Delete { index } => {
            let annotations = page.annotations_mut();
            let annotation = annotations.get(*index as usize).map_err(pdf_error)?;
            annotations
                .delete_annotation(annotation)
                .map_err(pdf_error)?;
        }
    }
    Ok(())
}

fn validate_contents(contents: &str) -> Result<(), String> {
    if contents.len() > 8192 || contents.contains('\0') {
        return Err("Invalid annotation contents".into());
    }
    Ok(())
}

fn pdf_error(error: PdfiumError) -> String {
    error.to_string()
}

fn annotation_rect(
    page: &pdfium_render::prelude::PdfPage<'_>,
    config: &PdfRenderConfig,
    width: i32,
    height: i32,
    bounds: &PdfRect,
) -> Result<pdfium_render::prelude::PdfRect, String> {
    if ![bounds.x, bounds.y, bounds.width, bounds.height]
        .into_iter()
        .all(f32::is_finite)
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width <= 0.0
        || bounds.height <= 0.0
        || bounds.x + bounds.width > 1.001
        || bounds.y + bounds.height > 1.001
    {
        return Err("Annotation bounds must be inside the page".into());
    }
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for (x, y) in [
        (bounds.x, bounds.y),
        (bounds.x + bounds.width, bounds.y),
        (bounds.x, bounds.y + bounds.height),
        (bounds.x + bounds.width, bounds.y + bounds.height),
    ] {
        let (x, y) = page
            .pixels_to_points(
                (x * width as f32).round() as i32,
                (y * height as f32).round() as i32,
                config,
            )
            .map_err(pdf_error)?;
        xs.push(x.value);
        ys.push(y.value);
    }
    let rect = pdfium_render::prelude::PdfRect::new_from_values(
        ys.iter().copied().fold(f32::INFINITY, f32::min),
        xs.iter().copied().fold(f32::INFINITY, f32::min),
        ys.into_iter().fold(f32::NEG_INFINITY, f32::max),
        xs.into_iter().fold(f32::NEG_INFINITY, f32::max),
    );
    Ok(rect)
}
