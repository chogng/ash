CREATE TABLE extension_state (
    namespace TEXT PRIMARY KEY,
    revision INTEGER NOT NULL,
    values_json TEXT NOT NULL
);
