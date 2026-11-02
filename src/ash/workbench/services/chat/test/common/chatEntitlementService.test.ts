import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ChatEntitlementService } from '../../common/chatEntitlementService.js';

test('Chat sentiment projects the configuration owner and only announces the AI preference', async () => {
	const registry = new ConfigurationRegistry();
	registry.registerConfiguration({ key: ChatAIDisabledSettingId, defaultValue: false, parse: value => value === true });
	registry.registerConfiguration({ key: 'unrelated.setting', defaultValue: false, parse: value => value === true });
	using configuration = new InMemoryConfigurationService(registry);
	using services = new InstantiationService();
	services.registerInstance(IConfigurationService, configuration);
	const service = services.createInstance(ChatEntitlementService);
	assert.deepEqual(service.sentiment, { hidden: false });
	const observations: unknown[] = [];
	using subscription = service.onDidChangeSentiment(() => observations.push(service.sentiment));
	await configuration.updateValue('unrelated.setting', true);
	assert.deepEqual(observations, []);
	await configuration.updateValue(ChatAIDisabledSettingId, true);
	assert.deepEqual(service.sentiment, { hidden: true });
	await configuration.updateValue(ChatAIDisabledSettingId, false);
	assert.deepEqual(observations, [{ hidden: true }, { hidden: false }]);
	subscription.dispose();
	await configuration.updateValue(ChatAIDisabledSettingId, true);
	assert.deepEqual(observations, [{ hidden: true }, { hidden: false }]);
});

test('Chat sentiment requires its configuration dependency at construction', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(ChatEntitlementService), /configurationService/);
});
