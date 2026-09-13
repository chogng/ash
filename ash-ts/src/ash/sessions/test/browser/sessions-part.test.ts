import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { Emitter } from "../../../base/common/event.js";
import { toDisposable } from "../../../base/common/lifecycle.js";
import type { ICommandEvent, ICommandService } from "../../../platform/commands/common/commands.js";
import type { IContextMenuService } from "../../../platform/contextview/browser/contextView.js";
import type { IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import type { IChatService, ThreadUpdateEnvelope } from "../../../workbench/services/chat/common/chatService.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagementService.js";
import { SessionsService } from "../../../sessions/services/view/browser/sessionsService.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
	navigator: browserEnvironment.window.navigator,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}
const { SessionsPart } = await import("../../../sessions/browser/parts/sessionsPart.js");

test.after(() => {
	browserEnvironment.window.close();
	for (const name of ["window", "document", "Node", "Element", "HTMLElement", "Event", "MouseEvent", "navigator"]) Reflect.deleteProperty(globalThis, name);
});

test("SessionsPart remains owned by the Sessions product layer", () => {
	const dom = browserEnvironment;
	dom.window.document.body.replaceChildren();
	const onDidChange = new Emitter<void>();
	let untitledSessions: readonly { untitledSessionId: string; title: string; model: undefined }[] = [];
	let activeUntitledSessionId: string | undefined;
	const sessionService: ISessionsManagementService = {
		onDidChange: onDidChange.event,
		sessions: [],
		active: undefined,
		get untitledSessions() { return untitledSessions; },
		get activeUntitledSession() { return untitledSessions.find(session => session.untitledSessionId === activeUntitledSessionId); },
		state: "ready",
		error: undefined,
		async initialize() {},
		selectThread() {},
		async interruptThread() {},
		createUntitledSession() {
			const untitledSession = { untitledSessionId: `untitled-${untitledSessions.length + 1}`, title: "New code session", model: undefined };
			untitledSessions = [...untitledSessions, untitledSession];
			activeUntitledSessionId = untitledSession.untitledSessionId;
			onDidChange.fire();
			return untitledSession;
		},
		selectUntitledSession(untitledSessionId) {
			activeUntitledSessionId = untitledSessionId;
			onDidChange.fire();
		},
		discardUntitledSession(untitledSessionId) {
			untitledSessions = untitledSessions.filter(session => session.untitledSessionId !== untitledSessionId);
			if (activeUntitledSessionId === untitledSessionId) activeUntitledSessionId = untitledSessions[0]?.untitledSessionId;
			onDidChange.fire();
		},
		setUntitledSessionModel() {},
		async materializeUntitledSession() {
			throw new Error("Session creation is unavailable");
		},
		promoteUntitledSession() {},
		async ensureActiveThread() {
			throw new Error("No active thread");
		},
		async startNewSession() {
			throw new Error("Session creation is unavailable");
		},
		async stopSession() {
			throw new Error("Session stopping is unavailable");
		},
		async setModel() {
			throw new Error("Model selection is unavailable");
		},
		async archiveSession() {
			throw new Error("Session archiving is unavailable");
		},
	};
	const threadUpdates = new Emitter<ThreadUpdateEnvelope>();
	const transcriptUpdates = new Emitter<import("../../../workbench/services/chat/common/chatService.js").ThreadTranscriptUpdateEnvelope>();
	const ready = new Emitter<void>();
	const chatService: IChatService = {
		onDidUpdateThread: threadUpdates.event,
		onDidUpdateThreadTranscript: transcriptUpdates.event,
		onDidUpdateGoal: () => toDisposable(() => {}),
		onDidBecomeReady: ready.event,
		onDidChangeModels: ready.event,
		onDidChangeSkills: ready.event,
		onDidUpdateTurnChanges: () => toDisposable(() => {}),
		async listModels() { return []; },
		async listModelCatalog() { return []; },
		async refreshModels() { return []; },
		isModelVisible() { return true; },
		async setModelVisible() {},
		async listSlashCommands() { return []; },
		async listSkillSelectors() { return []; },
		async readThread() { throw new Error("No active Thread"); },
		async subscribeThread() { throw new Error("No active Thread"); },
		async unsubscribeThread() {},
		async startTurn() {},
		async compactContext() {},
		async steerTurn() {},
		async interruptTurn() {},
		async resolveInteraction() {},
		async listTurnChanges() { return []; },
		async readTurnChange() { throw new Error("No ChangeSet"); },
		async readTurnChangeFile() { throw new Error("No ChangeSet file"); },
		async generateTurnChangeMessage() { return []; },
		async updateTurnChangeDraft() { return []; },
		async commitTurnChange() { return []; },
		async discardThreadChanges() { return []; },
	};
	const viewService = new SessionsService(sessionService);
	viewService.openNewSession("New code session");
	viewService.openNewSession("New code session");
	const contextMenuEvents = new Emitter<void>();
	const contextMenuService: IContextMenuService = {
		onDidShowContextMenu: contextMenuEvents.event,
		onDidHideContextMenu: contextMenuEvents.event,
		showContextMenu() {},
		hideContextMenu() {},
	};
	const contextViewService: IContextViewService = {
		container: dom.window.document.body,
		show() { return false; },
		hide() {},
		layout() {},
	};
	const commandEvents = new Emitter<ICommandEvent>();
	const commandService: ICommandService = {
		onWillExecuteCommand: commandEvents.event,
		onDidExecuteCommand: commandEvents.event,
		async executeCommand() { throw new Error("No commands registered"); },
	};
	const part = new SessionsPart(dom.window.document.body, {
		sessionService,
		chatService,
		contextMenuService,
		contextViewService,
		commandService,
		contextPickService: {} as import("../../../workbench/services/chat/common/chatContextService.js").IChatContextPickService,
		quickInputService: {} as import("../../../platform/quickinput/common/quickInput.js").IQuickInputService,
		activateSelection: selection => viewService.activateSelection(selection),
		closeSelection: selection => viewService.closeVisibleSelection(selection),
	});
	const updatePart = (): void => part.updateVisibleSelections(viewService.visibleSelections, viewService.activeSelection);
	const partListener = viewService.onDidChange(updatePart);
	updatePart();

	assert.equal(part.domNode.dataset.part, "sessions");
	assert.equal(part.domNode.querySelector(".ash-sessions-surface-header h1")?.textContent, "New code session");
	assert.ok(part.domNode.querySelector(".ash-sessions-chat-view"));
	assert.equal(part.domNode.querySelectorAll(".ash-sessions-chat-slot").length, 2);
	assert.equal(part.domNode.querySelectorAll(".ash-chat-input-part").length, 2);

	(part.domNode.querySelector(".ash-sessions-chat-slot-title") as HTMLButtonElement).click();
	assert.ok(part.domNode.querySelector(".ash-sessions-chat-slot.active:first-of-type"));

	(part.domNode.querySelector(".ash-sessions-chat-slot-close") as HTMLButtonElement).click();
	assert.equal(part.domNode.querySelectorAll(".ash-sessions-chat-slot").length, 1);

	partListener.dispose();
	part.dispose();
	viewService.dispose();
	contextMenuEvents.dispose();
	commandEvents.dispose();
	threadUpdates.dispose();
	ready.dispose();
	onDidChange.dispose();
});
