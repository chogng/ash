import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { promiseWithResolvers } from '../../../../../base/common/async.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { URI } from '../../../../../base/common/uri.js';
import {
	IBrowserViewService,
	BrowserViewStorageScope,
	type IBrowserViewInfo,
	type BrowserViewEvent,
} from '../../../../../platform/browserView/common/browserView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IEditorPart } from '../../../../browser/parts/editor/editorPart.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IEditorGroupsService, type IEditorGroup } from '../../../../services/editor/common/editorGroupsService.js';
import type { EditorPartChangeEvent } from '../../../../services/editor/common/editorState.js';
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { emptyEditorServiceState } from '../../../../test/common/testEditorService.js';
import { CanvasService } from '../../electron-browser/canvasService.js';
import { CanvasInput, ICanvasContextService } from '../../common/canvas.js';
import { readFile } from 'node:fs/promises';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { constObservable, observableValue, type IObservable } from '../../../../../base/common/observable.js';
import { Event } from '../../../../../base/common/event.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type {
	ICanvasContext,
	ICanvasOpenRequest,
	ICanvasWorkingSets,
	ICanvasWorkingSetState,
} from '../../common/canvas.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';

suite('Conversation Canvas presentation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('Canvas presentation descriptions use the non-default client language', async () => {
		const messages = JSON.parse(
			await readFile('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8'),
		);
		try {
			setNlsMessages('zh-CN', messages);
			using f = fixture([info('one', 'thread-one')]);
			await settle();
			assert.equal(
				(f.opened[0] as CanvasInput).getDescription(),
				'关闭此标签页会隐藏 Canvas。使用“打开 Canvas”可在其会话旁重新打开。',
			);
		} finally {
			resetNlsResolver();
		}
	});

	test('deduplicates native identity, preserves dismissal, and reveals only a new explicit open', async () => {
		using f = fixture();
		await settle();
		const page = info('one', 'thread-one');
		f.events.fire({ type: 'created', info: page });
		await settle();
		assert.equal(f.opened.length, 0);
		f.events.fire({ type: 'canvasOpened', targetId: page.id, info: page });
		await settle();
		assert.equal(f.opened.length, 1);
		const input = f.opened[0] as CanvasInput;
		assert.equal(f.canvases.restoreCanvasInput(input.serializationId), input);
		assert.equal(input.resource.toString().includes('secret'), false);
		await f.group.closeEditor(input);
		f.events.fire({ type: 'stateChanged', state: { ...page.state, url: 'https://secret.test/new?token=private' } });
		f.visibility.fire();
		await settle();
		assert.equal(f.opened.length, 1);
		const updated = {
			...page,
			state: { ...page.state, url: 'https://secret.test/updated' },
			canvas: { sessionId: 'session-one', instanceId: 'preview', title: 'Updated' },
		};
		f.events.fire({ type: 'canvasOpened', targetId: page.id, info: updated });
		await settle();
		assert.equal(f.opened.length, 2);
		assert.equal(f.opened[1], input);
		assert.equal(input.getName(), 'Updated');
		const { model } = await f.canvases.resolveCanvasModel(input.reference, input.canvas.get().source!);
		assert.equal(model.state.url, updated.state.url);
		assert.equal(model.info.canvas?.title, 'Updated');
		assert.deepEqual(f.failures, []);
	});

	test('keeps background conversations hidden and validates exact owner before reveal or close', async () => {
		using f = fixture([info('one', 'thread-one'), info('two', 'thread-two')]);
		await settle();
		assert.equal(f.opened.length, 1);
		assert.deepEqual(f.canvases.reopenableCanvases.get(), []);
		const first = f.opened[0] as CanvasInput;
		await assert.rejects(f.canvases.revealCanvas({ ...first.reference, providerId: 'other' }));
		await assert.rejects(f.canvases.closeCanvas({ ...first.reference, session: URI.parse('other:/owner') }));
		f.visible.clear();
		f.visible.add('thread-two');
		f.visibility.fire();
		await settle();
		assert.equal(f.canvases.isOwnerPresentable(first.reference), false);
		const second = f.opened[1] as CanvasInput;
		await f.canvases.closeCanvas(second.reference);
		await settle();
		assert.deepEqual(f.destroyed, ['two']);
		assert.deepEqual(f.canvases.reopenableCanvases.get(), []);
	});

	test('replays removals before presenting a late initial snapshot', async () => {
		const snapshot = promiseWithResolvers<readonly IBrowserViewInfo[]>();
		using f = fixture([], snapshot.promise);
		const page = info('one', 'thread-one');
		f.events.fire({ type: 'canvasOpened', targetId: page.id, info: page });
		await Promise.resolve();
		f.events.fire({ type: 'closed', targetId: page.id });
		snapshot.resolve([page]);
		await settle();
		assert.deepEqual(f.opened, []);
		assert.deepEqual(f.canvases.reopenableCanvases.get(), []);
	});

	test('a late editor open cannot retain a page removed during opening', async () => {
		using f = fixture();
		await settle();
		const opening = promiseWithResolvers<void>();
		f.waitForOpen = opening.promise;
		const page = info('one', 'thread-one');
		f.events.fire({ type: 'canvasOpened', targetId: page.id, info: page });
		await Promise.resolve();
		f.events.fire({ type: 'closed', targetId: page.id });
		opening.resolve();
		await settle();
		assert.deepEqual(f.inputs, []);
		assert.equal(f.canvases.restoreCanvasInput((f.opened[0] as CanvasInput).serializationId), undefined);
	});

	test('a user dismissal wins over a pending editor open', async () => {
		using f = fixture();
		await settle();
		const opening = promiseWithResolvers<void>();
		f.waitForOpen = opening.promise;
		const page = info('one', 'thread-one');
		f.events.fire({ type: 'canvasOpened', targetId: page.id, info: page });
		await Promise.resolve();
		await f.group.closeEditor(f.opened[0]!);
		opening.resolve();
		await settle();
		assert.deepEqual(f.inputs, []);
		assert.equal(f.canvases.reopenableCanvases.get().length, 1);
	});

	test('a successful explicit request is admitted after its pending state and metadata never reopens dismissal', async () => {
		const page = info('one', 'thread-one');
		const owner = {
			providerId: 'local-agent-host',
			session: URI.parse('ash-session:/session-one'),
			chat: URI.parse('ash-thread:/thread-one'),
		};
		const canvas = {
			resource: URI.parse('agent-host-canvas:/one'),
			instanceId: 'preview',
			title: 'Preview',
			source: URI.parse(page.state.url),
		};
		const canvases = observableValue('test', [canvas]);
		const requests = observableValue<ReadonlyMap<string, ICanvasOpenRequest>>(
			'test',
			new Map([['preview', { id: 'open-1', succeeded: false }]]),
		);
		using f = fixture([], undefined, { contexts: constObservable([{ owner, canvases, openRequests: requests }]) });
		await settle();
		f.events.fire({ type: 'created', info: page });
		await settle();
		assert.equal(f.opened.length, 0);
		requests.set(new Map([['preview', { id: 'open-1', succeeded: true }]]), undefined);
		await settle();
		assert.equal(f.opened.length, 1);
		await f.group.closeEditor(f.opened[0]!);
		canvases.set([{ ...canvas, title: 'Updated' }], undefined);
		await settle();
		assert.equal(f.opened.length, 1);
		requests.set(new Map([['preview', { id: 'open-2', succeeded: false }]]), undefined);
		await settle();
		assert.equal(f.opened.length, 1);
		requests.set(new Map([['preview', { id: 'open-2', succeeded: true }]]), undefined);
		await settle();
		assert.equal(f.opened.length, 2);
	});

	test('working-set application defers new requests and restores suspended inputs without taking focus', async () => {
		const state = observableValue<ICanvasWorkingSetState>('test', {
			owner: undefined,
			restoring: true,
			applying: true,
		});
		let suppressions = 0;
		using f = fixture([info('one', 'thread-one')], undefined, {
			workingSets: {
				state,
				registerEditorToRetain: () => Disposable.None,
				suppressEditorPartAutoVisibility: () => {
					suppressions++;
					return toDisposable(() => suppressions--);
				},
			},
		});
		await settle();
		assert.equal(f.opened.length, 0);
		state.set({ owner: undefined, restoring: false, applying: false }, undefined);
		await settle();
		assert.equal(f.opened.length, 1);
		state.set({ owner: undefined, restoring: true, applying: true }, undefined);
		await f.group.closeEditor(f.opened[0]!, { reason: 'reset' });
		f.visible.clear();
		f.visibility.fire();
		state.set({ owner: undefined, restoring: false, applying: false }, undefined);
		await settle();
		assert.equal(f.opened.length, 1);
		f.visible.add('thread-one');
		f.visibility.fire();
		await settle();
		assert.equal(f.opened.length, 2);
		assert.equal(f.options[1]?.preserveFocus, true);
		assert.equal(suppressions, 0);
	});

	test('dismissal after an explicit open starts wins over that request completing', async () => {
		const page = info('one', 'thread-one');
		const owner = {
			providerId: 'local-agent-host',
			session: URI.parse('ash-session:/session-one'),
			chat: URI.parse('ash-thread:/thread-one'),
		};
		const canvases = observableValue('test', [
			{
				resource: URI.parse('agent-host-canvas:/one'),
				instanceId: 'preview',
				title: 'Preview',
				source: URI.parse(page.state.url),
			},
		]);
		const requests = observableValue<ReadonlyMap<string, ICanvasOpenRequest>>(
			'test',
			new Map([['preview', { id: 'initial', succeeded: true }]]),
		);
		using f = fixture([page], undefined, {
			contexts: constObservable([{ owner, canvases, openRequests: requests }]),
		});
		await settle();
		requests.set(new Map([['preview', { id: 'updating', succeeded: false }]]), undefined);
		await f.group.closeEditor(f.opened[0]!);
		f.events.fire({ type: 'canvasOpened', targetId: page.id, info: page });
		requests.set(new Map([['preview', { id: 'updating', succeeded: true }]]), undefined);
		await settle();
		assert.equal(f.opened.length, 1);
		assert.equal(f.canvases.reopenableCanvases.get().length, 1);
	});

	test('a manual reveal waits for its source to recover without opening a stale page', async () => {
		const page = info('one', 'thread-one');
		const owner = {
			providerId: 'local-agent-host',
			session: URI.parse('ash-session:/session-one'),
			chat: URI.parse('ash-thread:/thread-one'),
		};
		const canvas = {
			resource: URI.parse('agent-host-canvas:/one'),
			instanceId: 'preview',
			title: 'Preview',
			source: URI.parse(page.state.url) as URI | undefined,
		};
		const source = observableValue('test', [canvas]);
		using f = fixture([page], undefined, { contexts: constObservable([{ owner, canvases: source }]) });
		await settle();
		const input = f.opened[0] as CanvasInput;
		await f.group.closeEditor(input);
		source.set([{ ...canvas, source: undefined }], undefined);
		await settle();
		await f.canvases.revealCanvas(input.reference);
		assert.equal(f.opened.length, 1);
		source.set([canvas], undefined);
		await settle();
		assert.equal(f.opened.length, 2);
	});
});

function info(id: string, thread: string): IBrowserViewInfo {
	return {
		id,
		host: { windowId: 1 },
		owner: { type: 'agent', sessionId: thread },
		session: { scope: BrowserViewStorageScope.Agent, affinity: thread },
		canvas: { sessionId: 'session-one', instanceId: 'preview', title: 'Preview' },
		state: {
			targetId: id,
			url: 'https://secret.test/app?token=private',
			title: '',
			loading: false,
			visible: false,
			canGoBack: false,
			canGoForward: false,
		},
	};
}

function fixture(
	snapshot: readonly IBrowserViewInfo[] = [],
	pendingSnapshot?: Promise<readonly IBrowserViewInfo[]>,
	contextOptions: { contexts?: IObservable<readonly ICanvasContext[]>; workingSets?: ICanvasWorkingSets } = {},
) {
	const resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	const events = resources.add(new Emitter<BrowserViewEvent>());
	const changes = resources.add(new Emitter<EditorPartChangeEvent>());
	const visibility = resources.add(new Emitter<void>());
	const inputs: IResourceEditorInput[] = [];
	const opened: IResourceEditorInput[] = [];
	const options: { preserveFocus?: boolean }[] = [];
	const destroyed: string[] = [];
	const failures: unknown[] = [];
	const visible = new Set(['thread-one']);
	const group = {
		id: 1,
		inputs,
		closeEditor: async (input: IResourceEditorInput, options?: { reason?: string }) => {
			const index = inputs.indexOf(input);
			if (index >= 0) {
				inputs.splice(index, 1);
			}
			changes.fire({
				kind: 'groupChanged',
				event: { kind: 'editorClosed', editor: { input }, reason: options?.reason },
			} as unknown as EditorPartChangeEvent);
			return true;
		},
	};
	services.registerInstance(IEditorPart, {
		groups: [group],
		onDidChangeEditors: changes.event,
	} as unknown as IEditorPart);
	services.registerInstance(IEditorGroupsService, {
		getGroup: (id: number) => (id === 1 ? group : undefined),
	} as unknown as IEditorGroupsService);
	services.registerInstance(ICanvasContextService, {
		contexts: contextOptions.contexts ?? constObservable([]),
		workingSets: contextOptions.workingSets,
		onDidRemoveOwner: Event.None,
		getContext: owner =>
			contextOptions.contexts?.get().find(context => context.owner.chat.toString() === owner.chat.toString()),
		getFrontendSessionResource: owner => owner.session,
		onDidChangeVisibility: visibility.event,
		isOwnerVisible: owner => visible.has(owner.chat.path.slice(1)),
		getEditorGroup: () => group as unknown as IEditorGroup,
	});
	services.registerInstance(IConfigurationService, {
		onDidChangeConfiguration: Event.None,
		getValue: () => undefined,
	} as unknown as IConfigurationService);
	services.registerInstance(INotificationService, {
		error: (error: unknown) => failures.push(error),
	} as unknown as INotificationService);
	services.registerInstance(IBrowserViewService, {
		onDidEvent: events.event,
		getBrowserViews: () => pendingSnapshot ?? Promise.resolve(snapshot),
		destroyBrowserView: async (id: string) => {
			destroyed.push(id);
			events.fire({ type: 'closed', targetId: id });
		},
	} as unknown as IBrowserViewService);
	const f = {
		[Symbol.dispose]: () => resources.dispose(),
		events,
		visibility,
		visible,
		opened,
		options,
		destroyed,
		failures,
		inputs,
		group,
		waitForOpen: Promise.resolve(),
	};
	services.registerInstance(IEditorService, {
		...emptyEditorServiceState,
		openEditor: async (input, settings) => {
			opened.push(input);
			options.push(settings ?? {});
			if (input instanceof CanvasInput) {
				await canvases.resolveCanvasModel(input.reference, input.canvas.get().source!);
			}
			await f.waitForOpen;
			if (!inputs.includes(input)) {
				inputs.push(input);
			}
		},
		focusActiveEditor: () => {},
	});
	const canvases = resources.add(services.createInstance(CanvasService));
	return Object.assign(f, { canvases, services });
}

function settle(): Promise<void> {
	return new Promise(resolve => setImmediate(resolve));
}
