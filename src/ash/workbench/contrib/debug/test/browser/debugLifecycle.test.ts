import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IStorageService } from '../../../../../platform/storage/common/storage.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { BrowserStorageService } from '../../../../services/storage/browser/storageService.js';
import { BrowserLifecycleService } from '../../../../services/lifecycle/browser/lifecycleService.js';
import { ShutdownVetoError } from '../../../../services/lifecycle/common/lifecycle.js';
import { MockDebugService } from '../common/mockDebug.js';
import { DebugLifecycle } from '../../common/debugLifecycle.js';

browserEnvironment.reconfigure({ url: 'https://ash.test/' });
Object.defineProperty(browserEnvironment.window.performance, 'getEntriesByType', {
	configurable: true,
	value: () => [],
});

for (const confirmed of [false, true])
	test(`Debug confirmation ${confirmed ? 'allows' : 'vetoes'} the real shutdown coordinator`, async () => {
		using services = new InstantiationService();
		services.registerInstance(ILogService, new NullLoggerService());
		services.registerSingleton(
			IStorageService,
			() =>
				new BrowserStorageService({
					ownerWindow: browserEnvironment.window as unknown as Window,
					workspaceId: 'debug-lifecycle',
					flushInterval: 0,
				}),
		);
		using lifecycle = services.createInstance(BrowserLifecycleService, {
			ownerWindow: browserEnvironment.window as unknown as Window,
			onError: () => { },
		});
		using debug = new MockDebugService();
		const prompts: string[] = [];
		const configuration = { getValue: () => 'always' } as unknown as IConfigurationService;
		const dialogs = {
			confirm: async (request: { message: string; }) => {
				prompts.push(request.message);
				return { confirmed };
			},
		} as unknown as IDialogService;
		using contribution = new DebugLifecycle(lifecycle, debug, configuration, dialogs);
		if (confirmed) await lifecycle.shutdown('reload');
		else await assert.rejects(lifecycle.shutdown('reload'), ShutdownVetoError);
		assert.equal(lifecycle.willShutdown, confirmed);
		assert.deepEqual(prompts, ['Stop 2 active debug session(s) and close the window?']);
	});
