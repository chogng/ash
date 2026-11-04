import { CancellationTokenSource } from '../../../../../../base/common/cancellation.js';
import { observableValue } from '../../../../../../base/common/observable.js';
import { Lxicon } from '../../../../../../base/common/lxicons.js';
import {
	picksWithPromiseFn,
	type ChatContextPick,
	type IChatContextPickerItem,
	type IChatContextPickerPickItem,
} from '../../../browser/attachments/chatContextPickService.js';
import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { ChatContextPickService } from '../../../browser/attachments/chatContextPickService.js';

import { DeferredPromise } from '../../../../../../base/common/async.js';
import type { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { setARIAContainer } from '../../../../../../base/browser/ui/aria/aria.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import type { IQuickPick, IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { ChatContextContributions, ChatReferenceContextContribution, pickChatContextItem } from '../../../browser/actions/chatContext.js';
import { ImageEditorService } from '../../../../../services/imageEditor/browser/imageEditorService.js';
import { IImageEditorService } from '../../../../../services/imageEditor/common/imageEditorService.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatContextPickService } from '../../../browser/attachments/chatContextPickService.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IChatAttachmentResolveService } from '../../../browser/attachments/chatAttachmentResolveService.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IChatService } from '../../../../../services/chat/common/chatService.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { ILanguageModelToolsService } from '../../../common/tools/languageModelToolsService.js';
import { Event } from '../../../../../../base/common/event.js';
import { ScreenshotCommandId } from '../../../common/constants.js';

function pickerHost(resources: DisposableStore): TestQuickInputService {
	const container = document.createElement('div');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	resources.add(setARIAContainer(container));
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


suite('Registered attachment source contracts', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('native sources assemble through DI, borrow image capture and unregister with their contribution', async () => {
		using resources = new DisposableStore();
		const services = resources.add(new InstantiationService());
		const contexts = new ChatContextPickService();
		services.registerInstance(IChatContextPickService, contexts);
		services.registerInstance(IClipboardService, {} as IClipboardService);
		services.registerInstance(IChatAttachmentResolveService, {} as IChatAttachmentResolveService);
		assert.throws(() => services.createInstance(ChatContextContributions), /imageEditorService/);
		assert.deepEqual([...contexts.items], [], 'A missing dependency must not leave partially registered sources');
		const requests: AbortSignal[] = [];
		class ManualImageEditors extends ImageEditorService {
			constructor() { super(); }
			async capture(signal: AbortSignal) { requests.push(signal); return undefined; }
		}
		const editors = resources.add(new ManualImageEditors());
		services.registerInstance(IImageEditorService, editors);
		services.registerInstance(IChatSessionNavigationService, {} as IChatSessionNavigationService);
		services.registerInstance(IChatService, {} as IChatService);
		services.registerInstance(ILanguageModelToolsService, { isAvailable: false, onDidChangeTools: Event.None } as ILanguageModelToolsService);
		services.registerInstance(IQuickInputService, pickerHost(resources));
		const contribution = resources.add(services.createInstance(ChatContextContributions));
		const references = resources.add(services.createInstance(ChatReferenceContextContribution));
		assert.deepEqual([...contexts.items].map(source => source.label), ['Image from Clipboard', 'Screenshot…', 'Sessions…', 'Tools…']);
		const screenshot = [...contexts.items].find(source => source.commandId === ScreenshotCommandId)!;
		assert.equal(screenshot.type, 'valuePick');
		assert.ok(screenshot.type === 'valuePick');
		const signal = new AbortController().signal;
		assert.equal(await screenshot.asAttachment(undefined, signal), undefined);
		assert.deepEqual(requests, [signal]);
		contribution.dispose();
		references.dispose();
		assert.deepEqual([...contexts.items], []);
	});

	function item(name: string): IChatContextPickerPickItem {
		return { label: name, asAttachment: () => ({ id: name, kind: 'source', name, resolve: async () => ({ name, content: `Captured ${name}` }) }) };
	}

	async function ready(condition: () => boolean): Promise<void> {
		for (let attempt = 0; attempt < 50; attempt++) {
			if (condition()) return;
			await new Promise<void>(resolve => setTimeout(resolve, 0));
		}
		assert.fail('Attachment source did not reach the expected state');
	}

	test('a query publishes busy immediately, cancels its old read and accepts only the latest result', async () => {
		using lifetime = new CancellationTokenSource();
		using cancel = toDisposable(() => lifetime.cancel());
		const query = observableValue('query', 'initial');
		const stale = new DeferredPromise<ChatContextPick[]>();
		const latest = new DeferredPromise<ChatContextPick[]>();
		const tokens = new Map<string, CancellationToken>();
		const state = picksWithPromiseFn(async (value, token) => {
			tokens.set(value, token);
			return value === 'slow' ? stale.p : value === 'latest' ? latest.p : [item('Old choice')];
		})(query, lifetime.token);
		await ready(() => !state.get().busy);
		query.set('slow');
		assert.deepEqual(state.get(), { busy: true, picks: [] });
		await ready(() => tokens.has('slow'));
		query.set('latest');
		assert.equal(tokens.get('slow')!.isCancellationRequested, true);
		await latest.complete([item('Latest choice')]);
		await ready(() => !state.get().busy);
		await stale.error(new Error('Retired query failed'));
		await Promise.resolve();
		assert.deepEqual(state.get().picks.map(pick => pick.label), ['Latest choice']);
		assert.equal(state.get().error, undefined);
	});

	test('provider result order and metadata matches are retained without a second label filter', async () => {
		using lifetime = new CancellationTokenSource();
		using cancel = toDisposable(() => lifetime.cancel());
		const query = observableValue('query', '1234567890abcdef');
		const picks = [item('Z newest'), item('A oldest')];
		const state = picksWithPromiseFn(async value => { assert.equal(value, query.get()); return picks; })(query, lifetime.token);
		await ready(() => !state.get().busy);
		assert.deepEqual(state.get().picks, picks);
	});

	test('current query failures are observable while cancelled failures cannot replace its state', async () => {
		using lifetime = new CancellationTokenSource();
		using cancel = toDisposable(() => lifetime.cancel());
		const result = new DeferredPromise<ChatContextPick[]>();
		const state = picksWithPromiseFn(() => result.p)(observableValue('query', ''), lifetime.token);
		const error = new Error('Current query failed');
		await result.error(error);
		await ready(() => !state.get().busy);
		assert.equal(state.get().error, error);
		lifetime.cancel();
	});

	test('parent cancellation retires current work without waiting for an uncooperative provider', async () => {
		using lifetime = new CancellationTokenSource();
		const result = new DeferredPromise<ChatContextPick[]>();
		let token: CancellationToken | undefined;
		const state = picksWithPromiseFn(async (_value, current) => { token = current; return result.p; })(observableValue('query', ''), lifetime.token);
		await ready(() => token !== undefined);
		lifetime.cancel();
		assert.equal(token!.isCancellationRequested, true);
		await result.complete([item('Late choice')]);
		assert.deepEqual(state.get().picks, []);
	});

	test('registration owns item identity and ordering; it never owns a picker or resolves a capture', () => {
		using resources = new DisposableStore();
		const service = new ChatContextPickService();
		const create = (label: string, ordinal = 0): IChatContextPickerItem => ({
			type: 'pickerPick', label, ordinal, icon: Lxicon.file,
			asPicker: () => { assert.fail('Registration must not instantiate picker UI'); },
		});
		const z = create('Z'), a = create('A'), priority = create('Priority', 10);
		resources.add(service.registerChatContextItem(z));
		const registration = resources.add(service.registerChatContextItem(a));
		resources.add(service.registerChatContextItem(priority));
		assert.deepEqual([...service.items], [priority, a, z]);
		assert.throws(() => service.registerChatContextItem(a), /already registered/u);
		registration.dispose();
		assert.deepEqual([...service.items], [priority, z]);
	});
});
