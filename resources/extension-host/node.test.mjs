import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';

async function host(t, source, entry = 'extension.cjs', capabilities = ['command'], onClient, fixture = {}) {
	const root = await mkdtemp(join(tmpdir(), 'ash-node-host-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const resources = join(root, 'resources');
	const extension = join(root, 'extension');
	await mkdir(resources);
	await mkdir(extension);
	for (const [from, to] of [['node.mjs', 'node.mjs'], ['ash.js', 'ash.mjs'], ['scm.js', 'scm.js']]) {
		await copyFile(new URL(from, import.meta.url), join(resources, to));
	}
	await copyFile(new URL('host.mjs', import.meta.url), join(resources, 'host.mjs'));
	await writeFile(join(extension, 'package.json'), JSON.stringify({ publisher: 'test', name: 'node', contributes: { debuggers: [{ type: 'test', label: 'Test' }], commands: [{ command: 'test.node', title: 'Node' }, { command: 'test.second', title: 'Second' }] }, ...fixture.manifest }));
	for (const [name, contents] of Object.entries(fixture.files ?? {})) {
		const path = join(extension, name);
		await mkdir(join(path, '..'), { recursive: true });
		await writeFile(path, contents);
	}
	await writeFile(join(extension, entry), source);
	const server = createServer();
	t.after(() => server.close());
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const connected = once(server, 'connection');
	const token = randomBytes(32).toString('hex');
	const child = spawn(process.execPath, [join(resources, 'node.mjs'), '--extension-id', 'test.node', '--package', extension, '--entry', entry, '--api', fixture.api ?? 'ash', '--protocol-address', `127.0.0.1:${server.address().port}`, '--protocol-token', token], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...fixture.inheritedEnvironment } });
	t.after(() => child.kill());
	let stderr = '';
	child.stderr.on('data', bytes => { stderr += bytes; });
	let stdout = '';
	child.stdout.on('data', bytes => { stdout += bytes; });
	const [control] = await Promise.race([connected, once(child, 'exit').then(() => { throw new Error(`Host exited before control binding: ${stderr}`); })]);
	t.after(() => control.destroy());
	// Physical stdin EOF must not retire the independently connected control incarnation.
	child.stdin.end();
	const responses = new Map();
	const waiters = new Map();
	const clientCalls = [];
	const registrationEvents = [];
	const registrationWaiters = new Map();
	const readers = createInterface({ input: control });
	t.after(() => readers.close());
	let controlFailure;
	const failRequests = error => {
		controlFailure = error;
		for (const waiter of waiters.values()) waiter.reject(error);
		waiters.clear();
	};
	// Windows may reset the socket when the child exits. Outstanding requests still
	// fail, while shutdown tests observe the child's exit code after its final reply.
	control.on('error', failRequests);
	readers.on('error', failRequests);
	assert.equal((await once(readers, 'line'))[0], token);
	readers.on('line', line => {
		const frame = JSON.parse(line);
		if (frame.speechProviders) {
			registrationEvents.push(frame);
			registrationWaiters.get(frame.revision)?.(frame);
			registrationWaiters.delete(frame.revision);
			return;
		}
		if (frame.callId) {
			clientCalls.push(frame);
			if (onClient) Promise.resolve(onClient(frame)).then(value => send({ context: frame.context, callId: frame.callId, outcome: { Ok: value } }));
			return;
		}
		const waiter = waiters.get(frame.requestId);
		if (waiter) { waiters.delete(frame.requestId); waiter.resolve(frame); }
		else responses.set(frame.requestId, frame);
	});
	child.on('exit', () => {
		for (const waiter of waiters.values()) waiter.reject(new Error(`Host exited: ${stderr}`));
		waiters.clear();
	});
	let id = 0;
	const send = frame => control.write(JSON.stringify(frame) + '\n');
	function request(method, params) {
		const requestId = ++id;
		if (controlFailure) return { requestId, result: Promise.reject(controlFailure) };
		const result = new Promise((resolve, reject) => waiters.set(requestId, { resolve, reject }));
		send({ protocolVersion: 1, requestId, incarnation: 2, activationGeneration: 3, method, ...(params === undefined ? {} : { params }) });
		return { requestId, result };
	}
	for (const environment of fixture.rejectedEnvironments ?? []) {
		const rejected = await request('initialize', { extensionId: 'test.node', runtimeApiVersion: 1, environment }).result;
		assert.equal(rejected.status, 'failure');
	}
	const initial = await request('initialize', { extensionId: 'test.node', runtimeApiVersion: 1, environment: fixture.environment }).result;
	assert.deepEqual(initial.body, { result: 'initialized', body: { protocolVersion: 1, runtimeApiVersion: 1 } });
	const activated = await request('activate', {
		extensionId: 'test.node', capabilities, initialization: {
			language: fixture.language ?? 'en',
			workspaceFolders: [{ uri: pathToFileURL(extension).href, name: 'extension', index: 0 }], workspaceName: 'extension', workspaceFile: null,
			configurationValues: {}, configurationData: { defaults: { contents: {}, keys: [], overrides: [] }, folders: [] },
			...(fixture.localization ? { localization: fixture.localization } : {}),
		}
	}).result;
	if (fixture.expectActivationFailure) { assert.equal(activated.status, 'failure'); return activated; }
	assert.equal(activated.body.result, 'activated', stderr);
	return {
		registrationEvent(revision) { return registrationEvents.find(event => event.revision === revision) ?? new Promise(resolve => registrationWaiters.set(revision, resolve)); },
		child, control, extension, request, send, clientCalls, registrations: activated.body.body.registrations, stderr: () => stderr, stdout: () => stdout,
		invoke(registrationId, arguments_) { return request('invoke', { extensionId: 'test.node', registrationId, operation: 'execute', payload: { arguments: arguments_ }, deadlineUnixMillis: Date.now() + 30000 }); }
	};
}

test('Ash ESM and CommonJS commands use the same host-bound SDK', { timeout: 10000 }, async t => {
	for (const commonjs of [false, true]) {
		const source = commonjs
			? `const ash = require('@ash/sdk'); exports.activate = context => context.subscriptions.push(ash.commands.register('test.node', path => ash.files.readTextFile(path)));`
			: `import * as ash from '@ash/sdk'; export function activate(context) { context.subscriptions.push(ash.commands.register('test.node', path => ash.files.readTextFile(path))); }`;
		const h = await host(t, source, commonjs ? 'extension.cjs' : 'extension.mjs', ['command'], frame => {
			assert.deepEqual(frame.operation, { operation: 'readWorkspaceFile', path: '/workspace/你好.txt' });
			return { result: 'file', text: 'Hello, 世界\n' };
		}, { api: 'ash' });
		assert.deepEqual(h.registrations.filter(registration => registration.kind === 'command').map(registration => registration.command), ['test.node']);
		const result = await h.invoke('test.node', ['/workspace/你好.txt']).result;
		assert.equal(result.status, 'success');
		assert.equal(result.body.body.payload, 'Hello, 世界\n');
	}
});

test('Ash commands retain requests started without awaiting their Promise', { timeout: 10000 }, async t => {
	let release;
	let requested;
	const seen = new Promise(resolve => { requested = resolve; });
	const h = await host(t, `import * as ash from '@ash/sdk';
export function activate(context) { context.subscriptions.push(ash.commands.register('test.node', () => { ash.files.readTextFile('/workspace/file.txt'); return 'finished'; })); }`, 'extension.mjs', ['command'], () => {
		requested();
		return new Promise(resolve => { release = () => resolve({ result: 'file', text: 'file' }); });
	}, { api: 'ash' });
	let completed = false;
	const invocation = h.invoke('test.node', []).result.then(result => { completed = true; return result; });
	await seen;
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(completed, false);
	release();
	assert.equal((await invocation).body.body.payload, 'finished');
});

test('Ash rejects legacy API imports and undeclared command registrations', { timeout: 10000 }, async t => {
	await host(t, `import 'vscode'; export function activate() {}`, 'extension.mjs', ['command'], undefined, { api: 'ash', expectActivationFailure: true });
	await host(t, `import * as ash from '@ash/sdk'; export function activate() { ash.commands.register('undeclared', () => null); }`, 'extension.mjs', ['command'], undefined, { api: 'ash', expectActivationFailure: true });
});

test('the public Ash SDK exposes every implemented domain and excludes retired and raw interfaces', { timeout: 10000 }, async t => {
	const published = await import('../../sdk/typescript/index.js');
	const h = await host(t, `const ash = require('@ash/sdk');
exports.activate = context => context.subscriptions.push(ash.commands.register('test.node', async () => {
 const unavailable = [];
 for (const key of ['ash', 'backend', 'editors']) { try { ash[key]; } catch { unavailable.push(key); } }
 for (const key of ['registerCommand', 'executeCommand']) { try { ash.commands[key]; } catch { unavailable.push(key); } }
 return { keys: Object.keys(ash).sort(), unavailable, result: await ash.commands.execute('test.target', 42) };
}));`, 'extension.cjs', ['command'], frame => {
		assert.deepEqual(frame.operation, { operation: 'executeCommand', command: 'test.target', arguments: [42] });
		return { result: 'command', value: 'called' };
	});
	assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload, { keys: Object.keys(published).sort(), unavailable: ['ash', 'backend', 'editors', 'registerCommand', 'executeCommand'], result: 'called' });
});

test('Ash comparison opening accepts existing comparison inputs through a bounded editor operation', { timeout: 10000 }, async t => {
	const calls = [];
	const h = await host(t, `const ash = require('@ash/sdk');
exports.activate = context => context.subscriptions.push(ash.commands.register('test.node', async input => {
 await ash.window.openComparison(input, { pinned: true }, true); return 'opened';
}));`, 'extension.cjs', ['command'], frame => { calls.push(frame.operation); return { result: 'value', value: null }; });
	const original = { resource: 'snapshot:/before', initialBytes: [0, 255], contentType: 'application/octet-stream' };
	const modified = { resource: 'snapshot:/after', initialBytes: [0, 254], contentType: 'application/octet-stream' };
	for (const input of [{ kind: 'diff', original: { resource: 'snapshot:/text', initialText: 'before' }, modified: { resource: 'file:/after' } }, { kind: 'binaryDiff', original, modified }, { kind: 'multiDiff', resource: 'comparison:/changes', items: [{ binary: true, original, modified }] }]) {
		assert.equal((await h.invoke('test.node', [input]).result).body.body.payload, 'opened');
		assert.deepEqual(calls.at(-1), { operation: 'editorOperation', payload: { method: 'open', input, options: { pinned: true }, sideBySide: true } });
	}
	assert.equal((await h.invoke('test.node', [{ kind: 'raw', method: 'dispose' }]).result).status, 'failure');
	assert.equal(calls.length, 3);
});

test('Ash manifest command titles follow the initiating client language', { timeout: 10000 }, async t => {
	const h = await host(t, `import * as ash from '@ash/sdk'; export function activate(context) { context.subscriptions.push(ash.commands.register('test.node', () => null)); }`, 'extension.mjs', ['command'], undefined, {
		api: 'ash', language: 'zh-CN',
		manifest: { contributes: { commands: [{ command: 'test.node', title: '%readFile%' }] } },
		files: {
			'package.nls.json': JSON.stringify({ readFile: 'Read file' }),
			'package.nls.zh-CN.json': JSON.stringify({ readFile: '读取文件' }),
		},
	});
	assert.equal(h.registrations.find(registration => registration.command === 'test.node').title, '读取文件');
});

test('custom text editor asset roles follow HTML instead of URI conversion order', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk');
exports.activate = context => context.subscriptions.push(v.window.registerCustomEditorProvider('test.editor', {
 resolveCustomTextEditor(document, panel) {
  const style = panel.webview.asWebviewUri(v.Uri.parse('blob:style')).toString();
  const script = panel.webview.asWebviewUri(v.Uri.parse('blob:script')).toString();
  panel.webview.html = '<link rel="stylesheet" href="' + style + '"><p>editor</p><script src="' + script + '"></script>';
 }
}));`, 'extension.cjs', ['customTextEditor'], undefined, {
		manifest: { contributes: { customEditors: [{ viewType: 'test.editor', displayName: 'Editor', selector: [{ filenamePattern: '*.md' }] }] } },
	});
	const result = await h.request('invoke', {
		extensionId: 'test.node', registrationId: 'test.editor', operation: 'resolveCustomTextEditor',
		payload: { document: { uri: 'untitled:/test.md', text: '# Test', languageId: 'markdown', version: 1 } }, deadlineUnixMillis: Date.now() + 5000,
	}).result;
	assert.equal(result.status, 'success');
	assert.deepEqual(result.body.body.payload, { html: '<p>editor</p>', resources: { style: 'blob:style', script: 'blob:script' } });
});

test('window environment is applied before module evaluation and inherited by Debug children', { timeout: 15000 }, async t => {
	const source = `const v = require('@ash/sdk'); const cp = require('node:child_process');
const keys = ['ASH_NODE_ENV_VALUE', 'ASH_NODE_ENV_REMOVE', 'ASH_NODE_ENV_EMPTY', 'ASH_NODE_ENV_INHERITED', 'OPENAI_API_KEY'];
const snapshot = () => Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
const evaluation = snapshot();
exports.activate = context => context.subscriptions.push(v.commands.register('test.node', () => ({
    evaluation, current: snapshot(), child: JSON.parse(cp.execFileSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(Object.fromEntries(' + JSON.stringify(keys) + '.map(key => [key, process.env[key] ?? null]))))'], { encoding: 'utf8' }))
})));`;
	const inheritedEnvironment = {
		ASH_NODE_ENV_VALUE: 'inherited', ASH_NODE_ENV_REMOVE: 'remove', ASH_NODE_ENV_EMPTY: 'nonempty',
		ASH_NODE_ENV_INHERITED: 'keep', OPENAI_API_KEY: 'synthetic-developer-key',
	};
	const first = await host(t, source, 'extension.cjs', ['command'], undefined, {
		inheritedEnvironment, environment: { ASH_NODE_ENV_VALUE: 'first', ASH_NODE_ENV_REMOVE: null, ASH_NODE_ENV_EMPTY: '' },
		// Invalid batches must leave even preceding valid entries untouched.
		rejectedEnvironments: [{ ASH_NODE_ENV_INHERITED: 'changed', 'invalid-name': 'reject' }, [], { VALUE: 'value\0' }, { VALUE: 42 }],
	});
	const second = await host(t, source, 'extension.cjs', ['command'], undefined, {
		inheritedEnvironment, environment: { ASH_NODE_ENV_VALUE: 'second' },
	});
	assert.notEqual(first.child.pid, second.child.pid);
	for (const [h, value, remove, empty] of [[first, 'first', null, ''], [second, 'second', 'remove', 'nonempty']]) {
		const expected = { ASH_NODE_ENV_VALUE: value, ASH_NODE_ENV_REMOVE: remove, ASH_NODE_ENV_EMPTY: empty, ASH_NODE_ENV_INHERITED: 'keep', OPENAI_API_KEY: 'synthetic-developer-key' };
		assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload, { evaluation: expected, current: expected, child: expected });
	}
});

test('CJS extension uses real Node filesystem, TCP, child processes and module cache', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); const fs = require('node:fs'); const net = require('node:net'); const cp = require('node:child_process');
if (v !== require('@ash/sdk')) throw Error('Editor API identity changed');
exports.activate = context => context.subscriptions.push(v.commands.register('test.node', async () => {
    fs.writeFileSync(__dirname + '/proof.txt', 'Node file');
    const server = net.createServer(socket => { socket.end('Node TCP'); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const received = await new Promise((resolve, reject) => { const client = net.connect(server.address().port, '127.0.0.1'); let text = ''; client.on('data', bytes => text += bytes); client.on('end', () => resolve(text)); client.on('error', reject); });
    await new Promise(resolve => server.close(resolve));
    console.log('Extension stdout remains ordinary stdio');
    fs.writeSync(1, 'Raw fd stdout\\n');
    cp.execFileSync(process.execPath, ['-e', 'process.stdout.write("Inherited child stdout")'], { stdio: 'inherit' });
    return { file: fs.readFileSync(__dirname + '/proof.txt', 'utf8'), tcp: received, child: cp.execFileSync(process.execPath, ['-e', 'process.stdout.write("Node child")'], { encoding: 'utf8' }), buffer: Buffer.from('Node Buffer').toString() };
}));`);
	const response = await h.invoke('test.node', []).result;
	assert.deepEqual(response.body.body.payload, { file: 'Node file', tcp: 'Node TCP', child: 'Node child', buffer: 'Node Buffer' });
	assert.equal(await readFile(join(h.extension, 'proof.txt'), 'utf8'), 'Node file');
	assert.match(h.stdout(), /Extension stdout remains ordinary stdio/);
	assert.match(h.stdout(), /Raw fd stdout/);
	assert.match(h.stdout(), /Inherited child stdout/);
	const exit = once(h.child, 'exit');
	assert.equal((await h.request('shutdown').result).body.result, 'shutdown');
	assert.equal((await exit)[0], 0);
});

test('parent control closure retires a host with retained timers', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
setInterval(() => {}, 1000);
context.subscriptions.push(v.commands.register('test.node', () => 'alive'));
};`);
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 'alive');
	const exit = once(h.child, 'exit');
	h.control.end();
	assert.equal((await exit)[0], 0);
});

test('ESM extension imports the same editor API and real Node builtins', { timeout: 10000 }, async t => {
	const h = await host(t, `import v, { commands } from '@ash/sdk'; import { basename } from 'node:path';
export function activate(context) { if (commands !== v.commands) throw Error('API identity differs'); context.subscriptions.push(commands.register('test.node', () => basename('/workspace/real-node.js'))); }`, 'extension.mjs');
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 'real-node.js');
});

test('transpiled CommonJS imports can inspect module metadata without changing API identity', { timeout: 10000 }, async t => {
	const h = await host(t, `const raw = require('@ash/sdk');
const imported = raw && raw.__esModule ? raw : { ...raw, default: raw };
if (imported.default !== raw || imported.commands !== raw.commands) throw Error('Module identity differs');
if (raw.commands.__esModule !== undefined) throw Error('Namespace metadata differs');
exports.activate = context => context.subscriptions.push(imported.commands.register('test.node', () => {
    try { raw.missingPublicApi(); } catch (error) { return error.message; }
    throw Error('Unsupported API was silently accepted');
}));`);
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 'Unsupported Ash API: ash.missingPublicApi');
});

test('debug extension tree item subclasses retain public label and resource values', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk');
class BreakpointItem extends v.TreeItem {
    constructor(label) { super(label, v.TreeItemCollapsibleState.Expanded); this.checkboxState = v.TreeItemCheckboxState.Checked; }
}
exports.activate = context => context.subscriptions.push(v.commands.register('test.node', () => {
    const label = { label: 'Breakpoint', highlights: [[0, 5]] };
    const item = new BreakpointItem(label);
    item.description = 'at line 2';
    const resource = v.Uri.file('/workspace/program.js');
    const file = new v.TreeItem(resource);
    return { labelIdentity: item.label === label, description: item.description, state: item.collapsibleState, checked: item.checkboxState, resourceIdentity: file.resourceUri === resource, defaultState: file.collapsibleState, hasLabel: file.label !== undefined };
}));`);
	assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload, {
		labelIdentity: true, description: 'at line 2', state: 2, checked: 1, resourceIdentity: true, defaultState: 0, hasLabel: false,
	});
});

test('window language selects the package translation bundle before CommonJS evaluation', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk');
const evaluation = v.l10n.t('Target {0}', 'worker');
exports.activate = context => context.subscriptions.push(v.commands.register('test.node', () => ({
    language: v.env.language, evaluation, uri: v.l10n.uri.path.endsWith('/l10n/bundle.l10n.zh-cn.json'),
    contents: v.l10n.bundle['Target {0}'], named: v.l10n.t('Ready {name}: {count}', { name: 'worker', count: 0 }),
    comment: v.l10n.t({ message: 'Paused {0}', args: [false], comment: ['debug', ' state'] }),
    fallback: v.l10n.t('Missing {0} {1}', 'first'), inherited: v.l10n.t('toString'),
})));`, 'extension.cjs', ['command'], undefined, {
		language: 'zh-cn', manifest: { l10n: './l10n' }, files: {
			'l10n/bundle.l10n.zh-cn.json': JSON.stringify({
				'Target {0}': '目标 {0}', 'Ready {name}: {count}': '就绪 {name}：{count}', 'Paused {0}/debug state': '已暂停 {0}',
			})
		},
	});
	assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload, {
		language: 'zh-cn', evaluation: '目标 worker', uri: true, contents: '目标 {0}', named: '就绪 worker：0', comment: '已暂停 false', fallback: 'Missing first {1}', inherited: 'toString',
	});
});

test('missing or invalid translation resources fall back to the source without inventing a bundle', { timeout: 10000 }, async t => {
	for (const fixture of [
		{ language: 'en', manifest: { l10n: './l10n' }, files: { 'l10n/bundle.l10n.en.json': '{"Target":"unwanted"}' } },
		{ language: 'zh-cn', manifest: { l10n: './missing' } },
		{ language: 'zh-cn', manifest: { l10n: './l10n' }, files: { 'l10n/bundle.l10n.zh-cn.json': 'invalid json' } },
		{ language: 'zh-cn', manifest: { l10n: '../outside' }, files: { '../outside/bundle.l10n.zh-cn.json': '{"Target":"outside"}' } },
	]) {
		const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => context.subscriptions.push(v.commands.register('test.node', () => ({ message: v.l10n.t('Target {0}', 0), bundle: v.l10n.bundle === undefined, uri: v.l10n.uri === undefined })));`, 'extension.cjs', ['command'], undefined, fixture);
		assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload, { message: 'Target 0', bundle: true, uri: true });
	}
});

test('concurrent callbacks retain identity and detached Node work uses the activation fence', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
context.subscriptions.push(v.commands.register('test.node', async key => { await new Promise(resolve => setTimeout(resolve, key === 'first' ? 15 : 1)); return v.commands.execute('read.identity', key); }));
context.subscriptions.push(v.commands.register('test.second', async () => { setTimeout(async () => { const result = await v.commands.execute('background'); require('node:fs').writeFileSync(__dirname + '/background.txt', result); }, 25); return 'finished'; }));
};`);
	const first = h.invoke('test.node', ['first']);
	const second = h.invoke('test.node', ['second']);
	while (h.clientCalls.length < 2) { if (t.signal.aborted) throw new Error('Test aborted'); await new Promise(resolve => setTimeout(resolve, 2)); }
	assert.deepEqual(h.clientCalls.map(call => call.context.requestId).sort((a, b) => a - b), [first.requestId, second.requestId]);
	for (const call of h.clientCalls) {
		h.send({ context: call.context, callId: call.callId, outcome: { Ok: { result: 'command', value: call.operation.arguments[0], hasValue: true } } });
	}
	assert.equal((await first.result).body.body.payload, 'first');
	assert.equal((await second.result).body.body.payload, 'second');
	assert.equal((await h.invoke('test.second', []).result).body.body.payload, 'finished');
	while (h.clientCalls.length < 3) { if (t.signal.aborted) throw new Error('Test aborted'); await new Promise(resolve => setTimeout(resolve, 2)); }
	const background = h.clientCalls[2];
	assert.deepEqual(background.context, { protocolVersion: 1, incarnation: 2, activationGeneration: 3 });
	assert.equal(background.operation.command, 'background');
	h.send({ context: background.context, callId: background.callId, outcome: { Ok: { result: 'command', value: 'lifecycle result' } } });
	while (true) {
		if (t.signal.aborted) throw new Error('Test aborted');
		try { assert.equal(await readFile(join(h.extension, 'background.txt'), 'utf8'), 'lifecycle result'); break; }
		catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 2)); }
	}
});

test('cancellation reaches the Debug provider token without retiring other callbacks', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
context.subscriptions.push(v.debug.registerDebugConfigurationProvider('test', {
resolveDebugConfiguration(folder, config, token) { return new Promise(resolve => {
require('node:fs').writeFileSync(__dirname + '/waiting.txt', 'waiting');
token.onCancellationRequested(() => resolve(undefined));
}); }
}));
context.subscriptions.push(v.commands.register('test.second', () => 'other'));
};`, 'extension.cjs', ['command', 'debugAdapter']);
	const registrationId = h.registrations.find(registration => registration.kind === 'debugConfigurationProvider').registrationId;
	const pending = h.request('invoke', { extensionId: 'test.node', registrationId, operation: 'resolveDebugConfiguration', payload: { configuration: { type: 'test', request: 'launch' } }, deadlineUnixMillis: Date.now() + 30000 });
	while (true) { if (t.signal.aborted) throw new Error('Test aborted'); try { await readFile(join(h.extension, 'waiting.txt')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 2)); } }
	assert.equal((await h.request('cancel', { requestId: pending.requestId, reason: 'caller' }).result).status, 'failure');
	assert.equal((await h.request('cancel', { targetRequestId: pending.requestId, reason: 'caller' }).result).body.result, 'cancelled');
	assert.equal((await h.invoke('test.second', []).result).body.body.payload, 'other');
	assert.deepEqual((await pending.result).body.body.payload, { cancelled: true });
});


test('late service replies after cancellation cannot revive authority or break other callbacks', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
context.subscriptions.push(v.commands.register('test.node', async () => { try { return await v.commands.execute('waiting'); } catch (error) { return error.code; } }));
context.subscriptions.push(v.commands.register('test.second', () => 'other'));
};`);
	const pending = h.invoke('test.node', []);
	while (h.clientCalls.length < 1) { if (t.signal.aborted) throw new Error('Test aborted'); await new Promise(resolve => setTimeout(resolve, 2)); }
	const call = h.clientCalls[0];
	await h.request('cancel', { targetRequestId: pending.requestId, reason: 'caller' }).result;
	assert.equal((await pending.result).body.body.payload, 'cancelled');
	h.send({ context: call.context, callId: call.callId, outcome: { Ok: { result: 'command', value: 'late', hasValue: true } } });
	assert.equal((await h.invoke('test.second', []).result).body.body.payload, 'other');
});


test('activation can await editor services before publishing its registrations', { timeout: 10000 }, async t => {
	const calls = [];
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = async context => {
        await v.window.showInformationMessage('Node activation');
        const value = await v.commands.execute('startup.value');
        context.subscriptions.push(v.commands.register('test.node', () => value));
    };`, 'extension.cjs', ['command'], frame => {
		calls.push(frame);
		return frame.operation.operation === 'showMessage' ? { result: 'done' } : { result: 'command', value: 'activated with editor IO' };
	});
	assert.deepEqual(calls.map(value => value.context), [
		{ protocolVersion: 1, incarnation: 2, activationGeneration: 3 },
		{ protocolVersion: 1, incarnation: 2, activationGeneration: 3 },
	]);
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 'activated with editor IO');
});

for (const [reason, expected] of [['caller', 'cancelled'], ['deadline', 'deadlineExceeded']]) {
	test(`uncaught service cancellation preserves ${reason} without retiring the host`, { timeout: 10000 }, async t => {
		const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
context.subscriptions.push(v.commands.register('test.node', () => v.commands.execute('waiting')));
context.subscriptions.push(v.commands.register('test.second', () => 'other'));
};`);
		const pending = h.invoke('test.node', []);
		while (!h.clientCalls.length) { if (t.signal.aborted) throw new Error('Test aborted'); await new Promise(resolve => setTimeout(resolve, 2)); }
		const call = h.clientCalls[0];
		await h.request('cancel', { targetRequestId: pending.requestId, reason }).result;
		const result = await pending.result;
		assert.equal(result.status, 'failure');
		assert.equal(result.body.code, expected);
		h.send({ context: call.context, callId: call.callId, outcome: { Ok: { result: 'command', value: 'late', hasValue: true } } });
		assert.equal((await h.invoke('test.second', []).result).body.body.payload, 'other');
	});
}

test('Quick Pick preserves item metadata and returns the original item', { timeout: 10000 }, async t => {
	const item = { label: 'occupied', description: 'origin/occupied', detail: 'Checked out elsewhere' };
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
        context.subscriptions.push(v.commands.register('test.node', async () => {
            const item = ${JSON.stringify(item)};
            const selected = await v.window.showQuickPick(['main', item], { placeHolder: 'Choose' });
            return selected === item;
        }));
    };`, 'extension.cjs', ['command'], frame => {
		assert.deepEqual(frame.operation, { operation: 'showQuickPick', items: [{ label: 'main' }, item], placeholder: 'Choose' });
		return { result: 'selection', index: 1 };
	});
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, true);
});


test('shutdown cancels detached service requests without unhandled rejection terminating the protocol', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
        context.subscriptions.push(v.commands.register('test.node', () => {
            setTimeout(() => { void v.commands.execute('background.wait'); }, 5);
            return 'queued';
        }));
    };`);
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 'queued');
	while (!h.clientCalls.length) { if (t.signal.aborted) throw new Error('Test aborted'); await new Promise(resolve => setTimeout(resolve, 2)); }
	const exit = once(h.child, 'exit');
	assert.equal((await h.request('deactivate').result).body.result, 'deactivated');
	assert.equal((await h.request('shutdown').result).body.result, 'shutdown');
	assert.equal((await exit)[0], 0);
});


test('parallel activation IO applies bounded backpressure and completes every request', { timeout: 10000 }, async t => {
	let activeCalls = 0;
	let maximumCalls = 0;
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = async context => {
        const results = await Promise.all(Array.from({ length: 64 }, (_, index) => v.commands.execute('startup.value', index)));
        context.subscriptions.push(v.commands.register('test.node', () => results));
    };`, 'extension.cjs', ['command'], async frame => {
		maximumCalls = Math.max(maximumCalls, ++activeCalls);
		await new Promise(resolve => setTimeout(resolve, 5));
		activeCalls--;
		return { result: 'command', value: frame.operation.arguments[0] };
	});
	assert.equal(h.clientCalls.length, 64);
	assert.ok(maximumCalls <= 32 && maximumCalls > 1);
	assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload, Array.from({ length: 64 }, (_, index) => index));
});

test('private secrets provide only fresh UTF-8 get/store/delete, including empty values', { timeout: 10000 }, async t => {
	let value = null;
	const h = await host(t, `const ash = require('@ash/sdk'); exports.activate = context => context.subscriptions.push(ash.commands.register('test.node', async (action,input) => {
 if (action === 'store') { await context.secrets.store('token',input); return null; }
 if (action === 'delete') return context.secrets.delete('token');
 if (action === 'methods') return Object.keys(context.secrets).sort();
 return {value:await context.secrets.get('token')};
}));`, 'extension.cjs', ['command'], frame => {
		const request = frame.operation.request;
		let response;
		if (request.service === 'secretLoad') response = { service: 'secretLoaded', value };
		if (request.service === 'secretStore') { assert.equal(request.key, 'token'); value = request.value; response = { service: 'secretStored' }; }
		if (request.service === 'secretDelete') { const deleted = value !== null; value = null; response = { service: 'secretDeleted', deleted }; }
		assert.ok(response); return { result: 'coreService', response };
	});
	assert.deepEqual((await h.invoke('test.node', ['get']).result).body.body.payload, {});
	await h.invoke('test.node', ['store', '你好']).result;
	assert.deepEqual(value, [...new TextEncoder().encode('你好')]);
	assert.deepEqual((await h.invoke('test.node', ['get']).result).body.body.payload, { value: '你好' });
	value = [...new TextEncoder().encode('changed elsewhere')];
	assert.deepEqual((await h.invoke('test.node', ['get']).result).body.body.payload, { value: 'changed elsewhere' });
	await h.invoke('test.node', ['store', '']).result;
	assert.deepEqual((await h.invoke('test.node', ['get']).result).body.body.payload, { value: '' });
	assert.equal((await h.invoke('test.node', ['delete']).result).body.body.payload, true);
	assert.equal((await h.invoke('test.node', ['delete']).result).body.body.payload, false);
	assert.deepEqual((await h.invoke('test.node', ['methods']).result).body.body.payload, ['delete', 'get', 'store']);
});

test('ordinary state provides only key get/update and distinguishes null from deletion', { timeout: 10000 }, async t => {
	const values = new Map();
	const h = await host(t, `const ash=require('@ash/sdk'); exports.activate=context=>context.subscriptions.push(ash.commands.register('test.node',async(action,key,value)=>{
 if(action==='methods') return Object.keys(context.storage).sort();
 if(action==='get') return {value:await context.storage.get(key)};
 await context.storage.update(key,action==='delete'?undefined:value); return null;
}));`, 'extension.cjs', ['command'], frame => {
		const r = frame.operation.request;
		if (r.service === 'storageGet') return { result: 'coreService', response: { service: 'storageValue', found: values.has(r.key), value: values.get(r.key) ?? null } };
		if (r.service === 'storageSet') values.set(r.key, r.value);
		else if (r.service === 'storageDelete') values.delete(r.key);
		else assert.fail('Unexpected private operation');
		return { result: 'coreService', response: { service: 'storageUpdated' } };
	});
	assert.deepEqual((await h.invoke('test.node', ['get', 'nothing']).result).body.body.payload, {});
	await h.invoke('test.node', ['set', 'nothing', null]).result;
	assert.deepEqual((await h.invoke('test.node', ['get', 'nothing']).result).body.body.payload, { value: null });
	values.set('nothing', 'changed elsewhere');
	assert.deepEqual((await h.invoke('test.node', ['get', 'nothing']).result).body.body.payload, { value: 'changed elsewhere' });
	await h.invoke('test.node', ['delete', 'nothing']).result;
	assert.deepEqual((await h.invoke('test.node', ['get', 'nothing']).result).body.body.payload, {});
	assert.deepEqual((await h.invoke('test.node', ['methods']).result).body.body.payload, ['get', 'update']);
});

test('state and secrets reject invalid values without sending private requests', { timeout: 10000 }, async t => {
	const h = await host(t, `const ash=require('@ash/sdk'); exports.activate=context=>context.subscriptions.push(ash.commands.register('test.node',async()=>{
 const s=context.secrets, v=context.storage;
 const invalid=[()=>s.get(''),()=>s.get('x'.repeat(257)),()=>s.get('bad\\0key'),()=>s.get(1),()=>s.store('token',{}),()=>s.store('token','x'.repeat(65537)),()=>s.delete(null),()=>v.get(''),()=>v.update('bad\\0key',1),()=>v.update('x',NaN),()=>v.update('x',{lost:undefined}),()=>v.update('x',()=>{})];
 let count=0; for(const call of invalid){try{await call();}catch{count++;}} return count;
}));`);
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 12);
	assert.deepEqual(h.clientCalls, []);
});

test('state and secrets cancellation suppress late replies and never replay writes', { timeout: 10000 }, async t => {
	for (const kind of ['storage', 'secrets']) {
		const call = kind === 'storage' ? "context.storage.update('key',true)" : "context.secrets.store('key','synthetic')";
		const h = await host(t, `const ash=require('@ash/sdk'); exports.activate=context=>{
 context.subscriptions.push(ash.commands.register('test.node',async()=>{try{await ${call}; return 'written';}catch(error){return error.code;}}));
 context.subscriptions.push(ash.commands.register('test.second',()=> 'alive'));
};`);
		const pending = h.invoke('test.node', []);
		while (!h.clientCalls.length) { if (t.signal.aborted) throw new Error('Test aborted'); await new Promise(resolve => setTimeout(resolve, 2)); }
		const request = h.clientCalls[0];
		await h.request('cancel', { targetRequestId: pending.requestId, reason: 'caller' }).result;
		assert.equal((await pending.result).body.body.payload, 'cancelled');
		h.send({ context: request.context, callId: request.callId, outcome: { Ok: { result: 'coreService', response: { service: kind === 'storage' ? 'storageUpdated' : 'secretStored' } } } });
		assert.equal((await h.invoke('test.second', []).result).body.body.payload, 'alive');
		const denied = h.invoke('test.node', []);
		while (h.clientCalls.length < 2) { if (t.signal.aborted) throw new Error('Test aborted'); await new Promise(resolve => setTimeout(resolve, 2)); }
		const next = h.clientCalls[1]; h.send({ context: next.context, callId: next.callId, outcome: { Err: { code: 'permissionDenied', message: 'retired' } } });
		assert.equal((await denied.result).body.body.payload, 'permissionDenied');
		assert.equal(h.clientCalls.length, 2);
	}
});

test('configuration writes use explicit owner targets, resets and authoritative change events', { timeout: 10000 }, async t => {
	const h = await host(t, `import * as ash from '@ash/sdk';
const captured = ash.workspace.getConfiguration('sample');
const changes = [];
export function activate(context) {
 context.subscriptions.push(ash.workspace.onDidChangeConfiguration(event => changes.push(event.affectsConfiguration('sample.enabled'))));
 context.subscriptions.push(ash.commands.register('test.node', async (target, value, reset) => {
  await captured.update('enabled', reset ? undefined : value, target);
  return { captured: captured.get('enabled', 'missing'), current: ash.workspace.getConfiguration('sample').get('enabled', 'missing'), changes: [...changes] };
 }));
 context.subscriptions.push(ash.commands.register('test.second', () => ({ captured: captured.get('enabled', 'missing'), current: ash.workspace.getConfiguration('sample').get('enabled', 'missing'), changes: [...changes] })));
}`, 'extension.mjs', ['command'], () => ({ result: 'done' }));
	assert.deepEqual((await h.invoke('test.node', ['workspace', false, false]).result).body.body.payload, { captured: 'missing', current: 'missing', changes: [] });
	assert.deepEqual(h.clientCalls[0].operation, { operation: 'updateConfiguration', section: 'sample.enabled', value: false, target: 'workspace' });
	// A successful write does not create a second configuration owner in the SDK.
	const data = { defaults: { contents: {}, keys: [], overrides: [] }, workspace: { contents: { sample: { enabled: false } }, keys: ['sample.enabled'], overrides: [] }, folders: [] };
	assert.equal((await h.request('invoke', { extensionId: 'test.node', registrationId: 'ash.workspace.events', operation: 'workspaceEvent', payload: { type: 'configuration', revision: 1, emit: true, configurationValues: { sample: { enabled: false } }, configurationData: data, change: { keys: ['sample.enabled'], overrides: [] } }, deadlineUnixMillis: Date.now() + 30000 }).result).status, 'success');
	assert.deepEqual((await h.invoke('test.second', []).result).body.body.payload, { captured: 'missing', current: false, changes: [true] });
	await h.invoke('test.node', ['user', { label: '你好', values: [0, '', null] }, false]).result;
	assert.deepEqual(h.clientCalls[1].operation, { operation: 'updateConfiguration', section: 'sample.enabled', value: { label: '你好', values: [0, '', null] }, target: 'user' });
	await h.invoke('test.node', ['workspace', null, true]).result;
	assert.deepEqual(h.clientCalls[2].operation, { operation: 'resetConfiguration', section: 'sample.enabled', target: 'workspace' });
	await h.invoke('test.node', ['user', null, false]).result;
	assert.deepEqual(h.clientCalls[3].operation, { operation: 'updateConfiguration', section: 'sample.enabled', value: null, target: 'user' });
});

test('configuration writes reject unsupported scopes and lossy JSON without sending requests', { timeout: 10000 }, async t => {
	const h = await host(t, `const ash = require('@ash/sdk'); exports.activate = context => context.subscriptions.push(ash.commands.register('test.node', async () => {
 const config = ash.workspace.getConfiguration('sample');
 const circular = {}; circular.self = circular;
 const invalid = [
  () => config.update('enabled', true),
  () => config.update('enabled', true, 'folder'),
  () => config.update('enabled', true, false),
  () => config.update(null, true, 'user'),
  () => config.update('bad\\0key', true, 'user'),
  () => ash.workspace.getConfiguration().update('', true, 'user'),
  () => ash.workspace.getConfiguration('sample', {languageId:'typescript'}).update('enabled', true, 'workspace'),
  ...[NaN, Infinity, {nested:undefined}, [undefined], () => {}, Symbol('value'), 1n, circular, new Map()].map(value => () => config.update('enabled', value, 'user')),
 ];
 let rejected = 0;
 for (const update of invalid) { try { await update(); } catch { rejected++; } }
 return { rejected, total: invalid.length };
}));`);
	const { rejected, total } = (await h.invoke('test.node', []).result).body.body.payload;
	assert.equal(rejected, total);
	assert.equal(total, 16);
	assert.deepEqual(h.clientCalls, []);
});

test('configuration owner failures and cancellation propagate without replaying writes', { timeout: 10000 }, async t => {
	const h = await host(t, `const ash = require('@ash/sdk'); exports.activate = context => {
 context.subscriptions.push(ash.commands.register('test.node', async () => { try { await ash.workspace.getConfiguration('sample').update('enabled', true, 'workspace'); } catch(error) { return {code:error.code, message:error.message}; } }));
 context.subscriptions.push(ash.commands.register('test.second', () => 'alive'));
};`);
	const first = h.invoke('test.node', []);
	while (h.clientCalls.length < 1) { if (t.signal.aborted) throw new Error('Test aborted'); await new Promise(resolve => setTimeout(resolve, 2)); }
	const rejected = h.clientCalls[0];
	h.send({ context: rejected.context, callId: rejected.callId, outcome: { Err: { code: 'denied', message: 'Configuration is managed by policy' } } });
	assert.deepEqual((await first.result).body.body.payload, { code: 'denied', message: 'Configuration is managed by policy' });
	const pending = h.invoke('test.node', []);
	while (h.clientCalls.length < 2) { if (t.signal.aborted) throw new Error('Test aborted'); await new Promise(resolve => setTimeout(resolve, 2)); }
	const cancelled = h.clientCalls[1];
	await h.request('cancel', { targetRequestId: pending.requestId, reason: 'caller' }).result;
	assert.equal((await pending.result).body.body.payload.code, 'cancelled');
	h.send({ context: cancelled.context, callId: cancelled.callId, outcome: { Ok: { result: 'done' } } });
	assert.equal((await h.invoke('test.second', []).result).body.body.payload, 'alive');
	assert.equal(h.clientCalls.length, 2);
});

test('live window events update synchronous snapshots, preserve folder handles and respect configuration scopes', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk');
const original = v.workspace.workspaceFolders[0];
const captured = v.workspace.getConfiguration('sample');
const receiver = {}; const listeners = []; const changes = []; const folders = [];
v.workspace.onDidChangeConfiguration(function(event) {
 if (this !== receiver) throw Error('Event receiver changed');
 changes.push({parent:event.affectsConfiguration('sample'),other:event.affectsConfiguration('unrelated'),enabled:event.affectsConfiguration('sample.enabled'),scoped:event.affectsConfiguration('sample.enabled',v.Uri.joinPath(original.uri,'source.ts')),language:event.affectsConfiguration('sample.enabled',{uri:v.Uri.joinPath(original.uri,'source.ts'),languageId:'typescript'}),policy:event.affectsConfiguration('sample.count',v.Uri.joinPath(original.uri,'source.ts'))});
}, receiver, listeners);
v.workspace.onDidChangeWorkspaceFolders(event => folders.push({added:event.added.map(folder => folder.uri.toString()),removed:event.removed.map(folder => ({uri:folder.uri.toString(),name:folder.name,index:folder.index}))}), undefined, listeners);
exports.activate = context => {
 context.subscriptions.push(...listeners);
 context.subscriptions.push(v.commands.register('test.second', () => { for (const listener of listeners) listener.dispose(); }));
 context.subscriptions.push(v.commands.register('test.node', () => ({changes,folders,current:v.workspace.getConfiguration('sample').get('enabled','missing'),count:v.workspace.getConfiguration('sample').get('count','missing'),captured:captured.get('enabled','missing'),name:original.name,index:original.index,retained:v.workspace.getWorkspaceFolder(v.Uri.joinPath(original.uri,'source.ts'))===original,empty:v.workspace.workspaceFolders===undefined,workspaceName:v.workspace.name??null}))); };`);
	const folderURI = pathToFileURL(h.extension).href;
	const empty = () => ({ contents: {}, keys: [], overrides: [] });
	const data = {
		defaults: { contents: { sample: { enabled: true, count: 1 } }, keys: ['sample.enabled', 'sample.count'], overrides: [{ identifiers: ['typescript'], keys: ['sample.enabled'], contents: { sample: { enabled: false } } }] },
		policy: { contents: { sample: { count: 17 } }, keys: ['sample.count'], overrides: [] },
		application: empty(), userLocal: empty(), userRemote: empty(), workspace: empty(),
		folders: [[{ scheme: 'file', path: decodeURIComponent(new URL(folderURI).pathname) }, { contents: { sample: { enabled: true } }, keys: ['sample.enabled'], overrides: [] }]],
	};
	async function event(payload) {
		const reply = await h.request('invoke', { extensionId: 'test.node', registrationId: 'ash.workspace.events', operation: 'workspaceEvent', payload, deadlineUnixMillis: Date.now() + 30000 }).result;
		assert.equal(reply.status, 'success', h.stderr());
	}
	const config = (revision, emit, enabled, count) => ({ type: 'configuration', revision, emit, configurationValues: { sample: { enabled, count } }, configurationData: data, change: { keys: ['sample.enabled', 'sample.count'], overrides: [] } });
	// Equivalent URI encodings must resolve the same folder configuration model.
	await event({ type: 'workspace', revision: 1, emit: false, workspaceFolders: [{ uri: folderURI.replace(/extension$/, '%65xtension'), name: 'extension', index: 0 }], workspaceName: 'extension', workspaceFile: null });
	await event(config(1, false, true, 1));
	await event(config(2, true, false, 0));
	await event(config(1, true, true, 99));
	let state = (await h.invoke('test.node', []).result).body.body.payload;
	assert.deepEqual(state.changes, [{ parent: true, other: false, enabled: true, scoped: false, language: false, policy: false }]);
	assert.equal(state.current, false);
	assert.equal(state.count, 17);
	assert.equal(state.captured, 'missing', 'configuration objects retain their creation snapshot');
	const workspace = (revision, folders) => ({ type: 'workspace', revision, emit: true, workspaceFolders: folders, workspaceName: folders.length ? 'Changed workspace' : null, workspaceFile: null });
	await event(workspace(2, [{ uri: `${folderURI}/two`, name: 'Two', index: 0 }, { uri: folderURI, name: 'Renamed', index: 1 }]));
	state = (await h.invoke('test.node', []).result).body.body.payload;
	assert.equal(state.retained, true);
	assert.equal(state.index, 1);
	assert.equal(state.name, 'Renamed');
	assert.deepEqual(state.folders[0], { added: [`${folderURI}/two`], removed: [] });
	await event(workspace(3, [{ uri: `${folderURI}/two`, name: 'Two', index: 0 }]));
	state = (await h.invoke('test.node', []).result).body.body.payload;
	assert.deepEqual(state.folders[1].removed, [{ uri: folderURI, name: 'Renamed', index: 1 }]);
	await event(workspace(4, []));
	state = (await h.invoke('test.node', []).result).body.body.payload;
	assert.equal(state.empty, true);
	assert.equal(state.workspaceName, null);
	await h.invoke('test.second', []).result;
	await event(config(3, true, true, 1));
	state = (await h.invoke('test.node', []).result).body.body.payload;
	assert.equal(state.changes.length, 1, 'disposed listeners do not receive later commits');
});


test('command categories and enablement stay separate from menu titles', async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => context.subscriptions.push(v.commands.register('test.node', () => 'ready'));`, 'extension.cjs', ['command'], undefined, {
		manifest: { contributes: { commands: [{ command: 'test.node', title: 'Run', category: 'Acme', enablement: '!scmBusy' }], menus: { 'scm/title': [{ command: 'test.node', group: 'navigation' }] } } }
	});
	const command = h.registrations.find(value => value.command === 'test.node');
	assert.equal(command.title, 'Run');
	assert.equal(command.category, 'Acme');
	assert.equal(command.enablement, '!scmBusy');
	assert.deepEqual(command.menus, [{ menu: 'scm/title', group: 'navigation' }]);
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 'ready');
});

test('terminal link providers preserve callback objects through the real Node host', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); let accepted; let terminal; let latest;
exports.activate = context => {
 context.subscriptions.push(v.window.registerTerminalLinkProvider({
  provideTerminalLinks: async (context, token) => {
   if (terminal && terminal !== context.terminal) throw new Error('Terminal identity changed');
   terminal = context.terminal;
   latest = [terminal.name, await terminal.processId];
   return [{ startIndex: 2, length: 4, tooltip: 'Open issue', issue: context.line.slice(2, 6) }];
  },
  handleTerminalLink: link => { accepted = link.issue; }
 }));
 context.subscriptions.push(v.commands.register('test.node', () => ({ accepted, latest })));
};`, 'extension.cjs', ['terminalLinkProvider', 'command']);
	const registration = h.registrations.find(entry => entry.kind === 'terminalLinkProvider');
	assert.ok(registration);
	const invoke = (operation, payload) => h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, registrationGeneration: registration.registrationGeneration, operation, payload, deadlineUnixMillis: Date.now() + 5000 }).result;
	const result = await invoke('provideTerminalLinks', { line: '  #123 text', terminal: { id: 'terminal-1', name: 'Shell', processId: 42 } });
	assert.equal(result.status, 'success', JSON.stringify(result));
	assert.deepEqual(result.body.body.payload.links.map(({ id, ...link }) => link), [{ startIndex: 2, length: 4, label: 'Open issue' }]);
	await invoke('handleTerminalLink', { id: result.body.body.payload.links[0].id });
	assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload, { accepted: '#123', latest: ['Shell', 42] });
	assert.equal((await invoke('provideTerminalLinks', { line: '  #456', terminal: { id: 'terminal-1', name: 'Renamed', processId: 99 } })).status, 'success');
	assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload, { accepted: '#123', latest: ['Renamed', 99] });
});

test('terminal link acceptance re-resolves a picker handle evicted by later output', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); let accepted;
exports.activate = context => {
 context.subscriptions.push(v.window.registerTerminalLinkProvider({
  provideTerminalLinks: context => Array.from({ length: 256 }, () => ({ startIndex: 0, length: 4, issue: context.line })),
  handleTerminalLink: link => { accepted = link.issue; }
 }));
 context.subscriptions.push(v.commands.register('test.node', () => accepted));
};`, 'extension.cjs', ['terminalLinkProvider', 'command']);
	const registration = h.registrations.find(entry => entry.kind === 'terminalLinkProvider');
	const invoke = (operation, payload) => h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, registrationGeneration: registration.registrationGeneration, operation, payload, deadlineUnixMillis: Date.now() + 5000 }).result;
	const terminal = { id: 'terminal-1', name: 'Shell', processId: 42 };
	const first = await invoke('provideTerminalLinks', { line: '#123', terminal });
	for (let index = 0; index < 9; index++) await invoke('provideTerminalLinks', { line: '#456', terminal });
	const accepted = await invoke('handleTerminalLink', { id: first.body.body.payload.links[0].id, line: '#123', terminal, startIndex: 0, length: 4 });
	assert.equal(accepted.status, 'success', JSON.stringify(accepted));
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, '#123');
});

test('terminal link provider rejects ranges outside the requested line', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
 context.subscriptions.push(v.window.registerTerminalLinkProvider({ provideTerminalLinks: () => [{ startIndex: 0, length: 100 }], handleTerminalLink() {} }));
};`, 'extension.cjs', ['terminalLinkProvider']);
	const registration = h.registrations.find(entry => entry.kind === 'terminalLinkProvider');
	const result = await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'provideTerminalLinks', payload: { line: 'short', terminal: { id: 'terminal-1', name: 'Shell', processId: 42 } }, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal(result.status, 'failure');
});

test('terminal profile provider returns literal shell options through the real Node host', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
 context.subscriptions.push(v.window.registerTerminalProfileProvider('shell', { provideTerminalProfile: token => new v.TerminalProfile({ name: 'Profile shell', shellPath: '/bin/sh', shellArgs: ['-c', 'literal;$HOME'], env: { PROFILE: 'with spaces', REMOVED: null }, cwd: '/workspace' }) }));
};`, 'extension.cjs', ['terminalProfileProvider'], undefined, { manifest: { contributes: { terminal: { profiles: [{ id: 'shell', title: 'Profile shell' }] } } } });
	const registration = h.registrations.find(entry => entry.kind === 'terminalProfileProvider');
	assert.equal(registration.profileId, 'shell');
	assert.equal(registration.title, 'Profile shell');
	const result = await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'createTerminalProfile', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal(result.status, 'success', JSON.stringify(result));
	assert.deepEqual(result.body.body.payload, { options: { name: 'Profile shell', shellPath: '/bin/sh', shellArgs: ['-c', 'literal;$HOME'], env: { PROFILE: 'with spaces', REMOVED: null }, cwd: '/workspace' } });
});

test('terminal profile provider preserves Windows raw shell options through the real Node host', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
 context.subscriptions.push(v.window.registerTerminalProfileProvider('shell', { provideTerminalProfile: token => new v.TerminalProfile({ name: 'Profile shell', shellPath: 'cmd.exe', shellArgs: '/d /s /c \"echo two words & literal;$HOME\"', env: { PROFILE: 'with spaces', REMOVED: null }, cwd: '/workspace' }) }));
};`, 'extension.cjs', ['terminalProfileProvider'], undefined, { manifest: { contributes: { terminal: { profiles: [{ id: 'shell', title: 'Profile shell' }] } } } });
	const registration = h.registrations.find(entry => entry.kind === 'terminalProfileProvider');
	assert.equal(registration.profileId, 'shell');
	assert.equal(registration.title, 'Profile shell');
	const result = await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'createTerminalProfile', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal(result.status, 'success', JSON.stringify(result));
	assert.deepEqual(result.body.body.payload, { options: { name: 'Profile shell', shellPath: 'cmd.exe', shellArgs: '/d /s /c \"echo two words & literal;$HOME\"', env: { PROFILE: 'with spaces', REMOVED: null }, cwd: '/workspace' } });
});

test('terminal profile Pseudoterminal preserves open and input output and releases once', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
 const write = new v.EventEmitter(); let closes = 0; let factory;
 context.subscriptions.push(v.commands.register('test.node', action => { if (action === 'dispose') factory.dispose(); return closes; }));
 context.subscriptions.push(factory = v.window.registerTerminalProfileProvider('pty', { provideTerminalProfile: () => new v.TerminalProfile({ name: 'Profile PTY', pty: { onDidWrite: write.event, open: dimensions => write.fire('open:' + dimensions.columns), handleInput: data => write.fire('input:' + data), close: () => { closes++; } } }) }));
};`, 'extension.cjs', ['terminalProfileProvider', 'command'], undefined, { manifest: { contributes: { terminal: { profiles: [{ id: 'pty', title: 'Profile PTY' }] }, commands: [{ command: 'test.node', title: 'Close count' }] } } });
	const registration = h.registrations.find(entry => entry.kind === 'terminalProfileProvider');
	const created = await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'createTerminalProfile', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal(created.status, 'success', JSON.stringify(created));
	const pty = created.body.body.payload.pty;
	assert.equal(pty.acceptsInput, true);
	assert.equal(typeof pty.registrationId, 'string');
	for (const [registrationId, operation, payload] of [
		[registration.registrationId, 'openTaskTerminal', { ptyId: pty.ptyId }],
		[pty.registrationId, 'createTerminalProfile', {}],
		[pty.registrationId, 'readTaskTerminal', { ptyId: 'another-resource' }],
	]) {
		assert.equal((await h.request('invoke', { extensionId: 'test.node', registrationId, operation, payload, deadlineUnixMillis: Date.now() + 5000 }).result).status, 'failure');
	}

	const opened = await h.request('invoke', { extensionId: 'test.node', registrationId: pty.registrationId, operation: 'openTaskTerminal', payload: { ptyId: pty.ptyId, dimensions: { columns: 80, rows: 24 } }, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.deepEqual(opened.body.body.payload, { events: [{ type: 'data', data: 'open:80' }] });
	const input = await h.request('invoke', { extensionId: 'test.node', registrationId: pty.registrationId, operation: 'inputTaskTerminal', payload: { ptyId: pty.ptyId, data: 'text' }, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.deepEqual(input.body.body.payload, { events: [{ type: 'data', data: 'input:text' }] });
	await h.request('invoke', { extensionId: 'test.node', registrationId: pty.registrationId, operation: 'closeTaskTerminal', payload: { ptyId: pty.ptyId }, deadlineUnixMillis: Date.now() + 5000 }).result;
	const retired = await h.request('invoke', { extensionId: 'test.node', registrationId: pty.registrationId, operation: 'readTaskTerminal', payload: { ptyId: pty.ptyId }, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal(retired.status, 'failure');
	await h.request('invoke', { extensionId: 'test.node', registrationId: pty.registrationId, operation: 'closeTaskTerminal', payload: { ptyId: pty.ptyId }, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 1);
	const replacement = await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'createTerminalProfile', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	const nextPty = replacement.body.body.payload.pty;
	assert.notEqual(nextPty.registrationId, pty.registrationId);
	assert.equal((await h.invoke('test.node', ['dispose']).result).body.body.payload, 1);
	const withdrawn = await h.registrationEvent(4);
	assert.deepEqual(withdrawn.terminalProviders.map(value => value.kind), ['terminalPty']);
	assert.equal((await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'createTerminalProfile', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result).status, 'failure');
	assert.notEqual(nextPty.ptyId, pty.ptyId);
	const reopened = await h.request('invoke', { extensionId: 'test.node', registrationId: nextPty.registrationId, operation: 'openTaskTerminal', payload: { ptyId: nextPty.ptyId, dimensions: { columns: 100, rows: 30 } }, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.deepEqual(reopened.body.body.payload, { events: [{ type: 'data', data: 'open:100' }] });
	await h.request('invoke', { extensionId: 'test.node', registrationId: nextPty.registrationId, operation: 'closeTaskTerminal', payload: { ptyId: nextPty.ptyId }, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 2);
});

test('withdrawn pending profile closes its late PTY without creating a resource lease', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
 let release; let closes = 0; let cancelled = 0;
 const factory = v.window.registerTerminalProfileProvider('pty', { provideTerminalProfile: token => {
  token.onCancellationRequested(() => cancelled++);
  return new Promise(resolve => { release = () => resolve(new v.TerminalProfile({ pty: { onDidWrite: new v.EventEmitter().event, open() {}, close() { closes++; } } })); });
 } });
 context.subscriptions.push(factory, v.commands.register('test.node', action => { if (action === 'dispose') factory.dispose(); if (action === 'release') release(); return { closes, cancelled, pending: !!release }; }));
};`, 'extension.cjs', ['terminalProfileProvider', 'command'], undefined, { manifest: { contributes: { terminal: { profiles: [{ id: 'pty', title: 'PTY' }] }, commands: [{ command: 'test.node', title: 'Control' }] } } });
	const factory = h.registrations.find(value => value.kind === 'terminalProfileProvider');
	const pending = h.request('invoke', { extensionId: 'test.node', registrationId: factory.registrationId, operation: 'createTerminalProfile', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	while (!(await h.invoke('test.node', []).result).body.body.payload.pending) await new Promise(resolve => setImmediate(resolve));
	assert.equal((await h.invoke('test.node', ['dispose']).result).body.body.payload.cancelled, 1);
	assert.deepEqual((await h.registrationEvent(1)).terminalProviders, []);
	await h.invoke('test.node', ['release']).result;
	assert.deepEqual((await pending).body.body.payload, { options: null });
	assert.equal((await h.invoke('test.node', []).result).body.body.payload.closes, 1);
});

test('factory withdrawal during PTY subscription cannot leave an unreturned resource', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
 let closes = 0; let factory;
 factory = v.window.registerTerminalProfileProvider('pty', { provideTerminalProfile: () => new v.TerminalProfile({ pty: {
  onDidWrite() { factory.dispose(); return new v.Disposable(() => {}); }, open() {}, close() { closes++; }
 } }) });
 context.subscriptions.push(factory, v.commands.register('test.node', () => closes));
};`, 'extension.cjs', ['terminalProfileProvider', 'command'], undefined, { manifest: { contributes: { terminal: { profiles: [{ id: 'pty', title: 'PTY' }] }, commands: [{ command: 'test.node', title: 'Closes' }] } } });
	const factory = h.registrations.find(value => value.kind === 'terminalProfileProvider');
	const result = await h.request('invoke', { extensionId: 'test.node', registrationId: factory.registrationId, operation: 'createTerminalProfile', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.deepEqual(result.body.body.payload, { options: null });
	assert.deepEqual((await h.registrationEvent(1)).terminalProviders, []);
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 1);
});

test('terminal profile can inherit the execution host default shell without inventing an executable', async t => {
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => {
 context.subscriptions.push(v.window.registerTerminalProfileProvider('default', { provideTerminalProfile: () => new v.TerminalProfile({ name: 'Default shell', env: { MODE: 'profile value' } }) }));
};`, 'extension.cjs', ['terminalProfileProvider'], undefined, { manifest: { contributes: { terminal: { profiles: [{ id: 'default', title: 'Default shell' }] } } } });
	const registration = h.registrations.find(entry => entry.kind === 'terminalProfileProvider');
	const result = await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'createTerminalProfile', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal(result.status, 'success', JSON.stringify(result));
	assert.deepEqual(result.body.body.payload, { options: { name: 'Default shell', env: { MODE: 'profile value' } } });
});

test('terminal profile and link providers can register after activation and withdraw their original handles', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); let handles = []; let accepted;
exports.activate = context => context.subscriptions.push(v.commands.register('test.node', action => {
 if (action === 'register') {
  handles = [v.window.registerTerminalProfileProvider('shell', { provideTerminalProfile: () => new v.TerminalProfile({ name: 'Live shell', env: { LIVE_PROFILE: 'yes' } }) }),
   v.window.registerTerminalLinkProvider({ provideTerminalLinks: () => [{ startIndex: 0, length: 4, value: 'original' }], handleTerminalLink: link => { accepted = link.value; } })];
  context.subscriptions.push(...handles);
 }
 if (action === 'dispose') for (const handle of handles) handle.dispose();
 return { accepted: accepted ?? null };
}));`, 'extension.cjs', ['terminalProfileProvider', 'terminalLinkProvider', 'command'], undefined, {
		manifest: { contributes: { commands: [{ command: 'test.node', title: 'Node' }], terminal: { profiles: [{ id: 'shell', title: 'Live shell' }] } } },
	});
	assert.equal((await h.invoke('test.node', ['register']).result).status, 'success');
	const first = await h.registrationEvent(2);
	assert.deepEqual(first.terminalProviders.map(value => value.kind), ['terminalProfileProvider', 'terminalLinkProvider']);
	const invoke = (registration, operation, payload) => h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation, payload, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.deepEqual((await invoke(first.terminalProviders[0], 'createTerminalProfile', {})).body.body.payload, { options: { name: 'Live shell', env: { LIVE_PROFILE: 'yes' } } });
	const provided = await invoke(first.terminalProviders[1], 'provideTerminalLinks', { line: 'LINK', terminal: { id: 'one', name: 'Shell', processId: 123 } });
	await invoke(first.terminalProviders[1], 'handleTerminalLink', { id: provided.body.body.payload.links[0].id });
	assert.equal((await h.invoke('test.node', []).result).body.body.payload.accepted, 'original');
	await h.invoke('test.node', ['dispose']).result;
	assert.deepEqual((await h.registrationEvent(4)).terminalProviders, []);
	assert.equal((await invoke(first.terminalProviders[0], 'createTerminalProfile', {})).status, 'failure');
	assert.equal((await invoke(first.terminalProviders[1], 'provideTerminalLinks', { line: 'LINK', terminal: { id: 'one', name: 'Shell', processId: 123 } })).status, 'failure');
	await h.invoke('test.node', ['register']).result;
	const second = await h.registrationEvent(6);
	assert.notEqual(second.terminalProviders[0].registrationId, first.terminalProviders[0].registrationId);
	assert.notEqual(second.terminalProviders[1].registrationId, first.terminalProviders[1].registrationId);
});

test('terminal environment collections expose immutable mutators through an independent admitted callback', async t => {
	const h = await host(t, `const v = require('@ash/sdk');
exports.activate = context => {
 context.environmentVariableCollection.prepend('PATH', '/extension:');
 context.environmentVariableCollection.append('PATH', ':after');
 context.environmentVariableCollection.replace('MODE', 'extension');
 context.environmentVariableCollection.persistent = false;
 context.subscriptions.push(v.window.registerTerminalProfileProvider('shell', { provideTerminalProfile: () => new v.TerminalProfile({ name: 'Environment shell' }) }));
};`, 'extension.cjs', ['terminalProfileProvider'], undefined, { manifest: { contributes: { terminal: { profiles: [{ id: 'shell', title: 'Environment shell' }] } } } });
	const registration = h.registrations.find(entry => entry.kind === 'terminalEnvironment');
	const result = await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'getTerminalEnvironment', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal(result.status, 'success', JSON.stringify(result));
	assert.deepEqual(result.body.body.payload, { persistent: false, map: [['PATH', { variable: 'PATH', value: ':after', type: 2, options: { applyAtProcessCreation: true } }], ['MODE', { variable: 'MODE', value: 'extension', type: 1, options: { applyAtProcessCreation: true } }]], descriptionMap: [] });
});

test('terminal environment collection is independent of registering a profile', async t => {
	const h = await host(t, `exports.activate = context => {
 context.environmentVariableCollection.replace('MODE', 'extension');
 context.environmentVariableCollection.prepend('PATH', '/extension:');
};`, 'extension.cjs', ['terminalProfileProvider']);
	assert.equal(h.registrations.some(entry => entry.kind === 'terminalProfileProvider'), false);
	const registration = h.registrations.find(entry => entry.kind === 'terminalEnvironment');
	const result = await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'getTerminalEnvironment', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal(result.status, 'success', JSON.stringify(result));
	assert.deepEqual(result.body.body.payload, { persistent: true, map: [['MODE', { variable: 'MODE', value: 'extension', type: 1, options: { applyAtProcessCreation: true } }], ['PATH', { variable: 'PATH', value: '/extension:', type: 3, options: { applyAtProcessCreation: true } }]], descriptionMap: [] });
});

test('terminal environment options are validated and captured with their declared phase', async t => {
	const h = await host(t, `exports.activate = context => {
 const options = { applyAtProcessCreation: false, applyAtShellIntegration: true };
 context.environmentVariableCollection.append('STAGE', ':after', options);
 options.applyAtProcessCreation = true;
 if (context.environmentVariableCollection.get('STAGE').options.applyAtProcessCreation) throw new Error('Mutable phase snapshot');
 let rejected = false;
 try { context.environmentVariableCollection.replace('BAD', '', { applyAtShellIntegration: 'yes' }); } catch { rejected = true; }
 if (!rejected) throw new Error('Invalid phase accepted');
};`, 'extension.cjs', ['terminalProfileProvider']);
	const registration = h.registrations.find(entry => entry.kind === 'terminalEnvironment');
	const result = await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'getTerminalEnvironment', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal(result.status, 'success', JSON.stringify(result));
	assert.deepEqual(result.body.body.payload.map[0][1].options, { applyAtProcessCreation: false, applyAtShellIntegration: true });
});

test('terminal environment scoped views retain global entries and serialize folder identity', async t => {
	const h = await host(t, `const v = require('@ash/sdk');
exports.activate = context => {
 const root = context.environmentVariableCollection;
 root.append('PATH', ':global'); root.description = 'global';
 const scoped = root.getScoped({ workspaceFolder: { uri: v.Uri.file('/workspace/a'), name: 'a', index: 0 } });
 scoped.append('PATH', ':folder'); scoped.description = 'folder a';
 if (root.get('PATH').value !== ':global' || [...scoped][0][0] !== 'PATH') throw new Error('Scope view leaked');
 scoped.clear(); scoped.prepend('PATH', 'folder:');
};`, 'extension.cjs', ['terminalProfileProvider']);
	const registration = h.registrations.find(entry => entry.kind === 'terminalEnvironment');
	const result = await h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'getTerminalEnvironment', payload: {}, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal(result.status, 'success', JSON.stringify(result));
	const snapshot = result.body.body.payload;
	assert.deepEqual(snapshot.map[0], ['PATH', { variable: 'PATH', value: ':global', type: 2, options: { applyAtProcessCreation: true } }]);
	assert.equal(snapshot.map[1][1].value, 'folder:');
	assert.deepEqual(snapshot.map[1][1].scope.workspaceFolder, { uri: { scheme: 'file', authority: '', path: '/workspace/a', query: '', fragment: '' }, name: 'a', index: 0 });
	assert.deepEqual(snapshot.descriptionMap.map(entry => entry[1].description), ['global', 'folder a']);
});

test('standard Speech sessions preserve events, tokens, cancellation and registration disposal in Node', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk');
let registration; let cancelled = 0; let detached = 0; const sessions = new Map();
function provide(kind, token, options) {
 const key = options?.language ?? kind; const emitter = new v.EventEmitter();
 const session = { onDidChange(listener) { const handle = emitter.event(listener); return { dispose() { detached++; handle.dispose(); emitter.dispose(); } }; },
 async synthesize(text) { emitter.fire({ status: v.TextToSpeechStatus.Started, text }); emitter.fire({ status: v.TextToSpeechStatus.Stopped }); } };
 let resume; sessions.set(key, { emitter, token });
 token.onCancellationRequested(() => { cancelled++; sessions.delete(key); resume?.(session); });
 return key === 'pending' ? new Promise(resolve => { resume = resolve; }) : session;
}
exports.activate = context => {
 registration = v.speech.registerSpeechProvider('test.recognition', {
  provideSpeechToTextSession: (token, options) => provide('stt', token, options),
  provideTextToSpeechSession: (token, options) => provide('tts', token, options),
  provideKeywordRecognitionSession: token => provide('keyword', token)
 });
 context.subscriptions.push(registration, v.commands.register('test.node', (action, key) => {
  if (action === 'emit') sessions.get(key).emitter.fire({ status: key === 'keyword' ? v.KeywordRecognitionStatus.Recognized : v.SpeechToTextStatus.Recognized, text: '你好' });
  if (action === 'overflow') for (let index = 0; index < 129; index++) sessions.get(key)?.emitter.fire({ status: v.SpeechToTextStatus.Recognized, text: 'phrase' });
  if (action === 'dispose') registration.dispose();
  return { cancelled, detached, sessions: [...sessions.keys()] };
 }));
};`, 'extension.cjs', ['speechProvider', 'command']);
	const registration = h.registrations.find(value => value.kind === 'speechProvider');
	assert.deepEqual(registration, { registrationId: 'ash.speech.1', kind: 'speechProvider', registrationGeneration: 1, identifier: 'test.recognition' });
	const invoke = (operation, payload) => h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, registrationGeneration: registration.registrationGeneration, operation, payload, deadlineUnixMillis: Date.now() + 30000 });
	const ids = ['a1234567-1234-1234-1234-123456789abc', 'b1234567-1234-1234-1234-123456789abc', 'c1234567-1234-1234-1234-123456789abc'];
	for (const [index, kind] of ['speechToText', 'textToSpeech', 'keywordRecognition'].entries()) assert.equal((await invoke('createSpeechSession', { sessionId: ids[index], kind }).result).status, 'success');
	assert.deepEqual((await h.invoke('test.node', ['emit', 'stt']).result).body.body.payload, { cancelled: 0, detached: 0, sessions: ['stt', 'tts', 'keyword'] });
	assert.deepEqual((await invoke('readSpeechSession', { sessionId: ids[0] }).result).body.body.payload, { events: [{ status: 3, text: '你好' }], closed: false });
	assert.equal((await invoke('synthesizeSpeech', { sessionId: ids[1], text: 'hello' }).result).status, 'success');
	assert.deepEqual((await invoke('readSpeechSession', { sessionId: ids[1] }).result).body.body.payload, { events: [{ status: 1, text: 'hello' }, { status: 2 }], closed: false });
	await h.invoke('test.node', ['emit', 'keyword']).result;
	assert.deepEqual((await invoke('readSpeechSession', { sessionId: ids[2] }).result).body.body.payload, { events: [{ status: 1, text: '你好' }], closed: false });
	const pending = invoke('createSpeechSession', { sessionId: 'd1234567-1234-1234-1234-123456789abc', kind: 'speechToText', language: 'pending' });
	assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload.sessions, ['stt', 'tts', 'keyword', 'pending']);
	assert.equal((await h.request('cancel', { targetRequestId: pending.requestId, reason: 'caller' }).result).body.result, 'cancelled');
	assert.equal((await pending.result).status, 'failure');
	assert.deepEqual((await h.invoke('test.node', ['overflow', 'stt']).result).body.body.payload, { cancelled: 2, detached: 1, sessions: ['tts', 'keyword'] });
	assert.equal((await invoke('readSpeechSession', { sessionId: ids[0] }).result).status, 'failure');
	assert.deepEqual((await h.invoke('test.node', ['dispose']).result).body.body.payload, { cancelled: 4, detached: 3, sessions: [] });
	assert.equal((await invoke('readSpeechSession', { sessionId: ids[1] }).result).status, 'failure');
});

test('completed Speech creation keeps a persistent token until its exact session is closed', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk');
let cancelled = 0;
function provide(token) {
 const events = new v.EventEmitter();
 token.onCancellationRequested(() => { cancelled++; events.dispose(); });
 return { onDidChange: events.event, synthesize: async () => {} };
}
exports.activate = context => context.subscriptions.push(
 v.speech.registerSpeechProvider('test.recognition', {
  provideSpeechToTextSession: provide,
  provideTextToSpeechSession: provide,
  provideKeywordRecognitionSession: provide
 }),
 v.commands.register('test.node', () => cancelled)
);`, 'extension.cjs', ['speechProvider', 'command']);
	const registrationId = h.registrations.find(value => value.kind === 'speechProvider').registrationId;
	const invoke = (operation, sessionId) => h.request('invoke', { extensionId: 'test.node', registrationId, registrationGeneration: 1, operation, payload: { sessionId, ...(operation === 'createSpeechSession' ? { kind: 'speechToText' } : {}) }, deadlineUnixMillis: Date.now() + 30000 });
	const first = 'a1234567-1234-1234-1234-123456789abc';
	const second = 'b1234567-1234-1234-1234-123456789abc';
	const created = invoke('createSpeechSession', first);
	assert.equal((await created.result).status, 'success');
	assert.equal((await invoke('createSpeechSession', second).result).status, 'success');
	await h.request('cancel', { targetRequestId: created.requestId, reason: 'caller' }).result;
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 0);
	assert.equal((await invoke('closeSpeechSession', first).result).status, 'success');
	assert.equal((await invoke('closeSpeechSession', first).result).status, 'success');
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 1);
	assert.equal((await invoke('readSpeechSession', first).result).status, 'failure');
	assert.equal((await invoke('readSpeechSession', second).result).status, 'success');
	assert.equal((await invoke('closeSpeechSession', second).result).status, 'success');
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 2);
});


test('Output channels preserve ordered writes, language, log levels and disposal through the real runtime', { timeout: 15000 }, async t => {
	const calls = [];
	const h = await host(t, `const v = require('@ash/sdk');
exports.activate = context => {
 const text = v.window.createOutputChannel('  Source  ', 'typescript');
 const logs = v.window.createOutputChannel('Logs', { log: true });
 const levels = [];
 context.subscriptions.push(logs.onDidChangeLogLevel(level => levels.push(level)));
 text.append('first'); text.appendLine('second'); text.replace('replacement'); text.show(true); text.hide();
 logs.info('ready %s %d', 'agent', 2); logs.error(new Error('failure'));
 context.subscriptions.push(v.commands.register('test.node', () => ({ level: logs.logLevel, levels, off: v.LogLevel.Off })));
 context.subscriptions.push(v.commands.register('test.second', () => { text.dispose(); logs.dispose(); logs.info('ignored'); }));
};`, 'extension.cjs', ['command'], frame => { calls.push(frame.operation.payload); return { result: 'value', value: null }; });
	assert.deepEqual(calls.filter(call => call.channelId === 'output.1').map(call => call.action), ['create', 'append', 'append', 'replace', 'show', 'hide']);
	assert.deepEqual(calls[0], { method: 'output', channelId: 'output.1', action: 'create', label: 'Source', kind: 'output', languageId: 'typescript' });
	assert.equal(calls.find(call => call.action === 'log').text, 'ready agent 2');
	assert.match(calls.filter(call => call.action === 'log')[1].text, /failure/);
	const reply = await h.request('invoke', { extensionId: 'test.node', registrationId: 'ash.output.events', operation: 'outputEvent', payload: { channelId: 'output.2', level: 1 }, deadlineUnixMillis: Date.now() + 30000 }).result;
	assert.equal(reply.status, 'success', h.stderr());
	assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload, { level: 1, levels: [1], off: 0 });
	await h.invoke('test.second', []).result;
	assert.equal(calls.filter(call => call.action === 'dispose').length, 2);
	assert.equal(calls.some(call => call.text === 'ignored'), false);
});

test('fetched task terminal groups survive public edits without entering the public presentation API', { timeout: 15000 }, async t => {
	const snapshot = { id: 'configured', name: 'Configured', source: 'Workspace', scope: 2, definition: { type: 'process' }, execution: { type: 'process', program: 'compiler', args: [] }, presentation: { group: 'build', reveal: 'never' }, options: {}, group: 'build', isBackground: false, problemMatchers: [], detail: null };
	const executions = [];
	const h = await host(t, `const v = require('@ash/sdk'); exports.activate = context => context.subscriptions.push(v.commands.register('test.node', async () => {
 const [task] = await v.tasks.fetchTasks();
 if ('group' in task.presentationOptions) throw Error('Configuration-only group leaked');
 for (let i = 0; i < 2; i++) { task.name = 'Edited ' + i; task.presentationOptions = { panel: v.TaskPanelKind.New }; await v.tasks.executeTask(task); }
 return 'retained';
}));`, 'extension.cjs', ['command'], frame => {
		if (frame.operation.operation === 'fetchTasks') return { result: 'tasks', sequence: 0, executions: [], tasks: [snapshot] };
		assert.equal(frame.operation.operation, 'executeTask');
		executions.push(frame.operation.task);
		return { result: 'taskExecution', sequence: executions.length, execution: { id: `run-${executions.length}`, active: false, task: snapshot } };
	});
	const result = await h.invoke('test.node', []).result;
	assert.equal(result.status, 'success', JSON.stringify(result));
	assert.deepEqual(executions.map(task => task.presentation), [{ panel: 'new', group: 'build' }, { panel: 'new', group: 'build' }]);
});


test('Speech registrations created after activation update the original registry and retire only their own sessions', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk');
let registration, retired, emitter, oldEmitter, cancelled = 0, created = 0;
function install() {
 registration = v.speech.registerSpeechProvider('test.dynamic', {
  provideSpeechToTextSession(token) { created++; emitter = new v.EventEmitter(); token.onCancellationRequested(() => cancelled++); return { onDidChange: emitter.event }; },
  provideTextToSpeechSession() {}, provideKeywordRecognitionSession() {}
 });
}
exports.activate = context => {
 context.subscriptions.push(v.commands.register('test.node', action => {
  if (action === 'retire') { oldEmitter = emitter; retired = registration; registration.dispose(); }
  if (action === 'install') install();
  if (action === 'oldDispose') { retired.dispose(); oldEmitter.fire({ status: 3, text: 'retired event' }); }
  if (action === 'created') return created;
  return cancelled;
 }));
 setTimeout(install, 10);
};`, 'extension.cjs', ['speechProvider', 'command']);
	assert.equal(h.registrations.some(value => value.kind === 'speechProvider'), false);
	const first = await h.registrationEvent(1);
	assert.deepEqual(first.context, { protocolVersion: 1, incarnation: 2, activationGeneration: 3 });
	assert.deepEqual(first.speechProviders, [{ registrationId: 'ash.speech.1', kind: 'speechProvider', registrationGeneration: 1, identifier: 'test.dynamic' }]);
	const sessionId = 'a1234567-1234-1234-1234-123456789abc';
	const speech = (registrationId, operation, payload, registrationGeneration = Number(registrationId.split('.').at(-1))) => h.request('invoke', { extensionId: 'test.node', registrationId, registrationGeneration, operation, payload, deadlineUnixMillis: Date.now() + 5000 }).result;
	assert.equal((await speech('ash.speech.1', 'createSpeechSession', { sessionId, kind: 'speechToText' })).status, 'success');
	assert.equal((await h.invoke('test.node', ['retire']).result).body.body.payload, 1);
	assert.deepEqual((await h.registrationEvent(2)).speechProviders, []);
	await h.invoke('test.node', ['install']).result;
	assert.equal((await h.registrationEvent(3)).speechProviders[0].registrationId, 'ash.speech.2');
	await h.invoke('test.node', ['oldDispose']).result;
	// A queued request carries its selected generation even if delivered after replacement.
	assert.equal((await speech('ash.speech.2', 'createSpeechSession', { sessionId, kind: 'speechToText' }, 1)).status, 'failure');
	assert.equal((await h.request('invoke', { extensionId: 'test.node', registrationId: 'ash.speech.2', operation: 'createSpeechSession', payload: { sessionId, kind: 'speechToText' }, deadlineUnixMillis: Date.now() + 5000 }).result).status, 'failure');
	assert.equal((await h.invoke('test.node', ['created']).result).body.body.payload, 1);
	assert.equal((await speech('ash.speech.1', 'readSpeechSession', { sessionId })).status, 'failure');
	assert.equal((await speech('ash.speech.2', 'createSpeechSession', { sessionId, kind: 'speechToText' })).status, 'success');
	assert.deepEqual((await speech('ash.speech.2', 'readSpeechSession', { sessionId })).body.body.payload, { events: [], closed: false });
	assert.equal((await h.invoke('test.node', []).result).status, 'success');
	await h.request('shutdown').result;
});

test('terminal completion public API preserves context, validates ranges and withdraws live providers', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); let registration; let terminal;
exports.activate = context => {
 registration = v.window.registerTerminalCompletionProvider({
  async provideTerminalCompletions(current, request, token) {
   if (terminal && terminal !== current) throw new Error('Terminal object changed');
   terminal = current;
   if (request.commandLine === 'invalid') return [new v.TerminalCompletionItem('bad', [0, 999])];
   return new v.TerminalCompletionList([new v.TerminalCompletionItem(await current.processId + ':' + current.name + ':' + request.commandLine, [0, request.cursorIndex], v.TerminalCompletionItemKind.Argument)]);
  }
 }, '-');
 context.subscriptions.push(registration, v.commands.register('test.node', () => registration.dispose()));
};`, 'extension.cjs', ['terminalCompletionProvider', 'command']);
	const registration = h.registrations.find(entry => entry.kind === 'terminalCompletionProvider');
	assert.deepEqual(registration, { registrationId: 'ash.terminalCompletions.1', kind: 'terminalCompletionProvider', triggerCharacters: ['-'] });
	const invoke = (commandLine, name = 'Shell') => h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'provideTerminalCompletions', payload: { commandLine, cursorIndex: commandLine.length, terminal: { id: 'terminal-1', name, processId: 42 } }, deadlineUnixMillis: Date.now() + 5000 }).result;
	const first = await invoke('git -');
	assert.equal(first.status, 'success', JSON.stringify(first));
	assert.deepEqual(first.body.body.payload, { items: [{ label: '42:Shell:git -', replacementRange: [0, 5], kind: 4 }] });
	assert.equal((await invoke('git --', 'Renamed')).body.body.payload.items[0].label, '42:Renamed:git --');
	assert.equal((await invoke('invalid')).status, 'failure');
	await h.invoke('test.node', []).result;
	assert.deepEqual((await h.registrationEvent(1)).terminalProviders, []);
	assert.equal((await invoke('git -')).status, 'failure');
});

test('terminal completion cancellation reaches its public cancellation token', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); let cancelled = false;
exports.activate = context => {
 context.subscriptions.push(v.window.registerTerminalCompletionProvider({ provideTerminalCompletions(terminal, request, token) { return new Promise(resolve => token.onCancellationRequested(() => { cancelled = true; resolve([]); })); } }));
 context.subscriptions.push(v.commands.register('test.node', () => cancelled));
};`, 'extension.cjs', ['terminalCompletionProvider', 'command']);
	const registration = h.registrations.find(entry => entry.kind === 'terminalCompletionProvider');
	const pending = h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation: 'provideTerminalCompletions', payload: { commandLine: 'git ', cursorIndex: 4, terminal: { id: 'terminal-1', name: 'Shell', processId: 42 } }, deadlineUnixMillis: Date.now() + 5000 });
	await h.request('cancel', { targetRequestId: pending.requestId, reason: 'caller' }).result;
	assert.deepEqual((await pending.result).body.body.payload, { items: [] });
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, true);
});

test('terminal quick fix selectors run before callbacks and retain opaque command actions', { timeout: 15000 }, async t => {
	const h = await host(t, `const v = require('@ash/sdk'); let calls = 0; let accepted; let fix;
exports.activate = context => {
 fix = v.window.registerTerminalQuickFixProvider('test.fix', { provideTerminalQuickFixes(match, token) {
  calls++;
  if (match.commandLineMatch[1] !== 'bad' || match.outputMatch.regexMatch.groups.option !== 'good') throw new Error('Selector captures lost');
  return [new v.TerminalQuickFixTerminalCommand('tool good', true), new v.TerminalQuickFixOpener(v.Uri.parse('https://example.com/help')), { command: 'test.second', title: 'Explain failure', arguments: ['matched'] }];
 } });
 context.subscriptions.push(fix, v.commands.register('test.second', value => { accepted = value; }), v.commands.register('test.node', action => action === 'dispose' ? fix.dispose() : { calls, accepted }));
};`, 'extension.cjs', ['terminalQuickFixProvider', 'command'], frame => {
		assert.equal(frame.operation.operation, 'executeCommand');
		assert.equal(frame.operation.command, 'test.second');
		assert.deepEqual(frame.operation.arguments, ['matched']);
		return { result: 'command', hasValue: false };
	}, { manifest: { contributes: { commands: [{ command: 'test.node', title: 'Node' }, { command: 'test.second', title: 'Second' }], terminalQuickFixes: [{ id: 'test.fix', commandLineMatcher: '^tool (bad)$', commandExitResult: 'error', outputMatcher: { lineMatcher: 'try (?<option>good)', anchor: 'bottom', offset: 0, length: 2 } }] } } });
	const registration = h.registrations.find(entry => entry.kind === 'terminalQuickFixProvider');
	assert.equal(registration.providerId, 'test.fix');
	const invoke = (operation, payload) => h.request('invoke', { extensionId: 'test.node', registrationId: registration.registrationId, operation, payload, deadlineUnixMillis: Date.now() + 5000 }).result;
	const payload = { phase: 'provide', commandLine: 'tool bad', exitCode: 1, outputLines: ['failed', 'try good'], terminalId: 'terminal-1' };
	assert.deepEqual((await invoke('provideTerminalQuickFixes', { ...payload, phase: 'matcher' })).body.body.payload, { matches: true, outputMatcher: { anchor: 'bottom', offset: 0, length: 2 } });
	assert.deepEqual((await invoke('provideTerminalQuickFixes', { ...payload, exitCode: 0 })).body.body.payload, { fixes: [] });
	const fixes = (await invoke('provideTerminalQuickFixes', payload)).body.body.payload.fixes;
	assert.deepEqual(fixes.slice(0, 2), [{ kind: 'terminalCommand', label: 'tool good', shouldExecute: true }, { kind: 'opener', label: 'https://example.com/help' }]);
	assert.equal((await invoke('handleTerminalQuickFix', { id: fixes[2].id, terminalId: 'other', commandLine: payload.commandLine })).status, 'failure');
	assert.equal((await invoke('handleTerminalQuickFix', { id: fixes[2].id, terminalId: 'terminal-1', commandLine: payload.commandLine })).status, 'success');
	assert.equal(h.clientCalls.length, 1);
	await h.invoke('test.node', ['dispose']).result;
	assert.deepEqual((await h.registrationEvent(1)).terminalProviders, []);
});

for (const legacy of [false, true]) test(`terminal profile declarations normalize ${legacy ? 'legacy' : 'standard'} package shape at the Node boundary`, async t => {
	const profiles = [{ id: 'shell', title: 'Shell' }];
	const h = await host(t, `const v=require('@ash/sdk'); exports.activate=context=>context.subscriptions.push(v.window.registerTerminalProfileProvider('shell',{provideTerminalProfile:()=>new v.TerminalProfile({name:'Shell'})}));`, 'extension.cjs', ['terminalProfileProvider'], undefined, { manifest: { contributes: legacy ? { terminalProfiles: profiles } : { terminal: { profiles } } } });
	const registration = h.registrations.find(value => value.kind === 'terminalProfileProvider');
	assert.equal(registration.profileId, 'shell');
});

test('terminal profile package cannot declare competing standard and legacy owners', async t => {
	const profiles = [{ id: 'shell', title: 'Shell' }];
	const result = await host(t, 'exports.activate=()=>{};', 'extension.cjs', ['terminalProfileProvider'], undefined, { expectActivationFailure: true, manifest: { contributes: { terminal: { profiles }, terminalProfiles: profiles } } });
	assert.equal(result.body.code, 'activationFailed');
});

test('serialized profile replies retain late cancellation only until first resource IO', { timeout: 10000 }, async t => {
	const h = await host(t, `const v=require('@ash/sdk');exports.activate=context=>{let closes=0;context.subscriptions.push(v.commands.register('test.node',()=>closes),v.window.registerTerminalProfileProvider('pty',{provideTerminalProfile:()=>new v.TerminalProfile({pty:{onDidWrite:new v.EventEmitter().event,open(){},close(){closes++}}})}));};`, 'extension.cjs', ['terminalProfileProvider', 'command'], undefined, { manifest: { contributes: { terminal: { profiles: [{ id: 'pty', title: 'PTY' }] }, commands: [{ command: 'test.node', title: 'Closes' }] } } });
	const factory = h.registrations.find(value => value.kind === 'terminalProfileProvider');
	const create = deadline => h.request('invoke', { extensionId: 'test.node', registrationId: factory.registrationId, operation: 'createTerminalProfile', payload: {}, deadlineUnixMillis: deadline ?? Date.now() + 5000 });
	const invoke = (pty, operation) => h.request('invoke', { extensionId: 'test.node', registrationId: pty.registrationId, operation, payload: { ptyId: pty.ptyId, dimensions: { columns: 80, rows: 24 } }, deadlineUnixMillis: Date.now() + 5000 }).result;
	const abandoned = create();
	assert.equal((await abandoned.result).status, 'success');
	await h.request('cancel', { targetRequestId: abandoned.requestId, reason: 'caller' }).result;
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 1);
	const adopted = create(); const pty = (await adopted.result).body.body.payload.pty;
	assert.equal((await invoke(pty, 'openTaskTerminal')).status, 'success');
	await h.request('cancel', { targetRequestId: adopted.requestId, reason: 'caller' }).result;
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 1, 'old create cancellation cannot kill an adopted PTY');
	assert.equal((await invoke(pty, 'readTaskTerminal')).status, 'success');
	await invoke(pty, 'closeTaskTerminal');
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 2);
	const expiring = create(Date.now() + 500); assert.equal((await expiring.result).status, 'success');
	const deadline = Date.now() + 5000;
	while ((await h.invoke('test.node', []).result).body.body.payload !== 3) {
		assert.ok(Date.now() < deadline, 'unused issued resource did not expire');
		await new Promise(resolve => setTimeout(resolve, 10));
	}
});
