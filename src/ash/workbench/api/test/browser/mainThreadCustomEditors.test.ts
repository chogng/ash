import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test, afterEach } from 'mocha';
import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeExtensionHostPayload, normalizeExtensionHostSnapshot } from '../../../../platform/agentHost/browser/extensionHostProtocol.js';
import { type ExtensionHostRegistration, type JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { EditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import { CustomEditorInput } from '../../../contrib/customEditor/browser/customEditorInput.js';
import { CustomEditorInputSerializer } from '../../../contrib/customEditor/browser/customEditorInputFactory.js';
import { EditorInputSerializerRegistry } from '../../../services/editor/common/editorInputSerializer.js';
import { URI } from '../../../../base/common/uri.js';

type Handler = (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

let activeRuntime: { deactivate(): Promise<void>; } | undefined;
let fixtureSequence = 0;
const invocationScope = new AsyncLocalStorage<number>();
const globals = globalThis as unknown as Record<string, unknown>;
let previousGlobals: Map<string, PropertyDescriptor | undefined> | undefined;
afterEach(async () => {
	try { await activeRuntime?.deactivate(); }
	finally {
		activeRuntime = undefined;
		for (const [name, descriptor] of previousGlobals ?? []) {
			if (descriptor) Object.defineProperty(globals, name, descriptor);
			else delete globals[name];
		}
		previousGlobals = undefined;
	}
});

async function loadMarkdown(language: string, documents: readonly unknown[] = [], configuration: unknown = {}, folders: readonly string[] = [], clientRequest: (request: { operation: string; uri?: string; command?: string; arguments?: unknown[]; }) => Promise<unknown> = async () => ({ result: 'done' })) {
	const bundle = JSON.parse(await readFile(resolve(process.cwd(), 'src/ash/platform/extensions/common/generated/browser.json'), 'utf8'));
	const entry = bundle.resources['vscode.markdown-language-features']['src/extension.js'];
	const manifest = JSON.parse(await readFile(resolve(process.cwd(), 'extensions/markdown-language-features/package.json'), 'utf8'));
	const empty = { contents: {}, keys: [], overrides: [] };
	previousGlobals = new Map(['__ashConfiguration', '__ashInitialization', '__ashInvocation', '__ashRequest', '__ashBackgroundRequest'].map(name => [name, Object.getOwnPropertyDescriptor(globals, name)]));
	globals.__ashConfiguration = { extensionId: 'vscode.markdown-language-features', extensionPath: '/', pathSeparator: '/', manifest, commands: manifest.contributes.commands };
	globals.__ashInitialization = { language, workspaceFolders: folders.map((uri, index) => ({ uri, name: 'Workspace', index })), workspaceName: null, workspaceFile: null, configurationValues: configuration, configurationData: { defaults: empty, application: empty, userLocal: empty, userRemote: empty, workspace: empty, policy: empty, folders: [] } };
	globals.__ashInvocation = (required = true) => { const id = invocationScope.getStore(); if (required && id === undefined) throw new Error('No invocation'); return id; };
	globals.__ashRequest = async (_id: number, encoded: string) => JSON.stringify(await clientRequest(JSON.parse(encoded)));
	globals.__ashBackgroundRequest = async (encoded: string) => JSON.stringify(await clientRequest(JSON.parse(encoded)));
	const runtime = await import(`data:text/javascript;base64,${entry}#${++fixtureSequence}`);
	activeRuntime = runtime;
	const registrations = await runtime.activate() as ExtensionHostRegistration[];
	const handlers = new Map<string, Handler>();
	for (const registration of registrations) handlers.set(registration.registrationId, async (operation, payload, signal) => {
		signal.throwIfAborted();
		const id = ++fixtureSequence;
		const cancel = () => runtime.cancel(id);
		signal.addEventListener('abort', cancel, { once: true });
		try { return await invocationScope.run(id, () => runtime.invoke(registration.registrationId, payload, id, operation)); }
		finally { signal.removeEventListener('abort', cancel); }
	});
	const invoke = async (operation: string, payload: JsonValue, signal: AbortSignal): Promise<JsonValue> => {
		const registration = registrations.find(value => value.kind === 'languageProvider' && value.operations.includes(operation as never));
		if (!registration) throw new Error(`Missing provider ${operation}`);
		return handlers.get(registration.registrationId)!(operation, { ...(payload as Record<string, JsonValue>), languageId: 'markdown', context: { kind: 'invoke' } }, signal);
	};
	for (const document of documents) await handlers.get('vscode.documents')!('documentEvent', { type: 'open', document } as JsonValue, new AbortController().signal);
	return { registrations, handlers, invoke };
}

test('custom editor tabs retain source identity and survive working-set serialization independently', () => {
	const source = { resource: URI.file('/notes/draft.md'), languageId: 'markdown', initialText: '# Unsaved' };
	const preview = new CustomEditorInput(source, 'vscode.markdown.preview.editor');
	const group = new EditorGroupModel();
	group.openEditor(source, { pinned: true });
	group.openEditor(preview, { pinned: true });
	assert.deepEqual(group.getEditors(), [source, preview]);
	assert.equal(preview.toUntyped(), source);
	const serializers = new EditorInputSerializerRegistry();
	using registration = serializers.register(new CustomEditorInputSerializer());
	const restored = serializers.deserialize(JSON.parse(JSON.stringify(serializers.serialize(preview))));
	assert.ok(restored instanceof CustomEditorInput);
	assert.deepEqual({ id: restored.editorId, uri: restored.resource.toString(), text: restored.initialText, language: restored.languageId }, {
		id: preview.editorId, uri: source.resource.toString(), text: source.initialText, language: source.languageId,
	});
});

test('packaged Markdown extension activates Chinese labels and renders the supplied unsaved document', async () => {
	const commands: unknown[][] = [];
	const { registrations, handlers } = await loadMarkdown('zh-CN', [], {}, [], async request => { if (request.operation === 'executeCommand') { commands.push([request.command, ...request.arguments!]); return { result: 'command', value: null, hasValue: false }; } return { result: 'done' }; });
	const normalized = normalizeExtensionHostSnapshot({
		generation: 1, extensions: [{
			id: 'vscode.markdown-language-features', activationGeneration: 1, incarnation: 1, lifecycle: 'ready',
			version: '1.0.0', packageDigest: `sha256:${'b'.repeat(64)}`, runtimeApiVersion: 1,
			stderr: '', failure: null, registrations, outputEvents: [],
		}]
	});
	const provider = normalized.extensions[0]!.registrations.find(registration => registration.kind === 'customTextEditor');
	assert.equal(provider?.kind === 'customTextEditor' && provider.displayName, 'Markdown 预览');
	const previewCommand = registrations.find(registration => registration.kind === 'command' && registration.command === 'markdown.showPreview');
	assert.equal(previewCommand?.kind === 'command' && previewCommand.title, '打开预览');
	const signal = new AbortController().signal;
	const result = await handlers.get('vscode.markdown.preview.editor')!('resolveCustomTextEditor', {
		document: { uri: 'untitled:/draft.md', text: '# Unsaved\n\n**bold**\n\n<script>alert(1)</script>', languageId: 'markdown' },
	}, signal) as { html: string; };
	assert.match(result.html, /<h1>Unsaved<\/h1>/u);
	assert.match(result.html, /<strong>bold<\/strong>/u);
	assert.doesNotMatch(result.html, /alert\(1\)/u);
	const activeEditor = { resource: URI.file('/notes/draft.md').toJSON(), groupId: 'source-group', editorIndex: 2 };
	for (const command of ['markdown.showPreview', 'markdown.showPreviewToSide', 'markdown.showSource', 'markdown.reopenAsPreview', 'markdown.reopenAsSource', 'markdown.showRichEditor', 'markdown.reopenAsRichEditor']) {
		await handlers.get(command)!('execute', normalizeExtensionHostPayload({ activeEditor, arguments: [] }), signal);
	}
	assert.deepEqual(JSON.parse(JSON.stringify(commands)), [
		['_workbench.openWith', { scheme: 'file', authority: '', path: '/notes/draft.md', query: '', fragment: '' }, 'vscode.markdown.preview.editor', [-1], 'source-group'],
		['_workbench.openWith', { scheme: 'file', authority: '', path: '/notes/draft.md', query: '', fragment: '' }, 'vscode.markdown.preview.editor', [-2], 'source-group'],
		['_workbench.openWith', { scheme: 'file', authority: '', path: '/notes/draft.md', query: '', fragment: '' }, 'default', [-1], 'source-group'],
		['reopenActiveEditorWith', 'vscode.markdown.preview.editor', { groupId: 'source-group', editorIndex: 2 }],
		['reopenActiveEditorWith', 'default', { groupId: 'source-group', editorIndex: 2 }],
		['_workbench.openWith', { scheme: 'file', authority: '', path: '/notes/draft.md', query: '', fragment: '' }, 'vscode.markdown.editor', [-1], 'source-group'],
		['reopenActiveEditorWith', 'vscode.markdown.editor', { groupId: 'source-group', editorIndex: 2 }],
	]);
});

test('packaged Markdown language service resolves unsaved headings and diagnoses broken links', async () => {
	const text = '# Shared draft\n\n[go](#shared-draft)\n\n[missing](#not-here)';
	const uri = 'untitled:/draft.md';
	let published: { diagnostics: { code: string; message: string; }[]; }[] = [];
	const { invoke } = await loadMarkdown('en', [{ uri, text, version: 7, languageId: 'markdown' }], {}, [], async request => {
		if (request.operation === 'setDiagnostics') published = (request as unknown as { entries: typeof published; }).entries;
		return { result: 'done' };
	});
	const signal = new AbortController().signal;
	const request = { resource: uri, text, version: 7, position: { lineIndex: 2, columnIndex: 9 } };
	const definitions = await invoke('definition', request, signal) as { resource: string; range: unknown; }[];
	assert.deepEqual(definitions, [{ resource: uri, range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 14 } } }]);
	const diagnostics = published[0]!;
	assert.deepEqual(diagnostics.diagnostics.map(value => value.code), ['link.no-such-header-in-own-file']);
	const symbols = await invoke('documentSymbols', request, signal) as { name: string; }[];
	assert.equal(symbols[0]!.name, '# Shared draft');
	const completions = await invoke('completion', { ...request, position: { lineIndex: 2, columnIndex: 7 } }, signal) as { items: { label: string; }[]; };
	assert.ok(completions.items.some(item => item.label === '#shared-draft'));
	const edit = await invoke('rename', { ...request, position: { lineIndex: 0, columnIndex: 5 }, kind: 'edit', newName: 'Changed heading' }, signal) as { entries: { expectedText: string; edits: unknown[]; }[]; };
	assert.equal(edit.entries[0]!.expectedText, text);
	assert.equal(edit.entries[0]!.edits.length, 2);
	const links = await invoke('documentLinks', request, signal) as { target: string; }[];
	assert.ok(links.some(link => URI.parse(link.target).toString(true) === 'untitled:/draft.md#1,1'), JSON.stringify(links));
	assert.ok(links.every(link => !link.target.startsWith('command:')));
	const highlights = await invoke('documentHighlights', request, signal) as { range: unknown; }[];
	assert.equal(highlights.length, 2);
});

test('Markdown workspace edits use dirty documents and localized validation respects configuration', async () => {
	const heading = { uri: 'file:///workspace/heading.md', text: '# Current heading\n\n[broken](#missing)', languageId: 'markdown', version: 7 };
	const referring = { uri: 'file:///workspace/referring.md', text: '[go](./heading.md#current-heading)', languageId: 'markdown', version: 9 };
	let published: { diagnostics: { message: string; }[]; }[] = [];
	const { handlers, invoke } = await loadMarkdown('zh-CN', [heading, referring], { markdown: { validate: { enabled: true } } }, ['file:///workspace'], async request => {
		if (request.operation === 'setDiagnostics') { published = (request as unknown as { entries: typeof published; }).entries; return { result: 'done' }; }
		if (request.operation === 'statResource') return { result: 'resourceStat', fileType: request.uri === 'file:///workspace' ? 2 : 1, size: 0, mtime: 0 };
		if (request.operation === 'readResourceDirectory') return { result: 'resourceDirectory', entries: [['heading.md', 1], ['referring.md', 1]] };
		throw new Error(`Dirty documents must precede disk reads: ${request.uri}`);
	});
	const signal = new AbortController().signal;
	const request = { resource: heading.uri, text: heading.text, version: heading.version, position: { lineIndex: 0, columnIndex: 4 } };
	const references = await invoke('references', { ...request, includeDeclaration: true }, signal) as { resource: string; }[];
	assert.ok(references.some(value => value.resource === referring.uri));
	const renamed = await invoke('rename', { ...request, kind: 'edit', newName: 'New heading' }, signal) as { entries: { resource: string; expectedText: string; }[]; };
	assert.deepEqual(new Map(renamed.entries.map(value => [value.resource, value.expectedText])), new Map([[heading.uri, heading.text], [referring.uri, referring.text]]));
	const fileRename = await invoke('rename', { resource: referring.uri, text: referring.text, version: referring.version, position: { lineIndex: 0, columnIndex: 9 }, kind: 'edit', newName: './moved.md' }, signal);
	assert.deepEqual(fileRename, {
		entries: [
			{ kind: 'textDocument', resource: referring.uri, expectedText: referring.text, edits: [{ range: { start: { lineIndex: 0, columnIndex: 5 }, end: { lineIndex: 0, columnIndex: 33 } }, text: './moved.md#current-heading' }] },
			{ kind: 'rename', source: heading.uri, target: 'file:///workspace/moved.md', existing: 'error' },
		]
	});
	const diagnostics = published[0]!;
	assert.match(diagnostics.diagnostics[0]!.message, /找不到标题/u);
	const empty = { contents: {}, keys: [], overrides: [] };
	await handlers.get('vscode.workspace.events')!('workspaceEvent', { type: 'configuration', revision: 1, emit: true, configurationValues: { markdown: { validate: { enabled: false } } }, configurationData: { defaults: empty, application: empty, userLocal: empty, userRemote: empty, workspace: empty, policy: empty, folders: [] }, change: { keys: ['markdown.validate.enabled'], overrides: [] } }, signal);
	assert.ok(published.every(value => value.diagnostics.length === 0));
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(invoke('references', request, cancelled.signal), error => error instanceof Error && error.name === 'AbortError');
});


test('Markdown reads unopened files for definitions, workspace references and rename edits', async () => {
	const heading = { uri: 'file:///workspace/heading.md', text: '# Current heading', languageId: 'markdown', version: 1 };
	const referring = { uri: 'file:///workspace/referring.md', text: '[go](./heading.md#current-heading)', languageId: 'markdown', version: 7 };
	const reads: string[] = [];
	const { invoke } = await loadMarkdown('en', [referring], {}, ['file:///workspace'], async request => {
		if (request.operation === 'setDiagnostics') return { result: 'done' };
		if (request.operation === 'statResource') return { result: 'resourceStat', fileType: request.uri === 'file:///workspace' ? 2 : 1, size: 0, mtime: 0 };
		if (request.operation === 'readResourceDirectory') return { result: 'resourceDirectory', entries: [['heading.md', 1], ['referring.md', 1]] };
		if (request.operation === 'readDocument' && request.uri === heading.uri) { reads.push(request.uri); return { result: 'document', document: heading }; }
		throw new Error(`Unexpected Markdown request: ${JSON.stringify(request)}`);
	});
	const signal = new AbortController().signal;
	const request = { resource: referring.uri, text: referring.text, version: referring.version, position: { lineIndex: 0, columnIndex: 23 } };
	const definitions = await invoke('definition', request, signal) as { resource: string; }[];
	assert.ok(definitions.some(value => value.resource === heading.uri));
	const references = await invoke('references', { ...request, includeDeclaration: true }, signal) as { resource: string; }[];
	assert.ok(references.some(value => value.resource === heading.uri));
	assert.ok(references.some(value => value.resource === referring.uri));
	const renamed = await invoke('rename', { ...request, kind: 'edit', newName: 'New heading' }, signal) as { entries: { resource: string; expectedText: string; }[]; };
	assert.deepEqual(new Map(renamed.entries.map(value => [value.resource, value.expectedText])), new Map([[heading.uri, heading.text], [referring.uri, referring.text]]));
	assert.ok(reads.length > 0);
	assert.ok(reads.every(uri => uri === heading.uri));
});
