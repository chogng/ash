import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isMacintosh } from '../../../../../base/common/platform.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../../common/services.js';
import { IImageEditorService } from '../../../../services/imageEditor/common/imageEditorService.js';
import { NativeScreenshotToolService } from '../../electron-browser/nativeScreenshotToolService.js';
import { IScreenCaptureSetupService } from '../../electron-browser/screenCaptureSetup.js';

suite('Desktop screenshot permission entry', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	function fixture(resources: DisposableStore, permission: () => ReturnType<INativeHostApi['getMediaAccessStatus']>) {
		const services = resources.add(new InstantiationService());
		const setups: { readonly title: string; readonly signal: AbortSignal; }[] = [];
		services.registerInstance(IImageEditorService, { capture: async () => assert.fail('Permission setup must not capture pixels') } as unknown as IImageEditorService);
		services.registerInstance(IConfigurationService, {} as IConfigurationService);
		services.registerInstance(INativeHostService, { getMediaAccessStatus: permission } as unknown as INativeHostApi);
		services.registerInstance(IScreenCaptureSetupService, { show: async (options, signal) => { setups.push({ title: options.title, signal }); } });
		const screenshots = resources.add(services.createInstance(NativeScreenshotToolService));
		return { screenshots, setups };
	}
	test('native screenshot construction requires the permission setup registration', () => {
		using services = new InstantiationService();
		services.registerInstance(IImageEditorService, {} as IImageEditorService);
		services.registerInstance(IConfigurationService, {} as IConfigurationService);
		services.registerInstance(INativeHostService, {} as INativeHostApi);
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
