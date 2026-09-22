use super::Store;
use super::board_id;
use super::channel_id;
use super::check_session;
use crate::Result;
use crate::model::Message;
use crate::model::OUTPUT_BYTES;
use crate::model::Read;
use crate::model::Scope;
use crate::model::channel_name;
use crate::model::input;
use crate::model::post_id;
use crate::model::search_term;
use base64::Engine;
use base64::prelude::BASE64_URL_SAFE_NO_PAD;
use protocol::ThreadId;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

const POSTS: &str = "SELECT p.id, COALESCE(p.topic,p.id), c.name, p.author, p.created_at, p.body,
    (SELECT COUNT(*) FROM agent_board_posts replies WHERE replies.topic=p.id)
    FROM agent_board_posts p JOIN agent_board_channels c ON c.id=p.channel";

#[derive(Serialize, Deserialize)]
struct Position {
    filter: String,
    before: i64,
}

impl Store {
    pub(crate) fn read(&self, scope: &Scope, request: &Read) -> Result<Value> {
        let mut database = self.connection()?;
        let transaction = database.transaction()?;
        check_session(&transaction, scope)?;
        let board = board_id(&transaction, scope)?;
        if let Read::Post { id, offset, chars } = request {
            post_id(*id)?;
            let chars = chars.unwrap_or(1000) as usize;
            if !(1..=4000).contains(&chars) {
                return Err(input("chars must be between 1 and 4000"));
            }
            let message = transaction
                .query_row(
                    &format!("{POSTS} WHERE c.board=?1 AND p.id=?2"),
                    params![board, id],
                    message,
                )
                .optional()?
                .ok_or_else(|| input("post does not exist in this board"))?;
            return body(message, *offset, chars);
        }
        let (cursor, limit) = match request {
            Read::Channels { cursor, limit, .. }
            | Read::Topics { cursor, limit, .. }
            | Read::Posts { cursor, limit, .. } => (cursor, limit.unwrap_or(20) as usize),
            Read::Post { .. } => unreachable!(),
        };
        if !(1..=50).contains(&limit) {
            return Err(input("limit must be between 1 and 50"));
        }
        let mut filters = serde_json::to_value(request)?;
        let object = filters.as_object_mut().expect("tagged read request");
        object.remove("cursor");
        object.remove("limit");
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(scope, filters))?)
        );
        let before = match cursor {
            None => None,
            Some(cursor) => {
                if cursor.len() > 512 {
                    return Err(input("cursor exceeds its maximum length"));
                }
                let bytes = BASE64_URL_SAFE_NO_PAD
                    .decode(cursor)
                    .map_err(|_| input("invalid cursor"))?;
                let position: Position =
                    serde_json::from_slice(&bytes).map_err(|_| input("invalid cursor"))?;
                if position.filter != fingerprint || position.before <= 0 {
                    return Err(input("cursor does not belong to this board and query"));
                }
                Some(position.before)
            }
        };
        let take = (limit + 1) as i64;
        let rows = match request {
            Read::Channels { query, .. } => {
                let query = search_term(query)?;
                let mut statement = transaction.prepare(
                    "SELECT c.id,c.name,c.creator,c.created_at,
                       (SELECT COUNT(*) FROM agent_board_posts p WHERE p.channel=c.id),
                       (SELECT MAX(id) FROM agent_board_posts p WHERE p.channel=c.id)
                     FROM agent_board_channels c WHERE board=?1 AND instr(search_name,?2)>0
                     AND (?3 IS NULL OR c.id<?3) ORDER BY c.id DESC LIMIT ?4",
                )?;
                statement
                    .query_map(params![board, query, before, take], |row| {
                        Ok((
                            row.get(0)?,
                            json!({
                                "channel": row.get::<_,String>(1)?,
                                "creator": row.get::<_,String>(2)?,
                                "created_at": row.get::<_,i64>(3)?,
                                "posts": row.get::<_,i64>(4)?,
                                "last_post": row.get::<_,Option<i64>>(5)?,
                            }),
                        ))
                    })?
                    .collect::<std::result::Result<Vec<_>, _>>()?
            }
            Read::Topics { channel, .. } => {
                channel_name(channel)?;
                let board = board.ok_or_else(|| input("channel does not exist in this board"))?;
                let channel = channel_id(&transaction, board, channel)?;
                collect(
                    &transaction,
                    &format!(
                        "{POSTS} WHERE c.board=?1 AND p.channel=?2 AND p.topic IS NULL
                     AND (?3 IS NULL OR p.id<?3) ORDER BY p.id DESC LIMIT ?4"
                    ),
                    params![board, channel, before, take],
                )?
            }
            Read::Posts {
                channel,
                topic,
                author,
                query,
                ..
            } => {
                if let Some(channel) = channel {
                    channel_name(channel)?;
                    channel_id(
                        &transaction,
                        board.ok_or_else(|| input("channel does not exist in this board"))?,
                        channel,
                    )?;
                }
                if let Some(topic) = topic {
                    post_id(*topic)?;
                    let exists: bool = transaction.query_row(
                        "SELECT EXISTS(SELECT 1 FROM agent_board_posts p JOIN agent_board_channels c ON c.id=p.channel
                         WHERE c.board=?1 AND p.id=?2 AND p.topic IS NULL)",
                        params![board, topic], |row| row.get(0),
                    )?;
                    if !exists {
                        return Err(input("topic does not exist in this board"));
                    }
                }
                let query = search_term(query)?;
                collect(
                    &transaction,
                    &format!(
                        "{POSTS} WHERE c.board=?1 AND (?2 IS NULL OR c.name=?2)
                     AND (?3 IS NULL OR p.topic=?3 OR p.id=?3)
                     AND (?4 IS NULL OR p.author=?4) AND instr(p.search_body,?5)>0
                     AND (?6 IS NULL OR p.id<?6) ORDER BY p.id DESC LIMIT ?7"
                    ),
                    params![
                        board,
                        channel,
                        topic,
                        author.as_ref().map(ThreadId::as_str),
                        query,
                        before,
                        take
                    ],
                )?
            }
            Read::Post { .. } => unreachable!(),
        };
        page(rows, limit, fingerprint)
    }
}

fn message(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
    let author = ThreadId::new(row.get::<_, String>(3)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Message {
        id: row.get(0)?,
        topic: row.get(1)?,
        channel: row.get(2)?,
        author,
        time: row.get(4)?,
        text: row.get(5)?,
        replies: row.get(6)?,
    })
}

fn collect(
    database: &Connection,
    sql: &str,
    values: impl rusqlite::Params,
) -> Result<Vec<(i64, Value)>> {
    let mut statement = database.prepare(sql)?;
    let mut entries = Vec::new();
    for record in statement.query_map(values, message)? {
        let record = record?;
        entries.push((record.id, record.summary(200)));
    }
    Ok(entries)
}

fn page(mut rows: Vec<(i64, Value)>, limit: usize, fingerprint: String) -> Result<Value> {
    let mut more = rows.len() > limit;
    rows.truncate(limit);
    loop {
        let cursor = if more {
            let last = rows
                .last()
                .ok_or_else(|| input("one result exceeds the response limit"))?
                .0;
            Some(BASE64_URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Position {
                filter: fingerprint.clone(),
                before: last,
            })?))
        } else {
            None
        };
        let value = json!({"items": rows.iter().map(|row| &row.1).collect::<Vec<_>>(), "next_cursor": cursor});
        if serde_json::to_vec(&value)?.len() <= OUTPUT_BYTES {
            return Ok(value);
        }
        rows.pop();
        more = true;
    }
}

fn body(message: Message, offset: usize, limit: usize) -> Result<Value> {
    let total = message.text.chars().count();
    if offset > total {
        return Err(input("offset is past the end of the post"));
    }
    let mut output = message.receipt();
    output["total_chars"] = total.into();
    output["next_offset"] = offset.into();
    output["text"] = "".into();
    // Reserve space for the final offset; charge every character its actual JSON escape cost.
    let overhead = serde_json::to_vec(&output)?.len() + 32;
    let mut budget = OUTPUT_BYTES
        .checked_sub(overhead)
        .ok_or_else(|| input("post metadata exceeds the response limit"))?;
    let mut text = String::new();
    let mut consumed = 0;
    for character in message.text.chars().skip(offset).take(limit) {
        let cost = serde_json::to_string(&character.to_string())?.len() - 2;
        if cost > budget {
            break;
        }
        text.push(character);
        budget -= cost;
        consumed += 1;
    }
    if consumed == 0 && offset < total {
        return Err(input("post metadata leaves no space for content"));
    }
    output["text"] = text.into();
    output["next_offset"] = if offset + consumed == total {
        Value::Null
    } else {
        (offset + consumed).into()
    };
    Ok(output)
}
