import { ChatAttachmentModel } from '../../browser/attachments/chatAttachmentModel.js';
import { SCMHistoryItemUri } from '../../../scm/common/history.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import assert from 'node:assert/strict';
import { setup, teardown, test, suite, suiteSetup, suiteTeardown } from 'mocha';
import { JSDOM } from 'jsdom';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const browserEnvironment = new JSDOM('<!doctype html><body></body>');
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	InputEvent: browserEnvironment.window.InputEvent,
	KeyboardEvent: browserEnvironment.window.KeyboardEvent,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}

const { createCodeEditorServices } = await import('../../../../../editor/test/browser/testCodeEditor.js');
const { ChatInputEditor } = await import('../../browser/widget/input/chatInputEditor.js');
await import('../../browser/chat.shared.contribution.js');
const { ChatInputConfiguration } = await import('../../common/constants.js');
const { IConfigurationService } = await import('../../../../../platform/configuration/common/configuration.js');
const { createChatCommandCompletionProvider, createChatSkillCompletionProvider } =
	await import('../../browser/widget/input/editor/chatInputCompletions.js');
const { DesktopSlashCommands, SlashCommandCatalog } = await import('../../common/slashCommands.js');
const { SkillSelectorCatalog } = await import('../../common/skillSelectors.js');
const { Position } = await import('../../../../../editor/common/core/position.js');
const { PositionAffinity } = await import('../../../../../editor/common/model.js');
const { EndOfLineSequence } = await import('../../../../../editor/common/model.js');
const { EditorOption } = await import('../../../../../editor/common/config/editorOptions.js');
const { FontMeasurements } = await import('../../../../../editor/browser/config/fontMeasurements.js');
const { Range } = await import('../../../../../editor/common/core/range.js');
const { LanguageCompletionTriggerKind } = await import('../../../../../editor/common/languages.js');
const { TextModel } = await import('../../../../../editor/common/model/textModel.js');
const { ICodeEditorService } = await import('../../../../../editor/browser/services/codeEditorService.js');
const { ICommandService } = await import('../../../../../platform/commands/common/commands.js');
const { Selection } = await import('../../../../../editor/common/core/selection.js');
const { ChatDynamicVariableModel, dynamicVariableDecorationType } =
	await import('../../browser/attachments/chatDynamicVariables.js');
const { ChatWidgetPasteTarget } = await import('../../browser/attachments/chatWidgetPasteTarget.js');
const { ChatPasteProvidersFeature, CHAT_ATTACHMENT_MIME_TYPE, CopyTextProvider } =
	await import('../../browser/widget/input/editor/chatPasteProviders.js');
const { CodeEditorWidget } = await import('../../../../../editor/browser/widget/codeEditor/codeEditorWidget.js');
const { ILanguageFeaturesService } = await import('../../../../../editor/common/services/languageFeatures.js');
const { CopyPasteController } =
	await import('../../../../../editor/contrib/dropOrPasteInto/browser/copyPasteController.js');
const { SelectAllCommand } = await import('../../../../../editor/browser/editorExtensions.js');
const { URI } = await import('../../../../../base/common/uri.js');
const { IEditorService } = await import('../../../../services/editor/common/editorService.js');
const { emptyEditorServiceState } = await import('../../../../test/common/testEditorService.js');
const { IResourceIconRenderer } = await import('../../../../browser/labels.js');
const { IChatSessionNavigationService } =
	await import('../../../../services/chat/common/chatSessionNavigationService.js');
const { Schemas } = await import('../../../../../base/common/network.js');
const { ChatReferenceAttachmentWidgetContribution } =
	await import('../../browser/attachments/chatReferenceAttachmentWidget.contribution.js');
const { noFileIconTheme } = await import('../../../../../platform/theme/common/themeService.js');
const { Emitter, Event: AshEvent } = await import('../../../../../base/common/event.js');
const { ModifierKeyEmitter } = await import('../../../../../base/browser/dom.js');

suiteTeardown(() => browserEnvironment.window.close());

for (const method of ['copy', 'cut'] as const) {
	test(`Code ${method} offers a reference snapshot after the source changes, while default paste stays plain`, async () => {
		using resources = new DisposableStore();
		const target = createSnapshotComposer(resources);
		const features = target.services.get(ILanguageFeaturesService);
		resources.add(
			features.documentPasteEditProvider.register(
				{ scheme: '*', hasAccessToAllModels: true },
				new CopyTextProvider({
					getChannel: () => undefined,
				} as unknown as import('../../../../services/output/common/output.js').IOutputService),
			),
		);
		using model = new TextModel('first\nconst unsaved = 42;\nlast', {
			resource: URI.file('/workspace/source.ts'),
			languageId: 'typescript',
		});
		const container = target.editor.element.ownerDocument.createElement('section');
		target.editor.element.ownerDocument.body.append(container);
		using source = target.services.createInstance(CodeEditorWidget, {
			container,
			model,
			contributionIds: ['editor.contrib.codeServices', CopyPasteController.ID],
		});
		source.setSelection(new Selection(2, 1, 3, 1));
		const clipboard = new SnapshotClipboard();
		dispatchSnapshotClipboard({ codeEditor: source, focus: () => source.focus() }, method, clipboard);
		if (method === 'cut') assert.equal(model.getValue(), 'first\nlast');
		model.setValue('Changed after copying');
		source.dispose();
		model.dispose();
		target.editor.value = 'Before  after';
		target.editor.setSelection({ anchor: 7, active: 7 });
		dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
		await CopyPasteController.get(target.editor.codeEditor)!.finishedPaste();
		assert.equal(target.editor.value, 'Before const unsaved = 42;\n after');
		assert.equal(target.references.variables.length, 0);
		const document = target.editor.element.ownerDocument;
		document.querySelector<HTMLButtonElement>('.stanza-editor-post-edit-selector button')!.click();
		const option = [...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(
			option => option.textContent === 'Pasted Code Attachment',
		);
		assert.ok(option);
		option.click();
		await waitFor(() => target.references.variables.length === 1);
		const reference = target.references.variables[0]!;
		assert.equal(target.editor.value, 'Before source.ts (2) after');
		assert.deepEqual(reference.reference, { start: 7, end: 20 });
		assert.equal(reference.kind, 'codeSelection');
		assert.ok((await reference.resolve()).content.endsWith('\n\nconst unsaved = 42;\n'));
		target.editor.getModel().undo();
		assert.equal(target.editor.value, 'Before  after');
		assert.deepEqual(target.references.variables, []);
		target.editor.getModel().redo();
		assert.equal(target.references.variables[0], reference);
	});
}

test('Malformed copied editor coordinates leave only the ordinary text paste', async () => {
	using resources = new DisposableStore();
	const target = createSnapshotComposer(resources);
	const clipboard = new SnapshotClipboard();
	clipboard.setData('text/plain', 'actual clipboard text');
	clipboard.setData(
		'application/vnd.code.additional-editor-data',
		JSON.stringify({
			uri: URI.file('/code.ts').toJSON(),
			range: { startLineNumber: 9, startColumn: 1, endLineNumber: 2, endColumn: 1 },
		}),
	);
	dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
	await CopyPasteController.get(target.editor.codeEditor)!.finishedPaste();
	assert.equal(target.editor.value, 'actual clipboard text');
	assert.deepEqual(target.references.variables, []);
	assert.equal(target.editor.element.ownerDocument.querySelector('.stanza-editor-post-edit-selector'), null);
});

test('Chat reference copy keeps the captured content after the source is cleared, with one paste undo step', async () => {
	using resources = new DisposableStore();
	const source = createSnapshotComposer(resources);
	const target = createSnapshotComposer(resources);
	source.editor.value = 'Review  please';
	source.editor.setSelection({ anchor: 7, active: 7 });
	source.references.addReference({
		id: 'file',
		kind: 'file',
		name: 'sample.ts',
		resource: URI.file('/sample.ts'),
		resolve: async () => ({ name: 'sample.ts', content: 'Original unsaved code' }),
	});
	source.editor.setSelection({ anchor: 0, active: source.editor.value.length });
	const clipboard = new SnapshotClipboard();
	dispatchSnapshotClipboard(source.editor, 'copy', clipboard);
	source.editor.value = '';
	target.editor.value = 'Before  after';
	target.editor.setSelection({ anchor: 7, active: 7 });
	dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
	await CopyPasteController.get(target.editor.codeEditor)!.finishedPaste();
	assert.equal(target.editor.value, 'Before Review sample.ts please after');
	assert.equal(target.references.variables.length, 1);
	const reference = target.references.variables[0]!;
	assert.deepEqual(reference.reference, { start: 14, end: 23 });
	assert.deepEqual(await reference.resolve(), { name: 'sample.ts', content: 'Original unsaved code' });
	assert.notEqual(reference.id, 'file');
	target.editor.getModel().undo();
	assert.equal(target.editor.value, 'Before  after');
	assert.deepEqual(target.references.variables, []);
	target.editor.getModel().redo();
	assert.equal(target.editor.value, 'Before Review sample.ts please after');
	assert.equal(target.references.variables[0], reference);
});

test('Chat reference cut captures before deletion and repeated paste has independent identities', async () => {
	using resources = new DisposableStore();
	const source = createSnapshotComposer(resources);
	const target = createSnapshotComposer(resources);
	const entry = source.references.addReference({
		id: 'file',
		kind: 'file',
		name: 'same.ts',
		resolve: async () => ({ name: 'same.ts', content: 'Cut snapshot' }),
	});
	source.editor.setSelection({ anchor: entry.reference!.start, active: entry.reference!.end });
	const clipboard = new SnapshotClipboard();
	dispatchSnapshotClipboard(source.editor, 'cut', clipboard);
	assert.equal(source.editor.value.trim(), '');
	source.editor.getModel().undo();
	assert.equal(source.references.variables[0], entry);
	for (let count = 1; count <= 2; count++) {
		dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
		await CopyPasteController.get(target.editor.codeEditor)!.finishedPaste();
		assert.equal(target.references.variables.length, count);
	}
	assert.notEqual(target.references.variables[0]!.id, target.references.variables[1]!.id);
	assert.deepEqual(await target.references.variables[1]!.resolve(), { name: 'same.ts', content: 'Cut snapshot' });
	target.editor.getModel().undo();
	assert.equal(target.references.variables.length, 1);
	target.editor.getModel().redo();
	assert.equal(target.references.variables.length, 2);
});

test('Chat ignores forged clipboard reference ranges and preserves the ordinary text paste', async () => {
	using resources = new DisposableStore();
	const target = createSnapshotComposer(resources);
	const clipboard = new SnapshotClipboard();
	clipboard.setData('text/plain', 'actual text');
	clipboard.setData(
		CHAT_ATTACHMENT_MIME_TYPE,
		JSON.stringify({
			version: 1,
			draft: {
				mode: 'agent',
				text: 'actual text',
				contexts: [
					{
						id: 'forged',
						kind: 'file',
						name: 'other',
						content: 'Hidden snapshot',
						reference: { start: 0, end: 5 },
					},
				],
			},
		}),
	);
	dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
	await CopyPasteController.get(target.editor.codeEditor)!.finishedPaste();
	assert.equal(target.editor.value, 'actual text');
	assert.deepEqual(target.references.variables, []);
});

test('Copying a tool configuration label cannot replace or duplicate the destination configuration', async () => {
	using resources = new DisposableStore();
	const source = createSnapshotComposer(resources);
	const target = createSnapshotComposer(resources);
	source.references.addReference({
		id: 'source-tools',
		kind: 'toolSelection',
		name: 'Source tools',
		resolve: async () => ({ name: 'Tools', kind: 'toolSelection', content: '["disabled"]' }),
	});
	const original = target.references.addReference({
		id: 'target-tools',
		kind: 'toolSelection',
		name: 'Target tools',
		resolve: async () => ({ name: 'Tools', kind: 'toolSelection', content: '[]' }),
	});
	source.editor.setSelection({ anchor: 0, active: source.editor.value.length });
	const clipboard = new SnapshotClipboard();
	dispatchSnapshotClipboard(source.editor, 'copy', clipboard);
	dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
	await CopyPasteController.get(target.editor.codeEditor)!.finishedPaste();
	assert.equal(target.editor.value, 'Target tools Source tools ');
	assert.deepEqual(target.references.variables, [original]);
	target.editor.getModel().undo();
	assert.deepEqual(target.references.variables, [original]);
});

test('Chat copies only selected references and keeps same-name snapshots independent after source disposal', async () => {
	using sourceResources = new DisposableStore();
	using targetResources = new DisposableStore();
	const source = createSnapshotComposer(sourceResources);
	const target = createSnapshotComposer(targetResources);
	for (const content of ['First snapshot', 'Second snapshot']) {
		source.references.addReference({
			id: 'file',
			kind: 'file',
			name: 'same.ts',
			resolve: async () => ({ name: 'same.ts', content }),
		});
	}
	const selected = source.references.variables[1]!.reference!;
	source.editor.setSelection({ anchor: selected.start, active: selected.end });
	const clipboard = new SnapshotClipboard();
	dispatchSnapshotClipboard(source.editor, 'copy', clipboard);
	sourceResources.dispose();
	dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
	await CopyPasteController.get(target.editor.codeEditor)!.finishedPaste();
	assert.equal(target.editor.value, 'same.ts');
	assert.equal(target.references.variables.length, 1);
	assert.deepEqual(await target.references.variables[0]!.resolve(), { name: 'same.ts', content: 'Second snapshot' });
});

test('Pasting an identical reference label replaces its snapshot and restores the previous snapshot on undo', async () => {
	using resources = new DisposableStore();
	const source = createSnapshotComposer(resources);
	const target = createSnapshotComposer(resources);
	const copied = source.references.addReference({
		id: 'copied',
		kind: 'file',
		name: 'same.ts',
		resolve: async () => ({ name: 'same.ts', content: 'Copied contents' }),
	});
	const original = target.references.addReference({
		id: 'original',
		kind: 'file',
		name: 'same.ts',
		resolve: async () => ({ name: 'same.ts', content: 'Original contents' }),
	});
	source.editor.setSelection({ anchor: copied.reference!.start, active: copied.reference!.end });
	target.editor.setSelection({ anchor: original.reference!.start, active: original.reference!.end });
	const before = target.editor.value;
	const clipboard = new SnapshotClipboard();
	dispatchSnapshotClipboard(source.editor, 'copy', clipboard);
	dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
	await CopyPasteController.get(target.editor.codeEditor)!.finishedPaste();
	assert.equal(target.editor.value, before);
	assert.equal(target.references.variables.length, 1);
	assert.deepEqual(await target.references.variables[0]!.resolve(), { name: 'same.ts', content: 'Copied contents' });
	target.editor.getModel().undo();
	assert.equal(target.references.variables[0], original);
	assert.equal(target.editor.value, before);
	target.editor.getModel().redo();
	assert.equal(target.editor.value, before);
	assert.deepEqual(await target.references.variables[0]!.resolve(), { name: 'same.ts', content: 'Copied contents' });
});

test('Reference paste maps LF copy offsets into every CRLF destination selection', async () => {
	using resources = new DisposableStore();
	const source = createSnapshotComposer(resources);
	const target = createSnapshotComposer(resources);
	source.editor.value = 'Before\n';
	source.editor.setSelection({ anchor: source.editor.value.length, active: source.editor.value.length });
	source.references.addReference({
		id: 'file',
		kind: 'file',
		name: 'file.ts',
		resolve: async () => ({ name: 'file.ts', content: 'Multiline snapshot' }),
	});
	source.editor.setSelection({ anchor: 0, active: source.editor.value.length });
	target.editor.value = 'old\r\nold';
	target.editor.getModel().setEOL(EndOfLineSequence.CRLF);
	target.editor.codeEditor.setSelections([new Selection(1, 1, 1, 4), new Selection(2, 1, 2, 4)]);
	const clipboard = new SnapshotClipboard();
	dispatchSnapshotClipboard(source.editor, 'copy', clipboard);
	dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
	await CopyPasteController.get(target.editor.codeEditor)!.finishedPaste();
	assert.equal(target.editor.value, 'Before\r\nfile.ts \r\nBefore\r\nfile.ts ');
	assert.equal(target.references.variables.length, 2);
	for (const reference of target.references.variables) {
		assert.equal(target.editor.value.slice(reference.reference!.start, reference.reference!.end), 'file.ts');
		assert.deepEqual(await reference.resolve(), { name: 'file.ts', content: 'Multiline snapshot' });
	}
	assert.notEqual(target.references.variables[0]!.id, target.references.variables[1]!.id);
	target.editor.getModel().undo();
	assert.equal(target.editor.value, 'old\r\nold');
	assert.deepEqual(target.references.variables, []);
	target.editor.getModel().redo();
	assert.equal(target.references.variables.length, 2);
});

test('A delayed Chat snapshot cannot paste into text edited while copy preparation is still pending', async () => {
	using resources = new DisposableStore();
	const source = createSnapshotComposer(resources);
	const target = createSnapshotComposer(resources);
	let release!: () => void;
	const snapshot = new Promise<{ name: string; content: string }>(resolve => {
		release = () => resolve({ name: 'held.ts', content: 'Held contents' });
	});
	const entry = source.references.addReference({
		id: 'file',
		kind: 'file',
		name: 'held.ts',
		resolve: () => snapshot,
	});
	source.editor.setSelection({ anchor: entry.reference!.start, active: entry.reference!.end });
	const clipboard = new SnapshotClipboard();
	dispatchSnapshotClipboard(source.editor, 'copy', clipboard);
	dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
	target.editor.value = 'A newer draft';
	await CopyPasteController.get(target.editor.codeEditor)!.finishedPaste();
	release();
	await snapshot;
	assert.equal(target.editor.value, 'A newer draft');
	assert.deepEqual(target.references.variables, []);
});

test('Chat paste options retain their snapshot session until switching and dismissal finish', async () => {
	using resources = new DisposableStore();
	const source = createSnapshotComposer(resources);
	const target = createSnapshotComposer(resources);
	const entry = source.references.addReference({
		id: 'file',
		kind: 'file',
		name: 'file.ts',
		resolve: async () => ({ name: 'file.ts', content: 'Saved snapshot' }),
	});
	source.editor.setSelection({ anchor: entry.reference!.start, active: entry.reference!.end });
	const clipboard = new SnapshotClipboard();
	dispatchSnapshotClipboard(source.editor, 'copy', clipboard);
	dispatchSnapshotClipboard(target.editor, 'paste', clipboard);
	const controller = CopyPasteController.get(target.editor.codeEditor)!;
	await controller.finishedPaste();
	const document = target.editor.element.ownerDocument;
	const choose = async (label: string): Promise<void> => {
		document.querySelector<HTMLButtonElement>('.stanza-editor-post-edit-selector button')!.click();
		const option = [...document.querySelectorAll<HTMLButtonElement>('[role=menuitem]')].find(
			option => option.textContent === label,
		);
		assert.ok(option);
		option.click();
	};
	await choose('Insert Plain Text');
	await waitFor(
		() => target.references.variables.length === 0 && !!document.querySelector('.stanza-editor-post-edit-selector'),
	);
	assert.equal(target.editor.value, 'file.ts');
	await choose('Insert Prompt & Attachments');
	await waitFor(() => target.references.variables.length === 1);
	assert.deepEqual(await target.references.variables[0]!.resolve(), { name: 'file.ts', content: 'Saved snapshot' });
	controller.clearWidgets();
	target.editor.getModel().undo();
	assert.equal(target.editor.value, '');
	target.editor.getModel().redo();
	assert.deepEqual(await target.references.variables[0]!.resolve(), { name: 'file.ts', content: 'Saved snapshot' });
});

function createSnapshotComposer(resources: DisposableStore) {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	resources.add(
		toDisposable(() => {
			dom.window.dispatchEvent(new dom.window.Event('pagehide'));
			ModifierKeyEmitter.disposeInstance(dom.window as unknown as Window);
			dom.window.close();
		}),
	);
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const services = createChatInputServices(resources);
	const editor = resources.add(
		services.createInstance(ChatInputEditor, {
			container: requiredElement<HTMLElement>(dom.window.document, 'main'),
			placeholder: 'Ask Ash',
			ariaLabel: 'Chat message',
			slashCommands: new SlashCommandCatalog([], []),
			skills: new SkillSelectorCatalog(),
		}),
	);
	const attachmentModel = resources.add(new ChatAttachmentModel());
	const references = resources.add(new ChatDynamicVariableModel(editor, attachmentModel));
	resources.add(services.createInstance(ChatWidgetPasteTarget, editor, references, attachmentModel));
	const lifecycle = new AbortController();
	resources.add(
		services.createInstance(
			ChatPasteProvidersFeature,
			editor,
			() => lifecycle.signal,
			() => true,
		),
	);
	return { editor, references, lifecycle, services, attachmentModel };
}

class SnapshotClipboard {
	private readonly values = new Map<string, string>();
	readonly files: readonly File[] = [];
	get types(): string[] {
		return [...this.values.keys()];
	}
	get items() {
		return [...this.values].map(([type, value]) => ({
			kind: 'string',
			type,
			getAsString: (read: (text: string) => void) => read(value),
			getAsFile: () => null,
		}));
	}
	setData(type: string, text: string): void {
		this.values.set(type, text);
	}
	getData(type: string): string {
		return this.values.get(type) ?? '';
	}
}

function dispatchSnapshotClipboard(
	editor: Pick<InstanceType<typeof ChatInputEditor>, 'codeEditor' | 'focus'>,
	type: 'copy' | 'cut' | 'paste',
	clipboard: SnapshotClipboard,
): void {
	editor.focus();
	const node = editor.codeEditor.controller.editContext.domNode.domNode;
	const targetWindow = node.ownerDocument.defaultView!;
	const event = new targetWindow.Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'clipboardData', { value: clipboard });
	node.dispatchEvent(event);
}

test('Registered session references keep their snapshot through source activation, deletion and undo', async () => {
	using resources = new DisposableStore();
	const opened: string[][] = [];
	const services = createChatInputServices(resources, undefined, async (session, thread) => {
		opened.push([session, thread]);
	});
	const container = browserEnvironment.window.document.createElement('main');
	browserEnvironment.window.document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	using editor = services.createInstance(ChatInputEditor, {
		container,
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog([], []),
		skills: new SkillSelectorCatalog(),
	});
	using attachmentModel = new ChatAttachmentModel();
	using references = new ChatDynamicVariableModel(editor, attachmentModel);
	editor.value = 'Explain  please';
	editor.setSelection({ anchor: 8, active: 8 });
	let reads = 0;
	const reference = references.addReference({
		id: 'session',
		kind: 'sessionReference',
		name: 'Earlier design',
		resource: URI.from({
			scheme: Schemas.internal,
			authority: 'chat-session',
			query: 'sessionId=previous&threadId=thread',
		}),
		resolve: async () => {
			reads++;
			return { name: 'Earlier design', content: 'Original conversation snapshot' };
		},
	});
	const decoration = editor
		.getModel()
		.getAllDecorations()
		.find(entry => entry.options.description === 'chat-context-reference')!;
	assert.equal(decoration.options.before?.replaceLength, reference.name.length);
	let submits = 0;
	resources.add(
		editor.onDidSubmit(() => {
			submits++;
		}),
	);
	editor.setSelection({ anchor: reference.reference!.start, active: reference.reference!.start });
	editor.element
		.querySelector('.stanza-editor-input')!
		.dispatchEvent(
			new browserEnvironment.window.KeyboardEvent('keydown', {
				key: 'Enter',
				altKey: true,
				bubbles: true,
				cancelable: true,
			}),
		);
	await Promise.resolve();
	assert.deepEqual(opened, [['previous', 'thread']]);
	assert.equal(reads, 0);
	assert.equal(submits, 0);
	const source = editor.element.querySelector<HTMLButtonElement>('.ash-chat-reference-attachment-source')!;
	source.dispatchEvent(
		new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
	);
	assert.equal(references.variables.length, 0);
	assert.equal(editor.element.querySelector('.ash-chat-reference-attachment'), null);
	editor.getModel().undo();
	assert.equal(references.variables[0], reference);
	assert.ok(editor.element.querySelector('.ash-chat-reference-attachment'));
	assert.equal((await references.variables[0]!.resolve()).content, 'Original conversation snapshot');
	assert.equal(reads, 1);
	editor.getModel().redo();
	assert.equal(references.variables.length, 0);
});

test('A mixed attachment batch keeps the caret after each reference and retains every snapshot', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using resources = new DisposableStore();
	const services = createChatInputServices(resources);
	using editor = services.createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog([], []),
		skills: new SkillSelectorCatalog(),
	});
	using attachmentModel = new ChatAttachmentModel();
	using references = new ChatDynamicVariableModel(editor, attachmentModel);
	editor.value = 'Review  please';
	editor.setSelection({ anchor: 7, active: 7 });
	const file = references.addReference(
		{
			id: 'file',
			kind: 'file',
			name: 'sample.ts',
			resolve: async () => ({ name: 'sample.ts', content: 'Captured source' }),
		},
		false,
	);
	assert.equal(editor.value, 'Review sample.ts please');
	assert.deepEqual(editor.getSelection(), { anchor: file.reference!.end, active: file.reference!.end });
	const image = references.addReference(
		{
			id: 'image',
			kind: 'image',
			name: 'preview.png',
			resolve: async () => ({ name: 'preview.png', kind: 'image', content: 'data:image/png;base64,captured' }),
		},
		false,
	);
	assert.equal(editor.value, 'Review sample.ts preview.png please');
	assert.deepEqual(
		references.variables.map(entry => entry.id),
		[file.id, image.id],
	);
	assert.deepEqual(await references.variables[0]!.resolve(), { name: 'sample.ts', content: 'Captured source' });
});

suite('Native attachment controls', () => {
	// Window caches outlive an input. Refresh jsdom's expiring font readings before
	// each case so a window-owned remeasurement cannot become a case-owned resource.
	setup(() => {
		FontMeasurements.clearAllFontInfos();
		using resources = new DisposableStore();
		createControlComposer(resources);
	});
	suiteTeardown(() => FontMeasurements.clearAllFontInfos());
	ensureNoDisposablesAreLeakedInTestSuite();

	function createControlComposer(
		resources: DisposableStore,
		openEditor?: import('../../../../services/editor/common/editorService.js').IEditorService['openEditor'],
	) {
		const container = browserEnvironment.window.document.createElement('main');
		browserEnvironment.window.document.body.append(container);
		resources.add(toDisposable(() => container.remove()));
		const services = createChatInputServices(resources, openEditor);
		const editor = resources.add(
			services.createInstance(ChatInputEditor, {
				container,
				placeholder: 'Ask Ash',
				ariaLabel: 'Chat message',
				slashCommands: new SlashCommandCatalog([], []),
				skills: new SkillSelectorCatalog(),
			}),
		);
		const attachmentModel = resources.add(new ChatAttachmentModel());
		const references = resources.add(new ChatDynamicVariableModel(editor, attachmentModel));
		return { editor, references, services };
	}

	test('Tab skips a pending image preview and reaches removal with one snapshot-preserving undo', async () => {
		using resources = new DisposableStore();
		const { editor, references } = createControlComposer(resources);
		let complete!: (value: { name: string; content: string }) => void;
		const pending = new Promise<{ name: string; content: string }>(resolve => {
			complete = resolve;
		});
		const image = references.addReference({
			id: 'image',
			kind: 'image',
			name: 'pending.png',
			resolve: () => pending,
		});
		const input = editor.codeEditor.controller.element;
		const window = input.ownerDocument.defaultView!;
		const buttons = editor.element.querySelectorAll<HTMLButtonElement>('.ash-chat-image-reference-control button');
		assert.equal(buttons[0]!.disabled, true);
		input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
		assert.equal(input.ownerDocument.activeElement, buttons[1]);
		buttons[1]!.dispatchEvent(
			new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
		);
		assert.equal(references.variables.length, 0);
		editor.getModel().undo();
		assert.equal(references.variables[0]!.resolve, image.resolve);
		complete({ name: 'pending.png', content: 'data:image/png;base64,Y2FwdHVyZWQ=' });
		const restored = editor.element.querySelector<HTMLImageElement>('.ash-chat-image-reference-control img')!;
		await waitFor(() => restored.hasAttribute('src'));
		Object.defineProperty(restored, 'naturalWidth', { value: 1 });
		restored.dispatchEvent(new window.Event('load'));
		assert.equal(
			editor.element.querySelector<HTMLButtonElement>('.ash-chat-image-reference-control button')!.disabled,
			false,
		);
		assert.equal(buttons[0]!.isConnected, false);
		assert.equal(buttons[0]!.querySelector('img')!.getAttribute('src'), null);
		assert.equal((await references.variables[0]!.resolve()).content, 'data:image/png;base64,Y2FwdHVyZWQ=');
		editor.getModel().redo();
		assert.equal(references.variables.length, 0);
	});

	for (const kind of ['file', 'terminalCommand'])
		test(`${kind} removal owns its focused control while preserving another reference at the caret`, async () => {
			using resources = new DisposableStore();
			const { editor, references } = createControlComposer(resources);
			const first = references.addReference({
				id: 'first',
				kind: 'file',
				name: 'first.ts',
				resolve: async () => ({ name: 'first.ts', content: 'First snapshot' }),
			});
			const target = references.addReference({
				id: 'second',
				kind,
				name: 'Saved source',
				resource:
					kind === 'file' ? URI.file('/workspace/second.ts') : URI.parse('private://terminal?id=original'),
				resolve: async () => ({ name: 'Saved source', content: 'Second snapshot' }),
			});
			editor.setSelection({ anchor: first.reference!.start, active: first.reference!.start });
			const remove = editor.element.querySelectorAll<HTMLButtonElement>('.ash-chat-attachment-remove')[1]!;
			remove.focus();
			remove.click();
			assert.deepEqual(
				references.variables.map(entry => entry.id),
				['first'],
			);
			editor.getModel().undo();
			assert.equal(references.variables[1]!.resolve, target.resolve);
			assert.equal((await references.variables[1]!.resolve()).content, 'Second snapshot');
			editor.getModel().redo();
			assert.deepEqual(
				references.variables.map(entry => entry.id),
				['first'],
			);
		});

	for (const kind of ['debug', 'scmHistoryItem', 'scmHistoryItemChange', 'custom'])
		test(`${kind} captured context opens the original readonly snapshot through removal and undo`, async () => {
			using resources = new DisposableStore();
			const opened: { resource: string; text: string }[] = [];
			const { editor, references } = createControlComposer(resources, async input => {
				assert.ok(input && 'initialText' in input);
				assert.equal(input.readOnly, true);
				opened.push({ resource: input.resource.toString(), text: input.initialText! });
			});
			const context = references.addReference({
				id: 'context',
				kind,
				name: 'Captured source',
				resolve: async () => ({ name: 'Captured source', content: 'Captured before source disposal' }),
			});
			editor.element.querySelector<HTMLButtonElement>('.ash-chat-attachment-source')!.click();
			await waitFor(() => opened.length === 1);
			assert.equal(opened[0]!.text, 'Captured before source disposal');
			editor.element.querySelector<HTMLButtonElement>('.ash-chat-attachment-remove')!.click();
			assert.equal(references.variables.length, 0);
			editor.getModel().undo();
			assert.equal(references.variables[0]!.resolve, context.resolve);
			editor.element.querySelector<HTMLButtonElement>('.ash-chat-attachment-source')!.click();
			await waitFor(() => opened.length === 2);
			assert.deepEqual(opened[0], opened[1]);
			editor.getModel().redo();
			assert.equal(references.variables.length, 0);
		});

	for (const kind of ['browserElement', 'scmHistoryItem', 'scmHistoryItemChange'])
		test(`${kind} dedicated control opens the same captured content despite a separate source URI`, async () => {
			using resources = new DisposableStore();
			const opened: unknown[] = [];
			const { editor, references } = createControlComposer(resources, async input => {
				assert.equal(input.readOnly, true);
				assert.equal(input.initialText, '<button onclick="captured()">Saved HTML</button>');
				opened.push(input);
			});
			const resource =
				kind === 'browserElement'
					? URI.parse('https://example.test/original')
					: SCMHistoryItemUri.toUri({
							repositoryId: 'original',
							revision: 'captured',
							...(kind === 'scmHistoryItemChange' ? { path: 'saved.ts' } : {}),
						});
			const context = references.addReference({
				id: 'context',
				kind,
				name: 'Saved source',
				resource,
				resolve: async () => ({
					name: 'Saved source',
					content: '<button onclick="captured()">Saved HTML</button>',
				}),
			});
			const chip = editor.element.querySelector<HTMLElement>('.ash-chat-attachment-chip')!;
			assert.equal(chip.dataset.attachmentKind, kind);
			assert.equal(chip.querySelectorAll('button').length, 3);
			chip.querySelector<HTMLButtonElement>('.ash-chat-attachment-source')!.click();
			await waitFor(() => opened.length === 1);
			assert.equal(editor.element.querySelector('[onclick]'), null);
			chip.querySelector<HTMLButtonElement>('.ash-chat-attachment-remove')!.click();
			editor.getModel().undo();
			assert.equal(references.variables[0]!.resolve, context.resolve);
			assert.equal(references.variables[0]!.resource!.toString(), resource.toString());
		});

	for (const kind of ['browserElement', 'scmHistoryItem', 'scmHistoryItemChange', 'debug', 'custom'])
		test(`${kind} native and keyboard hover share a bounded captured snapshot`, async () => {
			using resources = new DisposableStore();
			const { editor, references } = createControlComposer(resources);
			let reads = 0;
			const resource =
				kind === 'browserElement'
					? URI.parse('https://example.test/original')
					: kind.startsWith('scm')
						? SCMHistoryItemUri.toUri({
								repositoryId: 'repo:opaque',
								revision: 'revision:opaque',
								...(kind === 'scmHistoryItemChange' ? { path: 'source.ts' } : {}),
							})
						: undefined;
			const content = Array.from({ length: 20 }, (_, index) => `Captured line ${index + 1}`).join('\n');
			const entry = references.addReference({
				id: 'context',
				kind,
				name: 'Captured context',
				resource,
				resolve: async () => {
					reads++;
					return { name: 'Captured context', content };
				},
			});
			const message = () =>
				editor
					.getModel()
					.getAllDecorations()
					.find(decoration => decoration.options.description === 'chat-context-reference')?.options
					.hoverMessage as { value: string } | undefined;
			await waitFor(() => message()?.value.includes('Captured line 12') === true);
			assert.doesNotMatch(message()!.value, /Captured line 13|repo:opaque|revision:opaque/u);
			const source = editor.element.querySelector<HTMLButtonElement>('.ash-chat-attachment-source')!;
			assert.match(source.title, /Captured line 12/u);
			editor.setSelection({ anchor: 0, active: 0 });
			editor.insertText('Explain ');
			await waitFor(() => message()?.value.includes('Captured line 12') === true);
			assert.equal((await entry.resolve()).content, content);
			assert.equal(reads, 1);
		});

	test('a replaced same-ID control cannot receive a retired preview', async () => {
		using resources = new DisposableStore();
		const { editor, references } = createControlComposer(resources);
		let finish!: (value: { name: string; content: string }) => void;
		const pending = new Promise<{ name: string; content: string }>(resolve => {
			finish = resolve;
		});
		references.addReference({ id: 'context', kind: 'debug', name: 'Captured context', resolve: () => pending });
		const retired = editor.element.querySelector<HTMLButtonElement>('.ash-chat-attachment-source')!;
		references.addReference({
			id: 'context',
			kind: 'debug',
			name: 'Captured context',
			resolve: async () => ({ name: 'Captured context', content: 'Current captured preview' }),
		});
		const current = editor.element.querySelector<HTMLButtonElement>('.ash-chat-attachment-source')!;
		assert.notEqual(retired, current);
		await waitFor(() => current.title.includes('Current captured preview'));
		finish({ name: 'Captured context', content: 'Retired captured preview' });
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.match(current.title, /Current captured preview/u);
		assert.doesNotMatch(current.title, /Retired captured preview/u);
		assert.equal(retired.isConnected, false);
		assert.doesNotMatch(
			JSON.stringify(
				editor
					.getModel()
					.getAllDecorations()
					.map(decoration => decoration.options.hoverMessage),
			),
			/Retired captured preview/u,
		);
	});

	test('a removed generic context cannot open a late snapshot', async () => {
		using resources = new DisposableStore();
		let complete!: (value: { name: string; content: string }) => void;
		const pending = new Promise<{ name: string; content: string }>(resolve => {
			complete = resolve;
		});
		let reads = 0;
		const { editor, references } = createControlComposer(resources, async () => {
			assert.fail('Retired snapshot opened');
		});
		references.addReference({
			id: 'context',
			kind: 'debug',
			name: 'Captured source',
			resolve: () => {
				reads++;
				return pending;
			},
		});
		editor.element.querySelector<HTMLButtonElement>('.ash-chat-attachment-source')!.click();
		await waitFor(() => reads === 1);
		editor.element.querySelector<HTMLButtonElement>('.ash-chat-attachment-remove')!.click();
		complete({ name: 'Captured source', content: 'Late snapshot' });
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.equal(references.variables.length, 0);
	});

	test('a directory source action cannot also open a saved-content editor', async () => {
		using resources = new DisposableStore();
		const { editor, references, services } = createControlComposer(resources, async () => {
			assert.fail('Directory source opened a snapshot editor');
		});
		const commands = services.get(ICommandService);
		// The command is deliberately asynchronous so the adapter receives its completed open event.
		const requests: unknown[] = [];
		const execute = commands.executeCommand;
		commands.executeCommand = async (...args: unknown[]) => {
			requests.push(args);
			return undefined as never;
		};
		resources.add(
			toDisposable(() => {
				commands.executeCommand = execute;
			}),
		);
		const resource = URI.file('/workspace/src');
		references.addReference({
			id: 'folder',
			kind: 'directory',
			name: 'src',
			resource,
			resolve: async () => ({ name: 'src', content: 'Directory listing' }),
		});
		editor.element.querySelector<HTMLButtonElement>('.ash-chat-code-reference-source')!.click();
		await new Promise<void>(resolve => setTimeout(resolve, 0));
		assert.deepEqual(requests, [['revealInExplorer', resource]]);
	});
});

test('Deleting a focused session control leaves the reference at the text caret untouched', () => {
	using resources = new DisposableStore();
	const services = createChatInputServices(resources);
	const container = browserEnvironment.window.document.createElement('main');
	browserEnvironment.window.document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	using editor = services.createInstance(ChatInputEditor, {
		container,
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog([], []),
		skills: new SkillSelectorCatalog(),
	});
	using attachmentModel = new ChatAttachmentModel();
	using references = new ChatDynamicVariableModel(editor, attachmentModel);
	const file = references.addReference({
		id: 'first',
		kind: 'file',
		name: 'first.ts',
		resolve: async () => ({ name: 'first.ts', content: 'File snapshot' }),
	});
	references.addReference({
		id: 'second',
		kind: 'sessionReference',
		name: 'Earlier design',
		resource: URI.from({
			scheme: Schemas.internal,
			authority: 'chat-session',
			query: 'sessionId=previous&threadId=thread',
		}),
		resolve: async () => ({ name: 'Earlier design', content: 'Conversation snapshot' }),
	});
	editor.setSelection({ anchor: file.reference!.start, active: file.reference!.start });
	const source = editor.element.querySelector<HTMLButtonElement>('.ash-chat-reference-attachment-source')!;
	source.focus();
	source.dispatchEvent(
		new browserEnvironment.window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }),
	);
	assert.deepEqual(
		references.variables.map(reference => reference.name),
		['first.ts'],
	);
	editor.getModel().undo();
	assert.deepEqual(
		references.variables.map(reference => reference.name),
		['first.ts', 'Earlier design'],
	);
});

test('References constrain mouse, keyboard and API selections to whole model and visual boundaries', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using resources = new DisposableStore();
	const services = createChatInputServices(resources);
	using editor = services.createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog([], []),
		skills: new SkillSelectorCatalog(),
	});
	using attachmentModel = new ChatAttachmentModel();
	using references = new ChatDynamicVariableModel(editor, attachmentModel);
	editor.value = 'Before  after';
	editor.setSelection({ anchor: 7, active: 7 });
	const context = references.addReference({
		id: 'file',
		kind: 'file',
		name: 'settings.json (14-15)',
		resource: URI.file('/settings.json'),
		resolve: async () => ({ name: 'settings.json', content: 'Saved text' }),
	});
	const { start, end } = context.reference!;
	const model = editor.getModel();
	const native = editor.codeEditor;
	const move = (offset: number, source: string) => native.setPosition(model.getPositionAt(offset), source);
	move(start + 2, 'mouse');
	assert.deepEqual(editor.getSelection(), { anchor: start, active: start });
	move(end - 2, 'mouse');
	assert.deepEqual(editor.getSelection(), { anchor: end, active: end });
	const view = native._getViewModel()!;
	assert.ok(view.getPrimaryCursorState().viewState.selection.isEmpty());
	assert.equal(
		view.getPrimaryCursorState().viewState.position.column,
		view.coordinatesConverter.convertModelPositionToViewPosition(model.getPositionAt(end), PositionAffinity.Right)
			.column,
	);
	move(start, 'api');
	move(start + 1, 'keyboard');
	assert.deepEqual(editor.getSelection(), { anchor: end, active: end });
	move(end - 1, 'keyboard');
	assert.deepEqual(editor.getSelection(), { anchor: start, active: start });
	for (const [anchor, active, expected] of [
		[start, start + 1, { anchor: start, active: end }],
		[end, end - 1, { anchor: end, active: start }],
		[start + 2, end - 2, { anchor: start, active: end }],
	] as const) {
		native.setSelection(Selection.fromPositions(model.getPositionAt(anchor), model.getPositionAt(active)), 'mouse');
		assert.deepEqual(editor.getSelection(), expected);
	}
	editor.insertText('replacement');
	assert.equal(editor.value, 'Before replacement after');
	assert.deepEqual(references.variables, []);
});

test('Reference icons borrow the file theme, refresh with it and leave non-file sources empty', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using resources = new DisposableStore();
	const services = resources.add(createChatInputServices(resources).createChild());
	using changed = new Emitter<void>();
	let version = 'first';
	services.registerInstance(IResourceIconRenderer, {
		onDidChangeResourceIcons: changed.event,
		getFileIconTheme: () => ({ ...noFileIconTheme, hasFileIcons: true }),
		renderFileIcon: (resource, container) => {
			container.dataset.fileIcon = `${resource.path}:${version}`;
		},
	});
	using editor = services.createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog([], []),
		skills: new SkillSelectorCatalog(),
	});
	using attachmentModel = new ChatAttachmentModel();
	using references = new ChatDynamicVariableModel(editor, attachmentModel);
	for (const [id, uri] of [
		['file', 'file:///workspace/settings.json'],
		['output', 'output:/rust-analyzer'],
		['debug', 'inmemory:/debug-console'],
		['anonymous', 'inmemory:/console'],
	] as const) {
		references.addReference({
			id,
			kind: 'codeSelection',
			name: id,
			resource: URI.parse(uri),
			resolve: async () => ({ name: id, content: id }),
		});
	}
	const icons = () => [...editor.element.querySelectorAll<HTMLElement>('.ash-chat-code-reference-icon')];
	assert.equal(icons().length, 4);
	assert.equal(icons().filter(icon => icon.classList.contains('placeholder')).length, 3);
	assert.ok(icons().every(icon => icon.getAttribute('aria-hidden') === 'true' && !icon.querySelector('button')));
	assert.equal(
		editor.element.querySelector<HTMLElement>('[data-file-icon]')?.dataset.fileIcon,
		'/workspace/settings.json:first',
	);
	version = 'second';
	changed.fire();
	assert.equal(
		editor.element.querySelector<HTMLElement>('[data-file-icon]')?.dataset.fileIcon,
		'/workspace/settings.json:second',
	);
	assert.equal(editor.value, 'file output debug anonymous ');
	references.removeReference('file');
	assert.equal(icons().length, 3);
	assert.equal(editor.element.querySelector('[data-file-icon]'), null);
	await editor.getModel().undo();
	assert.equal(icons().length, 4);
	editor.dispose();
	changed.fire();
	assert.equal(dom.window.document.querySelector('.ash-chat-code-reference-icon'), null);
});

test('Reference previews shorten the shared snapshot without exposing output identities or changing submission', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
	using editor = services.createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog([], []),
		skills: new SkillSelectorCatalog(),
	});
	using attachmentModel = new ChatAttachmentModel();
	using references = new ChatDynamicVariableModel(editor, attachmentModel);
	const resource = URI.parse('output:/language-server.rust-analyzer.internal-id#3,1-33,1');
	const text = Array.from({ length: 30 }, (_, index) => `Captured line ${index + 1}`).join('\n');
	const content = `Source: ${resource.toString()}\n\n${text}`;
	let acquisitions = 0;
	const entry = references.addReference({
		id: 'selection',
		kind: 'codeSelection',
		name: 'rust-analyzer (3-32)',
		resource,
		resolve: async () => {
			acquisitions++;
			return { name: 'rust-analyzer (3-32)', content };
		},
	});
	const hover = () =>
		editor
			.getModel()
			.getAllDecorations()
			.find(decoration => decoration.options.description === 'chat-context-reference')?.options.hoverMessage as
			{ value: string } | undefined;
	await waitFor(() => hover()?.value.includes('Captured line 12') === true);
	assert.doesNotMatch(hover()!.value, /internal-id|output:\/|Captured line 13/u);
	assert.match(hover()!.value.replaceAll('&nbsp;', ' '), /Preview shortened/u);
	editor.setSelection({ anchor: 0, active: 0 });
	editor.insertText('Explain ');
	await waitFor(() => hover()?.value.includes('Captured line 12') === true);
	assert.equal((await entry.resolve()).content, content);
	assert.equal(acquisitions, 1);
});

test('Late reference previews cannot restore removed references or decorate another draft', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const opened: string[] = [];
	const services = createChatInputServices(editorServices, async input => {
		opened.push(input.resource.toString());
	});
	using editor = services.createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog([], []),
		skills: new SkillSelectorCatalog(),
	});
	using attachmentModel = new ChatAttachmentModel();
	using references = new ChatDynamicVariableModel(editor, attachmentModel);
	let finish!: (value: { name: string; content: string }) => void;
	const pending = new Promise<{ name: string; content: string }>(resolve => {
		finish = resolve;
	});
	references.addReference({ id: 'old', kind: 'codeSelection', name: 'old.ts (1)', resolve: () => pending });
	editor.setSelection({ anchor: 0, active: 0 });
	editor.element
		.querySelector('.stanza-editor-input')!
		.dispatchEvent(
			new dom.window.KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }),
		);
	references.removeReference('old');
	references.addReference({
		id: 'new',
		kind: 'codeSelection',
		name: 'new.ts (1)',
		resolve: async () => ({ name: 'new.ts (1)', content: 'Current snapshot' }),
	});
	finish({ name: 'old.ts (1)', content: 'Retired snapshot' });
	await waitFor(() =>
		editor
			.getModel()
			.getAllDecorations()
			.some(decoration => JSON.stringify(decoration.options.hoverMessage).includes('Current snapshot')),
	);
	assert.equal(
		editor
			.getModel()
			.getAllDecorations()
			.filter(decoration => decoration.options.description === 'chat-context-reference').length,
		1,
	);
	assert.doesNotMatch(
		JSON.stringify(
			editor
				.getModel()
				.getAllDecorations()
				.map(decoration => decoration.options.hoverMessage),
		),
		/Retired snapshot/u,
	);
	assert.deepEqual(opened, []);
});

test('Opening saved references isolates same-name snapshots and reuses the same snapshot tab', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const opened: import('../../../../common/editor.js').IResourceEditorInput[] = [];
	const services = createChatInputServices(editorServices, async input => {
		opened.push(input);
	});
	using editor = services.createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog([], []),
		skills: new SkillSelectorCatalog(),
	});
	using attachmentModel = new ChatAttachmentModel();
	using references = new ChatDynamicVariableModel(editor, attachmentModel);
	for (const content of ['First saved version', 'Second saved version']) {
		references.addReference({
			id: 'same-file',
			kind: 'file',
			name: 'same.ts',
			resource: URI.file('/same.ts'),
			resolve: async () => ({ name: 'same.ts', content }),
		});
	}
	const open = async (index: number, count: number): Promise<void> => {
		const offset = references.variables[index]!.reference!.start;
		editor.setSelection({ anchor: offset, active: offset });
		editor.element
			.querySelector('.stanza-editor-input')!
			.dispatchEvent(
				new dom.window.KeyboardEvent('keydown', {
					key: 'Enter',
					altKey: true,
					bubbles: true,
					cancelable: true,
				}),
			);
		await waitFor(() => opened.length === count);
	};
	await open(0, 1);
	await open(1, 2);
	await open(0, 3);
	assert.deepEqual(
		opened.map(input => input.initialText),
		['First saved version', 'Second saved version', 'First saved version'],
	);
	assert.notEqual(opened[0]!.resource.toString(), opened[1]!.resource.toString());
	assert.equal(opened[0]!.resource.toString(), opened[2]!.resource.toString());
	assert.ok(
		opened.every(
			input =>
				input.readOnly &&
				input.resource.scheme === 'chat-context-snapshot' &&
				input.contentType === 'text/plain' &&
				!input.showBreadcrumbs,
		),
	);
	assert.equal(references.variables.length, 2);
});

test('Inline code references track edits, atomic deletion, undo and redo in the real Chat editor', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
	using editor = services.createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog([], []),
		skills: new SkillSelectorCatalog(),
	});
	using attachmentModel = new ChatAttachmentModel();
	using references = new ChatDynamicVariableModel(editor, attachmentModel);
	editor.value = 'Explain  please';
	editor.setSelection({ anchor: 8, active: 8 });
	references.addReference({
		id: 'selection',
		kind: 'codeSelection',
		name: 'file.ts (6-9)',
		resolve: async () => ({ name: 'file.ts (6-9)', content: 'Unsaved code' }),
	});
	assert.equal(editor.value, 'Explain file.ts (6-9) please');
	assert.deepEqual(references.variables[0]?.reference, { start: 8, end: 21 });
	assert.equal(
		editor
			.getModel()
			.getAllDecorations()
			.filter(decoration => decoration.options.before?.replaceLength).length,
		1,
	);
	editor.setSelection({ anchor: 0, active: 0 });
	editor.insertText('First: ');
	assert.deepEqual(references.variables[0]?.reference, { start: 15, end: 28 });
	editor.setSelection({ anchor: 28, active: 28 });
	editor.element.dispatchEvent(
		new dom.window.KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
	);
	assert.equal(editor.value, 'First: Explain  please');
	assert.equal(references.variables.length, 0);
	assert.equal(attachmentModel.size, 0);
	await editor.getModel().undo();
	assert.equal(editor.value, 'First: Explain file.ts (6-9) please');
	assert.deepEqual(references.variables[0]?.reference, { start: 15, end: 28 });
	assert.equal((await references.variables[0]!.resolve()).content, 'Unsaved code');
	assert.equal(attachmentModel.size, 1);
	assert.equal(attachmentModel.attachments[0]!.resolve, references.variables[0]!.resolve);
	assert.equal(attachmentModel.attachments[0]!.reference, undefined);
	await editor.getModel().redo();
	assert.deepEqual(references.variables, []);
	assert.deepEqual(attachmentModel.attachments, []);
	// Typing the old label after deletion must not silently resurrect its code snapshot.
	editor.setSelection({ anchor: 15, active: 15 });
	editor.insertText('file.ts (6-9)');
	assert.deepEqual(references.variables, []);
});

test('Source updates project the canonical capture and revoked sources stay detached through undo', async () => {
	using resources = new DisposableStore();
	const { editor, references, attachmentModel } = createSnapshotComposer(resources);
	const capture = (name: string, content: string) => ({
		id: 'app',
		kind: 'mcpApp',
		lifetime: 'source' as const,
		name,
		resolve: async () => ({ name, content }),
	});
	const original = capture('App', 'Initial App content');
	attachmentModel.addContext(original);
	assert.equal(attachmentModel.attachments[0], original);
	assert.equal(references.variables[0]!.resolve, original.resolve);
	const latest = capture('Current App', 'Updated App content');
	attachmentModel.addContext(latest);
	assert.equal(editor.value, 'Current App ');
	assert.equal(attachmentModel.attachments[0], latest);
	assert.equal(references.variables[0]!.resolve, latest.resolve);
	assert.equal((await references.variables[0]!.resolve()).content, 'Updated App content');
	await editor.getModel().undo();
	assert.equal(editor.value, 'App ');
	assert.equal(references.variables[0]!.name, 'App');
	assert.equal(references.variables[0]!.resolve, latest.resolve);
	assert.equal(attachmentModel.attachments[0], latest);
	await editor.getModel().redo();
	assert.equal(editor.value, 'Current App ');
	attachmentModel.delete(latest.id);
	assert.deepEqual(references.variables, []);
	assert.deepEqual(attachmentModel.attachments, []);
	await editor.getModel().undo();
	assert.deepEqual(references.variables, []);
	assert.deepEqual(attachmentModel.attachments, []);
});

test('Chat registers its focused editor for global commands and removes it on disposal', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
	const editors = services.get(ICodeEditorService);
	const decorationTypes = editors.listDecorationTypes();
	const lifecycle: string[] = [];
	using willCreate = editors.onWillCreateCodeEditor(() => lifecycle.push('will'));
	using added = editors.onCodeEditorAdd(() => lifecycle.push('add'));
	using removed = editors.onCodeEditorRemove(() => lifecycle.push('remove'));
	using editor = services.createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []),
		skills: new SkillSelectorCatalog(),
	});
	assert.ok(editors.listDecorationTypes().includes(dynamicVariableDecorationType));
	editor.value = 'message';
	editor.focus();
	assert.equal(editors.listCodeEditors().length, 1);
	assert.deepEqual(lifecycle, ['will', 'add']);
	assert.equal(editor.element.querySelectorAll('.stanza-editor-completion').length, 1);
	const inputFont = editor.element.querySelector<HTMLElement>('.stanza-editor')!.style;
	assert.equal(inputFont.fontSize, '13px');
	assert.equal(inputFont.lineHeight, '20px');
	assert.doesNotMatch(inputFont.fontFamily.split(', monospace')[0]!, /^Menlo/u);
	assert.strictEqual(editors.getFocusedCodeEditor(), editors.listCodeEditors()[0]);
	await services.invokeFunction(accessor => SelectAllCommand.runCommand(accessor, undefined));
	assert.deepEqual(editors.getFocusedCodeEditor()?.getSelection(), new Selection(1, 1, 1, 8));
	editor.dispose();
	assert.deepEqual(editors.listDecorationTypes(), decorationTypes);
	assert.equal(editors.listCodeEditors().length, 0);
	assert.deepEqual(lifecycle, ['will', 'add', 'remove']);
});

test('Chat typography updates preserve the draft and selection, resize the input, and reset independently of file fonts', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
	const configuration = services.get(IConfigurationService);
	using editor = services.createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []),
		skills: new SkillSelectorCatalog(),
	});
	Object.defineProperty(editor.element, 'clientWidth', { value: 480 });
	editor.layout();
	editor.value = Array.from({ length: 6 }, (_, index) => `Line ${index + 1}`).join('\n');
	const codeEditor = services.get(ICodeEditorService).listCodeEditors()[0]!;
	codeEditor.setSelection(new Selection(2, 2, 3, 3));
	const selection = codeEditor.getSelection();
	const draft = editor.value;
	const font = editor.element.querySelector<HTMLElement>('.stanza-editor')!.style;
	const family = font.fontFamily;
	await waitFor(() => editor.element.style.height === '120px');
	await configuration.updateValue(ChatInputConfiguration.fontFamily, 'Arial');
	await configuration.updateValue(ChatInputConfiguration.fontSize, 18);
	await configuration.updateValue(ChatInputConfiguration.lineHeight, 30);
	await waitFor(() => editor.element.style.height === '180px');
	assert.match(font.fontFamily, /^Arial,/u);
	assert.equal(font.fontSize, '18px');
	assert.equal(font.lineHeight, '30px');
	assert.equal(editor.value, draft);
	assert.deepEqual(codeEditor.getSelection(), selection);
	await assert.rejects(configuration.updateValue(ChatInputConfiguration.fontFamily, 'Arial\nMenlo'));
	await assert.rejects(configuration.updateValue(ChatInputConfiguration.fontSize, 7));
	await assert.rejects(configuration.updateValue(ChatInputConfiguration.lineHeight, 7));
	await configuration.updateValue(ChatInputConfiguration.lineHeight, 0);
	assert.equal(font.lineHeight, `${codeEditor.getOption(EditorOption.fontInfo).lineHeight}px`);
	for (const key of Object.values(ChatInputConfiguration)) await configuration.updateValue(key, undefined);
	await waitFor(() => editor.element.style.height === '120px');
	assert.equal(font.fontFamily, family);
	assert.equal(font.fontSize, '13px');
	assert.equal(font.lineHeight, '20px');
	editor.dispose();
	await configuration.updateValue(ChatInputConfiguration.fontSize, 16);
	assert.equal(services.get(ICodeEditorService).listCodeEditors().length, 0);
});

test('Chat completion providers use one-based editor positions and ranges', async () => {
	const slashCommands = new SlashCommandCatalog(DesktopSlashCommands, []);
	using slashModel = new TextModel('/ne');
	const slashPosition = new Position(1, 4);
	const slashResult = await createChatCommandCompletionProvider(slashCommands).provideCompletions(
		{
			requestId: 1,
			languageId: 'ash-chat-input',
			position: slashPosition,
			context: { kind: LanguageCompletionTriggerKind.Invoke },
			snapshot: slashModel.createVersionedSnapshot(),
		},
		new AbortController().signal,
	);
	assert.deepEqual(slashResult?.items[0]?.range, new Range(1, 1, 1, 4));

	const skills = new SkillSelectorCatalog();
	skills.setSkills([
		{
			name: 'commit',
			description: 'Draft a commit message',
			source: 'user',
			skill: {
				id: { source: 'user:skill-source:test', name: 'commit' },
				version: { type: 'pinnedDigest', digest: 'sha256:commit' },
			},
		},
	]);
	using skillModel = new TextModel('first line\nuse $com here');
	const skillPosition = new Position(2, 9);
	const skillResult = await createChatSkillCompletionProvider(skills).provideCompletions(
		{
			requestId: 2,
			languageId: 'ash-chat-input',
			position: skillPosition,
			context: { kind: LanguageCompletionTriggerKind.Invoke },
			snapshot: skillModel.createVersionedSnapshot(),
		},
		new AbortController().signal,
	);
	assert.deepEqual(skillResult?.items[0]?.range, new Range(2, 5, 2, 9));
});

test('Chat slash provider finds description text without preselecting it', async () => {
	const catalog = new SlashCommandCatalog(
		[],
		[
			{ name: 'doctor', description: 'Inspect workspace health', argumentMode: 'none' },
			{ name: 'config', description: 'Open workspace settings', argumentMode: 'none' },
		],
	);
	using model = new TextModel('/workspace');
	const result = await createChatCommandCompletionProvider(catalog).provideCompletions(
		{
			requestId: 1,
			languageId: 'ash-chat-input',
			position: new Position(1, 11),
			context: { kind: LanguageCompletionTriggerKind.Invoke },
			snapshot: model.createVersionedSnapshot(),
		},
		new AbortController().signal,
	);
	assert.deepEqual(
		result?.items.map(item => [item.label, item.preselect, item.detailMatchIndices]),
		[
			['/config', false, [5, 6, 7, 8, 9, 10, 11, 12, 13]],
			['/doctor', false, [8, 9, 10, 11, 12, 13, 14, 15, 16]],
		],
	);
});

test('Chat input completes slash commands before submitting', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, 'main');
	using editorServices = new DisposableStore();
	using editor = createChatInputServices(editorServices).createInstance(ChatInputEditor, {
		container,
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []),
		skills: new SkillSelectorCatalog(),
	});
	let submissions = 0;
	using submitListener = editor.onDidSubmit(() => (submissions += 1));
	const input = requiredElement<HTMLTextAreaElement>(editor.element, '.stanza-editor-input');
	editor.focus();

	input.dispatchEvent(beforeInputEvent(dom.window, '/'));
	assert.equal(editor.value, '/');
	await waitFor(() => completionLabels(editor.element).includes('/config'));
	for (const command of ['/new', '/history', '/config'])
		assert.ok(completionLabels(editor.element).includes(command));
	assert.equal(editor.element.querySelector('.stanza-editor-line-number'), null);

	input.dispatchEvent(beforeInputEvent(dom.window, 'n'));
	await waitFor(() => completionLabels(editor.element).length === 1);
	assert.deepEqual(completionLabels(editor.element), ['/new']);

	const accept = keyboardEvent(dom.window, 'Enter');
	input.dispatchEvent(accept);
	assert.equal(accept.defaultPrevented, true);
	assert.equal(editor.value, '/new ');
	assert.equal(submissions, 0);

	const submit = keyboardEvent(dom.window, 'Enter');
	input.dispatchEvent(submit);
	assert.equal(submit.defaultPrevented, true);
	assert.equal(submissions, 1);
	dom.window.close();
});

test('Chat input shows a missing-character match without choosing it', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	using editor = createChatInputServices(editorServices).createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []),
		skills: new SkillSelectorCatalog(),
	});
	let submissions = 0;
	using submitListener = editor.onDidSubmit(() => (submissions += 1));
	const input = requiredElement<HTMLTextAreaElement>(editor.element, '.stanza-editor-input');
	editor.focus();
	input.dispatchEvent(beforeInputEvent(dom.window, '/'));
	await waitFor(() => completionLabels(editor.element).includes('/config'));
	for (const character of 'cofig') {
		input.dispatchEvent(beforeInputEvent(dom.window, character));
	}

	assert.equal(editor.value, '/cofig');
	await waitFor(() => completionLabels(editor.element).length > 0);
	assert.deepEqual(completionLabels(editor.element), ['/config']);
	assert.equal(editor.element.querySelector('.stanza-editor-completion-option.focused'), null);
	assert.deepEqual(
		[...editor.element.querySelectorAll('.stanza-editor-completion-label strong')].map(
			element => element.textContent,
		),
		['c', 'o', 'f', 'i', 'g'],
	);
	assert.equal(submissions, 0);

	const navigate = keyboardEvent(dom.window, 'ArrowDown');
	input.dispatchEvent(navigate);
	assert.equal(navigate.defaultPrevented, true);
	assert.equal(
		editor.element.querySelector('.stanza-editor-completion-option.focused .stanza-editor-completion-label')
			?.textContent,
		'/config',
	);
	const accept = keyboardEvent(dom.window, 'Enter');
	input.dispatchEvent(accept);
	assert.equal(accept.defaultPrevented, true);
	assert.equal(editor.value, '/config ');
	assert.equal(submissions, 0);
	dom.window.close();
});

test('Chat input emphasizes a description-only command match', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using editorServices = new DisposableStore();
	using editor = createChatInputServices(editorServices).createInstance(ChatInputEditor, {
		container: requiredElement<HTMLElement>(dom.window.document, 'main'),
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []),
		skills: new SkillSelectorCatalog(),
	});
	const input = requiredElement<HTMLTextAreaElement>(editor.element, '.stanza-editor-input');
	editor.focus();
	input.dispatchEvent(beforeInputEvent(dom.window, '/'));
	await waitFor(() => completionLabels(editor.element).includes('/config'));
	for (const character of 'settings') input.dispatchEvent(beforeInputEvent(dom.window, character));
	await waitFor(() => completionLabels(editor.element).includes('/config'));
	assert.deepEqual(completionLabels(editor.element), ['/config']);
	assert.equal(editor.element.querySelector('.stanza-editor-completion-option.focused'), null);
	assert.deepEqual(
		[...editor.element.querySelectorAll('.stanza-editor-completion-detail strong')].map(
			element => element.textContent,
		),
		[...'settings'],
	);
	dom.window.close();
});

test('Chat input discovers Skills through the shared `$` selector', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, 'main');
	const catalog = new SlashCommandCatalog(DesktopSlashCommands, []);
	const skills = new SkillSelectorCatalog();
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
	const options = { container, placeholder: 'Ask Ash', ariaLabel: 'Chat message', slashCommands: catalog, skills };
	using editor = services.createInstance(ChatInputEditor, options);
	let submissions = 0;
	using submitListener = editor.onDidSubmit(() => submissions++);
	skills.setSkills([
		{
			name: 'commit',
			description: 'Draft a commit message',
			source: 'user',
			skill: {
				id: { source: 'user:skill-source:test', name: 'commit' },
				version: { type: 'pinnedDigest', digest: 'sha256:commit' },
			},
		},
	]);
	const input = requiredElement<HTMLTextAreaElement>(editor.element, '.stanza-editor-input');
	editor.focus();

	input.dispatchEvent(beforeInputEvent(dom.window, '$'));
	await waitFor(() => completionLabels(editor.element).length === 1);

	assert.deepEqual(completionLabels(editor.element), ['$commit']);
	const accept = keyboardEvent(dom.window, 'Enter');
	input.dispatchEvent(accept);
	assert.equal(editor.value, '$commit ');
	assert.equal(submissions, 0);
});

test('Chat command completion replaces the whole command and preserves arguments', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using domCleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, 'main');
	using editorServices = new DisposableStore();
	const services = createChatInputServices(editorServices);
	using editor = services.createInstance(ChatInputEditor, {
		container,
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []),
		skills: new SkillSelectorCatalog(),
	});
	Object.defineProperty(editor.element, 'clientWidth', { value: 480 });
	editor.layout();
	editor.value = '/history argument';
	editor.focus();
	const input = requiredElement<HTMLElement>(editor.element, '.stanza-editor-input');
	input.dispatchEvent(keyboardEvent(dom.window, 'Home'));
	for (let index = 0; index < 3; index++) {
		input.dispatchEvent(keyboardEvent(dom.window, 'ArrowRight'));
	}
	await services.get(ICommandService).executeCommand('editor.action.triggerSuggest');
	await waitFor(() => completionLabels(editor.element)[0] === '/history');
	assert.equal(
		editor.element.querySelector('.stanza-editor-completion-option.focused .stanza-editor-completion-label')
			?.textContent,
		'/history',
	);
	input.dispatchEvent(keyboardEvent(dom.window, 'Enter'));
	assert.equal(editor.value, '/history argument');
});

test('Chat input starts with two lines and grows and shrinks with content', async () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement<HTMLElement>(dom.window.document, 'main');
	using editorServices = new DisposableStore();
	using editor = createChatInputServices(editorServices).createInstance(ChatInputEditor, {
		container,
		placeholder: 'Ask Ash',
		ariaLabel: 'Chat message',
		slashCommands: new SlashCommandCatalog(DesktopSlashCommands, []),
		skills: new SkillSelectorCatalog(),
	});
	Object.defineProperty(editor.element, 'clientWidth', { value: 480 });
	editor.layout();

	assert.equal(editor.element.style.height, '40px');
	editor.value = 'First line\nSecond line';
	await waitFor(() => editor.element.style.height === '40px');
	editor.value += '\nThird line';
	await waitFor(() => editor.element.style.height === '60px');
	editor.value = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join('\n');
	await waitFor(() => editor.element.style.height === '240px');
	editor.value = Array.from({ length: 50 }, (_, index) => `Line ${index + 1}`).join('\n');
	await waitFor(() => editor.element.style.height === '314px');
	editor.value = '';
	await waitFor(() => editor.element.style.height === '40px');
	dom.window.close();
});

function completionLabels(root: ParentNode): string[] {
	return [...root.querySelectorAll<HTMLElement>('.stanza-editor-completion-label')].map(
		element => element.textContent ?? '',
	);
}

function beforeInputEvent(
	targetWindow: typeof browserEnvironment.window,
	data: string | null,
	inputType = 'insertText',
): InputEvent {
	return new targetWindow.InputEvent('beforeinput', {
		bubbles: true,
		cancelable: true,
		inputType,
		data,
	}) as unknown as InputEvent;
}

function keyboardEvent(targetWindow: typeof browserEnvironment.window, key: string): KeyboardEvent {
	return new targetWindow.KeyboardEvent('keydown', {
		bubbles: true,
		cancelable: true,
		key,
	}) as unknown as KeyboardEvent;
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>(resolve => setTimeout(resolve, 0));
	}
	assert.fail('Timed out waiting for Chat input state');
}

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}

// Embedded editors exercise the same admitted feature batch as the product host.
const { getEditorFeatures } = await import('../../../../../editor/browser/editorFeatures.js');
const { EditorExtensionsRegistry } = await import('../../../../../editor/browser/editorExtensions.js');
let editorFeatures: import('../../../../../base/common/lifecycle.js').IDisposable;
setup(() => {
	editorFeatures = EditorExtensionsRegistry.registerEditorFeatures(getEditorFeatures());
});
teardown(() => editorFeatures.dispose());

function createChatInputServices(
	resources: DisposableStore,
	openEditor: import('../../../../services/editor/common/editorService.js').IEditorService['openEditor'] = async () => {},
	openConversation: import('../../../../services/chat/common/chatSessionNavigationService.js').IChatSessionNavigationService['openConversation'] = async () => {
		throw new Error('Unexpected conversation navigation');
	},
): ReturnType<typeof createCodeEditorServices> {
	const services = createCodeEditorServices(resources);
	services.registerInstance(IEditorService, { ...emptyEditorServiceState, openEditor, focusActiveEditor() {} });
	services.registerInstance(IResourceIconRenderer, {
		onDidChangeResourceIcons: AshEvent.None,
		getFileIconTheme: () => noFileIconTheme,
		renderFileIcon() {},
	});
	services.registerInstance(IChatSessionNavigationService, {
		revision: 0,
		getConversations: () => [],
		getActiveConversation: () => undefined,
		appendToActiveDraft() {
			throw new Error('Unexpected draft handoff');
		},
		captureActiveDraft: async () => undefined,
		openConversation,
		startVoiceConversation: async () => {
			throw new Error('Unexpected voice start');
		},
	});
	resources.add(services.createInstance(ChatReferenceAttachmentWidgetContribution));
	return services;
}
