import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import { Event } from '../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IBrowserViewGroupService } from '../../common/browserViewGroup.js';
import { PlaywrightService } from '../../node/playwrightService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';

suite('Playwright session lifetime', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('retiring a Thread cancels discovery and destroys a group that arrives after release', async () => {
		const created = promiseWithResolvers<string>();
		const started = promiseWithResolvers<void>();
		const destroyed = promiseWithResolvers<string>();
		using services = new InstantiationService();
		services.registerInstance(IBrowserViewGroupService, {
			createGroup: async () => { started.resolve(); return created.promise; },
			destroyGroup: async id => { destroyed.resolve(id); },
			onDynamicDidDestroy: () => Event.None,
			onDynamicCDPMessage: () => Event.None,
			sendCDPMessage: async () => { throw new Error('Released Thread must not issue Chromium commands'); },
		});
		using playwright = services.createInstance(PlaywrightService);
		const observation = playwright.getObservation('operation-one', 'thread-one', 'page-one', { includeAccessibilityTree: false, includeDomSnapshot: false, includeScreenshot: false });
		await started.promise;
		const rejected = assert.rejects(observation, /BrowserRequestCancelled/);
		await playwright.disposeSession('thread-one');
		await rejected;
		created.resolve('late-group');
		assert.equal(await destroyed.promise, 'late-group');
	});
});
