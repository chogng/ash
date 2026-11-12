import { languagePackCatalog as chineseCatalog } from '../../../../../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { suite, test } from 'mocha';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationError } from '../../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { constObservable, observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { AccessibleViewType, IAccessibleViewService } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { IBrowserViewService, BrowserViewStorageScope, type BrowserViewEvent, type IBrowserViewBounds, type IBrowserViewState } from '../../../../../platform/browserView/common/browserView.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import { IThemeService } from '../../../../../platform/theme/common/themeService.js';
import { DialogsModel, IDialogsModel } from '../../../../common/dialogs.js';
import { IEditorGroupsService } from '../../../../services/editor/common/editorGroupsService.js';
import { BrowserViewModel } from '../../../browserView/common/browserView.js';
import type { ICanvas, ICanvasReference } from '../../../../common/canvasReference.js';
import { CanvasInput, ICanvasContextService, ICanvasService, type ICanvasModelResolution } from '../../common/canvas.js';
import { CanvasEditor } from '../../electron-browser/canvasEditor.js';
import { CanvasView, getFocusedCanvasView, type ICanvasViewInput } from '../../electron-browser/canvasView.js';

suite('CanvasView presentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('keeps bounds ahead of visibility and lets another surface borrow the same live page', async () => {
		using f = fixture();
		const first = f.view(10);
		const second = f.view(400);
		const input = f.input('shared');
		const pending = promiseWithResolvers<void>();
		f.beforeLayout = () => pending.promise;
		first.setInput(input);
		first.setVisible(true);
		await settle(() => f.calls.includes('layout:shared'));
		assert.equal(f.states.get('shared')!.visible, false);
		pending.resolve();
		await settle(() => f.states.get('shared')!.visible);
		assert.ok(f.calls.indexOf('layout:shared') < f.calls.indexOf('visible:shared:true'));
		second.setInput(input);
		second.setVisible(true);
		await settle(() => f.bounds.get('shared')?.x === 400);
		second.setVisible(false);
		await settle(() => f.bounds.get('shared')?.x === 10);
		assert.equal(f.models.size, 1);
		assert.equal(f.models.get('shared')!.isDisposed, false);
	});

	test('leaves stale resolutions detached after switching inputs or losing the owner', async () => {
		using f = fixture();
		const view = f.view();
		const pending = promiseWithResolvers<ICanvasModelResolution>();
		const first = f.input('first');
		const second = f.input('second');
		f.resolve = reference => reference.canvas.path === '/first' ? pending.promise : Promise.resolve({ model: f.models.get('second')!, reused: true });
		view.setVisible(true);
		view.setInput(first);
		await settle(() => f.resolutions.length === 1);
		view.setInput(second);
		await settle(() => f.states.get('second')!.visible);
		pending.resolve({ model: f.models.get('first')!, reused: true });
		await turn();
		assert.equal(f.calls.includes('layout:first'), false);
		assert.equal(f.models.get('first')!.isDisposed, false);
		f.ownerVisible = false;
		f.visibility.fire();
		await settle(() => !f.states.get('second')!.visible);
		assert.equal(view.element.querySelector('[role="status"]')!.textContent, 'Owner unavailable');
	});

	test('retries the latest source after an older source fails, without displaying the old error', async () => {
		using f = fixture();
		const view = f.view();
		const input = f.input('page');
		const pending = promiseWithResolvers<ICanvasModelResolution>();
		f.resolve = () => f.resolutions.length === 1 ? pending.promise : Promise.resolve({ model: f.models.get('page')!, reused: true });
		view.setVisible(true);
		view.setInput(input);
		await settle(() => f.resolutions.length === 1);
		input.canvas.set({ ...input.canvas.get()!, source: URI.parse('https://example.test/recovered') });
		pending.reject(new Error('obsolete source'));
		await settle(() => f.states.get('page')!.visible);
		assert.equal(f.resolutions.length, 2);
		assert.equal(view.element.querySelector<HTMLElement>('[role="status"]')!.hidden, true);
	});

	test('recovers native focus only while the canvas retains workbench focus', async () => {
		using f = fixture();
		const view = f.view();
		const input = f.input('page');
		const canvas = input.canvas.get()!;
		view.setVisible(true);
		view.setInput(input);
		view.focus();
		await settle(() => f.calls.includes('focus:page'));
		f.calls.length = 0;
		input.canvas.set({ ...canvas, source: undefined });
		await settle(() => !f.states.get('page')!.visible);
		input.canvas.set(canvas);
		await settle(() => f.calls.includes('focus:page'));
		assert.equal(getFocusedCanvasView(), view);
		input.canvas.set({ ...canvas, source: undefined });
		await settle(() => !f.states.get('page')!.visible);
		const button = f.dom.window.document.createElement('button');
		f.dom.window.document.body.append(button);
		button.focus();
		f.calls.length = 0;
		input.canvas.set(canvas);
		await settle(() => f.states.get('page')!.visible);
		assert.equal(f.calls.includes('focus:page'), false);
		assert.equal(getFocusedCanvasView(), undefined);
	});

	test('holds a switch frame across clearInput and discards a late capture when hidden', async () => {
		using f = fixture();
		const view = f.view();
		view.setVisible(true);
		view.setInput(f.input('first'));
		await settle(() => f.states.get('first')!.visible);
		const capture = promiseWithResolvers<VSBuffer>();
		f.capture = () => capture.promise;
		view.clearInput();
		const input = f.input('second');
		input.membershipPending.set(true);
		view.setInput(input);
		capture.resolve(VSBuffer.fromString('frame'));
		const frame = view.element.querySelector<HTMLImageElement>('img')!;
		await settle(() => !frame.hidden);
		assert.equal(frame.getAttribute('aria-hidden'), 'true');
		view.setVisible(false);
		assert.equal(frame.hidden, true);
		assert.equal(frame.hasAttribute('src'), false);
		view.setVisible(true);
		input.membershipPending.set(false);
		await settle(() => f.states.get('second')!.visible);
		const late = promiseWithResolvers<VSBuffer>();
		f.capture = () => late.promise;
		view.clearInput();
		view.setVisible(false);
		late.resolve(VSBuffer.fromString('late'));
		await turn();
		assert.equal(frame.hasAttribute('src'), false);
	});

	test('cancellation does not spin or become a page error; translated pending content remains readable', async () => {
		try {
			setNlsMessages('zh-CN', chineseCatalog.bundles);
			using f = fixture();
			const view = f.view();
			f.resolve = () => { throw new CancellationError(); };
			view.setVisible(true);
			view.setInput(f.input('page'));
			await turn();
			assert.equal(f.resolutions.length, 1);
			assert.equal(view.element.querySelector('[role="status"]')!.textContent, '此 Canvas 正在重新连接…');
			using provider = view.createAccessibleProvider(AccessibleViewType.View);
			assert.equal(provider.provideContent(), '此 Canvas 正在重新连接…');
		} finally { resetNlsResolver(); }
	});

	test('accessible content follows the focused surface and ignores results from a previous input', async () => {
		using f = fixture();
		const first = f.view();
		const second = f.view(400);
		first.setInput(f.input('first'));
		second.setInput(f.input('second'));
		second.setVisible(true);
		await settle(() => f.states.get('second')!.visible);
		second.focus();
		assert.equal(getFocusedCanvasView(), second);
		using help = getFocusedCanvasView()!.createAccessibleProvider(AccessibleViewType.Help);
		assert.equal(help.provideContent(), 'Canvas fixture help');
		const reading = promiseWithResolvers<string>();
		f.read = () => reading.promise;
		using content = second.createAccessibleProvider(AccessibleViewType.View);
		second.setInput(f.input('third'));
		reading.resolve('Old conversation content');
		await turn();
		assert.notEqual(content.provideContent(), 'Old conversation content');
		second.dispose();
		assert.equal(getFocusedCanvasView(), undefined);
	});

	test('the editor abort signal cannot detach a later input or dispose a service-owned page', async () => {
		using f = fixture();
		const parent = f.dom.window.document.createElement('div');
		f.dom.window.document.body.append(parent);
		const editor = f.add(f.instantiation.createInstance(CanvasEditor));
		editor.create(parent);
		editor.setVisible(true);
		const first = f.input('first');
		const second = f.input('second');
		const firstAbort = new AbortController();
		const secondAbort = new AbortController();
		const firstInput = f.add(f.instantiation.createInstance(CanvasInput, first.reference, first.canvas.get()!));
		const secondInput = f.add(f.instantiation.createInstance(CanvasInput, second.reference, second.canvas.get()!));
		await editor.setInput(firstInput, firstAbort.signal);
		await editor.setInput(secondInput, secondAbort.signal);
		firstAbort.abort();
		await turn();
		assert.equal(editor.getContainer()!.querySelector('[role="region"]')!.getAttribute('aria-label'), 'Canvas: second');
		secondAbort.abort();
		assert.equal(editor.getContainer()!.querySelector('[role="status"]')!.textContent, '');
		assert.equal(f.models.get('second')!.isDisposed, false);
	});
});

function fixture() {
	const store = new DisposableStore();
	const dom = new JSDOM('<!doctype html><body></body>');
	store.add(toDisposable(() => dom.window.close()));
	const targetWindow = dom.window as unknown as Window & typeof globalThis;
	targetWindow.ResizeObserver = class implements ResizeObserver {
		observe(): void { }
		unobserve(): void { }
		disconnect(): void { }
	};
	const events = store.add(new Emitter<BrowserViewEvent>());
	const visibility = store.add(new Emitter<void>());
	const states = new Map<string, IBrowserViewState>();
	const models = new Map<string, BrowserViewModel>();
	const calls: string[] = [];
	const bounds = new Map<string, IBrowserViewBounds>();
	const resolutions: ICanvasReference[] = [];
	const f = Object.assign(store, {
		dom, visibility, states, models, calls, bounds, resolutions,
		ownerVisible: true,
		beforeLayout: () => Promise.resolve(),
		resolve: async (reference: ICanvasReference): Promise<ICanvasModelResolution> => ({ model: models.get(reference.canvas.path.slice(1))!, reused: true }),
		capture: async () => VSBuffer.fromString('frame'),
		read: async () => 'Canvas accessible content',
	});
	const service = {
		onDidEvent: events.event,
		layout: async (id: string, value: IBrowserViewBounds) => { calls.push('layout:' + id); await f.beforeLayout(); bounds.set(id, value); },
		setVisible: async (id: string, visible: boolean) => {
			calls.push(`visible:${id}:${visible}`);
			const state = { ...states.get(id)!, visible };
			states.set(id, state);
			events.fire({ type: 'stateChanged', state });
		},
		focus: async (id: string) => { calls.push('focus:' + id); },
		captureScreenshot: () => f.capture(),
		getAccessibilityTree: () => f.read(),
	} as unknown as IBrowserViewService;
	const instantiation = store.add(new InstantiationService(new ServiceCollection(
		[IBrowserViewService, service],
		[ILogService, new NullLoggerService()],
		[IDialogsModel, store.add(new DialogsModel())],
		[IContextMenuService, { onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None } as IContextMenuService],
		[IContextKeyService, store.add(new ContextKeyService())],
		[IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService],
		[ICanvasContextService, { onDidChangeVisibility: visibility.event } as unknown as ICanvasContextService],
		[ICanvasService, {
			enabled: constObservable(true), isOwnerPresentable: () => f.ownerVisible, isPresentable: () => f.ownerVisible,
			resolveCanvasModel: (reference: ICanvasReference) => { resolutions.push(reference); return f.resolve(reference); },
		} as unknown as ICanvasService],
		[IEditorGroupsService, {} as IEditorGroupsService],
		[IThemeService, { onDidColorThemeChange: Event.None, getColorTheme: () => ({}) } as unknown as IThemeService],
		[IStorageService, { onWillSaveState: Event.None } as unknown as IStorageService],
	)));
	return Object.assign(f, {
		instantiation,
		view: (left = 10) => {
			const parent = dom.window.document.createElement('div');
			dom.window.document.body.append(parent);
			const view = store.add(instantiation.createInstance(CanvasView, parent, targetWindow, {
				logPrefix: '[Canvas test]', notPresentableMessage: constObservable('Owner unavailable'), getHelpContent: () => 'Canvas fixture help',
			}));
			view.element.querySelector<HTMLElement>('[role="region"]')!.getBoundingClientRect = () => new dom.window.DOMRect(left, 20, 300, 200);
			return view;
		},
		input: (id: string) => {
			const state: IBrowserViewState = { targetId: id, isDevToolsOpen: false, url: 'https://example.test/' + id, title: id, loading: false, visible: false, canGoBack: false, canGoForward: false };
			states.set(id, state);
			models.set(id, store.add(instantiation.createInstance(BrowserViewModel, {
				id, state, host: { windowId: 1 }, owner: { type: 'user' }, session: { scope: BrowserViewStorageScope.Workspace },
			})));
			const reference = { providerId: 'local-agent-host', session: URI.parse('ash-session:/one'), chat: URI.parse('ash-thread:/one'), canvas: URI.parse('agent-host-canvas:/' + id) };
			return {
				reference,
				canvas: observableValue<ICanvas | undefined>('canvas', { resource: reference.canvas, instanceId: id, title: id, source: URI.parse(state.url) }),
				membershipPending: observableValue('membershipPending', false),
			} satisfies ICanvasViewInput;
		},
	});
}

async function turn(): Promise<void> { await new Promise(resolve => setImmediate(resolve)); }

async function settle(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100 && !condition(); attempt++) { await Promise.resolve(); }
	assert.equal(condition(), true, 'Expected Canvas presentation to settle');
}
