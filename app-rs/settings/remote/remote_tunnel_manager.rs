use std::num::NonZeroU16;

use ash_ui_components::ScrollAxis;
use ash_ui_components::ScrollCommand;
use ash_ui_components::ScrollMetrics;
use ash_ui_components::ScrollState;
use zui::ui::ElementId;
use zui::ui::TextInput;
use zui::ui::TextInputCommand;
use zui::ui::TextInputCompositionEvent;

use ash_remote_host::{RemoteTunnelEvent, RemoteTunnelId, RemoteTunnelUpdate};

const REMOTE_TUNNEL_MANAGER_SCOPE: u32 = 11;
const REMOTE_TUNNEL_STOP_SCOPE: u32 = 12;
const REMOTE_TUNNEL_ITEM_SCOPE: u32 = 13;
pub const REMOTE_TUNNEL_MANAGER: ElementId = ElementId::scoped(REMOTE_TUNNEL_MANAGER_SCOPE, 1);
pub const REMOTE_TUNNEL_MANAGER_CLOSE: ElementId =
    ElementId::scoped(REMOTE_TUNNEL_MANAGER_SCOPE, 2);
pub const REMOTE_TUNNEL_REMOTE_PORT: ElementId = ElementId::scoped(REMOTE_TUNNEL_MANAGER_SCOPE, 3);
pub const REMOTE_TUNNEL_OPEN: ElementId = ElementId::scoped(REMOTE_TUNNEL_MANAGER_SCOPE, 4);
pub const REMOTE_TUNNEL_LIST: ElementId = ElementId::scoped(REMOTE_TUNNEL_MANAGER_SCOPE, 5);
pub const REMOTE_TUNNEL_STATUS: ElementId = ElementId::scoped(REMOTE_TUNNEL_MANAGER_SCOPE, 6);
pub const REMOTE_TUNNEL_ITEM_HEIGHT: f32 = 42.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteTunnelLifecycle {
    Starting,
    Ready,
    Recovering,
    Stopping,
}

impl RemoteTunnelLifecycle {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Starting => "Starting…",
            Self::Ready => "Forwarding",
            Self::Recovering => "Recovering…",
            Self::Stopping => "Stopping…",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteTunnelRecord {
    tunnel_id: RemoteTunnelId,
    remote_port: NonZeroU16,
    local_port: Option<NonZeroU16>,
    lifecycle: RemoteTunnelLifecycle,
}

impl RemoteTunnelRecord {
    pub const fn tunnel_id(&self) -> RemoteTunnelId {
        self.tunnel_id
    }

    pub const fn remote_port(&self) -> NonZeroU16 {
        self.remote_port
    }

    pub const fn local_port(&self) -> Option<NonZeroU16> {
        self.local_port
    }

    pub const fn lifecycle(&self) -> RemoteTunnelLifecycle {
        self.lifecycle
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ManagerStatus {
    message: String,
    error: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OpenRemoteTunnelManager {
    host: String,
    restore_focus: Option<ElementId>,
}

/// Renderer-facing state for loopback forwards owned by the product app host.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RemoteTunnelManagerState {
    open: Option<OpenRemoteTunnelManager>,
    remote_port: TextInput,
    tunnels: Vec<RemoteTunnelRecord>,
    scroll: ScrollState,
    status: Option<ManagerStatus>,
}

impl RemoteTunnelManagerState {
    pub fn open(&mut self, host: impl Into<String>, restore_focus: Option<ElementId>) {
        self.open = Some(OpenRemoteTunnelManager {
            host: host.into(),
            restore_focus,
        });
        self.remote_port.take_text();
        self.scroll = ScrollState::default();
    }

    pub const fn is_open(&self) -> bool {
        self.open.is_some()
    }

    pub fn dismiss(&mut self) -> Option<ElementId> {
        self.remote_port.cancel_composition();
        self.open.take().and_then(|open| open.restore_focus)
    }

    pub fn host(&self) -> &str {
        self.open
            .as_ref()
            .map(|open| open.host.as_str())
            .unwrap_or_default()
    }

    pub const fn remote_port_input(&self) -> &TextInput {
        &self.remote_port
    }

    pub fn apply_remote_port(&mut self, command: TextInputCommand) {
        self.remote_port.apply(command);
        self.status = None;
    }

    pub fn apply_remote_port_composition(&mut self, event: TextInputCompositionEvent) {
        self.remote_port.apply_composition(event);
        self.status = None;
    }

    pub fn cancel_remote_port_composition(&mut self) {
        self.remote_port.cancel_composition();
    }

    pub fn selected_remote_port_text(&self) -> Option<&str> {
        self.remote_port.selected_text()
    }

    pub fn start_request(&mut self) -> Option<NonZeroU16> {
        let remote_port = match parse_port(self.remote_port.text()) {
            Ok(port) => port,
            Err(error) => {
                self.set_error(error);
                return None;
            }
        };
        if self
            .tunnels
            .iter()
            .any(|tunnel| tunnel.remote_port == remote_port)
        {
            self.set_error(format!(
                "Remote port {} already has a tunnel in this window",
                remote_port
            ));
            return None;
        }
        Some(remote_port)
    }

    pub fn start_succeeded(&mut self, tunnel_id: RemoteTunnelId, remote_port: NonZeroU16) {
        self.remote_port.take_text();
        self.tunnels.push(RemoteTunnelRecord {
            tunnel_id,
            remote_port,
            local_port: None,
            lifecycle: RemoteTunnelLifecycle::Starting,
        });
        self.status = Some(ManagerStatus {
            message: format!("Opening loopback forward to 127.0.0.1:{remote_port}…"),
            error: false,
        });
    }

    pub fn start_failed(&mut self, error: impl Into<String>) {
        self.set_error(error);
    }

    pub fn stop_request(&mut self, tunnel_id: RemoteTunnelId) -> bool {
        let Some(tunnel) = self
            .tunnels
            .iter_mut()
            .find(|tunnel| tunnel.tunnel_id == tunnel_id)
        else {
            return false;
        };
        if tunnel.lifecycle == RemoteTunnelLifecycle::Stopping {
            return false;
        }
        tunnel.lifecycle = RemoteTunnelLifecycle::Stopping;
        self.status = Some(ManagerStatus {
            message: format!("Stopping tunnel to 127.0.0.1:{}…", tunnel.remote_port),
            error: false,
        });
        true
    }

    pub fn stop_failed(&mut self, tunnel_id: RemoteTunnelId, error: impl Into<String>) {
        if let Some(tunnel) = self
            .tunnels
            .iter_mut()
            .find(|tunnel| tunnel.tunnel_id == tunnel_id)
        {
            tunnel.lifecycle = if tunnel.local_port.is_some() {
                RemoteTunnelLifecycle::Ready
            } else {
                RemoteTunnelLifecycle::Starting
            };
        }
        self.set_error(error);
    }

    pub fn handle_event(&mut self, event: &RemoteTunnelEvent) -> bool {
        let Some(index) = self
            .tunnels
            .iter()
            .position(|tunnel| tunnel.tunnel_id == event.tunnel_id())
        else {
            return false;
        };
        match event.update() {
            RemoteTunnelUpdate::Ready { local_port } => {
                let tunnel = &mut self.tunnels[index];
                tunnel.local_port = Some(*local_port);
                if tunnel.lifecycle != RemoteTunnelLifecycle::Stopping {
                    tunnel.lifecycle = RemoteTunnelLifecycle::Ready;
                    self.status = Some(ManagerStatus {
                        message: format!(
                            "Forwarding 127.0.0.1:{local_port} to Remote 127.0.0.1:{}",
                            tunnel.remote_port
                        ),
                        error: false,
                    });
                }
            }
            RemoteTunnelUpdate::Recovering { attempt } => {
                let tunnel = &mut self.tunnels[index];
                if tunnel.lifecycle != RemoteTunnelLifecycle::Stopping {
                    tunnel.lifecycle = RemoteTunnelLifecycle::Recovering;
                    let local = tunnel
                        .local_port
                        .map(|port| port.to_string())
                        .unwrap_or_else(|| "allocating".into());
                    self.status = Some(ManagerStatus {
                        message: format!(
                            "SSH transport lost; recovering 127.0.0.1:{local} (attempt {attempt})…"
                        ),
                        error: false,
                    });
                }
            }
            RemoteTunnelUpdate::Stopped => {
                self.tunnels.remove(index);
                self.status = Some(ManagerStatus {
                    message: format!("Stopped tunnel to Remote 127.0.0.1:{}", event.remote_port()),
                    error: false,
                });
            }
            RemoteTunnelUpdate::Failed(error) => {
                self.tunnels.remove(index);
                self.set_error(error.clone());
            }
        }
        true
    }

    pub fn tunnels(&self) -> &[RemoteTunnelRecord] {
        &self.tunnels
    }

    pub fn stop_id(&self, element: ElementId) -> Option<RemoteTunnelId> {
        self.tunnels.iter().find_map(|tunnel| {
            (remote_tunnel_stop_id(tunnel.tunnel_id) == element).then_some(tunnel.tunnel_id)
        })
    }

    pub fn can_stop(&self, tunnel_id: RemoteTunnelId) -> bool {
        self.tunnels.iter().any(|tunnel| {
            tunnel.tunnel_id == tunnel_id && tunnel.lifecycle != RemoteTunnelLifecycle::Stopping
        })
    }

    pub const fn scroll_state(&self) -> ScrollState {
        self.scroll
    }

    pub fn apply_scroll(&mut self, command: ScrollCommand, metrics: ScrollMetrics) -> bool {
        self.scroll.apply(command, metrics, ScrollAxis::Vertical)
    }

    pub fn status(&self) -> Option<(&str, bool)> {
        self.status
            .as_ref()
            .map(|status| (status.message.as_str(), status.error))
    }

    fn set_error(&mut self, error: impl Into<String>) {
        self.status = Some(ManagerStatus {
            message: error.into(),
            error: true,
        });
    }
}

pub const fn remote_tunnel_stop_id(tunnel_id: RemoteTunnelId) -> ElementId {
    ElementId::scoped(REMOTE_TUNNEL_STOP_SCOPE, tunnel_id.get())
}

pub const fn remote_tunnel_item_id(tunnel_id: RemoteTunnelId) -> ElementId {
    ElementId::scoped(REMOTE_TUNNEL_ITEM_SCOPE, tunnel_id.get())
}

pub fn is_remote_tunnel_manager_element(id: ElementId, tunnels: &[RemoteTunnelRecord]) -> bool {
    matches!(
        id,
        REMOTE_TUNNEL_MANAGER
            | REMOTE_TUNNEL_MANAGER_CLOSE
            | REMOTE_TUNNEL_REMOTE_PORT
            | REMOTE_TUNNEL_OPEN
            | REMOTE_TUNNEL_LIST
            | REMOTE_TUNNEL_STATUS
    ) || tunnels.iter().any(|tunnel| {
        remote_tunnel_stop_id(tunnel.tunnel_id) == id
            || remote_tunnel_item_id(tunnel.tunnel_id) == id
    })
}

fn parse_port(value: &str) -> Result<NonZeroU16, String> {
    value
        .trim()
        .parse::<u16>()
        .ok()
        .and_then(NonZeroU16::new)
        .ok_or_else(|| "Enter a Remote TCP port from 1 to 65535".into())
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroU16;

    use zui::ui::TextInputCommand;

    use super::RemoteTunnelEvent;
    use super::RemoteTunnelId;
    use super::RemoteTunnelLifecycle;
    use super::RemoteTunnelManagerState;
    use super::RemoteTunnelUpdate;
    use super::remote_tunnel_stop_id;

    #[test]
    fn manager_validates_ports_and_prevents_duplicate_forwards() {
        let mut state = RemoteTunnelManagerState::default();
        state.open("build.example", None);
        state.apply_remote_port(TextInputCommand::Insert("0".into()));
        assert!(state.start_request().is_none());
        assert!(state.status().unwrap().1);

        state.apply_remote_port(TextInputCommand::SelectAll);
        state.apply_remote_port(TextInputCommand::Insert("3000".into()));
        let port = state.start_request().unwrap();
        state.start_succeeded(RemoteTunnelId::new(7), port);
        state.apply_remote_port(TextInputCommand::Insert("3000".into()));
        assert!(state.start_request().is_none());
        assert!(state.status().unwrap().0.contains("already has a tunnel"));
    }

    #[test]
    fn manager_projects_ready_stopping_and_terminal_events() {
        let mut state = RemoteTunnelManagerState::default();
        state.open("build.example", None);
        state.start_succeeded(RemoteTunnelId::new(9), NonZeroU16::new(3_000).unwrap());
        assert_eq!(
            state.tunnels()[0].lifecycle(),
            RemoteTunnelLifecycle::Starting
        );

        let ready = event(
            9,
            RemoteTunnelUpdate::Ready {
                local_port: NonZeroU16::new(49_152).unwrap(),
            },
        );
        assert!(state.handle_event(&ready));
        assert_eq!(state.tunnels()[0].lifecycle(), RemoteTunnelLifecycle::Ready);
        assert_eq!(state.tunnels()[0].local_port().unwrap().get(), 49_152);
        assert!(state.handle_event(&event(9, RemoteTunnelUpdate::Recovering { attempt: 1 })));
        assert_eq!(
            state.tunnels()[0].lifecycle(),
            RemoteTunnelLifecycle::Recovering
        );
        assert!(state.status().unwrap().0.contains("attempt 1"));
        assert!(state.handle_event(&ready));
        assert_eq!(state.tunnels()[0].lifecycle(), RemoteTunnelLifecycle::Ready);
        assert!(state.stop_request(RemoteTunnelId::new(9)));
        assert_eq!(
            state.tunnels()[0].lifecycle(),
            RemoteTunnelLifecycle::Stopping
        );
        assert!(state.handle_event(&event(9, RemoteTunnelUpdate::Stopped)));
        assert!(state.tunnels().is_empty());
    }

    #[test]
    fn dismissing_the_manager_preserves_tunnel_records() {
        let mut state = RemoteTunnelManagerState::default();
        state.open("build.example", None);
        state.start_succeeded(RemoteTunnelId::new(11), NonZeroU16::new(8_080).unwrap());

        state.dismiss();

        assert!(!state.is_open());
        assert_eq!(state.tunnels().len(), 1);
    }

    #[test]
    fn tunnel_controls_keep_semantic_identity_when_an_earlier_row_exits() {
        let mut state = RemoteTunnelManagerState::default();
        state.open("build.example", None);
        state.start_succeeded(RemoteTunnelId::new(21), NonZeroU16::new(3_000).unwrap());
        state.start_succeeded(RemoteTunnelId::new(22), NonZeroU16::new(4_000).unwrap());
        let second_stop = remote_tunnel_stop_id(RemoteTunnelId::new(22));

        assert!(state.handle_event(&event(21, RemoteTunnelUpdate::Stopped)));

        assert_eq!(state.stop_id(second_stop), Some(RemoteTunnelId::new(22)));
    }

    fn event(tunnel_id: u32, update: RemoteTunnelUpdate) -> RemoteTunnelEvent {
        RemoteTunnelEvent::new(
            RemoteTunnelId::new(tunnel_id),
            NonZeroU16::new(3_000).unwrap(),
            update,
        )
    }
}
