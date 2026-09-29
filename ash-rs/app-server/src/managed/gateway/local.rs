use super::ProfileAppServerRegistry;
use super::Target;
use super::tag_host_request;
use crate::server::message_queue::OutboundSender;
use crate::server::request_dispatch::IncomingRequest;
use crate::server::request_dispatch::RequestDispatchHandle;
use crate::server::request_dispatch::RequestLane;
use serde_json::Value;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread;

const REQUEST_CAPACITY: usize = 64;
const CONTROL_CAPACITY: usize = 16;

#[derive(Default)]
struct State {
    closed: bool,
    target: Option<Arc<Target>>,
    ordinary: usize,
    control: usize,
}

struct Admission {
    state: Arc<Mutex<State>>,
    lane: RequestLane,
}

impl Drop for Admission {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        match self.lane {
            RequestLane::Control => state.control -= 1,
            _ => state.ordinary -= 1,
        }
    }
}

struct RoutedRequest {
    raw: IncomingRequest,
    admission: Admission,
}

/// Directory IO and initialization belong to this route task. The reader only offers bounded
/// messages; ready routes share the gateway's existing request workers and resource scheduler.
pub(super) struct LocalTarget<'scope> {
    pub(super) route_id: usize,
    input: Option<mpsc::SyncSender<RoutedRequest>>,
    state: Arc<Mutex<State>>,
    budgets: crate::server::message_queue::InputBudgets,
    opening: Option<thread::ScopedJoinHandle<'scope, io::Result<()>>>,
}

impl<'scope> LocalTarget<'scope> {
    pub(super) fn start<'env: 'scope>(
        scope: &'scope thread::Scope<'scope, 'env>,
        registry: Arc<ProfileAppServerRegistry>,
        root: PathBuf,
        initialize: IncomingRequest,
        route_id: usize,
        requests: RequestDispatchHandle<'env>,
        outbound: OutboundSender,
    ) -> Self {
        let (input, incoming) =
            mpsc::sync_channel::<RoutedRequest>(REQUEST_CAPACITY + CONTROL_CAPACITY);
        let state = Arc::new(Mutex::new(State::default()));
        let opening_state = Arc::clone(&state);
        let budgets = requests.budgets();
        let opening = scope.spawn(move || {
            let opened = (|| {
                let server = registry
                    .server_for_local_session(&root)
                    .map_err(io::Error::other)?;
                let mut connection = server.product_host_connection();
                let response = server.handle_json(&mut connection, &initialize);
                if !serde_json::from_str::<Value>(&response)
                    .is_ok_and(|response| response.get("result").is_some())
                {
                    server.close_connection(connection);
                    return Err(io::Error::other(response));
                }
                Ok(Arc::new(Target { server, connection }))
            })();
            let target = match opened {
                Ok(target) => target,
                Err(error) => {
                    // Seal before draining: acceptance and startup failure cannot race past
                    // each other and leave a request without a terminal response.
                    opening_state.lock().unwrap().closed = true;
                    for request in incoming.try_iter() {
                        let id = serde_json::from_str::<Value>(&request.raw)
                            .expect("gateway validated request")["id"]
                            .clone();
                        outbound
                            .send(super::local_request_error(id, &error).into())
                            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
                    }
                    return Ok(());
                }
            };
            {
                let mut state = opening_state.lock().unwrap();
                if state.closed {
                    drop(state);
                    target.server.close_connection(target.connection.clone());
                    return Ok(());
                }
                state.target = Some(Arc::clone(&target));
            }
            let notifications = target.server.connection_notifications(&target.connection);
            let notification_output = outbound.clone();
            scope.spawn(move || {
                while notifications.wait() {
                    for notification in notifications.drain() {
                        if notification_output
                            .send(tag_host_request(notification, route_id).into())
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            });
            while let Ok(request) = incoming.recv() {
                if opening_state.lock().unwrap().closed {
                    break;
                }
                let output = outbound.clone();
                let RoutedRequest { raw, admission } = request;
                requests.dispatch(
                    Arc::clone(&target.server),
                    &target.connection,
                    raw,
                    move |response| {
                        let result = output
                            .send(response.into())
                            .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe));
                        drop(admission);
                        result
                    },
                )?;
            }
            Ok(())
        });
        Self {
            route_id,
            input: Some(input),
            state,
            budgets,
            opening: Some(opening),
        }
    }

    pub(super) fn is_alive(&self) -> bool {
        !self.state.lock().unwrap().closed
    }

    pub(super) fn send(&self, mut raw: IncomingRequest, request: &Value) -> io::Result<()> {
        let lane = RequestLane::for_message(
            request["method"]
                .as_str()
                .expect("gateway validated method"),
            &request["params"],
        );
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(io::Error::new(
                io::ErrorKind::BrokenPipe,
                "Local directory route closed",
            ));
        }
        let (count, capacity) = match lane {
            RequestLane::Control => (&mut state.control, CONTROL_CAPACITY),
            _ => (&mut state.ordinary, REQUEST_CAPACITY),
        };
        if *count == capacity {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "Local directory request capacity exhausted",
            ));
        }
        raw.retain(&self.budgets, lane).map_err(|()| {
            io::Error::new(
                io::ErrorKind::WouldBlock,
                "Local directory request byte capacity exhausted",
            )
        })?;
        *count += 1;
        let routed = RoutedRequest {
            raw,
            admission: Admission {
                state: Arc::clone(&self.state),
                lane,
            },
        };
        // Capacity counts requests through response delivery, including startup and resource
        // waits. The channel therefore has room whenever admission succeeds.
        let sent = self
            .input
            .as_ref()
            .expect("open route owns sender")
            .try_send(routed);
        drop(state);
        sent.map_err(|error| io::Error::new(io::ErrorKind::BrokenPipe, error))
    }

    pub(super) fn host_response(&self, response: Value) -> io::Result<()> {
        let target = self.state.lock().unwrap().target.clone().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Host response before directory initialization",
            )
        })?;
        target
            .server
            .handle_product_host_response(&target.connection, response)
    }

    pub(super) fn close(&mut self) {
        let target = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.target.clone()
        };
        if let Some(target) = target {
            target.server.cancel_connection_requests(&target.connection);
        }
        self.input.take();
    }

    pub(super) fn join(&mut self) -> io::Result<()> {
        self.opening
            .take()
            .expect("route joined once")
            .join()
            .map_err(|_| io::Error::other("Local directory route panicked"))?
    }

    pub(super) fn dispose(self) {
        if let Some(target) = self.state.lock().unwrap().target.take() {
            target.server.close_connection(target.connection.clone());
        }
    }
}
