import type { NetworkInformation } from '../../browser/networkInformation.js';
import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../instantiation/common/serviceCollection.js';
import { getSingletonServiceDescriptors } from '../../../instantiation/common/extensions.js';
import { IMeteredConnectionService, METERED_CONNECTION_SETTING_KEY } from '../../common/meteredConnection.js';
import { MeteredConnectionService } from '../../browser/meteredConnectionService.js';

class BrowserConnection extends EventTarget implements NetworkInformation {
	metered = true;
	saveData = false;
	effectiveType = '2g';
}

suite('Web metered connection policy', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('browser observations and application overrides produce distinct changes and release listeners', async () => {
		using services = new InstantiationService();
		using configuration = new InMemoryConfigurationService();
		services.registerInstance(IConfigurationService, configuration);
		const connection = new BrowserConnection();
		using metered = services.createInstance(MeteredConnectionService, () => connection);
		const observed: boolean[] = [];
		using subscription = metered.onDidChangeIsConnectionMetered(value => observed.push(value));
		assert.equal(metered.isConnectionMetered, true);
		await configuration.updateValue(METERED_CONNECTION_SETTING_KEY, 'off');
		connection.metered = false;
		connection.saveData = true;
		connection.dispatchEvent(new Event('change'));
		assert.equal(metered.isConnectionMetered, false);
		await configuration.updateValue(METERED_CONNECTION_SETTING_KEY, 'auto');
		connection.saveData = false;
		connection.dispatchEvent(new Event('change'));
		connection.dispatchEvent(new Event('change'));
		// A 2G effective speed is not a billing-status signal.
		assert.equal(metered.isConnectionMetered, false);
		await configuration.updateValue(METERED_CONNECTION_SETTING_KEY, 'on');
		assert.deepEqual(observed, [false, true, false, true]);
		metered.dispose();
		await configuration.updateValue(METERED_CONNECTION_SETTING_KEY, 'off');
		connection.dispatchEvent(new Event('change'));
		assert.deepEqual(observed, [false, true, false, true]);
	});

	test('the registered Web singleton works without connection support or an IPC service', async () => {
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IMeteredConnectionService)!;
		using services = new InstantiationService(new ServiceCollection(descriptor));
		using configuration = new InMemoryConfigurationService();
		services.registerInstance(IConfigurationService, configuration);
		const metered = services.get(IMeteredConnectionService);
		assert.equal(metered.isConnectionMetered, false);
		await configuration.updateValue(METERED_CONNECTION_SETTING_KEY, 'on');
		assert.equal(metered.isConnectionMetered, true);
	});

	test('configuration is a required dependency', () => {
		using services = new InstantiationService();
		assert.throws(() => services.createInstance(MeteredConnectionService, () => undefined), /configurationService/);
	});
});
