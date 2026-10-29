import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import { scheduleAtNextAnimationFrame } from '../../../../../../base/browser/scheduler.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import type { IQuickPick, IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { showToolsPicker } from '../../../browser/actions/chatToolPicker.js';
import { createTestLanguageModelToolsService } from '../../common/tools/testLanguageModelToolsService.js';
import { Emitter } from '../../../../../../base/common/event.js';

// The document's module-owned ARIA root has the isolated test process's lifetime.
setARIAContainer(document.body);

test('browser group selection uses available built-in names without disabling a similarly named MCP tool', async () => {
	using resources = new DisposableStore();
	const container = document.createElement('div');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	const quick = resources.add(new TestQuickInputService({ container }));
	const tools = [
		{ id: 'browser_open', toolReferenceName: 'browser_open', displayName: 'Open', modelDescription: 'Open', canBeReferencedInPrompt: true, source: 'local', sourceDetails: [], exposure: 'direct', authority: 'productService' },
		{ id: 'browser_click', toolReferenceName: 'browser_click', displayName: 'Click', modelDescription: 'Click', canBeReferencedInPrompt: true, source: 'local', sourceDetails: [], exposure: 'direct', authority: 'productService' },
		{ id: 'browser_screenshot', toolReferenceName: 'browser_screenshot', displayName: 'External', modelDescription: 'External', canBeReferencedInPrompt: true, source: 'mcp', sourceDetails: [], exposure: 'direct', authority: 'providerDefined' },
	] as const;
	using service = createTestLanguageModelToolsService({
		isAvailable: true, read: async () => ({
			tools: tools.map(tool => ({ ...tool, name: tool.id, description: tool.modelDescription })), sourceGroups: [],
		})
	});
	await service.refresh();
	const cancellation = new AbortController();
	resources.add(toDisposable(() => cancellation.abort()));
	const result = showToolsPicker(quick, service, [], cancellation.signal);
	const picker = quick.currentQuickInput as IQuickPick<IQuickPickItem>;
	const choose = (label: string): void => {
		picker.value = label;
		const item = picker.items.find(item => 'label' in item && item.label === label) as IQuickPickItem;
		assert.ok(item);
		picker.activeItems = [item];
		document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	};
	choose('Browser tools');
	choose('Apply tool selection');
	assert.deepEqual(await result, ['browser_click', 'browser_open']);
	await new Promise<void>(done => resources.add(scheduleAtNextAnimationFrame(window, done)));
});

test('an open tools picker follows backend changes and retains search, focus and unsent selection', async () => {
	using resources = new DisposableStore();
	using invalidated = new Emitter<void>();
	const container = document.createElement('div');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	const quick = resources.add(new TestQuickInputService({ container }));
	let names = ['read_file', 'removed_tool'];
	using service = createTestLanguageModelToolsService({
		isAvailable: true, onDidChangeTools: invalidated.event, read: async () => ({
			tools: names.map(name => ({ name, description: name, source: 'local', sourceDetails: [], exposure: 'direct', authority: 'directoryRead' })),
			sourceGroups: [{ id: 'directory', source: 'local', sourceId: 'directory', tools: names }],
		})
	});
	await service.refresh();
	const cancellation = new AbortController();
	resources.add(toDisposable(() => cancellation.abort()));
	const result = showToolsPicker(quick, service, [], cancellation.signal);
	const picker = quick.currentQuickInput as IQuickPick<IQuickPickItem>;
	const find = (label: string): IQuickPickItem => picker.items.find(item => item.label === label) as IQuickPickItem;
	picker.value = 'read_file';
	picker.activeItems = [find('read_file')];
	const input = document.activeElement;
	input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	assert.equal(find('read_file').description, 'Disabled');
	names = ['read_file', 'added_tool'];
	invalidated.fire();
	await service.refresh();
	assert.equal(picker.value, 'read_file');
	assert.equal(document.activeElement, input);
	assert.equal(picker.activeItems[0]!.label, 'read_file');
	assert.equal(find('read_file').description, 'Disabled');
	picker.value = '';
	assert.ok(picker.items.some(item => item.label === 'added_tool'));
	assert.ok(!picker.items.some(item => item.label === 'removed_tool'));
	picker.activeItems = [find('Apply tool selection')];
	input!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
	assert.deepEqual(await result, ['read_file']);
	await new Promise<void>(done => resources.add(scheduleAtNextAnimationFrame(window, done)));
});
