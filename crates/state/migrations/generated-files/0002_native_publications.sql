CREATE TABLE generated_file_publications (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    item_id TEXT NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL
);
