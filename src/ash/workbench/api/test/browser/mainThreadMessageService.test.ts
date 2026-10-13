import assert from 'node:assert/strict';
import { test } from 'mocha';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { OPEN_EXTENSIONS_COMMAND_ID } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService, NotificationSeverity } from '../../../../platform/notification/common/notification.js';
import { CommandService } from '../../../services/commands/common/commandService.js';
import { NotificationService } from '../../../services/notification/common/notificationService.js';
import { MainThreadMessageService } from '../../browser/mainThreadMessageService.js';

function createServices(): InstantiationService {
	const services = new InstantiationService();
	services.registerSingleton(INotificationService, () => services.createInstance(NotificationService));
	services.registerSingleton(ICommandService, () => services.createInstance(CommandService));
	services.registerInstance(IExtensionApi, {
		list: async () => ({ generation: 1, diagnostics: [], extensions: [{ id: 'fixture.git', displayName: 'Git' }] }),
	} as unknown as import('../../../../platform/extensions/common/extensionApi.js').IExtensionApi);
	return services;
}

test('extension message identity comes from its authenticated caller, and secondary management preserves its primary choice', async () => {
	using services = createServices();
	using messages = services.createInstance(MainThreadMessageService);
	const notifications = services.get(INotificationService);
	const added = promiseWithResolvers<void>();
	using listener = notifications.onDidAdd(() => added.resolve());
	let managed: unknown;
	using command = CommandsRegistry.register(OPEN_EXTENSIONS_COMMAND_ID, (_accessor, options) => { managed = options; });
	const result = messages.handle({ operation: 'showMessage', message: 'Git failed', severity: 'error', items: ['Output', 'Retry'] }, 'fixture.git', new AbortController().signal);
	await added.promise;
	const item = notifications.getNotifications()[0];
	assert.deepEqual({ source: item.source, severity: item.severity, primary: item.actions?.primary?.map(action => action.label), secondary: item.actions?.secondary?.map(action => action.label) }, {
		source: 'Git', severity: NotificationSeverity.Error, primary: ['Output', 'Retry'], secondary: ['Manage Extension'],
	});
	await item.actions!.secondary![0].run();
	assert.deepEqual(managed, { query: 'fixture.git' });
	assert.deepEqual(notifications.getNotifications(), [item]);
	await item.actions!.primary![1].run();
	assert.deepEqual(await result, { result: 'selection', index: 1 });
	assert.deepEqual(notifications.getNotifications(), []);
});

for (const dismissal of ['remove', 'abort', 'dispose', 'removeOnArrival'] as const) {
	test(`extension message ${dismissal} settles its choice and releases its notification`, async () => {
		using services = createServices();
		using messages = services.createInstance(MainThreadMessageService);
		const notifications = services.get(INotificationService);
		const added = promiseWithResolvers<void>();
		using listener = notifications.onDidAdd(item => {
			if (dismissal === 'removeOnArrival') notifications.remove(item.id);
			added.resolve();
		});
		const controller = new AbortController();
		const result = messages.handle({ operation: 'showMessage', message: 'Choose', severity: 'warning', items: ['Continue'] }, 'fixture.git', controller.signal);
		await added.promise;
		if (dismissal === 'remove') notifications.clear();
		else if (dismissal === 'abort') controller.abort();
		else if (dismissal === 'dispose') messages.dispose();
		assert.deepEqual(await result, { result: 'selection', index: null });
		assert.deepEqual(notifications.getNotifications(), []);
	});
}

test('an extension message without choices completes immediately with an identity fallback when the catalog is unavailable', async () => {
	using services = createServices();
	services.get(IExtensionApi).list = async () => { throw new Error('Catalog unavailable'); };
	using messages = services.createInstance(MainThreadMessageService);
	assert.deepEqual(await messages.handle({ operation: 'showMessage', message: 'Hello', severity: 'information' }, 'fixture.unknown', new AbortController().signal), { result: 'done' });
	assert.equal(services.get(INotificationService).getNotifications()[0].source, 'fixture.unknown');
	await assert.rejects(messages.handle({ operation: 'showMessage', message: 'Invalid', severity: 'error', items: [''] }, 'fixture.unknown', new AbortController().signal), /button labels/);
	assert.equal(services.get(INotificationService).getNotifications().length, 1);
});
