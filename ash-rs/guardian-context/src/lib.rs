//! Pure review evidence selection and whole-request budgeting.
//! Core supplies durable facts and their origin; the reviewer supplies the final wire payload.
//! This crate never loads Threads, invokes models, grants permissions, or retains conversation state.

mod budget;
mod history;

pub use budget::BudgetError;
pub use budget::RequestBudget;
pub use budget::fit;
pub use history::MessageOrigin;
pub use history::collect;
