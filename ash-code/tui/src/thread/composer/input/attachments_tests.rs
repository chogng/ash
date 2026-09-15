use super::*;
use std::fs;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[test]
fn pasted_png_path_becomes_an_atomic_chat_input_attachment() {
    let path = temporary_image_path("png");
    fs::write(&path, b"\x89PNG\r\n\x1a\npayload").unwrap();
    let mut attachments = Attachments::default();
    let mut textarea = TextArea::new();

    let outcome =
        attachments.try_attach_pasted_path(&mut textarea, path.to_string_lossy().as_ref());

    assert_eq!(outcome, ImagePasteOutcome::Attached);
    assert_eq!(textarea.text(), "[Image #1] ");
    let (element_id, _) = textarea.elements().next().unwrap();
    assert!(
        matches!(attachments.attachment_item(element_id), Some(super::super::state::ChatInputItem::Image { url }) if url.starts_with("data:image/png;base64,"))
    );
    let _ = fs::remove_file(path);
}

#[test]
fn clipboard_png_bytes_become_an_atomic_image_attachment() {
    let mut attachments = Attachments::default();
    let mut textarea = TextArea::new();

    attachments
        .attach_image_bytes(&mut textarea, b"\x89PNG\r\n\x1a\npayload".to_vec())
        .unwrap();

    assert_eq!(textarea.text(), "[Image #1] ");
    let (element_id, _) = textarea.elements().next().unwrap();
    assert!(
        matches!(attachments.attachment_item(element_id), Some(super::super::state::ChatInputItem::Image { url }) if url.starts_with("data:image/png;base64,"))
    );
}

#[test]
fn clipboard_image_bytes_respect_the_attachment_size_limit() {
    let mut attachments = Attachments::default();
    let mut textarea = TextArea::new();
    let oversized = vec![0; MAX_LOCAL_IMAGE_BYTES as usize + 1];

    let result = attachments.attach_image_bytes(&mut textarea, oversized);

    assert!(result.is_err());
    assert_eq!(textarea.text(), "");
}

#[test]
fn non_image_file_remains_text_paste_input() {
    let path = temporary_image_path("txt");
    fs::write(&path, b"not an image").unwrap();
    let mut attachments = Attachments::default();
    let mut textarea = TextArea::new();

    let outcome =
        attachments.try_attach_pasted_path(&mut textarea, path.to_string_lossy().as_ref());

    assert_eq!(outcome, ImagePasteOutcome::NotImage);
    assert_eq!(textarea.text(), "");
    let _ = fs::remove_file(path);
}

#[test]
fn deleting_an_image_relabels_remaining_placeholders() {
    let first_path = temporary_image_path("png");
    let second_path = temporary_image_path("jpg");
    fs::write(&first_path, b"\x89PNG\r\n\x1a\nfirst").unwrap();
    fs::write(&second_path, b"\xff\xd8\xffsecond").unwrap();
    let mut attachments = Attachments::default();
    let mut textarea = TextArea::new();
    attachments.try_attach_pasted_path(&mut textarea, first_path.to_string_lossy().as_ref());
    attachments.try_attach_pasted_path(&mut textarea, second_path.to_string_lossy().as_ref());
    textarea.handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Home,
        crossterm::event::KeyModifiers::NONE,
    ));
    textarea.handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Delete,
        crossterm::event::KeyModifiers::NONE,
    ));

    attachments.reconcile(&mut textarea);

    assert_eq!(textarea.text(), " [Image #1] ");
    let _ = fs::remove_file(first_path);
    let _ = fs::remove_file(second_path);
}

fn temporary_image_path(extension: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::env::temp_dir().join(format!(
        "ash-tui-image-{}-{nonce}.{extension}",
        std::process::id()
    ))
}
