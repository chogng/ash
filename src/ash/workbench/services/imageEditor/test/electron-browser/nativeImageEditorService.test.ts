import assert from 'node:assert/strict';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { NATIVE_HOST_DESKTOP_SCREENSHOT_CHANNEL } from '../../../../../platform/native/common/nativeHost.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IHostService } from '../../../host/browser/host.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IWebviewService } from '../../../../contrib/webview/browser/webview.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Native extension image acquisition', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	let read: () => Promise<unknown>;
	let Service: typeof import('../../electron-browser/nativeImageEditorService.js').NativeImageEditorService;
	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: { ipcRenderer: { invoke: (channel: string) => { assert.equal(channel, NATIVE_HOST_DESKTOP_SCREENSHOT_CHANNEL); return read(); } } } });
		Service = (await import('../../electron-browser/nativeImageEditorService.js')).NativeImageEditorService;
	});
	suiteTeardown(() => { if (previous) { Object.defineProperty(globalThis, 'ash', previous); } else { Reflect.deleteProperty(globalThis, 'ash'); } });
	function fixture(services: InstantiationService) {
		services.registerInstance(IHostService, {} as IHostService);
		services.registerInstance(IWebviewService, {} as IWebviewService);
		services.registerInstance(IClipboardService, {} as IClipboardService);
		services.registerInstance(IFileDialogService, {} as IFileDialogService);
		services.registerInstance(IFileService, {} as IFileService);
		class Acquisition extends Service { public read(signal: AbortSignal) { return this.getImage(signal); } }
		return services.createInstance(Acquisition);
	}
	test('native contributes pixels without opening a presentation window', async () => {
		using services = new InstantiationService();
		using editor = fixture(services);
		const bytes = new Uint8Array(33);
		bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
		new DataView(bytes.buffer).setUint32(16, 1);
		new DataView(bytes.buffer).setUint32(20, 1);
		read = async () => bytes;
		assert.deepEqual(await editor.read(new AbortController().signal), bytes);
	});
	test('late native pixels are discarded after cancellation', async () => {
		using services = new InstantiationService();
		using editor = fixture(services);
		const pending = new DeferredPromise<Uint8Array>();
		read = () => pending.p;
		const controller = new AbortController();
		const result = editor.read(controller.signal);
		controller.abort();
		await pending.complete(new Uint8Array(100));
		assert.equal(await result, undefined);
	});
	test('malformed native pixels fail at the IPC boundary', async () => {
		using services = new InstantiationService();
		using editor = fixture(services);
		read = async () => new Uint8Array(100);
		await assert.rejects(editor.read(new AbortController().signal), /Invalid image PNG/);
	});
});
