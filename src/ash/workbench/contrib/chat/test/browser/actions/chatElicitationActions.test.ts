import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CommandsRegistry } from '../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IChatWidgetService } from '../../../browser/chat.js';
import { AcceptElicitationRequestActionId, registerChatElicitationActions } from '../../../browser/actions/chatElicitationActions.js';

test('elicitation commands use the visible input owner without submitting any other form', () => {
	using registration = registerChatElicitationActions(); using services = new InstantiationService(); let submitted = 0;
	const widget = { visible: true, input: { acceptElicitation: () => { submitted++; } } };
	services.registerInstance(IChatWidgetService, { lastFocusedWidget: widget } as unknown as IChatWidgetService);
	services.invokeFunction(CommandsRegistry.getCommand(AcceptElicitationRequestActionId)!); assert.equal(submitted, 1);
	widget.visible = false;
	services.invokeFunction(CommandsRegistry.getCommand(AcceptElicitationRequestActionId)!); assert.equal(submitted, 1);
});
