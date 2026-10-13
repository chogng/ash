import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../base/common/async.js';
import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import type { IQuickPick, IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { pickChatContextItem } from '../../../browser/actions/chatContext.js';

function pickerHost(resources: DisposableStore): TestQuickInputService {
	const container = document.createElement('div');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	setARIAContainer(container);
	return resources.add(new TestQuickInputService({ container }));
}

function enter(background = false): void {
	document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: background, bubbles: true, cancelable: true }));
}

test('Async context results make the actual source the default background selection', async () => {
	using resources = new DisposableStore();
	const quickInput = pickerHost(resources);
	const result = new DeferredPromise<readonly IQuickPickItem[]>();
	const item = { label: 'Zsh', description: 'Owned terminal' };
	const selection = pickChatContextItem(quickInput, 'Select a terminal', () => result.p, new AbortController().signal);
	await result.complete([item]);
	assert.equal((quickInput.currentQuickInput as IQuickPick<IQuickPickItem>).busy, false);
	enter(true);
	assert.deepEqual(await selection, { kind: 'item', item, background: true });
	assert.equal(quickInput.currentQuickInput, undefined);
});

test('An empty completed context search keeps its keyboard Go back selection', async () => {
	using resources = new DisposableStore();
	const quickInput = pickerHost(resources);
	const result = new DeferredPromise<readonly IQuickPickItem[]>();
	const selection = pickChatContextItem(quickInput, 'Search context', () => result.p, new AbortController().signal);
	await result.complete([]);
	enter();
	assert.deepEqual(await selection, { kind: 'back' });
	assert.equal(quickInput.currentQuickInput, undefined);
});

test('Escape cancels an unresolved context catalog and ignores its late result', async () => {
	using resources = new DisposableStore();
	const quickInput = pickerHost(resources);
	const result = new DeferredPromise<readonly IQuickPickItem[]>();
	let token: CancellationToken | undefined;
	const selection = pickChatContextItem(quickInput, 'Search context', (_query, cancellation) => { token = cancellation; return result.p; }, new AbortController().signal);
	document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
	assert.equal(await selection, undefined);
	assert.equal(token?.isCancellationRequested, true);
	await result.complete([{ label: 'Late context' }]);
	assert.equal(quickInput.currentQuickInput, undefined);
});
