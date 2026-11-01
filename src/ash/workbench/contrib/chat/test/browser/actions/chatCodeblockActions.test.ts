import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { registerChatCodeBlockActions } from '../../../browser/actions/chatCodeblockActions.js';

registerChatCodeBlockActions();

test('code block commands route direction to the visible transcript owner', () => {
	using services = new InstantiationService(); const calls: boolean[] = [];
	const widget = { visible: true, focusCodeBlock: (reverse: boolean) => calls.push(reverse) };
	services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget } as unknown as IChatWidgetService);
	for (const direction of ['next', 'previous']) { services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chat.' + direction + 'CodeBlock')!); }
	assert.deepEqual(calls, [false, true]); widget.visible = false;
	services.invokeFunction(CommandsRegistry.getCommand('workbench.action.chat.nextCodeBlock')!); assert.equal(calls.length, 2);
});
