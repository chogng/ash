use crate::EngineOperation;
use crate::EngineRequest;
use crate::EngineResult;
use crate::PageRequest;
use crate::PdfAnnotation;
use crate::PdfAnnotationEdit;
use crate::PdfCharacter;
use crate::PdfPage;
use crate::PdfRect;
use ash_pdf_contract::PdfOutlineEntry;
use ash_pdf_contract::PdfOutlineTarget;
use image::ImageEncoder;
use image::codecs::png::PngEncoder;
use pdfium_render::prelude::*;
use sha2::Digest;
use sha2::Sha256;
use std::collections::HashSet;
use std::fs::File;
use std::io::BufRead;
use std::io::BufWriter;
use std::io::Write;
use std::path::Path;

const MAX_PAGE_IMAGE_BYTES: usize = 16 * 1024 * 1024;

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
    let document = pdfium
        .load_pdf_from_file(&first.source, None)
        .map_err(pdf_error)?;
    let sha256 = if let Some(digest) = &first.source_sha256 {
        if digest.len() != 64
            || !digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        {
            return Err("Invalid PDF source digest".into());
        }
        digest.clone()
    } else {
        let mut file = File::open(&first.source).map_err(|error| error.to_string())?;
        let mut hash = Sha256::new();
        std::io::copy(&mut file, &mut hash).map_err(|error| error.to_string())?;
        format!("{:x}", hash.finalize())
    };
    let file_size = metadata.len() as usize;
    let mut request = Some(first);
    while let Some(next) = request {
        let modified = next.operation.modifies_document();
        let result = match next.operation {
            EngineOperation::Page(page) => {
                execute(&document, page, &sha256, file_size).map(EngineResult::Page)
            }
            EngineOperation::Outline => Ok(EngineResult::Outline(read_outline(&document))),
        };
        let success = result.is_ok();
        let mut output = std::io::stdout().lock();
        serde_json::to_writer(&mut output, &result).map_err(|error| error.to_string())?;
        output.write_all(b"\n").map_err(|error| error.to_string())?;
        output.flush().map_err(|error| error.to_string())?;
        // After an edit, the service commits the file and releases this helper.
        if !success || modified {
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

fn read_outline(document: &PdfDocument<'_>) -> Vec<PdfOutlineEntry> {
    read_outline_level(
        document,
        document.bookmarks().root(),
        &mut HashSet::new(),
        0,
    )
}

fn read_outline_level<'a>(
    document: &PdfDocument<'_>,
    mut bookmark: Option<PdfBookmark<'a>>,
    seen: &mut HashSet<PdfBookmark<'a>>,
    depth: usize,
) -> Vec<PdfOutlineEntry> {
    // Bound traversal and the worker reply even if the file contains cycles or huge titles.
    const MAX_DEPTH: usize = 32;
    const MAX_BOOKMARKS: usize = 2048;
    let mut entries = Vec::new();
    while let Some(item) = bookmark {
        if depth == MAX_DEPTH || seen.len() == MAX_BOOKMARKS || !seen.insert(item.clone()) {
            break;
        }
        let children = read_outline_level(document, item.first_child(), seen, depth + 1);
        let title: String = item
            .title()
            .unwrap_or_default()
            .chars()
            .filter(|character| !character.is_control())
            .take(256)
            .collect();
        let title = title.trim();
        if title.is_empty() {
            entries.extend(children);
        } else {
            let target = item
                .destination()
                .and_then(|destination| outline_target(document, &destination))
                .or_else(|| {
                    let action = item.action()?;
                    let destination = action.as_local_destination_action()?.destination().ok()?;
                    outline_target(document, &destination)
                });
            if target.is_some() || !children.is_empty() {
                entries.push(PdfOutlineEntry {
                    title: title.into(),
                    target,
                    children,
                });
            }
        }
        bookmark = item.next_sibling();
    }
    entries
}

fn outline_target(
    document: &PdfDocument<'_>,
    destination: &PdfDestination<'_>,
) -> Option<PdfOutlineTarget> {
    let index = destination.page_index().ok()?;
    if !(0..document.pages().len()).contains(&index) {
        return None;
    }
    let top = destination
        .view_settings()
        .ok()
        .and_then(|settings| outline_top(document, index, settings));
    Some(PdfOutlineTarget {
        page: index as u32 + 1,
        top,
    })
}

fn outline_top(
    document: &PdfDocument<'_>,
    index: PdfPageIndex,
    settings: PdfDestinationViewSettings,
) -> Option<f32> {
    use PdfDestinationViewSettings::*;
    let (x, y, other_corner) = match settings {
        SpecificCoordinatesAndZoom(x, y, _) if x.is_some() || y.is_some() => (x, y, None),
        FitPageHorizontallyToWindow(Some(y)) | FitBoundsHorizontallyToWindow(Some(y)) => {
            (None, Some(y), None)
        }
        FitPageVerticallyToWindow(Some(x)) | FitBoundsVerticallyToWindow(Some(x)) => {
            (Some(x), None, None)
        }
        FitPageToRectangle(rect) => (
            Some(rect.left()),
            Some(rect.top()),
            Some((rect.right(), rect.bottom())),
        ),
        _ => return None,
    };
    // Match the page raster's coordinate system, including CropBox and rotation.
    let page = document.pages().get(index).ok()?;
    let width_points = page.width().value;
    let height_points = page.height().value;
    let scale = 2048.0 / width_points.max(height_points);
    let width = (width_points * scale).round().max(1.0) as i32;
    let height = (height_points * scale).round().max(1.0) as i32;
    let config = PdfRenderConfig::new().set_fixed_size(width, height);
    let (left, top) = page.pixels_to_points(0, 0, &config).ok()?;
    let pixel_y = |x: PdfPoints, y: PdfPoints| {
        if !x.value.is_finite() || !y.value.is_finite() {
            return None;
        }
        page.points_to_pixels(x, y, &config).ok().map(|(_, y)| y)
    };
    let y = pixel_y(x.unwrap_or(left), y.unwrap_or(top))?;
    let y = other_corner
        .and_then(|(x, y)| pixel_y(x, y))
        .map_or(y, |other| y.min(other));
    Some((y as f32 / height as f32).clamp(0.0, 1.0))
}

pub(super) fn execute(
    document: &PdfDocument<'_>,
    request: PageRequest,
    sha256: &str,
    file_size: usize,
) -> Result<PdfPage, String> {
    if request.page == 0
        || !(256..=2048).contains(&request.dimension)
        || request.edit.is_some() != request.modified.is_some()
    {
        return Err("Invalid PDF operation".into());
    }
    let page_index = i32::try_from(request.page - 1).map_err(|_| "Page is outside this PDF")?;
    let mut page = document.pages().get(page_index).map_err(pdf_error)?;
    let width_points = page.width().value;
    let height_points = page.height().value;
    let scale = request.dimension as f32 / width_points.max(height_points);
    let width = (width_points * scale).round().max(1.0) as i32;
    let height = (height_points * scale).round().max(1.0) as i32;
    let config = PdfRenderConfig::new()
        .set_fixed_size(width, height)
        .limit_render_image_cache_size(true)
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
            let path = request
                .modified
                .as_ref()
                .ok_or("Missing modified PDF path")?;
            let mut output = ArtifactWriter::new(path, crate::MAX_FILE_BYTES)?;
            crate::annotations::apply(
                &document.save_to_bytes().map_err(pdf_error)?,
                request.page,
                edit,
                &mut output,
            )?;
            let (file_size, sha256) = output.finish()?;
            let pdfium = Pdfium::default();
            let edited = pdfium.load_pdf_from_file(path, None).map_err(pdf_error)?;
            let request = PageRequest {
                edit: None,
                modified: None,
                ..request
            };
            return execute(&edited, request, &sha256, file_size);
        }
    }
    // Coordinate conversion uses exactly the same dimensions as the single raster pass.
    if let Some(edit) = &request.edit {
        apply_edit(&mut page, &config, width, height, edit)?;
    }
    let text = page.text().map_err(pdf_error)?;
    let include_geometry = matches!(request.output, crate::PdfOutput::Image);
    let mut all = String::new();
    let mut characters = Vec::new();
    for (index, character) in text.chars().iter().take(60_000).enumerate() {
        let Some(value) = character.unicode_char() else {
            continue;
        };
        all.push(value);
        if include_geometry
            && index < 20_000
            && let Ok(bounds) = character.tight_bounds()
            && let Ok(bounds) = displayed_rect(&page, &config, width, height, bounds)
        {
            characters.push(PdfCharacter {
                text: value.to_string(),
                bounds,
            });
        }
    }
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
    let (image_size, image_sha256) = if include_geometry {
        // BGRA has no row padding. PDFium's reversed byte order yields RGBA in
        // this buffer, which the encoder can borrow after the bitmap is released.
        let mut pixels = vec![0; width as usize * height as usize * 4];
        {
            let mut bitmap =
                PdfBitmap::from_bytes(width, height, PdfBitmapFormat::BGRA, &mut pixels)
                    .map_err(pdf_error)?;
            page.render_into_bitmap_with_config(&mut bitmap, &config.set_reverse_byte_order(true))
                .map_err(pdf_error)?;
        }
        let mut output = ArtifactWriter::new(&request.image, MAX_PAGE_IMAGE_BYTES)?;
        PngEncoder::new(&mut output)
            .write_image(
                &pixels,
                width as u32,
                height as u32,
                image::ExtendedColorType::Rgba8,
            )
            .map_err(|error| error.to_string())?;
        output.finish()?
    } else {
        (0, format!("{:x}", Sha256::digest([])))
    };
    let (file_size, sha256) = if let Some(path) = &request.modified {
        let mut output = ArtifactWriter::new(path, crate::MAX_FILE_BYTES)?;
        document.save_to_writer(&mut output).map_err(pdf_error)?;
        output.finish()?
    } else {
        (file_size, sha256.into())
    };
    let result = PdfPage {
        revision: 0,
        sha256,
        page_count: document.pages().len() as u32,
        page: request.page,
        width: width as u32,
        height: height as u32,
        width_points,
        height_points,
        text: all,
        text_truncated: text.len() > 60_000 || include_geometry && text.len() > 20_000,
        characters,
        annotations,
        annotations_truncated: page.annotations().len() > 2_000,
        image_size,
        image_sha256,
        file_size,
    };
    Ok(result)
}

/// Writes worker artifacts within their disk budget and hashes them as they are written.
struct ArtifactWriter {
    file: BufWriter<File>,
    hash: Sha256,
    size: usize,
    limit: usize,
}

impl ArtifactWriter {
    fn new(path: &Path, limit: usize) -> Result<Self, String> {
        Ok(Self {
            file: BufWriter::new(File::create(path).map_err(|error| error.to_string())?),
            hash: Sha256::new(),
            size: 0,
            limit,
        })
    }

    fn finish(mut self) -> Result<(usize, String), String> {
        self.flush().map_err(|error| error.to_string())?;
        Ok((self.size, format!("{:x}", self.hash.finalize())))
    }
}

impl Write for ArtifactWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > self.limit - self.size {
            return Err(std::io::Error::other("PDF artifact exceeds its size limit"));
        }
        let written = self.file.write(bytes)?;
        self.hash.update(&bytes[..written]);
        self.size += written;
        Ok(written)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.flush()
    }
}

fn displayed_rect(
    page: &pdfium_render::prelude::PdfPage<'_>,
    config: &PdfRenderConfig,
    width: i32,
    height: i32,
    rect: pdfium_render::prelude::PdfRect,
) -> Result<PdfRect, String> {
    // The page-to-bitmap transform only scales and rotates by right angles.
    // Opposite corners still enclose the rectangle after rotation.
    let (left, bottom) = page
        .points_to_pixels(rect.left(), rect.bottom(), config)
        .map_err(pdf_error)?;
    let (right, top) = page
        .points_to_pixels(rect.right(), rect.top(), config)
        .map_err(pdf_error)?;
    let width = width as f32;
    let height = height as f32;
    let x = left.min(right) as f32 / width;
    let y = bottom.min(top) as f32 / height;
    Ok(PdfRect {
        x,
        y,
        width: left.max(right) as f32 / width - x,
        height: bottom.max(top) as f32 / height - y,
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
