import { readFile } from 'node:fs/promises';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { JSDOM } from 'jsdom';
import { setARIAContainer } from '../../../../../base/browser/ui/aria/aria.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue, constObservable } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { NullLoggerService } from '../../../../../platform/log/common/log.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { CanvasesEnabledSettingId } from '../../../../../platform/agentHost/common/agentService.js';
import { BrowserStorageService } from '../../../../../workbench/services/storage/browser/storageService.js';
import type { IAgentHostCanvasCollection } from '../../../../../workbench/contrib/canvases/common/agentHostCanvas.js';
import type { ICanvas, ICanvasOwner, ICanvasReference } from '../../../../../workbench/contrib/canvases/common/canvas.js';
import type { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import type { ISessionsProvidersService } from '../../../../services/sessions/browser/sessionsProvidersService.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import type { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import { AbstractCustomView } from '../../../../services/customView/browser/customView.js';
import { CustomViewService } from '../../../../services/customView/browser/customViewService.js';
import { PinnedCanvasService } from '../../browser/pinnedCanvasService.js';
import { MAX_PINNED_CANVASES, PINNED_CANVAS_PAGE_ID, PinnedCanvasState } from '../../browser/pinnedCanvases.js';

class Page extends AbstractCustomView {
	readonly title = constObservable('Canvas');
	render(): void { }
	layout(): void { }
}

suite('Pinned Canvas ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('persists identities without URLs, deduplicates pins and enforces the sidebar limit', () => {
		using f = fixture();
		for (let index = 0; index < MAX_PINNED_CANVASES; index++) { assert.equal(f.pins.pin(f.reference(index)), true); }
		assert.equal(f.pins.pin(f.reference(0)), true);
		assert.equal(f.pins.pin(f.reference(5)), false);
		assert.equal(f.pins.entries.get().length, MAX_PINNED_CANVASES);
		const saved = f.storage.get('sessions.pinnedCanvases', StorageScope.PROFILE)!;
		assert.equal(saved.includes('secret'), false);
		assert.equal(saved.includes('agent-host-canvas'), false);
		assert.equal(JSON.parse(saved).pins[0].instanceId, 'instance-0');
		assert.equal(f.warnings.length, 1);
	});

	test('rejects saved source fields at the persistence boundary and translates limit announcements', async () => {
		using original = fixture(); original.pins.pin(original.reference(0));
		const saved = JSON.parse(original.storage.get('sessions.pinnedCanvases', StorageScope.PROFILE)!);
		saved.pins[0].url = 'https://secret.test/?token=private';
		using invalid = fixture(JSON.stringify(saved));
		assert.equal(invalid.pins.entries.get().length, 0);
		assert.equal(invalid.errors.length, 1);
		try {
			setNlsMessages('zh-CN', JSON.parse(await readFile('extensions/language-pack-zh-cn/translations/workbench.json', 'utf8')));
			using chinese = fixture();
			for (let index = 0; index <= MAX_PINNED_CANVASES; index++) { chinese.pins.pin(chinese.reference(index)); }
			assert.deepEqual(chinese.warnings, ['最多可将 5 个 Canvas 固定到侧栏。']);
		} finally { resetNlsResolver(); }
	});

	test('full pages retain their own navigation state and unpinning keeps the underlying page', async () => {
		using f = fixture();
		f.pins.pin(f.reference(0)); f.pins.pin(f.reference(1));
		const [first, second] = f.pins.entries.get();
		await f.pins.show(first!);
		assert.equal(f.pins.selected.get(), first);
		await f.pins.show(second!);
		assert.equal(f.views.activeCustomViewOpen.get()?.state, second!.id);
		f.views.showCustomView(PINNED_CANVAS_PAGE_ID, { source: 'history', state: first!.id });
		assert.equal(f.pins.selected.get(), first);
		f.pins.unpin(first!);
		assert.equal(f.views.activeCustomView.get(), undefined);
		assert.equal(f.membership.get()!.length, 6);
		f.views.showCustomView(PINNED_CANVAS_PAGE_ID, { source: 'history', state: first!.id });
		assert.equal(f.views.activeCustomView.get(), undefined, 'Removed pin history must not reopen an empty page');
	});

	test('unknown membership preserves a pin; confirmed closure removes it and hides the full page', async () => {
		using f = fixture();
		f.pins.pin(f.reference(0));
		const pin = f.pins.entries.get()[0]!;
		await f.pins.show(pin);
		f.membership.set(undefined);
		assert.equal(pin.state.get(), PinnedCanvasState.Pending);
		assert.equal(pin.canvas.get(), undefined);
		assert.equal(f.pins.entries.get()[0], pin);
		f.membership.set([]);
		assert.equal(f.pins.entries.get().length, 0);
		assert.equal(f.views.activeCustomView.get(), undefined);
	});

	test('restoration matches stable provider identity to a new live target and never restores a page URL', async () => {
		using f = fixture();
		f.pins.pin(f.reference(0));
		const saved = f.storage.get('sessions.pinnedCanvases', StorageScope.PROFILE)!;
		using restored = fixture(saved, null);
		const pin = restored.pins.entries.get()[0]!;
		assert.equal(restored.views.activeCustomView.get(), undefined);
		assert.equal(pin.reference.get(), undefined);
		restored.membership.set([{ ...f.membership.get()![0]!, resource: URI.parse('agent-host-canvas:/new-target') }]);
		assert.equal(pin.reference.get()?.canvas.path, '/new-target');
		assert.equal(pin.state.get(), PinnedCanvasState.Live);
		await restored.pins.show(pin);
		assert.equal(restored.pins.isShown(pin.reference.get()!), true);
	});

	test('disable preserves pins, reconnect uses the provider, and close ends only the selected Canvas', async () => {
		using f = fixture();
		f.pins.pin(f.reference(0));
		const pin = f.pins.entries.get()[0]!;
		await f.pins.show(pin);
		f.setEnabled(false);
		assert.equal(f.pins.entries.get().length, 0);
		assert.equal(f.views.activeCustomView.get(), undefined);
		assert.equal(JSON.parse(f.storage.get('sessions.pinnedCanvases', StorageScope.PROFILE)!).pins.length, 1);
		f.setEnabled(true);
		await f.pins.reconnect(pin);
		assert.deepEqual(f.opened, ['instance-0']);
		await f.pins.closeCanvas(pin);
		assert.deepEqual(f.closed, ['instance-0']);
		assert.equal(f.pins.entries.get().length, 0);
	});

	test('catalog loss during disconnect preserves pins and a confirmed deletion retires them', () => {
		using f = fixture();
		f.sessions.push({ sessionId: 'session', kind: 'code' as const, title: 'Conversation', status: 'active', chats: [] } as unknown as ISession);
		f.pins.pin(f.reference(0));
		f.connection.set('disconnected'); f.sessions.splice(0); f.catalog.fire();
		assert.equal(f.pins.entries.get().length, 1);
		f.connection.set('connected');
		assert.equal(f.pins.entries.get().length, 0);
	});

	test('a connection retirement can release a native target without removing its saved pin', async () => {
		using f = fixture(); f.pins.pin(f.reference(0));
		const pin = f.pins.entries.get()[0]!;
		f.connection.set('disconnected'); f.membership.set([]);
		assert.equal(pin.state.get(), PinnedCanvasState.Pending);
		f.connection.set('connected');
		assert.equal(f.pins.entries.get()[0], pin);
		assert.equal(pin.state.get(), PinnedCanvasState.Unavailable);
		await f.pins.reconnect(pin);
		assert.deepEqual(f.opened, ['instance-0']);
	});

	test('archiving the owner retires its pin without changing another pin', () => {
		using f = fixture();
		f.pins.pin(f.reference(0));
		f.sessions.push({ sessionId: 'session', kind: 'code' as const, title: 'Conversation', status: 'archived', chats: [] } as unknown as ISession);
		f.catalog.fire();
		assert.equal(f.pins.entries.get().length, 0);
	});
});

function fixture(saved?: string, initial: readonly ICanvas[] | null = Array.from({ length: 6 }, (_, index) => ({
	resource: URI.parse('agent-host-canvas:/target-' + index), instanceId: 'instance-' + index, title: 'Board ' + index,
	extensionId: 'fixture', canvasId: 'board', source: URI.parse('https://secret.test/?token=private'),
}))) {
	const lifetime = new DisposableStore();
	const dom = new JSDOM('', { url: 'https://pins.test', pretendToBeVisual: true });
	lifetime.add(toDisposable(() => dom.window.close()));
	lifetime.add(setARIAContainer(dom.window.document.body));
	const storage = lifetime.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, workspaceId: 'pins', flushInterval: 0 }));
	if (saved) { storage.store('sessions.pinnedCanvases', saved, StorageScope.PROFILE, StorageTarget.USER); }
	const views = lifetime.add(new CustomViewService(new NullLoggerService(), storage));
	const catalog = lifetime.add(new Emitter<void>());
	const configurationChanges = lifetime.add(new Emitter<unknown>());
	let enabled = true;
	const sessions: ISession[] = [];
	const connection = observableValue<'connected' | 'disconnected'>('test', 'connected');
	const membership = observableValue<readonly ICanvas[] | undefined>('test', initial ?? undefined);
	const closed: string[] = [], opened: string[] = [], warnings: string[] = [], errors: string[] = [];
	const owner: ICanvasOwner = { providerId: 'local-agent-host', session: URI.parse('ash-session:/session'), chat: URI.parse('ash-thread:/thread') };
	const collection = {
		createContext: () => ({
			owner, canvases: membership,
			definitionProvider: { listCanvases: async () => [{ extensionId: 'fixture', canvasId: 'board' }], openCanvas: async (_definition: unknown, instanceId: string) => { opened.push(instanceId); } },
			closeCanvas: async (canvas: ICanvas) => { closed.push(canvas.instanceId!); membership.set(membership.get()!.filter(candidate => candidate !== canvas)); },
		})
	} as unknown as IAgentHostCanvasCollection;
	const pins = lifetime.add(new PinnedCanvasService(collection, { onDidChange: catalog.event, state: 'ready', get sessions() { return sessions; } } as unknown as ISessionsManagementService, { openThread: async () => { views.hideCustomView(); } } as unknown as ISessionsService,
		{ onDidChangeProviders: Event.None, getProvider: () => ({ connectionStatus: connection }) } as unknown as ISessionsProvidersService, views, { onDidChangeConfiguration: configurationChanges.event, getValue: (key: string) => key === CanvasesEnabledSettingId ? enabled : false } as unknown as IConfigurationService,
		storage, { warn: (message: string) => warnings.push(message), error: (message: string) => errors.push(message) } as unknown as INotificationService));
	lifetime.add(views.registerCustomView({ id: PINNED_CANVAS_PAGE_ID, ctor: new SyncDescriptor(Page), acceptsState: id => pins.entries.get().some(pin => pin.id === id) }, { restore: false }));
	return Object.assign(lifetime, {
		pins, storage, views, membership, sessions, catalog, connection, closed, opened, warnings, errors,
		reference: (index: number): ICanvasReference => ({ ...owner, canvas: URI.parse('agent-host-canvas:/target-' + index) }),
		setEnabled: (value: boolean) => { enabled = value; configurationChanges.fire({}); },
	});
}
