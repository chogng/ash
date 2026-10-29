import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { ContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { EditorPaneRegistry } from '../../../../browser/editor.js';
import { REOPEN_WITH_COMMAND_ID } from '../../../../browser/parts/editor/editorCommands.js';
import { EditorPaneMatch } from '../../../../browser/parts/editor/editorPane.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { CommandService } from '../../../commands/common/commandService.js';
import { productLanguagePackCatalogs } from '../../../localization/common/localizationCatalogs.js';
import { OpenWithEditorPicker } from '../../browser/openWithEditorPicker.js';
import type { EditorOpenOptions } from '../../common/editorService.js';

function setup() {
	const lifetime = new DisposableStore();
	const container = browserEnvironment.window.document.createElement('div');
	browserEnvironment.window.document.body.append(container);
	lifetime.add(toDisposable(() => container.remove()));
	const services = lifetime.add(new InstantiationService());
	const contexts = lifetime.add(new ContextKeyService());
	const quickInput = lifetime.add(new TestQuickInputService({ container, instantiationService: services, contextKeyService: contexts }));
	services.registerInstance(IQuickInputService, quickInput);
	const registry = lifetime.add(new EditorPaneRegistry());
	for (const id of ['test.first', 'test.second', 'test.unsupported']) {
		lifetime.add(registry.registerEditorPane({
			id, name: id,
			canOpen: () => id === 'test.unsupported' ? EditorPaneMatch.None : EditorPaneMatch.Optional,
			create: () => { throw new Error('The selection UI must not create editor panes'); },
		}));
	}
	const input = { resource: URI.file('/workspace/main.ts') };
	const opened: { input: IResourceEditorInput; options: EditorOpenOptions; }[] = [];
	const openStarted = new DeferredPromise<void>();
	let openResult: Promise<void> = Promise.resolve();
	const group = {
		id: 'main', inputs: [input], activeInput: input,
		openEditor: async (input: IResourceEditorInput, options: EditorOpenOptions) => {
			opened.push({ input, options });
			void openStarted.complete(undefined);
			await openResult;
		},
	};
	const groups = [group];
	services.registerInstance(IEditorPart, {
		groups, activeGroup: group,
		getEditorPaneChoices: (input: IResourceEditorInput | undefined) => input ? registry.getEditorPanesForInput(input) : [],
	} as unknown as IEditorPart);
	const commands = lifetime.add(new CommandService(services));
	const currentPicker = () => {
		assert.ok(quickInput.currentQuickInput);
		return quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
	};
	return {
		[Symbol.dispose]: () => lifetime.dispose(),
		services, commands, quickInput, registry, input, group, groups, opened, currentPicker,
		whenOpenStarts: openStarted.p,
		deferOpen: (result: Promise<void>) => { openResult = result; },
	};
}

test('OpenWithEditorPicker returns a selection without opening an editor', async () => {
	using context = setup();
	const result = context.services.createInstance(OpenWithEditorPicker).pick(context.input);
	const picker = context.currentPicker();
	assert.deepEqual(picker.items.map(item => item.label), ['test.first', 'test.second']);
	await picker.accept(true);
	assert.deepEqual(await result, { preferredEditorId: 'test.first', preserveFocus: true });
	assert.deepEqual(context.opened, []);
	assert.equal(context.quickInput.currentQuickInput, undefined);
});

test('OpenWithEditorPicker localizes the prompt and accessible label in Chinese', async () => {
	using context = setup();
	const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	setNlsMessages(catalog.locale, catalog.bundles);
	try {
		const result = context.services.createInstance(OpenWithEditorPicker).pick(context.input);
		const picker = context.currentPicker();
		assert.deepEqual({ placeholder: picker.placeholder, ariaLabel: picker.ariaLabel }, { placeholder: '选择编辑器', ariaLabel: '选择编辑器' });
		picker.hide();
		assert.equal(await result, undefined);
	} finally {
		resetNlsResolver();
	}
});

test('Reopen With cancellation leaves the editor untouched and dismisses the picker', async () => {
	using context = setup();
	const result = context.commands.executeCommand(REOPEN_WITH_COMMAND_ID);
	context.currentPicker().hide();
	await result;
	assert.deepEqual(context.opened, []);
	assert.equal(context.quickInput.currentQuickInput, undefined);
});

test('Reopen With waits for the selected editor to finish opening', async () => {
	using context = setup();
	const opening = new DeferredPromise<void>();
	context.deferOpen(opening.p);
	let completed = false;
	const result = context.commands.executeCommand(REOPEN_WITH_COMMAND_ID).then(() => { completed = true; });
	await context.currentPicker().accept(true);
	await context.whenOpenStarts;
	assert.deepEqual(context.opened, [{ input: context.input, options: { preferredEditorId: 'test.first', preserveFocus: true, pinned: true } }]);
	assert.equal(completed, false);
	await opening.complete(undefined);
	await result;
	assert.equal(completed, true);
});

for (const removed of ['tab', 'group']) {
	test(`Reopen With does not reopen a ${removed} closed while picking`, async () => {
		using context = setup();
		const result = context.commands.executeCommand(REOPEN_WITH_COMMAND_ID);
		if (removed === 'tab') context.group.inputs.length = 0;
		else context.groups.length = 0;
		await context.currentPicker().accept();
		await result;
		assert.deepEqual(context.opened, []);
	});
}

test('Reopen With keeps the captured tab when the active tab changes during selection', async () => {
	using context = setup();
	const result = context.commands.executeCommand(REOPEN_WITH_COMMAND_ID);
	context.group.activeInput = { resource: URI.file('/workspace/other.ts') };
	await context.currentPicker().accept();
	await result;
	assert.deepEqual(context.opened, [{ input: context.input, options: { preferredEditorId: 'test.first', preserveFocus: false, pinned: true } }]);
});

test('Reopen With rejects an opening failure through its command promise', async () => {
	using context = setup();
	const failure = new Error('The selected editor could not load');
	context.deferOpen(Promise.reject(failure));
	const result = context.commands.executeCommand(REOPEN_WITH_COMMAND_ID);
	const rejected = assert.rejects(result, error => error === failure);
	await context.currentPicker().accept();
	await rejected;
});
