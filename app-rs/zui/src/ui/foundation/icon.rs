//! Renderer-independent icon asset contracts.

mod definition;
mod identity;
mod value;

pub use definition::{IconDefinition, IconRendering};
pub use identity::IconId;
pub use value::Icon;

#[cfg(test)]
#[path = "icon/icon_tests.rs"]
mod tests;
