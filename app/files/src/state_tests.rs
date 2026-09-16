use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

use zui::ui::Size;
use zui::ui::TextInputCommand;

use super::DirectoryEntry;
use super::FilesState;

static NEXT_DIR_ID: AtomicU64 = AtomicU64::new(0);

#[test]
fn replacing_dir_rebuilds_the_files_root_and_search_results() {
    let fixture = test_dir("replace");
    let first = fixture.join("first");
    let second = fixture.join("second");
    std::fs::create_dir_all(&first).unwrap();
    std::fs::create_dir_all(&second).unwrap();
    std::fs::write(first.join("first.txt"), "first").unwrap();
    std::fs::write(second.join("second.txt"), "second").unwrap();
    let mut files = FilesState::default();
    files.set_dir_root(first);
    files.refresh(vec![DirectoryEntry::file("first.txt")]);
    files.apply_search(TextInputCommand::Insert(".txt".into()));
    wait_for_search(&mut files);
    assert_eq!(files.search_matches(), &[PathBuf::from("first.txt")]);

    files.set_dir_root(second);
    files.refresh(vec![DirectoryEntry::file("second.txt")]);
    wait_for_search(&mut files);

    assert_eq!(files.tree_row(0).unwrap().entry().label(), "second.txt");
    assert_eq!(files.search_matches(), &[PathBuf::from("second.txt")]);
    drop(files);
    std::fs::remove_dir_all(fixture).unwrap();
}

#[test]
fn refreshing_files_resets_pixel_scroll() {
    let fixture = test_dir("scroll");
    std::fs::create_dir_all(&fixture).unwrap();
    let mut files = FilesState::default();
    files.set_dir_root(fixture.clone());
    files.refresh(
        (0..20)
            .map(|index| DirectoryEntry::file(format!("file-{index:02}.txt")))
            .collect(),
    );
    assert!(files.scroll(72.0, Size::new(320.0, 100.0)));
    assert_eq!(files.scroll_state().vertical_offset(), 72.0);

    files.refresh(Vec::new());

    assert_eq!(files.scroll_state().vertical_offset(), 0.0);
    std::fs::remove_dir_all(fixture).unwrap();
}

fn wait_for_search(files: &mut FilesState) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while files.search_pending() {
        files.poll_search();
        assert!(Instant::now() < deadline, "file search did not finish");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn test_dir(label: &str) -> std::path::PathBuf {
    std::env::temp_dir().join(format!(
        "ash-files-{label}-{}-{}",
        std::process::id(),
        NEXT_DIR_ID.fetch_add(1, Ordering::Relaxed)
    ))
}
