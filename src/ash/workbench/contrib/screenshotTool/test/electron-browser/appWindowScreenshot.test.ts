import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Event, Emitter } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import type { INativeAppWindows } from '../../../../../platform/native/common/native.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { INativeHostService } from '../../../../common/services.js';
import { getScreenshotToolImageData } from '../../browser/screenshotTool.js';
import { AppWindowScreenshotService } from '../../electron-browser/appWindowScreenshot.js';

const window = { sourceId: 'window:42:0', title: 'Synthetic app' };
const bytes = new Uint8Array(33);
bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
new DataView(bytes.buffer).setUint32(16, 600);
new DataView(bytes.buffer).setUint32(20, 400);
const image = VSBuffer.wrap(bytes);

function fixture(lifetime: DisposableStore) {
	const services = lifetime.add(new InstantiationService());
	const shown = lifetime.add(new Emitter<void>());
	const accepted = lifetime.add(new Emitter<void>());
	const hidden = lifetime.add(new Emitter<void>());
	const calls: string[] = [];
	const state = { windows: { kind: 'windows', windows: [window] } as INativeAppWindows, items: [] as readonly (IQuickPickItem & { window: typeof window; })[], selected: [] as readonly (IQuickPickItem & { window: typeof window; })[], disposed: false, read: async () => image };
	services.registerInstance(INativeHostService, {
		focusWindow: async () => { calls.push('focus'); },
		getAppWindows: async () => { calls.push('list'); return state.windows; },
		captureAppWindow: async value => { assert.deepEqual(value, window); calls.push('capture'); return state.read(); },
	} as INativeHostApi);
	services.registerInstance(IStorageService, { getBoolean: () => false, onDidChangeValue: Event.None, store() { } } as unknown as IStorageService);
	services.registerInstance(INotificationService, {
		info: () => calls.push('notice'), notify: () => calls.push('permission'),
	} as unknown as INotificationService);
	services.registerInstance(IQuickInputService, {
		createQuickPick: () => ({
			set items(items: typeof state.items) { state.items = items; },
			get selectedItems() { return state.selected; },
			onDidAccept: accepted.event, onDidHide: hidden.event, onDidChangeValue: Event.None,
			show: () => { calls.push('pick'); shown.fire(); },
			dispose: () => { state.disposed = true; },
			[Symbol.dispose]: () => { state.disposed = true; },
		})
	} as unknown as IQuickInputService);
	return { services, state, calls, shown, accepted, hidden, service: services.createInstance(AppWindowScreenshotService) };
}

suite('App window screenshot acquisition', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('production DI requires the native owner', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(AppWindowScreenshotService));
	});
	test('automatic capture returns the window identity and intrinsic pixels', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		const result = await f.service.capture();
		assert.equal(result.kind, 'captured');
		assert.ok(result.kind === 'captured');
		assert.deepEqual(result.window, window);
		assert.deepEqual([result.image.width, result.image.height], [600, 400]);
		assert.deepEqual(getScreenshotToolImageData(result.image).data.buffer, image.buffer);
		assert.deepEqual(f.calls, ['list', 'capture']);
	});
	test('a picked capture uses the selected window and releases its picker', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		const shown = new Promise<void>(resolve => lifetime.add(f.shown.event(resolve)));
		const pending = f.service.capture({ pick: true });
		await shown;
		f.state.selected = [f.state.items[0]];
		f.accepted.fire();
		assert.equal((await pending).kind, 'captured');
		assert.deepEqual(f.calls, ['list', 'pick', 'capture']);
		assert.equal(f.state.disposed, true);
	});
	test('permission and empty-window results never acquire pixels or open an editor', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		f.state.windows = { kind: 'permissionRequired' };
		assert.equal((await f.service.capture()).kind, 'permissionRequired');
		f.state.windows = { kind: 'windows', windows: [] };
		assert.equal((await f.service.capture()).kind, 'noWindow');
		assert.deepEqual(f.calls, ['list', 'list', 'focus', 'notice']);
	});
	test('canceling the picker releases it without capturing', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		const controller = new AbortController();
		const shown = new Promise<void>(resolve => lifetime.add(f.shown.event(resolve)));
		const pending = f.service.capture({ pick: true, signal: controller.signal });
		await shown; controller.abort();
		assert.equal((await pending).kind, 'cancelled');
		assert.deepEqual(f.calls, ['list', 'pick']);
		assert.equal(f.state.disposed, true);
	});
	test('retiring a draft during native capture prevents a late image editor', async () => {
		using lifetime = new DisposableStore(); const f = fixture(lifetime);
		const captured = new DeferredPromise<void>();
		const result = new DeferredPromise<VSBuffer>();
		f.state.read = () => { void captured.complete(); return result.p; };
		const controller = new AbortController();
		const pending = f.service.capture({ signal: controller.signal });
		await captured.p; controller.abort(); await result.complete(image);
		assert.equal((await pending).kind, 'cancelled');
		assert.deepEqual(f.calls, ['list', 'capture']);
	});
});
