import { DisposableStore } from "../../../base/common/lifecycle.js";
import { Action2, registerAction2 } from "../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../platform/quickinput/common/quickInput.js";
import { NEW_CHAT_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID } from "../../../workbench/contrib/chat/common/chat.js";
import type { SessionId, ThreadId } from "../../services/sessions/common/session.js";
import { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import { ISessionsService } from "../../services/sessions/browser/sessionsService.js";
import { localizedString } from '../../../platform/action/common/action.js';
import { ContextKeyExpr } from '../../../platform/contextkey/common/contextkey.js';
import type { ApprovalMode } from '../../../workbench/services/chat/common/chatService.js';
import type { IChatWidgetModel } from '../../../workbench/contrib/chat/browser/widget/chatWidget.js';
import { Menus } from '../menus.js';

for (const [mode, key, label] of [
	['askPermissions', 'sessions.chat.permission.ask', 'Ask permissions'],
	['autoReview', 'sessions.chat.permission.auto', 'Automatic review'],
	['bypassPermissions', 'sessions.chat.permission.full', 'Full access'],
] as const satisfies readonly (readonly [ApprovalMode, string, string])[]) {
	registerAction2(class SelectSessionApprovalMode extends Action2 {
		constructor() {
			super({
				id: `sessions.chat.permission.${mode}`,
				title: localizedString('ash', key, label),
				toggled: ContextKeyExpr.equals('sessionsChatApprovalMode', mode),
				menu: { id: Menus.NewSessionControl, group: 'navigation' },
			});
		}

		override run(_accessor: ServicesAccessor, model: IChatWidgetModel): void {
			// The menu carries its own composer model, including when another pane is active.
			model.selectApprovalMode(mode);
		}
	});
}

// ChatWidget shares these command IDs with the regular Workbench; this window owns their Sessions behavior.
registerAction2(class NewSessionsChatAction extends Action2 {
	constructor() {
		super({ id: NEW_CHAT_COMMAND_ID, title: "New Session" });
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(ISessionsService).openNewSession("New code session");
	}
});

interface SessionsHistoryQuickPickItem extends IQuickPickItem {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
}

registerAction2(class ShowSessionsChatHistoryAction extends Action2 {
	constructor() {
		super({ id: SHOW_CHAT_HISTORY_COMMAND_ID, title: "Show Session History" });
	}

	override run(accessor: ServicesAccessor): void {
		const sessions = accessor.get(ISessionsManagementService);
		const view = accessor.get(ISessionsService);
		const quickPick = accessor.get(IQuickInputService).createQuickPick<SessionsHistoryQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(quickPick);
		quickPick.placeholder = "Select a session";
		quickPick.items = sessions.sessions.flatMap(session => {
			if (session.status !== "active") return [];
			const threads = session.chats.filter(thread => thread.status === "active");
			return threads.map((thread, index) => ({
				sessionId: session.sessionId,
				threadId: thread.threadId,
				label: session.title.trim() || "Session",
				description: threads.length > 1 ? `Thread ${index + 1}` : undefined,
			}));
		});
		disposables.add(quickPick.onDidAccept(item => {
			view.openSession(item.sessionId, item.threadId);
			quickPick.hide();
		}));
		disposables.add(quickPick.onDidHide(() => disposables.dispose()));
		quickPick.show();
	}
});
