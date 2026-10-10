use std::num::NonZeroU64;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use external_ext_protocol::ExtensionClientOperation;
use external_ext_protocol::ExtensionClientResult;
use external_ext_protocol::ExtensionDocumentSnapshot;
use host::ActivateParams;
use host::ActivationAuthority;
use host::ActivationLease;
use host::ExtensionActivationSpec;
use host::ExtensionCapability;
use host::ExtensionHostError;
use host::ExtensionHostLimits;
use host::ExtensionHostStatus;
use host::ExtensionHostSupervisor;
use host::ExtensionInvocation;
use host::ExtensionInvocationTarget;
use host::ExtensionLaunchCommand;
use host::HostErrorCode;
use host::PackageBinding;
use host::ProcessIsolationPolicy;
use host::RestartPolicy;
use host::TrustedDevelopmentLauncher;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;

struct Authority(AtomicBool);
struct Lease;
impl ActivationLease for Lease {}
impl ActivationAuthority for Authority {
    fn authorizes(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
    fn acquire(&self) -> Option<Box<dyn ActivationLease>> {
        self.authorizes()
            .then(|| Box::new(Lease) as Box<dyn ActivationLease>)
    }
}

struct Running {
    supervisor: ExtensionHostSupervisor,
    authority: Arc<Authority>,
    _package: tempfile::TempDir,
}
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.supervisor.shutdown();
    }
}
fn start(source: &str) -> Result<Running, ExtensionHostError> {
    start_with_capabilities(source, vec![ExtensionCapability::Command])
}
fn start_with_capabilities(
    source: &str,
    capabilities: Vec<ExtensionCapability>,
) -> Result<Running, ExtensionHostError> {
    start_with_launcher(
        source,
        capabilities,
        ProcessIsolationPolicy::TrustedDevelopment,
        Arc::new(TrustedDevelopmentLauncher),
    )
}

fn start_with_launcher(
    source: &str,
    capabilities: Vec<ExtensionCapability>,
    isolation: ProcessIsolationPolicy,
    launcher: Arc<dyn host::ExtensionHostLauncher>,
) -> Result<Running, ExtensionHostError> {
    start_with_api(source, capabilities, isolation, launcher, TestApi::Ash, &[])
}

#[derive(Clone, Copy)]
enum TestApi {
    Ash,
    Vscode,
}

fn start_vscode(source: &str) -> Result<Running, ExtensionHostError> {
    start_vscode_with_files(source, &[])
}

fn start_vscode_with_files(
    source: &str,
    files: &[(&str, &str)],
) -> Result<Running, ExtensionHostError> {
    start_vscode_with_files_and_capabilities(
        source,
        files,
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::LanguageProvider,
            ExtensionCapability::StatusBar,
            ExtensionCapability::TaskProvider,
            ExtensionCapability::DebugAdapter,
        ],
    )
}

fn start_vscode_with_files_and_capabilities(
    source: &str,
    files: &[(&str, &str)],
    capabilities: Vec<ExtensionCapability>,
) -> Result<Running, ExtensionHostError> {
    let (isolation, launcher): (_, Arc<dyn host::ExtensionHostLauncher>) =
        if host::ProductJavaScriptLauncher::supports_platform() {
            (
                ProcessIsolationPolicy::RequireJavaScriptEnforcement(
                    host::JavaScriptMemoryLimits::default(),
                ),
                Arc::new(host::ProductJavaScriptLauncher::new(PathBuf::from(env!(
                    "CARGO_BIN_EXE_ash-external-js-ext"
                )))),
            )
        } else {
            (
                ProcessIsolationPolicy::TrustedDevelopment,
                Arc::new(TrustedDevelopmentLauncher),
            )
        };
    start_with_api(
        source,
        capabilities,
        isolation,
        launcher,
        TestApi::Vscode,
        files,
    )
}

#[test]
fn vscode_activation_only_registers_observers_within_the_admitted_ceiling() {
    for task_access in [false, true] {
        let mut capabilities = vec![ExtensionCapability::Command];
        if task_access {
            capabilities.push(ExtensionCapability::TaskProvider);
        }
        let running = start_vscode_with_files_and_capabilities(r#"
            const vscode = require('vscode');
            exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('example.hello', () => vscode.tasks.taskExecutions.length));
        "#, &[], capabilities).unwrap();
        let snapshot = running.supervisor.snapshot();
        let registrations = snapshot
            .registrations
            .iter()
            .map(|registration| registration.registration_id.as_str())
            .collect::<Vec<_>>();
        let expected = if task_access {
            vec![
                "vscode.workspace.events",
                "vscode.tasks.events",
                "example.hello",
            ]
        } else {
            vec!["vscode.workspace.events", "example.hello"]
        };
        assert_eq!(registrations, expected);
        assert_eq!(
            running
                .supervisor
                .begin_invoke(invocation("hello", json!([]), Duration::from_secs(5)))
                .unwrap()
                .wait()
                .unwrap()
                .payload,
            json!(0)
        );
    }
}

fn start_with_api(
    source: &str,
    capabilities: Vec<ExtensionCapability>,
    isolation: ProcessIsolationPolicy,
    launcher: Arc<dyn host::ExtensionHostLauncher>,
    api: TestApi,
    files: &[(&str, &str)],
) -> Result<Running, ExtensionHostError> {
    start_with_environment(
        source,
        capabilities,
        isolation,
        launcher,
        api,
        files,
        Default::default(),
    )
}

fn start_with_environment(
    source: &str,
    capabilities: Vec<ExtensionCapability>,
    isolation: ProcessIsolationPolicy,
    launcher: Arc<dyn host::ExtensionHostLauncher>,
    api: TestApi,
    files: &[(&str, &str)],
    environment: Option<std::collections::BTreeMap<String, Option<String>>>,
) -> Result<Running, ExtensionHostError> {
    let package = tempfile::tempdir().unwrap();
    std::fs::write(package.path().join("main.js"), source).unwrap();
    std::fs::write(
        package.path().join("helper.js"),
        include_str!("fixtures/helper.js"),
    )
    .unwrap();
    for (name, contents) in files {
        let path = package.path().join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }
    let mut arguments: Vec<String> = vec![
        "--extension-id".into(),
        "example".into(),
        "--package".into(),
        package.path().to_str().unwrap().into(),
        "--entry".into(),
        "main.js".into(),
    ];
    if matches!(api, TestApi::Vscode) {
        arguments.extend(["--api".into(), "vscode".into()]);
        std::fs::write(
            package.path().join("package.json"),
            serde_json::to_vec(&json!({
                "name": "example", "publisher": "test", "version": "1.0.0", "browser": "main.js",
                "contributes": { "commands": [
                    {"command": "example.hello", "title": "Hello"},
                    {"command": "example.async", "title": "Async"},
                    {"command": "example.probe", "title": "Probe"}
                ], "debuggers": [{"type": "example", "label": "Example"}]}
            }))
            .unwrap(),
        )
        .unwrap();
    }
    let command = ExtensionLaunchCommand::javascript(
        PathBuf::from(env!("CARGO_BIN_EXE_ash-external-js-ext")),
        arguments,
        package.path(),
    )
    .unwrap();
    let command = match environment {
        Some(environment) => command.with_extension_environment(environment).unwrap(),
        None => command,
    };
    let authority = Arc::new(Authority(AtomicBool::new(true)));
    let activation = ExtensionActivationSpec::new(
        ActivateParams {
            initialization: matches!(api, TestApi::Vscode).then(vscode_initialization),
            extension_id: "example".into(),
            package: PackageBinding {
                package_id: "example@1.0.0".into(),
                package_digest: format!("sha256:{}", "a".repeat(64)),
                entrypoint: "main.js".into(),
            },
            runtime_api_version: 1,
            activation_events: vec!["startup".into()],
            capabilities,
        },
        NonZeroU64::new(1).unwrap(),
        authority.clone(),
    );
    let supervisor = ExtensionHostSupervisor::new(
        launcher,
        command,
        activation,
        ExtensionHostLimits {
            isolation,
            cancellation_grace: Duration::from_millis(200),
            ..ExtensionHostLimits::default()
        },
        RestartPolicy::default(),
    )
    .unwrap();
    supervisor.start()?;
    Ok(Running {
        supervisor,
        authority,
        _package: package,
    })
}
fn invocation(id: &str, arguments: Value, timeout: Duration) -> ExtensionInvocation {
    let deadline =
        (SystemTime::now().duration_since(UNIX_EPOCH).unwrap() + timeout).as_millis() as u64;
    ExtensionInvocation {
        registration_id: format!("example.{id}"),
        operation: "execute".into(),
        payload: json!({"arguments": arguments}),
        deadline_unix_millis: NonZeroU64::new(deadline).unwrap(),
    }
}

fn product_params() -> ActivateParams {
    let manifest = include_str!("../../../extensions/remote-ssh/package.json");
    let source = include_str!("../../../extensions/remote-ssh/src/extension.js");
    let sdk = include_str!("../../../sdk/typescript/index.js");
    ActivateParams {
        initialization: None,
        extension_id: "ash.remote-ssh".into(),
        package: PackageBinding {
            package_id: "ash.remote-ssh@1.0.0".into(),
            package_digest: format!(
                "sha256:{:x}",
                Sha256::digest(format!("{manifest}\0{source}\0{sdk}"))
            ),
            entrypoint: "src/extension.js".into(),
        },
        runtime_api_version: 1,
        activation_events: vec!["startup".into()],
        capabilities: vec![
            ExtensionCapability::RemoteAuthorityResolver,
            ExtensionCapability::ProductRemoteAuthorityResolver,
        ],
    }
}

fn start_product(params: ActivateParams) -> Result<Running, ExtensionHostError> {
    // The product loader must work without a package directory or workspace grant.
    let directory = tempfile::tempdir().unwrap();
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_ash-external-js-ext"));
    let authority = Arc::new(Authority(AtomicBool::new(true)));
    let running = Running {
        supervisor: ExtensionHostSupervisor::new(
            Arc::new(host::ProductJavaScriptLauncher::new(executable.clone())),
            ExtensionLaunchCommand::product_javascript(executable, "remote-ssh", directory.path())
                .unwrap(),
            ExtensionActivationSpec::new(params, NonZeroU64::new(1).unwrap(), authority.clone()),
            ExtensionHostLimits {
                isolation: ProcessIsolationPolicy::RequireJavaScriptEnforcement(
                    host::JavaScriptMemoryLimits::default(),
                ),
                ..ExtensionHostLimits::default()
            },
            RestartPolicy::default(),
        )?,
        authority,
        _package: directory,
    };
    running.supervisor.start()?;
    Ok(running)
}

fn ssh_invocation() -> ExtensionInvocation {
    ExtensionInvocation {
        registration_id: "remote:ssh".into(),
        operation: "resolveConnection".into(),
        payload: json!({"authority": "ssh+build"}),
        deadline_unix_millis: invocation("unused", json!(null), Duration::from_secs(5))
            .deadline_unix_millis,
    }
}

#[test]
fn compiled_ssh_uses_the_sdk_and_fences_old_incarnations_after_restart() {
    let running = start_product(product_params()).unwrap();
    let initial = running.supervisor.snapshot();
    assert_eq!(initial.registrations.len(), 1);
    assert_eq!(
        running.supervisor.invoke(ssh_invocation()).unwrap().payload,
        json!({"connectionName": "build"})
    );
    running.supervisor.shutdown().unwrap();
    assert!(running.supervisor.snapshot().registrations.is_empty());
    let restarted = running.supervisor.start().unwrap();
    assert!(restarted.incarnation > initial.incarnation);
    assert!(matches!(
        running.supervisor.begin_fenced_invoke(
            ExtensionInvocationTarget {
                incarnation: NonZeroU64::new(initial.incarnation).unwrap(),
                activation_generation: NonZeroU64::new(1).unwrap(),
            },
            ssh_invocation()
        ),
        Err(ExtensionHostError::RegistrationNotFound)
    ));
    assert_eq!(
        running.supervisor.invoke(ssh_invocation()).unwrap().payload,
        json!({"connectionName": "build"})
    );
}

#[test]
fn compiled_ssh_rejects_a_stale_release_binding() {
    let mut params = product_params();
    params.package.package_digest = format!("sha256:{}", "a".repeat(64));
    assert!(start_product(params).is_err());
}

#[test]
fn installed_sdk_packages_cannot_acquire_the_product_ssh_authority() {
    let source = "import { workspace } from '@ash/extension'; export function activate(context) { context.subscriptions.push(workspace.registerRemoteConnectionResolver('ssh', { resolve() { return { connectionName: 'build' }; } })); }";
    assert!(
        start_with_capabilities(source, vec![ExtensionCapability::RemoteAuthorityResolver])
            .is_err()
    );
    assert!(
        start_with_capabilities(
            source,
            vec![
                ExtensionCapability::RemoteAuthorityResolver,
                ExtensionCapability::ProductRemoteAuthorityResolver
            ]
        )
        .is_err()
    );
}
fn run(running: &Running, id: &str, arguments: Value) -> Result<Value, ExtensionHostError> {
    running
        .supervisor
        .invoke(invocation(id, arguments, Duration::from_secs(5)))
        .map(|result| result.payload)
}

#[test]
fn vscode_commonjs_modules_share_cycles_json_and_captured_package_bytes() {
    let running = start_vscode_with_files(
        r#"
        const v = require('vscode');
        const cycle = require('./lib/cycle-a');
        const helper = require('./lib/helper');
        if (helper !== require('./lib/helper.js') || require('fixture-lib') !== helper) throw Error('Module identity changed');
        if (cycle.ready !== true || cycle.peerSawReady !== false) throw Error('CommonJS cycle lost partial exports');
        if (module.filename !== __filename || !__filename.endsWith('main.js') || require.resolve('./lib/helper') !== helper.filename) throw Error('CommonJS filename changed');
        for (const name of ['../outside.js', '/etc/passwd', 'node:fs']) {
            let rejected = false;
            try { require(name); } catch { rejected = true; }
            if (!rejected) throw Error('A module left the captured package');
        }
        try { require('./lib/flaky'); } catch (error) { if (error.message !== 'fixture failure') throw error; }
        if (require('./lib/flaky') !== 2 || require('./lib/flaky') !== 2) throw Error('Failed module stayed cached');
        exports.activate = context => {
            context.subscriptions.push(v.commands.registerCommand('example.probe', () => ({
                directory: __dirname,
                args: require('./later.cjs'),
                jsonIdentity: helper.data === require('./lib/data.json'),
                loaded: module.loaded,
                childLoaded: module.children.every(child => child.loaded),
                cycle: cycle.peerSawReady
            })));
            context.subscriptions.push(v.tasks.registerTaskProvider('builder', require('./providers')));
        };
        "#,
        &[
            ("lib/helper.js", "exports.data = require('./data'); exports.filename = __filename;"),
            ("lib/data.json", "{\"value\":\"中文🧊\"}"),
            ("lib/cycle-a.js", "exports.ready = false; exports.peerSawReady = require('./cycle-b').seen; exports.ready = true;"),
            ("lib/cycle-b.js", "exports.seen = require('./cycle-a').ready;"),
            ("lib/flaky.js", "globalThis.fixtureAttempts = (globalThis.fixtureAttempts || 0) + 1; if (globalThis.fixtureAttempts === 1) throw Error('fixture failure'); module.exports = globalThis.fixtureAttempts;"),
            ("later.cjs", "module.exports = ['', '$HOME', 'two words'];"),
            ("providers/package.json", "{\"main\":\"./task.cjs\"}"),
            ("providers/task.cjs", "const v = require('vscode'); module.exports = { provideTasks() { return [new v.Task({type:'builder'}, v.TaskScope.Workspace, 'Nested', 'Builder', new v.ProcessExecution('compiler', require('../later.cjs')))]; } };"),
            ("node_modules/fixture-lib/package.json", "{\"main\":\"./index\"}"),
            ("node_modules/fixture-lib/index.js", "module.exports = require('../../lib/helper');"),
        ],
    ).unwrap();
    std::fs::write(
        running._package.path().join("later.cjs"),
        "module.exports = ['changed'];",
    )
    .unwrap();
    assert_eq!(
        run(&running, "probe", json!([])).unwrap(),
        json!({
            "directory": running._package.path().to_str().unwrap(),
            "args": ["", "$HOME", "two words"], "jsonIdentity": true,
            "loaded": true, "childLoaded": true, "cycle": false
        })
    );
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "vscode.tasks.1".into();
    request.operation = "provideTasks".into();
    request.payload = json!({});
    let provided = running.supervisor.invoke(request).unwrap().payload;
    assert_eq!(
        provided["tasks"][0]["execution"],
        json!({"type":"process","program":"compiler","args":["","$HOME","two words"]})
    );
}

#[test]
fn vscode_activation_context_uses_captured_package_location_and_exports() {
    let running = start_vscode(r#"
        const v = require('vscode');
        const publicApi = { value: 'activation result' };
        exports.activate = async function(context) {
            if (this !== exports || context.extension.isActive) throw Error('Activation state changed too early');
            let pendingExportsRejected = false;
            try { context.extension.exports; } catch { pendingExportsRejected = true; }
            if (!pendingExportsRejected) throw Error('Uninitialized exports became visible');
            const activation = context.extension.activate();
            if (activation !== context.extension.activate()) throw Error('Activation promise identity changed');
            if (context.extensionUri !== context.extension.extensionUri || context.extensionPath !== v.Uri.file(__dirname).fsPath) throw Error('Extension location differs from captured package');
            if (context.extensionMode !== v.ExtensionMode.Production || context.extension.extensionKind !== v.ExtensionKind.UI) throw Error('Installed extension mode differs');
            context.subscriptions.push(v.commands.registerCommand('example.probe', async () => {
                const base = v.Uri.from({ scheme: 'file', path: '/parent/path', query: 'source=1', fragment: 'part' });
                const normalized = v.Uri.joinPath(base, '..', 'other', '.', '资源 #?.txt');
                return {
                    id: context.extension.id,
                    path: context.extensionPath,
                    uri: context.extensionUri.toString(),
                    asset: context.asAbsolutePath('lib/../资源 #?.txt'),
                    emptyPath: context.asAbsolutePath(''),
                    resourceUri: v.Uri.joinPath(context.extensionUri, '资源 #?.txt').toString(),
                    normalized: normalized.toString(),
                    rooted: v.Uri.joinPath(v.Uri.file('/parent'), '..', '..', 'other').path,
                    packageVersion: context.extension.packageJSON.version,
                    active: context.extension.isActive,
                    exportsIdentity: context.extension.exports === publicApi && await activation === publicApi && await context.extension.activate() === publicApi
                };
            }));
            context.subscriptions.push(v.tasks.registerTaskProvider('builder', {
                provideTasks() {
                    return [new v.Task({ type: 'builder' }, v.TaskScope.Workspace, 'Package command', 'Builder',
                        new v.ProcessExecution(context.asAbsolutePath('bin/compiler'), ['literal']))];
                }
            }));
            await Promise.resolve();
            return publicApi;
        };
    "#).unwrap();
    std::fs::write(
        running._package.path().join("package.json"),
        "{\"version\":\"changed\"}",
    )
    .unwrap();
    let value = run(&running, "probe", json!([])).unwrap();
    let root = running._package.path();
    let expected_root = if cfg!(windows) {
        let path = root.to_str().unwrap();
        format!("{}{}", path[..1].to_lowercase(), &path[1..])
    } else {
        root.to_str().unwrap().to_owned()
    };
    assert_eq!(value["id"], "test.example");
    assert_eq!(value["path"], expected_root);
    assert_eq!(value["emptyPath"], expected_root);
    assert_eq!(
        value["asset"],
        std::path::Path::new(&expected_root)
            .join("资源 #?.txt")
            .to_str()
            .unwrap()
    );
    assert_eq!(value["packageVersion"], "1.0.0");
    assert_eq!(value["active"], true);
    assert_eq!(value["exportsIdentity"], true);
    assert_eq!(
        value["resourceUri"],
        format!(
            "{}/%E8%B5%84%E6%BA%90%20%23%3F.txt",
            value["uri"].as_str().unwrap()
        )
    );
    assert_eq!(
        value["normalized"],
        "file:///parent/other/%E8%B5%84%E6%BA%90%20%23%3F.txt?source=1#part"
    );
    assert_eq!(value["rooted"], "/other");
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "vscode.tasks.1".into();
    request.operation = "provideTasks".into();
    request.payload = json!({});
    let provided = running.supervisor.invoke(request).unwrap().payload;
    assert_eq!(
        provided["tasks"][0]["execution"],
        json!({
            "type": "process",
            "program": std::path::Path::new(&expected_root).join("bin/compiler").to_str().unwrap(),
            "args": ["literal"]
        })
    );
}

#[test]
fn malformed_extension_source_does_not_write_engine_diagnostics_to_protocol_stdout() {
    let package = tempfile::tempdir().unwrap();
    std::fs::write(
        package.path().join("main.js"),
        "export function activate( {",
    )
    .unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_ash-external-js-ext"))
        .args(["--extension-id", "example", "--package"])
        .arg(package.path())
        .args(["--entry", "main.js"])
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(output.stdout.is_empty(), "{:?}", output.stdout);
    let diagnostic = String::from_utf8(output.stderr).unwrap();
    assert!(
        diagnostic.contains("cannot compile module 'main.js'"),
        "{diagnostic}"
    );
    assert!(diagnostic.contains("SyntaxError"), "{diagnostic}");
}

#[test]
fn vscode_task_providers_preserve_argv_options_and_resolve_definitions_at_dispatch() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => context.subscriptions.push(v.tasks.registerTaskProvider('builder', {
            provideTasks() {
                const task = new v.Task({type: 'builder', target: 'app'}, v.TaskScope.Workspace, 'Build', 'Builder', new v.ProcessExecution('compiler', ['', '$HOME', 'two words'], {cwd: '${workspaceFolder}/src', env: {MODE: 'build'}}), ['$tsc']);
                if (Object.keys(task.presentationOptions).length || Object.keys(task.runOptions).length) throw Error('Task options must default to empty objects');
                return [v.TaskGroup.Build, v.TaskGroup.Test, v.TaskGroup.Clean, v.TaskGroup.Rebuild].map(group => {
                    const grouped = new v.Task(task.definition, task.scope, group.id, task.source, task.execution, task.problemMatchers);
                    grouped.group = group;
                    grouped.runOptions = {reevaluateOnRerun: false};
                    grouped.presentationOptions = {echo: false, showReuseMessage: false, panel: v.TaskPanelKind.Dedicated, clear: false, reveal: v.TaskRevealKind.Silent, focus: false, close: true};
                    return grouped;
                });
            },
            resolveTask(task) {
                if (task.runOptions.reevaluateOnRerun !== false) throw Error('Configured runOptions changed');
				if ('revealProblems' in task.presentationOptions) throw Error('Configuration-only policy leaked into the public API');
                if (task.presentationOptions.echo !== true || task.presentationOptions.showReuseMessage !== true || task.presentationOptions.panel !== v.TaskPanelKind.New || task.presentationOptions.clear !== true || task.presentationOptions.reveal !== v.TaskRevealKind.Always || task.presentationOptions.focus !== false || task.presentationOptions.close !== false) throw Error('Configured presentationOptions changed');
                if (!(task.group instanceof v.TaskGroup) || task.group.id !== 'clean' || task.group.isDefault !== true) throw Error('Configured TaskGroup changed');
                task.execution = new v.ProcessExecution('compiler', [task.definition.target]);
                return task;
            }
        }));
    "#).unwrap();
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "vscode.tasks.1".into();
    request.operation = "provideTasks".into();
    request.payload = json!({});
    let provided = running.supervisor.invoke(request.clone()).unwrap().payload;
    assert_eq!(
        provided["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|task| task["group"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["build", "test", "clean", "rebuild"]
    );
    let task = &provided["tasks"][0];
    assert_eq!(
        task["execution"],
        json!({"type": "process", "program": "compiler", "args": ["", "$HOME", "two words"]})
    );
    assert_eq!(task["scope"], 2);
    assert_eq!(task["runOptions"], json!({"reevaluateOnRerun": false}));
    assert_eq!(
        task["presentation"],
        json!({"echo": false, "showReuseMessage": false, "panel": "dedicated", "clear": false, "reveal": "silent", "focus": false, "close": true})
    );
    assert_eq!(task["source"], "Builder");
    assert_eq!(task["cwd"], "${workspaceFolder}/src");
    assert_eq!(task["env"], json!({"MODE": "build"}));
    assert_eq!(task["problemMatchers"], json!(["$tsc"]));
    request.operation = "resolveTask".into();
    request.payload = json!({"task": {"id": "configured", "presentation": {"echo": true, "showReuseMessage": true, "panel": "new", "clear": true, "reveal": "always", "revealProblems": "onProblem", "focus": false, "close": false}, "runOptions": {"reevaluateOnRerun": false}, "name": "Configured", "source": "Workspace", "scope":{"uri":"file:///workspace","name":"Workspace","index":0},"options":{},"group":"clean","groupIsDefault":true,"isBackground":true,"problemMatchers":["$tsc"],"detail":"configured detail","definition": {"type": "builder", "target": "chosen"}}});
    let resolved = running.supervisor.invoke(request).unwrap().payload;
    assert_eq!(resolved["task"]["id"], "configured");
    assert_eq!(
        resolved["task"]["runOptions"],
        json!({"reevaluateOnRerun": false})
    );
    assert_eq!(resolved["task"]["group"], "clean");
    assert_eq!(resolved["task"]["groupIsDefault"], true);
    assert_eq!(
        resolved["task"]["presentation"],
        json!({"echo": true, "showReuseMessage": true, "panel": "new", "clear": true, "reveal": "always", "revealProblems": "onProblem", "focus": false, "close": false})
    );
    assert_eq!(
        resolved["task"]["definition"],
        json!({"type": "builder", "target": "chosen"})
    );
    assert_eq!(resolved["task"]["execution"]["args"], json!(["chosen"]));
}

#[test]
fn vscode_task_queries_execute_and_terminate_with_stable_event_handles() {
    let running = start_vscode(r#"
        const v = require('vscode');
        const seen = [];
        let execution;
        exports.activate = context => {
            const receiver = {name: 'receiver'};
            for (const [name, event] of [['start', v.tasks.onDidStartTask], ['processStart', v.tasks.onDidStartTaskProcess], ['processEnd', v.tasks.onDidEndTaskProcess], ['end', v.tasks.onDidEndTask]]) {
                event(function(value) {
                    if (this !== receiver || value.execution !== execution) throw Error('Execution identity or listener receiver changed');
                    seen.push([name, value.processId ?? value.exitCode ?? null, v.tasks.taskExecutions.length]);
                }, receiver, context.subscriptions);
            }
            context.subscriptions.push(v.commands.registerCommand('example.hello', async () => {
                const tasks = await v.tasks.fetchTasks({version: '2.0.0', type: 'builder'});
                const task = tasks[0];
                if (!(task instanceof v.Task) || !(task.execution instanceof v.ProcessExecution) || task.scope.uri.path !== '/workspace' || task.execution.args[0] !== '$HOME') throw Error('Task shape changed');
                if (!(task.group instanceof v.TaskGroup) || task.group.id !== 'rebuild' || task.group.isDefault !== false) throw Error('Fetched TaskGroup changed');
                if (task.runOptions.reevaluateOnRerun !== false) throw Error('Fetched runOptions changed');
                if (task.presentationOptions.echo !== false || task.presentationOptions.showReuseMessage !== false || task.presentationOptions.panel !== v.TaskPanelKind.Shared || task.presentationOptions.clear !== false || task.presentationOptions.reveal !== v.TaskRevealKind.Never || task.presentationOptions.focus !== true || task.presentationOptions.close !== false) throw Error('Fetched presentationOptions changed');
                execution = await v.tasks.executeTask(task);
                if (execution.task !== task || v.tasks.taskExecutions[0] !== execution) throw Error('Execution lost its originating task');
                execution.terminate();
                return task.execution.options.env.MODE;
            }), v.commands.registerCommand('example.probe', () => seen));
        };
    "#).unwrap();
    let task = json!({"id":"task-1","presentation":{"echo":false,"showReuseMessage":false,"panel":"shared","clear":false,"reveal":"never","focus":true,"close":false},"runOptions":{"reevaluateOnRerun":false},"name":"Build","source":"Builder","definition":{"type":"builder","target":false},"scope":{"uri":"file:///workspace","name":"workspace","index":0},"execution":{"type":"process","program":"compiler","args":["$HOME",""]},"options":{"env":{"MODE":"literal"}},"problemMatchers":[],"group":"rebuild","groupIsDefault":false,"isBackground":false,"detail":null});
    let execution = json!({"id":"execution-1","task":task,"active":true,"exitCode":null});
    let mut operations = Vec::new();
    let result = running
        .supervisor
        .begin_invoke(invocation("hello", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            operations.push(operation.clone());
            Ok(match operation {
                ExtensionClientOperation::FetchTasks { version, task_type } => {
                    assert_eq!(
                        (version.as_deref(), task_type.as_deref()),
                        (Some("2.0.0"), Some("builder"))
                    );
                    ExtensionClientResult::Tasks {
                        sequence: 0,
                        tasks: vec![task.clone()],
                        executions: vec![],
                    }
                }
                ExtensionClientOperation::ExecuteTask { task_id, task } => {
                    assert_eq!(task_id.as_deref(), Some("task-1"));
                    assert!(task.is_none());
                    ExtensionClientResult::TaskExecution {
                        sequence: 1,
                        execution: execution.clone(),
                    }
                }
                ExtensionClientOperation::TerminateTask { execution_id } => {
                    assert_eq!(execution_id, "execution-1");
                    ExtensionClientResult::Done
                }
                other => panic!("unexpected client operation: {other:?}"),
            })
        })
        .unwrap();
    assert_eq!(result.payload, json!("literal"));
    assert_eq!(operations.len(), 3);
    for (index, (kind, ended)) in [
        ("start", false),
        ("processStart", false),
        ("processEnd", true),
        ("end", true),
    ]
    .into_iter()
    .enumerate()
    {
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = "vscode.tasks.events".into();
        request.operation = "taskEvent".into();
        request.payload = json!({"type":kind,"sequence":index + 1,"execution":execution,"processId":42,"exitCode":0});
        request.payload["execution"]["active"] = json!(!ended);
        running.supervisor.invoke(request).unwrap();
    }
    assert_eq!(
        run(&running, "probe", json!([])).unwrap(),
        json!([
            ["start", null, 1],
            ["processStart", 42, 1],
            ["processEnd", 0, 1],
            ["end", null, 0]
        ])
    );
}

#[test]
fn vscode_executes_a_constructed_process_task_and_preserves_start_event_identity() {
    let running = start_vscode(r#"
        const v = require('vscode');
        let task, started;
        exports.activate = context => {
            context.subscriptions.push(v.tasks.onDidStartTask(event => {
                if (event.execution.task !== task) throw Error('Start event lost constructed Task');
                started = event.execution;
            }), v.commands.registerCommand('example.hello', async () => {
                task = new v.Task({type: 'builder', target: false}, v.TaskScope.Workspace, 'Explicit', 'Builder', new v.ProcessExecution('compiler', ['$HOME', ''], {cwd: '${workspaceFolder}/src', env: {MODE: 'build'}}));
                task.presentationOptions = {panel: v.TaskPanelKind.Shared, clear: true, reveal: v.TaskRevealKind.Never, focus: false, close: true};
                const execution = await v.tasks.executeTask(task);
                if (execution !== started || execution.task !== task) throw Error('Execution identity changed');
                return execution.task.name;
            }));
        };
    "#).unwrap();
    let result = running.supervisor.begin_invoke(invocation("hello", json!([]), Duration::from_secs(5))).unwrap().wait_with_client(|operation, _, _| {
        let ExtensionClientOperation::ExecuteTask { task_id, task } = operation else { panic!("unexpected client operation: {operation:?}"); };
        assert!(task_id.is_none());
        let task = task.as_ref().unwrap();
        assert_eq!(task["scope"], 2);
        assert_eq!(task["source"], "Builder");
        assert_eq!(task["presentation"], json!({"panel":"shared","clear":true,"reveal":"never","focus":false,"close":true}));
        assert_eq!(task["execution"], json!({"type":"process","program":"compiler","args":["$HOME",""]}));
        assert_eq!(task["cwd"], "${workspaceFolder}/src");
        assert_eq!(task["env"], json!({"MODE":"build"}));
        let execution = json!({"id":"execution-1","active":true,"exitCode":null,"task":{"id":"canonical-explicit","clientTaskId":task["id"],"name":"Explicit","source":"Builder","scope":2,"definition":task["definition"],"execution":task["execution"],"options":{},"problemMatchers":[],"group":"other","isBackground":false,"detail":null}});
        let mut event = invocation("unused", json!([]), Duration::from_secs(5));
        event.registration_id = "vscode.tasks.events".into();
        event.operation = "taskEvent".into();
        event.payload = json!({"type":"start","sequence":1,"execution":execution});
        running.supervisor.invoke(event).unwrap();
        Ok(ExtensionClientResult::TaskExecution { sequence: 1, execution })
    }).unwrap();
    assert_eq!(result.payload, json!("Explicit"));
}

#[test]
fn vscode_constructed_custom_execution_uses_the_owned_pty_without_a_backend_process() {
    let running = start_vscode(r#"
        const v = require('vscode');
        let closes = 0;
        exports.activate = context => context.subscriptions.push(
            v.commands.registerCommand('example.probe', () => closes),
            v.commands.registerCommand('example.hello', async () => {
                const task = new v.Task({type: 'builder', target: false}, v.TaskScope.Workspace, 'Explicit custom', 'Builder', new v.CustomExecution(async definition => {
                    if (definition.target !== false) throw Error('Resolved TaskDefinition changed');
                    const write = new v.EventEmitter();
                    return {
                        onDidWrite: write.event,
                        open(size) { write.fire('OPEN:' + size.columns); },
                        handleInput(data) { write.fire('INPUT:' + data); },
                        close() { closes++; write.dispose(); }
                    };
                }));
                const execution = await v.tasks.executeTask(task);
                if (execution.task !== task) throw Error('Custom Task identity changed');
                return execution.task.name;
            })
        );
    "#).unwrap();
    let result = running.supervisor.begin_invoke(invocation("hello", json!([]), Duration::from_secs(5))).unwrap().wait_with_client(|operation, _, _| {
        let ExtensionClientOperation::ExecuteTask { task_id, task } = operation else { panic!("unexpected client operation: {operation:?}"); };
        assert!(task_id.is_none());
        let task = task.as_ref().unwrap();
        assert_eq!(task["execution"]["type"], "custom");
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = "vscode.tasks.events".into();
        request.operation = "createTaskTerminal".into();
        request.payload = json!({"executionId":task["execution"]["id"],"definition":task["definition"]});
        let created = running.supervisor.invoke(request.clone()).unwrap().payload;
        for (operation, payload, expected) in [
            ("openTaskTerminal", json!({"dimensions":{"columns":80,"rows":24}}), "OPEN:80"),
            ("inputTaskTerminal", json!({"data":"literal $HOME"}), "INPUT:literal $HOME"),
        ] {
            request.operation = operation.into();
            request.payload = payload;
            request.payload["ptyId"] = created["ptyId"].clone();
            assert_eq!(running.supervisor.invoke(request.clone()).unwrap().payload, json!({"events":[{"type":"data","data":expected}]}));
        }
        request.operation = "closeTaskTerminal".into();
        request.payload = json!({"ptyId":created["ptyId"]});
        running.supervisor.invoke(request.clone()).unwrap();
        running.supervisor.invoke(request).unwrap();
        Ok(ExtensionClientResult::TaskExecution { sequence: 1, execution: json!({"id":"explicit-custom","active":false,"task":{"id":"canonical-custom","clientTaskId":task["id"],"name":"Explicit custom","source":"Builder","scope":2,"definition":task["definition"],"execution":{"type":"custom"},"options":{},"problemMatchers":[],"group":"other","isBackground":false,"detail":null}}) })
    }).unwrap();
    assert_eq!(result.payload, json!("Explicit custom"));
    assert_eq!(run(&running, "probe", json!([])).unwrap(), json!(1));
}

#[test]
fn completed_tasks_are_not_resurrected_by_late_execute_or_query_replies() {
    let running = start_vscode(r#"
        const v = require('vscode');
        let task, firstHandle;
        exports.activate = context => {
            context.subscriptions.push(v.tasks.onDidStartTask(event => {
                if (event.execution.task !== task) throw Error('Start lost the original task');
                firstHandle = event.execution;
            }), v.tasks.onDidEndTask(event => {
                if (event.execution !== firstHandle) throw Error('End lost execution identity');
            }), v.commands.registerCommand('example.hello', async () => {
                [task] = await v.tasks.fetchTasks();
                const execution = await v.tasks.executeTask(task);
                if (execution !== firstHandle || v.tasks.taskExecutions.length !== 0) throw Error('Late execute reply resurrected task');
                await v.tasks.fetchTasks();
                if (v.tasks.taskExecutions.length !== 0) throw Error('Late query resurrected task');
                return 'completed';
            }));
        };
    "#).unwrap();
    let task = json!({"id":"task-1","name":"Build","source":"Builder","definition":{"type":"builder"},"scope":2,"execution":{"type":"process","program":"compiler","args":[]},"options":{},"problemMatchers":[],"group":"build","isBackground":false,"detail":null});
    let execution = json!({"id":"execution-1","task":task,"active":true,"exitCode":null});
    let mut fetches = 0;
    let result = running
        .supervisor
        .begin_invoke(invocation("hello", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            Ok(match operation {
                ExtensionClientOperation::FetchTasks { .. } => {
                    fetches += 1;
                    ExtensionClientResult::Tasks {
                        sequence: 0,
                        tasks: vec![task.clone()],
                        executions: if fetches == 1 {
                            vec![]
                        } else {
                            vec![execution.clone()]
                        },
                    }
                }
                ExtensionClientOperation::ExecuteTask { .. } => {
                    for (sequence, kind) in [(1, "start"), (2, "end")] {
                        let mut event = invocation("unused", json!([]), Duration::from_secs(5));
                        event.registration_id = "vscode.tasks.events".into();
                        event.operation = "taskEvent".into();
                        event.payload =
                            json!({"type":kind,"sequence":sequence,"execution":execution});
                        event.payload["execution"]["active"] = json!(kind == "start");
                        running.supervisor.invoke(event).unwrap();
                    }
                    ExtensionClientResult::TaskExecution {
                        sequence: 1,
                        execution: execution.clone(),
                    }
                }
                other => panic!("unexpected client operation: {other:?}"),
            })
        })
        .unwrap();
    assert_eq!(result.payload, json!("completed"));
    assert_eq!(fetches, 2);
}

#[test]
fn sdk_task_only_activation_publishes_and_invokes_its_provider() {
    if !host::ProductJavaScriptLauncher::supports_platform() {
        return;
    }
    let running = start_with_launcher(r#"
        import { tasks } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(tasks.registerTaskProvider('build', 'lazy-build', {
                provideTasks() { return [{ id: 'build', label: 'Build', group: 'build', definition: { type: 'lazy-build' }, execution: { type: 'process', program: 'compiler', args: [] } }]; }
            }));
        }
    "#, vec![ExtensionCapability::TaskProvider],
        ProcessIsolationPolicy::RequireJavaScriptEnforcement(host::JavaScriptMemoryLimits::default()),
        Arc::new(host::ProductJavaScriptLauncher::new(PathBuf::from(env!("CARGO_BIN_EXE_ash-external-js-ext")))),
    ).unwrap();
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "build".into();
    request.operation = "provideTasks".into();
    request.payload = json!({});
    let provided = running.supervisor.invoke(request).unwrap().payload;
    assert_eq!(provided["tasks"][0]["definition"]["type"], "lazy-build");
}

#[test]
fn vscode_shell_execution_preserves_structured_arguments_and_shell_options() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => context.subscriptions.push(v.tasks.registerTaskProvider('builder', {
            provideTasks() {
                const execution = new v.ShellExecution({value: '${workspaceFolder}/tool name', quoting: v.ShellQuoting.Strong}, ['', {value: '$HOME', quoting: v.ShellQuoting.Strong}, {value: '$HOME', quoting: v.ShellQuoting.Weak}], {executable: '/bin/sh', shellArgs: ['-c'], cwd: '${workspaceFolder}/src', env: {MODE: 'build'}, shellQuoting: {escape: '\\', strong: "'", weak: '"'}});
                return [new v.Task({type: 'builder'}, v.TaskScope.Workspace, 'Build', 'Builder', execution)];
            }
        }));
    "#).unwrap();
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "vscode.tasks.1".into();
    request.operation = "provideTasks".into();
    request.payload = json!({});
    let provided = running.supervisor.invoke(request).unwrap().payload;
    assert_eq!(
        provided["tasks"][0]["execution"],
        json!({
            "type": "shell", "command": {"value": "${workspaceFolder}/tool name", "quoting": 2},
            "args": ["", {"value": "$HOME", "quoting": 2}, {"value": "$HOME", "quoting": 3}],
            "options": {"executable": "/bin/sh", "shellArgs": ["-c"], "shellQuoting": {"escape": "\\", "strong": "'", "weak": "\""}}
        })
    );
    assert_eq!(provided["tasks"][0]["cwd"], "${workspaceFolder}/src");
    assert_eq!(provided["tasks"][0]["env"], json!({"MODE": "build"}));
}

#[test]
fn vscode_debug_descriptor_factory_uses_resolved_configuration_and_preserves_literal_argv() {
    let running = start_vscode(r#"
        const v = require('vscode');
        let prepared;
        exports.activate = context => context.subscriptions.push(v.debug.onDidStartDebugSession(session => { if (session !== prepared) throw Error('Descriptor session identity changed'); }), v.debug.registerDebugAdapterDescriptorFactory('example', {
            createDebugAdapterDescriptor(session, executable) {
                prepared = session;
                if (!(executable instanceof v.DebugAdapterExecutable) || executable.command !== 'declared-adapter' || executable.args.join(',') !== '$HOME,' || executable.options.env.REMOVED !== null) throw Error('Default executable argument changed');
                if (session.id !== 'descriptor-session' || session.workspaceFolder.uri.path !== '/workspace' || session.name !== 'Debug') throw Error('Descriptor session metadata changed');
                return new v.DebugAdapterExecutable('adapter', [session.configuration.target, '', '$HOME']);
            }
        }));
    "#).unwrap();
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "vscode.debug.1".into();
    request.operation = "createDebugAdapterDescriptor".into();
    request.payload = json!({"executable":{"program":"declared-adapter","arguments":["$HOME",""],"env":{"REMOVED":null}},"session":{"id":"descriptor-session","workspaceFolder":{"uri":"file:///workspace","name":"workspace","index":0}},"configuration": {"name": "Debug", "type": "example", "request": "launch", "target": "/workspace/program"}});
    assert_eq!(
        running.supervisor.invoke(request.clone()).unwrap().payload,
        json!({"program": "adapter", "arguments": ["/workspace/program", "", "$HOME"]})
    );
    request.registration_id = "vscode.debug.events".into();
    request.operation = "debugEvent".into();
    request.payload = json!({"type":"start","sequence":1,"session":{"id":"descriptor-session","type":"example","name":"Debug","configuration":{"name":"Debug","type":"example","request":"launch","target":"/workspace/program"},"workspaceFolder":{"uri":"file:///workspace","name":"workspace","index":0}}});
    running.supervisor.invoke(request).unwrap();
}

#[test]
fn vscode_debug_descriptor_factories_encode_server_and_named_pipe_endpoints() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => context.subscriptions.push(v.debug.registerDebugAdapterDescriptorFactory('example', {
            createDebugAdapterDescriptor(session) {
                const target = session.configuration.target;
                return target === 'server' ? new v.DebugAdapterServer(4711, '::1') : new v.DebugAdapterNamedPipeServer('/tmp/adapter.sock');
            }
        }));
    "#).unwrap();
    for (target, expected) in [
        (
            "server",
            json!({"connection":{"type":"server","port":4711,"host":"::1"}}),
        ),
        (
            "pipe",
            json!({"connection":{"type":"namedPipe","path":"/tmp/adapter.sock"}}),
        ),
    ] {
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = "vscode.debug.1".into();
        request.operation = "createDebugAdapterDescriptor".into();
        request.payload = json!({"session":{"id":target,"workspaceFolder":{"uri":"file:///workspace","name":"workspace","index":0}},"configuration":{"name":"Debug","type":"example","request":"launch","target":target}});
        assert_eq!(
            running.supervisor.invoke(request).unwrap().payload,
            expected
        );
    }
}

#[test]
fn vscode_custom_execution_buffers_output_routes_input_and_releases_the_pty_once() {
    let running = start_vscode(r#"
        const v = require('vscode');
        let closes = 0;
        exports.activate = context => {
            context.subscriptions.push(v.commands.registerCommand('example.probe', () => closes));
            context.subscriptions.push(v.tasks.registerTaskProvider('builder', {
                provideTasks() { return [new v.Task({type: 'builder'}, v.TaskScope.Workspace, 'Custom', 'Builder', new v.CustomExecution(async definition => {
                    const output = new v.EventEmitter();
                    return {
                        onDidWrite: output.event,
                        open(dimensions) { output.fire('OPEN:' + dimensions.columns + ':' + definition.target); },
                        handleInput(data) { output.fire('INPUT:' + data); },
                        setDimensions(dimensions) { output.fire('SIZE:' + dimensions.rows); },
                        close() { closes++; output.dispose(); }
                    };
                }))]; }
            }));
        };
    "#).unwrap();
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "vscode.tasks.1".into();
    request.operation = "provideTasks".into();
    request.payload = json!({});
    let task = running.supervisor.invoke(request.clone()).unwrap().payload;
    let execution_id = &task["tasks"][0]["execution"]["id"];
    request.operation = "createTaskTerminal".into();
    request.payload =
        json!({"executionId": execution_id, "definition": {"type": "builder", "target": "app"}});
    let created = running.supervisor.invoke(request.clone()).unwrap().payload;
    assert_eq!(created["acceptsInput"], true);
    for (operation, payload, output) in [
        (
            "openTaskTerminal",
            json!({"dimensions": {"columns": 80, "rows": 24}}),
            "OPEN:80:app",
        ),
        ("inputTaskTerminal", json!({"data": "hello"}), "INPUT:hello"),
        (
            "resizeTaskTerminal",
            json!({"dimensions": {"columns": 90, "rows": 30}}),
            "SIZE:30",
        ),
    ] {
        request.operation = operation.into();
        request.payload = payload;
        request.payload["ptyId"] = created["ptyId"].clone();
        assert_eq!(
            running.supervisor.invoke(request.clone()).unwrap().payload,
            json!({"events": [{"type": "data", "data": output}]})
        );
    }
    request.operation = "closeTaskTerminal".into();
    request.payload = json!({"ptyId": created["ptyId"]});
    running.supervisor.invoke(request.clone()).unwrap();
    running.supervisor.invoke(request).unwrap();
    assert_eq!(run(&running, "probe", json!([])).unwrap(), json!(1));
}

#[test]
fn vscode_status_bar_replaces_hidden_arguments_and_releases_published_entries() {
    let running = start_vscode(r#"
        const v = require('vscode');
        const item = v.window.createStatusBarItem('status', v.StatusBarAlignment.Right, 1.5);
        exports.activate = context => {
            const defaultItem = v.window.createStatusBarItem();
            if (defaultItem.alignment !== v.StatusBarAlignment.Left || defaultItem.priority !== undefined || defaultItem.id !== 'test.example') throw Error('Invalid default status bar overload');
            defaultItem.dispose();
            item.text = 'Initial'; item.tooltip = 'Run'; item.accessibilityInformation = { label: 'Run extension status' };
            item.command = { command: 'example.probe', title: 'Probe', arguments: [{ value: 0 }] };
            item.show();
            context.subscriptions.push(item, v.commands.registerCommand('example.probe', arg => arg.value));
            context.subscriptions.push(v.commands.registerCommand('example.hello', mode => {
                if (mode === 'hide') {
                    item.hide();
                    // Retaining the previous argument on every hidden replacement exceeds the isolate's heap budget.
                    for (let index = 0; index < 512; index++) item.command = { command: 'example.probe', title: 'Probe', arguments: [Array(32768).fill(index)] };
                    item.command = { command: 'example.probe', title: 'Probe', arguments: [{ value: 512 }] };
                } else if (mode === 'show') { item.text = 'Current'; item.show(); }
                else if (mode === 'dispose') { item.dispose(); item.dispose(); if (item.command !== undefined) throw Error('Disposed item retained command'); }
            }));
        };
    "#).unwrap();
    let initial = running.supervisor.snapshot();
    let status = initial
        .registrations
        .iter()
        .find(|registration| registration.registration_id == "vscode.statusBar")
        .unwrap();
    let external_ext_protocol::RegistrationKind::StatusBar { entries, .. } = &status.kind else {
        panic!("missing status bar");
    };
    assert_eq!(entries[0].priority.as_f64(), Some(1.5));
    assert_eq!(entries[0].text, "Initial");
    assert_eq!(
        entries[0].aria_label.as_deref(),
        Some("Run extension status")
    );
    drop(initial);
    for (mode, expected_count) in [("hide", 0), ("show", 1), ("dispose", 0)] {
        let handle = running
            .supervisor
            .begin_invoke(invocation("hello", json!([mode]), Duration::from_secs(10)))
            .unwrap();
        let mut requests = 0;
        handle
            .wait_with_client(|operation, _, _| {
                let ExtensionClientOperation::SetStatusBarEntries {
                    registration_id,
                    entries,
                    ..
                } = operation
                else {
                    panic!("unexpected operation");
                };
                requests += 1;
                assert_eq!(registration_id, "vscode.statusBar");
                assert_eq!(entries.len(), expected_count);
                if expected_count == 1 {
                    assert_eq!(entries[0].text, "Current");
                    assert_eq!(
                        entries[0].command.as_ref().unwrap().arguments,
                        json!([{ "value": 512 }]).as_array().unwrap().clone()
                    );
                }
                Ok(ExtensionClientResult::Done)
            })
            .unwrap();
        assert_eq!(requests, 1);
        let snapshot = running.supervisor.snapshot();
        let status = snapshot
            .registrations
            .iter()
            .find(|registration| registration.registration_id == "vscode.statusBar")
            .unwrap();
        let external_ext_protocol::RegistrationKind::StatusBar { entries, .. } = &status.kind
        else {
            panic!("missing status bar");
        };
        assert_eq!(entries.len(), expected_count);
    }
    assert_eq!(
        run(&running, "probe", json!([{ "value": 512 }])).unwrap(),
        json!(512)
    );
    running.supervisor.shutdown().unwrap();
}

#[test]
fn status_bar_snapshots_accept_only_acknowledged_updates_for_owned_registrations() {
    let running = start_with_capabilities(r#"
        import { commands, window } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(window.registerStatusBar('status', () => ({ revision: 1, entries: [] })));
            context.subscriptions.push(commands.registerCommand('example.update', 'Update', async (call, id, revision) => {
                try { await call.window.setStatusBarEntries(id, revision, []); return 'ok'; }
                catch (error) { return error.code; }
            }));
        }
    "#, vec![ExtensionCapability::Command, ExtensionCapability::StatusBar]).unwrap();
    for (id, revision, permit, expected) in [
        ("foreign", 2, true, "registrationNotFound"),
        ("example.update", 2, true, "registrationNotFound"),
        ("status", 2, true, "ok"),
        ("status", 1, true, "ok"),
        ("status", 3, false, "permissionDenied"),
    ] {
        let handle = running
            .supervisor
            .begin_invoke(invocation(
                "update",
                json!([id, revision]),
                Duration::from_secs(5),
            ))
            .unwrap();
        let mut calls = 0;
        let result = handle
            .wait_with_client(|_, _, _| {
                calls += 1;
                if permit {
                    Ok(ExtensionClientResult::Done)
                } else {
                    Err(host::HostFailure {
                        code: HostErrorCode::PermissionDenied,
                        message: "Rejected".into(),
                    })
                }
            })
            .unwrap();
        assert_eq!(result.payload, json!(expected));
        assert_eq!(calls, usize::from(id == "status"));
    }
    let snapshot = running.supervisor.snapshot();
    let status = snapshot
        .registrations
        .iter()
        .find(|registration| registration.registration_id == "status")
        .unwrap();
    assert!(matches!(
        status.kind,
        external_ext_protocol::RegistrationKind::StatusBar { revision: 2, .. }
    ));
    running.supervisor.shutdown().unwrap();
}

fn hover_invocation(text: &str) -> ExtensionInvocation {
    let mut request = invocation("hover", json!([]), Duration::from_secs(5));
    request.operation = "hover".into();
    request.payload = json!({
        "resource": "file:///workspace/data.ts", "languageId": "typescript",
        "version": 7, "text": text, "position": {"lineIndex": 0, "columnIndex": 1}
    });
    request
}

#[test]
fn author_sdk_document_callbacks_publish_diagnostics_and_completion_ranges() {
    let running = start_with_capabilities(r#"
        import { workspace, languages } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(workspace.registerTextDocumentEvents('example.documents', async (call, event) => {
                await call.languages.setDiagnostics('lint', [{ uri:event.document.uri, version:event.document.version, diagnostics:[{
                    start:{line:0,character:2}, end:{line:0,character:4}, message:'Check word', severity:'hint', source:'example', code:null
                }] }]);
            }), languages.registerCompletionProvider('example.complete', ['typescript'], {
                provideCompletionItems(call, document, position, trigger) {
                    if (document.getText() !== '😀ab' || position.character !== 4 || trigger.kind !== 'invoke') throw Error('Author completion context lost');
                    return { isIncomplete:false, items:[{ id:'word', label:'abcd', kind:'text', range:{start:{line:0,character:2},end:position}, insertText:'abcd', insertTextFormat:'plainText' }] };
                }
            }, ['.']));
        }
    "#, vec![ExtensionCapability::LanguageProvider]).unwrap();
    let mut request = hover_invocation("😀ab");
    request.registration_id = "example.documents".into();
    request.operation = "documentEvent".into();
    request.payload = json!({"type":"open","document":{"uri":"file:///main.ts","version":7,"languageId":"typescript","text":"😀ab"}});
    running.supervisor.begin_invoke(request).unwrap().wait_with_client(|operation, _, _| {
        assert!(matches!(operation, ExtensionClientOperation::SetDiagnostics { entries, .. } if entries[0].version == Some(7) && entries[0].diagnostics[0].end.character == 4));
        Ok(ExtensionClientResult::Done)
    }).unwrap();
    let mut completion = hover_invocation("😀ab");
    completion.registration_id = "example.complete".into();
    completion.operation = "completion".into();
    completion.payload["position"]["columnIndex"] = json!(4);
    completion.payload["context"] = json!({"kind":"invoke"});
    let result = running.supervisor.invoke(completion).unwrap();
    assert_eq!(
        result.payload["items"][0]["range"],
        json!({"start":{"lineIndex":0,"columnIndex":2},"end":{"lineIndex":0,"columnIndex":4}})
    );
}

#[test]
fn diagnostics_keep_the_version_read_before_an_await_when_live_documents_change() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => {
            const collection = v.languages.createDiagnosticCollection('lint');
            context.subscriptions.push(collection, v.commands.registerCommand('example.hello', async () => {
                const document = v.workspace.textDocuments[0];
                const original = document.getText();
                await v.window.showInformationMessage('pause');
                const first = new v.Diagnostic(new v.Range(0,0,0,original.length), original);
                const second = new v.Diagnostic(new v.Range(0,0,0,original.length), 'Second');
                collection.set([[document.uri,[first]],[document.uri,[second]]]);
                if (collection.get(document.uri).length !== 2) throw Error('Duplicate tuples were not merged');
            }));
        };
        exports.deactivate = () => {
            if (v.workspace.textDocuments[0].getText() !== 'new text') throw Error('Cached reads require no client call');
        };
    "#).unwrap();
    let mut event = invocation("unused", json!([]), Duration::from_secs(5));
    event.registration_id = "vscode.documents".into();
    event.operation = "documentEvent".into();
    event.payload = json!({"type":"open","document":{"uri":"file:///main.ts","version":1,"languageId":"typescript","text":"old"}});
    running.supervisor.invoke(event.clone()).unwrap();
    let command = running
        .supervisor
        .begin_invoke(invocation("hello", json!([]), Duration::from_secs(5)))
        .unwrap();
    let mut version = None;
    command.wait_with_client(|operation, _, _| {
        match operation {
            ExtensionClientOperation::ShowMessage { .. } => {
                event.payload = json!({"type":"change","document":{"uri":"file:///main.ts","version":2,"languageId":"typescript","text":"new text"},"reason":"edit","contentChanges":[]});
                running.supervisor.invoke(event.clone()).unwrap();
            }
            ExtensionClientOperation::SetDiagnostics { entries, .. } => {
                assert_eq!(entries[0].diagnostics.len(), 2);
                assert_eq!(entries[0].diagnostics[0].message, "old");
                version = entries[0].version;
            }
            operation => panic!("unexpected request {operation:?}"),
        }
        Ok(ExtensionClientResult::Done)
    }).unwrap();
    assert_eq!(version, Some(1));
    running.supervisor.shutdown().unwrap();
}

#[test]
fn vscode_document_events_drive_diagnostics_with_unsaved_versions_and_close_lifetimes() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => {
            const collection = v.languages.createDiagnosticCollection('lint');
            let opened;
            context.subscriptions.push(collection,
                v.workspace.onDidOpenTextDocument(doc => { opened = doc; }),
                v.workspace.onDidChangeTextDocument(event => {
                    if (event.document !== opened || event.document.getText() !== '😀bad') throw Error('Document identity/text changed');
                    if (event.contentChanges[0].range.start.character !== 2) throw Error('UTF16 change range lost');
                    collection.set(event.document.uri, [new v.Diagnostic(new v.Range(0,2,0,5), 'Bad word', v.DiagnosticSeverity.Warning)]);
                }),
                v.workspace.onDidCloseTextDocument(doc => {
                    if (!doc.isClosed || v.workspace.textDocuments.length) throw Error('Closed document retained');
                    collection.delete(doc.uri);
                }));
        };
    "#).unwrap();
    for (kind, version, text) in [
        ("open", 1, "😀"),
        ("change", 2, "😀bad"),
        ("close", 2, "😀bad"),
    ] {
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = "vscode.documents".into();
        request.operation = "documentEvent".into();
        request.payload = json!({"type":kind,"document":{"uri":"file:///main.ts","languageId":"typescript","version":version,"text":text},"reason":"edit","contentChanges":[{"range":{"start":{"line":0,"character":2},"end":{"line":0,"character":2}},"rangeOffset":2,"rangeLength":0,"text":"bad"}]});
        let mut calls = Vec::new();
        running
            .supervisor
            .begin_invoke(request)
            .unwrap()
            .wait_with_client(|operation, _, _| {
                calls.push(operation);
                Ok(ExtensionClientResult::Done)
            })
            .unwrap();
        if kind == "open" {
            assert!(calls.is_empty());
        } else if kind == "change" {
            assert!(
                matches!(&calls[0], ExtensionClientOperation::SetDiagnostics { entries, .. } if entries[0].version == Some(2) && entries[0].diagnostics[0].start.character == 2)
            );
        } else {
            assert!(
                matches!(&calls[0], ExtensionClientOperation::SetDiagnostics { entries, .. } if entries.is_empty())
            );
        }
    }
}

#[test]
fn vscode_completion_preserves_trigger_context_snippets_utf16_and_provider_disposal() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => {
            const registration = v.languages.registerCompletionItemProvider('typescript', {
                provideCompletionItems(doc, position, token, trigger) {
                    if (doc.getText() !== '😀al' || position.character !== 4 || trigger.triggerKind !== 1 || trigger.triggerCharacter !== '.') throw Error('Completion context lost');
                    const item = new v.CompletionItem('alpha', v.CompletionItemKind.Function);
                    item.insertText = new v.SnippetString('alpha(${1:value})');
                    return new v.CompletionList([item], true);
                }
            }, '.');
            context.subscriptions.push(registration, v.commands.registerCommand('example.hello', () => registration.dispose()));
        };
    "#).unwrap();
    let mut request = hover_invocation("😀al");
    request.registration_id = "vscode.completion.1".into();
    request.operation = "completion".into();
    request.payload["position"]["columnIndex"] = json!(4);
    request.payload["context"] = json!({"kind":"triggerCharacter","triggerCharacter":"."});
    let result = running.supervisor.invoke(request.clone()).unwrap();
    assert_eq!(
        result.payload,
        json!({"isIncomplete":true,"items":[{"id":"0","label":"alpha","kind":"function","range":{"start":{"lineIndex":0,"columnIndex":2},"end":{"lineIndex":0,"columnIndex":4}},"insertText":"alpha(${1:value})","insertTextFormat":"snippet"}]})
    );
    run(&running, "hello", json!([])).unwrap();
    assert!(running.supervisor.invoke(request).is_err());
}

#[test]
fn vscode_commonjs_commands_keep_standard_arguments_and_drain_unawaited_notifications() {
    let running = start_vscode(r#"
        const vscode = require('vscode');
        const topLevelExports = this === exports;
        exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('example.hello', function(value) {
            if (!topLevelExports) throw new Error('CommonJS receiver changed');
            vscode.window.showInformationMessage(this.prefix + value);
            return value;
        }, {prefix: 'hello:'}));
    "#).unwrap();
    let mut messages = Vec::new();
    let result = running
        .supervisor
        .begin_invoke(invocation(
            "hello",
            json!(["world"]),
            Duration::from_secs(5),
        ))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            messages.push(operation);
            Ok(ExtensionClientResult::Done)
        })
        .unwrap();
    assert_eq!(result.payload, json!("world"));
    assert_eq!(
        messages,
        vec![ExtensionClientOperation::ShowMessage {
            message: "hello:world".into(),
            severity: external_ext_protocol::ExtensionMessageSeverity::Information
        }]
    );
}

#[test]
fn vscode_callbacks_can_handle_a_service_rejection() {
    let running = start_vscode(r#"
        const vscode = require('vscode');
        exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('example.hello', async () => {
            try { await vscode.workspace.openTextDocument(vscode.Uri.file('/workspace/missing.txt')); }
            catch (error) { return error.message; }
            throw new Error('Expected a rejected document read');
        }));
    "#).unwrap();
    let result = running
        .supervisor
        .begin_invoke(invocation("hello", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|_, _, _| {
            Err(external_ext_protocol::HostFailure {
                code: HostErrorCode::InvalidRequest,
                message: "Document read denied".into(),
            })
        })
        .unwrap();
    assert!(
        result
            .payload
            .as_str()
            .unwrap()
            .contains("Document read denied")
    );
}

#[test]
fn vscode_await_continuations_keep_each_overlapping_invocations_identity() {
    let running = start_vscode(r#"
        const vscode = require('vscode');
        exports.activate = context => context.subscriptions.push(vscode.commands.registerCommand('example.async', async name => {
            await vscode.window.showInformationMessage('begin:' + name);
            await Promise.resolve();
            await vscode.window.showInformationMessage('end:' + name);
            return name;
        }));
    "#).unwrap();
    let first = running
        .supervisor
        .begin_invoke(invocation(
            "async",
            json!(["first"]),
            Duration::from_secs(5),
        ))
        .unwrap();
    let second = running
        .supervisor
        .begin_invoke(invocation(
            "async",
            json!(["second"]),
            Duration::from_secs(5),
        ))
        .unwrap();
    for (pending, name) in [(first, "first"), (second, "second")] {
        let mut calls = Vec::new();
        let result = pending
            .wait_with_client(|operation, _, _| {
                calls.push(operation);
                Ok(ExtensionClientResult::Done)
            })
            .unwrap();
        assert_eq!(result.payload, json!(name));
        assert_eq!(calls.len(), 2);
        assert!(
            matches!(&calls[1], ExtensionClientOperation::ShowMessage { message, .. } if message == &format!("end:{name}"))
        );
    }
}

#[test]
fn vscode_detached_continuations_cannot_borrow_a_later_invocations_authority() {
    let running = start_vscode(r#"
        const vscode = require('vscode');
        let release, detached;
        exports.activate = context => {
            context.subscriptions.push(vscode.commands.registerCommand('example.hello', () => {
                detached = new Promise(resolve => release = resolve).then(() => vscode.window.showInformationMessage('escaped')).catch(error => error.message);
            }));
            context.subscriptions.push(vscode.commands.registerCommand('example.probe', async () => { release(); return await detached; }));
        };
    "#).unwrap();
    assert_eq!(run(&running, "hello", json!([])).unwrap(), Value::Null);
    assert_eq!(
        run(&running, "probe", json!([])).unwrap(),
        json!("VS Code service call has no active invocation")
    );
}

#[test]
fn vscode_hover_and_document_reads_keep_unsaved_text_and_utf16_positions() {
    let running = start_vscode(r#"
        const vscode = require('vscode');
        exports.activate = context => context.subscriptions.push(vscode.languages.registerHoverProvider('typescript', {
            async provideHover(document, position, token) {
                const opened = await vscode.workspace.openTextDocument(document.uri);
                const range = new vscode.Range(new vscode.Position(0, 0), position);
                return new vscode.Hover(new vscode.MarkdownString(JSON.stringify({
                    text: document.getText(range), opened: opened.getText(), uri: opened.uri.toString(),
                    version: document.version, language: document.languageId, character: position.character,
                    cancelled: token.isCancellationRequested
                })), range);
            }
        }));
    "#).unwrap();
    let mut request = hover_invocation("😀ab\r\nunsaved");
    request.registration_id = "vscode.hover.1".into();
    request.payload["position"]["columnIndex"] = json!(4);
    let result = running
        .supervisor
        .begin_invoke(request)
        .unwrap()
        .wait_with_client(|operation, _, _| {
            assert_eq!(
                operation,
                ExtensionClientOperation::ReadDocument {
                    uri: "file:///workspace/data.ts".into()
                }
            );
            Ok(ExtensionClientResult::Document {
                document: ExtensionDocumentSnapshot {
                    uri: "file:///workspace/data.ts".into(),
                    version: 7,
                    language_id: "typescript".into(),
                    text: "unsaved editor content".into(),
                },
            })
        })
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(result.payload["contents"][0]["value"].as_str().unwrap())
            .unwrap(),
        json!({
            "text": "😀ab", "opened": "unsaved editor content", "uri": "file:///workspace/data.ts",
            "version": 7, "language": "typescript", "character": 4, "cancelled": false
        })
    );
    assert_eq!(
        result.payload["range"],
        json!({"start": {"lineIndex": 0, "columnIndex": 0}, "end": {"lineIndex": 0, "columnIndex": 4}})
    );
}

#[test]
fn vscode_node_modules_and_unimplemented_apis_are_rejected_explicitly() {
    assert!(start_vscode("require('fs'); exports.activate = () => {};").is_err());
    assert!(
        start_vscode("require('vscode').authentication; exports.activate = () => {};").is_err()
    );
    assert!(start_vscode("exports.activate = () => require('vscode').commands.registerCommand('undeclared', () => {});").is_err());
}

#[test]
fn hover_receives_frozen_unsaved_utf16_snapshot_and_can_call_authorized_services() {
    let running = start_with_capabilities(
        include_str!("fixtures/hover.js"),
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::LanguageProvider,
            ExtensionCapability::StatusBar,
        ],
    )
    .unwrap();
    let mut request = hover_invocation("😀ab\r\nsecond");
    request.payload["position"]["columnIndex"] = json!(4);
    let result = running
        .supervisor
        .begin_invoke(request)
        .unwrap()
        .wait_with_client(|operation, _, _| {
            assert_eq!(
                operation,
                ExtensionClientOperation::ReadWorkspaceFile {
                    path: "data.txt".into()
                }
            );
            Ok(ExtensionClientResult::File {
                text: "disk content".into(),
            })
        })
        .unwrap();
    let mut actual = result.payload;
    actual["contents"][0] = serde_json::from_str(actual["contents"][0].as_str().unwrap()).unwrap();
    assert_eq!(
        actual,
        json!({
            "contents": [json!({
                "uri": "file:///workspace/data.ts", "version": 7, "text": "😀ab\r\nsecond",
                "position": {"line": 0, "character": 4}, "disk": "disk content", "frozen": true
        }), {"language": "typescript", "value": "const value = 1;"}],
            "range": {"start": {"lineIndex": 0, "columnIndex": 0}, "end": {"lineIndex": 0, "columnIndex": 4}}
        })
    );
}

#[test]
fn hover_requires_declared_capability_and_rejects_invalid_snapshots_and_disposed_callback() {
    assert!(start(include_str!("fixtures/hover.js")).is_err());
    let running = start_with_capabilities(
        include_str!("fixtures/hover.js"),
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::LanguageProvider,
            ExtensionCapability::StatusBar,
        ],
    )
    .unwrap();
    for (field, value) in [
        ("languageId", json!("rust")),
        ("version", json!(0)),
        ("position", json!({"lineIndex": 0, "columnIndex": 100})),
    ] {
        let mut request = hover_invocation("unsaved");
        request.payload[field] = value;
        assert!(matches!(
            running.supervisor.invoke(request),
            Err(ExtensionHostError::HostRejected { .. })
        ));
    }
    assert!(
        running
            .supervisor
            .invoke(hover_invocation("reversed"))
            .is_err()
    );
    assert_eq!(
        running
            .supervisor
            .invoke(hover_invocation("absent"))
            .unwrap()
            .payload,
        Value::Null
    );
    assert!(
        running
            .supervisor
            .invoke(invocation("hover", json!([]), Duration::from_secs(5)))
            .is_err()
    );
    run(&running, "disposeHover", json!([])).unwrap();
    assert!(matches!(
        running.supervisor.invoke(hover_invocation("absent")),
        Err(ExtensionHostError::HostRejected { .. })
    ));
}

#[test]
fn cancelling_a_pending_hover_retires_its_isolate_and_restores_the_provider_in_a_new_one() {
    let running = start_with_capabilities(
        include_str!("fixtures/hover.js"),
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::LanguageProvider,
            ExtensionCapability::StatusBar,
        ],
    )
    .unwrap();
    let before = running.supervisor.snapshot().incarnation;
    let pending = running
        .supervisor
        .begin_invoke(hover_invocation("pending"))
        .unwrap();
    // Completing a later command proves the engine reached the pending provider before cancellation.
    run(&running, "disposeHover", json!([])).unwrap();
    pending.cancel(host::CancelReason::Caller).unwrap();
    assert!(pending.wait().is_err());
    assert_eq!(
        running
            .supervisor
            .invoke(hover_invocation("absent"))
            .unwrap()
            .payload,
        Value::Null
    );
    assert!(running.supervisor.snapshot().incarnation > before);
}

#[test]
fn activates_esm_sdk_and_releases_subscriptions_without_node_globals() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    assert_eq!(running.supervisor.snapshot().registrations.len(), 15);
    assert_eq!(
        run(&running, "globals", json!([])).unwrap(),
        json!(["undefined", "undefined", "undefined", "undefined"])
    );
    assert_eq!(
        run(&running, "echo", json!([{"nested": [1, true]}])).unwrap(),
        json!({"nested": [1, true]})
    );
    running.supervisor.shutdown().unwrap();
    assert_eq!(
        running.supervisor.snapshot().status,
        ExtensionHostStatus::Stopped
    );
}

#[test]
fn editor_snapshot_and_rust_disk_read_stay_distinct() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    use ash_file_system::FileSystem;
    use ash_file_system::LocalFileSystem;
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("data.txt"), "on disk").unwrap();
    let files = LocalFileSystem::new(Grant::for_environment(
        Dir::open_local(workspace.path()).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    ));
    let running = start(include_str!("fixtures/main.js")).unwrap();
    let mut calls = Vec::new();
    let result = running
        .supervisor
        .begin_invoke(invocation(
            "inspect",
            json!(["file:///workspace/data.txt", "data.txt"]),
            Duration::from_secs(5),
        ))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            calls.push(operation.clone());
            Ok(match operation {
                ExtensionClientOperation::ReadDocument { uri } => ExtensionClientResult::Document {
                    document: ExtensionDocumentSnapshot {
                        uri,
                        version: 7,
                        language_id: "plaintext".into(),
                        text: "unsaved editor".into(),
                    },
                },
                ExtensionClientOperation::ReadWorkspaceFile { path } => {
                    ExtensionClientResult::File {
                        text: String::from_utf8(
                            files
                                .read_file(std::path::Path::new(&path), 256 * 1024)
                                .unwrap(),
                        )
                        .unwrap(),
                    }
                }
                ExtensionClientOperation::ShowMessage { .. } => ExtensionClientResult::Done,
                operation => panic!("unexpected request {operation:?}"),
            })
        })
        .unwrap();
    assert_eq!(
        result.payload,
        json!({"editor": "unsaved editor", "version": 7, "disk": "on disk", "frozen": true})
    );
    assert_eq!(calls.len(), 3);
}

#[test]
fn callback_failures_and_forged_operations_do_not_break_the_next_command() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    for id in ["fail", "forge"] {
        assert!(matches!(
            run(&running, id, json!([])),
            Err(ExtensionHostError::HostRejected {
                code: HostErrorCode::Internal,
                ..
            })
        ));
    }
    assert_eq!(
        run(&running, "echo", json!(["after failure"])).unwrap(),
        json!("after failure")
    );
}

#[test]
fn invocation_authority_cannot_be_kept_for_background_calls() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    run(&running, "capture", json!([])).unwrap();
    assert!(matches!(
        run(&running, "retired", json!([])),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::Internal,
            ..
        })
    ));
    running.authority.0.store(false, Ordering::Release);
    assert!(matches!(
        run(&running, "echo", json!([])),
        Err(ExtensionHostError::AuthorityDenied)
    ));
}

#[test]
fn deadlines_stop_synchronous_code_promise_continuations_rejection_coercion_and_pending_promises() {
    for id in ["spin", "continuationSpin", "rejectionSpin", "wait"] {
        let running = start(include_str!("fixtures/main.js")).unwrap();
        let before = std::time::Instant::now();
        assert!(
            running
                .supervisor
                .invoke(invocation(id, json!([]), Duration::from_millis(250)))
                .is_err()
        );
        assert!(
            before.elapsed() < Duration::from_secs(3),
            "{id} exceeded the shutdown bound"
        );
    }
}

#[test]
fn rejects_node_imports_and_rejected_module_initialization() {
    for source in [
        "import fs from 'node:fs'; export function activate() {}",
        "throw new Error('module failed'); export function activate() {}",
        "await new Promise(() => {}); export function activate() {}",
    ] {
        assert!(start(source).is_err());
    }
}

#[test]
fn rust_failure_code_is_available_to_the_extension_author() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    let result = running
        .supervisor
        .begin_invoke(invocation("readFailure", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            assert!(matches!(
                operation,
                ExtensionClientOperation::ReadWorkspaceFile { .. }
            ));
            Err(external_ext_protocol::HostFailure {
                code: HostErrorCode::InvalidRequest,
                message: "path outside workspace".into(),
            })
        })
        .unwrap();
    assert_eq!(
        result.payload,
        json!({"typed": true, "code": "invalidRequest"})
    );
}

#[test]
fn cooperative_cancellation_rejects_queued_services_and_preserves_the_extension_incarnation() {
    let running = start(r#"
        import { commands } from '@ash/extension';
        let state;
        export function activate(context) {
            context.subscriptions.push(commands.registerCommand('example.wait', 'Wait', async call => {
                state = { cancelled: false, notifications: 0, blocked: false, childRejected: false };
                const child = call.window.showInformationMessage('queued').catch(() => { state.childRejected = true; });
                await new Promise(resolve => call.cancellationToken.onCancellationRequested(async () => {
                    state.cancelled = call.cancellationToken.isCancellationRequested;
                    state.notifications++;
                    try { await call.window.showInformationMessage('after cancellation'); } catch (error) { state.blocked = error.code === 'cancelled'; }
                    resolve();
                }));
                await child;
                return 'discard this result';
            }));
            context.subscriptions.push(commands.registerCommand('example.probe', 'Probe', () => state));
        }
    "#).unwrap();
    let incarnation = running.supervisor.snapshot().incarnation;
    let pending = running
        .supervisor
        .begin_invoke(invocation("wait", json!([]), Duration::from_secs(5)))
        .unwrap();
    assert_eq!(
        run(&running, "probe", json!([])).unwrap()["cancelled"],
        false
    );
    pending.cancel(host::CancelReason::Caller).unwrap();
    let outcome = pending.wait_with_client(|_, _, _| panic!("cancelled child must not execute"));
    assert!(matches!(
        outcome,
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::Cancelled,
            ..
        })
    ));
    assert_eq!(
        run(&running, "probe", json!([])).unwrap(),
        json!({"cancelled": true, "notifications": 1, "blocked": true, "childRejected": true})
    );
    assert_eq!(running.supervisor.snapshot().incarnation, incarnation);
}

#[test]
fn vscode_tasks_and_debug_callbacks_receive_independent_live_cancellation_tokens() {
    let running = start_vscode(r#"
        const v = require('vscode');
        const states = [];
        function wait(token, value) {
            const state = { token, calls: 0, late: 0, disposed: 0, value };
            states.push(state);
            const subscriptions = [];
            const removed = token.onCancellationRequested(() => state.disposed++);
            removed.dispose();
            return new Promise(resolve => {
                state.release = () => resolve(value);
                token.onCancellationRequested(function() {
                    if (this !== state || !token.isCancellationRequested) throw Error('Invalid cancellation event');
                    this.calls++;
                    token.onCancellationRequested(() => this.late++);
                    const suppressed = token.onCancellationRequested(() => this.disposed++);
                    suppressed.dispose();
                    state.release();
                }, state, subscriptions);
                if (subscriptions.length !== 1) throw Error('Missing disposable');
            });
        }
        exports.activate = context => context.subscriptions.push(
            v.commands.registerCommand('example.probe', release => {
                if (release) states.at(-1).release();
                return states.map(state => ({ cancelled: state.token.isCancellationRequested, calls: state.calls, late: state.late, disposed: state.disposed }));
            }),
            v.tasks.registerTaskProvider('builder', {
                provideTasks(token) { return wait(token, []); },
                resolveTask(task, token) { return wait(token, undefined); }
            }),
            v.debug.registerDebugConfigurationProvider('example', {
                provideDebugConfigurations(folder, token) { return wait(token, []); },
                resolveDebugConfiguration(folder, configuration, token) { return wait(token, configuration); },
                resolveDebugConfigurationWithSubstitutedVariables(folder, configuration, token) { return wait(token, configuration); }
            })
        );
    "#).unwrap();
    let incarnation = running.supervisor.snapshot().incarnation;
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "vscode.tasks.1".into();
    request.operation = "provideTasks".into();
    request.payload = json!({});
    let first = running.supervisor.begin_invoke(request.clone()).unwrap();
    let second = running.supervisor.begin_invoke(request.clone()).unwrap();
    assert_eq!(
        run(&running, "probe", json!([]))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        2
    );
    first.cancel(host::CancelReason::Caller).unwrap();
    assert!(matches!(
        first.wait(),
        Err(ExtensionHostError::HostRejected {
            code: HostErrorCode::Cancelled,
            ..
        })
    ));
    assert_eq!(
        run(&running, "probe", json!([true])).unwrap(),
        json!([
            {"cancelled": true, "calls": 1, "late": 1, "disposed": 0},
            {"cancelled": false, "calls": 0, "late": 0, "disposed": 0}
        ])
    );
    assert_eq!(second.wait().unwrap().payload, json!({"tasks": []}));
    for (registration, operation, payload) in [
        (
            "vscode.tasks.1",
            "resolveTask",
            json!({"task": {"id": "configured", "name": "Build", "source": "Workspace", "scope": 2, "definition": {"type": "builder"}, "options": {}}}),
        ),
        (
            "vscode.debugConfiguration.2",
            "provideDebugConfigurations",
            json!({}),
        ),
        (
            "vscode.debugConfiguration.2",
            "resolveDebugConfiguration",
            json!({"configuration": {"type": "example", "name": "Debug", "request": "launch"}}),
        ),
        (
            "vscode.debugConfiguration.2",
            "resolveDebugConfigurationWithSubstitutedVariables",
            json!({"configuration": {"type": "example", "name": "Debug", "request": "launch"}}),
        ),
    ] {
        request.registration_id = registration.into();
        request.operation = operation.into();
        request.payload = payload;
        let pending = running.supervisor.begin_invoke(request.clone()).unwrap();
        assert_eq!(
            run(&running, "probe", json!([]))
                .unwrap()
                .as_array()
                .unwrap()
                .last()
                .unwrap()["cancelled"],
            false
        );
        pending.cancel(host::CancelReason::Caller).unwrap();
        assert!(matches!(
            pending.wait(),
            Err(ExtensionHostError::HostRejected {
                code: HostErrorCode::Cancelled,
                ..
            })
        ));
        assert_eq!(
            run(&running, "probe", json!([]))
                .unwrap()
                .as_array()
                .unwrap()
                .last()
                .unwrap(),
            &json!({"cancelled": true, "calls": 1, "late": 1, "disposed": 0})
        );
    }
    assert_eq!(running.supervisor.snapshot().incarnation, incarnation);
}

#[test]
fn vscode_cancellation_sources_release_listeners_and_notify_once() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => context.subscriptions.push(v.commands.registerCommand('example.probe', async () => {
            const source = new v.CancellationTokenSource();
            const disposed = new v.CancellationTokenSource();
            const events = [];
            const subscriptions = [];
            source.token.onCancellationRequested(function() { events.push(this.name); }, {name: 'cancel'}, subscriptions);
            disposed.token.onCancellationRequested(() => events.push('disposed'));
            disposed.dispose(); disposed.cancel();
            source.cancel(); source.cancel();
            source.token.onCancellationRequested(() => events.push('late'));
            events.push('synchronous');
            await Promise.resolve();
            subscriptions[0].dispose(); source.dispose();
            return [source.token.isCancellationRequested, disposed.token.isCancellationRequested, events];
        }));
    "#).unwrap();
    assert_eq!(
        run(&running, "probe", json!([])).unwrap(),
        json!([true, false, ["cancel", "synchronous", "late"]])
    );
}

#[test]
fn cancellation_retires_the_isolate_and_a_new_command_uses_a_new_incarnation() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    let before = running.supervisor.snapshot().incarnation;
    let pending = running
        .supervisor
        .begin_invoke(invocation("wait", json!([]), Duration::from_secs(5)))
        .unwrap();
    // A second completed command proves the engine accepted the waiting invocation first.
    assert_eq!(
        run(&running, "echo", json!(["ready"])).unwrap(),
        json!("ready")
    );
    pending.cancel(host::CancelReason::Caller).unwrap();
    assert!(pending.wait().is_err());
    assert_eq!(
        run(&running, "echo", json!(["recovered"])).unwrap(),
        json!("recovered")
    );
    assert!(running.supervisor.snapshot().incarnation > before);
}

#[test]
fn quick_pick_preserves_selection_and_cancellation() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    for (index, expected) in [(Some(1), json!("second")), (None, Value::Null)] {
        let result = running
            .supervisor
            .begin_invoke(invocation("pick", json!([]), Duration::from_secs(5)))
            .unwrap()
            .wait_with_client(|operation, _, _| {
                assert!(matches!(
                    operation,
                    ExtensionClientOperation::ShowQuickPick { .. }
                ));
                Ok(ExtensionClientResult::Selection { index })
            })
            .unwrap();
        assert_eq!(result.payload, expected);
    }
}

#[test]
fn heap_quota_retires_only_the_extension_process() {
    let running = start(include_str!("fixtures/main.js")).unwrap();
    assert!(
        running
            .supervisor
            .invoke(invocation("heap", json!([]), Duration::from_secs(3)))
            .is_err()
    );
    assert_eq!(
        run(&running, "echo", json!(["after heap quota"])).unwrap(),
        json!("after heap quota")
    );
}

#[cfg(any(target_os = "macos", all(windows, target_pointer_width = "64")))]
fn start_confined(source: &str) -> Result<Running, ExtensionHostError> {
    start_with_launcher(
        source,
        vec![ExtensionCapability::Command],
        ProcessIsolationPolicy::RequireJavaScriptEnforcement(host::JavaScriptMemoryLimits {
            heap_bytes: std::num::NonZeroUsize::new(64 * 1024 * 1024).unwrap(),
            array_buffer_bytes: std::num::NonZeroUsize::new(8 * 1024 * 1024).unwrap(),
        }),
        Arc::new(host::ProductJavaScriptLauncher::new(PathBuf::from(env!(
            "CARGO_BIN_EXE_ash-external-js-ext"
        )))),
    )
}

#[cfg(any(target_os = "macos", all(windows, target_pointer_width = "64")))]
#[test]
fn product_js_launcher_enforces_aggregate_and_implicit_backing_store_budgets() {
    struct ObservedLauncher {
        inner: host::ProductJavaScriptLauncher,
        processes: Arc<std::sync::Mutex<Vec<Arc<dyn host::ExtensionHostProcess>>>>,
    }
    impl host::ExtensionHostLauncher for ObservedLauncher {
        fn spawn(
            &self,
            command: &ExtensionLaunchCommand,
            limits: &ExtensionHostLimits,
        ) -> Result<Arc<dyn host::ExtensionHostProcess>, ExtensionHostError> {
            let process = self.inner.spawn(command, limits)?;
            self.processes.lock().unwrap().push(process.clone());
            Ok(process)
        }
    }
    for expression in [
        "new ArrayBuffer(8 * 1024 * 1024 + 1)",
        "new Uint8Array(8 * 1024 * 1024 + 1)",
        "(retained = [new ArrayBuffer(4 * 1024 * 1024), new ArrayBuffer(4 * 1024 * 1024)], new ArrayBuffer(1))",
        "(retained = [new Uint8Array(4 * 1024 * 1024), new Uint8Array(4 * 1024 * 1024)], new Uint8Array(4096))",
        "(retained = new ArrayBuffer(5 * 1024 * 1024), retained.slice(0))",
        "(retained = new Uint8Array(5 * 1024 * 1024), retained.map(x => x))",
    ] {
        let source = format!(
            r#"
import {{ commands }} from '@ash/extension';
let retained;
export function activate(context) {{
    context.subscriptions.push(commands.registerCommand('example.echo', 'Echo', (_, value) => value));
    context.subscriptions.push(commands.registerCommand('example.allocate', 'Allocate', () => {{
        try {{ {expression}; return 'unexpected allocation'; }} catch (error) {{ return error.name; }}
    }}));
}}"#
        );
        let processes: Arc<std::sync::Mutex<Vec<Arc<dyn host::ExtensionHostProcess>>>> =
            Arc::default();
        let running = start_with_launcher(
            &source,
            vec![ExtensionCapability::Command],
            ProcessIsolationPolicy::RequireJavaScriptEnforcement(host::JavaScriptMemoryLimits {
                heap_bytes: std::num::NonZeroUsize::new(64 * 1024 * 1024).unwrap(),
                array_buffer_bytes: std::num::NonZeroUsize::new(8 * 1024 * 1024).unwrap(),
            }),
            Arc::new(ObservedLauncher {
                inner: host::ProductJavaScriptLauncher::new(PathBuf::from(env!(
                    "CARGO_BIN_EXE_ash-external-js-ext"
                ))),
                processes: processes.clone(),
            }),
        )
        .unwrap();
        let result = run(&running, "allocate", json!([]));
        if expression.starts_with("new ") {
            assert_eq!(result.unwrap(), json!("RangeError"), "{expression}");
        } else {
            assert!(
                matches!(result, Err(ExtensionHostError::HostExited)),
                "{expression}: {result:?}"
            );
            assert!(
                processes.lock().unwrap()[0]
                    .stderr()
                    .contains("ArrayBuffer quota exceeded"),
                "{expression}"
            );
            assert_eq!(
                run(&running, "echo", json!(["recovered"])).unwrap(),
                json!("recovered")
            );
        }
    }
}

#[cfg(any(target_os = "macos", all(windows, target_pointer_width = "64")))]
#[test]
fn product_js_context_excludes_unbudgeted_memory_and_constructor_paths() {
    let running = start_confined(r#"
import { commands } from '@ash/extension';
export function activate(context) {
    context.subscriptions.push(commands.registerCommand('example.buffers', 'Buffers', () => {
        const buffer = new Uint8Array(4).buffer;
        const constructors = [ArrayBuffer, buffer.constructor, Object.getPrototypeOf(buffer).constructor,
            buffer.slice(0).constructor, new Uint8Array(4).buffer.transfer().constructor];
        const failures = constructors.map(Constructor => {
            try { new Constructor(1, {maxByteLength: 1024}); return 'escaped'; }
            catch (error) { return error.name; }
        });
        class Derived extends ArrayBuffer {}
        const capture = {};
        const valueOf = Function('capture', 'return function() { try { capture.caller = arguments.callee.caller; } catch {} return 4; }')(capture);
        new ArrayBuffer({ valueOf });
        return [typeof SharedArrayBuffer, typeof WebAssembly, failures,
            new Derived(4) instanceof Derived, ArrayBuffer.isView(new Uint8Array(4)), capture.caller == null];
    }));
}"#).unwrap();
    assert_eq!(
        run(&running, "buffers", json!([])).unwrap(),
        json!([
            "undefined",
            "undefined",
            [
                "TypeError",
                "TypeError",
                "TypeError",
                "TypeError",
                "TypeError"
            ],
            true,
            true,
            true
        ])
    );
}

#[cfg(any(target_os = "macos", all(windows, target_pointer_width = "64")))]
#[test]
fn product_js_process_recovers_after_execution_deadline() {
    let running = start_confined(include_str!("fixtures/main.js")).unwrap();
    assert!(
        running
            .supervisor
            .invoke(invocation("spin", json!([]), Duration::from_millis(100)))
            .is_err()
    );
    assert_eq!(
        run(&running, "echo", json!(["after timeout"])).unwrap(),
        json!("after timeout")
    );
}

#[test]
fn vscode_debug_configuration_callbacks_preserve_workspace_metadata_and_resolution_phases() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => context.subscriptions.push(v.debug.registerDebugConfigurationProvider('example', {
            provideDebugConfigurations(folder, token) {
                if (folder.name !== 'Server' || folder.index !== 1 || folder.uri.fsPath !== '/workspace/server' || token.isCancellationRequested) throw Error('Invalid workspace metadata');
                return [{name: 'Provided', type: 'example', request: 'launch', program: '${workspaceFolder}/app'}];
            },
            resolveDebugConfiguration(folder, configuration) {
                if (configuration.cancel) return undefined;
                if (configuration.open) return null;
                return {...configuration, folderName: folder.name, folderIndex: folder.index};
            },
            resolveDebugConfigurationWithSubstitutedVariables(folder, configuration) {
                if (configuration.cancel) return undefined;
                if (configuration.open) return null;
                if (configuration.program !== '/workspace/server/app') throw Error('Unresolved configuration');
                return {...configuration, resolved: true};
            }
        }, v.DebugConfigurationProviderTriggerKind.Dynamic));
    "#).unwrap();
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "vscode.debugConfiguration.1".into();
    request.operation = "provideDebugConfigurations".into();
    let folder = json!({"uri": "file:///workspace/server", "name": "Server", "index": 1});
    request.payload = json!({"folder": folder});
    let provided = running.supervisor.invoke(request.clone()).unwrap().payload;
    assert_eq!(
        provided["configurations"][0]["program"],
        "${workspaceFolder}/app"
    );
    request.operation = "resolveDebugConfiguration".into();
    request.payload["configuration"] = provided["configurations"][0].clone();
    let mut resolved =
        running.supervisor.invoke(request.clone()).unwrap().payload["configuration"].clone();
    assert_eq!(resolved["folderName"], "Server");
    assert_eq!(resolved["folderIndex"], 1);
    resolved["program"] = json!("/workspace/server/app");
    request.operation = "resolveDebugConfigurationWithSubstitutedVariables".into();
    request.payload["configuration"] = resolved;
    assert_eq!(
        running.supervisor.invoke(request.clone()).unwrap().payload["configuration"]["resolved"],
        true
    );
    for operation in [
        "resolveDebugConfiguration",
        "resolveDebugConfigurationWithSubstitutedVariables",
    ] {
        request.operation = operation.into();
        for (field, expected) in [
            ("cancel", json!({"cancelled": true})),
            ("open", json!({"configuration": null})),
        ] {
            request.payload["configuration"] =
                json!({"name": "Canceled", "type": "example", "request": "launch", field: true});
            assert_eq!(
                running.supervisor.invoke(request.clone()).unwrap().payload,
                expected
            );
        }
    }
}

#[test]
fn vscode_debug_sessions_preserve_early_event_identity_and_route_custom_requests() {
    let running = start_vscode(r#"
        const v = require('vscode');
        const seen = [];
        const stackChanges = [];
        let session;
        exports.activate = context => {
            const receiver = {};
            v.debug.onDidChangeActiveStackItem(function(item) {
                if (this !== receiver || v.debug.activeStackItem !== item || item && item.session !== session) throw Error('Stack item identity changed');
                if (item && !(item instanceof v.DebugThread) && !(item instanceof v.DebugStackFrame)) throw Error('Stack item class changed');
                stackChanges.push(item ? [item instanceof v.DebugStackFrame ? 'frame' : 'thread', item.threadId, item instanceof v.DebugStackFrame ? item.frameId : null] : null);
            }, receiver, context.subscriptions);
            for (const [name, event] of [['start', v.debug.onDidStartDebugSession], ['end', v.debug.onDidTerminateDebugSession], ['active', v.debug.onDidChangeActiveDebugSession]]) {
                event(function(value) {
                    if (this !== receiver) throw Error('Listener receiver changed');
                    if (value && value !== session) throw Error('Session identity changed');
                    seen.push([name, value?.id ?? null]);
                }, receiver, context.subscriptions);
            }
            v.debug.onDidReceiveDebugSessionCustomEvent(value => {
                session ??= value.session;
                if (session !== value.session || value.body !== null) throw Error('Early custom event changed');
                seen.push(['custom', value.event]);
            }, undefined, context.subscriptions);
            context.subscriptions.push(v.commands.registerCommand('example.hello', async () => {
                if (!await v.debug.startDebugging({uri: v.Uri.parse('file:///workspace')}, {name:'Explicit',type:'builder',request:'launch',program:'${workspaceFolder}/app'})) throw Error('Launch failed');
                if (!(v.debug.activeStackItem instanceof v.DebugStackFrame) || v.debug.activeStackItem.threadId !== 0 || v.debug.activeStackItem.frameId !== -1) throw Error('Focused frame changed');
                if (v.debug.activeDebugSession !== session || session.workspaceFolder.uri.path !== '/workspace' || session.configuration.program !== '/workspace/app') throw Error('Session metadata changed');
                const source = {name:'generated?#.ts',path:'/adapter-only/generated?#.ts',sourceReference:33};
                const sourceUri = v.debug.asDebugSourceUri(source);
                if (!(sourceUri instanceof v.Uri) || sourceUri.scheme !== 'debug' || sourceUri.path !== source.path || sourceUri.query !== 'session=debug-1&ref=33') throw Error('Reference source address changed');
                if (v.debug.asDebugSourceUri(source, session).toString() !== sourceUri.toString() || !sourceUri.toString().includes('generated%3F%23.ts')) throw Error('Source URI encoding changed');
                if (v.debug.asDebugSourceUri({path:'/workspace/app'}).scheme !== 'file' || v.debug.asDebugSourceUri({path:'C:\\project\\app.ts'}).path !== '/C:/project/app.ts' || v.debug.asDebugSourceUri({path:'\\\\server\\share\\app.ts'}).authority !== 'server') throw Error('File source address changed');
                const unixPath = String.raw`/workspace/main\part.ts`;
                if (v.debug.asDebugSourceUri({path:unixPath}).path !== unixPath) throw Error('Unix filename changed');
                let invalid = 0;
                for (const source of [{}, {sourceReference:Infinity}, {sourceReference:1.5}]) { try { v.debug.asDebugSourceUri(source, session); } catch { invalid++; } }
                if (invalid !== 3) throw Error('Invalid source accepted');
                session.name = 'Renamed session';
                if (v.debug.activeDebugSession.name !== 'Renamed session' || session.configuration.name !== 'Explicit') throw Error('Name mutation changed configuration');
                const echo = await session.customRequest('echo', {value:[0,false,null,'']});
                const nullBody = await session.customRequest('echo', null);
                const absentBody = await session.customRequest('empty');
                await v.debug.stopDebugging(session);
                return [echo, nullBody === null, absentBody === undefined, v.debug.activeDebugSession === undefined, stackChanges];
            }), v.commands.registerCommand('example.probe', () => seen));
        };
    "#).unwrap();
    let session = json!({"id":"debug-1","type":"builder","name":"Explicit","configuration":{"name":"Explicit","type":"builder","request":"launch","program":"/workspace/app"},"workspaceFolder":{"uri":"file:///workspace","name":"workspace","index":0}});
    let send_event = |kind: &str, sequence: u64| {
        let mut event = invocation("unused", json!([]), Duration::from_secs(5));
        event.registration_id = "vscode.debug.events".into();
        event.operation = "debugEvent".into();
        event.payload = json!({"type":kind,"sequence":sequence,"session":session,"event":"builderReady","body":null,"hasBody":true});
        if kind == "active" && sequence == 9 {
            event.payload["session"] = Value::Null;
        }
        if matches!(kind, "thread" | "frame" | "clear") {
            event.payload["type"] = json!("stackItem");
            event.payload["item"] = if kind == "clear" {
                Value::Null
            } else {
                json!({"kind":kind,"session":session,"threadId":0})
            };
            if kind == "frame" {
                event.payload["item"]["frameId"] = json!(-1);
            }
        }
        running.supervisor.invoke(event).unwrap();
    };
    let result = running
        .supervisor
        .begin_invoke(invocation("hello", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            Ok(match operation {
                ExtensionClientOperation::StartDebugging {
                    folder,
                    configuration,
                    options: _,
                } => {
                    assert_eq!(folder.as_deref(), Some("file:///workspace"));
                    assert_eq!(configuration["program"], "${workspaceFolder}/app");
                    send_event("custom", 1);
                    send_event("start", 2);
                    send_event("active", 3);
                    send_event("thread", 4);
                    send_event("frame", 5);
                    send_event("frame", 6);
                    ExtensionClientResult::DebugStarted { started: true }
                }
                ExtensionClientOperation::SetDebugSessionName { session_id, name } => {
                    assert_eq!(session_id, "debug-1");
                    assert_eq!(name, "Renamed session");
                    ExtensionClientResult::Done
                }
                ExtensionClientOperation::DebugCustomRequest {
                    session_id,
                    command,
                    arguments,
                    has_arguments,
                } => {
                    assert_eq!(session_id, "debug-1");
                    assert_eq!(has_arguments, command == "echo");
                    ExtensionClientResult::DebugResponse {
                        value: arguments.clone(),
                        has_body: command != "empty",
                    }
                }
                ExtensionClientOperation::StopDebugging { session_id } => {
                    assert_eq!(session_id.as_deref(), Some("debug-1"));
                    send_event("clear", 7);
                    send_event("end", 8);
                    send_event("active", 9);
                    ExtensionClientResult::Done
                }
                other => panic!("unexpected client operation: {other:?}"),
            })
        })
        .unwrap();
    assert_eq!(
        result.payload,
        json!([{"value":[0,false,null,""]},true,true,true,[["thread",0,null],["frame",0,-1],null]])
    );
    assert_eq!(
        run(&running, "probe", json!([])).unwrap(),
        json!([
            ["custom", "builderReady"],
            ["start", "debug-1"],
            ["active", "debug-1"],
            ["end", "debug-1"],
            ["active", null]
        ])
    );
    let mut stale = invocation("unused", json!([]), Duration::from_secs(5));
    stale.registration_id = "vscode.debug.events".into();
    stale.operation = "debugEvent".into();
    stale.payload =
        json!({"type":"snapshot","sequence":0,"sessions":[session],"activeSession":"debug-1"});
    running.supervisor.invoke(stale).unwrap();
    assert_eq!(
        run(&running, "probe", json!([]))
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        5
    );
}

#[test]
fn remote_resolver_runs_in_javascript_and_connection_intent_uses_the_invocation_broker() {
    let source = r#"
        import { commands, workspace } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(workspace.registerRemoteConnectionResolver('team', {
                resolve(_call, authority) { if (authority !== 'team+linux') throw Error('Wrong authority'); return { connectionName: 'build' }; }
            }));
            context.subscriptions.push(commands.registerCommand('example.connect', 'Connect', async call => {
                await call.workspace.openRemoteConnection('team+linux'); return 'requested';
            }));
        }
    "#;
    assert!(
        start(source).is_err(),
        "registration requires its declared capability"
    );
    let running = start_with_capabilities(
        source,
        vec![
            ExtensionCapability::Command,
            ExtensionCapability::RemoteAuthorityResolver,
        ],
    )
    .unwrap();
    let mut resolve = invocation("unused", json!([]), Duration::from_secs(5));
    resolve.registration_id = "remote:team".into();
    resolve.operation = "resolveConnection".into();
    resolve.payload = json!({"authority":"team+linux"});
    assert_eq!(
        running.supervisor.invoke(resolve).unwrap().payload,
        json!({"connectionName":"build"})
    );
    let mut calls = Vec::new();
    let result = running
        .supervisor
        .begin_invoke(invocation("connect", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            calls.push(operation);
            Ok(ExtensionClientResult::Done)
        })
        .unwrap();
    assert_eq!(result.payload, json!("requested"));
    assert_eq!(
        calls,
        vec![ExtensionClientOperation::OpenRemoteConnection {
            authority: "team+linux".into()
        }]
    );
}

#[test]
fn vscode_debug_breakpoints_keep_public_identity_and_query_adapter_bindings() {
    let running = start_vscode(r#"
        const v = require('vscode');
        let session;
        const changes = [];
        exports.activate = context => {
            v.debug.onDidStartDebugSession(value => { session = value; }, undefined, context.subscriptions);
            const receiver = {};
            v.debug.onDidChangeBreakpoints(function(event) {
                if (this !== receiver || !Object.isFrozen(event.added)) throw Error('Breakpoint event contract changed');
                changes.push(event);
            }, receiver, context.subscriptions);
            context.subscriptions.push(v.commands.registerCommand('example.hello', async () => {
                const source = new v.SourceBreakpoint(new v.Location(v.Uri.file('/workspace/main.ts'), new v.Position(6, 3)), true, 'value > 0', '2', 'hit {value}');
                const fn = new v.FunctionBreakpoint('main', false, undefined, undefined, 'function hit');
                v.debug.addBreakpoints([source, fn]);
                if (v.debug.breakpoints[0] !== source || v.debug.breakpoints[1] !== fn || changes[0].added[0] !== source) throw Error('Breakpoint identity changed');
                const binding = await session.getDebugProtocolBreakpoint(source);
                v.debug.removeBreakpoints([source, fn]);
                if (changes[1].removed[0] !== source || v.debug.breakpoints.length) throw Error('Removal changed identity');
                return [binding, source instanceof v.Breakpoint, fn instanceof v.Breakpoint];
            }), v.commands.registerCommand('example.probe', () => changes.map(event => [event.added.length,event.removed.length,event.changed.length])));
        };
    "#).unwrap();
    let mut event = invocation("unused", json!([]), Duration::from_secs(5));
    event.registration_id = "vscode.debug.events".into();
    event.operation = "debugEvent".into();
    event.payload = json!({"type":"start","sequence":1,"session":{"id":"debug-1","type":"builder","name":"Launch","configuration":{},"workspaceFolder":null}});
    running.supervisor.invoke(event.clone()).unwrap();
    let mut source_id = String::new();
    let mut points = Vec::new();
    let result = running.supervisor.begin_invoke(invocation("hello", json!([]), Duration::from_secs(5))).unwrap().wait_with_client(|operation, _, _| {
        Ok(match operation {
            ExtensionClientOperation::AddDebugBreakpoints { breakpoints } => {
                assert_eq!(breakpoints.len(), 2);
                source_id = breakpoints[0]["id"].as_str().unwrap().into();
                assert_eq!(breakpoints[0]["line"], 6);
                assert_eq!(breakpoints[0]["column"], 3);
                assert_eq!(breakpoints[0]["logMessage"], "hit {value}");
                assert_eq!(breakpoints[1]["name"], "main");
                assert_eq!(breakpoints[1]["logMessage"], "function hit");
                points = breakpoints.clone();
                event.payload = json!({"type":"breakpoints","sequence":2,"added":points,"removed":[],"changed":[]});
                running.supervisor.invoke(event.clone()).unwrap();
                ExtensionClientResult::Done
            }
            ExtensionClientOperation::GetDebugProtocolBreakpoint { session_id, breakpoint_id } => {
                assert_eq!(session_id, "debug-1");
                assert_eq!(breakpoint_id, source_id);
                ExtensionClientResult::DebugResponse { value: json!({"id":100,"verified":true,"line":7,"column":4}), has_body:true }
            }
            ExtensionClientOperation::RemoveDebugBreakpoints { breakpoint_ids } => {
                assert_eq!(breakpoint_ids[0], source_id);
                event.payload = json!({"type":"breakpoints","sequence":3,"added":[],"removed":points,"changed":[]});
                running.supervisor.invoke(event.clone()).unwrap();
                ExtensionClientResult::Done
            }
            other => panic!("unexpected client operation: {other:?}"),
        })
    }).unwrap();
    assert_eq!(
        result.payload,
        json!([{"id":100,"verified":true,"line":7,"column":4},true,true])
    );
    assert_eq!(
        run(&running, "probe", json!([])).unwrap(),
        json!([[2, 0, 0], [0, 2, 0]])
    );
}

#[test]
fn vscode_debug_adapter_trackers_keep_session_identity_and_active_hooks_after_factory_disposal() {
    let running = start_vscode(r#"
        const v = require('vscode');
        let session, registration;
        const phases = [];
        exports.activate = context => {
            registration = v.debug.registerDebugAdapterTrackerFactory('*', {
                async createDebugAdapterTracker(value) {
                    if (session && session !== value) throw Error('Session identity changed');
                    session = value;
                    const tracker = {
                        onWillStartSession() { if (this !== tracker) throw Error('Tracker receiver changed'); phases.push('start'); },
                        onWillReceiveMessage(message) { phases.push(['receive', message.command]); },
                        async onDidSendMessage(message) {
                            const result = await session.customRequest('tracker:echo', message.body);
                            phases.push(['send', result]);
                        },
                        onWillStopSession() { phases.push('stop'); },
                        onError(error) { if (!(error instanceof Error)) throw Error('Error is not an Error'); phases.push(['error', error.name, error.message]); },
                        onExit(code, signal) { phases.push(['exit', code === undefined, signal === undefined]); },
                    };
                    return tracker;
                },
            });
            context.subscriptions.push(registration,
                v.commands.registerCommand('example.hello', () => { registration.dispose(); return session.id; }),
                v.commands.registerCommand('example.probe', () => phases));
        };
    "#).unwrap();
    let mut call = invocation("unused", json!([]), Duration::from_secs(5));
    call.registration_id = "vscode.debugTracker.1".into();
    call.operation = "createDebugAdapterTracker".into();
    call.payload = json!({"session":{"id":"debug-1","name":"Launch","type":"builder","configuration":{"request":"launch"},"workspaceFolder":null}});
    let handle = running.supervisor.invoke(call.clone()).unwrap().payload;
    assert_eq!(handle["operations"].as_array().unwrap().len(), 6);
    let tracker_id = handle["trackerId"].clone();
    assert_eq!(run(&running, "hello", json!([])).unwrap(), json!("debug-1"));
    assert_eq!(
        running.supervisor.invoke(call.clone()).unwrap().payload,
        json!(null)
    );
    call.operation = "debugAdapterTrackerEvent".into();
    for event in [
        "onWillStartSession",
        "onWillReceiveMessage",
        "onWillStopSession",
        "onError",
    ] {
        call.payload = json!({"trackerId":tracker_id,"event":event,"message":{"command":"initialize"},"name":"TransportError"});
        if event == "onError" {
            call.payload["message"] = json!("adapter gone");
        }
        running.supervisor.invoke(call.clone()).unwrap();
    }
    call.payload = json!({"trackerId":tracker_id,"event":"onDidSendMessage","message":{"body":{"reentrant":true}}});
    running
        .supervisor
        .begin_invoke(call.clone())
        .unwrap()
        .wait_with_client(|operation, _, _| {
            let ExtensionClientOperation::DebugCustomRequest {
                session_id,
                command,
                arguments,
                has_arguments,
            } = operation
            else {
                panic!("unexpected client operation: {operation:?}");
            };
            assert_eq!(session_id, "debug-1");
            assert_eq!(command, "tracker:echo");
            assert!(has_arguments);
            Ok(ExtensionClientResult::DebugResponse {
                value: arguments.clone(),
                has_body: true,
            })
        })
        .unwrap();
    call.payload = json!({"trackerId":tracker_id,"event":"onExit","code":null,"signal":null});
    running.supervisor.invoke(call).unwrap();
    assert_eq!(
        run(&running, "probe", json!([])).unwrap(),
        json!(["start",["receive","initialize"],"stop",["error","TransportError","adapter gone"],["send",{"reentrant":true}],["exit",true,true]])
    );
}

#[test]
fn remote_connection_calls_without_an_active_resolver_do_not_reach_the_client() {
    let running = start(r#"
        import { commands } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(commands.registerCommand('example.connect', 'Connect', async call => {
                try { await call.workspace.openRemoteConnection('ssh+build'); }
                catch (error) { return error.code; }
                throw Error('Expected refusal');
            }));
        }
    "#).unwrap();
    let result = running
        .supervisor
        .begin_invoke(invocation("connect", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|_, _, _| panic!("Unauthorized request reached the client"))
        .unwrap();
    assert_eq!(result.payload, json!("permissionDenied"));
}

#[test]
fn standard_authority_resolution_preserves_endpoints_attempts_and_error_categories() {
    let source = r#"
        import { workspace, ResolvedAuthority, RemoteAuthorityResolverError } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(workspace.registerRemoteAuthorityResolver('test', {
                resolve(authority, context) {
                    if (authority === 'test+offline') throw RemoteAuthorityResolverError.NotAvailable('Offline', true);
                    return new ResolvedAuthority('127.0.0.1', 4000 + context.resolveAttempt, 'capability');
                }
            }));
        }
    "#;
    let running =
        start_with_capabilities(source, vec![ExtensionCapability::RemoteAuthorityResolver])
            .unwrap();
    let request = |authority| {
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = "remote-authority:test".into();
        request.operation = "resolveAuthority".into();
        request.payload = json!({"authority":authority,"resolveAttempt":2,"__connectionOwner":"7"});
        request
    };
    assert_eq!(
        running
            .supervisor
            .invoke(request("test+target"))
            .unwrap()
            .payload,
        json!({"type":"webSocket","host":"127.0.0.1","port":4002,"connectionToken":"capability"})
    );
    assert_eq!(
        running
            .supervisor
            .invoke(request("test+offline"))
            .unwrap()
            .payload,
        json!({"error":{"code":"NotAvailable","message":"Offline","handled":true}})
    );
    assert!(running.supervisor.invoke(request("other+target")).is_err());
}

#[test]
fn canonical_uri_and_resolver_options_cross_the_sdk_boundary_without_session_tokens() {
    let source = r#"
        import { workspace, ResolvedAuthority } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(workspace.registerRemoteAuthorityResolver('test', {
                resolve(authority) {
                    return Object.assign(new ResolvedAuthority('localhost', 5000), {
                        isTrusted: authority === 'test+invalid' ? 'yes' : false,
                        extensionHostEnv: { SET: 'value', REMOVE: null },
                        authenticationSessionForInitializingExtensions: {
                            id: 'session', providerId: 'provider', accessToken: 'secret',
                            account: { id: 'account', label: 'Account' }, scopes: []
                        }
                    });
                },
                getCanonicalURI(uri) {
                    if (uri.path === '/identity') return undefined;
                    if (uri.path === '/invalid') return { scheme: 'file' };
                    return uri.with({ fragment: 'canonical' });
                }
            }));
            context.subscriptions.push(workspace.registerRemoteAuthorityResolver('identity', {
                resolve() { return new ResolvedAuthority('localhost', 5000); }
            }));
        }
    "#;
    let running =
        start_with_capabilities(source, vec![ExtensionCapability::RemoteAuthorityResolver])
            .unwrap();
    let request = |registration: &str, operation: &str, payload| {
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = registration.into();
        request.operation = operation.into();
        request.payload = payload;
        request
    };
    let resolved = running
        .supervisor
        .invoke(request(
            "remote-authority:test",
            "resolveAuthority",
            json!({"authority":"test+target","resolveAttempt":1,"__connectionOwner":"7"}),
        ))
        .unwrap()
        .payload;
    assert_eq!(
        resolved,
        json!({
            "type":"webSocket","host":"localhost","port":5000,"connectionToken":null,
            "options":{"isTrusted":false,"extensionHostEnv":{"SET":"value","REMOVE":null},
                "authenticationSession":{"id":"session","providerId":"provider"}}
        })
    );
    assert!(!resolved.to_string().contains("secret"));
    let canonical_request = |prefix: &str, path: &str, external: &str| {
        request(
            &format!("remote-authority:{prefix}"),
            "getCanonicalURI",
            json!({
                "authority":format!("{prefix}+target"),"__connectionOwner":"7",
                "uri":{"scheme":"ash-remote","authority":format!("{prefix}+target"),
                    "path":path,"query":"q=1","fragment":"old","external":external}
            }),
        )
    };
    assert_eq!(
        running
            .supervisor
            .invoke(canonical_request(
                "test",
                "/alias/child/文件",
                "ash-remote://test+target/alias%2Fchild/%E6%96%87%E4%BB%B6?q=1#old"
            ))
            .unwrap()
            .payload,
        json!({
            "scheme":"ash-remote","authority":"test+target","path":"/alias/child/文件",
            "query":"q=1","fragment":"canonical",
            "external":"ash-remote://test+target/alias%2Fchild/%E6%96%87%E4%BB%B6?q=1#canonical"
        })
    );
    for (prefix, path) in [("test", "/identity"), ("identity", "/any")] {
        assert_eq!(
            running
                .supervisor
                .invoke(canonical_request(
                    prefix,
                    path,
                    &format!("ash-remote://{prefix}+target{path}?q=1#old")
                ))
                .unwrap()
                .payload,
            json!(null)
        );
    }
    assert!(
        running
            .supervisor
            .invoke(canonical_request(
                "test",
                "/invalid",
                "ash-remote://test+target/invalid?q=1#old"
            ))
            .is_err()
    );
    assert!(
        running
            .supervisor
            .invoke(canonical_request(
                "test",
                "/identity",
                "ash-remote://test+target/another-path?q=1#old"
            ))
            .is_err()
    );
    assert!(
        running
            .supervisor
            .invoke(request(
                "remote-authority:test",
                "resolveAuthority",
                json!({"authority":"test+invalid","resolveAttempt":1,"__connectionOwner":"7"})
            ))
            .is_err()
    );
}

#[test]
fn vscode_executes_edits_to_fetched_tasks_and_resolves_definition_only_tasks() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => context.subscriptions.push(v.commands.registerCommand('example.hello', async () => {
            const [task] = await v.tasks.fetchTasks();
            if ('revealProblems' in task.presentationOptions) throw Error('Configuration-only policy leaked into the public API');
            task.name = 'Edited';
            task.execution.args.push('two words', '');
            task.execution.options.env.MODE = 'edited';
            task.presentationOptions = {panel: v.TaskPanelKind.New, clear: true};
            const edited = await v.tasks.executeTask(task);
            if (edited.task !== task) throw Error('Edited task identity changed');
            task.detail = 'Edited again';
            const repeated = await v.tasks.executeTask(task);
            if (repeated.task !== task) throw Error('Repeated edited task identity changed');
            const unresolved = new v.Task({type:'builder', target:'generated'}, v.TaskScope.Workspace, 'Resolve', 'Builder');
            const resolved = await v.tasks.executeTask(unresolved);
            if (resolved.task !== unresolved) throw Error('Definition-only task identity changed');
            return [edited.task.name, resolved.task.name];
        }));
    "#).unwrap();
    let mut count = 0;
    let result = running.supervisor.begin_invoke(invocation("hello", json!([]), Duration::from_secs(5))).unwrap().wait_with_client(|operation, _, _| {
        Ok(match operation {
            ExtensionClientOperation::FetchTasks { .. } => ExtensionClientResult::Tasks { sequence:0, executions:vec![], tasks:vec![json!({"id":"fetched-1","name":"Original","source":"Builder","scope":2,"definition":{"type":"builder"},"execution":{"type":"process","program":"compiler","args":["$HOME"]},"presentation":{"revealProblems":"onProblem","reveal":"never"},"options":{"env":{"MODE":"original"}},"problemMatchers":[],"group":"build","isBackground":false,"detail":null})] },
            ExtensionClientOperation::ExecuteTask { task_id, task } => {
                assert!(task_id.is_none());
                let task = task.unwrap();
                count += 1;
                if count <= 2 {
                    assert_eq!(task["label"], "Edited");
                    assert_eq!(task["execution"], json!({"type":"process","program":"compiler","args":["$HOME","two words",""]}));
                    assert_eq!(task["env"]["MODE"], "edited");
                    assert_eq!(task["presentation"], json!({"panel":"new","clear":true,"revealProblems":"onProblem"}));
                } else {
                    assert_eq!(task["label"], "Resolve");
                    assert!(task.get("execution").is_none());
                    assert_eq!(task["definition"]["target"], "generated");
                    assert!(task.get("presentation").is_none());
                }
                ExtensionClientResult::TaskExecution { sequence:count, execution:json!({"id":format!("run-{count}"),"active":true,"exitCode":null,"task":{"id":"canonical-provided","clientTaskId":task["id"],"name":task["label"],"source":"Builder","scope":2,"definition":task["definition"],"execution":{"type":"process","program":"compiler","args":[]},"options":{},"problemMatchers":[],"group":"other","isBackground":false,"detail":null}}) }
            }
            other => panic!("unexpected client operation: {other:?}"),
        })
    }).unwrap();
    assert_eq!(result.payload, json!(["Edited", "Resolve"]));
    assert_eq!(count, 3);
}

#[test]
fn vscode_execute_command_preserves_void_null_and_falsy_results() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => context.subscriptions.push(v.commands.registerCommand('example.hello', async () => {
            const results = [];
            for (const command of ['void', 'null', 'false', 'zero', 'object']) {
                const value = await v.commands.executeCommand('example.' + command, command, 0, false);
                results.push({command, isUndefined: value === undefined, value});
            }
            return results;
        }));
    "#).unwrap();
    let result = running
        .supervisor
        .begin_invoke(invocation("hello", json!([]), Duration::from_secs(5)))
        .unwrap()
        .wait_with_client(|operation, _, _| {
            let ExtensionClientOperation::ExecuteCommand { command, arguments } = operation else {
                panic!("unexpected operation: {operation:?}");
            };
            let name = command.strip_prefix("example.").unwrap();
            assert_eq!(arguments, vec![json!(name), json!(0), json!(false)]);
            let value = match name {
                "void" | "null" => Value::Null,
                "false" => json!(false),
                "zero" => json!(0),
                "object" => json!({"value":7}),
                other => panic!("unexpected command: {other}"),
            };
            Ok(ExtensionClientResult::Command {
                value,
                has_value: name != "void",
            })
        })
        .unwrap();
    assert_eq!(
        result.payload,
        json!([
            {"command":"void","isUndefined":true},
            {"command":"null","isUndefined":false,"value":null},
            {"command":"false","isUndefined":false,"value":false},
            {"command":"zero","isUndefined":false,"value":0},
            {"command":"object","isUndefined":false,"value":{"value":7}}
        ])
    );
}

#[test]
fn vscode_edits_fetched_custom_tasks_without_transferring_the_provider_callback() {
    let source = r#"
        const v = require('vscode');
        exports.activate = context => context.subscriptions.push(v.commands.registerCommand('example.hello', async () => {
            const [task] = await v.tasks.fetchTasks();
            if (!(task.execution instanceof v.CustomExecution) || task.execution.callback !== undefined) throw Error('Invalid custom snapshot');
            const original = await v.tasks.executeTask(task);
            if (original.task !== task) throw Error('Original task identity changed');
            const copy = new v.Task(task.definition, task.scope, 'Copy', task.source, task.execution);
            const copied = await v.tasks.executeTask(copy);
            if (copied.task !== copy || copied.task === task) throw Error('Copied task identity changed');
            const forged = new v.Task(task.definition, task.scope, 'Forged', task.source, Object.create(v.CustomExecution.prototype));
            try { await v.tasks.executeTask(forged); throw Error('Forged execution dispatched'); }
            catch (error) { if (!String(error).includes('CustomExecution copied')) throw error; }
            task.name = 'Edited custom';
            task.definition.target = '${workspaceFolder}/edited';
            task.presentationOptions = {reveal: v.TaskRevealKind.Never};
            for (const detail of ['first', 'second']) {
                task.detail = detail;
                const execution = await v.tasks.executeTask(task);
                if (execution.task !== task) throw Error('Edited custom identity changed');
            }
            task.execution = new v.CustomExecution(async () => ({onDidWrite: new v.EventEmitter().event, open() {}, close() {}}));
            const own = await v.tasks.executeTask(task);
            if (own.task !== task) throw Error('Replacement execution identity changed');
            return task.name;
        }));
    "#;
    let running = start_vscode(source).unwrap();
    let mut count = 0;
    let mut edited_id = None;
    let invocation = invocation("hello", json!([]), Duration::from_secs(5));
    let result = running.supervisor.begin_invoke(invocation).unwrap()
        .wait_with_client(|operation, _, _| {
            Ok(match operation {
                ExtensionClientOperation::FetchTasks { .. } => ExtensionClientResult::Tasks {
                    sequence: 0,
                    executions: vec![],
                    tasks: vec![json!({
                        "id": "original-custom", "name": "Original", "source": "Builder",
                        "scope": 2, "definition": {"type": "builder"},
                        "execution": {"type": "custom"}, "options": {},
                        "problemMatchers": [], "group": "build", "isBackground": false, "detail": null
                    })],
                },
                ExtensionClientOperation::ExecuteTask { task_id, task } => {
                    count += 1;
                    if count == 1 {
                        assert_eq!(task_id.as_deref(), Some("original-custom"));
                        assert!(task.is_none());
                    } else {
                        let snapshot = task.as_ref().unwrap();
                        let original_id = if count == 5 { None } else { Some("original-custom") };
                        assert_eq!(task_id.as_deref(), original_id);
                        assert_eq!(snapshot["label"], if count == 2 { "Copy" } else { "Edited custom" });
                        assert_eq!(snapshot["execution"], json!({"type":"custom","id":snapshot["id"]}));
                        if count == 2 {
                            assert_eq!(snapshot["definition"], json!({"type":"builder"}));
                        } else {
                            assert_eq!(snapshot["definition"]["target"], "${workspaceFolder}/edited");
                        }
                        if count == 3 {
                            edited_id = Some(snapshot["id"].clone());
                        }
                        if count >= 3 { assert_eq!(Some(&snapshot["id"]), edited_id.as_ref()); }
                        if count == 3 || count == 4 {
                            let detail = if count == 3 { "first" } else { "second" };
                            assert_eq!(snapshot["detail"], detail);
                        }
                    }
                    let client_task_id = task.as_ref()
                        .map(|task| task["id"].clone())
                        .unwrap_or(json!("original-custom"));
                    ExtensionClientResult::TaskExecution {
                        sequence: count,
                        execution: json!({
                            "id": format!("run-{count}"), "active": true, "exitCode": null,
                            "task": {
                                "id": "canonical-custom", "clientTaskId": client_task_id,
                                "name": "Custom", "source": "Builder", "scope": 2,
                                "definition": {"type":"builder"}, "execution": {"type":"custom"},
                                "options": {}, "problemMatchers": [], "group": "build",
                                "isBackground": false, "detail": null
                            }
                        }),
                    }
                }
                other => panic!("unexpected client operation: {other:?}"),
            })
        }).unwrap();
    assert_eq!(result.payload, json!("Edited custom"));
    assert_eq!(count, 5);
}

#[test]
fn vscode_task_presentation_rejects_invalid_values_before_requesting_execution() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => context.subscriptions.push(v.commands.registerCommand('example.hello', async () => {
            const task = new v.Task({type: 'builder'}, v.TaskScope.Workspace, 'Invalid', 'Builder', new v.ProcessExecution('compiler'));
            const failures = [];
            for (const options of [null, [], {panel: 0}, {panel: 4}, {panel: 'shared'}, {clear: 1}, {reveal: 'never'}, {reveal: 0}, {reveal: 4}, {focus: 'false'}, {close: 1}, {echo: 1}, {echo: 'false'}, {echo: null}, {showReuseMessage: 1}, {showReuseMessage: 'false'}, {showReuseMessage: null}]) {
                task.presentationOptions = options;
                try { await v.tasks.executeTask(task); throw Error('Invalid presentation dispatched'); }
                catch (error) { if (!(error instanceof TypeError)) throw error; failures.push(error.name); }
            }
            return failures;
        }));
    "#).unwrap();
    assert_eq!(
        run(&running, "hello", json!([])).unwrap(),
        json!(vec!["TypeError"; 17])
    );
}

#[test]
fn managed_authority_sockets_preserve_bytes_and_retire_on_resolution_and_restart() {
    let source = r#"
        import { workspace, ManagedResolvedAuthority } from '@ash/extension';
        export function activate(context) {
            context.subscriptions.push(workspace.registerRemoteAuthorityResolver('test', {
                resolve() {
                    return new ManagedResolvedAuthority(async () => {
                        const data = new Set(), closed = new Set(), ended = new Set();
                        const event = listeners => callback => { listeners.add(callback); return { dispose() { listeners.delete(callback); } }; };
                        return { onDidReceiveMessage: event(data), onDidClose: event(closed), onDidEnd: event(ended),
                            send(bytes) { for (const callback of data) callback(bytes); },
                            end() { for (const callback of closed) callback(); }, async drain() {} };
                    });
                }
            }));
        }
    "#;
    let running =
        start_with_capabilities(source, vec![ExtensionCapability::RemoteAuthorityResolver])
            .unwrap();
    let request = |operation: &str, payload: Value| {
        let mut request = invocation("unused", json!([]), Duration::from_secs(5));
        request.registration_id = "remote-authority:test".into();
        request.operation = operation.into();
        request.payload = payload;
        request
            .payload
            .as_object_mut()
            .unwrap()
            .insert("__connectionOwner".into(), json!("7"));
        request
    };
    let resolved = running
        .supervisor
        .invoke(request(
            "resolveAuthority",
            json!({"authority":"test+target","resolveAttempt":1}),
        ))
        .unwrap()
        .payload;
    let id = resolved["id"].as_u64().unwrap();
    let connected = running
        .supervisor
        .invoke(request("remoteConnect", json!({"id":id})))
        .unwrap()
        .payload;
    let socket = connected["id"].as_u64().unwrap();
    running
        .supervisor
        .invoke(request(
            "remoteWrite",
            json!({"id":socket,"data":"00f09f9880ff"}),
        ))
        .unwrap();
    running
        .supervisor
        .invoke(request("remoteDrain", json!({"id":socket})))
        .unwrap();
    assert_eq!(
        running
            .supervisor
            .invoke(request("remoteRead", json!({"id":socket})))
            .unwrap()
            .payload,
        json!({"data":"00f09f9880ff","closed":false,"ended":false,"error":null})
    );
    let owner_request = |owner: &str, operation: &str, payload: Value| {
        let mut invocation = request(operation, payload);
        invocation
            .payload
            .as_object_mut()
            .unwrap()
            .insert("__connectionOwner".into(), json!(owner));
        invocation
    };
    let second = running
        .supervisor
        .invoke(owner_request(
            "8",
            "resolveAuthority",
            json!({"authority":"test+other","resolveAttempt":1}),
        ))
        .unwrap()
        .payload;
    let second_socket = running
        .supervisor
        .invoke(owner_request(
            "8",
            "remoteConnect",
            json!({"id":second["id"]}),
        ))
        .unwrap()
        .payload["id"]
        .as_u64()
        .unwrap();
    assert!(
        running
            .supervisor
            .invoke(owner_request("8", "remoteRead", json!({"id":socket})))
            .is_err()
    );
    assert!(
        running
            .supervisor
            .invoke(request("remoteRead", json!({"id":socket})))
            .is_ok()
    );
    running
        .supervisor
        .invoke(owner_request("7", "remoteReleaseOwner", json!({})))
        .unwrap();
    assert!(
        running
            .supervisor
            .invoke(request("remoteRead", json!({"id":socket})))
            .is_err()
    );
    assert!(
        running
            .supervisor
            .invoke(owner_request(
                "8",
                "remoteRead",
                json!({"id":second_socket})
            ))
            .is_ok()
    );
    running
        .supervisor
        .invoke(request(
            "resolveAuthority",
            json!({"authority":"test+target","resolveAttempt":2}),
        ))
        .unwrap();
    assert!(
        running
            .supervisor
            .invoke(owner_request(
                "8",
                "remoteRead",
                json!({"id":second_socket})
            ))
            .is_ok()
    );
    assert!(
        running
            .supervisor
            .invoke(request("remoteRead", json!({"id":socket})))
            .is_err()
    );
    assert!(
        running
            .supervisor
            .invoke(request("remoteConnect", json!({"id":id})))
            .is_err()
    );
    let old = NonZeroU64::new(running.supervisor.snapshot().incarnation).unwrap();
    running.supervisor.shutdown().unwrap();
    running.supervisor.start().unwrap();
    assert!(
        running
            .supervisor
            .begin_fenced_invoke(
                ExtensionInvocationTarget {
                    activation_generation: NonZeroU64::new(1).unwrap(),
                    incarnation: old
                },
                request("remoteConnect", json!({"id":id}))
            )
            .is_err()
    );
}

#[test]
fn vscode_inline_debug_adapter_preserves_messages_and_releases_listener_and_implementation_once() {
    let running = start_vscode(r#"
        const v = require('vscode');
        let disposed = 0; let listenersDisposed = 0;
        let factory;
        exports.activate = context => {
            context.subscriptions.push(v.commands.registerCommand('example.probe', () => ({ disposed, listenersDisposed })));
            factory = v.debug.registerDebugAdapterDescriptorFactory('example', {
                createDebugAdapterDescriptor() {
                    const emitter = new v.EventEmitter();
                    const implementation = {
                        onDidSendMessage(listener) { const handle = emitter.event(listener); return { dispose() { listenersDisposed++; handle.dispose(); } }; },
                        handleMessage(message) {
                            if (this !== implementation) throw Error('Inline receiver changed');
                            const body = { value: message.arguments, literal: '$HOME' };
                            emitter.fire({ seq: 0, type: 'response', request_seq: message.seq, command: message.command, success: true, body });
                            body.literal = 'changed after event';
                            if (message.command === 'retireFactory') factory.dispose();
                        },
                        dispose() { disposed++; emitter.dispose(); }
                    };
                    return new v.DebugAdapterInlineImplementation(implementation);
                }
            });
            context.subscriptions.push(factory);
        };
    "#).unwrap();
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "vscode.debug.1".into();
    request.operation = "createDebugAdapterDescriptor".into();
    request.payload = json!({"session":{"id":"inline-session","workspaceFolder":null},"configuration":{"name":"Debug","type":"example","request":"launch"}});
    let id = running.supervisor.invoke(request.clone()).unwrap().payload["inlineAdapterId"].clone();
    for (index, command) in ["retireFactory", "echo"].into_iter().enumerate() {
        request.operation = "sendInlineDebugAdapter".into();
        request.payload = json!({"inlineAdapterId":id,"message":{"seq":index + 1,"type":"request","command":command,"arguments":null}});
        running.supervisor.invoke(request.clone()).unwrap();
        request.operation = "readInlineDebugAdapter".into();
        request.payload = json!({"inlineAdapterId":id,"afterSequence":index,"maxMessages":1});
        let result = running.supervisor.invoke(request.clone()).unwrap().payload;
        assert_eq!(result["messages"][0]["sequence"], index);
        assert_eq!(
            result["messages"][0]["message"]["body"],
            json!({"value":null,"literal":"$HOME"})
        );
        assert_eq!(result["nextSequence"], index + 1);
        assert_eq!(result["exited"], false);
    }
    request.operation = "closeInlineDebugAdapter".into();
    request.payload = json!({"inlineAdapterId":id});
    running.supervisor.invoke(request).unwrap();
    assert_eq!(
        running
            .supervisor
            .invoke(invocation("probe", json!([]), Duration::from_secs(5)))
            .unwrap()
            .payload,
        json!({"disposed":1,"listenersDisposed":1})
    );
}

#[test]
fn vscode_debug_session_options_encode_parent_handles_and_preserve_child_identity() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => {
            v.debug.onDidStartDebugSession(() => {});
            context.subscriptions.push(v.commands.registerCommand('example.hello', async () => {
                const parent = v.debug.activeDebugSession;
                if (parent.parentSession !== undefined || parent.workspaceFolder !== undefined) throw Error('Parent metadata changed');
                const options = { parentSession: parent, lifecycleManagedByParent: true, consoleMode: v.DebugConsoleMode.MergeWithParent, noDebug: false, suppressSaveBeforeStart: true };
                await v.debug.startDebugging(undefined, { name:'Child', type:'builder', request:'launch' }, options);
                const child = v.debug.activeDebugSession;
                if (child.parentSession !== parent) throw Error('Canonical parent identity changed');
                let rejected = 0;
                for (const options of [{parentSession:{id:parent.id}}, {consoleMode:2}, {noDebug:'true'}, {suppressSaveBeforeStart:'true'}, {unknown:true}]) {
                    try { await v.debug.startDebugging(undefined, 'Invalid', options); } catch { rejected++; }
                }
                if (rejected !== 5) throw Error('Invalid options reached the client');
                await v.debug.startDebugging(undefined, 'Second', parent);
                if (v.debug.activeDebugSession.parentSession !== parent) throw Error('Parent overload changed');
                return [child.id, child.parentSession.id, rejected, v.DebugConsoleMode.Separate];
            }));
        };
    "#).unwrap();
    let parent = json!({"id":"parent","type":"builder","name":"Parent","configuration":{"name":"Parent","type":"builder","request":"launch"},"workspaceFolder":null,"parentSessionId":null});
    let mut initial = invocation("unused", json!([]), Duration::from_secs(5));
    initial.registration_id = "vscode.debug.events".into();
    initial.operation = "debugEvent".into();
    initial.payload = json!({"type":"snapshot","sequence":1,"sessions":[parent],"activeSession":"parent","breakpoints":[],"activeStackItem":null});
    running.supervisor.invoke(initial).unwrap();
    let mut launches = 0;
    let result = running.supervisor.begin_invoke(invocation("hello", json!([]), Duration::from_secs(5))).unwrap().wait_with_client(|operation, _, _| {
        let ExtensionClientOperation::StartDebugging { folder, configuration, options } = operation else { panic!("unexpected client operation: {operation:?}"); };
        launches += 1;
        assert_eq!(folder, None);
        let options = serde_json::to_value(options.as_ref().unwrap()).unwrap();
        if launches == 1 {
            assert_eq!(configuration["name"], "Child");
            assert_eq!(options, json!({"parentSessionId":"parent","lifecycleManagedByParent":true,"consoleMode":1,"noDebug":false,"suppressSaveBeforeStart":true}));
        } else {
            assert_eq!(configuration, json!("Second"));
            assert_eq!(options, json!({"parentSessionId":"parent"}));
        }
        let child = json!({"id":format!("child-{launches}"),"type":"builder","name":"Child","configuration":{"name":"Child","type":"builder","request":"launch"},"workspaceFolder":null,"parentSessionId":"parent"});
        for (kind, offset) in [("start",0),("active",1)] {
            let mut event = invocation("unused", json!([]), Duration::from_secs(5));
            event.registration_id = "vscode.debug.events".into();
            event.operation = "debugEvent".into();
            event.payload = json!({"type":kind,"sequence":launches*2+offset,"session":child});
            running.supervisor.invoke(event).unwrap();
        }
        Ok(ExtensionClientResult::DebugStarted { started:true })
    }).unwrap();
    assert_eq!(launches, 2);
    assert_eq!(result.payload, json!(["child-1", "parent", 5, 0]));
}

#[test]
fn vscode_debug_empty_descriptors_preserve_defaults_and_following_invocations() {
    let running = start_vscode(r#"
        const v = require('vscode');
        exports.activate = context => context.subscriptions.push(v.debug.registerDebugAdapterDescriptorFactory('example', {
            createDebugAdapterDescriptor(session, executable) {
                if (!(executable instanceof v.DebugAdapterExecutable) || executable.command !== 'default-must-not-spawn') throw Error('Default executable missing');
                if (session.configuration.mode === 'undefined') return undefined;
                if (session.configuration.mode === 'null') return null;
                return new v.DebugAdapterExecutable('accepted-adapter', ['', '$HOME']);
            }
        }));
    "#).unwrap();
    let mut request = invocation("unused", json!([]), Duration::from_secs(5));
    request.registration_id = "vscode.debug.1".into();
    request.operation = "createDebugAdapterDescriptor".into();
    for mode in ["undefined", "null", "valid"] {
        request.payload = json!({"executable":{"program":"default-must-not-spawn","arguments":[]},"session":{"id":"empty-descriptor","workspaceFolder":null},"configuration":{"name":"Empty","type":"example","request":"launch","mode":mode}});
        let returned = running.supervisor.invoke(request.clone()).unwrap().payload;
        if mode == "valid" {
            assert_eq!(
                returned,
                json!({"program":"accepted-adapter","arguments":["","$HOME"]})
            );
        } else {
            assert_eq!(returned, Value::Null);
        }
    }
}

fn vscode_initialization() -> external_ext_protocol::ExtensionHostInitialization {
    let empty = serde_json::json!({"contents":{},"keys":[],"overrides":[]});
    serde_json::from_value(serde_json::json!({
        "workspaceFolders":[{"uri":"file:///workspace","name":"Workspace","index":0},{"uri":"file:///workspace/nested","name":"Nested","index":1}],
        "workspaceName":"Fixture", "workspaceFile":null,
        "configurationValues":{"sample":{"enabled":false,"count":0,"empty":"","nested":{"x":1}},"debug":{"saveBeforeStart":"none"}},
        "configurationData": {
            "defaults":{"contents":{"sample":{"enabled":true,"nested":{"x":1}},"debug":{"saveBeforeStart":"allEditorsInActiveGroup"}},"keys":["sample.enabled","sample.nested","debug.saveBeforeStart"],"overrides":[{"keys":["sample.enabled"],"identifiers":["javascript"],"contents":{"sample":{"enabled":true}}}]},
            "policy":empty,"application":empty,"userLocal":{"contents":{"sample":{"enabled":false},"debug":{"saveBeforeStart":"none"}},"keys":["sample.enabled","debug.saveBeforeStart"],"overrides":[]},
            "userRemote":empty,"workspace":empty,"folders":[]
        }
    })).unwrap()
}

#[test]
fn vscode_workspace_and_configuration_are_synchronous_during_package_evaluation_and_activation() {
    let running = start_vscode(r#"
        const v = require('vscode');
        const top = v.workspace.getConfiguration('sample').get('enabled');
        const first = v.workspace.workspaceFolders[0];
        exports.activate = context => {
            if (top !== false || v.workspace.name !== 'Fixture') throw Error('Initialization unavailable during module evaluation');
            if (v.workspace.getWorkspaceFolder(v.Uri.file('/workspace/nested/file.js')) !== v.workspace.workspaceFolders[1]) throw Error('Nested folder identity lost');
            if (v.workspace.getWorkspaceFolder(v.Uri.file('/workspace/nested-other/file.js')) !== first) throw Error('Path boundary ignored');
            if (v.workspace.getWorkspaceFolder(v.Uri.file('/outside')) !== undefined) throw Error('Outside folder accepted');
            const config = v.workspace.getConfiguration('sample');
            const nested = config.get('nested'); nested.x = 42;
            if (config.get('nested').x !== 1 || config.get('count', 12) !== 0 || config.get('empty', 'fallback') !== '') throw Error('Value identity or falsy default changed');
            if (!config.has('enabled') || config.has('missing') || config.inspect('missing') !== undefined) throw Error('Missing key semantics changed');
            const inspection = config.inspect('enabled');
            if (inspection.key !== 'sample.enabled' || inspection.defaultValue !== true || inspection.globalValue !== false) throw Error('Inspect lost owner values');
            if (v.workspace.getConfiguration('sample', {uri:v.Uri.file('/workspace/file.js'),languageId:'javascript'}).get('enabled') !== true) throw Error('Language override ignored');
            context.subscriptions.push(v.commands.registerCommand('example.probe', () => ({top, uri:first.uri.toString(), name:first.name, index:first.index})));
        };
    "#).unwrap();
    let value = run(&running, "probe", json!([])).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"top":false,"uri":"file:///workspace","name":"Workspace","index":0})
    );
}

#[test]
fn extension_environment_is_available_during_module_loading_and_isolated_per_process() {
    let source = r#"
        import { commands } from '@ash/extension';
        if (process.exit !== undefined || process.dlopen !== undefined || process.binding !== undefined || process.cwd !== undefined) throw new Error('Unexpected Node capability');
        const loaded = { set: process.env.SET ?? null, removed: process.env.REMOVE ?? null, prototype: process.env.__proto__ ?? null };
        export function activate(context) {
            context.subscriptions.push(commands.registerCommand('example.env', 'Env', () => loaded));
        }
    "#;
    let launch = |value: &str| {
        start_with_environment(
            source,
            vec![ExtensionCapability::Command],
            ProcessIsolationPolicy::TrustedDevelopment,
            Arc::new(TrustedDevelopmentLauncher),
            TestApi::Ash,
            &[],
            Some(
                [
                    ("SET".into(), Some(value.into())),
                    ("REMOVE".into(), None),
                    ("__proto__".into(), Some("exact key".into())),
                ]
                .into(),
            ),
        )
        .unwrap()
    };
    let first = launch("one");
    let second = launch("two");
    for (runtime, expected) in [(&first, "one"), (&second, "two"), (&first, "one")] {
        assert_eq!(
            runtime
                .supervisor
                .invoke(invocation("env", json!([]), Duration::from_secs(5)))
                .unwrap()
                .payload,
            json!({"set": expected, "removed": null, "prototype": "exact key"})
        );
    }
    first.supervisor.shutdown().unwrap();
    first.supervisor.start().unwrap();
    assert_eq!(
        first
            .supervisor
            .invoke(invocation("env", json!([]), Duration::from_secs(5)))
            .unwrap()
            .payload,
        json!({"set":"one", "removed":null, "prototype":"exact key"})
    );
    let empty = start_with_environment(
        source,
        vec![ExtensionCapability::Command],
        ProcessIsolationPolicy::TrustedDevelopment,
        Arc::new(TrustedDevelopmentLauncher),
        TestApi::Ash,
        &[],
        Some(Default::default()),
    )
    .unwrap();
    assert_eq!(
        empty
            .supervisor
            .invoke(invocation("env", json!([]), Duration::from_secs(5)))
            .unwrap()
            .payload,
        json!({"set":null, "removed":null, "prototype":null})
    );
    // Match the SDK's JavaScript string limit for non-ASCII values as well.
    let value = "界".repeat(8192);
    let unicode = launch(&value);
    assert_eq!(
        unicode
            .supervisor
            .invoke(invocation("env", json!([]), Duration::from_secs(5)))
            .unwrap()
            .payload["set"],
        json!(value)
    );
}
