CREATE TABLE IF NOT EXISTS agent_board_sessions (
    session TEXT PRIMARY KEY,
    deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_boards (
    id INTEGER PRIMARY KEY,
    session TEXT NOT NULL REFERENCES agent_board_sessions(session),
    root TEXT NOT NULL,
    UNIQUE(session, root)
);

CREATE TABLE IF NOT EXISTS agent_board_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board INTEGER NOT NULL REFERENCES agent_boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    search_name TEXT NOT NULL,
    creator TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(board, name)
);

CREATE TABLE IF NOT EXISTS agent_board_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel INTEGER NOT NULL REFERENCES agent_board_channels(id) ON DELETE CASCADE,
    topic INTEGER REFERENCES agent_board_posts(id) ON DELETE CASCADE,
    author TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    body TEXT NOT NULL,
    search_body TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_board_channel_posts ON agent_board_posts(channel, id);

CREATE INDEX IF NOT EXISTS agent_board_channel_topics ON agent_board_posts(channel, id) WHERE topic IS NULL;

CREATE INDEX IF NOT EXISTS agent_board_topic_posts ON agent_board_posts(topic, id);

CREATE TABLE IF NOT EXISTS agent_board_channel_members (
    channel INTEGER NOT NULL REFERENCES agent_board_channels(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    PRIMARY KEY(channel, member)
);

CREATE TABLE IF NOT EXISTS agent_board_topic_members (
    topic INTEGER NOT NULL REFERENCES agent_board_posts(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    PRIMARY KEY(topic, member)
);

CREATE TABLE IF NOT EXISTS agent_board_channel_opt_outs (
    channel INTEGER NOT NULL REFERENCES agent_board_channels(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    PRIMARY KEY(channel, member)
);

CREATE TABLE IF NOT EXISTS agent_board_topic_opt_outs (
    topic INTEGER NOT NULL REFERENCES agent_board_posts(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    PRIMARY KEY(topic, member)
);

CREATE TABLE IF NOT EXISTS agent_board_unread (
    board INTEGER NOT NULL REFERENCES agent_boards(id) ON DELETE CASCADE,
    member TEXT NOT NULL,
    post INTEGER NOT NULL REFERENCES agent_board_posts(id) ON DELETE CASCADE,
    target_kind INTEGER NOT NULL,
    target INTEGER NOT NULL,
    PRIMARY KEY(board, member, post)
);

CREATE INDEX IF NOT EXISTS agent_board_unread_target ON agent_board_unread(target_kind, target, member);

CREATE TABLE IF NOT EXISTS agent_board_commands (
    board INTEGER NOT NULL REFERENCES agent_boards(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    call TEXT NOT NULL,
    request TEXT NOT NULL,
    response TEXT NOT NULL,
    PRIMARY KEY(board, actor, call)
);
