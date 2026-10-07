use crate::CancellationId;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::task::{Context, Poll, Waker};

static NEXT_CANCELLATION_ID: AtomicU64 = AtomicU64::new(1);

pub(super) struct Signal<R> {
    pub(super) origin: CancellationId,
    pub(super) reason: R,
}

pub(super) struct Node<R> {
    pub(super) id: CancellationId,
    state: Mutex<State<R>>,
}

impl<R> Node<R> {
    pub(super) fn active() -> Self {
        Self {
            id: next_id(),
            state: Mutex::new(State::default()),
        }
    }

    pub(super) fn child_of(parent: &Arc<Self>) -> Arc<Self> {
        let child = Arc::new(Self {
            id: next_id(),
            state: Mutex::new(State::default()),
        });
        let inherited_signal = {
            let mut state = lock_state(parent);
            if let Some(signal) = state.signal.clone() {
                Some(signal)
            } else {
                state.children.retain(|child| child.strong_count() > 0);
                state.children.push(Arc::downgrade(&child));
                None
            }
        };
        if let Some(signal) = inherited_signal {
            cancel_tree(child.clone(), signal);
        }
        child
    }
}

pub(super) fn is_cancelled<R>(node: &Node<R>) -> bool {
    lock_state(node).signal.is_some()
}

pub(super) fn signal<R>(node: &Node<R>) -> Option<Arc<Signal<R>>> {
    lock_state(node).signal.clone()
}

pub(super) fn poll_cancelled<R>(
    node: &Node<R>,
    context: &mut Context<'_>,
    waiter_id: &mut Option<u64>,
) -> Poll<Arc<Signal<R>>> {
    let mut state = lock_state(node);
    if let Some(signal) = state.signal.clone() {
        *waiter_id = None;
        return Poll::Ready(signal);
    }

    match *waiter_id {
        Some(id) => {
            if let Some(waiter) = state.waiters.iter_mut().find(|waiter| waiter.id == id) {
                if !waiter.waker.will_wake(context.waker()) {
                    waiter.waker = context.waker().clone();
                }
            } else {
                *waiter_id = Some(state.insert_waiter(context.waker().clone()));
            }
        }
        None => {
            *waiter_id = Some(state.insert_waiter(context.waker().clone()));
        }
    }
    Poll::Pending
}

pub(super) fn remove_waiter<R>(node: &Node<R>, waiter_id: &mut Option<u64>) {
    let Some(id) = waiter_id.take() else {
        return;
    };
    lock_state(node).waiters.retain(|waiter| waiter.id != id);
}

#[cfg(test)]
pub(super) fn waiter_count<R>(node: &Node<R>) -> usize {
    lock_state(node).waiters.len()
}

pub(super) fn effective_signal<R>(node: &Node<R>, fallback: Arc<Signal<R>>) -> Arc<Signal<R>> {
    signal(node).unwrap_or(fallback)
}

pub(super) fn cancel_tree<R>(root: Arc<Node<R>>, signal: Arc<Signal<R>>) -> bool {
    let root_id = root.id;
    let mut pending = vec![(root, signal)];
    let mut wakers = Vec::new();
    let mut installed_at_root = false;

    while let Some((node, incoming_signal)) = pending.pop() {
        let (effective_signal, children) = {
            let mut state = lock_state(&node);
            let effective_signal = match state.signal.clone() {
                Some(signal) => signal,
                None => {
                    if node.id == root_id {
                        installed_at_root = true;
                    }
                    state.signal = Some(incoming_signal.clone());
                    wakers.extend(state.waiters.drain(..).map(|waiter| waiter.waker));
                    incoming_signal
                }
            };
            let children = state
                .children
                .drain(..)
                .filter_map(|child| child.upgrade())
                .collect::<Vec<_>>();
            (effective_signal, children)
        };
        pending.extend(
            children
                .into_iter()
                .map(|child| (child, effective_signal.clone())),
        );
    }

    for waker in wakers {
        waker.wake();
    }
    installed_at_root
}

struct State<R> {
    signal: Option<Arc<Signal<R>>>,
    children: Vec<Weak<Node<R>>>,
    waiters: Vec<Waiter>,
    next_waiter_id: u64,
}

impl<R> State<R> {
    fn insert_waiter(&mut self, waker: Waker) -> u64 {
        let start = self.next_waiter_id;
        loop {
            let id = self.next_waiter_id;
            self.next_waiter_id = self.next_waiter_id.wrapping_add(1);
            if !self.waiters.iter().any(|waiter| waiter.id == id) {
                self.waiters.push(Waiter { id, waker });
                return id;
            }
            assert!(
                self.next_waiter_id != start,
                "cancellation waiter identity space exhausted"
            );
        }
    }
}

impl<R> Default for State<R> {
    fn default() -> Self {
        Self {
            signal: None,
            children: Vec::new(),
            waiters: Vec::new(),
            next_waiter_id: 0,
        }
    }
}

struct Waiter {
    id: u64,
    waker: Waker,
}

fn next_id() -> CancellationId {
    let id = NEXT_CANCELLATION_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
        .expect("cancellation identity space exhausted");
    CancellationId(id)
}

fn lock_state<R>(node: &Node<R>) -> MutexGuard<'_, State<R>> {
    node.state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
