import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import { Emitter } from "../../../base/common/event.js";
import { DisposableStore, toDisposable } from "../../../base/common/lifecycle.js";
import type { ICommandEvent, ICommandService } from "../../../platform/commands/common/commands.js";
import { IContextMenuService, IContextViewService } from "../../../platform/contextview/browser/contextView.js";
import { IAccessibleViewService } from '../../../platform/accessibility/browser/accessibleView.js';
import { INotificationService } from '../../../platform/notification/common/notification.js';
import { NotificationService } from '../../../workbench/services/notification/common/notificationService.js';
import type { IChatService, ThreadUpdateEnvelope } from "../../../workbench/services/chat/common/chatService.js";
import type { ISessionsManagementService } from "../../services/sessions/common/sessionsManagement.js";
import type { IUntitledChatSession } from "../../services/sessions/common/session.js";
import { SessionsService } from "../../../sessions/services/sessions/browser/sessionsService.js";
import { IStorageService } from '../../../platform/storage/common/storage.js';
import { BrowserStorageService } from '../../../workbench/services/storage/browser/storageService.js';
import { ChatTipService, IChatTipService } from '../../../workbench/contrib/chat/browser/chatTipService.js';
import { ILifecycleService } from '../../../workbench/services/lifecycle/common/lifecycle.js';
import { BrowserLifecycleService } from '../../../workbench/services/lifecycle/browser/lifecycleService.js';
import { readNewChatDraftState, writeNewChatDraftState } from '../../contrib/chat/common/newChatDraftState.js';
import { builtinLanguagePackCatalogs } from '../../../workbench/services/localization/common/localizationCatalogs.js';
import { formatNlsMessage, setNlsResolver, resetNlsResolver } from '../../../nls.js';
import { ChatAttachmentModel } from '../../../workbench/contrib/chat/browser/attachments/chatAttachmentModel.js';
import { NewChatContextAttachments } from '../../contrib/chat/browser/newChatContextAttachments.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>", { url: 'http://localhost/' });
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
	FileReader: browserEnvironment.window.FileReader,
	navigator: browserEnvironment.window.navigator,
})) {
	Object.defineProperty(globalThis, name, { configurable: true, value });
}
const { SessionsPart } = await import("../../../sessions/browser/parts/sessionsPart.js");
const { NewChatInputWidget } = await import('../../contrib/chat/browser/newChatInput.js');
const { createCodeEditorServices } = await import('../../../editor/test/browser/testCodeEditor.js');

suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ["window", "document", "Node", "Element", "HTMLElement", "Event", "MouseEvent", "FileReader", "navigator"]) Reflect.deleteProperty(globalThis, name);
});

test("SessionsPart remains owned by the Sessions product layer", async () => {
	const dom = browserEnvironment;
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	dom.window.document.body.replaceChildren();
	const onDidChange = new Emitter<void>();
	let untitledSessions: readonly IUntitledChatSession[] = [];
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
		async listAgents() { return []; },
		async openThread() {},
		selectThread() {},
		async interruptThread() {},
		createUntitledSession() {
			const untitledSession = { untitledSessionId: `untitled-${untitledSessions.length + 1}`, title: "New code session", model: undefined, agent: undefined, workspace: { type: 'current' as const } };
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
		setUntitledSessionDefaultModel() {},
		setUntitledSessionAgent() {},
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
		configureAdvisor: async () => {},
		consultAdvisor: async () => {},
		readAdvisorDefault: async () => null,
		saveAdvisorDefault: async () => {},
		onDidUpdateThread: threadUpdates.event,
		onDidUpdateThreadTranscript: transcriptUpdates.event,
		onDidUpdateGoal: () => toDisposable(() => {}),
		onDidBecomeReady: ready.event,
		onDidChangeModels: ready.event,
		onDidChangeQueue: ready.event,
		onDidChangeSkills: ready.event,
		onDidUpdateTurnChanges: () => toDisposable(() => {}),
		async listModels() { return []; },
		getDefaultNewChatModel() { return undefined; },
		rememberSelectedModel() {},
		async listModelCatalog() { return []; },
		async listModelProviders() { return []; },
		async setModelProviderApiKey() {},
		async listAdvisorModels() { return []; },
		async refreshModels() { return []; },
		isModelVisible() { return true; },
		async setModelVisible() {},
		async listSlashCommands() { return []; },
		async listSkillSelectors() { return []; },
		async readThread() { throw new Error("No active Thread"); },
		async subscribeThread() { throw new Error("No active Thread"); },
		async unsubscribeThread() {},
		async startTurn() {},
		async queueTurn() {},
		async queuedMessageCount() { return 0; },
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
	using resources = new DisposableStore();
	const services = resources.add(createCodeEditorServices(resources).createChild());
	using notifications = new NotificationService();
	services.registerInstance(IContextMenuService, contextMenuService);
	services.registerInstance(IContextViewService, contextViewService);
	services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService);
	services.registerInstance(INotificationService, notifications);
	const storage = resources.add(new BrowserStorageService({ ownerWindow: dom.window as unknown as Window, applicationId: 'test', workspaceId: 'test', flushInterval: 0 }));
	services.registerInstance(IStorageService, storage);
	services.registerInstance(IChatTipService, resources.add(services.createInstance(ChatTipService)));
	services.registerInstance(ILifecycleService, resources.add(new BrowserLifecycleService({ ownerWindow: dom.window as unknown as Window, onError: error => { throw error; } })));
	const part = new SessionsPart(dom.window.document.body, {
		sessionService,
		chatService,
		contextMenuService,
		contextViewService,
		accessibleViewService: { getOpenAriaHint: () => undefined } as unknown as IAccessibleViewService,
		notifications,
		commandService,
		createInputPart: (container, delegate, model) => services.createInstance(NewChatInputWidget, container, delegate, model, undefined, undefined),
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
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-input .ash-chat-input-editor').length, 2);
	assert.equal(part.domNode.querySelectorAll('.ash-sessions-chat-welcome-heading:not([hidden])').length, 2);
	await new Promise(resolve => setTimeout(resolve, 0));
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-tip').length, 2);
	const firstTip = part.domNode.querySelector('.ash-chat-input-tip');
	assert.ok(firstTip);
	const chinese = builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!;
	try {
		setNlsResolver((bundle, key, fallback, parameters) => formatNlsMessage(chinese.bundles[bundle]?.[key] ?? fallback, parameters));
		assert.match(part.domNode.querySelector('.ash-chat-input-tip')?.textContent ?? '', /用 \+ 按钮添加文本文件或图片/u);
		assert.equal(part.domNode.querySelector('[data-action-id="ash.chat.input.attach"] button')?.getAttribute('aria-label'), '添加附件');
		assert.equal(part.domNode.querySelector('.ash-sessions-chat-input-footer button')?.getAttribute('aria-label'), '权限：请求权限');
	} finally {
		resetNlsResolver();
	}
	const translatedTip = part.domNode.querySelector('.ash-chat-input-tip');
	viewService.activateSelection(viewService.activeSelection!);
	assert.equal(part.domNode.querySelector('.ash-chat-input-tip'), translatedTip);
	translatedTip!.querySelector<HTMLButtonElement>('button')!.click();
	assert.equal(part.domNode.querySelectorAll('.ash-chat-input-tip').length, 0);
	assert.equal(services.get(IChatTipService).getWelcomeTip(), undefined);

	(part.domNode.querySelector(".ash-sessions-chat-slot-title") as HTMLButtonElement).click();
	assert.ok(part.domNode.querySelector(".ash-sessions-chat-slot.active:first-of-type"));

	(part.domNode.querySelector(".ash-sessions-chat-slot-close") as HTMLButtonElement).click();
	assert.equal(part.domNode.querySelectorAll(".ash-sessions-chat-slot").length, 1);
	assert.ok(part.domNode.querySelector('.ash-sessions-chat-view.single-chat'));

	partListener.dispose();
	part.dispose();
	viewService.dispose();
	contextMenuEvents.dispose();
	commandEvents.dispose();
	threadUpdates.dispose();
	ready.dispose();
	onDidChange.dispose();
});

test('Sessions draft state restores text and images while isolating Threads and workspaces', async () => {
	const ownerWindow = browserEnvironment.window as unknown as Window;
	using storage = new BrowserStorageService({ ownerWindow, applicationId: 'draft-test', workspaceId: 'workspace-a', flushInterval: 0 });
	const draft = { mode: 'debug' as const, text: 'Review this', contexts: [{ id: 'image', kind: 'image', name: 'image.png', content: 'data:image/png;base64,aGVsbG8=' }] };
	writeNewChatDraftState(storage, draft);
	writeNewChatDraftState(storage, { mode: 'plan', text: 'Thread draft', contexts: [] }, 'thread-1');
	await storage.flush();
	using restored = new BrowserStorageService({ ownerWindow, applicationId: 'draft-test', workspaceId: 'workspace-a', flushInterval: 0 });
	assert.deepEqual(readNewChatDraftState(restored), draft);
	assert.deepEqual(readNewChatDraftState(restored, 'thread-1'), { mode: 'plan', text: 'Thread draft', contexts: [] });
	assert.equal(readNewChatDraftState(restored, 'thread-2'), undefined);
	restored.switchWorkspace('workspace-b');
	assert.equal(readNewChatDraftState(restored), undefined);
	restored.switchWorkspace('workspace-a');
	writeNewChatDraftState(restored, undefined);
	assert.equal(readNewChatDraftState(restored), undefined);
	assert.equal(readNewChatDraftState(restored, 'thread-1')?.text, 'Thread draft');
});

test('Sessions file acquisition preserves valid UTF-8 and rejects binary content without adding it', async () => {
	using model = new ChatAttachmentModel();
	using notifications = new NotificationService();
	using attachments = new NewChatContextAttachments(document.body, model, notifications);
	await attachments.attachFiles([new browserEnvironment.window.File(['A literal \uFFFD character'], 'context.txt', { type: 'text/plain' })]);
	assert.deepEqual(await model.attachments[0]!.resolve(), { name: 'context.txt', content: 'A literal \uFFFD character' });
	await attachments.attachFiles([new browserEnvironment.window.File([new Uint8Array([0xFF, 0x00])], 'binary.dat')]);
	assert.equal(model.size, 1);
	assert.match(notifications.getNotifications()[0]?.message ?? '', /binary.dat must be a UTF-8 text file/u);
});

test('Closing Sessions file acquisition cancels its readers and does not mutate attachments', async () => {
	using model = new ChatAttachmentModel();
	using notifications = new NotificationService();
	using attachments = new NewChatContextAttachments(document.body, model, notifications);
	const pending = attachments.attachFiles([new browserEnvironment.window.File(['Pending read'], 'context.txt', { type: 'text/plain' })]);
	attachments.dispose();
	await pending;
	assert.equal(model.size, 0);
	assert.deepEqual(notifications.getNotifications(), []);
});
