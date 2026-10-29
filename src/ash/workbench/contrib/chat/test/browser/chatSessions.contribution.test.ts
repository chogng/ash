import '../../../../../editor/test/browser/testEditorDom.js';
import '../../browser/chat.shared.contribution.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { CommandService } from '../../../../services/commands/common/commandService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { CHAT_VIEW_ID, OPEN_CHAT_COMMAND_ID } from '../../common/chat.js';
import { registerChatSessionsActions } from '../../browser/chatSessions/chatSessions.contribution.js';

registerChatSessionsActions();

test('The contributed Open Chat command focuses its owning view and honors the window AI setting', async () => {
	using services = new InstantiationService();
	using configuration = new TestConfigurationService();
	services.registerInstance(IConfigurationService, configuration);
	const focused: string[] = [];
	services.registerInstance(IViewsService, {
		focusView: async (id: string) => {
			focused.push(id);
			return true;
		},
	} as IViewsService);
	using commands = new CommandService(services);
	assert.equal(await commands.executeCommand(OPEN_CHAT_COMMAND_ID), true);
	assert.deepEqual(focused, [CHAT_VIEW_ID]);
	await configuration.updateValue(ChatAIDisabledSettingId, true);
	assert.equal(await commands.executeCommand(OPEN_CHAT_COMMAND_ID), false);
	assert.deepEqual(focused, [CHAT_VIEW_ID]);
});
