//! Headless list composition and interaction state for slash-triggered launchers.
//!
//! Products decide which lists to provide and how to activate a selected item. This crate only
//! validates and combines those lists, interprets a leading-slash query, and owns renderer-neutral
//! selection state.

mod input;
mod model;
mod snapshot;
mod state;

pub use input::SlashLauncherInput;
pub use input::SlashLauncherQuery;
pub use model::SlashLauncherError;
pub use model::SlashLauncherItem;
pub use model::SlashLauncherList;
pub use snapshot::SlashLauncherSelection;
pub use snapshot::SlashLauncherSnapshot;
pub use state::SlashLauncherState;
pub use state::SlashLauncherView;
