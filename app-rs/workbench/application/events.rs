use super::*;

pub(super) fn handle_terminal_event(
    app: &mut WorkbenchApplication,
    key: TerminalSessionKey,
    event: TerminalSessionEvent,
) {
    if app.terminal_runtime.is_pending(key) {
        app.terminal_runtime.buffer_event_if_pending(key, event);
        return;
    }
    if app.active_pane_terminal_key() != Some(key) {
        {
            let Some(terminal) = app.terminal_runtime.terminal_mut(key) else {
                return;
            };
            if let Err(error) = terminal.handle_event(event) {
                eprintln!("could not reply to inactive terminal query: {error}");
            }
        }
        return;
    }

    let previous_scroll_limit = app.terminal_scroll_limit();
    let previous_block_status = app
        .active_terminal()
        .and_then(|terminal| terminal.core().block_list().blocks().last())
        .map(|block| block.status());
    let (active_screen, title) = if let Some(terminal) = app.active_terminal_mut() {
        if let Err(error) = terminal.handle_event(event) {
            eprintln!("could not reply to terminal query: {error}");
        }
        (
            terminal.core().active_screen(),
            terminal
                .core()
                .title()
                .unwrap_or(APP_DISPLAY_NAME)
                .to_owned(),
        )
    } else {
        return;
    };
    if let Some(window) = app.window.as_ref() {
        let _ = window.set_title(&title);
    }
    let current_block_status = app
        .active_terminal()
        .and_then(|terminal| terminal.core().block_list().blocks().last())
        .map(|block| block.status());
    if previous_block_status == Some(BlockStatus::Running)
        && current_block_status != Some(BlockStatus::Running)
    {
        if let Err(error) = app.refresh_git_from_app_server() {
            eprintln!("could not refresh Git snapshot: {error}");
        }
        app.refresh_files_from_app_server();
    }
    if active_screen == ScreenBuffer::Alternate || app.terminal_view().scroll.offset() == 0 {
        app.terminal_view_mut().selection.clear();
    }
    let scroll_limit = app.terminal_scroll_limit();
    app.terminal_view_mut().scroll.preserve_view_after_growth(
        scroll_limit.saturating_sub(previous_scroll_limit),
        scroll_limit,
    );
    app.sync_input_focus();
    app.rebuild_presentation_on_next_redraw();
}
