import '../../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Emitter } from '../../../../../../base/common/event.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { INotificationService } from '../../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPick } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { CommandService } from '../../../../../services/commands/common/commandService.js';
import { TestConfigurationService } from '../../../../../services/configuration/test/common/testServices.js';
import { registerChatActions } from '../../../browser/actions/chatActions.js';
import { IChatSessionNavigationService } from '../../../../../services/chat/common/chatSessionNavigationService.js';
import { IAgentSessionsService, type IAgentSessionPickerItem } from '../../../browser/agentSessions/agentSessionsService.js';
import { SHOW_CHAT_HISTORY_COMMAND_ID } from '../../../common/chat.js';

registerChatActions();

test('Workbench history renders a borrowed host catalog without Session services and releases its subscription', async () => {
	const dom = new JSDOM('<!doctype html><body><button>History</button></body>');
	try {
		using services = new InstantiationService();
		using changes = new Emitter<void>();
		using configuration = new TestConfigurationService();
		using quickInput = new TestQuickInputService({ container: dom.window.document.body, instantiationService: services });
		const opened: string[] = [];
		const entry = (label: string): IAgentSessionPickerItem => ({
			id: 'host-entry', label,
			open: () => { opened.push('host-entry'); },
			getActions: () => [],
			getButtonAction: () => undefined,
		});
		let items = [entry('Alpha')];
		services.registerInstance(IAgentSessionsService, {
			model: {
				onDidChange: changes.event,
				get items() { return items; },
			}
		});
		services.registerInstance(IChatSessionNavigationService, {} as IChatSessionNavigationService);
		services.registerInstance(IConfigurationService, configuration);
		services.registerInstance(IQuickInputService, quickInput);
		services.registerInstance(INotificationService, { error: () => assert.fail('The host operation must succeed') } as unknown as INotificationService);
		using commands = new CommandService(services);
		const anchor = dom.window.document.querySelector('button')!;
		const picking = commands.executeCommand(SHOW_CHAT_HISTORY_COMMAND_ID, anchor);
		const picker = quickInput.currentQuickInput as IQuickPick<IAgentSessionPickerItem>;
		assert.equal(picker.anchor, anchor);
		assert.equal(picker.anchorPosition, 'below');
		assert.equal(changes.hasListeners(), true);
		picker.value = 'Alpha';
		picker.activeItems = [picker.items[0] as IAgentSessionPickerItem];
		items = [entry('Alpha renamed')];
		changes.fire();
		assert.equal(picker.value, 'Alpha');
		assert.equal(picker.activeItems[0]?.label, 'Alpha renamed');
		picker.selectedItems = [picker.activeItems[0]!];
		await picker.accept();
		await picking;
		assert.deepEqual(opened, ['host-entry']);
		assert.equal(changes.hasListeners(), false);
		assert.equal(dom.window.document.querySelector('.ash-quick-pick'), null);
	} finally {
		dom.window.close();
	}
});
