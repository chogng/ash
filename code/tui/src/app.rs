mod chat_panel;
#[cfg(test)]
#[path = "app/chat_panel_tests.rs"]
mod chat_panel_tests;
mod command;
mod command_panel;
mod completion;
#[cfg(test)]
#[path = "app/conversation_flow_tests.rs"]
mod conversation_flow_tests;
mod dispatch;
mod driver;
mod escape;
mod event;
mod event_loop;
mod event_pump;
mod frame;
mod fullscreen;
mod help;
mod inline;
#[cfg(test)]
#[path = "app/interaction_flow_tests.rs"]
mod interaction_flow_tests;
#[cfg(test)]
#[path = "app/mode_tests.rs"]
mod mode_tests;
#[cfg(test)]
#[path = "app/mermaid_preview_tests.rs"]
mod mermaid_preview_tests;
mod recovery;
mod redraw;
mod requests;
#[cfg(test)]
#[path = "app/session_manager_tests.rs"]
mod session_manager_tests;
mod start;
mod startup;
mod state;
mod top_tip;
#[cfg(test)]
#[path = "app/usage_tests.rs"]
mod usage_tests;
mod welcome;

pub(crate) use crate::sessions::ActiveConversation;
pub(crate) use command::AppCommand;
#[cfg(test)]
pub(crate) use command_panel::CommandPanel;
#[cfg(test)]
pub(crate) use completion::apply_active_turn_snapshot;
pub(crate) use event::AppEvent;
pub(crate) use event_loop::run;
pub(crate) use state::App;
#[cfg(test)]
pub(crate) use state::Status;

#[cfg(test)]
#[path = "app/marketplace_tests.rs"]
mod marketplace_tests;
