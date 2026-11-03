import assert from 'node:assert/strict';
import { test } from 'mocha';
import { promiseWithResolvers } from '../../../../base/common/async.js';
import { resetNlsResolver, setNlsMessages } from '../../../../nls.js';
import { extensionResourceRequest } from '../../../../platform/extensionResourceLoader/common/extensionResourceLoader.js';
import { ILanguagePackService } from '../../../../platform/languagePacks/common/languagePacks.js';
import { createEmptyTestLanguagePacks } from '../../../services/localization/test/common/localizationTestUtils.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { OPEN_EXTENSIONS_COMMAND_ID } from '../../../../platform/extensionManagement/common/extensionManagementService.js';
import { IExtensionApi } from '../../../../platform/extensions/common/extensionApi.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { CommandService } from '../../../services/commands/common/commandService.js';
import { NotificationService } from '../../../services/notification/common/notificationService.js';
import { TestNotificationService } from '../../../services/notification/test/common/testNotificationService.js';
import { MainThreadMessageService } from '../../browser/mainThreadMessageService.js';

function createServices(): InstantiationService {
	const services = new InstantiationService();
	services.registerSingleton(INotificationService, () => new TestNotificationService());
	services.registerSingleton(ICommandService, () => services.createInstance(CommandService));
	services.registerInstance(IExtensionApi, {
		list: async () => ({ generation: 1, diagnostics: [], extensions: [{ id: 'fixture.git', displayName: 'Git' }] }),
	} as unknown as import('../../../../platform/extensions/common/extensionApi.js').IExtensionApi);
	return services;
}

test('extension message identity comes from its authenticated caller, and secondary management preserves its primary choice', async () => {
	using services = createServices();
	using messages = services.createInstance(MainThreadMessageService);
	const notifications = services.get(INotificationService) as NotificationService;
	const added = promiseWithResolvers<void>();
	using listener = notifications.model.onDidAdd(() => added.resolve());
	let managed: unknown;
	using command = CommandsRegistry.register(OPEN_EXTENSIONS_COMMAND_ID, (_accessor, options) => { managed = options; });
	const result = messages.handle({ operation: 'showMessage', message: 'Git failed', severity: 'error', items: ['Output', 'Retry'] }, 'fixture.git', new AbortController().signal);
	await added.promise;
	const item = notifications.model.getNotifications()[0];
	assert.deepEqual({ source: item.source, sourceId: item.sourceId, severity: item.severity, primary: item.actions?.primary?.map(action => action.label), secondary: item.actions?.secondary?.map(action => action.label) }, {
		source: 'Git', sourceId: 'fixture.git', severity: Severity.Error, primary: ['Output', 'Retry'], secondary: ['Manage Extension'],
	});
	await item.actions!.secondary![0].run();
	assert.deepEqual(managed, { query: 'fixture.git' });
	assert.deepEqual(notifications.model.getNotifications(), [item]);
	await item.actions!.primary![1].run();
	assert.deepEqual(await result, { result: 'selection', index: 1 });
	assert.deepEqual(notifications.model.getNotifications(), []);
});

for (const dismissal of ['remove', 'abort', 'dispose', 'removeOnArrival'] as const) {
	test(`extension message ${dismissal} settles its choice and releases its notification`, async () => {
		using services = createServices();
		using messages = services.createInstance(MainThreadMessageService);
		const notifications = services.get(INotificationService) as NotificationService;
		const added = promiseWithResolvers<void>();
		using listener = notifications.model.onDidAdd(item => {
			if (dismissal === 'removeOnArrival') notifications.model.remove(item.id);
			added.resolve();
		});
		const controller = new AbortController();
		const result = messages.handle({ operation: 'showMessage', message: 'Choose', severity: 'warning', items: ['Continue'] }, 'fixture.git', controller.signal);
		await added.promise;
		if (dismissal === 'remove') notifications.model.clear();
		else if (dismissal === 'abort') controller.abort();
		else if (dismissal === 'dispose') messages.dispose();
		assert.deepEqual(await result, { result: 'selection', index: null });
		assert.deepEqual(notifications.model.getNotifications(), []);
	});
}

test('an extension message without choices completes immediately with an identity fallback when the catalog is unavailable', async () => {
	using services = createServices();
	services.get(IExtensionApi).list = async () => { throw new Error('Catalog unavailable'); };
	using messages = services.createInstance(MainThreadMessageService);
	assert.deepEqual(await messages.handle({ operation: 'showMessage', message: 'Hello', severity: 'information' }, 'fixture.unknown', new AbortController().signal), { result: 'done' });
	assert.equal((services.get(INotificationService) as NotificationService).model.getNotifications()[0].source, 'fixture.unknown');
	await assert.rejects(messages.handle({ operation: 'showMessage', message: 'Invalid', severity: 'error', items: [''] }, 'fixture.unknown', new AbortController().signal), /button labels/);
	assert.equal((services.get(INotificationService) as NotificationService).model.getNotifications().length, 1);
});

test('extension notifications resolve manifest source labels in the client language', async () => {
	using services = createServices();
	services.registerInstance(ILanguagePackService, createEmptyTestLanguagePacks());
	services.get(IExtensionApi).list = async () => ({
		generation: 1, diagnostics: [], extensions: [{
			id: 'fixture.git', name: 'git', publisher: 'fixture', version: '1.0.0',
			sourceKind: 'builtIn', manifestSha256: 'sha256:' + 'a'.repeat(64),
			packageSha256: 'sha256:' + 'b'.repeat(64),
			displayName: '%displayName%', manifestJson: '{"displayName":"%displayName%"}',
		}],
	});
	Object.assign(services.get(IExtensionApi), {
		resources: {
			readExtensionResourceBytes: async () => { throw new Error('Unused binary resource'); },
			readExtensionResource: async uri => {
				if (extensionResourceRequest(uri)?.path === 'package.nls.zh-cn.json') {
					return '{"displayName":"版本控制"}';
				}
				throw new Error('Missing optional resource');
			},
		} satisfies IExtensionApi['resources']
	});
	using messages = services.createInstance(MainThreadMessageService);
	setNlsMessages('zh-CN', {});
	try {
		await messages.handle({ operation: 'showMessage', message: 'Git', severity: 'warning' }, 'fixture.git', new AbortController().signal);
		assert.equal((services.get(INotificationService) as NotificationService).model.getNotifications()[0].source, '版本控制');
	} finally {
		resetNlsResolver();
	}
});
