//! Domain-neutral SQLite opening policy and atomic, component-scoped migrations.
//! Domains retain their schema, migration list, transactions and database path.

mod migrations;
mod runtime;

pub use migrations::Migration;
pub use migrations::Migrator;
pub use runtime::SqliteDurability;
pub use runtime::open_in_memory_database;
pub use runtime::open_sqlite_database;

#[cfg(test)]
mod tests;
