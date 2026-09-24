use std::cell::RefCell;
use std::rc::Rc;

use super::ApplicationBadge;
use super::ApplicationBadgeHandle;
use super::ApplicationBadgeRequest;
use super::ApplicationBadgeService;
use super::DesktopFileName;
use super::SystemServiceError;

struct RecordingBadges {
    requests: Rc<RefCell<Vec<ApplicationBadgeRequest>>>,
    fail: bool,
}

impl ApplicationBadgeService for RecordingBadges {
    fn set(&mut self, request: &ApplicationBadgeRequest) -> Result<(), SystemServiceError> {
        self.requests.borrow_mut().push(request.clone());
        if self.fail {
            Err(SystemServiceError::backend(
                "application badge",
                std::io::Error::other("injected failure"),
            ))
        } else {
            Ok(())
        }
    }
}

fn recording_handle(
    fail: bool,
) -> (
    ApplicationBadgeHandle,
    Rc<RefCell<Vec<ApplicationBadgeRequest>>>,
) {
    let requests = Rc::new(RefCell::new(Vec::new()));
    let handle = ApplicationBadgeHandle::new(RecordingBadges {
        requests: Rc::clone(&requests),
        fail,
    });
    (handle, requests)
}

#[test]
fn badge_values_keep_hidden_count_and_indeterminate_semantics_distinct() {
    assert_eq!(ApplicationBadge::from_count(0), ApplicationBadge::Hidden);
    assert_eq!(ApplicationBadge::from_count(7).count(), 7);
    assert!(ApplicationBadge::Count(-1).is_visible());
    assert!(ApplicationBadge::Indeterminate.is_visible());
    assert!(!ApplicationBadge::Hidden.is_visible());
    assert_eq!(ApplicationBadge::Hidden.display_label(), None);
    assert_eq!(
        ApplicationBadge::Indeterminate.display_label().as_deref(),
        Some("•")
    );
    assert_eq!(
        ApplicationBadge::Count(100).display_label().as_deref(),
        Some("99+")
    );
}

#[test]
fn configured_desktop_identity_and_badge_reach_the_injected_backend() {
    let (handle, requests) = recording_handle(false);
    let desktop_file_name = DesktopFileName::new("dev.ash.BadgeTest").unwrap();
    handle.set_desktop_file_name(Some(desktop_file_name.clone()));
    handle.set_count(12).unwrap();
    assert_eq!(handle.badge(), ApplicationBadge::Count(12));
    assert_eq!(handle.count(), 12);
    assert_eq!(requests.borrow()[0].badge(), ApplicationBadge::Count(12));
    assert_eq!(
        requests.borrow()[0].desktop_file_name(),
        Some(&desktop_file_name)
    );

    handle.set_indeterminate().unwrap();
    assert_eq!(handle.badge(), ApplicationBadge::Indeterminate);
    handle.clear().unwrap();
    assert_eq!(handle.badge(), ApplicationBadge::Hidden);
}

#[test]
fn failed_backend_updates_do_not_change_the_last_successful_badge() {
    let (handle, requests) = recording_handle(true);
    assert!(handle.set_count(9).is_err());
    assert_eq!(handle.badge(), ApplicationBadge::Hidden);
    assert_eq!(requests.borrow().len(), 1);
}
