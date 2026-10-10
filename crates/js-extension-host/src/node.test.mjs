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

async function host(t, source, entry = 'extension.cjs', capabilities = ['command'], onClient, fixture = {}) {
	const root = await mkdtemp(join(tmpdir(), 'ash-node-host-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const resources = join(root, 'resources');
	const extension = join(root, 'extension');
	await mkdir(resources);
	await mkdir(extension);
	for (const [from, to] of [['node.mjs', 'node.mjs'], ['vscode.js', 'vscode.mjs']]) {
		await copyFile(new URL(from, import.meta.url), join(resources, to));
	}
	await copyFile(new URL('../../../extension-sdk/index.js', import.meta.url), join(resources, 'sdk.mjs'));
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
	const child = spawn(process.execPath, [join(resources, 'node.mjs'), '--extension-id', 'test.node', '--package', extension, '--entry', entry, '--api', 'vscode', '--protocol-address', `127.0.0.1:${server.address().port}`, '--protocol-token', token], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...fixture.inheritedEnvironment } });
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
	const readers = createInterface({ input: control });
	t.after(() => readers.close());
	assert.equal((await once(readers, 'line'))[0], token);
	readers.on('line', line => {
		const frame = JSON.parse(line);
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
			workspaceFolders: [{ uri: `file://${extension}`, name: 'extension', index: 0 }], workspaceName: 'extension', workspaceFile: null,
			configurationValues: {}, configurationData: { defaults: { contents: {}, keys: [], overrides: [] }, folders: [] },
		}
	}).result;
	assert.equal(activated.body.result, 'activated', stderr);
	return {
		child, control, extension, request, send, clientCalls, registrations: activated.body.body.registrations, stderr: () => stderr, stdout: () => stdout,
		invoke(registrationId, arguments_) { return request('invoke', { extensionId: 'test.node', registrationId, operation: 'execute', payload: { arguments: arguments_ }, deadlineUnixMillis: Date.now() + 30000 }); }
	};
}

test('window environment is applied before module evaluation and inherited by Debug children', { timeout: 15000 }, async t => {
	const source = `const v = require('vscode'); const cp = require('node:child_process');
const keys = ['ASH_NODE_ENV_VALUE', 'ASH_NODE_ENV_REMOVE', 'ASH_NODE_ENV_EMPTY', 'ASH_NODE_ENV_INHERITED', 'OPENAI_API_KEY'];
const snapshot = () => Object.fromEntries(keys.map(key => [key, process.env[key] ?? null]));
const evaluation = snapshot();
exports.activate = context => context.subscriptions.push(v.commands.registerCommand('test.node', () => ({
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
	const h = await host(t, `const v = require('vscode'); const fs = require('node:fs'); const net = require('node:net'); const cp = require('node:child_process');
if (v !== require('vscode')) throw Error('Editor API identity changed');
exports.activate = context => context.subscriptions.push(v.commands.registerCommand('test.node', async () => {
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
	const h = await host(t, `const v = require('vscode'); exports.activate = context => {
setInterval(() => {}, 1000);
context.subscriptions.push(v.commands.registerCommand('test.node', () => 'alive'));
};`);
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 'alive');
	const exit = once(h.child, 'exit');
	h.control.end();
	assert.equal((await exit)[0], 0);
});

test('ESM extension imports the same editor API and real Node builtins', { timeout: 10000 }, async t => {
	const h = await host(t, `import v, { commands } from 'vscode'; import { basename } from 'node:path';
export function activate(context) { if (commands !== v.commands) throw Error('API identity differs'); context.subscriptions.push(commands.registerCommand('test.node', () => basename('/workspace/real-node.js'))); }`, 'extension.mjs');
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 'real-node.js');
});

test('transpiled CommonJS imports can inspect module metadata without changing API identity', { timeout: 10000 }, async t => {
	const h = await host(t, `const raw = require('vscode');
const imported = raw && raw.__esModule ? raw : { ...raw, default: raw };
if (imported.default !== raw || imported.commands !== raw.commands) throw Error('Module identity differs');
if (raw.commands.__esModule !== undefined) throw Error('Namespace metadata differs');
exports.activate = context => context.subscriptions.push(imported.commands.registerCommand('test.node', () => {
    try { raw.missingPublicApi(); } catch (error) { return error.message; }
    throw Error('Unsupported API was silently accepted');
}));`);
	assert.equal((await h.invoke('test.node', []).result).body.body.payload, 'Unsupported VS Code API: vscode.missingPublicApi');
});

test('debug extension tree item subclasses retain public label and resource values', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('vscode');
class BreakpointItem extends v.TreeItem {
    constructor(label) { super(label, v.TreeItemCollapsibleState.Expanded); this.checkboxState = v.TreeItemCheckboxState.Checked; }
}
exports.activate = context => context.subscriptions.push(v.commands.registerCommand('test.node', () => {
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
	const h = await host(t, `const v = require('vscode');
const evaluation = v.l10n.t('Target {0}', 'worker');
exports.activate = context => context.subscriptions.push(v.commands.registerCommand('test.node', () => ({
    language: v.env.language, evaluation, uri: v.l10n.uri.fsPath.endsWith('/l10n/bundle.l10n.zh-cn.json'),
    contents: v.l10n.bundle['Target {0}'], named: v.l10n.t('Ready {name}: {count}', { name: 'worker', count: 0 }),
    comment: v.l10n.t({ message: 'Paused {0}', args: [false], comment: ['debug', ' state'] }),
    fallback: v.l10n.t('Missing {0} {1}', 'first'), inherited: v.l10n.t('toString'),
})));`, 'extension.cjs', ['command'], undefined, {
		language: 'zh-cn', manifest: { l10n: './l10n' }, files: { 'l10n/bundle.l10n.zh-cn.json': JSON.stringify({
			'Target {0}': '目标 {0}', 'Ready {name}: {count}': '就绪 {name}：{count}', 'Paused {0}/debug state': '已暂停 {0}',
		}) },
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
		const h = await host(t, `const v = require('vscode'); exports.activate = context => context.subscriptions.push(v.commands.registerCommand('test.node', () => ({ message: v.l10n.t('Target {0}', 0), bundle: v.l10n.bundle === undefined, uri: v.l10n.uri === undefined })));`, 'extension.cjs', ['command'], undefined, fixture);
		assert.deepEqual((await h.invoke('test.node', []).result).body.body.payload, { message: 'Target 0', bundle: true, uri: true });
	}
});

test('concurrent callbacks retain identity and detached Node work uses the activation fence', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('vscode'); exports.activate = context => {
context.subscriptions.push(v.commands.registerCommand('test.node', async key => { await new Promise(resolve => setTimeout(resolve, key === 'first' ? 15 : 1)); return v.commands.executeCommand('read.identity', key); }));
context.subscriptions.push(v.commands.registerCommand('test.second', async () => { setTimeout(async () => { const result = await v.commands.executeCommand('background'); require('node:fs').writeFileSync(__dirname + '/background.txt', result); }, 25); return 'finished'; }));
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
	const h = await host(t, `const v = require('vscode'); exports.activate = context => {
context.subscriptions.push(v.debug.registerDebugConfigurationProvider('test', {
resolveDebugConfiguration(folder, config, token) { return new Promise(resolve => {
require('node:fs').writeFileSync(__dirname + '/waiting.txt', 'waiting');
token.onCancellationRequested(() => resolve(undefined));
}); }
}));
context.subscriptions.push(v.commands.registerCommand('test.second', () => 'other'));
};`, 'extension.cjs', ['command', 'debugAdapter']);
	const registrationId = h.registrations.find(registration => registration.kind === 'debugConfigurationProvider').registrationId;
	const pending = h.request('invoke', { extensionId: 'test.node', registrationId, operation: 'resolveDebugConfiguration', payload: { configuration: { type: 'test', request: 'launch' } }, deadlineUnixMillis: Date.now() + 30000 });
	while (true) { if (t.signal.aborted) throw new Error('Test aborted'); try { await readFile(join(h.extension, 'waiting.txt')); break; } catch (error) { if (error.code !== 'ENOENT') throw error; await new Promise(resolve => setTimeout(resolve, 2)); } }
	assert.equal((await h.request('cancel', { requestId: pending.requestId }).result).body.result, 'cancelled');
	assert.equal((await h.invoke('test.second', []).result).body.body.payload, 'other');
	assert.deepEqual((await pending.result).body.body.payload, { cancelled: true });
});


test('late service replies after cancellation cannot revive authority or break other callbacks', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('vscode'); exports.activate = context => {
context.subscriptions.push(v.commands.registerCommand('test.node', async () => { try { return await v.commands.executeCommand('waiting'); } catch (error) { return error.code; } }));
context.subscriptions.push(v.commands.registerCommand('test.second', () => 'other'));
};`);
	const pending = h.invoke('test.node', []);
	while (h.clientCalls.length < 1) { if (t.signal.aborted) throw new Error('Test aborted'); await new Promise(resolve => setTimeout(resolve, 2)); }
	const call = h.clientCalls[0];
	await h.request('cancel', { requestId: pending.requestId }).result;
	assert.equal((await pending.result).body.body.payload, 'cancelled');
	h.send({ context: call.context, callId: call.callId, outcome: { Ok: { result: 'command', value: 'late', hasValue: true } } });
	assert.equal((await h.invoke('test.second', []).result).body.body.payload, 'other');
});


test('activation can await editor services before publishing its registrations', { timeout: 10000 }, async t => {
	const calls = [];
	const h = await host(t, `const v = require('vscode'); exports.activate = async context => {
        await v.window.showInformationMessage('Node activation');
        const value = await v.commands.executeCommand('startup.value');
        context.subscriptions.push(v.commands.registerCommand('test.node', () => value));
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


test('shutdown cancels detached service requests without unhandled rejection terminating the protocol', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('vscode'); exports.activate = context => {
        context.subscriptions.push(v.commands.registerCommand('test.node', () => {
            setTimeout(() => { void v.commands.executeCommand('background.wait'); }, 5);
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
	const h = await host(t, `const v = require('vscode'); exports.activate = async context => {
        const results = await Promise.all(Array.from({ length: 64 }, (_, index) => v.commands.executeCommand('startup.value', index)));
        context.subscriptions.push(v.commands.registerCommand('test.node', () => results));
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

test('live window events update synchronous snapshots, preserve folder handles and respect configuration scopes', { timeout: 10000 }, async t => {
	const h = await host(t, `const v = require('vscode');
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
 context.subscriptions.push(v.commands.registerCommand('test.second', () => { for (const listener of listeners) listener.dispose(); }));
 context.subscriptions.push(v.commands.registerCommand('test.node', () => ({changes,folders,current:v.workspace.getConfiguration('sample').get('enabled','missing'),count:v.workspace.getConfiguration('sample').get('count','missing'),captured:captured.get('enabled','missing'),name:original.name,index:original.index,retained:v.workspace.getWorkspaceFolder(v.Uri.joinPath(original.uri,'source.ts'))===original,empty:v.workspace.workspaceFolders===undefined,workspaceName:v.workspace.name??null}))); };`);
	const folderURI = `file://${h.extension}`;
	const empty = () => ({ contents: {}, keys: [], overrides: [] });
	const data = {
		defaults: { contents: { sample: { enabled: true, count: 1 } }, keys: ['sample.enabled', 'sample.count'], overrides: [{ identifiers: ['typescript'], keys: ['sample.enabled'], contents: { sample: { enabled: false } } }] },
		policy: { contents: { sample: { count: 17 } }, keys: ['sample.count'], overrides: [] },
		application: empty(), userLocal: empty(), userRemote: empty(), workspace: empty(),
		folders: [[{ scheme: 'file', path: h.extension }, { contents: { sample: { enabled: true } }, keys: ['sample.enabled'], overrides: [] }]],
	};
	async function event(payload) {
		const reply = await h.request('invoke', { extensionId: 'test.node', registrationId: 'vscode.workspace.events', operation: 'workspaceEvent', payload, deadlineUnixMillis: Date.now() + 30000 }).result;
		assert.equal(reply.status, 'success', h.stderr());
	}
	const config = (revision, emit, enabled, count) => ({ type: 'configuration', revision, emit, configurationValues: { sample: { enabled, count } }, configurationData: data, change: { keys: ['sample.enabled', 'sample.count'], overrides: [] } });
	await event(config(1, false, true, 1));
	await event(config(2, true, false, 0));
	await event(config(1, true, true, 99));
	let state = (await h.invoke('test.node', []).result).body.body.payload;
	assert.deepEqual(state.changes, [{ parent: true, other: false, enabled: true, scoped: false, language: false, policy: false }]);
	assert.equal(state.current, false);
	assert.equal(state.count, 17);
	assert.equal(state.captured, 'missing', 'configuration objects retain their creation snapshot');
	const workspace = (revision, folders) => ({ type: 'workspace', revision, emit: true, workspaceFolders: folders, workspaceName: folders.length ? 'Changed workspace' : null, workspaceFile: null });
	await event(workspace(1, [{ uri: `${folderURI}/two`, name: 'Two', index: 0 }, { uri: folderURI, name: 'Renamed', index: 1 }]));
	state = (await h.invoke('test.node', []).result).body.body.payload;
	assert.equal(state.retained, true);
	assert.equal(state.index, 1);
	assert.equal(state.name, 'Renamed');
	assert.deepEqual(state.folders[0], { added: [`${folderURI}/two`], removed: [] });
	await event(workspace(2, [{ uri: `${folderURI}/two`, name: 'Two', index: 0 }]));
	state = (await h.invoke('test.node', []).result).body.body.payload;
	assert.deepEqual(state.folders[1].removed, [{ uri: folderURI, name: 'Renamed', index: 1 }]);
	await event(workspace(3, []));
	state = (await h.invoke('test.node', []).result).body.body.payload;
	assert.equal(state.empty, true);
	assert.equal(state.workspaceName, null);
	await h.invoke('test.second', []).result;
	await event(config(3, true, true, 1));
	state = (await h.invoke('test.node', []).result).body.body.payload;
	assert.equal(state.changes.length, 1, 'disposed listeners do not receive later commits');
});
