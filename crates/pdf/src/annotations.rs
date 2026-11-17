//! Standard annotation dictionaries and appearance streams for editable ink and text.

use lopdf::Document;
use lopdf::Object;
use lopdf::Stream;
use lopdf::StringFormat;
use lopdf::dictionary;

pub(super) enum Edit<'a> {
    Ink {
        points: Vec<(f32, f32)>,
    },
    Text {
        rect: [f32; 4],
        contents: &'a str,
        rotation: i32,
    },
    UpdateText {
        index: usize,
        contents: &'a str,
        rotation: i32,
    },
}

pub(super) fn apply(
    bytes: &[u8],
    page: u32,
    edit: Edit<'_>,
    output: &mut impl std::io::Write,
) -> Result<(), String> {
    let mut document = Document::load_mem(bytes).map_err(|error| error.to_string())?;
    let page_id = *document
        .get_pages()
        .get(&page)
        .ok_or("Page is outside this PDF")?;
    let page_dictionary = document
        .get_dictionary(page_id)
        .map_err(|error| error.to_string())?;
    let mut annotations = match page_dictionary.get(b"Annots") {
        Ok(value) => document
            .dereference(value)
            .map_err(|error| error.to_string())?
            .1
            .as_array()
            .map_err(|error| error.to_string())?
            .clone(),
        Err(_) => Vec::new(),
    };
    let mut annotation =
        dictionary! { "Type" => "Annot", "T" => Object::string_literal("aspdf"), "F" => 4 };
    match edit {
        Edit::Ink { points } => {
            let left = points.iter().map(|p| p.0).fold(f32::INFINITY, f32::min) - 2.0;
            let bottom = points.iter().map(|p| p.1).fold(f32::INFINITY, f32::min) - 2.0;
            let right = points.iter().map(|p| p.0).fold(f32::NEG_INFINITY, f32::max) + 2.0;
            let top = points.iter().map(|p| p.1).fold(f32::NEG_INFINITY, f32::max) + 2.0;
            let mut appearance = "0.14 0.35 0.82 RG 2 w 1 J 1 j\n".to_owned();
            for (index, (x, y)) in points.iter().enumerate() {
                appearance.push_str(&format!(
                    "{} {} {}\n",
                    x - left,
                    y - bottom,
                    if index == 0 { "m" } else { "l" }
                ));
            }
            appearance.push_str("S\n");
            let appearance = document.add_object(Stream::new(dictionary! {
                "Type" => "XObject", "Subtype" => "Form", "BBox" => numbers(&[0.0, 0.0, right - left, top - bottom]),
            }, appearance.into_bytes()));
            annotation.set("Subtype", "Ink");
            annotation.set("Rect", numbers(&[left, bottom, right, top]));
            annotation.set("C", numbers(&[0.14, 0.35, 0.82]));
            annotation.set("BS", dictionary! { "W" => 2, "S" => "S" });
            annotation.set(
                "InkList",
                vec![Object::Array(
                    points
                        .into_iter()
                        .flat_map(|(x, y)| [Object::Real(x), Object::Real(y)])
                        .collect(),
                )],
            );
            annotation.set("AP", dictionary! { "N" => appearance });
        }
        Edit::Text {
            rect,
            contents,
            rotation,
        } => {
            annotation.set("Subtype", "FreeText");
            annotation.set("Rect", numbers(&rect));
            set_text(&mut document, &mut annotation, rect, contents, rotation);
        }
        Edit::UpdateText {
            index,
            contents,
            rotation,
        } => {
            let value = annotations
                .get(index)
                .ok_or("Annotation is outside this page")?;
            let (id, object) = document
                .dereference(value)
                .map_err(|error| error.to_string())?;
            annotation = object.as_dict().map_err(|error| error.to_string())?.clone();
            let rect = annotation
                .get(b"Rect")
                .and_then(Object::as_array)
                .map_err(|error| error.to_string())?;
            if rect.len() != 4 {
                return Err("Invalid annotation bounds".into());
            }
            let mut coordinates = [0.0; 4];
            for (target, value) in coordinates.iter_mut().zip(rect) {
                *target = value.as_float().map_err(|error| error.to_string())?;
            }
            set_text(
                &mut document,
                &mut annotation,
                coordinates,
                contents,
                rotation,
            );
            if let Some(id) = id {
                document.objects.insert(id, Object::Dictionary(annotation));
            } else {
                annotations[index] = Object::Dictionary(annotation);
            }
            document
                .get_dictionary_mut(page_id)
                .map_err(|error| error.to_string())?
                .set("Annots", annotations);
            return document
                .save_to(output)
                .map(|_| ())
                .map_err(|error| error.to_string());
        }
    }
    let annotation = document.add_object(annotation);
    annotations.push(annotation.into());
    document
        .get_dictionary_mut(page_id)
        .map_err(|error| error.to_string())?
        .set("Annots", annotations);
    document
        .save_to(output)
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn numbers(values: &[f32]) -> Vec<Object> {
    values.iter().copied().map(Object::Real).collect()
}

fn set_text(
    document: &mut Document,
    annotation: &mut lopdf::Dictionary,
    rect: [f32; 4],
    contents: &str,
    rotation: i32,
) {
    let native_width = rect[2] - rect[0];
    let native_height = rect[3] - rect[1];
    let (width, height) = if rotation == 90 || rotation == 270 {
        (native_height, native_width)
    } else {
        (native_width, native_height)
    };
    let latin = document.add_object(
        dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica" },
    );
    let mut fonts = dictionary! { "F0" => latin };
    if !contents.is_ascii() {
        // The standard CJK font uses Unicode code points and PDFium's bundled font fallback.
        let descendant = document.add_object(dictionary! {
            "Type" => "Font", "Subtype" => "CIDFontType0", "BaseFont" => "STSong-Light",
            "CIDSystemInfo" => dictionary! { "Registry" => Object::string_literal("Adobe"), "Ordering" => Object::string_literal("GB1"), "Supplement" => 4 },
        });
        let cjk = document.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type0", "BaseFont" => "STSong-Light", "Encoding" => "UniGB-UCS2-H", "DescendantFonts" => vec![Object::Reference(descendant)] });
        fonts.set("F1", cjk);
    }
    let mut appearance = format!(
        "q 0 0 {width} {height} re W n BT /F0 12 Tf 0 g 14 TL 1 0 0 1 2 {} Tm\n",
        height - 14.0
    );
    // Explicit appearances keep text visible after save/reopen in readers that do not synthesize them.
    let mut lines = vec![String::new()];
    let mut line_width = 0.0;
    for character in contents.chars().filter(|character| *character != '\r') {
        let advance = if character.is_ascii() { 7.2 } else { 12.0 };
        if character == '\n' || line_width + advance > (width - 4.0).max(12.0) {
            lines.push(String::new());
            line_width = 0.0;
        }
        if character != '\n' {
            lines
                .last_mut()
                .expect("A text line always exists")
                .push(character);
            line_width += advance;
        }
    }
    for line in lines {
        let mut run = String::new();
        let mut ascii = true;
        for character in line.chars() {
            if character.is_ascii() != ascii {
                append_text_run(&mut appearance, &run, ascii);
                run.clear();
                ascii = character.is_ascii();
            }
            run.push(character);
        }
        append_text_run(&mut appearance, &run, ascii);
        appearance.push_str("T*\n");
    }
    appearance.push_str("ET Q\n");
    let matrix = match rotation {
        90 => [0.0, 1.0, -1.0, 0.0, height, 0.0],
        180 => [-1.0, 0.0, 0.0, -1.0, width, height],
        270 => [0.0, -1.0, 1.0, 0.0, 0.0, width],
        _ => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
    };
    let appearance = document.add_object(Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Form", "BBox" => numbers(&[0.0, 0.0, width, height]),
            "Matrix" => numbers(&matrix), "Resources" => dictionary! { "Font" => fonts },
        },
        appearance.into_bytes(),
    ));
    let encoded = std::iter::once(0xFEFF)
        .chain(contents.encode_utf16())
        .flat_map(u16::to_be_bytes)
        .collect();
    annotation.set(
        "Contents",
        Object::String(encoded, StringFormat::Hexadecimal),
    );
    annotation.set("DA", Object::string_literal("/F0 12 Tf 0 g"));
    annotation.set("AP", dictionary! { "N" => appearance });
}

fn append_text_run(appearance: &mut String, text: &str, ascii: bool) {
    if text.is_empty() {
        return;
    }
    let encoded: Vec<u8> = if ascii {
        text.as_bytes().to_vec()
    } else {
        text.encode_utf16().flat_map(u16::to_be_bytes).collect()
    };
    let hex: String = encoded.iter().map(|byte| format!("{byte:02X}")).collect();
    let font = if ascii { "F0" } else { "F1" };
    appearance.push_str(&format!("/{font} 12 Tf <{hex}> Tj\n"));
}
