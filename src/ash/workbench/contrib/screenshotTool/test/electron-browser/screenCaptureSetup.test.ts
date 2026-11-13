import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { suite, teardown, test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AccessibleViewProviderId, AccessibilityVerbositySettingId } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { INativeHostApi } from '../../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../../common/services.js';
import { ScreenCaptureSetupService, type IScreenCaptureSetupOptions } from '../../electron-browser/screenCaptureSetup.js';

class SetupDialog extends Disposable {
	private readonly closed = new DeferredPromise<void>();
	show(): Promise<void> { return this.closed.p; }
	protected override disposeCore(): void { void this.closed.complete(); super.disposeCore(); }
}

suite('Screen capture setup request ownership', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => mock.restoreAll());
	for (const phase of ['focus', 'permission'] as const) {
		test(`a cancelled ${phase} request cannot absorb a new setup or clear its ownership later`, async () => {
			using resources = new DisposableStore();
			const services = resources.add(new InstantiationService());
			const gates = [new DeferredPromise<void>(), new DeferredPromise<void>()];
			const started = [new DeferredPromise<void>(), new DeferredPromise<void>()];
			const opened = new DeferredPromise<void>();
			const dialogs: SetupDialog[] = [];
			let requests = 0;
			const wait = () => {
				const index = requests++;
				void started[index].complete();
				return gates[index].p;
			};
			services.registerInstance(INativeHostService, {
				focusWindow: async () => { if (phase === 'focus') await wait(); },
				getMediaAccessStatus: async () => { if (phase === 'permission') await wait(); return 'denied'; },
			} as unknown as INativeHostApi);
			const setup = resources.add(services.createInstance(ScreenCaptureSetupService));
			mock.method(services, 'createInstance', ((_ctor: unknown, _permission: unknown, options: IScreenCaptureSetupOptions) => {
				assert.equal(options.title, 'Synthetic setup');
				const dialog = resources.add(new SetupDialog());
				dialogs.push(dialog);
				void opened.complete();
				return dialog;
			}) as typeof services.createInstance);
			const options: IScreenCaptureSetupOptions = {
				title: 'Synthetic setup', description: '', help: '',
				providerId: AccessibleViewProviderId.ScreenCaptureSetup,
				verbositySetting: AccessibilityVerbositySettingId.ChatScreenshot,
			};
			const olderController = new AbortController();
			const older = setup.show(options, olderController.signal);
			await started[0].p;
			olderController.abort();
			const newerController = new AbortController();
			const newer = setup.show(options, newerController.signal);
			assert.notEqual(newer, older);
			await started[1].p;
			await gates[1].complete();
			await opened.p;
			await gates[0].complete();
			await older;
			assert.equal(dialogs.length, 1);
			assert.equal(setup.show(options, new AbortController().signal), newer);
			assert.equal(dialogs[0].isDisposed, false);
			newerController.abort();
			await newer;
			assert.equal(dialogs[0].isDisposed, true);
		});
	}
});
