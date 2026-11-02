import '../../../../../../editor/test/browser/testEditorDom.js';
import '../../../browser/chat.shared.contribution.js';
import '../../../browser/chatManagement/chatManagement.contribution.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'mocha';
import { DisposableStore, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { resetNlsResolver } from '../../../../../../nls.js';
import { ChatAIDisabledSettingId } from '../../../../../../platform/chat/common/chatSettings.js';
import { CommandsRegistry, ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { getSingletonServiceDescriptors } from '../../../../../../platform/instantiation/common/extensions.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService, QuickInputType, type IQuickPick, type IQuickPickItem } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase, type WorkbenchContributionHost } from '../../../../../common/contributions.js';
import { IChatEntitlementService } from '../../../../../services/chat/common/chatEntitlementService.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { initializeTestLocalization } from '../../../../../services/localization/test/common/localizationTestUtils.js';
import { TestNotificationService } from '../../../../../services/notification/test/common/testNotificationService.js';
import { IPreferencesService } from '../../../../../services/preferences/common/preferences.js';
import { CHAT_SETUP_ACTION_ID } from '../../../browser/actions/chatActions.js';
import { ChatSetupContribution } from '../../../browser/chatSetup/chatSetupContributions.js';
import { ChatContextKeys } from '../../../common/actions/chatContextKeys.js';

afterEach(() => resetNlsResolver());

function setup(resources: DisposableStore): {
	configuration: InMemoryConfigurationService;
	contexts: ContextKeyService;
	quickInput: TestQuickInputService;
	commands: CommandService;
	opened: unknown[];
	host: WorkbenchContributionHost;
} {
	const services = resources.add(new InstantiationService());
	const configuration = resources.add(new InMemoryConfigurationService());
	const contexts = resources.add(new ContextKeyService());
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(IContextKeyService, contexts);
	const descriptor = getSingletonServiceDescriptors().find(([id]) => id === IChatEntitlementService)![1];
	services.registerSingleton(IChatEntitlementService, () => services.createInstance(descriptor));
	const container = document.createElement('div');
	document.body.append(container);
	resources.add(toDisposable(() => container.remove()));
	const quickInput = resources.add(new TestQuickInputService({ container }));
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
	const opened: unknown[] = [];
	services.registerInstance(IPreferencesService, {
		openSettings: async options => { opened.push(options); },
	} as IPreferencesService);
	resources.add(CommandsRegistry.register('workbench.action.manageAccounts', () => { opened.push('accounts'); }));
	const commands = resources.add(new CommandService(services));
	services.registerInstance(ICommandService, commands);
	const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [ChatSetupContribution.ID]));
	host.advance(WorkbenchPhase.BlockStartup);
	return { configuration, contexts, quickInput, commands, opened, host };
}

function picker(quickInput: IQuickInputService): IQuickPick<IQuickPickItem> {
	assert.equal(quickInput.currentQuickInput?.type, QuickInputType.QuickPick);
	return quickInput.currentQuickInput as IQuickPick<IQuickPickItem>;
}

for (const locale of ['en', 'zh-CN']) {
	test(`Contributed Chat setup routes through existing model and account commands in ${locale}`, async () => {
		initializeTestLocalization(locale);
		using resources = new DisposableStore();
		const f = setup(resources);
		await f.commands.executeCommand(CHAT_SETUP_ACTION_ID);
		const first = picker(f.quickInput);
		assert.equal(first.ariaLabel, locale === 'en' ? 'Choose how to set up Chat' : '选择 Chat 的设置方式');
		assert.deepEqual(first.items.map(item => item.label), locale === 'en'
			? ['Configure Model Connections', 'Manage Accounts'] : ['配置模型连接', '管理账号']);
		await f.commands.executeCommand(CHAT_SETUP_ACTION_ID);
		assert.equal(picker(f.quickInput), first, 'Repeated setup reuses the active picker');
		first.activeItems = [first.items[0] as IQuickPickItem];
		await f.quickInput.accept();
		assert.deepEqual(f.opened, [{ section: 'models', query: '', sectionQuery: '', jsonEditor: false, focusSearch: true }]);
		await f.commands.executeCommand(CHAT_SETUP_ACTION_ID);
		const accounts = picker(f.quickInput);
		accounts.activeItems = [accounts.items[1] as IQuickPickItem];
		await f.quickInput.accept();
		assert.equal(f.opened[1], 'accounts');
		await f.commands.executeCommand(CHAT_SETUP_ACTION_ID);
		await f.quickInput.cancel();
		assert.equal(f.quickInput.currentQuickInput, undefined);
		assert.equal(f.opened.length, 2, 'Cancel does not navigate or send a request');
	});
}

test('AI configuration closes setup, updates both context keys, and releases the window contribution', async () => {
	using resources = new DisposableStore();
	const f = setup(resources);
	assert.equal(f.contexts.getValue(ChatContextKeys.enabled.key), true);
	assert.equal(f.contexts.getValue(ChatContextKeys.Setup.hidden.key), false);
	await f.commands.executeCommand(CHAT_SETUP_ACTION_ID);
	await f.configuration.updateValue(ChatAIDisabledSettingId, true);
	assert.equal(f.quickInput.currentQuickInput, undefined);
	assert.equal(f.contexts.getValue(ChatContextKeys.enabled.key), false);
	assert.equal(f.contexts.getValue(ChatContextKeys.Setup.hidden.key), true);
	await f.commands.executeCommand(CHAT_SETUP_ACTION_ID);
	assert.equal(f.quickInput.currentQuickInput, undefined, 'Direct calls honor the preference');
	await f.configuration.updateValue(ChatAIDisabledSettingId, false);
	await f.commands.executeCommand(CHAT_SETUP_ACTION_ID);
	assert.ok(f.quickInput.currentQuickInput);
	f.host.dispose();
	assert.equal(f.quickInput.currentQuickInput, undefined);
	assert.equal(CommandsRegistry.getCommand(CHAT_SETUP_ACTION_ID), undefined);
	await f.configuration.updateValue(ChatAIDisabledSettingId, true);
	assert.equal(f.contexts.getValue(ChatContextKeys.Setup.hidden.key), false);
	assert.deepEqual(f.opened, []);
});

test('Setup assembly fails when the required common service is absent', () => {
	using services = new InstantiationService();
	using contexts = new ContextKeyService();
	services.registerInstance(IContextKeyService, contexts);
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, [ChatSetupContribution.ID]);
	assert.throws(() => host.advance(WorkbenchPhase.BlockStartup), /chatEntitlementService/);
});
