import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { autorun } from '../../../../../../base/common/observable.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { getSingletonServiceDescriptors } from '../../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { ServiceCollection } from '../../../../../../platform/instantiation/common/serviceCollection.js';
import { TestConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import { IChatLayoutService } from '../../../common/widget/chatLayoutService.js';
import { ChatLayoutService } from '../../../browser/widget/chatLayoutService.js';
import '../../../browser/chat.shared.contribution.js';

suite('ChatLayoutService', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('the registered service requires configuration and follows persisted edits and resets', async () => {
		using store = new DisposableStore();
		const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IChatLayoutService)!;
		assert.equal(descriptor[1].ctor, ChatLayoutService);
		const services = store.add(new InstantiationService(new ServiceCollection(descriptor)));
		assert.throws(() => services.get(IChatLayoutService), /configurationService/);
		const configuration = store.add(new TestConfigurationService({ source: '{ "chat.fontFamily": "serif", "chat.fontSize": 18, "unrelated": true }' }));
		services.registerInstance(IConfigurationService, configuration);
		const layout = services.get(IChatLayoutService);
		let current: readonly [string | null, number] | undefined;
		const binding = store.add(autorun(reader => { current = [layout.fontFamily.read(reader), layout.fontSize.read(reader)]; }));
		assert.deepEqual(current, ['serif', 18]);
		await configuration.updateValue('chat.fontSize', 21.5);
		assert.deepEqual(current, ['serif', 21.5]);
		assert.equal(JSON.parse((await configuration.read()).source)['chat.fontSize'], 21.5);
		await configuration.write('{ "chat.fontFamily": "Arial, sans-serif", "chat.fontSize": 24, "unrelated": true }');
		assert.deepEqual(current, ['Arial, sans-serif', 24]);
		for (const [key, value] of [['chat.fontFamily', 'serif\nmonospace'], ['chat.fontSize', 5], ['chat.fontSize', 101], ['chat.fontSize', '18']] as const) {
			await assert.rejects(configuration.updateValue(key, value));
			assert.deepEqual(current, ['Arial, sans-serif', 24]);
		}
		await configuration.updateValue('chat.fontFamily', undefined);
		await configuration.updateValue('chat.fontSize', undefined);
		assert.deepEqual(current, [null, 13]);
		assert.equal(JSON.parse((await configuration.read()).source).unrelated, true);
		binding.dispose();
		await configuration.updateValue('chat.fontSize', 22);
		assert.deepEqual(current, [null, 13]);
	});
});
