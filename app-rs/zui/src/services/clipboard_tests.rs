use super::Clipboard;
use super::ClipboardError;
use super::ClipboardHandle;
use super::ClipboardHtml;
use super::ClipboardImage;

#[derive(Default)]
struct MemoryClipboard {
    text: String,
    html: Option<ClipboardHtml>,
    image: Option<ClipboardImage>,
}

impl Clipboard for MemoryClipboard {
    fn write_text(&mut self, text: String) -> Result<(), ClipboardError> {
        self.text = text;
        Ok(())
    }

    fn read_text(&mut self) -> Result<String, ClipboardError> {
        Ok(self.text.clone())
    }

    fn write_html(&mut self, content: ClipboardHtml) -> Result<(), ClipboardError> {
        self.html = Some(content);
        Ok(())
    }

    fn read_html(&mut self) -> Result<String, ClipboardError> {
        self.html
            .as_ref()
            .map(|content| content.html().to_owned())
            .ok_or(ClipboardError::Unsupported)
    }

    fn write_image(&mut self, image: ClipboardImage) -> Result<(), ClipboardError> {
        self.image = Some(image);
        Ok(())
    }

    fn read_image(&mut self) -> Result<ClipboardImage, ClipboardError> {
        self.image.clone().ok_or(ClipboardError::Unsupported)
    }

    fn clear(&mut self) -> Result<(), ClipboardError> {
        self.text.clear();
        self.html = None;
        self.image = None;
        Ok(())
    }
}

#[test]
fn cloned_handles_share_one_runtime_owned_clipboard() {
    let first = ClipboardHandle::new(MemoryClipboard::default());
    let second = first.clone();

    first.write_text("shared text".into()).unwrap();

    assert_eq!(second.read_text().unwrap(), "shared text");
}

#[test]
fn cloned_handles_share_html_images_and_clear_operations() {
    let first = ClipboardHandle::new(MemoryClipboard::default());
    let second = first.clone();
    let html = ClipboardHtml::new("<strong>shared</strong>").with_plain_text("shared");
    let image = ClipboardImage::from_rgba(vec![255, 0, 0, 255], 1, 1).unwrap();

    first.write_html(html.clone()).unwrap();
    first.write_image(image.clone()).unwrap();

    assert_eq!(html.html(), "<strong>shared</strong>");
    assert_eq!(html.plain_text(), Some("shared"));
    assert_eq!(second.read_html().unwrap(), "<strong>shared</strong>");
    assert_eq!(second.read_image().unwrap(), image);
    assert_eq!(image.width(), 1);
    assert_eq!(image.height(), 1);
    assert_eq!(image.rgba(), [255, 0, 0, 255]);

    second.clear().unwrap();

    assert_eq!(first.read_text().unwrap(), "");
    assert_eq!(first.read_html(), Err(ClipboardError::Unsupported));
    assert_eq!(first.read_image(), Err(ClipboardError::Unsupported));
}

#[test]
fn clipboard_image_rejects_invalid_rgba_dimensions() {
    assert_eq!(
        ClipboardImage::from_rgba(vec![0; 3], 1, 1),
        Err(ClipboardError::InvalidImage {
            width: 1,
            height: 1,
            byte_length: 3,
        })
    );
    assert_eq!(
        ClipboardImage::from_rgba(Vec::new(), 0, 0),
        Err(ClipboardError::InvalidImage {
            width: 0,
            height: 0,
            byte_length: 0,
        })
    );
}

#[derive(Default)]
struct TextOnlyClipboard(String);

impl Clipboard for TextOnlyClipboard {
    fn write_text(&mut self, text: String) -> Result<(), ClipboardError> {
        self.0 = text;
        Ok(())
    }

    fn read_text(&mut self) -> Result<String, ClipboardError> {
        Ok(self.0.clone())
    }
}

#[test]
fn existing_text_only_backends_report_rich_formats_as_unsupported() {
    let clipboard = ClipboardHandle::new(TextOnlyClipboard::default());
    let image = ClipboardImage::from_rgba(vec![0, 0, 0, 255], 1, 1).unwrap();

    assert_eq!(
        clipboard.write_html(ClipboardHtml::new("<p>text</p>")),
        Err(ClipboardError::Unsupported)
    );
    assert_eq!(
        clipboard.write_image(image),
        Err(ClipboardError::Unsupported)
    );
    assert_eq!(clipboard.clear(), Err(ClipboardError::Unsupported));
}
