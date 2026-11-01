import assert from 'node:assert/strict';
import { test } from 'mocha';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { IAccessibilityService } from '../../../../../../platform/accessibility/common/accessibility.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { ACTION_ID_FOCUS_CHAT_CONFIRMATION, registerChatAccessibilityActions } from '../../../browser/actions/chatAccessibilityActions.js';

registerChatAccessibilityActions();

test('confirmation focus prefers the focused input owner, skips hidden widgets and announces when none remain', async () => {
	using services = new InstantiationService();
	const calls: number[] = []; const alerts: string[] = [];
	const pending = [true, true];
	const widgets = [0, 1].map(index => ({ visible: true, input: { focusConfirmation: () => { calls.push(index); return pending[index]; } } }));
	services.registerInstance(IChatWidgetService, { lastFocusedWidget: widgets[1], getAllWidgets: () => widgets } as unknown as IChatWidgetService);
	services.registerInstance(IAccessibilityService, { alert: text => { alerts.push(text); } } as IAccessibilityService);
	const run = async (): Promise<void> => { await services.invokeFunction(CommandsRegistry.getCommand(ACTION_ID_FOCUS_CHAT_CONFIRMATION)!); };
	await run(); assert.deepEqual(calls, [1]);
	pending[1] = false; await run(); assert.equal(calls.at(-1), 0);
	widgets[0].visible = false; await run(); assert.deepEqual(alerts, ['No chat confirmation required.']);
});
