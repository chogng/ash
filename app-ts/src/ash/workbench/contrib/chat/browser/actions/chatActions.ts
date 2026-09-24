import { lxiconsLibrary } from "../../../../../base/common/lxiconsLibrary.js";
import { DisposableStore } from "../../../../../base/common/lifecycle.js";
import { Action2, MenuId, registerAction2 } from "../../../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPickItem } from "../../../../../platform/quickinput/common/quickInput.js";
import type { SessionId, ThreadId } from "../../../../../sessions/services/sessions/common/session.js";
import { ISessionsManagementService } from "../../../../../sessions/services/sessions/common/sessionsManagementService.js";
import { IViewsService } from "../../../../services/views/browser/viewsService.js";
import { CHAT_VIEW_ID, NEW_CHAT_COMMAND_ID, OPEN_CHAT_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID } from "../../common/chat.js";

registerAction2(class OpenChatAction extends Action2 {
	constructor() {
		super({
			id: OPEN_CHAT_COMMAND_ID,
			title: "Open Chat",
			icon: lxiconsLibrary.chat,
			f1: true,
		});
	}

	override run(accessor: ServicesAccessor): void {
		accessor.get(IViewsService).focusView(CHAT_VIEW_ID);
	}
});

registerAction2(class NewChatAction extends Action2 {
	constructor() {
		super({
			id: NEW_CHAT_COMMAND_ID,
			title: "New Chat",
			icon: lxiconsLibrary.add,
			f1: true,
			menu: {
				id: MenuId.ChatTitle,
				group: "navigation",
				order: 1,
			},
		});
	}

	override run(accessor: ServicesAccessor): void {
		const sessionService = accessor.get(ISessionsManagementService);
		const viewsService = accessor.get(IViewsService);
		sessionService.createUntitledSession();
		viewsService.focusView(CHAT_VIEW_ID);
	}
});

interface ChatHistoryQuickPickItem extends IQuickPickItem {
	readonly sessionId: SessionId;
	readonly threadId: ThreadId;
}

registerAction2(class ShowChatHistoryAction extends Action2 {
	constructor() {
		super({
			id: SHOW_CHAT_HISTORY_COMMAND_ID,
			title: "Show Chat History",
			tooltip: "Show Chat History",
			icon: lxiconsLibrary.history,
			f1: true,
			menu: {
				id: MenuId.ChatTitle,
				group: "navigation",
				order: 2,
			},
		});
	}

	override run(accessor: ServicesAccessor): void {
		const sessions = accessor.get(ISessionsManagementService);
		const views = accessor.get(IViewsService);
		const quickPick = accessor.get(IQuickInputService).createQuickPick<ChatHistoryQuickPickItem>();
		const disposables = new DisposableStore();
		disposables.add(quickPick);
		quickPick.placeholder = "Select a chat";
		quickPick.items = sessions.sessions.flatMap((session) => {
			if (session.status !== "active") return [];
			const threads = session.chats.filter((thread) => thread.status === "active");
			return threads.map((thread, index) => ({
				sessionId: session.sessionId,
				threadId: thread.threadId,
				label: session.title.trim() || "Chat",
				description: threads.length > 1 ? `Thread ${index + 1}` : undefined,
			}));
		});
		disposables.add(quickPick.onDidAccept((item) => {
			sessions.selectThread(item.sessionId, item.threadId);
			quickPick.hide();
			views.focusView(CHAT_VIEW_ID);
		}));
		disposables.add(quickPick.onDidHide(() => disposables.dispose()));
		quickPick.show();
	}
});
