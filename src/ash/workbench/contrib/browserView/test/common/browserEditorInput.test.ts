import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { observableValue } from '../../../../../base/common/observable.js';
import {
	isChatContextPickerPickItem,
	type IChatContextPickerItem,
	type IChatContextValueItem,
	type IChatContextPickerPickItem,
} from '../../../chat/browser/attachments/chatContextPickService.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import { IChatContextPickService } from '../../../chat/browser/attachments/chatContextPickService.js';
import type { BrowserEditor } from '../../electron-browser/browserEditor.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBrowserViewService, BrowserViewStorageScope, type BrowserViewEvent, type IBrowserViewInfo, type IBrowserViewService as BrowserService } from '../../../../../platform/browserView/common/browserView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { EditorInputSerializerRegistry } from '../../../../services/editor/common/editorInputSerializer.js';
import { BrowserEditorInput, BrowserEditorSerializer, type IBrowserEditorInputData } from '../../common/browserEditorInput.js';
import { IBrowserViewWorkbenchService, type IBrowserViewModel } from '../../common/browserView.js';
import { BrowserViewUri } from '../../../../../platform/browserView/common/browserViewUri.js';
import { setNlsMessages, resetNlsResolver } from '../../../../../nls.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { BrowserEditorChatIntegration } from '../../electron-browser/features/browserEditorChatFeatures.js';
import { ChatContextPickService } from '../../../../contrib/chat/browser/attachments/chatContextPickService.js';

import { VSBuffer } from '../../../../../base/common/buffer.js';

const id = 'browser_target_123e4567-e89b-12d3-a456-426614174000';
const data: IBrowserEditorInputData = { id, url: 'https://example.test/', title: 'Saved page', session: { scope: BrowserViewStorageScope.Workspace } };

suite('Browser editor page model and restoration', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('resolving a lazy input uses one page and mirrors subsequent Main state', async () => {
		using f = fixture();
		const input = f.input(data);
		assert.equal(BrowserViewUri.getId(input.resource), id);
		const [first, second] = await Promise.all([input.resolve(), input.resolve()]);
		f.events.fire({ type: 'stateChanged', state: { ...first.state, title: 'Updated title', url: 'https://example.test/next' } });
		assert.deepEqual([first === second, f.creations, input.label, input.serialize().url], [true, 1, 'Updated title', 'https://example.test/next']);
	});

	test('a newer event wins over a snapshot response arriving later', async () => {
		using f = fixture();
		const snapshot = promiseWithResolvers<IBrowserViewInfo['state']>();
		const requested = promiseWithResolvers<void>();
		f.service.getState = async () => { requested.resolve(); return snapshot.promise; };
		const input = f.input(data);
		const resolution = input.resolve();
		await requested.promise;
		f.events.fire({ type: 'stateChanged', state: { ...f.info.state, title: 'Newer event' } });
		snapshot.resolve({ ...f.info.state, title: 'Older snapshot' });
		await resolution;
		assert.equal(input.label, 'Newer event');
	});

	test('editor serialization restores a lazy input and keeps an agent login and authority out of persistence', async () => {
		using f = fixture();
		f.info = { ...f.info, owner: { type: 'agent', sessionId: 'agent-thread' }, session: { scope: BrowserViewStorageScope.Agent, affinity: 'agent-thread' } };
		const input = f.input(data);
		await input.resolve();
		const registry = new EditorInputSerializerRegistry();
		using registration = registry.register(f.instantiation.createInstance(BrowserEditorSerializer));
		const serialized = registry.serialize(input);
		const restored = registry.deserialize(serialized);
		assert.deepEqual(serialized, { typeId: 'workbench.editorInput.browser', value: { ...data, title: 'Live page', session: { scope: BrowserViewStorageScope.Ephemeral } } });
		assert.ok(restored instanceof BrowserEditorInput);
		assert.equal(f.creations, 1);
	});

	test('disposing the input detaches its model without closing a Main page', async () => {
		using f = fixture();
		const input = f.input(data);
		await input.resolve();
		input.dispose();
		f.events.fire({ type: 'stateChanged', state: { ...f.info.state, title: 'After disposal' } });
		assert.equal(f.closed, 0);
		assert.equal(input.label, 'Live page');
	});

	test('a failed snapshot can be retried without retaining the failed model listener', async () => {
		using f = fixture();
		const input = f.input(data);
		let attempts = 0;
		f.service.getState = async () => {
			if (++attempts === 1) { throw new Error('Snapshot unavailable'); }
			return f.info.state;
		};
		await assert.rejects(input.resolve(), /Snapshot unavailable/);
		const model = await input.resolve();
		let labels = 0;
		using listener = input.onDidChangeLabel(() => labels++);
		f.events.fire({ type: 'stateChanged', state: { ...model.state, title: 'Recovered page' } });
		assert.deepEqual([attempts, labels, input.label], [2, 1, 'Recovered page']);
	});

	test('closing a page during snapshot discovery rejects resolution instead of reviving it', async () => {
		using f = fixture();
		const snapshot = promiseWithResolvers<IBrowserViewInfo['state']>();
		const requested = promiseWithResolvers<void>();
		f.service.getState = async () => { requested.resolve(); return snapshot.promise; };
		const input = f.input(data);
		const resolution = input.resolve();
		await requested.promise;
		f.events.fire({ type: 'closed', targetId: id });
		snapshot.resolve(f.info.state);
		await assert.rejects(resolution, /BrowserTargetUnavailable/);
		assert.throws(() => input.resolve(), /BrowserTargetUnavailable/);
	});

	test('disposing a resolved input preserves its latest presentation for serialization', async () => {
		using f = fixture();
		const input = f.input(data);
		const model = await input.resolve();
		f.events.fire({ type: 'stateChanged', state: { ...model.state, url: 'https://example.test/latest', title: 'Latest title' } });
		input.dispose();
		assert.deepEqual(input.serialize(), { ...data, url: 'https://example.test/latest', title: 'Latest title' });
	});

	test('split editors share one selection source and model disposal rejects a late screenshot', async () => {
		using f = fixture();
		const contexts = new ChatContextPickService();
		f.instantiation.registerInstance(IChatContextPickService, contexts);
		const input = f.input(data);
		const model = await input.resolve();
		using modelChanges = new Emitter<{ model: IBrowserViewModel | undefined; isNew: boolean; }>();
		const editor = { onDidChangeModel: modelChanges.event, model, setStatus: () => { } } as unknown as BrowserEditor;
		using left = f.instantiation.createInstance(BrowserEditorChatIntegration, editor);
		using right = f.instantiation.createInstance(BrowserEditorChatIntegration, editor);
		modelChanges.fire({ model, isNew: false });
		assert.equal(contexts.items.length, 1);
		f.events.fire({ type: 'elementPicked', targetId: id, data: { elementId: 'element-one', comment: 'Review spacing', outerHTML: '<button>Pick</button>', computedStyle: 'display: block', bounds: { x: 0, y: 0, width: 30, height: 20 } } });
		const picks = await readContextPicks(contexts.items[0]!, 'Review');
		assert.equal(picks.length, 1);
		assert.match((await (await selectedAttachment(picks[0]!)).resolve()).content, /Review spacing/);
		left.dispose();
		assert.equal(contexts.items.length, 1);
		const screenshot = promiseWithResolvers<VSBuffer>();
		f.service.captureScreenshot = () => screenshot.promise;
		f.events.fire({ type: 'areaPicked', targetId: id, rect: { x: 0, y: 0, width: 30, height: 20 } });
		input.dispose();
		screenshot.resolve(VSBuffer.fromString('late screenshot'));
		await screenshot.promise;
		assert.equal(contexts.items.length, 0);
	});

	test('the blank browser tab uses the selected Chinese catalog', () => {
		using f = fixture();
		const catalog = productLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
		setNlsMessages('zh-CN', catalog.bundles);
		try { assert.equal(f.input({ ...data, url: 'about:blank', title: '' }).label, '浏览器'); }
		finally { resetNlsResolver(); }
	});
});

function fixture() {
	const store = new DisposableStore();
	const events = store.add(new Emitter<BrowserViewEvent>());
	const f = {
		[Symbol.dispose]: () => store.dispose(), events, creations: 0, closed: 0,
		info: { id, host: { windowId: 1 }, owner: { type: 'user' }, session: data.session, state: { targetId: id, url: data.url, title: 'Live page', loading: false, visible: false, canGoBack: false, canGoForward: false } } as IBrowserViewInfo,
	};
	const service: BrowserService = {
		setContentVisibility: async () => { }, respondToPasswordSave: async () => { }, respondToPasswordFill: async () => { }, respondToAuthentication: async () => { }, setPermissions: async () => { }, respondToFileRequest: async () => { },
		toggleDevTools: async () => { }, clearStorage: async () => { }, setBrowserZoomIndex: async () => { }, setDeviceEmulation: async () => { },
		updateWindowConfiguration: async () => { }, getConsoleLogs: async () => '', getSelectedText: async () => '', getAccessibilityTree: async () => '', findInPage: async () => { }, stopFindInPage: async () => { },
		toggleElementSelection: async () => { }, setElementComments: async () => { }, toggleAreaSelection: async () => { }, captureScreenshot: async () => { throw new Error('Unexpected screenshot'); },
		getBrowserHistory: async () => ({ items: [] }), deleteBrowserHistory: async () => { },
		getSharing: async () => [], setSharing: async () => { },
		respondToPermission: async () => { }, clearPermissions: async () => { }, cancelDownloads: async () => { },
		getBrowserViews: async () => [f.info], getOrCreateBrowserView: async () => { f.creations++; return f.info; }, getState: async () => f.info.state,
		layout: async () => { }, setVisible: async () => { }, loadURL: async () => { }, goBack: async () => { }, goForward: async () => { }, reload: async () => { }, stop: async () => { }, focus: async () => { },
		destroyBrowserView: async () => { f.closed++; }, onDidEvent: events.event,
	};
	const instantiation = store.add(new InstantiationService(new ServiceCollection([IBrowserViewService, service])));
	const input = (inputData: IBrowserEditorInputData) => store.add(instantiation.createInstance(BrowserEditorInput, inputData));
	instantiation.registerInstance(IBrowserViewWorkbenchService, {
		onDidChangeBrowserViews: Event.None,
		initialize: async () => { }, getKnownBrowserViews: () => new Map(), getContextualBrowserViews: () => new Map(),
		registerContextualFilter: () => Disposable.None, registerOpenHandler: () => Disposable.None,
		getOrCreateLazy: input, createBrowserView: async () => { throw new Error('Not used in serializer fixture'); },
	});
	return Object.assign(f, { service, instantiation, input });
}


async function readContextPicks(source: IChatContextPickerItem | IChatContextValueItem, query: string): Promise<IChatContextPickerPickItem[]> {
	if (source.type !== 'pickerPick') throw new Error('Expected the registered picker contract');
	const picker = source.asPicker();
	const cancellation = new CancellationTokenSource();
	try {
		if (typeof picker.picks !== 'function') return (await picker.picks).filter(isChatContextPickerPickItem);
		const state = picker.picks(observableValue('test.query', query), cancellation.token);
		if (!state.get().busy) {
			if (state.get().error) throw state.get().error;
			return state.get().picks.filter(isChatContextPickerPickItem);
		}
		return await new Promise((resolve, reject) => {
			const listener = state.onDidChange(value => {
				if (value.busy) return;
				listener.dispose();
				if (value.error) reject(value.error);
				else resolve(value.picks.filter(isChatContextPickerPickItem));
			});
		});
	} finally { cancellation.dispose(true); picker.dispose?.(); }
}

async function selectedAttachment(item: IChatContextPickerPickItem): Promise<ChatContextAttachment> {
	const result = await item.asAttachment();
	if (result === 'noop' || Array.isArray(result)) throw new Error('Expected one captured context');
	return result;
}
