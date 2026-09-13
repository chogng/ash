import assert from "node:assert/strict";
import { test } from "mocha";
import { Emitter } from "../../../base/common/event.js";
import { ServiceContainer } from "../../../platform/instantiation/common/instantiation.js";
import { NEW_CHAT_COMMAND_ID } from "../../../workbench/contrib/chat/common/chat.js";
import { CommandService } from "../../../workbench/services/commands/common/commandService.js";
import "../../../sessions/browser/actions/sessionsChatActions.js";
import { ISessionsService } from "../../../sessions/services/view/common/sessionsService.js";

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
