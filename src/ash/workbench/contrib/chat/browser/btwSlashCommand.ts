import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ProductSlashCommands } from '../../../services/chat/common/chatService.js';
import { IChatSideChatService } from '../common/chatSideChatService.js';
import { IChatSlashCommandService } from '../common/participants/chatSlashCommands.js';
import { LocalChatSessionUri } from '../common/model/chatUri.js';
import { IChatWidgetService } from './chat.js';
import { captureSideChatSelection } from './chatSideChat.js';

/** Both /btw and the send menu submit through this registered handler. */
export class BtwSlashCommandContribution extends Disposable {
	static readonly ID = 'workbench.contrib.btwSlashCommand';

	constructor(
		@IChatSlashCommandService commands: IChatSlashCommandService,
		@IChatSideChatService sideChats: IChatSideChatService,
		@IChatWidgetService widgets: IChatWidgetService,
	) {
		super();
		const definition = ProductSlashCommands.btw;
		this._register(commands.registerSlashCommand({
			command: definition.name,
			detail: localize('slash.btw.description', definition.description),
			argumentHint: definition.argumentHint,
			executeDuringRequest: true,
		}, async (prompt, resource, options) => {
			if (!prompt.trim()) throw new Error(localize('chat.btw.missingPrompt', 'Enter a question after /btw.'));
			const source = LocalChatSessionUri.parse(resource);
			const widget = source && widgets.getAllWidgets().find(widget => widget.visible && widget.sessionId === source.sessionId && widget.threadId === source.threadId);
			if (!sideChats.canAskInSideChat(resource)) throw new Error(localize('chat.btw.unavailable', 'Send a message in this conversation before starting a side chat.'));
			await sideChats.askInSideChat(resource, prompt, captureSideChatSelection(widget), options);
		}));
	}
}
