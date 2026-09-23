use super::*;
use protocol::SessionId;
use rusqlite::StatementStatus;
use rusqlite::ToSql;

fn populated() -> Store {
    let store = Store::in_memory().unwrap();
    store.connection().unwrap().execute_batch(
        "INSERT INTO agent_board_sessions VALUES ('session',0),('other',0);
         INSERT INTO agent_boards VALUES (1,'session','root'),(2,'other','root');
         INSERT INTO agent_board_channels VALUES
           (1,1,'work','work','root',0),(2,1,'noise','noise','root',0),(3,2,'work','work','root',0);
         INSERT INTO agent_board_posts VALUES (1,1,NULL,'root',0,'target','target');
         WITH RECURSIVE n(id) AS (VALUES(2) UNION ALL SELECT id+1 FROM n WHERE id<1001)
         INSERT INTO agent_board_posts SELECT id,1,1,'worker',0,'target reply','target reply' FROM n;
         WITH RECURSIVE n(id) AS (VALUES(1002) UNION ALL SELECT id+1 FROM n WHERE id<11001)
         INSERT INTO agent_board_posts SELECT id,2,NULL,'root',0,'noise','noise' FROM n;
         INSERT INTO agent_board_posts VALUES (11002,3,NULL,'worker',0,'target','target');
         ANALYZE;"
    ).unwrap();
    store
}

fn run(database: &Connection, sql: &str, values: &[&dyn ToSql]) -> (Vec<i64>, i32) {
    let mut statement = database.prepare(sql).unwrap();
    let ids = statement
        .query_map(values, |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    (ids, statement.get_status(StatementStatus::VmStep))
}

fn plan(database: &Connection, sql: &str, values: &[&dyn ToSql]) -> String {
    database
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
        .unwrap()
        .query_map(values, |row| row.get::<_, String>(3))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap()
        .join("\n")
}

#[test]
fn topic_pages_seek_past_newer_roots_without_rescanning_them() {
    let store = populated();
    let database = store.connection().unwrap();
    let values: &[&dyn ToSql] = &[&1, &2, &1100, &21];
    let old_sql = format!(
        "{POSTS} WHERE c.board=?1 AND p.channel=?2 AND p.topic IS NULL
        AND (?3 IS NULL OR p.id<?3) ORDER BY p.id DESC LIMIT ?4"
    );
    let sql = topics_sql(Some(1100));
    let old = run(&database, &old_sql, values);
    let new = run(&database, &sql, values);
    assert_eq!(new.0, old.0);
    assert_eq!(new.0.len(), 21);
    let plan = plan(&database, &sql, values);
    // This fixture's channel contains only roots, so either channel index is equally selective.
    assert!(plan.contains("(channel=? AND id<?)"), "{plan}");
    assert!(!plan.contains("USE TEMP B-TREE"), "{plan}");
    assert!(new.1 * 10 < old.1, "old={} new={}", old.1, new.1);
    println!("topic page SQL steps: {} -> {}", old.1, new.1);
}

#[test]
fn topic_posts_use_bounded_index_ranges_for_root_and_replies() {
    let store = populated();
    let database = store.connection().unwrap();
    let values: &[&dyn ToSql] = &[
        &1,
        &Option::<String>::None,
        &1,
        &Option::<String>::None,
        &"",
        &Option::<i64>::None,
        &21,
    ];
    let old_sql = format!(
        "{POSTS} WHERE c.board=?1 AND (?2 IS NULL OR c.name=?2)
        AND (?3 IS NULL OR p.topic=?3 OR p.id=?3)
        AND (?4 IS NULL OR p.author=?4) AND instr(p.search_body,?5)>0
        AND (?6 IS NULL OR p.id<?6) ORDER BY p.id DESC LIMIT ?7"
    );
    let sql = posts_sql(None, Some(1), None, "", None);
    let old = run(&database, &old_sql, values);
    let new = run(&database, &sql, values);
    assert_eq!(new.0, old.0);
    assert_eq!(new.0, (981..=1001).rev().collect::<Vec<_>>());
    let plan = plan(&database, &sql, values);
    assert!(plan.contains("agent_board_topic_posts"), "{plan}");
    assert!(plan.contains("INTEGER PRIMARY KEY"), "{plan}");
    assert!(
        new.1 < 2000,
        "count only visible roots, not an off-page root's thousand replies: {}",
        new.1
    );
    assert!(new.1 * 10 < old.1, "old={} new={}", old.1, new.1);
    println!("topic posts SQL steps: {} -> {}", old.1, new.1);
}

#[test]
fn topic_read_keeps_root_filters_cursor_and_board_isolation() {
    let store = populated();
    let scope = Scope {
        session: SessionId::new("session").unwrap(),
        root: ThreadId::new("root").unwrap(),
    };
    let mut request = json!({"action":"posts","topic":1,"limit":50});
    let mut ids = Vec::new();
    loop {
        let page = store
            .read(
                &scope,
                &scope.root,
                &serde_json::from_value(request.clone()).unwrap(),
            )
            .unwrap();
        ids.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_i64().unwrap()),
        );
        if page["next_cursor"].is_null() {
            break;
        }
        request["cursor"] = page["next_cursor"].clone();
    }
    assert_eq!(ids, (1..=1001).rev().collect::<Vec<_>>());
    for (filters, expected) in [
        (
            json!({"channel":"work","author":"root","query":"TARGET"}),
            vec![1],
        ),
        (json!({"channel":"noise"}), vec![]),
        (json!({"query":"missing"}), vec![]),
    ] {
        let mut request = json!({"action":"posts","topic":1});
        request
            .as_object_mut()
            .unwrap()
            .extend(filters.as_object().unwrap().clone());
        let page = store
            .read(
                &scope,
                &scope.root,
                &serde_json::from_value(request).unwrap(),
            )
            .unwrap();
        assert_eq!(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|row| row["id"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            expected
        );
    }
    assert!(
        store
            .read(
                &scope,
                &scope.root,
                &serde_json::from_value(json!({"action":"posts","topic":11002})).unwrap()
            )
            .is_err()
    );
}
