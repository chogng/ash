use std::collections::BTreeMap;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use extension_protocol::ExtensionClientOperation;
use extension_protocol::ExtensionClientRequest;
use extension_protocol::ExtensionHostRequest;
use extension_protocol::ExtensionHostResponse;
use extension_protocol::ExtensionHostStdinFrame;
use extension_protocol::HostErrorCode;
use extension_protocol::HostFailure;
use extension_protocol::HostRequestKind;
use extension_protocol::HostResponseKind;
use extension_protocol::HostSuccess;
use extension_protocol::ProtocolLimits;
use extension_protocol::RequestContext;
use serde_json::Value;

use crate::package::Package;

pub(crate) struct MemoryLimits {
    pub(crate) heap_bytes: std::num::NonZeroUsize,
    pub(crate) array_buffer_bytes: std::num::NonZeroUsize,
}
const MAX_CLIENT_CALLS: usize = 32;
const MAX_INVOCATIONS: usize = 32;
const CONTROL_MILLIS: u64 = 5_000;

type Writer = Arc<Mutex<Box<dyn Write + Send>>>;
type ActiveRequests = Arc<Mutex<BTreeMap<u64, RequestContext>>>;

struct ClientCall {
    context: RequestContext,
    resolver: v8::Global<v8::PromiseResolver>,
}

struct Bridge {
    api: crate::package::ApiContract,
    writer: Writer,
    contexts: BTreeMap<u64, RequestContext>,
    active: ActiveRequests,
    calls: BTreeMap<u64, ClientCall>,
    next_call: u64,
    modules: BTreeMap<String, v8::Global<v8::Module>>,
    module_names: BTreeMap<i32, String>,
}

struct Job {
    request: ExtensionHostRequest,
    promise: v8::Global<v8::Promise>,
    deadline: u64,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Phase {
    New,
    Initialized,
    Active,
    Disposed,
}

struct HeapGuard {
    handle: v8::IsolateHandle,
    exceeded: Arc<AtomicBool>,
}

unsafe extern "C" fn heap_limit(
    data: *mut std::ffi::c_void,
    current: usize,
    _initial: usize,
) -> usize {
    // SAFETY: the boxed guard remains alive until the isolate is dropped, below.
    let guard = unsafe { &*(data as *const HeapGuard) };
    guard.exceeded.store(true, Ordering::Release);
    guard.handle.terminate_execution();
    current.saturating_add(4 * 1024 * 1024)
}

/// Pure-JS execution is bounded even while the engine cannot service its transport loop.
struct Watchdog {
    sender: mpsc::Sender<Option<u64>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Watchdog {
    fn new(handle: v8::IsolateHandle) -> Self {
        let (sender, receiver) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut deadline: Option<u64> = None;
            loop {
                let message = match deadline {
                    None => receiver
                        .recv()
                        .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                    Some(deadline) => {
                        receiver.recv_timeout(Duration::from_millis(deadline.saturating_sub(now())))
                    }
                };
                match message {
                    Ok(next) => deadline = next,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        handle.terminate_execution();
                        return;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
        });
        Self {
            sender,
            worker: Some(worker),
        }
    }
    fn set(&self, deadline: Option<u64>) -> Result<(), String> {
        self.sender
            .send(deadline)
            .map_err(|_| "JavaScript execution deadline exceeded".into())
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        let (replacement, _) = mpsc::channel();
        drop(std::mem::replace(&mut self.sender, replacement));
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub(crate) fn run(package: Package, confinement: Option<MemoryLimits>) -> Result<(), String> {
    v8_runtime::ensure_v8_initialized()?;
    let memory = confinement
        .as_ref()
        .map(|limits| (limits.heap_bytes.get(), limits.array_buffer_bytes))
        .unwrap_or((
            64 * 1024 * 1024,
            std::num::NonZeroUsize::new(64 * 1024 * 1024).unwrap(),
        ));
    let writer: Writer = Arc::new(Mutex::new(Box::new(std::io::stdout())));
    let mut isolate = v8::Isolate::new(
        v8::Isolate::create_params()
            .array_buffer_allocator(v8_runtime::bounded_array_buffer_allocator(memory.1))
            .heap_limits(0, memory.0),
    );
    if confinement.is_some() {
        crate::isolation::restrict_javascript_process()?;
    }
    let handle = isolate.thread_safe_handle();
    let exceeded = Arc::new(AtomicBool::new(false));
    let guard = Box::new(HeapGuard {
        handle: handle.clone(),
        exceeded: exceeded.clone(),
    });
    isolate
        .add_near_heap_limit_callback(heap_limit, (&*guard as *const HeapGuard).cast_mut().cast());
    let watchdog = Watchdog::new(handle.clone());
    let (sender, receiver) = mpsc::sync_channel(64);
    let active: ActiveRequests = Arc::default();
    let reader_active = active.clone();
    std::thread::spawn(move || {
        let mut reader = std::io::stdin().lock();
        loop {
            let message = extension_protocol::read_frame(
                &mut reader,
                ProtocolLimits::default().maximum_frame_bytes,
            )
            .map_err(|error| error.to_string())
            .and_then(|bytes| {
                bytes
                    .map(|bytes| {
                        serde_json::from_slice::<ExtensionHostStdinFrame>(&bytes)
                            .map_err(|error| error.to_string())
                    })
                    .transpose()
            });
            if let Ok(Some(ExtensionHostStdinFrame::Request(request))) = &message
                && let HostRequestKind::Cancel(cancel) = &request.request
                && request.validate(&ProtocolLimits::default()).is_ok()
                && reader_active.lock().is_ok_and(|active| {
                    active.get(&cancel.target_request_id).is_some_and(|target| {
                        target.incarnation == request.context.incarnation
                            && target.activation_generation == request.context.activation_generation
                    })
                })
            {
                // Cancellation retires this extension's entire isolate: no captured callback can
                // continue with an old invocation's authority. The supervisor recovers a new incarnation.
                handle.terminate_execution();
            }
            let done = !matches!(message, Ok(Some(_)));
            if sender.send(message).is_err() || done {
                break;
            }
        }
    });
    let outcome = {
        v8::scope!(let scope, &mut isolate);
        let context = v8::Context::new(scope, Default::default());
        let scope = &mut v8::ContextScope::new(scope, context);
        fixed_buffer_context(scope)?;
        scope.set_slot(Bridge {
            api: package.api,
            writer: writer.clone(),
            contexts: BTreeMap::new(),
            active,
            calls: BTreeMap::new(),
            next_call: 0,
            modules: BTreeMap::new(),
            module_names: BTreeMap::new(),
        });
        let result = run_engine(scope, &package, &writer, &receiver, &watchdog);
        // Globals own engine handles. Release them before dropping the isolate and heap callback.
        scope.remove_slot::<Bridge>();
        result
    };
    drop(watchdog);
    drop(isolate);
    drop(guard);
    if exceeded.load(Ordering::Acquire) {
        return Err("extension heap quota exceeded".into());
    }
    outcome
}

fn fixed_buffer_context(scope: &mut v8::PinScope<'_, '_>) -> Result<(), String> {
    // V8's resizable/shared buffers bypass the per-isolate Allocator. Keep the original
    // constructor only in this private closure and replace its sole public constructor
    // link, including buffers obtained through typed arrays. Fixed buffers, slice, transfer
    // and all typed-array allocations still use the hard allocator budget.
    let source = v8::String::new(scope, include_str!("fixed_buffers.js"))
        .ok_or("failed to prepare bounded buffer context")?;
    let script = v8::Script::compile(scope, source, None)
        .ok_or("failed to compile bounded buffer context")?;
    script
        .run(scope)
        .ok_or("failed to install bounded buffer context")?;
    Ok(())
}

fn run_engine(
    scope: &mut v8::PinScope<'_, '_>,
    package: &Package,
    writer: &Writer,
    receiver: &mpsc::Receiver<Result<Option<ExtensionHostStdinFrame>, String>>,
    watchdog: &Watchdog,
) -> Result<(), String> {
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "__ashRequest").ok_or("cannot allocate SDK bridge name")?;
    let callback = v8::Function::new(scope, client_request).ok_or("cannot create SDK bridge")?;
    global
        .define_own_property(
            scope,
            key.into(),
            callback.into(),
            v8::PropertyAttribute::READ_ONLY | v8::PropertyAttribute::DONT_DELETE,
        )
        .ok_or("cannot install SDK bridge")?;
    let key =
        v8::String::new(scope, "__ashInvocation").ok_or("cannot allocate invocation bridge")?;
    let callback =
        v8::Function::new(scope, current_invocation).ok_or("cannot create invocation bridge")?;
    global
        .define_own_property(
            scope,
            key.into(),
            callback.into(),
            v8::PropertyAttribute::READ_ONLY | v8::PropertyAttribute::DONT_DELETE,
        )
        .ok_or("cannot install invocation bridge")?;
    for (name, text) in &package.sources {
        let source = v8::String::new(scope, text).ok_or("cannot allocate module source")?;
        let resource = v8::String::new(scope, name).ok_or("cannot allocate module name")?;
        let origin = v8::ScriptOrigin::new(
            scope,
            resource.into(),
            0,
            0,
            false,
            0,
            None,
            false,
            false,
            true,
            None,
        );
        let mut source = v8::script_compiler::Source::new(source, Some(&origin));
        let module = v8::script_compiler::compile_module(scope, &mut source)
            .ok_or_else(|| format!("cannot compile module '{name}'"))?;
        let id = module.script_id().ok_or("module has no script identity")?;
        let module = v8::Global::new(scope, module);
        let bridge = scope
            .get_slot_mut::<Bridge>()
            .expect("engine bridge installed");
        bridge.module_names.insert(id, name.clone());
        bridge.modules.insert(name.clone(), module);
    }
    let entry = local_module(scope, &package.entry).ok_or("missing entry module")?;
    let sdk = local_module(scope, "@ash/extension").ok_or("missing SDK module")?;
    let mut phase = Phase::New;
    let mut fence = None;
    let mut jobs: BTreeMap<u64, Job> = BTreeMap::new();
    let mut runtime: Option<v8::Global<v8::Object>> = None;
    loop {
        // A fresh handle scope bounds engine handles during a long-lived activation. Promise
        // continuations need the same watchdog as the initial synchronous callback.
        v8::scope!(let scope, scope);
        watchdog.set(jobs.values().map(|job| job.deadline).min())?;
        scope.perform_microtask_checkpoint();
        if scope.is_execution_terminating() {
            return Err("extension execution was terminated".into());
        }
        let completed: Vec<u64> = jobs
            .iter()
            .filter(|(_, job)| {
                v8::Local::new(scope, &job.promise).state() != v8::PromiseState::Pending
            })
            .map(|(id, _)| *id)
            .collect();
        for id in completed {
            let job = jobs.remove(&id).expect("completed job exists");
            let bridge = scope.get_slot_mut::<Bridge>().expect("bridge exists");
            bridge.contexts.remove(&id);
            bridge
                .active
                .lock()
                .map_err(|_| "invocation control poisoned")?
                .remove(&id);
            if bridge
                .calls
                .values()
                .any(|call| call.context.request_id == id)
            {
                return Err("callback returned with unfinished SDK requests".into());
            }
            let promise = v8::Local::new(scope, &job.promise);
            let value = promise.result(scope);
            let outcome = if promise.state() == v8::PromiseState::Rejected {
                Err(HostFailure {
                    code: HostErrorCode::Internal,
                    message: value.to_rust_string_lossy(scope),
                })
            } else {
                match &job.request.request {
                    HostRequestKind::Activate(_) => {
                        let runtime =
                            v8::Local::new(scope, runtime.as_ref().ok_or("missing runtime")?);
                        let descriptors = call(scope, runtime, "sealActivation", &[])?;
                        let descriptors = descriptors.to_rust_string_lossy(scope);
                        let registrations = serde_json::from_str(&descriptors)
                            .map_err(|error| error.to_string())?;
                        phase = Phase::Active;
                        Ok(HostSuccess::Activated(extension_protocol::ActivateResult {
                            registrations,
                        }))
                    }
                    HostRequestKind::Invoke(_) => {
                        let text = value.to_rust_string_lossy(scope);
                        if text.len() > ProtocolLimits::default().maximum_payload_bytes {
                            return Err("callback result quota exceeded".into());
                        }
                        let payload: Value =
                            serde_json::from_str(&text).map_err(|error| error.to_string())?;
                        Ok(HostSuccess::Invoked(extension_protocol::InvokeResult {
                            payload,
                        }))
                    }
                    HostRequestKind::Deactivate | HostRequestKind::Shutdown => {
                        Ok(HostSuccess::Deactivated)
                    }
                    _ => return Err("unexpected asynchronous host operation".into()),
                }
            };
            respond(writer, &job.request, outcome)?;
        }
        watchdog.set(None)?;
        let wait = jobs
            .values()
            .map(|job| job.deadline)
            .min()
            .map(|deadline| Duration::from_millis(deadline.saturating_sub(now())));
        let message = match wait {
            Some(wait) => receiver.recv_timeout(wait),
            None => receiver
                .recv()
                .map_err(|_| mpsc::RecvTimeoutError::Disconnected),
        };
        let message = match message {
            Ok(message) => message?,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return Err("extension invocation deadline exceeded".into());
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => None,
        };
        let Some(message) = message else {
            return Ok(());
        };
        match message {
            ExtensionHostStdinFrame::ClientResponse(response) => {
                let bridge = scope.get_slot_mut::<Bridge>().expect("bridge exists");
                let pending = bridge
                    .calls
                    .remove(&response.call_id)
                    .ok_or("unknown or duplicate SDK response")?;
                if pending.context != response.context
                    || !bridge.contexts.contains_key(&pending.context.request_id)
                {
                    return Err("SDK response belongs to a retired invocation".into());
                }
                let resolver = v8::Local::new(scope, pending.resolver);
                match response.outcome {
                    Ok(value) => {
                        let text =
                            serde_json::to_string(&value).map_err(|error| error.to_string())?;
                        if text.len() > ProtocolLimits::default().maximum_payload_bytes {
                            return Err("SDK response quota exceeded".into());
                        }
                        let value =
                            v8::String::new(scope, &text).ok_or("cannot allocate SDK result")?;
                        resolver
                            .resolve(scope, value.into())
                            .ok_or("cannot resolve SDK result")?;
                    }
                    Err(error) => {
                        let message = v8::String::new(scope, &error.message)
                            .ok_or("cannot allocate SDK error")?;
                        let exception = v8::Exception::error(scope, message);
                        let object = v8::Local::<v8::Object>::try_from(exception)
                            .map_err(|_| "invalid SDK error object")?;
                        let key = v8::String::new(scope, "code")
                            .ok_or("cannot allocate SDK error code")?;
                        let code =
                            serde_json::to_value(error.code).map_err(|error| error.to_string())?;
                        let code =
                            v8::String::new(scope, code.as_str().ok_or("invalid SDK error code")?)
                                .ok_or("cannot allocate SDK error code")?;
                        object
                            .set(scope, key.into(), code.into())
                            .ok_or("cannot set SDK error code")?;
                        resolver
                            .reject(scope, exception)
                            .ok_or("cannot reject SDK request")?;
                    }
                }
            }
            ExtensionHostStdinFrame::Request(request) => {
                request
                    .validate(&ProtocolLimits::default())
                    .map_err(|error| error.to_string())?;
                let binding = (
                    request.context.incarnation,
                    request.context.activation_generation,
                );
                if fence.is_some_and(|current| current != binding) {
                    return Err("request belongs to another activation".into());
                }
                match &request.request {
                    HostRequestKind::Initialize(params) => {
                        if phase != Phase::New
                            || params.extension_id != package.extension_id
                            || params.runtime_api_version != 1
                        {
                            return Err("invalid JavaScript host initialization".into());
                        }
                        fence = Some(binding);
                        phase = Phase::Initialized;
                        respond(
                            writer,
                            &request,
                            Ok(HostSuccess::Initialized(
                                extension_protocol::InitializeResult {
                                    protocol_version: extension_protocol::PROTOCOL_VERSION,
                                    runtime_api_version: 1,
                                },
                            )),
                        )?;
                    }
                    HostRequestKind::Activate(params) => {
                        if phase != Phase::Initialized
                            || runtime.is_some()
                            || params.extension_id != package.extension_id
                            || params.package.entrypoint != package.entry
                        {
                            return Err("invalid JavaScript package activation".into());
                        }
                        let deadline = now() + CONTROL_MILLIS;
                        watchdog.set(Some(deadline))?;
                        sdk.instantiate_module(scope, resolve_module)
                            .ok_or("SDK instantiation failed")?;
                        evaluate_module(scope, sdk)?;
                        entry
                            .instantiate_module(scope, resolve_module)
                            .ok_or("extension imports are unsupported or leave their package")?;
                        evaluate_module(scope, entry)?;
                        scope.perform_microtask_checkpoint();
                        let sdk_namespace = sdk.get_module_namespace();
                        let sdk_namespace = v8::Local::<v8::Object>::try_from(sdk_namespace)
                            .map_err(|_| "invalid SDK namespace")?;
                        let runtime_object = property(scope, sdk_namespace, "__runtime")?;
                        let runtime_object = v8::Local::<v8::Object>::try_from(runtime_object)
                            .map_err(|_| "invalid SDK runtime")?;
                        let id = v8::String::new(scope, &package.extension_id)
                            .ok_or("cannot allocate extension identity")?;
                        let context = call(scope, runtime_object, "beginActivation", &[id.into()])?;
                        runtime = Some(v8::Global::new(scope, runtime_object));
                        let namespace =
                            v8::Local::<v8::Object>::try_from(entry.get_module_namespace())
                                .map_err(|_| "invalid extension namespace")?;
                        let result = call(scope, namespace, "activate", &[context])?;
                        let promise = as_promise(scope, result)?;
                        jobs.insert(
                            request.context.request_id,
                            Job {
                                request,
                                promise,
                                deadline,
                            },
                        );
                        watchdog.set(None)?;
                    }
                    HostRequestKind::Invoke(params) => {
                        if phase != Phase::Active
                            || params.extension_id != package.extension_id
                            || !matches!(params.operation.as_str(), "execute" | "hover")
                            || jobs.len() >= MAX_INVOCATIONS
                            || jobs.contains_key(&request.context.request_id)
                            || request.context.request_id > 9_007_199_254_740_991
                        {
                            return Err("invalid SDK invocation".into());
                        }
                        let context = request.context;
                        let bridge = scope.get_slot_mut::<Bridge>().expect("bridge exists");
                        bridge.contexts.insert(context.request_id, context);
                        bridge
                            .active
                            .lock()
                            .map_err(|_| "invocation control poisoned")?
                            .insert(context.request_id, context);
                        let runtime =
                            v8::Local::new(scope, runtime.as_ref().ok_or("runtime missing")?);
                        let registration = v8::String::new(scope, &params.registration_id)
                            .ok_or("cannot allocate registration")?;
                        let payload = serde_json::to_string(&params.payload)
                            .map_err(|error| error.to_string())?;
                        let payload = v8::String::new(scope, &payload)
                            .ok_or("cannot allocate callback payload")?;
                        let id = v8::Number::new(scope, context.request_id as f64);
                        let operation = v8::String::new(scope, &params.operation)
                            .ok_or("cannot allocate invocation operation")?;
                        watchdog.set(Some(params.deadline_unix_millis))?;
                        // V8 carries this value through Promise/await continuations. The extension
                        // cannot read or change it, so overlapping callbacks keep their own caller.
                        let previous = scope.get_continuation_preserved_embedder_data();
                        scope.set_continuation_preserved_embedder_data(id.into());
                        let result = call(
                            scope,
                            runtime,
                            "invoke",
                            &[
                                registration.into(),
                                payload.into(),
                                id.into(),
                                operation.into(),
                            ],
                        )?;
                        let promise = as_promise(scope, result)?;
                        scope.set_continuation_preserved_embedder_data(previous);
                        let deadline = params.deadline_unix_millis;
                        jobs.insert(
                            context.request_id,
                            Job {
                                request,
                                promise,
                                deadline,
                            },
                        );
                        watchdog.set(None)?;
                    }
                    HostRequestKind::Ping => respond(writer, &request, Ok(HostSuccess::Pong))?,
                    HostRequestKind::Cancel(cancel) => {
                        let is_active = jobs.contains_key(&cancel.target_request_id);
                        respond(writer, &request, Ok(HostSuccess::Cancelled))?;
                        if is_active {
                            return Err("extension incarnation cancelled".into());
                        }
                    }
                    HostRequestKind::Deactivate | HostRequestKind::Shutdown => {
                        if !jobs.is_empty() {
                            return Err("extension must drain before deactivation".into());
                        }
                        watchdog.set(Some(now() + CONTROL_MILLIS))?;
                        let cleanup = if phase == Phase::Active {
                            let namespace =
                                v8::Local::<v8::Object>::try_from(entry.get_module_namespace())
                                    .map_err(|_| "invalid extension namespace")?;
                            let deactivate = property(scope, namespace, "deactivate")?;
                            let runtime =
                                v8::Local::new(scope, runtime.as_ref().ok_or("runtime missing")?);
                            // The SDK finally block disposes subscriptions even if deactivate rejects.
                            let result = call(scope, runtime, "deactivate", &[deactivate])?;
                            let promise = as_promise(scope, result)?;
                            scope.perform_microtask_checkpoint();
                            let promise = v8::Local::new(scope, promise);
                            match promise.state() {
                                v8::PromiseState::Fulfilled => Ok(()),
                                v8::PromiseState::Rejected => Err(HostFailure {
                                    code: HostErrorCode::Internal,
                                    message: promise.result(scope).to_rust_string_lossy(scope),
                                }),
                                v8::PromiseState::Pending => {
                                    return Err(
                                        "deactivation must finish without external calls".into()
                                    );
                                }
                            }
                        } else {
                            Ok(())
                        };
                        phase = Phase::Disposed;
                        watchdog.set(None)?;
                        let shutdown = matches!(request.request, HostRequestKind::Shutdown);
                        respond(
                            writer,
                            &request,
                            cleanup.map(|()| {
                                if shutdown {
                                    HostSuccess::Shutdown
                                } else {
                                    HostSuccess::Deactivated
                                }
                            }),
                        )?;
                        if shutdown {
                            return Ok(());
                        }
                    }
                }
            }
        }
    }
}

fn local_module<'s>(scope: &v8::PinScope<'s, '_>, name: &str) -> Option<v8::Local<'s, v8::Module>> {
    scope
        .get_slot::<Bridge>()?
        .modules
        .get(name)
        .map(|module| v8::Local::new(scope, module))
}

fn resolve_module<'s>(
    context: v8::Local<'s, v8::Context>,
    specifier: v8::Local<'s, v8::String>,
    _attributes: v8::Local<'s, v8::FixedArray>,
    referrer: v8::Local<'s, v8::Module>,
) -> Option<v8::Local<'s, v8::Module>> {
    // SAFETY: V8 supplies the live context and callback-local handles for module resolution.
    v8::callback_scope!(unsafe scope, context);
    let specifier = specifier.to_rust_string_lossy(scope);
    let referrer = scope
        .get_slot::<Bridge>()?
        .module_names
        .get(&referrer.script_id()?)?
        .clone();
    let name = match crate::package::resolve(&referrer, &specifier) {
        Ok(name) => name,
        Err(error) => {
            throw(scope, &error);
            return None;
        }
    };
    match local_module(scope, &name) {
        Some(module) => Some(module),
        None => {
            throw(scope, "module is not in the immutable package snapshot");
            None
        }
    }
}

fn evaluate_module(
    scope: &mut v8::PinScope<'_, '_>,
    module: v8::Local<v8::Module>,
) -> Result<(), String> {
    let value = module.evaluate(scope).ok_or("module evaluation failed")?;
    let promise = v8::Local::<v8::Promise>::try_from(value)
        .map_err(|_| "module evaluation did not return a promise")?;
    scope.perform_microtask_checkpoint();
    match promise.state() {
        v8::PromiseState::Fulfilled => Ok(()),
        v8::PromiseState::Rejected => Err(promise.result(scope).to_rust_string_lossy(scope)),
        v8::PromiseState::Pending => {
            Err("module initialization must finish before activation".into())
        }
    }
}

fn property<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    object: v8::Local<'s, v8::Object>,
    name: &str,
) -> Result<v8::Local<'s, v8::Value>, String> {
    let key = v8::String::new(scope, name).ok_or("cannot allocate property name")?;
    object
        .get(scope, key.into())
        .ok_or_else(|| format!("cannot read '{name}'"))
}

fn call<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    receiver: v8::Local<'s, v8::Object>,
    name: &str,
    arguments: &[v8::Local<'s, v8::Value>],
) -> Result<v8::Local<'s, v8::Value>, String> {
    let function = property(scope, receiver, name)?;
    let function = v8::Local::<v8::Function>::try_from(function)
        .map_err(|_| format!("'{name}' must be a function"))?;
    function
        .call(scope, receiver.into(), arguments)
        .ok_or_else(|| format!("JavaScript '{name}' failed"))
}

fn as_promise(
    scope: &mut v8::PinScope<'_, '_>,
    value: v8::Local<v8::Value>,
) -> Result<v8::Global<v8::Promise>, String> {
    if let Ok(promise) = v8::Local::<v8::Promise>::try_from(value) {
        return Ok(v8::Global::new(scope, promise));
    }
    let resolver = v8::PromiseResolver::new(scope).ok_or("cannot allocate lifecycle promise")?;
    resolver
        .resolve(scope, value)
        .ok_or("cannot resolve lifecycle promise")?;
    Ok(v8::Global::new(scope, resolver.get_promise(scope)))
}

fn client_request(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    mut result: v8::ReturnValue,
) {
    if let Err(error) = dispatch_client(scope, args, &mut result) {
        throw(scope, &error);
    }
}

fn current_invocation(
    scope: &mut v8::PinScope<'_, '_>,
    _args: v8::FunctionCallbackArguments,
    mut result: v8::ReturnValue,
) {
    let value = scope.get_continuation_preserved_embedder_data();
    let id = value.number_value(scope);
    if id.is_some_and(|id| {
        scope
            .get_slot::<Bridge>()
            .is_some_and(|bridge| bridge.contexts.contains_key(&(id as u64)))
    }) {
        result.set(value);
    } else {
        throw(scope, "VS Code service call has no active invocation");
    }
}

fn dispatch_client(
    scope: &mut v8::PinScope<'_, '_>,
    args: v8::FunctionCallbackArguments,
    result: &mut v8::ReturnValue,
) -> Result<(), String> {
    let parent = args
        .get(0)
        .number_value(scope)
        .ok_or("SDK request needs an invocation")?;
    if !parent.is_finite()
        || parent < 1.0
        || parent.fract() != 0.0
        || parent > 9_007_199_254_740_991.0
        || !args.get(1).is_string()
    {
        return Err("invalid SDK request identity".into());
    }
    if scope
        .get_slot::<Bridge>()
        .is_some_and(|bridge| bridge.api == crate::package::ApiContract::Vscode)
        && scope
            .get_continuation_preserved_embedder_data()
            .number_value(scope)
            != Some(parent)
    {
        return Err("VS Code service call belongs to another invocation".into());
    }
    let text = args.get(1).to_rust_string_lossy(scope);
    if text.len() > ProtocolLimits::default().maximum_payload_bytes {
        return Err("SDK request quota exceeded".into());
    }
    let operation: ExtensionClientOperation =
        serde_json::from_str(&text).map_err(|error| error.to_string())?;
    // This host exposes only the supported read/UI API. In particular, the older RPC command and
    // write operations cannot be reached by forging a request through the JavaScript bridge.
    if !matches!(
        operation,
        ExtensionClientOperation::ReadDocument { .. }
            | ExtensionClientOperation::ReadWorkspaceFile { .. }
            | ExtensionClientOperation::ShowMessage { .. }
            | ExtensionClientOperation::ShowQuickPick { .. }
    ) {
        return Err("operation is outside JavaScript SDK v1".into());
    }
    let resolver = v8::PromiseResolver::new(scope).ok_or("cannot allocate SDK promise")?;
    let promise = resolver.get_promise(scope);
    let resolver = v8::Global::new(scope, resolver);
    let bridge = scope.get_slot_mut::<Bridge>().ok_or("SDK bridge missing")?;
    let context = *bridge
        .contexts
        .get(&(parent as u64))
        .ok_or("SDK invocation is no longer active")?;
    if bridge.calls.len() >= MAX_CLIENT_CALLS {
        return Err("too many pending SDK requests".into());
    }
    bridge.next_call = bridge
        .next_call
        .checked_add(1)
        .ok_or("SDK call ID exhausted")?;
    let request = ExtensionClientRequest {
        context,
        call_id: bridge.next_call,
        operation,
    };
    request
        .validate(&ProtocolLimits::default())
        .map_err(|error| error.to_string())?;
    write(&bridge.writer, &request)?;
    bridge
        .calls
        .insert(request.call_id, ClientCall { context, resolver });
    result.set(promise.into());
    Ok(())
}

fn throw(scope: &mut v8::PinScope<'_, '_>, message: &str) {
    if let Some(message) = v8::String::new(scope, message) {
        let exception = v8::Exception::error(scope, message);
        scope.throw_exception(exception);
    }
}

fn respond(
    writer: &Writer,
    request: &ExtensionHostRequest,
    outcome: Result<HostSuccess, HostFailure>,
) -> Result<(), String> {
    let response = ExtensionHostResponse {
        context: request.context,
        response: match outcome {
            Ok(value) => HostResponseKind::Success(value),
            Err(error) => HostResponseKind::Failure(error),
        },
    };
    response
        .validate_for(request, &ProtocolLimits::default())
        .map_err(|error| error.to_string())?;
    write(writer, &response)
}

fn write(writer: &Writer, value: &impl serde::Serialize) -> Result<(), String> {
    let mut writer = writer.lock().map_err(|_| "protocol writer poisoned")?;
    extension_protocol::write_frame(
        &mut *writer,
        value,
        ProtocolLimits::default().maximum_frame_bytes,
    )
    .map_err(|error| error.to_string())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("UTC clock after epoch")
        .as_millis() as u64
}
