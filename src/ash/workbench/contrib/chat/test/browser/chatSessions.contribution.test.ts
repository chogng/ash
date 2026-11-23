import '../../../../../editor/test/browser/testEditorDom.js';
import '../../browser/chat.shared.contribution.js';
import '../../../../browser/parts/auxiliarybar/auxiliaryBarActions.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { MenuId, MenusRegistry } from '../../../../../platform/actions/common/actions.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { AuxiliaryBarHasActiveViewsContext, AuxiliaryBarVisibleContext, IsAuxiliaryWindowContext } from '../../../../common/contextkeys.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { initializeTestLocalization } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { CHAT_VIEW_ID, OPEN_CHAT_COMMAND_ID } from '../../common/chat.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { registerChatSessionsActions } from '../../browser/chatSessions/chatSessions.contribution.js';

initializeTestLocalization('zh-CN');
try { registerChatSessionsActions(); }
finally { initializeTestLocalization('en'); }

test('The Chat title actions use the Chinese product catalog', () => {
	const getTitle = (menu: MenuId, id: string) => {
		const item = MenusRegistry.getMenuItems(menu).find(item => 'command' in item && item.command.id === id);
		const title = item && 'command' in item ? item.command.title : undefined;
		return typeof title === 'string' ? title : title?.value;
	};
	assert.equal(getTitle(MenuId.TitleBar, 'workbench.action.toggleChat'), '切换聊天');
	assert.equal(getTitle(MenuId.ChatHostTitle, 'workbench.action.closeChat'), '隐藏聊天');
	assert.equal(getTitle(MenuId.ChatHostTitle, 'workbench.action.toggleExpandedChat'), '展开聊天');
});

test('The IDE title bar shares one right side bar button between Chat and the secondary side bar', () => {
	using services = new InstantiationService();
	using context = new ContextKeyService();
	services.registerInstance(IContextKeyService, context);
	const auxiliaryVisible = AuxiliaryBarVisibleContext.bindTo(context);
	const auxiliaryHasViews = AuxiliaryBarHasActiveViewsContext.bindTo(context);
	const chatEnabled = ChatContextKeys.enabled.bindTo(context);
	const auxiliaryWindow = IsAuxiliaryWindowContext.bindTo(context);
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.chatTitleBar']);
	host.advance(WorkbenchPhase.BlockRestore);

	const chat = 'workbench.action.toggleChat';
	const auxiliary = 'workbench.action.toggleAuxiliaryBar';
	const titleBarActions = MenusRegistry.getMenuItems(MenuId.TitleBar).filter(item =>
		'command' in item && (item.command.id === chat || item.command.id === auxiliary));
	const visible = () => titleBarActions.flatMap(item => 'command' in item && context.contextMatchesRules(item.when)
		? [{ id: item.command.id, icon: item.command.icon }]
		: []);
	const expected = (id: string) => [{ id, icon: Lxicon.layoutSidebarRightOff }];

	auxiliaryVisible.set(false);
	assert.deepEqual(visible(), expected(auxiliary));
	chatEnabled.set(true);
	assert.deepEqual(visible(), expected(chat));
	auxiliaryHasViews.set(true);
	assert.deepEqual(visible(), expected(auxiliary));
	auxiliaryHasViews.set(false);
	auxiliaryVisible.set(true);
	assert.deepEqual(visible(), expected(auxiliary));
	auxiliaryWindow.set(true);
	assert.deepEqual(visible(), []);
});

test('The contributed Open Chat command focuses its owning view and honors the window AI setting', async () => {
	using services = new InstantiationService();
	using configuration = new TestConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	const focused: string[] = [];
	services.registerInstance(IViewsService, { focusView: async (id: string) => { focused.push(id); return true; } } as IViewsService);
	using commands = new CommandService(services);
	assert.equal(await commands.executeCommand(OPEN_CHAT_COMMAND_ID), true);
	assert.deepEqual(focused, [CHAT_VIEW_ID]);
	await configuration.updateValue(ChatAIDisabledSettingId, true);
	assert.equal(await commands.executeCommand(OPEN_CHAT_COMMAND_ID), false);
	assert.deepEqual(focused, [CHAT_VIEW_ID]);
});
