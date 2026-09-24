use crate::WorkbenchApplication;
use crate::launch_progress::RemoteLaunchProgressEvent;
use crate::remote_connection_process::RemoteWindowLaunchEvent;
use crate::remote_connection_process::RemoteWindowLaunchUpdate;
use crate::remote_connection_process::launch_remote_connection;

impl WorkbenchApplication {
    pub(super) fn connect_remote_connection_manager(&mut self) {
        let Some(name) = self.remote_connection_manager.connect_request() else {
            self.remote_connection_manager_changed();
            return;
        };
        match launch_remote_connection(&name, self.event_proxy.clone()) {
            Ok(launch) => {
                self.remote_connection_manager.launch_started(name);
                self.remote_connection_launch = Some(launch);
                self.remote_connection_manager_changed();
            }
            Err(error) => {
                self.remote_connection_manager.launch_failed(format!(
                    "could not open Remote connection `{}`: {error}",
                    name.as_str()
                ));
                self.remote_connection_manager_changed();
            }
        }
    }

    pub(super) fn handle_remote_window_launch_event(&mut self, event: RemoteWindowLaunchEvent) {
        let Some(active) = self.remote_connection_launch.as_ref() else {
            return;
        };
        if active.launch_id() != event.launch_id() {
            return;
        }
        match event.update().clone() {
            RemoteWindowLaunchUpdate::Progress(progress) => match progress {
                RemoteLaunchProgressEvent::Ready => {
                    self.remote_connection_launch.take();
                    self.dismiss_remote_connection_manager();
                }
                RemoteLaunchProgressEvent::Failed(error) => {
                    if let Some(launch) = self.remote_connection_launch.take() {
                        let _ = launch.cancel();
                    }
                    self.remote_connection_manager.launch_failed(error);
                    self.remote_connection_manager_changed();
                }
                progress => {
                    self.remote_connection_manager
                        .launch_progress(progress.message());
                    self.remote_connection_manager_changed();
                }
            },
            RemoteWindowLaunchUpdate::Exited { success, code } => {
                self.remote_connection_launch.take();
                let status = match (success, code) {
                    (true, _) => {
                        "Remote window process exited before reporting readiness".to_owned()
                    }
                    (false, Some(code)) => {
                        format!("Remote window launch failed with exit code {code}")
                    }
                    (false, None) => "Remote window launch was terminated".to_owned(),
                };
                self.remote_connection_manager.launch_failed(status);
                self.remote_connection_manager_changed();
            }
        }
    }
}
