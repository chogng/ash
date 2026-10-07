use crate::MessageHistory;
use crate::MessageHistoryEntry;
use crate::MessageHistoryKind;
use crate::MessageHistoryPage;
use crate::MessageHistoryQuery;
use crate::MessageHistoryRecall;
use crate::MessageHistoryRecallEffect;
use crate::MessageHistoryStore;
use crate::MessageHistorySubmission;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(5);
type ReadCall = (MessageHistoryQuery, mpsc::Sender<MessageHistoryPage>);

struct Store {
    calls: mpsc::Sender<ReadCall>,
    appended: Mutex<Vec<MessageHistorySubmission>>,
}

impl MessageHistoryStore for Store {
    fn append(&self, submission: MessageHistorySubmission) -> Result<MessageHistoryEntry, String> {
        self.appended.lock().unwrap().push(submission.clone());
        Ok(MessageHistoryEntry {
            id: 1,
            submitted_at_ms: 0,
            submission,
        })
    }
    fn read(&self, query: &MessageHistoryQuery) -> Result<MessageHistoryPage, String> {
        let (reply, receive) = mpsc::channel();
        self.calls.send((query.clone(), reply)).unwrap();
        receive
            .recv_timeout(TIMEOUT)
            .map_err(|error| error.to_string())
    }
    fn clear(&self) -> Result<(), String> {
        self.appended.lock().unwrap().clear();
        Ok(())
    }
}

fn entry(id: u64, text: &str) -> MessageHistoryEntry {
    MessageHistoryEntry {
        id,
        submitted_at_ms: 0,
        submission: MessageHistorySubmission {
            text: text.into(),
            kind: MessageHistoryKind::Agent,
            thread_id: None,
        },
    }
}

fn recalled(effect: MessageHistoryRecallEffect) -> String {
    match effect {
        MessageHistoryRecallEffect::Recall(input) => input.text,
        _ => panic!("expected recalled input"),
    }
}

#[test]
fn changing_search_discards_old_results_and_paginates_to_unique_matches() {
    let (calls, received) = mpsc::channel();
    let store = Arc::new(Store {
        calls,
        appended: Mutex::new(Vec::new()),
    });
    let (wake, awakened) = mpsc::channel();
    let client = MessageHistory::with_waker(store, move || {
        let _ = wake.send(());
    })
    .unwrap();
    let mut recall = MessageHistoryRecall::default();
    recall.connect(client);
    recall.search("old".into());
    let (query, old_reply) = received.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(query.text, "old");
    recall.search("new".into());
    old_reply
        .send(MessageHistoryPage {
            entries: vec![entry(8, "old result")],
            next_before: None,
        })
        .unwrap();
    awakened.recv_timeout(TIMEOUT).unwrap();
    assert!(matches!(recall.poll().1, MessageHistoryRecallEffect::Keep));
    let (query, reply) = received.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(query.text, "new");
    reply
        .send(MessageHistoryPage {
            entries: vec![entry(7, "new result")],
            next_before: Some(7),
        })
        .unwrap();
    awakened.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(recalled(recall.poll().1), "new result");
    recall.older();
    let (query, reply) = received.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(query.before, Some(7));
    reply
        .send(MessageHistoryPage {
            entries: vec![entry(6, "new result")],
            next_before: Some(6),
        })
        .unwrap();
    awakened.recv_timeout(TIMEOUT).unwrap();
    recall.poll();
    let (query, reply) = received.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(query.before, Some(6));
    reply
        .send(MessageHistoryPage {
            entries: vec![entry(5, "new older")],
            next_before: None,
        })
        .unwrap();
    awakened.recv_timeout(TIMEOUT).unwrap();
    assert_eq!(recalled(recall.poll().1), "new older");
    assert_eq!(recalled(recall.newer()), "new result");
    assert!(matches!(recall.accept(), MessageHistoryRecallEffect::Keep));
    assert!(!recall.active());
}

#[test]
fn cancelling_a_pending_read_never_recalls_its_result() {
    let (calls, received) = mpsc::channel();
    let (wake, awakened) = mpsc::channel();
    let client = MessageHistory::with_waker(
        Arc::new(Store {
            calls,
            appended: Mutex::new(Vec::new()),
        }),
        move || {
            let _ = wake.send(());
        },
    )
    .unwrap();
    let mut recall = MessageHistoryRecall::default();
    recall.connect(client);
    recall.older();
    let (_, reply) = received.recv_timeout(TIMEOUT).unwrap();
    assert!(matches!(
        recall.newer(),
        MessageHistoryRecallEffect::Restore
    ));
    reply
        .send(MessageHistoryPage {
            entries: vec![entry(1, "must not replace draft")],
            next_before: None,
        })
        .unwrap();
    awakened.recv_timeout(TIMEOUT).unwrap();
    assert!(matches!(recall.poll().1, MessageHistoryRecallEffect::Keep));
    assert!(!recall.active());
}

#[test]
fn dropping_the_last_client_drains_accepted_writes() {
    let (calls, _) = mpsc::channel();
    let store = Arc::new(Store {
        calls,
        appended: Mutex::new(Vec::new()),
    });
    let client = MessageHistory::new(store.clone()).unwrap();
    let expected = (0..10)
        .map(|id| entry(id, &format!("input {id}")).submission)
        .collect::<Vec<_>>();
    for submission in &expected {
        client.append(submission.clone()).unwrap();
    }
    drop(client);
    assert_eq!(*store.appended.lock().unwrap(), expected);
}
