import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter, Event } from "../../../base/common/event.js";
import { Disposable } from "../../../base/common/lifecycle.js";
import { ServiceContainer } from "../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService, type IQuickPick, type IQuickPickItem } from "../../../platform/quickinput/common/quickInput.js";
import { NEW_CHAT_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID } from "../../../workbench/contrib/chat/common/chat.js";
import { CommandService } from "../../../workbench/services/commands/common/commandService.js";
import "../../../sessions/browser/actions/sessionsChatActions.js";
import { ISessionsService } from "../../../sessions/services/sessions/browser/sessionsService.js";
import type { ISession } from "../../../sessions/services/sessions/common/session.js";
import { ISessionsManagementService } from "../../../sessions/services/sessions/common/sessionsManagement.js";

test("Sessions owns the local New Chat command without requiring regular Workbench Views", async () => {
	const onDidChange = new Emitter<void>();
	let created = 0;
	const viewService: ISessionsService = {
		onDidChange: onDidChange.event,
		visibleSelections: [],
		activeSelection: undefined,
		canNavigateBack: false,
		canNavigateForward: false,
		async initialize() {},
		openSession() {},
		openUntitledSession() {},
		openNewSession() {
			created += 1;
			return { untitledSessionId: `untitled-${created}`, title: "New code session", model: undefined };
		},
		activateSelection() {},
		closeVisibleSelection() {},
		navigateBack() {},
		navigateForward() {},
	};
	const services = new ServiceContainer();
	services.registerInstance(ISessionsService, viewService);
	using commands = new CommandService(services);

	await commands.executeCommand(NEW_CHAT_COMMAND_ID);

	assert.equal(created, 1);
	onDidChange.dispose();
});

test("Sessions History opens the selected active chat", async () => {
	const opened: Array<{ sessionId: string; threadId: string }> = [];
	const quickInput = new TestQuickInputService();
	const sessions: readonly ISession[] = [
		{
			sessionId: "session-1",
			title: "First Session",
			status: "active",
			nextApprovalMode: "askPermissions",
			chats: [
				{ threadId: "thread-1", origin: { type: "root" }, status: "active" },
				{ threadId: "thread-2", origin: { type: "root" }, status: "archived" },
			],
		},
		{
			sessionId: "session-2",
			title: "Archived Session",
			status: "archived",
			nextApprovalMode: "askPermissions",
			chats: [{ threadId: "thread-3", origin: { type: "root" }, status: "active" }],
		},
	];
	const services = new ServiceContainer();
	services.registerInstance(ISessionsManagementService, { sessions } as ISessionsManagementService);
	services.registerInstance(ISessionsService, {
		openSession: (sessionId: string, threadId: string) => opened.push({ sessionId, threadId }),
	} as unknown as ISessionsService);
	services.registerInstance(IQuickInputService, quickInput);
	using commands = new CommandService(services);

	await commands.executeCommand(SHOW_CHAT_HISTORY_COMMAND_ID);

	assert.equal(quickInput.picker?.placeholder, "Select a session");
	assert.deepEqual(quickInput.picker?.items.map(item => item.label), ["First Session"]);
	quickInput.picker?.acceptFirst();
	assert.deepEqual(opened, [{ sessionId: "session-1", threadId: "thread-1" }]);
});

class TestQuickInputService implements IQuickInputService {
	picker: TestQuickPick<IQuickPickItem> | undefined;

	createQuickPick<TItem extends IQuickPickItem>(): IQuickPick<TItem> {
		const picker = new TestQuickPick<TItem>();
		this.picker = picker as unknown as TestQuickPick<IQuickPickItem>;
		return picker;
	}

	async input(): Promise<string | undefined> { return undefined; }
}

class TestQuickPick<TItem extends IQuickPickItem> extends Disposable implements IQuickPick<TItem> {
	private readonly acceptEmitter = this._register(new Emitter<TItem>());
	private readonly hideEmitter = this._register(new Emitter<void>());
	readonly onDidAccept = this.acceptEmitter.event;
	readonly onDidHide = this.hideEmitter.event;
	readonly onDidChangeValue = Event.None;
	readonly onDidBlur = Event.None;
	readonly onDidTriggerItemButton = Event.None;
	items: readonly TItem[] = [];
	ariaLabel = "";
	placeholder = "";
	value = "";
	valueSelection = { start: 0, end: 0 };
	filterValue = (value: string): string => value;

	acceptFirst(): void {
		const item = this.items[0];
		if (item) this.acceptEmitter.fire(item);
	}

	show(): void {}
	hide(): void { this.hideEmitter.fire(); }
}
