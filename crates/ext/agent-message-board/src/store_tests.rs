use crate::Store;
use crate::model::Commit;
use crate::model::Read;
use crate::model::Scope;
use crate::model::Write;
use protocol::SessionId;
use protocol::ThreadId;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::sync::Barrier;

fn board_scope(session: &str, root: &str) -> Scope {
    Scope {
        session: SessionId::new(session).unwrap(),
        root: ThreadId::new(root).unwrap(),
    }
}

fn write(store: &Store, scope: &Scope, actor: &str, key: &str, args: Value) -> Commit {
    store
        .write(
            scope,
            &ThreadId::new(actor).unwrap(),
            key,
            100,
            &serde_json::from_value::<Write>(args).unwrap(),
        )
        .unwrap()
}

fn read(store: &Store, scope: &Scope, args: Value) -> Value {
    read_as(store, scope, &scope.root, args)
}

fn read_as(store: &Store, scope: &Scope, member: &ThreadId, args: Value) -> Value {
    let result = store
        .read(
            scope,
            member,
            &serde_json::from_value::<Read>(args).unwrap(),
        )
        .unwrap();
    assert!(serde_json::to_vec(&result).unwrap().len() <= 8000);
    result
}

fn channel(store: &Store, scope: &Scope) {
    write(
        store,
        scope,
        "root",
        "create",
        json!({"action":"create_channel","channel":"work"}),
    );
}

#[test]
fn topic_index_is_installed_on_reopen_and_pagination_excludes_replies() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("board.sqlite3");
    let scope = board_scope("session", "root");
    let store = Store::open(&path).unwrap();
    channel(&store, &scope);
    let mut ids = Vec::new();
    for number in 0..3 {
        let topic = write(
            &store,
            &scope,
            "root",
            &format!("topic-{number}"),
            json!({"action":"post","channel":"work","text":format!("topic {number}")}),
        );
        let id = topic.output["id"].as_i64().unwrap();
        ids.push(id);
        for reply in 0..10 {
            write(
                &store,
                &scope,
                "worker",
                &format!("reply-{number}-{reply}"),
                json!({"action":"post","channel":"work","topic":id,"text":"reply"}),
            );
        }
    }
    drop(store);
    let connection = rusqlite::Connection::open(&path).unwrap();
    connection
        .execute("DROP INDEX agent_board_channel_topics", [])
        .unwrap();
    let reopened = Store::open(&path).unwrap();
    let first = read(
        &reopened,
        &scope,
        json!({"action":"topics","channel":"work","limit":2}),
    );
    assert_eq!(first["items"][0]["id"], ids[2]);
    assert_eq!(first["items"][1]["id"], ids[1]);
    assert_eq!(first["items"][0]["replies"], 10);
    let next = read(
        &reopened,
        &scope,
        json!({"action":"topics","channel":"work","limit":2,"cursor":first["next_cursor"]}),
    );
    assert_eq!(next["items"].as_array().unwrap().len(), 1);
    assert_eq!(next["items"][0]["id"], ids[0]);
    connection.execute_batch("ANALYZE").unwrap();
    let plan = connection.prepare(
        "EXPLAIN QUERY PLAN SELECT p.id, COALESCE(p.topic,p.id), c.name, p.author, p.created_at, p.body,
         (SELECT COUNT(*) FROM agent_board_posts replies WHERE replies.topic=p.id)
         FROM agent_board_posts p JOIN agent_board_channels c ON c.id=p.channel
         WHERE c.board=?1 AND p.channel=?2 AND p.topic IS NULL
         ORDER BY p.id DESC LIMIT ?4"
    ).unwrap().query_map(rusqlite::params![1, 1, Option::<i64>::None, 3], |row| row.get::<_, String>(3))
        .unwrap().collect::<std::result::Result<Vec<_>, _>>().unwrap().join("\n");
    assert!(plan.contains("agent_board_channel_topics"), "{plan}");
}

#[test]
fn channel_and_topic_subscriptions_route_different_events_and_deduplicate_members() {
    let store = Store::in_memory().unwrap();
    let scope = board_scope("session", "root");
    channel(&store, &scope);
    write(
        &store,
        &scope,
        "reader",
        "subscribe",
        json!({
            "action":"subscription","channel":"work","state":"on"
        }),
    );
    let root = write(
        &store,
        &scope,
        "worker",
        "first",
        json!({
            "action":"post","channel":"work","text":"evidence","notify":["reader","reader","worker"]
        }),
    );
    assert_eq!(
        store
            .unread(&scope, &ThreadId::new("reader").unwrap())
            .unwrap()
            .count,
        1
    );
    assert_eq!(
        store
            .unread(&scope, &ThreadId::new("root").unwrap())
            .unwrap()
            .count,
        1
    );
    assert_eq!(
        store
            .unread(&scope, &ThreadId::new("worker").unwrap())
            .unwrap()
            .count,
        0
    );
    let id = root.output["id"].as_i64().unwrap();
    let reply = write(
        &store,
        &scope,
        "reviewer",
        "reply",
        json!({
            "action":"post","channel":"work","topic":id,"text":"verified"
        }),
    );
    assert_eq!(
        store
            .unread(&scope, &ThreadId::new("worker").unwrap())
            .unwrap()
            .through,
        reply.output["id"]
    );
    write(
        &store,
        &scope,
        "worker",
        "stop",
        json!({
            "action":"subscription","channel":"work","topic":id,"state":"off"
        }),
    );
    assert_eq!(
        store
            .unread(&scope, &ThreadId::new("worker").unwrap())
            .unwrap()
            .count,
        0
    );
    let followup = write(
        &store,
        &scope,
        "root",
        "next",
        json!({
            "action":"post","channel":"work","topic":id,"text":"accepted"
        }),
    );
    assert_eq!(
        store
            .unread(&scope, &ThreadId::new("reviewer").unwrap())
            .unwrap()
            .through,
        followup.output["id"]
    );
    let topics = read(&store, &scope, json!({"action":"topics","channel":"work"}));
    assert_eq!(topics["items"][0]["replies"], 2);
    assert_eq!(topics["items"][0]["id"], id);
    let post = read(
        &store,
        &scope,
        json!({"action":"post","id":reply.output["id"]}),
    );
    assert_eq!(post["text"], "verified");
}

#[test]
fn explicit_topic_unsubscribe_survives_post_and_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("board.sqlite3");
    let scope = board_scope("session", "root");
    let store = Store::open(&path).unwrap();
    channel(&store, &scope);
    let first = write(
        &store,
        &scope,
        "worker",
        "first",
        json!({"action":"post","channel":"work","text":"first"}),
    );
    let topic = first.output["id"].as_i64().unwrap();
    drop(store);

    // A database created before opt-outs existed must gain them when opened again.
    let database = rusqlite::Connection::open(&path).unwrap();
    database
        .execute_batch(
            "DROP TABLE IF EXISTS agent_board_channel_opt_outs;
             DROP TABLE IF EXISTS agent_board_topic_opt_outs;",
        )
        .unwrap();
    drop(database);

    let store = Store::open(&path).unwrap();
    write(
        &store,
        &scope,
        "worker",
        "unsubscribe",
        json!({"action":"subscription","channel":"work","topic":topic,"state":"off"}),
    );
    drop(store);

    let store = Store::open(&path).unwrap();
    write(
        &store,
        &scope,
        "worker",
        "worker-reply",
        json!({"action":"post","channel":"work","topic":topic,"text":"more evidence"}),
    );
    write(
        &store,
        &scope,
        "root",
        "root-reply",
        json!({"action":"post","channel":"work","topic":topic,"text":"reviewed"}),
    );
    assert_eq!(
        store
            .unread(&scope, &ThreadId::new("worker").unwrap())
            .unwrap()
            .count,
        0
    );

    write(
        &store,
        &scope,
        "worker",
        "resubscribe",
        json!({"action":"subscription","channel":"work","topic":topic,"state":"on"}),
    );
    let followup = write(
        &store,
        &scope,
        "root",
        "followup",
        json!({"action":"post","channel":"work","topic":topic,"text":"done"}),
    );
    assert_eq!(
        store
            .unread(&scope, &ThreadId::new("worker").unwrap())
            .unwrap()
            .through,
        followup.output["id"]
    );
}

#[test]
fn unread_survives_reopen_and_resubscription_starts_with_new_posts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("board.sqlite3");
    let scope = board_scope("session", "root");
    let reader = ThreadId::new("reader").unwrap();
    let store = Store::open(&path).unwrap();
    channel(&store, &scope);
    write(
        &store,
        &scope,
        "reader",
        "watch",
        json!({"action":"subscription","channel":"work","state":"on"}),
    );
    let first = write(
        &store,
        &scope,
        "root",
        "first",
        json!({"action":"post","channel":"work","text":"first"}),
    );
    drop(store);

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.unread(&scope, &reader).unwrap().through,
        first.output["id"]
    );
    write(
        &store,
        &scope,
        "reader",
        "off",
        json!({"action":"subscription","channel":"work","state":"off"}),
    );
    assert_eq!(store.unread(&scope, &reader).unwrap().count, 0);
    write(
        &store,
        &scope,
        "root",
        "muted",
        json!({"action":"post","channel":"work","text":"while muted"}),
    );
    write(
        &store,
        &scope,
        "reader",
        "on",
        json!({"action":"subscription","channel":"work","state":"on"}),
    );
    let fresh = write(
        &store,
        &scope,
        "root",
        "fresh",
        json!({"action":"post","channel":"work","text":"fresh"}),
    );
    let unread = store.unread(&scope, &reader).unwrap();
    assert_eq!(unread.count, 1);
    assert_eq!(unread.through, fresh.output["id"]);
    assert_eq!(unread.notices[0]["preview"], "fresh");
    let ack = write(
        &store,
        &scope,
        "reader",
        "ack",
        json!({"action":"acknowledge","through":fresh.output["id"]}),
    );
    assert_eq!(ack.output["acknowledged"], 1);
    assert_eq!(store.unread(&scope, &reader).unwrap().count, 0);
    assert_eq!(
        write(
            &store,
            &scope,
            "reader",
            "ack",
            json!({"action":"acknowledge","through":fresh.output["id"]}),
        )
        .output,
        ack.output
    );
}

#[test]
fn unread_pages_span_channels_and_belong_to_one_agent() {
    let store = Store::in_memory().unwrap();
    let scope = board_scope("session", "root");
    let reader = ThreadId::new("reader").unwrap();
    let other = ThreadId::new("other").unwrap();
    channel(&store, &scope);
    write(
        &store,
        &scope,
        "root",
        "create-news",
        json!({"action":"create_channel","channel":"news"}),
    );
    write(
        &store,
        &scope,
        "reader",
        "watch-work",
        json!({"action":"subscription","channel":"work","state":"on"}),
    );
    let mut ids = Vec::new();
    for (key, channel) in [("one", "work"), ("two", "news"), ("three", "work")] {
        ids.push(
            write(
                &store,
                &scope,
                "worker",
                key,
                json!({"action":"post","channel":channel,"text":key,"notify":["reader","other"]}),
            )
            .output["id"]
                .clone(),
        );
    }
    let first = read_as(
        &store,
        &scope,
        &reader,
        json!({"action":"unread","limit":2}),
    );
    assert_eq!(first["items"][0]["id"], ids[2]);
    assert_eq!(first["items"][1]["id"], ids[1]);
    assert_eq!(first["items"][1]["channel"], "news");
    assert!(
        store
            .read(
                &scope,
                &other,
                &serde_json::from_value(json!({
                    "action":"unread","limit":2,"cursor":first["next_cursor"]
                }))
                .unwrap()
            )
            .is_err()
    );
    let second = read_as(
        &store,
        &scope,
        &reader,
        json!({"action":"unread","limit":2,"cursor":first["next_cursor"]}),
    );
    assert_eq!(second["items"][0]["id"], ids[0]);
    assert!(second["next_cursor"].is_null());
    write(
        &store,
        &scope,
        "reader",
        "reviewed",
        json!({"action":"acknowledge","through":ids[1]}),
    );
    assert_eq!(
        read_as(&store, &scope, &reader, json!({"action":"unread"}))["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        read_as(&store, &scope, &other, json!({"action":"unread"}))["items"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn concurrent_duplicate_operations_commit_once_and_survive_reopening() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let scope = board_scope("session", "root");
    channel(&Store::open(&path).unwrap(), &scope);
    let stores = [Store::open(&path).unwrap(), Store::open(&path).unwrap()];
    let gate = Arc::new(Barrier::new(2));
    let workers = stores
        .into_iter()
        .map(|store| {
            let scope = scope.clone();
            let gate = gate.clone();
            std::thread::spawn(move || {
                gate.wait();
                write(
                    &store,
                    &scope,
                    "worker",
                    "same",
                    json!({
                        "action":"post","channel":"work","text":"one record"
                    }),
                )
            })
        })
        .collect::<Vec<_>>();
    let mut results = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(results[0].output, results[1].output);
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store
            .unread(&scope, &ThreadId::new("root").unwrap())
            .unwrap()
            .count,
        1
    );
    let replay = write(
        &store,
        &scope,
        "worker",
        "same",
        json!({"action":"post","channel":"work","text":"one record"}),
    );
    assert_eq!(replay.output, results.pop().unwrap().output);
    assert_eq!(
        store
            .unread(&scope, &ThreadId::new("root").unwrap())
            .unwrap()
            .count,
        1
    );
    let changed: Write =
        serde_json::from_value(json!({"action":"post","channel":"work","text":"changed"})).unwrap();
    assert!(
        store
            .write(
                &scope,
                &ThreadId::new("worker").unwrap(),
                "same",
                200,
                &changed
            )
            .is_err()
    );
    assert_eq!(
        read(&store, &scope, json!({"action":"posts"}))["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // Channel creation uses the same durable replay contract.
    channel(&store, &scope);
    assert_eq!(
        read(&store, &scope, json!({"action":"channels"}))["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn pagination_keeps_its_position_when_new_messages_arrive() {
    let store = Store::in_memory().unwrap();
    let scope = board_scope("session", "root");
    channel(&store, &scope);
    let mut ids = Vec::new();
    for number in 0..5 {
        ids.push(
            write(
                &store,
                &scope,
                "worker",
                &number.to_string(),
                json!({
                    "action":"post","channel":"work","text":format!("record {number}")
                }),
            )
            .output["id"]
                .clone(),
        );
    }
    let first = read(&store, &scope, json!({"action":"posts","limit":2}));
    assert_eq!(first["items"][0]["id"], ids[4]);
    write(
        &store,
        &scope,
        "worker",
        "later",
        json!({"action":"post","channel":"work","text":"new"}),
    );
    let second = read(
        &store,
        &scope,
        json!({"action":"posts","limit":2,"cursor":first["next_cursor"]}),
    );
    assert_eq!(second["items"][0]["id"], ids[2]);
    assert_eq!(second["items"][1]["id"], ids[1]);
    let last = read(
        &store,
        &scope,
        json!({"action":"posts","limit":2,"cursor":second["next_cursor"]}),
    );
    assert_eq!(last["items"][0]["id"], ids[0]);
    assert!(last["next_cursor"].is_null());
    for (other, args) in [
        (
            scope.clone(),
            json!({"action":"posts","query":"record","cursor":first["next_cursor"]}),
        ),
        (
            board_scope("session", "another"),
            json!({"action":"posts","cursor":first["next_cursor"]}),
        ),
        (
            scope.clone(),
            json!({"action":"channels","cursor":first["next_cursor"]}),
        ),
    ] {
        assert!(
            store
                .read(&other, &other.root, &serde_json::from_value(args).unwrap())
                .is_err()
        );
    }
}

#[test]
fn search_and_character_reads_preserve_unicode_and_escaped_text() {
    let store = Store::in_memory().unwrap();
    let scope = board_scope("session", "root");
    channel(&store, &scope);
    let text = "Straße 😀\"\\\n".repeat(3000);
    let post = write(
        &store,
        &scope,
        "worker",
        "unicode",
        json!({"action":"post","channel":"work","text":text}),
    );
    let found = read(
        &store,
        &scope,
        json!({"action":"posts","query":"STRASSE","author":"worker"}),
    );
    assert_eq!(found["items"][0]["id"], post.output["id"]);
    assert_eq!(found["items"][0]["total_chars"], text.chars().count());
    let mut offset = 0;
    let mut restored = String::new();
    loop {
        let part = read(
            &store,
            &scope,
            json!({"action":"post","id":post.output["id"],"offset":offset,"chars":4000}),
        );
        restored.push_str(part["text"].as_str().unwrap());
        if part["next_offset"].is_null() {
            break;
        }
        let next = part["next_offset"].as_u64().unwrap();
        assert!(next > offset);
        offset = next;
    }
    assert_eq!(restored, text);
    let eof = read(
        &store,
        &scope,
        json!({"action":"post","id":post.output["id"],"offset":text.chars().count()}),
    );
    assert_eq!(eof["text"], "");
    assert!(eof["next_offset"].is_null());
}

#[test]
fn output_budget_trims_pages_without_losing_the_remaining_messages() {
    let store = Store::in_memory().unwrap();
    let scope = board_scope("session", "root");
    channel(&store, &scope);
    let mut expected = Vec::new();
    for index in 0..30 {
        expected.push(
            write(
                &store,
                &scope,
                "worker",
                &format!("post-{index}"),
                json!({
                    "action":"post","channel":"work","text":"\u{0001}".repeat(500)
                }),
            )
            .output["id"]
                .as_i64()
                .unwrap(),
        );
    }
    let mut actual = Vec::new();
    let mut cursor = Value::Null;
    loop {
        let page = read(
            &store,
            &scope,
            json!({"action":"posts","limit":50,"cursor":cursor}),
        );
        assert!(!page["items"].as_array().unwrap().is_empty());
        actual.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].as_i64().unwrap()),
        );
        cursor = page["next_cursor"].clone();
        if cursor.is_null() {
            break;
        }
    }
    expected.reverse();
    assert_eq!(actual, expected);
}

#[test]
fn invalid_topics_and_deleted_sessions_cannot_mutate_other_boards() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let store = Store::open(&path).unwrap();
    let a = board_scope("one", "root");
    let b = board_scope("one", "other");
    let c = board_scope("two", "root");
    for scope in [&a, &b, &c] {
        channel(&store, scope);
    }
    let post = write(
        &store,
        &a,
        "root",
        "post",
        json!({"action":"post","channel":"work","text":"private"}),
    );
    write(
        &store,
        &a,
        "root",
        "unfollow-topic",
        json!({"action":"subscription","channel":"work","topic":post.output["id"],"state":"off"}),
    );
    write(
        &store,
        &a,
        "root",
        "unfollow-channel",
        json!({"action":"subscription","channel":"work","state":"off"}),
    );
    let bad: Write = serde_json::from_value(
        json!({"action":"post","channel":"work","topic":post.output["id"],"text":"bad"}),
    )
    .unwrap();
    assert!(store.write(&b, &b.root, "cross-board", 0, &bad).is_err());
    let invalid: Read =
        serde_json::from_value(json!({"action":"post","id":post.output["id"]})).unwrap();
    assert!(store.read(&b, &b.root, &invalid).is_err());
    assert!(store.read(&c, &c.root, &invalid).is_err());
    store.delete_session(&a.session).unwrap();
    let stale = Store::open(&path).unwrap();
    let command: Write =
        serde_json::from_value(json!({"action":"create_channel","channel":"revived"})).unwrap();
    for scope in [&a, &b] {
        assert!(
            stale
                .write(scope, &scope.root, "stale", 0, &command)
                .is_err()
        );
        assert!(
            stale
                .read(
                    scope,
                    &scope.root,
                    &serde_json::from_value(json!({"action":"channels"})).unwrap()
                )
                .is_err()
        );
    }
    assert_eq!(
        read(&stale, &c, json!({"action":"channels"}))["items"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let database = rusqlite::Connection::open(&path).unwrap();
    for table in ["agent_board_channels", "agent_board_commands"] {
        let remaining: i64 = database
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining, 1);
    }
    for table in ["agent_board_channel_opt_outs", "agent_board_topic_opt_outs"] {
        let remaining: i64 = database
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(remaining, 0);
    }
    assert_eq!(
        database
            .query_row("SELECT COUNT(*) FROM agent_board_posts", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn rejected_output_receipts_roll_back_the_entire_mutation() {
    let store = Store::in_memory().unwrap();
    let scope = board_scope("session", "root");
    let actor = ThreadId::new("a".repeat(9000)).unwrap();
    let command = Write::CreateChannel {
        channel: "too-big".into(),
    };
    assert!(store.write(&scope, &actor, "create", 0, &command).is_err());
    assert!(
        read(&store, &scope, json!({"action":"channels"}))["items"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
