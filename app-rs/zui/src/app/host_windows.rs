use std::collections::HashSet;

use crate::internal::ActiveEventLoop;
use crate::window::WindowEvent;
use crate::window::WindowId;
use crate::window::WindowRole;

use super::App;
use super::ApplicationExitReason;
use super::ApplicationHost;
use super::WindowContext;
use super::WindowContextParts;
use super::WindowRuntime;
use crate::app::ApplicationExitDecision;
use crate::app::WindowCommand;
use crate::runtime::TaskScope;

impl<T, A> ApplicationHost<T, A>
where
    T: Send + 'static,
    A: App<T>,
{
    pub(super) fn process_window_commands(&mut self, event_loop: &ActiveEventLoop) {
        self.process_devtools_requests(event_loop);
        while let Some(command) = self.lifecycle.next_command() {
            match command {
                WindowCommand::Opened(window) => {
                    if self
                        .windows
                        .get(&window)
                        .is_some_and(|runtime| runtime.role() == WindowRole::Product)
                    {
                        self.with_app_context(event_loop, |app, context| {
                            app.window_opened(context, window)
                        });
                    }
                }
                WindowCommand::RequestClose(window) => {
                    self.deliver_window_close_request(event_loop, window)
                }
                WindowCommand::Destroy(window) => self.close_window_tree(event_loop, window),
                WindowCommand::Exit(reason) => {
                    if self.process_exit_request(event_loop, reason) {
                        break;
                    }
                }
            }
        }
    }

    fn process_exit_request(
        &mut self,
        event_loop: &ActiveEventLoop,
        reason: ApplicationExitReason,
    ) -> bool {
        let decision = if reason.is_cancelable() {
            self.diagnostics
                .record(crate::devtools::DiagnosticEventKind::ExitRequested(reason));
            self.with_app_context(event_loop, |app, context| app.before_exit(context, reason))
        } else {
            ApplicationExitDecision::Exit
        };
        if decision == ApplicationExitDecision::Cancel {
            self.cancel_exit_request(reason);
            return false;
        }
        if self.exit_request_was_superseded(reason) {
            return false;
        }
        if reason.is_cancelable() && !self.close_windows_for_exit(event_loop, reason) {
            if !self.exit_request_was_superseded(reason) {
                self.cancel_exit_request(reason);
            }
            return false;
        }
        let decision = if reason.is_cancelable() {
            self.with_app_context(event_loop, |app, context| app.will_exit(context, reason))
        } else {
            ApplicationExitDecision::Exit
        };
        if decision == ApplicationExitDecision::Cancel {
            self.cancel_exit_request(reason);
            return false;
        }
        if self.exit_request_was_superseded(reason) {
            return false;
        }
        if self
            .lifecycle
            .resolve_exit(reason, ApplicationExitDecision::Exit)
        {
            event_loop.exit();
            return true;
        }
        false
    }

    fn cancel_exit_request(&mut self, reason: ApplicationExitReason) {
        self.lifecycle
            .resolve_exit(reason, ApplicationExitDecision::Cancel);
        self.diagnostics
            .record(crate::devtools::DiagnosticEventKind::ExitCancelled(reason));
    }

    fn exit_request_was_superseded(&self, reason: ApplicationExitReason) -> bool {
        self.lifecycle
            .pending_exit()
            .is_some_and(|pending| pending != reason)
    }

    fn close_windows_for_exit(
        &mut self,
        event_loop: &ActiveEventLoop,
        reason: ApplicationExitReason,
    ) -> bool {
        let relationships = self
            .windows
            .values()
            .filter(|runtime| runtime.role() == WindowRole::Product)
            .map(|runtime| (runtime.id(), runtime.parent()))
            .collect::<Vec<_>>();
        for window in all_child_first_close_order(&relationships) {
            if self.windows.get(&window).map(WindowRuntime::role) != Some(WindowRole::Product) {
                continue;
            }
            self.deliver_window_close_request(event_loop, window);
            if self.exit_request_was_superseded(reason) {
                return false;
            }
            if !self.lifecycle.take_window_destroy(window) {
                return false;
            }
            self.close_one_window(event_loop, window, false);
            if self.exit_request_was_superseded(reason) {
                return false;
            }
        }
        !self.lifecycle.has_product_windows()
    }

    fn deliver_window_close_request(&mut self, event_loop: &ActiveEventLoop, window: WindowId) {
        let role = self.windows.get(&window).map(WindowRuntime::role);
        if role != Some(WindowRole::Product) {
            if role.is_some() {
                self.lifecycle.destroy_window(window);
            }
            return;
        }
        self.diagnostics
            .record(crate::devtools::DiagnosticEventKind::WindowEvent(window));
        let runtime = self
            .windows
            .get_mut(&window)
            .expect("live product window disappeared before close callback");
        let mut context = WindowContext::new(WindowContextParts {
            runtime,
            event_proxy: &self.event_proxy,
            clipboard: &self.clipboard,
            services: &self.services,
            error: &mut self.error,
            lifecycle: &mut self.lifecycle,
            background: &self.background,
            timers: &self.timers,
            diagnostics: &self.diagnostics,
        });
        self.app
            .window_event(&mut context, WindowEvent::CloseRequested);
        self.process_devtools_requests(event_loop);
    }

    fn close_window_tree(&mut self, event_loop: &ActiveEventLoop, root: WindowId) {
        let relationships = self
            .windows
            .values()
            .map(|runtime| {
                let parent = (runtime.role() == WindowRole::Product)
                    .then(|| runtime.parent())
                    .flatten();
                (runtime.id(), parent)
            })
            .collect::<Vec<_>>();
        for window in child_first_close_order(root, &relationships) {
            self.close_one_window(event_loop, window, true);
        }
    }

    fn close_one_window(
        &mut self,
        event_loop: &ActiveEventLoop,
        window: WindowId,
        notify_all_closed: bool,
    ) {
        let role = self.windows.get(&window).map(WindowRuntime::role);
        if role == Some(WindowRole::Product) {
            self.close_devtools_windows(window);
            self.services.menus().detach_window(window);
        }
        let Some(runtime) = self.windows.remove(&window) else {
            return;
        };
        let parent = runtime.parent();
        let modal = runtime.is_modal();
        if modal
            && let Some(parent) = parent
            && !self.windows.values().any(|candidate| {
                candidate.role() == WindowRole::Product
                    && candidate.is_modal()
                    && candidate.parent() == Some(parent)
            })
            && let Some(parent) = self.windows.get(&parent)
        {
            parent.set_enabled(true);
        }
        drop(runtime);
        self.background.cancel_window(window);
        self.timer_registry.cancel_scope(TaskScope::Window(window));
        self.cursor_positions.remove(&window);
        self.diagnostics.close_window(window);
        if role == Some(WindowRole::Product) {
            self.lifecycle.record_window_closed(window);
            self.with_app_context(event_loop, |app, context| {
                app.window_closed(context, window)
            });
            if notify_all_closed && !self.lifecycle.has_product_windows() {
                self.with_app_context(event_loop, |app, context| app.window_all_closed(context));
                if self.lifecycle.should_exit_after_last_window() {
                    self.lifecycle
                        .request_exit(ApplicationExitReason::LastWindowClosed);
                }
            }
        } else if let Some(WindowRole::DevTools { owner }) = role
            && let Some(runtime) = self.windows.get(&owner)
        {
            runtime.handle().devtools().close_local();
            runtime.request_redraw();
        }
    }

    pub(super) fn restore_modal_parents(&self) {
        let parents = self
            .windows
            .values()
            .filter(|runtime| runtime.role() == WindowRole::Product && runtime.is_modal())
            .filter_map(WindowRuntime::parent)
            .collect::<HashSet<_>>();
        for parent in parents {
            if let Some(runtime) = self.windows.get(&parent) {
                runtime.set_enabled(true);
            }
        }
    }
}

fn child_first_close_order(
    root: WindowId,
    relationships: &[(WindowId, Option<WindowId>)],
) -> Vec<WindowId> {
    let mut visited = HashSet::new();
    let mut order = Vec::new();
    collect_child_first(root, relationships, &mut visited, &mut order);
    order
}

fn all_child_first_close_order(relationships: &[(WindowId, Option<WindowId>)]) -> Vec<WindowId> {
    let mut roots = relationships
        .iter()
        .filter_map(|(window, parent)| {
            let parent_is_live = parent.is_some_and(|parent| {
                relationships
                    .iter()
                    .any(|(candidate, _)| *candidate == parent)
            });
            (!parent_is_live).then_some(*window)
        })
        .collect::<Vec<_>>();
    roots.sort_by_key(|window| window.into_raw());
    let mut remaining = relationships
        .iter()
        .map(|(window, _)| *window)
        .collect::<Vec<_>>();
    remaining.sort_by_key(|window| window.into_raw());

    let mut visited = HashSet::new();
    let mut order = Vec::new();
    for root in roots.into_iter().chain(remaining) {
        collect_child_first(root, relationships, &mut visited, &mut order);
    }
    order
}

fn collect_child_first(
    window: WindowId,
    relationships: &[(WindowId, Option<WindowId>)],
    visited: &mut HashSet<WindowId>,
    order: &mut Vec<WindowId>,
) {
    if !visited.insert(window)
        || !relationships
            .iter()
            .any(|(candidate, _)| *candidate == window)
    {
        return;
    }
    let mut children = relationships
        .iter()
        .filter_map(|(candidate, parent)| (*parent == Some(window)).then_some(*candidate))
        .collect::<Vec<_>>();
    children.sort_by_key(|child| child.into_raw());
    for child in children {
        collect_child_first(child, relationships, visited, order);
    }
    order.push(window);
}

#[cfg(test)]
#[path = "host_windows_tests.rs"]
mod tests;
