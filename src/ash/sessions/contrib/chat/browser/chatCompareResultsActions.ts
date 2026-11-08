import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ChatResponseActionContext } from '../../../../workbench/contrib/chat/browser/chat.js';
import { ChatContextKeys } from '../../../../workbench/contrib/chat/common/actions/chatContextKeys.js';
import { getCompletedChatResponseSource } from '../../../../workbench/contrib/chat/common/model/chatViewModel.js';
import { IChatService } from '../../../../workbench/services/chat/common/chatService.js';
import { IEditorService } from '../../../../workbench/services/editor/common/editorService.js';
import { readChatRequestVersions, type ChatRequestVersionPair } from '../../../browser/chatRequestVersions.js';
import { createTurnResultComparisonInput } from '../../../browser/turnMultiDiffSource.js';
import { SessionsWorkspaceModeContext } from '../../../common/contextkeys.js';
import type { ISession } from '../../../services/sessions/common/session.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';

const code = SessionsWorkspaceModeContext.isEqualTo('code');

registerAction2(class CompareChatVersionResultsAction extends Action2 {
	constructor() {
		super({
			id: 'sessions.chat.compareVersionResults',
			title: localize2('sessions.requestVersions.compare', 'Compare results'),
			precondition: code,
			menu: { id: MenuId.ChatMessageFooter, group: '1_conversation', order: 2, when: ContextKeyExpr.and(code, ChatContextKeys.responseCanCompareResults.isEqualTo(true)) },
		});
	}

	override async run(accessor: ServicesAccessor, context: unknown): Promise<void> {
		if (!(context instanceof ChatResponseActionContext) || !context.visible || !context.item.canCompareResults) return;
		const source = getCompletedChatResponseSource(context.item);
		if (!source) return;
		const session = accessor.get(ISessionsManagementService).sessions.find(candidate => candidate.sessionId === source.sessionId);
		if (!session) return;
		const chat = accessor.get(IChatService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const editors = accessor.get(IEditorService);
		const matches = (target: { readonly threadId: string; readonly turnId: string; }) => target.threadId === source.threadId && target.turnId === source.turnId;
		const pairs = (await readChatRequestVersions(chat, session, source.threadId)).filter(pair => matches(pair.original) || matches(pair.alternate));
		if (!context.visible) return;
		if (!pairs.length) {
			notifications.info(localize('sessions.requestVersions.compareUnavailable', 'Both versions need completed Git snapshots to compare their results.'));
			return;
		}
		const pair = pairs.length === 1 ? pairs[0] : await pickVersion(quickInput, session, pairs);
		if (!pair || !context.visible) return;
		const input = await createTurnResultComparisonInput(chat, pair);
		if (!context.visible) return;
		if (input.items.length) await editors.openEditor(input, { pinned: true });
		else notifications.info(localize('sessions.requestVersions.identical', 'The two versions produced the same files.'));
	}
});

async function pickVersion(quickInput: IQuickInputService, session: ISession, pairs: readonly ChatRequestVersionPair[]): Promise<ChatRequestVersionPair | undefined> {
	const store = new DisposableStore();
	try {
		const picker = store.add(quickInput.createQuickPick<{ readonly pair: ChatRequestVersionPair; readonly label: string; readonly description?: string; }>());
		picker.ariaLabel = picker.placeholder = localize('sessions.requestVersions.pick', 'Choose a version to compare with the original run');
		picker.sortByLabel = false;
		picker.items = pairs.map((pair, index) => ({
			pair,
			label: localize('sessions.requestVersions.pickLabel', 'Version {0}', index + 1),
			description: session.chats.find(chat => chat.threadId === pair.alternate.threadId)?.title,
		}));
		return await new Promise(resolve => {
			store.add(picker.onDidAccept(() => resolve(picker.selectedItems[0]?.pair)));
			store.add(picker.onDidHide(() => resolve(undefined)));
			picker.show();
		});
	} finally {
		store.dispose();
	}
}
