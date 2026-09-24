use std::cell::RefCell;
use std::path::PathBuf;
use std::rc::Rc;

use super::JumpListCategory;
use super::JumpListHandle;
use super::JumpListItem;
use super::JumpListModelError;
use super::JumpListRequest;
use super::JumpListService;
use super::JumpListSettings;
use super::JumpListTask;
use super::JumpListUpdateResult;
use super::SystemServiceError;

struct RecordingJumpLists {
    requests: Rc<RefCell<Vec<JumpListRequest>>>,
}

impl JumpListService for RecordingJumpLists {
    fn settings(&mut self) -> Result<JumpListSettings, SystemServiceError> {
        Ok(JumpListSettings::new(10, Vec::new()))
    }

    fn set(
        &mut self,
        request: &JumpListRequest,
    ) -> Result<JumpListUpdateResult, SystemServiceError> {
        self.requests.borrow_mut().push(request.clone());
        Ok(JumpListUpdateResult::Applied)
    }
}

fn absolute(name: &str) -> PathBuf {
    std::env::temp_dir().join(name)
}

#[test]
fn task_values_retain_literal_windows_command_line_and_resources() {
    let program = absolute("zui-jump-list.exe");
    let icon = absolute("zui-jump-list.ico");
    let working_directory = absolute("zui-jump-list-work");
    let task = JumpListTask::new(program.clone(), "New window")
        .with_arguments("--new-window \"literal value\"")
        .with_description("Open another product window")
        .with_icon(icon.clone(), 2)
        .with_working_directory(working_directory.clone());
    assert_eq!(task.program(), program);
    assert_eq!(task.arguments(), "--new-window \"literal value\"");
    assert_eq!(task.title(), "New window");
    assert_eq!(task.description(), "Open another product window");
    assert_eq!(task.icon(), Some((icon.as_path(), 2)));
    assert_eq!(task.working_directory(), Some(working_directory.as_path()));
}

#[test]
fn invalid_categories_are_rejected_before_the_injected_backend() {
    let requests = Rc::new(RefCell::new(Vec::new()));
    let handle = JumpListHandle::new(RecordingJumpLists {
        requests: Rc::clone(&requests),
    });
    let error = handle
        .set(vec![JumpListCategory::custom(
            "Projects",
            vec![JumpListItem::Separator],
        )])
        .unwrap_err();
    assert_eq!(
        error.code(),
        crate::services::SystemServiceErrorCode::InvalidInput
    );
    assert!(requests.borrow().is_empty());

    let too_long = "a".repeat(261);
    let task = JumpListTask::new(absolute("zui.exe"), "Task").with_description(too_long);
    let request =
        JumpListRequest::Categories(vec![JumpListCategory::tasks(vec![JumpListItem::Task(
            task,
        )])]);
    assert!(matches!(
        request.validate(),
        Err(JumpListModelError::DescriptionTooLong { length: 261 })
    ));
}

#[test]
fn user_tasks_settings_and_reset_reach_the_injected_backend() {
    let requests = Rc::new(RefCell::new(Vec::new()));
    let handle = JumpListHandle::new(RecordingJumpLists {
        requests: Rc::clone(&requests),
    });
    let task = JumpListTask::new(absolute("zui.exe"), "New window");
    assert_eq!(
        handle.set_user_tasks(vec![task.clone()]).unwrap(),
        JumpListUpdateResult::Applied
    );
    assert_eq!(handle.settings().unwrap().min_items(), 10);
    assert_eq!(handle.reset().unwrap(), JumpListUpdateResult::Applied);
    assert_eq!(
        requests.borrow()[0],
        JumpListRequest::Categories(vec![JumpListCategory::tasks(vec![JumpListItem::Task(
            task
        )])])
    );
    assert_eq!(requests.borrow()[1], JumpListRequest::Default);
}
