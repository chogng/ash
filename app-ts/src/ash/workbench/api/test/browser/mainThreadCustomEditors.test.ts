import assert from 'node:assert/strict';
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
	const extension = await import(`data:text/javascript;base64,${entry}`) as { activate(context: unknown): void };
	const registrations: ExtensionHostRegistration[] = [];
	const handlers = new Map<string, Handler>();
	const commands: unknown[][] = [];
	extension.activate({ language: 'zh-CN',
		register: (registration: ExtensionHostRegistration, handler: Handler) => { registrations.push(registration); handlers.set(registration.registrationId, handler); },
		executeCommand: async (...args: unknown[]) => { commands.push(args); },
	});
	const normalized = normalizeExtensionHostSnapshot({ generation: 1, extensions: [{
		id: 'vscode.markdown-language-features', activationGeneration: 1, incarnation: 1, lifecycle: 'ready',
		version: '1.0.0', packageDigest: `sha256:${'b'.repeat(64)}`, runtimeApiVersion: 1,
		stderr: '', failure: null, registrations, outputEvents: [],
	}] });
	const provider = normalized.extensions[0]!.registrations.find(registration => registration.kind === 'customTextEditor');
	assert.equal(provider?.kind === 'customTextEditor' && provider.displayName, 'Markdown 预览');
	const previewCommand = registrations.find(registration => registration.kind === 'command' && registration.command === 'markdown.showPreview');
	assert.equal(previewCommand?.kind === 'command' && previewCommand.title, '打开预览');
	const signal = new AbortController().signal;
	const result = await handlers.get('vscode.markdown.preview.editor')!('resolveCustomTextEditor', {
		document: { uri: 'untitled:/draft.md', text: '# Unsaved\n\n**bold**\n\n<script>alert(1)</script>', languageId: 'markdown' },
	}, signal) as { html: string };
	assert.match(result.html, /<h1>Unsaved<\/h1>/u);
	assert.match(result.html, /<strong>bold<\/strong>/u);
	assert.doesNotMatch(result.html, /alert\(1\)/u);
	const activeEditor = { resource: URI.file('/notes/draft.md').toJSON(), groupId: 'source-group', editorIndex: 2 };
	for (const command of ['markdown.showPreview', 'markdown.showPreviewToSide', 'markdown.showSource', 'markdown.reopenAsPreview', 'markdown.reopenAsSource']) {
		await handlers.get(command)!('execute', normalizeExtensionHostPayload({ activeEditor }), signal);
	}
	assert.deepEqual(JSON.parse(JSON.stringify(commands)), [
		['_workbench.openWith', activeEditor.resource, 'vscode.markdown.preview.editor', [-1], 'source-group'],
		['_workbench.openWith', activeEditor.resource, 'vscode.markdown.preview.editor', [-2], 'source-group'],
		['_workbench.openWith', activeEditor.resource, 'default', [-1], 'source-group'],
		['reopenActiveEditorWith', 'vscode.markdown.preview.editor', { groupId: 'source-group', editorIndex: 2 }],
		['reopenActiveEditorWith', 'default', { groupId: 'source-group', editorIndex: 2 }],
	]);
});
