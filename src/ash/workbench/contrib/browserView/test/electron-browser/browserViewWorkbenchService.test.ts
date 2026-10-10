import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IBrowserViewService, BrowserViewStorageScope, type BrowserViewEvent, type IBrowserViewInfo } from '../../../../../platform/browserView/common/browserView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { DialogsModel, IDialogsModel } from '../../../../common/dialogs.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import type { EditorPartChangeEvent } from '../../../../services/editor/common/editorState.js';
import { BrowserViewWorkbenchService } from '../../electron-browser/browserViewWorkbenchService.js';

const id = 'browser_target_123e4567-e89b-12d3-a456-426614174000';
const info: IBrowserViewInfo = {
	id, host: { windowId: 1 }, owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace },
	state: { targetId: id, url: 'https://example.test/', title: 'Original page', loading: false, visible: false, canGoBack: false, canGoForward: false },
};

suite('Browser Workbench page lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('close reaches model consumers and finishes closing the old editor before opening a replacement', async () => {
		using f = fixture();
		await f.views.initialize();
		const original = f.views.getKnownBrowserViews().get(id)!;
		const model = await original.resolve();
		f.groupInputs.push(original);
		const closing = promiseWithResolvers<void>();
		const closed = promiseWithResolvers<void>();
		f.closeEditor = async input => {
			closing.resolve();
			await closed.promise;
			f.groupInputs.splice(f.groupInputs.indexOf(input), 1);
			return true;
		};
		const received: string[] = [];
		using listener = model.onDidClose(() => {
			received.push('closed');
			f.info = { ...info, state: { ...info.state, title: 'Replacement page' } };
			f.events.fire({ type: 'created', info: f.info });
		});
		f.events.fire({ type: 'closed', targetId: id });
		assert.deepEqual(received, ['closed']);
		await closing.promise;
		assert.deepEqual(f.opened, []);
		closed.resolve();
		await f.editorOpened.promise;
		const replacement = f.views.getKnownBrowserViews().get(id)!;
		assert.deepEqual([original.isDisposed, replacement !== original, replacement.label, f.groupInputs, f.destroyed], [true, true, 'Replacement page', [replacement], []]);
	});

	test('Workbench shutdown releases an input whose page close is still pending', async () => {
		using f = fixture();
		await f.views.initialize();
		const input = f.views.getKnownBrowserViews().get(id)!;
		f.events.fire({ type: 'closed', targetId: id });
		f.views.dispose();
		assert.equal(input.isDisposed, true);
		await Promise.resolve();
	});

	test('creation rejects if Main closes the reserved page before returning its snapshot', async () => {
		using f = fixture();
		const snapshot = promiseWithResolvers<IBrowserViewInfo>();
		const requested = promiseWithResolvers<string>();
		f.service.getOrCreateBrowserView = async targetId => { requested.resolve(targetId); return snapshot.promise; };
		const creation = f.views.createBrowserView({ initialUrl: 'about:blank', owner: { type: 'user' }, session: info.session });
		const targetId = await requested.promise;
		f.events.fire({ type: 'closed', targetId });
		snapshot.resolve({ ...info, id: targetId, state: { ...info.state, targetId } });
		await assert.rejects(creation, /BrowserTargetUnavailable/);
		assert.deepEqual([f.views.getKnownBrowserViews().has(targetId), f.opened], [false, []]);
	});

	test('initial discovery can recover after failure and still replay events received before its snapshot', async () => {
		using f = fixture();
		let attempts = 0;
		f.service.getBrowserViews = async () => {
			if (++attempts === 1) { throw new Error('Discovery unavailable'); }
			return [];
		};
		f.events.fire({ type: 'created', info });
		await assert.rejects(f.views.initialize(), /Discovery unavailable/);
		await f.views.initialize();
		await f.editorOpened.promise;
		assert.deepEqual([attempts, f.views.getKnownBrowserViews().size, f.opened.length], [2, 1, 1]);
	});

	test('restoration waits for a buffered close before exposing the initial page set', async () => {
		using f = fixture();
		const input = f.views.getOrCreateLazy({ id, url: info.state.url, title: info.state.title, session: info.session });
		f.groupInputs.push(input);
		const snapshot = promiseWithResolvers<readonly IBrowserViewInfo[]>();
		const closing = promiseWithResolvers<void>();
		const closed = promiseWithResolvers<void>();
		f.service.getBrowserViews = () => snapshot.promise;
		f.closeEditor = async () => { closing.resolve(); await closed.promise; f.groupInputs.length = 0; return true; };
		let ready = false;
		const initialization = f.views.initialize().then(() => { ready = true; });
		f.events.fire({ type: 'closed', targetId: id });
		snapshot.resolve([info]);
		await closing.promise;
		await Promise.resolve();
		assert.equal(ready, false);
		closed.resolve();
		await initialization;
		assert.deepEqual([input.isDisposed, f.views.getKnownBrowserViews().size, f.groupInputs], [true, 0, []]);
	});
});

function fixture() {
	const resources = new DisposableStore();
	const events = resources.add(new Emitter<BrowserViewEvent>());
	const editorEvents = resources.add(new Emitter<EditorPartChangeEvent>());
	const f = {
		info, events, groupInputs: [] as IResourceEditorInput[], opened: [] as IResourceEditorInput[], destroyed: [] as string[],
		editorOpened: promiseWithResolvers<void>(),
		closeEditor: async (input: IResourceEditorInput): Promise<boolean> => { f.groupInputs.splice(f.groupInputs.indexOf(input), 1); return true; },
	};
	const service: IBrowserViewService = {
		getBrowserViews: async () => [f.info], getOrCreateBrowserView: async () => f.info, getState: async () => f.info.state,
		getSharing: async () => [], setSharing: async () => { }, respondToPermission: async () => { }, clearPermissions: async () => { }, cancelDownloads: async () => { },
		loadURL: async () => { }, goBack: async () => { }, goForward: async () => { }, reload: async () => { }, stop: async () => { }, focus: async () => { }, layout: async () => { }, setVisible: async () => { },
		destroyBrowserView: async targetId => { f.destroyed.push(targetId); }, onDidEvent: events.event,
	};
	const editors: IEditorService = {
		...emptyEditorServiceState,
		onDidActiveEditorChange: Event.None, onDidVisibleEditorsChange: Event.None, activeEditor: undefined, visibleEditors: [], focusActiveEditor: () => { },
		openEditor: async input => {
			f.opened.push(input);
			if ('resolve' in input && typeof input.resolve === 'function') { await input.resolve(); }
			f.groupInputs.push(input);
			f.editorOpened.resolve();
		},
	};
	const editorPart = {
		onDidChangeEditors: editorEvents.event,
		groups: [{ inputs: f.groupInputs, closeEditor: (input: IResourceEditorInput) => f.closeEditor(input) }],
	} as unknown as IEditorPart;
	const dialogs = resources.add(new DialogsModel());
	const services = resources.add(new InstantiationService(new ServiceCollection([IBrowserViewService, service], [IEditorService, editors], [IEditorPart, editorPart], [IDialogsModel, dialogs])));
	const views = resources.add(services.createInstance(BrowserViewWorkbenchService));
	return Object.assign(f, { [Symbol.dispose]: () => resources.dispose(), views, service });
}
