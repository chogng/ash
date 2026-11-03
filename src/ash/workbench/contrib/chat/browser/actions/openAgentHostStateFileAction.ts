import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import { ChatAIDisabledSettingId } from '../../../../../platform/chat/common/chatSettings.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IChatService, type ThreadRead } from '../../../../services/chat/common/chatService.js';
import { IChatSessionNavigationService, withChatConversation } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IUntitledTextEditorService } from '../../../../services/untitled/common/untitledTextEditorService.js';
import { UntitledTextEditorInput } from '../../../../services/untitled/common/untitledTextEditorInput.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { IChatWidgetService } from '../chat.js';

export class OpenAgentHostStateFileAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.inspectChatModel',
			title: localize2('chat.developer.inspectChatModel', 'Developer: Inspect Chat Model'),
			f1: true, precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		if (configuration.getValue<boolean>(ChatAIDisabledSettingId)) return;
		const widgets = accessor.get(IChatWidgetService);
		const widget = widgets.lastFocusedWidget;
		if (!widget?.visible || !widget.sessionId || !widget.threadId) return;
		const { sessionId, threadId } = widget;
		const navigation = accessor.get(IChatSessionNavigationService);
		const revision = navigation.revision;
		const chat = accessor.get(IChatService);
		const editors = accessor.get(IEditorService);
		const untitled = accessor.get(IUntitledTextEditorService);
		const connection = navigation.captureConnection?.(sessionId);
		const appServer = connection ? undefined : accessor.get(IAppServerApi);
		let snapshot: ThreadRead | undefined;
		try {
			if (connection) {
				await connection.assertCurrent();
				snapshot = await chat.readThread(sessionId, threadId);
				await connection.assertCurrent();
			} else {
				await withChatConversation(chat, appServer!, sessionId, threadId, async value => { snapshot = value; });
			}
			if (!snapshot) return;
			if (snapshot.thread.sessionId !== sessionId || snapshot.thread.threadId !== threadId) {
				throw new Error(localize('chat.sessionLink.missing', 'This conversation is unavailable on this connection.'));
			}
			// A slow read must not open an editor over the user's next conversation.
			if (configuration.getValue<boolean>(ChatAIDisabledSettingId) || navigation.revision !== revision
				|| widgets.lastFocusedWidget !== widget || !widget.visible || widget.sessionId !== sessionId || widget.threadId !== threadId) return;
			const model = untitled.create({ initialValue: JSON.stringify(snapshot, null, 2), languageId: 'json' });
			await editors.openEditor(new UntitledTextEditorInput(model), { pinned: true });
		} finally { connection?.dispose(); }
	}
}
