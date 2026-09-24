use super::MAX_THREAD_PRESENTATIONS;
use super::ThreadPresentationStore;
use crate::thread::composer::ChatInputCatalog;
use crate::thread::composer::ChatInputQueueOutcome;
use crate::thread::composer::CompletionView;
use crate::thread::composer::built_in_slash_command_definitions;
use ash_protocol::ThreadId;
use ash_slash_commands::SlashCommandArgumentMode;
use ash_slash_commands::SlashCommandCatalog;
use ash_slash_commands::SlashCommandDefinition;

#[test]
fn switching_threads_restores_draft_and_queue_together() {
    let main = thread_id("main");
    let child = thread_id("child");
    let mut store = ThreadPresentationStore::new(main.clone());
    store.active_mut().input.insert_text("main draft");
    let ChatInputQueueOutcome::Queued(queued) = store.active_mut().input.queue_current() else {
        panic!("expected queued input");
    };
    store.active_mut().queue.push(queued);
    store.active_mut().input.insert_text("main remaining draft");
    store.switch(child);
    store.active_mut().input.insert_text("child draft");
    store.switch(main);

    assert_eq!(store.active().input.text(), "main remaining draft");
    assert_eq!(
        store
            .active()
            .queue
            .view(&crate::thread::queue::QueueNavigation::default())
            .items[0]
            .text,
        "main draft"
    );
}

#[test]
fn refreshed_completion_catalog_reaches_existing_and_future_threads() {
    let main = thread_id("main");
    let child = thread_id("child");
    let future = thread_id("future");
    let mut store = ThreadPresentationStore::new(main.clone());
    store.switch(child.clone());
    store.switch(main.clone());
    let catalog = SlashCommandCatalog::with_local_and_server(
        built_in_slash_command_definitions(),
        [SlashCommandDefinition {
            name: "diagnose".into(),
            description: "inspect the current dir".into(),
            argument_mode: SlashCommandArgumentMode::Optional,
            argument_hint: None,
        }],
    )
    .unwrap();

    store.replace_input_catalog(ChatInputCatalog::with_slash_commands(catalog));

    for thread in [main, child, future] {
        store.switch(thread);
        store.active_mut().input.insert_text("/diag");
        let Some(CompletionView::Slash(view)) = store.active().input.completion() else {
            panic!("expected Slash completion");
        };
        assert_eq!(view.commands[0].name, "diagnose");
    }
}

#[test]
fn thread_presentations_evict_the_least_recent_inactive_thread() {
    let first = thread_id("thread-0");
    let retained = thread_id("thread-1");
    let mut store = ThreadPresentationStore::new(first.clone());

    for index in 1..MAX_THREAD_PRESENTATIONS {
        store.switch(thread_id(&format!("thread-{index}")));
    }
    store.switch(retained.clone());
    store.switch(thread_id(&format!("thread-{MAX_THREAD_PRESENTATIONS}")));

    assert_eq!(store.len(), MAX_THREAD_PRESENTATIONS);
    assert!(!store.contains(&first));
    assert!(store.contains(&retained));
    assert!(store.contains(&thread_id(&format!("thread-{MAX_THREAD_PRESENTATIONS}"))));
}

fn thread_id(value: &str) -> ThreadId {
    ThreadId::new(value).unwrap()
}

#[test]
fn status_indicator_timer_survives_thread_switching() {
    let now = std::time::Instant::now();
    let main = thread_id("timer-main");
    let mut store = ThreadPresentationStore::new(main.clone());
    store.active_mut().status_timer.start(now);
    store.switch(thread_id("timer-child"));
    store
        .active_mut()
        .status_timer
        .start(now + std::time::Duration::from_secs(10));
    store.switch(main);
    store
        .active_mut()
        .status_timer
        .tick(now + std::time::Duration::from_secs(30));
    assert_eq!(
        store.active().status_timer.elapsed(),
        std::time::Duration::from_secs(30)
    );
}
