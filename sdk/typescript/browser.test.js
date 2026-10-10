import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commands, defineBrowserExtension, languages, window } from './browser.js';

test('browser authors use the shared SDK lifecycle through scoped window services', async t => {
	const handlers = new Map();
	const descriptors = [];
	const released = [];
	const requests = [];
	let retained;
	let observed;
	let resource;
	let command;
	let started;
	let blocked = false;
	const document = { uri: 'file:///readme.md', languageId: 'markdown', version: 3, text: '# unsaved' };
	const extension = defineBrowserExtension(context => {
		assert.deepEqual([context.extensionId, context.language], ['example.markdown', 'zh-CN']);
		resource = window.createWebviewResource('main {}', 'text/css');
		command = commands.registerCommand('example.read', 'Read document', async call => {
			retained = call;
			const open = await call.workspace.openTextDocument(document.uri);
			return { text: open.getText(), folders: await call.workspace.getWorkspaceFolders(), configuration: await call.workspace.getConfiguration('markdown', open.uri), stat: await call.workspace.stat(open.uri), entries: await call.workspace.readDirectory('file:///'), editor: call.activeEditor?.resource.toString() ?? null, executed: await call.commands.executeCommand('example.action', open.uri) };
		}, { icon: 'preview', menus: [{ menu: 'editor/title', group: 'navigation' }] });
		context.subscriptions.push(command);
		context.subscriptions.push(languages.registerLanguageProvider('example.language', ['markdown'], {
			operations: ['definition', 'foldingRanges', 'rename'],
			async provideLanguageFeatures(call, request) {
				observed = request;
				if (blocked) await call.workspace.openTextDocument(document.uri);
				if (request.operation === 'foldingRanges') return [{ startLine: 0, endLine: 2 }];
				if (request.operation === 'rename') return { entries: [{ kind: 'rename', source: 'file:///old.md', target: 'file:///new.md', existing: 'error' }, { kind: 'textDocument', resource: document.uri, expectedText: document.text, edits: [{ range: { start: { line: 0, character: 2 }, end: { line: 0, character: 9 } }, text: 'new' }] }] };
				return [{ resource: document.uri, range: { start: { line: 0, character: 2 }, end: { line: 0, character: 9 } } }];
			},
		}));
		context.subscriptions.push(window.registerCustomTextEditorProvider('example.preview', {
			resolveCustomTextEditor(_call, snapshot) { return { html: snapshot.text, resources: { style: resource.uri, script: 'blob:script' }, update: { type: 'document', ...snapshot } }; },
		}, { displayName: 'Preview', priority: 'option', selectors: ['*.md'] }));
		assert.throws(() => commands.registerCommand('example.read', 'Duplicate', () => null), /Duplicate registration/);
		assert.throws(() => languages.registerLanguageProvider('invalid', ['markdown'], { operations: ['arbitraryRpc'], provideLanguageFeatures() {} }), /Invalid language provider operations/);
	});
	const bridge = {
		apiVersion: 1, extensionId: 'example.markdown', language: 'zh-CN',
		createWebviewResource() { return 'blob:style'; },
		releaseWebviewResource(uri) { released.push(uri); },
		register(descriptor, handler) { descriptors.push(descriptor); handlers.set(descriptor.registrationId, handler); },
		async clientRequest(request, signal) {
			requests.push(request);
			if (blocked) {
				started();
				return await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
			}
			if (request.operation === 'readDocument') return { result: 'document', document };
			if (request.operation === 'workspaceFolders') return [];
			if (request.operation === 'readConfiguration') return { result: 'configuration', value: { validate: { enabled: false } } };
			if (request.operation === 'stat') return null;
			if (request.operation === 'readDirectory') return [];
			if (request.operation === 'executeCommand') return 'executed';
			throw new Error(`Unexpected request ${request.operation}`);
		},
	};
	await assert.rejects(extension.activate({ ...bridge, apiVersion: 2 }), { code: 'incompatibleApi' });
	await extension.activate(bridge);
	const invoke = (id, operation, payload, signal = new AbortController().signal) => handlers.get(id)(operation, payload, signal);
	try {
		await t.test('registrations publish only descriptors and keep command menus', () => {
			assert.deepEqual(descriptors.map(value => [value.kind, value.registrationId, value.invokePayload, value.callback]), [['command', 'example.read', undefined, undefined], ['languageProvider', 'example.language', undefined, undefined], ['customTextEditor', 'example.preview', undefined, undefined]]);
			assert.deepEqual(descriptors[0].menus, [{ menu: 'editor/title', group: 'navigation' }]);
			assert.throws(() => commands.registerCommand('late', 'Late', () => null), /during activation/);
		});
		await t.test('offline commands use unsaved snapshots and originating editors', async () => {
			assert.deepEqual(await invoke('example.read', 'execute', { arguments: [], activeEditor: { resource: { scheme: 'file', path: '/readme.md' }, groupId: 'second', editorIndex: 4 } }), { text: '# unsaved', folders: [], configuration: { validate: { enabled: false } }, stat: null, entries: [], editor: 'file:///readme.md', executed: 'executed' });
			await assert.rejects(retained.workspace.openTextDocument(document.uri), { code: 'cancelled' });
			assert.equal(requests.length, 6);
		});
		await t.test('language positions and ordered workspace edits cross the adapter', async () => {
			const payload = { resource: document.uri, languageId: document.languageId, version: document.version, text: document.text, position: { lineIndex: 0, columnIndex: 2 } };
			assert.deepEqual(await invoke('example.language', 'definition', payload), [{ resource: document.uri, range: { start: { lineIndex: 0, columnIndex: 2 }, end: { lineIndex: 0, columnIndex: 9 } } }]);
			assert.deepEqual([observed.operation, observed.position, observed.document.getText()], ['definition', { line: 0, character: 2 }, '# unsaved']);
			assert.deepEqual(await invoke('example.language', 'foldingRanges', payload), [{ startLineIndex: 0, endLineIndex: 2 }]);
			assert.deepEqual((await invoke('example.language', 'rename', { ...payload, kind: 'edit', newName: 'new' })).entries, [{ kind: 'rename', source: 'file:///old.md', target: 'file:///new.md', existing: 'error' }, { kind: 'textDocument', resource: document.uri, expectedText: document.text, edits: [{ range: { start: { lineIndex: 0, columnIndex: 2 }, end: { lineIndex: 0, columnIndex: 9 } }, text: 'new' }] }]);
			await assert.rejects(invoke('example.language', 'arbitraryRpc', payload), /does not match its registration/);
		});
		await t.test('custom editors borrow versioned readonly state', async () => {
			const snapshot = { ...document, readOnly: true };
			assert.deepEqual(await invoke('example.preview', 'resolveCustomTextEditor', { document: snapshot }), { html: document.text, resources: { style: 'blob:style', script: 'blob:script' }, update: { type: 'document', ...snapshot } });
		});
		await t.test('caller cancellation interrupts child requests without stopping other contributions', async () => {
			blocked = true;
			const ready = new Promise(resolve => { started = resolve; });
			const controller = new AbortController();
			const call = invoke('example.read', 'execute', { arguments: [] }, controller.signal);
			await ready;
			controller.abort();
			await assert.rejects(call);
			blocked = false;
			assert.equal((await invoke('example.preview', 'resolveCustomTextEditor', { document: { ...document, readOnly: false } })).html, document.text);
		});
		await t.test('disposal revokes registrations and releases each resource once', async () => {
			command.dispose();
			await assert.rejects(invoke('example.read', 'execute', { arguments: [] }), /is disposed/);
			resource.dispose();
			resource.dispose();
			blocked = true;
			const ready = new Promise(resolve => { started = resolve; });
			const pending = invoke('example.language', 'definition', { resource: document.uri, languageId: 'markdown', version: 3, text: document.text, position: { lineIndex: 0, columnIndex: 2 } });
			const cancelled = assert.rejects(pending);
			await ready;
			await extension.deactivate();
			await cancelled;
			assert.deepEqual(released, ['blob:style']);
		});
	} finally {
		await extension.deactivate();
	}
});
