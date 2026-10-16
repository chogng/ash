import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, before, afterEach } from 'mocha';
import { prepareMarkdownExtension, startMarkdownExtension } from '../../../../../../test/fixtures/markdownExtension.js';
import { normalizeExtensionHostPayload, normalizeExtensionHostSnapshot } from '../../../../platform/agentHost/browser/extensionHostProtocol.js';
import { type ExtensionHostRegistration, type JsonValue } from '../../../../platform/agentHost/common/extensionHostApi.js';
import { EditorGroupModel } from '../../../common/editor/editorGroupModel.js';
import { CustomEditorInput } from '../../../contrib/customEditor/browser/customEditorInput.js';
import { CustomEditorInputSerializer } from '../../../contrib/customEditor/browser/customEditorInputFactory.js';
import { EditorInputSerializerRegistry } from '../../../services/editor/common/editorInputSerializer.js';
import { URI } from '../../../../base/common/uri.js';
import { MainThreadCustomEditors } from '../../browser/mainThreadCustomEditors.js';
import { EditorPanes } from '../../../browser/editor.js';
import type { CustomTextEditorProvider } from '../../../contrib/webviewPanel/browser/webviewEditor.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import type { IExtensionApi, ExtensionDescriptor } from '../../../../platform/extensions/common/extensionApi.js';
import type { IExtensionHostApi } from '../../../../platform/agentHost/common/extensionHostApi.js';

test('Rust custom editor resources stay within their enabled package and follow catalog generations', async () => {
	let generation = 1, enabled = true;
	let provider: CustomTextEditorProvider | undefined;
	let path = 'media/view.js';
	const reads: unknown[] = [];
	const packages = {
		list: async () => ({ generation, diagnostics: [], extensions: enabled ? [{ id: 'test.rust', version: '1', sourceKind: 'builtIn' } as ExtensionDescriptor] : [] }),
		resources: { readExtensionResourceBytes: async (request: unknown) => { reads.push(request); return new TextEncoder().encode('/* view */'); } },
	} as unknown as IExtensionApi;
	using adapter = new MainThreadCustomEditors(30000, { createInstance: (_ctor: unknown, value: CustomTextEditorProvider) => { provider = value; return {}; } } as unknown as IInstantiationService, {} as IExtensionHostApi, packages);
	using registration = adapter.registerCustomTextEditorProvider({ kind: 'customTextEditor', registrationId: 'test.rust.editor', viewType: 'test.rust.editor', displayName: 'Test', selectors: ['*.md'], priority: 'option' }, async () => ({ html: '<main></main>', resources: { script: path, style: 'media/view.css' } }), { id: 'test.rust', version: '1' });
	await EditorPanes.getEditorPanes().find(pane => pane.id === 'test.rust.editor')!.create({});
	const document = { uri: 'untitled:/view.md', version: 1, languageId: 'markdown', text: '', readOnly: false };
	const signal = new AbortController().signal;
	await provider!.render(document, signal);
	await provider!.render(document, signal);
	assert.equal(reads.length, 2);
	generation = 2;
	await provider!.render(document, signal);
	assert.equal(reads.length, 4);
	assert.deepEqual(reads[2], { generation: 2, extensionId: 'test.rust', path: 'media/view.js' });
	for (path of ['../other/view.js', '/view.js', 'file:///view.js', 'media\\view.js']) await assert.rejects(provider!.render(document, signal), /own package/);
	path = 'media/view.js'; enabled = false;
	await assert.rejects(provider!.render(document, signal), /unavailable/);
});

type Handler = (operation: string, payload: JsonValue, signal: AbortSignal) => Promise<JsonValue>;

test('rich Markdown and preview consume the shared formula compatibility corpus', async () => {
	const { handlers } = await loadMarkdown('en');
	const corpus = JSON.parse(readFileSync('test/fixtures/markdownMath.json', 'utf8')) as { name: string; markdown: string; formulas: { source: string; display: string; }[]; }[];
	const combined = corpus.filter(entry => entry.formulas.length || ['code and escapes', 'currency and jQuery'].includes(entry.name));
	corpus.push({ name: 'combined compatibility document', markdown: combined.map(entry => entry.markdown).join('\n\n'), formulas: combined.flatMap(entry => entry.formulas) });
	const collect = (value: unknown): { source: string; display: string; }[] => {
		if (!Array.isArray(value)) { return []; }
		if (value[0] === 'math') { return [{ source: value[1], display: value[2] ? 'block' : 'inline' }]; }
		return value.flatMap(collect);
	};
	for (const entry of corpus) {
		const document = { uri: 'untitled:/compatibility.md', version: 1, languageId: 'markdown', text: entry.markdown };
		const signal = new AbortController().signal;
		const rich = await handlers.get('vscode.markdown.editor')!('resolveCustomTextEditor', { document }, signal) as { update: { blocks: unknown[]; }; };
		assert.deepEqual(collect(rich.update.blocks), entry.formulas, entry.name);
		const preview = await handlers.get('vscode.markdown.preview.editor')!('resolveCustomTextEditor', { document }, signal) as { update: { html: string; }; };
		assert.equal((preview.update.html.match(/class="ash-markdown-math"/gu) ?? []).length, entry.formulas.length, entry.name);
		assert.equal((preview.update.html.match(/data-math-display="block"/gu) ?? []).length, entry.formulas.filter(formula => formula.display === 'block').length, entry.name);
	}
});

test('independent Markdown math shares macros across formulas and follows settings and disablement', async () => {
	const { handlers } = await loadMarkdown('en', [], { markdown: { math: { macros: { '\\RR': '\\mathbb{R}' } } } });
	const signal = new AbortController().signal;
	const document = { uri: 'untitled:/math.md', version: 1, languageId: 'markdown', text: '$\\newcommand{\\ashfoo}{x^2}\\ashfoo$\n\n$\\ashfoo+\\RR$\n\n```math\n\\frac{1}{2}\n```\n' };
	const preview = () => handlers.get('vscode.markdown.preview.editor')!('resolveCustomTextEditor', { document }, signal) as Promise<{ update: { html: string; }; }>;
	const initial = await preview();
	assert.equal((initial.update.html.match(/class="katex"/g) ?? []).length, 3);
	assert.doesNotMatch(initial.update.html, /#cc0000|katex-error/);
	const rich = await handlers.get('vscode.markdown.editor')!('resolveCustomTextEditor', { document }, signal);
	assert.match(JSON.stringify(rich), /katex-display/);
	const empty = { contents: {}, keys: [], overrides: [] };
	await handlers.get('vscode.workspace.events')!('workspaceEvent', {
		type: 'configuration', revision: 1, emit: true,
		configurationValues: { markdown: { math: { enabled: false } } },
		configurationData: { defaults: empty, application: empty, userLocal: empty, userRemote: empty, workspace: empty, policy: empty, folders: [] },
		change: { keys: ['markdown.math'], overrides: [] },
	}, signal);
	const disabled = await preview();
	assert.doesNotMatch(disabled.update.html, /class="katex"/);
	assert.match(disabled.update.html, /\\ashfoo/);
	assert.match(disabled.update.html, /<pre><code class="language-math">/);
	await handlers.get('vscode.workspace.events')!('workspaceEvent', {
		type: 'configuration', revision: 2, emit: true, configurationValues: {},
		configurationData: { defaults: empty, application: empty, userLocal: empty, userRemote: empty, workspace: empty, policy: empty, folders: [] },
		change: { keys: ['markdown.math'], overrides: [] },
	}, signal);
	await activeRuntime!.disableMath();
	const unavailable = await preview();
	assert.doesNotMatch(unavailable.update.html, /class="katex"/);
	assert.match(unavailable.update.html, /data-math=/);
	assert.match(unavailable.update.html, /\\frac\{1\}\{2\}/);
});
for (const [language, explanation, limitExplanation] of [['en', 'This formula could not be rendered.', 'This formula exceeds the rendering output limit.'], ['zh-CN', '无法渲染此公式。', '此公式超出渲染输出限制。']]) {
	test(`Markdown math preserves valid siblings and localizes structured diagnostics (${language})`, async () => {
		const { handlers } = await loadMarkdown(language);
		const document = { uri: 'untitled:/diagnostics.md', version: 1, languageId: 'markdown', text: '$x$\n\n$\\ashInvalidCommand$\n\n```math\n' + 'q+'.repeat(4000) + '\n```\n\n$y$' };
		const signal = new AbortController().signal;
		for (const view of ['vscode.markdown.preview.editor', 'vscode.markdown.editor']) {
			const result = await handlers.get(view)!('resolveCustomTextEditor', { document }, signal);
			const encoded = JSON.stringify(result);
			assert.match(encoded, /data-math-diagnostic/);
			assert.match(encoded, /invalidFormula/);
			assert.ok(encoded.includes(explanation));
			assert.ok(encoded.includes(limitExplanation));
			assert.match(encoded, /outputLimit/);
			assert.ok(encoded.includes('<mi>x</mi>') && encoded.includes('<mi>y</mi>'));
			assert.match(encoded, /katex/);
			assert.doesNotMatch(encoded, /katex-error/);
		}
	});
}
let activeRuntime: Awaited<ReturnType<typeof startMarkdownExtension>> | undefined;
before(function () { this.timeout(600000); prepareMarkdownExtension(); });
afterEach(async () => { await activeRuntime?.dispose(); activeRuntime = undefined; });
async function loadMarkdown(language: string, documents: readonly unknown[] = [], configuration: unknown = {}, folders: readonly string[] = [], clientRequest: (request: any) => Promise<any> = async () => ({ result: 'done' })) {
	const runtime = activeRuntime = await startMarkdownExtension(language, documents, configuration, folders, clientRequest);
	const registrations = runtime.registrations as ExtensionHostRegistration[];
	const handlers = new Map<string, Handler>();
	for (const registration of registrations) handlers.set(registration.registrationId, (operation, payload, signal) => runtime.invoke(registration.registrationId, operation, payload, signal));
	const invoke = async (operation: string, payload: JsonValue, signal: AbortSignal): Promise<JsonValue> => {
		const registration = registrations.find(value => value.kind === 'languageProvider' && value.operations.includes(operation as never));
		if (!registration) throw new Error(`Missing provider ${operation}`);
		return runtime.invoke(registration.registrationId, operation, payload, signal);
	};
	for (const document of documents) await handlers.get('vscode.documents')!('documentEvent', { type: 'open', document } as JsonValue, new AbortController().signal);
	return { registrations, handlers, invoke, clientCalls: runtime.clientCalls };
}

function diagnosticEntries<T>(previous: T[], request: any): T[] {
	if (!request.merge) return request.entries;
	const entries = new Map(previous.map(entry => [(entry as { uri: string; }).uri, entry]));
	for (const entry of request.entries) entries.set(entry.uri, entry);
	return [...entries.values()];
}

test('reference destination rename edits the path, rebases moved content and leaves labels intact', async () => {
	const current = { uri: 'file:///workspace/current.md', text: '[go][id]\n\n[id]: ./target.md\n', version: 1, languageId: 'markdown' };
	const target = { ...current, uri: 'file:///workspace/target.md', text: '# Target\n\n[asset](./asset.png)\n' };
	const { invoke } = await loadMarkdown('en', [current, target], {}, [], async request => {
		if (request.operation === 'statResource') return { result: 'resourceStat', fileType: 1, size: 0, mtime: 0 };
		return { result: 'done' };
	});
	const edit = await invoke('rename', { resource: current.uri, text: current.text, version: 1, position: { lineIndex: 2, columnIndex: 12 }, kind: 'edit', newName: './sub/moved.md' }, new AbortController().signal);
	assert.deepEqual(edit, {
		entries: [
			{ kind: 'textDocument', resource: current.uri, expectedText: current.text, edits: [{ range: { start: { lineIndex: 2, columnIndex: 6 }, end: { lineIndex: 2, columnIndex: 17 } }, text: './sub/moved.md' }] },
			{ kind: 'textDocument', resource: target.uri, expectedText: target.text, edits: [{ range: { start: { lineIndex: 2, columnIndex: 8 }, end: { lineIndex: 2, columnIndex: 19 } }, text: '../asset.png' }] },
			{ kind: 'rename', source: target.uri, target: 'file:///workspace/sub/moved.md', existing: 'error' },
		]
	});
});

test('heading links share preview slugs and destination ranges even when titles contain delimiters', async () => {
	const text = '# Cafe\u0301\n\n[go](<#CAFE%CC%81> "title ](bad")\n';
	const uri = 'untitled:/unicode.md';
	const { invoke, handlers } = await loadMarkdown('en', [{ uri, text, version: 1, languageId: 'markdown' }]);
	const signal = new AbortController().signal;
	const request = { resource: uri, text, version: 1 };
	assert.deepEqual(await invoke('diagnostics', request, signal), { diagnostics: [] });
	const links = await invoke('documentLinks', request, signal) as { range: unknown; target: string; }[];
	assert.deepEqual(links[0]!.range, { start: { lineIndex: 2, columnIndex: 6 }, end: { lineIndex: 2, columnIndex: 17 } });
	assert.equal(URI.parse(links[0]!.target).fragment, '1,1');
	const preview = await handlers.get('vscode.markdown.preview.editor')!('resolveCustomTextEditor', { document: { uri, text: '---\ntitle: hidden\n---\n\n' + text + '\n$E=mc^2$', version: 1, languageId: 'markdown' } }, signal) as { editable: boolean; update: { html: string; }; };
	assert.equal(preview.editable, false);
	assert.match(preview.update.html, /id="cafe\u0301"/u);
	assert.doesNotMatch(preview.update.html, /title: hidden/u);
	assert.match(preview.update.html, /class="katex"/u);
	assert.match(preview.update.html, /annotation encoding="application\/x-tex">E=mc\^2/);
});

test('link diagnostics reuse target snapshots without listing unrelated open documents', async () => {
	const target = { uri: 'file:///workspace/target.md', text: '# Target\n', version: 1, languageId: 'markdown' };
	const current = { ...target, uri: 'file:///workspace/current.md', text: '[go](./target.md#TARGET)\n\n'.repeat(1000) };
	const { invoke, clientCalls } = await loadMarkdown('en', [current, target], {}, [], async request => {
		if (request.operation === 'statResource') return { result: 'resourceStat', fileType: 1, size: 0, mtime: 0 };
		return { result: 'done' };
	});
	clientCalls.length = 0;
	assert.deepEqual(await invoke('diagnostics', { resource: current.uri, text: current.text, version: 1 }, new AbortController().signal), { diagnostics: [] });
	assert.equal(clientCalls.filter(operation => operation === 'listDocuments').length, 0);
	assert.equal(clientCalls.filter(operation => operation === 'readDocument').length, 1);
});

test('document diagnostics update dependents, retain unrelated markers and clear a closed document', async () => {
	const documents = [
		{ uri: 'file:///workspace/target.md', text: '# Before\n', version: 1, languageId: 'markdown' },
		{ uri: 'file:///workspace/link.md', text: '[go](./target.md#before)', version: 1, languageId: 'markdown' },
		{ uri: 'file:///workspace/unrelated.md', text: '[broken](#missing)', version: 1, languageId: 'markdown' },
	];
	const publications: any[] = [];
	const { handlers, clientCalls } = await loadMarkdown('en', documents, {}, [], async request => {
		if (request.operation === 'setDiagnostics') publications.push(request);
		return { result: 'done' };
	});
	publications.length = 0;
	documents[0] = { ...documents[0]!, text: '# After\n', version: 2 };
	const signal = new AbortController().signal;
	await handlers.get('vscode.documents')!('documentEvent', { type: 'change', document: documents[0]! }, signal);
	assert.equal(publications[0].merge, true);
	assert.deepEqual(publications[0].entries.map((entry: any) => entry.uri).sort(), documents.slice(0, 2).map(document => document.uri).sort());
	assert.equal(publications[0].entries.find((entry: any) => entry.uri === documents[1]!.uri).diagnostics[0].code, 'link.no-such-header-in-file');
	const closed = documents.pop()!;
	await handlers.get('vscode.documents')!('documentEvent', { type: 'close', document: closed }, signal);
	assert.deepEqual(publications[1].entries, [{ uri: closed.uri, version: null, diagnostics: [] }]);
	const calls = clientCalls.length;
	await handlers.get('vscode.documents')!('documentEvent', { type: 'change', document: { ...closed, languageId: 'plaintext' } }, signal);
	assert.equal(publications.length, 2);
	assert.equal(clientCalls.length, calls, 'unrelated language changes do not fetch Markdown snapshots');
});

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
			id: 'ash.markdown-language-features', activationGeneration: 1, incarnation: 1, lifecycle: 'ready',
			version: '1.0.0', packageDigest: `sha256:${'b'.repeat(64)}`, runtimeApiVersion: 1,
			stderr: '', failure: null, registrations, outputEvents: [],
		}]
	});
	const provider = normalized.extensions[0]!.registrations.find(registration => registration.kind === 'customTextEditor' && registration.viewType === 'vscode.markdown.preview.editor');
	assert.equal(provider?.kind === 'customTextEditor' && provider.displayName, 'Markdown 预览');
	const previewCommand = registrations.find(registration => registration.kind === 'command' && registration.command === 'markdown.showPreview');
	assert.equal(previewCommand?.kind === 'command' && previewCommand.title, '打开预览');
	assert.equal(previewCommand?.kind === 'command' && previewCommand.icon, 'preview');
	const sideCommand = registrations.find(registration => registration.kind === 'command' && registration.command === 'markdown.showPreviewToSide');
	assert.equal(sideCommand?.kind === 'command' && sideCommand.icon, 'open-preview');
	const signal = new AbortController().signal;
	const result = await handlers.get('vscode.markdown.preview.editor')!('resolveCustomTextEditor', {
		document: { uri: 'untitled:/draft.md', text: '# Unsaved\n\n**bold**\n\n<script>alert(1)</script>', languageId: 'markdown', version: 1 },
	}, signal) as { html: string; update: { html: string; }; };
	assert.match(result.update.html, /<h1 id="unsaved" tabindex="-1">Unsaved<\/h1>/u);
	assert.match(result.update.html, /<strong>bold<\/strong>/u);
	assert.doesNotMatch(result.update.html, /alert\(1\)/u);
	const activeEditor = { resource: URI.file('/notes/draft.md').toJSON(), groupId: 'source-group', editorIndex: 2 };
	for (const command of ['markdown.showPreview', 'markdown.showPreviewToSide', 'markdown.showSource', 'markdown.reopenAsPreview', 'markdown.reopenAsSource', 'markdown.showRichEditor', 'markdown.reopenAsRichEditor']) {
		await handlers.get(command)!('execute', normalizeExtensionHostPayload({ activeEditor, arguments: [] }), signal);
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
	const text = '# Shared draft\n\n[go](#shared-draft)\n\n[missing](#not-here)';
	const uri = 'untitled:/draft.md';
	let published: { diagnostics: { code: string; message: string; }[]; }[] = [];
	const { invoke, handlers } = await loadMarkdown('en', [{ uri, text, version: 7, languageId: 'markdown' }], {}, [], async request => {
		if (request.operation === 'setDiagnostics') published = diagnosticEntries(published, request);
		return { result: 'done' };
	});
	const signal = new AbortController().signal;
	const request = { resource: uri, text, version: 7, position: { lineIndex: 2, columnIndex: 9 } };
	const definitions = await invoke('definition', request, signal) as { resource: string; range: unknown; }[];
	assert.deepEqual(definitions, [{ resource: uri, range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 14 } } }]);
	const diagnostics = published[0]!;
	assert.deepEqual(diagnostics.diagnostics.map(value => value.code), ['link.no-such-header-in-own-file']);
	assert.ok(![...handlers.keys()].some(id => /documentSymbols|foldingRanges|selectionRanges/u.test(id)));
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

test('packaged Markdown preferences control completion, highlighting, preview breaks and live diagnostics', async () => {
	const text = '# Heading\n\n[go](#heading)\n\n[missing](#absent)\n\nfirst\nsecond';
	const uri = 'untitled:/settings.md';
	let published: { diagnostics: { severity: string; }[]; }[] = [];
	const { handlers, invoke } = await loadMarkdown('en', [{ uri, text, version: 1, languageId: 'markdown' }], {
		markdown: { suggest: { paths: { enabled: false } }, occurrencesHighlight: { enabled: false }, preview: { breaks: true }, validate: { fragmentLinks: { enabled: 'error' }, fileLinks: { markdownFragmentLinks: 'inherit' } } },
	}, [], async request => {
		if (request.operation === 'setDiagnostics') published = diagnosticEntries(published, request);
		return { result: 'done' };
	});
	const signal = new AbortController().signal;
	const request = { resource: uri, text, version: 1, position: { lineIndex: 2, columnIndex: 7 } };
	assert.equal(published[0]!.diagnostics[0]!.severity, 'error');
	assert.deepEqual(await invoke('completion', request, signal), { items: [], isIncomplete: false });
	assert.deepEqual(await invoke('documentHighlights', request, signal), []);
	const preview = await handlers.get('vscode.markdown.preview.editor')!('resolveCustomTextEditor', { document: { uri, text, version: 1, languageId: 'markdown' } }, signal) as { html: string; update: { html: string; }; };
	assert.match(preview.update.html, /first<br\s*\/?>\s*second/);
	const empty = { contents: {}, keys: [], overrides: [] };
	await handlers.get('vscode.workspace.events')!('workspaceEvent', {
		type: 'configuration', revision: 1, emit: true,
		configurationValues: { markdown: { validate: { fragmentLinks: { enabled: 'ignore' } }, suggest: { paths: { enabled: true } }, occurrencesHighlight: { enabled: true } } },
		configurationData: { defaults: empty, application: empty, userLocal: empty, userRemote: empty, workspace: empty, policy: empty, folders: [] },
		change: { keys: ['markdown'], overrides: [] },
	}, signal);
	assert.ok(published.every(entry => entry.diagnostics.length === 0));
	const completion = await invoke('completion', request, signal) as { items: { label: string; }[]; };
	assert.ok(completion.items.some(item => item.label === '#heading'));
	assert.ok((await invoke('documentHighlights', request, signal) as unknown[]).length > 0);
	const reset = await handlers.get('vscode.markdown.preview.editor')!('resolveCustomTextEditor', { document: { uri, text, version: 1, languageId: 'markdown' } }, signal) as { html: string; update: { html: string; }; };
	assert.match(reset.update.html, /first\nsecond/);
});

test('Markdown workspace edits use dirty documents and localized validation respects configuration', async () => {
	const heading = { uri: 'file:///workspace/heading.md', text: '# Current heading\n\n[broken](#missing)', languageId: 'markdown', version: 7 };
	const referring = { uri: 'file:///workspace/referring.md', text: '[go](./heading.md#current-heading)', languageId: 'markdown', version: 9 };
	let published: { diagnostics: { message: string; }[]; }[] = [];
	const { handlers, invoke } = await loadMarkdown('zh-CN', [heading, referring], { markdown: { validate: { enabled: true } } }, ['file:///workspace'], async request => {
		if (request.operation === 'setDiagnostics') { published = diagnosticEntries(published, request); return { result: 'done' }; }
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

test('large rich documents are delivered once as updates instead of embedded HTML', async () => {
	const text = '\uFEFF# Unembedded source\r\n' + '中文😀 **保真**  \r\n'.repeat(50000);
	const uri = 'file:///synthetic/large.md';
	const { handlers } = await loadMarkdown('zh-CN');
	const result = await handlers.get('vscode.markdown.editor')!('resolveCustomTextEditor', { document: { uri, version: 5, text, languageId: 'markdown' } }, new AbortController().signal) as { html: string; update: { text: string; blocks: unknown[]; }; };
	assert.ok(result.html.length < 10000);
	assert.doesNotMatch(result.html, /Unembedded source/u);
	assert.equal(result.update.text, text);
	assert.ok(result.update.blocks.length > 0);
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

test('Rust Markdown preserves reference spelling and validates unresolved and duplicate definitions', async () => {
	const uri = 'untitled:/references.md';
	const text = '[shown][ID]\n\n[id][] and [id]\n\n[missing][absent]\n\n[ID]: https://example.com\n[id]: https://duplicate.example\n';
	const { invoke } = await loadMarkdown('zh-CN', [{ uri, text, version: 1, languageId: 'markdown' }]);
	const request = { resource: uri, text, version: 1, position: { lineIndex: 0, columnIndex: 9 } };
	const signal = new AbortController().signal;
	const diagnostics = await invoke('diagnostics', request, signal) as { diagnostics: { code: string; message: string; }[]; };
	assert.ok(diagnostics.diagnostics.some(value => value.code === 'link.no-such-reference' && value.message.includes('找不到链接定义')));
	assert.ok(diagnostics.diagnostics.some(value => value.code === 'link.duplicate-definition'));
	const renamed = await invoke('rename', { ...request, kind: 'edit', newName: 'renamed' }, signal) as { entries: { edits: { range: { start: { lineIndex: number; columnIndex: number; }; end: { lineIndex: number; columnIndex: number; }; }; text: string; }[]; }[]; };
	const lines = text.split('\n');
	const offset = (position: { lineIndex: number; columnIndex: number; }) => lines.slice(0, position.lineIndex).reduce((sum, line) => sum + line.length + 1, 0) + position.columnIndex;
	let result = text;
	for (const edit of renamed.entries[0]!.edits.sort((a, b) => offset(b.range.start) - offset(a.range.start))) result = result.slice(0, offset(edit.range.start)) + edit.text + result.slice(offset(edit.range.end));
	assert.equal(result, '[shown][renamed]\n\n[id][renamed] and [id][renamed]\n\n[missing][absent]\n\n[renamed]: https://example.com\n[renamed]: https://duplicate.example\n');
});

test('Rust Markdown completes directory paths and workspace headings through client services', async () => {
	const other = { uri: 'file:///workspace/other.md', version: 2, languageId: 'markdown', text: '# Other heading' };
	const { invoke } = await loadMarkdown('en', [other], { markdown: { preferredMdPathExtensionStyle: 'removeExtension' }, files: { exclude: { '**/excluded': true } } }, ['file:///workspace'], async request => {
		if (request.operation === 'setDiagnostics') return { result: 'done' };
		if (request.operation === 'readResourceDirectory') { assert.equal(request.uri.replace(/\/$/u, ''), 'file:///workspace'); return { result: 'resourceDirectory', entries: [['other.md', 1], ['excluded', 2]] }; }
		throw new Error(`Unexpected client request: ${JSON.stringify(request)}`);
	});
	const signal = new AbortController().signal;
	const request = { resource: 'file:///workspace/current.md', text: '[link](', version: 1, position: { lineIndex: 0, columnIndex: 7 } };
	const paths = await invoke('completion', request, signal) as { items: { insertText: string; }[]; };
	assert.ok(paths.items.some(item => item.insertText === 'other'));
	const headings = await invoke('completion', { ...request, text: '[link](##', position: { lineIndex: 0, columnIndex: 9 } }, signal) as { items: { insertText: string; }[]; };
	assert.ok(headings.items.some(item => item.insertText === 'other.md#other-heading'));
});

test('Rust Markdown cancels an in-flight workspace read and remains usable', async () => {
	let entered!: () => void, release!: () => void;
	const reading = new Promise<void>(resolve => { entered = resolve; });
	const waiting = new Promise<void>(resolve => { release = resolve; });
	const uri = 'file:///workspace/current.md', text = '# Heading';
	const { invoke } = await loadMarkdown('en', [{ uri, text, version: 1, languageId: 'markdown' }], {}, ['file:///workspace'], async request => {
		if (request.operation === 'readResourceDirectory') { entered(); await waiting; return { result: 'resourceDirectory', entries: [] }; }
		return { result: 'done' };
	});
	const controller = new AbortController();
	const pending = invoke('references', { resource: uri, text, version: 1, position: { lineIndex: 0, columnIndex: 4 } }, controller.signal);
	await reading;
	controller.abort();
	await assert.rejects(pending, error => error instanceof Error && error.name === 'AbortError');
	release();
	assert.deepEqual(await invoke('diagnostics', { resource: uri, text, version: 1 }, new AbortController().signal), { diagnostics: [] });
});

test('Rust Markdown extracts link definitions and resolves extensionless targets', async () => {
	const uri = 'file:///workspace/current.md', text = '[link](./other#heading)';
	const other = { uri: 'file:///workspace/other.md', text: '# Heading', version: 1, languageId: 'markdown' };
	const { invoke } = await loadMarkdown('en', [other], {}, [], async request => {
		if (request.operation === 'statResource') throw new Error('Missing extensionless file');
		return { result: 'done' };
	});
	const signal = new AbortController().signal;
	const request = { resource: uri, text, version: 1, position: { lineIndex: 0, columnIndex: 17 } };
	const definitions = await invoke('definition', request, signal) as { resource: string; }[];
	assert.equal(definitions[0]!.resource, other.uri);
	const actions = await invoke('codeAction', { ...request, range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: text.length } }, only: ['refactor.extract'] }, signal) as { kind: string; edit: { entries: { expectedText: string; edits: { text: string; }[]; }[]; }; }[];
	assert.equal(actions[0]!.kind, 'refactor.extract.link');
	assert.equal(actions[0]!.edit.entries[0]!.expectedText, text);
	assert.deepEqual(actions[0]!.edit.entries[0]!.edits.map(edit => edit.text), ['[link][1]', '\n\n[1]: ./other#heading\n']);
});

test('Rust Markdown keeps escaped reference labels on UTF-16 boundaries and remains usable', async () => {
	const uri = 'untitled:/escaped.md';
	const text = '[go][a\\]😀]\n\n[a\\]😀]: https://example.com\n[a\\]😀]: https://duplicate.example\n';
	const { invoke } = await loadMarkdown('en', [{ uri, text, version: 1, languageId: 'markdown' }]);
	const signal = new AbortController().signal;
	const request = { resource: uri, text, version: 1 };
	const diagnostics = await invoke('diagnostics', request, signal) as any;
	assert.deepEqual(diagnostics.diagnostics.map((value: any) => [value.code, value.range]), [
		['link.duplicate-definition', { start: { lineIndex: 3, columnIndex: 1 }, end: { lineIndex: 3, columnIndex: 6 } }],
	]);
	const renamed = await invoke('rename', { ...request, position: { lineIndex: 0, columnIndex: 8 }, kind: 'edit', newName: 'renamed' }, signal) as any;
	assert.deepEqual(renamed.entries[0].edits, [
		{ range: { start: { lineIndex: 0, columnIndex: 5 }, end: { lineIndex: 0, columnIndex: 10 } }, text: 'renamed' },
		{ range: { start: { lineIndex: 2, columnIndex: 1 }, end: { lineIndex: 2, columnIndex: 6 } }, text: 'renamed' },
		{ range: { start: { lineIndex: 3, columnIndex: 1 }, end: { lineIndex: 3, columnIndex: 6 } }, text: 'renamed' },
	]);
	assert.deepEqual(await invoke('diagnostics', { resource: uri, text: '# Still alive', version: 2 }, signal), { diagnostics: [] });
});

test('heading rename preserves links when collision suffixes change on other headings', async () => {
	const uri = 'file:///workspace/headings.md';
	const text = '# Alpha\n\n# Beta\n\n# Alpha\n\n[renamed](#beta) [later](#alpha-1) [first](#alpha)\n';
	const referring = { uri: 'file:///workspace/referring.md', text: '[go](./headings.md#alpha-1)', version: 1, languageId: 'markdown' };
	const { invoke, handlers } = await loadMarkdown('en', [{ uri, text, version: 1, languageId: 'markdown' }, referring]);
	const signal = new AbortController().signal;
	const edit = await invoke('rename', { resource: uri, text, version: 1, position: { lineIndex: 2, columnIndex: 3 }, kind: 'edit', newName: '**Alpha**' }, signal) as any;
	const changed = new Map<string, string>();
	for (const entry of edit.entries) {
		const lines: string[] = entry.expectedText.split('\n');
		const offset = (position: any) => lines.slice(0, position.lineIndex).reduce((total, line) => total + line.length + 1, 0) + position.columnIndex;
		let result: string = entry.expectedText;
		for (const replacement of [...entry.edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) result = result.slice(0, offset(replacement.range.start)) + replacement.text + result.slice(offset(replacement.range.end));
		changed.set(entry.resource, result);
	}
	assert.equal(changed.get(uri), '# Alpha\n\n# **Alpha**\n\n# Alpha\n\n[renamed](#alpha-1) [later](#alpha-2) [first](#alpha)\n');
	assert.equal(changed.get(referring.uri), '[go](./headings.md#alpha-2)');
	const preview = await handlers.get('vscode.markdown.preview.editor')!('resolveCustomTextEditor', { document: { uri, text: changed.get(uri)!, version: 2, languageId: 'markdown' } }, signal) as any;
	assert.deepEqual([...preview.update.html.matchAll(/<h1 id="([^"]+)"/gu)].map(value => value[1]), ['alpha', 'alpha-1', 'alpha-2']);
});

test('root-relative Markdown links use the containing workspace for navigation diagnostics and completion', async () => {
	const current = { uri: 'file:///workspace/nested/docs/current.md', text: '[go](/target.md#heading)', version: 1, languageId: 'markdown' };
	const target = { ...current, uri: 'file:///workspace/nested/target.md', text: '# Heading\n' };
	const { invoke, clientCalls } = await loadMarkdown('en', [current, target], {}, ['file:///workspace', 'file:///workspace/nested'], async request => {
		if (request.operation === 'setDiagnostics') return { result: 'done' };
		if (request.operation === 'readResourceDirectory') {
			assert.equal(request.uri.replace(/\/$/u, ''), 'file:///workspace/nested');
			return { result: 'resourceDirectory', entries: [['target.md', 1]] };
		}
		throw new Error(`Unexpected root-relative request: ${JSON.stringify(request)}`);
	});
	const signal = new AbortController().signal;
	const request = { resource: current.uri, text: current.text, version: 1 };
	assert.deepEqual(await invoke('diagnostics', request, signal), { diagnostics: [] });
	assert.deepEqual(await invoke('definition', { ...request, position: { lineIndex: 0, columnIndex: 10 } }, signal), [
		{ resource: target.uri, range: { start: { lineIndex: 0, columnIndex: 0 }, end: { lineIndex: 0, columnIndex: 9 } } },
	]);
	const links = await invoke('documentLinks', request, signal) as any[];
	assert.equal(URI.parse(links[0]!.target).toString(true), `${target.uri}#1,1`);
	const completion = await invoke('completion', { ...request, text: '[go](/tar', position: { lineIndex: 0, columnIndex: 9 } }, signal) as any;
	assert.ok(completion.items.some((item: any) => item.insertText === '/target.md'));
	assert.ok(!clientCalls.includes('statResource'));
});

test('Markdown changes inspect only the changed document and indexed dependents after initialization', async () => {
	const documents = [
		{ uri: 'file:///workspace/target.md', text: '# Before\n', version: 1, languageId: 'markdown' },
		{ uri: 'file:///workspace/link.md', text: '[go](./target#before)', version: 1, languageId: 'markdown' },
		{ uri: 'file:///workspace/unrelated.md', text: '# Unrelated', version: 1, languageId: 'markdown' },
	];
	const reads: string[] = [], publications: any[] = [];
	const { invoke, handlers, clientCalls } = await loadMarkdown('en', documents, {}, [], async request => {
		if (request.operation === 'setDiagnostics') { publications.push(request); return { result: 'done' }; }
		if (request.operation === 'statResource') throw new Error('Extensionless target does not exist');
		if (request.operation === 'readDocument') { reads.push(request.uri); throw new Error('No such document'); }
		throw new Error(`Unexpected incremental request: ${JSON.stringify(request)}`);
	});
	clientCalls.length = reads.length = publications.length = 0;
	documents[0] = { ...documents[0]!, text: '# After\n', version: 2 };
	const signal = new AbortController().signal;
	await handlers.get('vscode.documents')!('documentEvent', { type: 'change', document: documents[0]! }, signal);
	assert.equal(clientCalls.filter(value => value === 'listDocuments').length, 0);
	assert.equal(clientCalls.filter(value => value === 'readDocument').length, 1, 'read only the dependent snapshot');
	assert.deepEqual(reads, []);
	assert.deepEqual(publications[0].entries.map((entry: any) => entry.uri).sort(), documents.slice(0, 2).map(document => document.uri).sort());
	assert.equal(publications[0].entries[0].uri === documents[0]!.uri ? publications[0].entries[1].diagnostics[0].code : publications[0].entries[0].diagnostics[0].code, 'link.no-such-header-in-file');
	// Equal URI/version values are insufficient for cache reuse after a model is reopened.
	assert.deepEqual(await invoke('diagnostics', { resource: documents[0]!.uri, version: 2, text: '# Different\n\n[go](#different)' }, signal), { diagnostics: [] });
});

test('an interrupted Markdown diagnostic publication rebuilds dependencies from current client snapshots', async () => {
	const documents = [
		{ uri: 'file:///workspace/target.md', text: '# Before', version: 1, languageId: 'markdown' },
		{ uri: 'file:///workspace/link.md', text: '[go](./target.md#before)', version: 1, languageId: 'markdown' },
	];
	let failPublication = false;
	const publications: any[] = [];
	const { handlers, clientCalls } = await loadMarkdown('en', documents, {}, [], async request => {
		if (request.operation === 'setDiagnostics') {
			if (failPublication) { failPublication = false; throw new Error('Deliberate publication failure'); }
			publications.push(request);
			return { result: 'done' };
		}
		throw new Error(`Unexpected diagnostic recovery request: ${JSON.stringify(request)}`);
	});
	const signal = new AbortController().signal;
	documents[0] = { ...documents[0]!, text: '# After', version: 2 };
	failPublication = true;
	await assert.rejects(handlers.get('vscode.documents')!('documentEvent', { type: 'change', document: documents[0]! }, signal), /Deliberate publication failure/u);
	clientCalls.length = publications.length = 0;
	documents[0] = { ...documents[0]!, text: '# Final', version: 3 };
	await handlers.get('vscode.documents')!('documentEvent', { type: 'change', document: documents[0]! }, signal);
	assert.equal(clientCalls.filter(value => value === 'listDocuments').length, 1);
	assert.equal(publications[0].merge, undefined);
	assert.deepEqual(publications[0].entries.map((entry: any) => [entry.uri, entry.version]), documents.slice().reverse().map(document => [document.uri, document.version]));
	assert.equal(publications[0].entries[0].diagnostics[0].code, 'link.no-such-header-in-file');
});
