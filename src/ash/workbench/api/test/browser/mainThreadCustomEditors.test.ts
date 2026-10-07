import assert from 'node:assert/strict';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'mocha';
import { normalizeExtensionHostPayload, normalizeExtensionHostSnapshot, type ExtensionHostRegistration, type JsonValue } from '../../../../platform/extensionHost/common/extensionHostApi.js';
import { EditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import { CustomEditorInput } from '../../../contrib/customEditor/browser/customEditorInput.js';
import { CustomEditorInputSerializer } from '../../../contrib/customEditor/browser/customEditorInputFactory.js';
import { EditorInputSerializerRegistry } from '../../../services/editor/common/editorInputSerializer.js';
import { URI } from '../../../../base/common/uri.js';

type Handler = (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

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
	const bundle = JSON.parse(await readFile(resolve(process.cwd(), 'src/ash/platform/extensions/common/generated/browser.json'), 'utf8'));
	const entry = bundle.resources['vscode.markdown-language-features']['src/extension.js'];
	const extension = await import(`data:text/javascript;base64,${entry}`) as { activate(context: unknown): Promise<void>; };
	const registrations: ExtensionHostRegistration[] = [];
	using resources = new DisposableStore();
	const handlers = new Map<string, Handler>();
	const commands: unknown[][] = [];
	await extension.activate({
		language: 'zh-CN',
		createWebviewResource: (content: string, mediaType: string) => {
			const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
			resources.add(toDisposable(() => URL.revokeObjectURL(url)));
			return url;
		},
		register: (registration: ExtensionHostRegistration, handler: Handler) => { registrations.push(registration); handlers.set(registration.registrationId, handler); },
		executeCommand: async (...args: unknown[]) => { commands.push(args); },
	});
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
		await handlers.get(command)!('execute', normalizeExtensionHostPayload({ activeEditor }), signal);
	}
	assert.deepEqual(JSON.parse(JSON.stringify(commands)), [
		['_workbench.openWith', activeEditor.resource, 'vscode.markdown.preview.editor', [-1], 'source-group'],
		['_workbench.openWith', activeEditor.resource, 'vscode.markdown.preview.editor', [-2], 'source-group'],
		['_workbench.openWith', activeEditor.resource, 'default', [-1], 'source-group'],
		['reopenActiveEditorWith', 'vscode.markdown.preview.editor', { groupId: 'source-group', editorIndex: 2 }],
		['reopenActiveEditorWith', 'default', { groupId: 'source-group', editorIndex: 2 }],
		['_workbench.openWith', activeEditor.resource, 'vscode.markdown.editor', [-1], 'source-group'],
		['reopenActiveEditorWith', 'vscode.markdown.editor', { groupId: 'source-group', editorIndex: 2 }],
	]);
});

test('packaged Markdown language service resolves unsaved headings and diagnoses broken links', async () => {
	const bundle = JSON.parse(await readFile(resolve(process.cwd(), 'src/ash/platform/extensions/common/generated/browser.json'), 'utf8'));
	const extension = await import(`data:text/javascript;base64,${bundle.resources['vscode.markdown-language-features']['src/extension.js']}`);
	using resources = new DisposableStore();
	const handlers = new Map<string, Handler>();
	const text = '# Shared draft\n\n[go](#shared-draft)\n\n[missing](#not-here)';
	const uri = 'untitled:/draft.md';
	await extension.activate({
		createWebviewResource: (content: string, mediaType: string) => {
			const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
			resources.add(toDisposable(() => URL.revokeObjectURL(url)));
			return url;
		}, language: 'en', register: (registration: ExtensionHostRegistration, handler: Handler) => handlers.set(registration.registrationId, handler), clientRequest: async (request: { operation: string; }) => {
			if (request.operation === 'readConfiguration') return { value: null };
			if (request.operation === 'workspaceFolders') return [];
			if (request.operation === 'stat') return { isDirectory: false };
			if (request.operation === 'readDirectory') return [];
			if (request.operation === 'listDocuments') return { documents: [{ uri, text, version: 7, languageId: 'markdown' }] };
			throw new Error(`Unexpected request: ${request.operation}`);
		}
	});
	const invoke = handlers.get('markdown.languageFeatures')!;
	const signal = new AbortController().signal;
	const request = { resource: uri, text, version: 7, position: { lineIndex: 2, columnIndex: 9 } };
	const definitions = await invoke('definition', request, signal) as { resource: string; range: unknown; }[];
	assert.deepEqual(definitions, [{ resource: uri, range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 14 } } }]);
	const diagnostics = await invoke('diagnostics', request, signal) as { diagnostics: { code: string; message: string; }[]; };
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
	const bundle = JSON.parse(await readFile(resolve(process.cwd(), 'src/ash/platform/extensions/common/generated/browser.json'), 'utf8'));
	const extension = await import(`data:text/javascript;base64,${bundle.resources['vscode.markdown-language-features']['src/extension.js']}`);
	using resources = new DisposableStore();
	const handlers = new Map<string, Handler>();
	const heading = { uri: 'file:///workspace/heading.md', text: '# Current heading\n\n[broken](#missing)', languageId: 'markdown', version: 7 };
	const referring = { uri: 'file:///workspace/referring.md', text: '[go](./heading.md#current-heading)', languageId: 'markdown', version: 9 };
	let validationEnabled = true;
	await extension.activate({
		language: 'zh-CN',
		createWebviewResource: (content: string, mediaType: string) => {
			const url = URL.createObjectURL(new Blob([content], { type: mediaType }));
			resources.add(toDisposable(() => URL.revokeObjectURL(url)));
			return url;
		},
		register: (registration: ExtensionHostRegistration, handler: Handler) => handlers.set(registration.registrationId, handler),
		clientRequest: async (request: { operation: string; section?: string; resource?: string; uri?: string; }) => {
			switch (request.operation) {
				case 'listDocuments': return { documents: [heading, referring] };
				case 'workspaceFolders': return ['file:///workspace'];
				case 'readConfiguration': return { value: request.section === 'markdown' ? { validate: { enabled: validationEnabled } } : {} };
				case 'stat': return { isDirectory: request.resource === 'file:///workspace' };
				case 'readDirectory': return [['heading.md', { isDirectory: false }], ['referring.md', { isDirectory: false }]];
				case 'readDocument': throw new Error(`Dirty documents must precede disk reads: ${request.uri}`);
				default: throw new Error(`Unexpected request: ${request.operation}`);
			}
		},
	});
	const invoke = handlers.get('markdown.languageFeatures')!;
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
	const diagnostics = await invoke('diagnostics', request, signal) as { diagnostics: { message: string; }[]; };
	assert.match(diagnostics.diagnostics[0]!.message, /找不到标题/u);
	validationEnabled = false;
	assert.deepEqual(await invoke('diagnostics', request, signal), { diagnostics: [] });
	const cancelled = new AbortController();
	cancelled.abort();
	await assert.rejects(invoke('diagnostics', request, cancelled.signal), error => error instanceof Error && error.name === 'AbortError');
});
