import { IHostService } from '../../../../services/host/browser/host.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import assert from 'node:assert/strict';
import { suite, suiteSetup, suiteTeardown, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import type { VSBuffer } from '../../../../../base/common/buffer.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../../common/services.js';
import { IImageEditorService } from '../../../../services/imageEditor/common/imageEditorService.js';
import { IScreenCaptureSetupService } from '../../electron-browser/screenCaptureSetup.js';

suite('Desktop screenshot permission entry', () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, 'ash');
	let NativeScreenshotToolService: typeof import('../../electron-browser/nativeScreenshotToolService.js').NativeScreenshotToolService;
	suiteSetup(async () => {
		Object.defineProperty(globalThis, 'ash', { configurable: true, value: { ipcRenderer: {} } });
		NativeScreenshotToolService = (await import('../../electron-browser/nativeScreenshotToolService.js')).NativeScreenshotToolService;
	});
	suiteTeardown(() => { if (previous) { Object.defineProperty(globalThis, 'ash', previous); } else { Reflect.deleteProperty(globalThis, 'ash'); } });
	ensureNoDisposablesAreLeakedInTestSuite();
	function fixture(resources: DisposableStore, permission: () => ReturnType<INativeHostApi['getMediaAccessStatus']>, images: Partial<IImageEditorService> = { capture: async () => assert.fail('Permission setup must not capture pixels') }) {
		const services = resources.add(new InstantiationService());
		const setups: { readonly title: string; readonly signal: AbortSignal; }[] = [];
		services.registerInstance(IImageEditorService, images as IImageEditorService);
		services.registerInstance(IConfigurationService, { getValue: () => undefined } as unknown as IConfigurationService);
		services.registerInstance(INativeHostService, { getMediaAccessStatus: permission } as unknown as INativeHostApi);
		services.registerInstance(IHostService, {} as IHostService);
		services.registerInstance(IClipboardService, {} as IClipboardService);
		services.registerInstance(IFileDialogService, {} as IFileDialogService);
		services.registerInstance(IFileService, {} as IFileService);
		services.registerInstance(ILayoutService, {} as ILayoutService);
		services.registerInstance(IScreenCaptureSetupService, { show: async (options, signal) => { setups.push({ title: options.title, signal }); } });
		class Acquisition extends NativeScreenshotToolService {
			protected override capture(_options: unknown, signal: AbortSignal): Promise<VSBuffer | undefined> { return images.capture!(signal); }
		}
		const screenshots = resources.add(services.createInstance(Acquisition));
		return { screenshots, setups };
	}
	for (const entry of ['capture', 'show'] as const) {
		for (const latePermission of ['granted', 'denied'] as const) {
			test(`${entry} ignores an older ${latePermission} preflight after a newer screenshot opens`, async function () {
				if (!isMacintosh) this.skip();
				using resources = new DisposableStore();
				const permissions: DeferredPromise<'granted' | 'denied'>[] = [];
				const opened = new DeferredPromise<void>();
				const completed = new DeferredPromise<VSBuffer | undefined>();
				const signals: AbortSignal[] = [];
				const capture = (signal: AbortSignal) => {
					signals.push(signal);
					void opened.complete();
					return completed.p;
				};
				const value = fixture(resources, () => {
					const permission = new DeferredPromise<'granted' | 'denied'>();
					permissions.push(permission);
					return permission.p;
				}, { capture, show: async (_options, signal) => { await capture(signal); } });
				const run = () => entry === 'capture'
					? value.screenshots.captureAndEdit(new AbortController().signal)
					: value.screenshots.show({}, new AbortController().signal);
				const older = run();
				const newer = run();
				await permissions[1].complete('granted');
				await opened.p;
				await permissions[0].complete(latePermission);
				await older;
				assert.equal(signals.length, 1);
				assert.equal(signals[0].aborted, false);
				assert.deepEqual(value.setups, []);
				await completed.complete(undefined);
				await newer;
			});
		}
	}
	test('native screenshot construction requires the permission setup registration', () => {
		using services = new InstantiationService();
		services.registerInstance(IImageEditorService, {} as IImageEditorService);
		services.registerInstance(IConfigurationService, {} as IConfigurationService);
		services.registerInstance(INativeHostService, {} as INativeHostApi);
		services.registerInstance(IHostService, {} as IHostService);
		services.registerInstance(IClipboardService, {} as IClipboardService);
		services.registerInstance(IFileDialogService, {} as IFileDialogService);
		services.registerInstance(IFileService, {} as IFileService);
		services.registerInstance(ILayoutService, {} as ILayoutService);
		assert.throws(() => services.createInstance(NativeScreenshotToolService), /screenCaptureSetupService/);
	});
	test('denied desktop capture opens setup and completes without acquiring an image', async function () {
		if (!isMacintosh) this.skip();
		using resources = new DisposableStore();
		const value = fixture(resources, async () => 'denied');
		assert.equal(await value.screenshots.captureAndEdit(new AbortController().signal), undefined);
		assert.equal(value.setups.length, 1);
		assert.equal(value.setups[0].title, 'Set Up Desktop Screenshots');
	});
	test('cancellation before capture does not query native permission', async () => {
		using resources = new DisposableStore();
		const value = fixture(resources, async () => assert.fail('Cancelled requests must not query the OS'));
		await assert.rejects(value.screenshots.captureAndEdit(AbortSignal.abort()), { name: 'AbortError' });
		assert.deepEqual(value.setups, []);
	});
	test('retirement during native preflight cannot open late setup', async function () {
		if (!isMacintosh) this.skip();
		using resources = new DisposableStore();
		const permission = new DeferredPromise<'denied'>();
		const started = new DeferredPromise<void>();
		const value = fixture(resources, () => { void started.complete(); return permission.p; });
		const capture = value.screenshots.captureAndEdit(new AbortController().signal);
		await started.p;
		value.screenshots.dispose();
		await permission.complete('denied');
		assert.equal(await capture, undefined);
		assert.deepEqual(value.setups, []);
	});
});
