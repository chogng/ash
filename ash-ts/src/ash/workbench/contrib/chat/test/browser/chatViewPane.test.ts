import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import type { ModelRef, ServerNotification, Session as SessionDto, SessionCreateParams, Thread, ThreadTranscriptSnapshot } from "../../../../../platform/app-server/common/generated/index.js";
import type { SessionMutationParams, SessionOperationInput } from "../../../../../platform/sessions/common/sessionApi.js";
import type { IRendererHost } from "../../../../../platform/renderer/common/rendererHost.js";
import type { IAction } from "../../../../../base/common/actions.js";
import { Emitter } from "../../../../../base/common/event.js";
import { TAB_CLOSE_ACTION_ID } from "../../../../../base/browser/ui/tablist/tabList.js";
import { lxiconsLibrary } from "../../../../../base/common/lxiconsLibrary.js";
import { MenuId } from "../../../../../platform/actions/common/actions.js";
import { MenuService } from "../../../../../platform/actions/common/menuService.js";
import type { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import { ServiceContainer } from "../../../../../platform/instantiation/common/instantiation.js";
import { IQuickInputService } from "../../../../../platform/quickinput/common/quickInput.js";
import { CommandService } from "../../../../../workbench/services/commands/common/commandService.js";
import type { ViewPaneContainer } from "../../../../../workbench/browser/parts/views/viewPaneContainer.js";
import { ViewContainerLocation, WorkbenchViewRegistry } from "../../../../../workbench/common/views.js";
import { chatTranscriptListItems, chatListItem, chatTurnErrorListItem, type ChatTurnErrorAction } from "../../../../../workbench/contrib/chat/browser/list/chatListItems.js";
import { ChatPaneModel } from "../../../../../workbench/contrib/chat/browser/pane/chatPaneModel.js";
import { CHAT_VIEW_CONTAINER_ID, CHAT_VIEW_ID, MOVE_CHAT_TO_EDITOR_COMMAND_ID, MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID, NEW_CHAT_COMMAND_ID, OPEN_CHAT_BROWSER_COMMAND_ID, OPEN_CHAT_SETTINGS_COMMAND_ID, SHOW_CHAT_HISTORY_COMMAND_ID, TOGGLE_SESSION_INSPECTOR_COMMAND_ID } from "../../../../../workbench/contrib/chat/common/chat.js";
import { IPreferencesService, type IPreferencesService as PreferencesService } from "../../../../../workbench/services/preferences/common/preferences.js";
import { PreferencesService as BrowserPreferencesService } from "../../../../../workbench/services/preferences/browser/preferencesService.js";
import { emptyEditorServiceState } from '../../../../../workbench/test/common/testEditorService.js';
import { IWorkbenchLayoutService, type WorkbenchPartId, type WorkbenchPartVisibilityChangeEvent } from "../../../../../workbench/services/layout/browser/layoutService.js";
import { ChatService } from "../../../../../workbench/services/chat/browser/chatService.js";
import { ChatContextPickService } from "../../../../../workbench/services/chat/browser/chatContextPickService.js";
import type { ThreadUpdateEnvelope, TurnError } from "../../../../../workbench/services/chat/common/chatService.js";
import { ModelCatalogConfiguration } from "../../../../../workbench/services/chat/common/modelCatalog.js";
import { WorkbenchConfigurationService } from "../../../../../workbench/services/configuration/browser/configurationService.js";
import { AppServerSessionsManagementService as SessionsManagementService } from "../../../../../sessions/services/sessions/browser/appServerSessionsManagementService.js";
import { AppServerSessionsProvider } from "../../../../../sessions/services/sessions/browser/appServerSessionsProvider.js";
import type { ISession } from "../../../../../sessions/services/sessions/common/session.js";
import { ISessionsManagementService } from "../../../../../sessions/services/sessions/common/sessionsManagementService.js";
import { IViewsService, ViewsService } from "../../../../../workbench/services/views/browser/viewsService.js";
import { ContextKeyService, IContextKeyService } from "../../../../../platform/contextkey/browser/contextKeyService.js";
import { ViewDescriptorService } from "../../../../../workbench/services/views/common/viewDescriptorService.js";
import { WorkbenchQuickInputService } from "../../../../../workbench/services/quickinput/browser/quickInputService.js";
import { h } from "../../../../../base/browser/dom.js";

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
const emptyChatContextPickService = new ChatContextPickService();
const unavailableQuickInputService = {
	createQuickPick: () => { throw new Error("Quick input is unavailable in this test"); },
} as IQuickInputService;

class AppServerSessionsManagementService extends SessionsManagementService {
	constructor(api: IRendererHost) {
		super(new AppServerSessionsProvider({ session: api.session, model: api.model, turn: api.turn, events: api.events }));
	}
}
for (const [name, value] of Object.entries({
	window: browserEnvironment.window,
	document: browserEnvironment.window.document,
	Node: browserEnvironment.window.Node,
	Element: browserEnvironment.window.Element,
	HTMLElement: browserEnvironment.window.HTMLElement,
	Event: browserEnvironment.window.Event,
	MouseEvent: browserEnvironment.window.MouseEvent,
})) {
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}
const { registerChatViews } = await import(
	"../../../../../workbench/contrib/chat/browser/chat.contribution.js"
);
const { BrowserContextViewService } = await import(
	"../../../../../platform/contextview/browser/contextViewService.js"
);
const { ChatViewPane } = await import(
	"../../../../../workbench/contrib/chat/browser/view/chatViewPane.js"
);
const { ChatListWidget } = await import(
	"../../../../../workbench/contrib/chat/browser/list/chatListWidget.js"
);
await import(
	"../../../../../workbench/contrib/preferences/browser/preferences.contribution.js"
);
suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of [
		"window",
		"document",
		"Node",
		"Element",
		"HTMLElement",
		"Event",
		"MouseEvent",
	]) {
		Reflect.deleteProperty(globalThis, name);
	}
});

function chatTitleContent(pane: { readonly partTitleProjection: { readonly content?: HTMLElement } | undefined }): HTMLElement {
	const content = pane.partTitleProjection?.content;
	assert.ok(content);
	return content;
}

function chatTitleActions(pane: { readonly partTitleProjection: { readonly actions?: HTMLElement } | undefined }): HTMLElement {
	const actions = pane.partTitleProjection?.actions;
	assert.ok(actions);
	return actions;
}

test("Chat contribution owns the fixed Auxiliary Bar view", () => {
	const registry = new WorkbenchViewRegistry();

	registerChatViews(registry);

	assert.equal(
		registry.getDefaultViewContainer(ViewContainerLocation.AuxiliaryBar)?.id,
		CHAT_VIEW_CONTAINER_ID,
	);
	assert.deepEqual(
		registry.getViews(CHAT_VIEW_CONTAINER_ID).map((view) => view.id),
		[CHAT_VIEW_ID],
	);
	assert.equal(registry.getDefaultViewContainer(ViewContainerLocation.AgentSidebar), undefined);
});

test("Chat title separates Session tabs from its action toolbar", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	dom.window.HTMLElement.prototype.scrollTo = () => {};
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	const subscriptionModel = {
		model: { provider: "openai", model: "gpt-5.6-sol" },
		displayName: "GPT-5.6 Sol",
		access: "subscription" as const,
		outputTransport: "nativeStreaming" as const,
	};
	const fake = fakeApi({
		sessions: [
			{ ...session("session-1", "thread-1"), model: subscriptionModel.model },
			{ ...session("session-2", "thread-2"), model: subscriptionModel.model },
		],
		models: [subscriptionModel],
	});
	const api = fake.api;
	using sessions = new AppServerSessionsManagementService(api);
	using contextKeys = new ContextKeyService();
	using viewDescriptors = new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry: new WorkbenchViewRegistry(),
	});
	const services = new ServiceContainer();
	let preferencesEditorTarget: string | undefined;
	using preferences: PreferencesService = new BrowserPreferencesService(() => ({
		...emptyEditorServiceState,
		openEditor: async (_input, _options, target) => { preferencesEditorTarget = target; },
		focusActiveEditor() {},
	}));
	services.registerInstance(IPreferencesService, preferences);
	services.registerInstance(IContextKeyService, contextKeys);
	using commands = new CommandService(services);
	const menuService = new MenuService(commands, contextKeys);
	const layout = testLayoutService();
	let chatView: InstanceType<typeof ChatViewPane> | undefined;
	services.registerInstance(IWorkbenchLayoutService, layout);
	services.registerInstance(IViewsService, {
		openView: () => chatView,
		focusView: () => true,
	});
	let shownContextMenuActions: readonly IAction[] = [];
	const contextMenuService = {
		showContextMenu: (options: { readonly getActions: () => readonly IAction[] }) => {
			shownContextMenuActions = options.getActions();
		},
	} as unknown as IContextMenuService;
	using pane = new ChatViewPane(
		dom.window.document.body,
		{
			id: CHAT_VIEW_ID,
			title: "Chat",
		},
		createChatService(api),
		sessions,
		menuService,
		contextMenuService,
		contextViewService,
		commands,
		layout,
		emptyChatContextPickService,
		unavailableQuickInputService,
		contextKeys,
	);
	chatView = pane;
	const title = h(dom.window.document, "div");
	title.className = "ash-pane-composite-title";
	title.append(chatTitleContent(pane), chatTitleActions(pane));
	dom.window.document.body.append(title, pane.element);

	await sessions.initialize();
	await nextTask();

	const tablist = title.querySelector(
		".ash-chat-tabs-control .ash-action-bar",
	);
	const toolbar = title.querySelector(
		".ash-chat-title-actions > .ash-action-bar",
	);
	const layoutToolbar = title.querySelector<HTMLElement>(
		".ash-chat-title-layout-actions",
	);
	assert.equal(tablist?.getAttribute("role"), "tablist");
	assert.equal(toolbar?.getAttribute("role"), "toolbar");
	assert.equal(toolbar?.classList.contains("ash-toolbar"), true);
	assert.equal(
		chatTitleContent(pane).nextElementSibling,
		chatTitleActions(pane),
	);
	assert.deepEqual(
		[...toolbar?.querySelectorAll<HTMLElement>("[data-action-id]") ?? []]
			.map((item) => item.dataset.actionId),
		[
			NEW_CHAT_COMMAND_ID,
			SHOW_CHAT_HISTORY_COMMAND_ID,
			"ash.toolbar.moreActions",
		],
	);
	assert.deepEqual(
		[...toolbar?.querySelectorAll<HTMLButtonElement>("button") ?? []]
			.map((button) => button.title),
		["New Chat", "Show Chat History", "More Actions"],
	);
	assert.equal(
		toolbar?.querySelectorAll(".ash-action-view-item.icon").length,
		3,
	);
	assert.ok(toolbar?.querySelector(".ash-button-label"));
	assert.ok(toolbar?.querySelector("svg.ash-icon"));
	assert.ok(layoutToolbar?.querySelector(
		`[data-action-id="${TOGGLE_SESSION_INSPECTOR_COMMAND_ID}"]`,
	));
	layoutToolbar?.querySelector<HTMLButtonElement>("button")?.focus();
	await commands.executeCommand(TOGGLE_SESSION_INSPECTOR_COMMAND_ID);
	assert.equal(pane.element.querySelector<HTMLElement>(".ash-session-inspector")?.hidden, false);
	assert.equal(contextKeys.getValue("chatSessionInspectorVisible"), true);
	pane.element.querySelector(".ash-chat-body")!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	assert.equal(pane.element.querySelector<HTMLElement>(".ash-session-inspector")?.hidden, true);
	assert.equal(contextKeys.getValue("chatSessionInspectorVisible"), false);
	assert.equal(dom.window.document.activeElement, layoutToolbar?.querySelector("button"));
	assert.equal(layoutToolbar?.hidden, false);
	const chatActions = menuService.getMenuActions(MenuId.ChatTitle)
		.filter(([group]) => group !== "navigation")
		.flatMap(([, actions]) => actions);
	assert.deepEqual(
		chatActions.map((action) => ({
			id: action.id,
			label: action.label,
			enabled: action.enabled,
			icon: action.icon,
		})),
		[
			{
				id: OPEN_CHAT_BROWSER_COMMAND_ID,
				label: "Open Browser",
				enabled: false,
				icon: lxiconsLibrary.browserWeb,
			},
			{
				id: MOVE_CHAT_TO_EDITOR_COMMAND_ID,
				label: "Move Chat to Editor Area",
				enabled: false,
				icon: lxiconsLibrary.layoutPanel,
			},
			{
				id: MOVE_CHAT_TO_NEW_WINDOW_COMMAND_ID,
				label: "Move Chat to New Window",
				enabled: false,
				icon: lxiconsLibrary.linkExternal,
			},
			{
				id: OPEN_CHAT_SETTINGS_COMMAND_ID,
				label: "Chat Settings",
				enabled: true,
				icon: lxiconsLibrary.settings,
			},
		],
	);
	await chatActions[3]?.run();
	assert.equal(preferencesEditorTarget, "modalGroup");
	const tabs = tablist?.querySelectorAll<HTMLButtonElement>("[role='tab']");
	assert.equal(tabs?.length, 2);
	assert.deepEqual(
		[...(tabs ?? [])].map((tab) => tab.getAttribute("aria-selected")),
		["true", "false"],
	);
	const panel = pane.element.querySelector("[role='tabpanel']");
	assert.equal(panel?.id, tabs?.[0]?.getAttribute("aria-controls"));
	assert.equal(panel?.getAttribute("aria-labelledby"), tabs?.[0]?.id);
	assert.equal(
		chatTitleContent(pane).querySelector(
			".ash-chat-tabs-control .ash-scrollable-element",
		)?.getAttribute("data-scroll-direction"),
		"horizontal",
	);
	assert.equal(
		pane.element.querySelector(
			".ash-chat-transcript-scrollable",
		)?.getAttribute("data-scroll-direction"),
		"vertical",
	);
	const chatPanes = pane.element.querySelectorAll<HTMLElement>(".ash-chat-pane-host > .ash-chat");
	assert.equal(chatPanes.length, 2);
	for (const chatPane of chatPanes) {
		assert.equal(chatPane.classList.contains("empty"), true);
		assert.equal(chatPane.classList.contains("has-conversation"), false);
		assert.equal(chatPane.querySelector<HTMLElement>(":scope > .ash-chat-goal")?.hidden, true);
		assert.ok(chatPane.querySelector(":scope > .ash-chat-list-widget"));
		assert.ok(chatPane.querySelector(":scope > .ash-chat-input-part"));
		const inputToolbar = chatPane.querySelector<HTMLElement>(".ash-chat-input-toolbars");
		assert.equal(inputToolbar?.getAttribute("role"), "toolbar");
		assert.deepEqual(
			[...inputToolbar?.querySelectorAll<HTMLElement>("[data-action-id]") ?? []].map((item) => item.dataset.actionId),
			[
				"ash.chat.input.mode",
				"ash.chat.input.model",
				"ash.chat.input.attachment",
				"ash.chat.input.send",
			],
		);
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.mode'] button")?.textContent, "Agent");
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.model'] button .ash-button-label")?.textContent, "GPT-5.6 Sol");
		assert.equal(inputToolbar?.querySelector(".ash-chat-input-model-access-badge")?.textContent, "ChatGPT subscription");
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.attachment'] button")?.disabled, false);
		assert.equal(inputToolbar?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.send'] button")?.disabled, true);
	}
	const firstChatPane = chatPanes[0]!;
	firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.model'] button")?.click();
	assert.deepEqual(shownContextMenuActions.map(action => ({ label: action.label, badge: action.badge })), [
		{ label: "GPT-5.6 Sol", badge: "ChatGPT subscription" },
	]);
	shownContextMenuActions = [];
	firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.mode'] button")?.click();
	assert.deepEqual(shownContextMenuActions, []);
	const modeMenu = dom.window.document.querySelector<HTMLElement>(".ash-chat-input-mode-menu");
	assert.equal(modeMenu?.closest(".ash-context-view")?.parentElement, contextViewService.container);
	assert.deepEqual(
		[...modeMenu?.querySelectorAll<HTMLElement>("[data-action-id]") ?? []].map(item => item.textContent),
		["Agent", "Plan", "Debug", "Multitask", "Ask"],
	);
	modeMenu?.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.mode.plan'] button")?.click();
	assert.equal(firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.mode'] button")?.textContent, "Plan");
	assert.equal(dom.window.document.querySelector(".ash-chat-input-mode-menu"), null);
	assert.deepEqual([...chatPanes].map((chatPane) => chatPane.hidden), [false, true]);
	const composerInputs = [...chatPanes].map((chatPane) => {
		const input = chatPane.querySelector<HTMLTextAreaElement>(".ash-chat-textarea-input");
		assert.ok(input);
		return input;
	});
	typeChatText(dom.window, composerInputs[0], "First draft");
	assert.equal(firstChatPane.querySelector<HTMLButtonElement>("[data-action-id='ash.chat.input.send'] button")?.disabled, false);

	tabs?.[1]?.click();
	assert.equal(sessions.active?.session.sessionId, "session-2");
	assert.equal(sessions.active?.threadId, "thread-2");
	assert.deepEqual(
		[...chatTitleContent(pane).querySelectorAll<HTMLElement>("[role='tab']")]
			.map((tab) => tab.getAttribute("aria-selected")),
		["false", "true"],
	);
	assert.deepEqual([...chatPanes].map((chatPane) => chatPane.hidden), [true, false]);
	typeChatText(dom.window, composerInputs[1], "Second draft");
	chatTitleContent(pane).querySelectorAll<HTMLButtonElement>("[role='tab']")[0]?.click();
	assert.equal(sessions.active?.session.sessionId, "session-1");
	assert.deepEqual([...chatPanes].map((chatPane) => chatPane.hidden), [false, true]);
	assert.equal(composerInputs[0]?.value, "First draft");
	assert.equal(composerInputs[1]?.value, "Second draft");

	const closeButtons = chatTitleContent(pane).querySelectorAll<HTMLButtonElement>(
		`[data-action-id="${TAB_CLOSE_ACTION_ID}"] button`,
	);
	assert.equal(closeButtons.length, 2);
	assert.deepEqual(
		[...closeButtons].map((button) => button.title),
		["Close Session session-1", "Close Session session-2"],
	);
	closeButtons[0]?.click();
	await nextTask();

	assert.deepEqual(
			fake.stopRequests.map(({ sessionId }) => ({ sessionId })),
			[{ sessionId: "session-1" }],
	);
	assert.equal(sessions.active?.session.sessionId, "session-2");
	assert.deepEqual(
		[...chatTitleContent(pane).querySelectorAll<HTMLElement>("[role='tab']")]
			.map((tab) => ({
				label: tab.textContent,
				selected: tab.getAttribute("aria-selected"),
			})),
		[{ label: "Session session-2", selected: "true" }],
	);
	assert.equal(
		pane.element.querySelector<HTMLElement>(".ash-chat-pane-host > .ash-chat")
			?.dataset.sessionId,
		"session-2",
	);

	chatTitleContent(pane).querySelector<HTMLButtonElement>(`[data-action-id="${TAB_CLOSE_ACTION_ID}"] button`)?.click();
	await waitFor(() => !layout.isPartVisible("auxiliarybar"));
	assert.equal(chatTitleContent(pane).querySelectorAll("[role='tab']").length, 0);
	assert.equal(sessions.active, undefined);
	assert.equal(sessions.untitledSessions.length, 0);

	layout.showPart("auxiliarybar");
	await waitFor(() => chatTitleContent(pane).querySelectorAll("[role='tab']").length === 1);
	assert.equal(chatTitleContent(pane).querySelector<HTMLElement>("[role='tab']")?.textContent, "New Chat");
	assert.equal(sessions.untitledSessions.length, 1);

	chatTitleContent(pane).querySelector<HTMLButtonElement>(`[data-action-id="${TAB_CLOSE_ACTION_ID}"] button`)?.click();
	assert.equal(layout.isPartVisible("auxiliarybar"), false);
	assert.equal(chatTitleContent(pane).querySelectorAll("[role='tab']").length, 0);
	assert.equal(sessions.untitledSessions.length, 0);

	dom.window.close();
});

test("Empty chat transcripts do not render a redundant placeholder", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using list = new ChatListWidget(dom.window.document.body);

	list.render([]);

	assert.equal(list.element.querySelector(".ash-chat-empty"), null);
	assert.equal(list.element.textContent, "");
	dom.window.close();
});

test("Turn error cards invoke their typed action without interpreting message text", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	let requestedAction: ChatTurnErrorAction | undefined;
	using list = new ChatListWidget(dom.window.document.body, {
		onDidRequestErrorAction: (action) => { requestedAction = action; },
	});
	const item = chatTurnErrorListItem(failedTurn("providerAuth", false, "same opaque message"));
	assert.ok(item);

	list.render([item]);
	list.element.querySelector<HTMLButtonElement>(".ash-chat-turn-error-action")?.click();

	assert.equal(list.element.querySelector(".ash-chat-item-label")?.textContent, "Authentication");
	assert.equal(list.element.querySelector("pre")?.textContent, "same opaque message");
	assert.deepEqual(requestedAction, { type: "chooseModel", label: "Choose another model" });
	dom.window.close();
});

test("an empty Session list opens an untitled session and persists it on its first send", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	const createdSession = session("session-1", undefined, "New Chat");
	const attachedSession = session("session-1", "thread-1", "New Chat");
	const fake = fakeApi({
		sessions: [],
		createSession: createdSession,
		createThread: {
			session: attachedSession,
			threadId: "thread-1",
		},
	});
	const api = fake.api;
	const services = new ServiceContainer();
	using sessions = new AppServerSessionsManagementService(api);
	using contextKeys = new ContextKeyService();
	using viewDescriptors = new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry: new WorkbenchViewRegistry(),
	});
	services.registerInstance(ISessionsManagementService, sessions);
	services.registerInstance(IViewsService, {
		openView: () => undefined,
		focusView: () => true,
	});
	using commands = new CommandService(services);
	const menuService = new MenuService(commands, contextKeys);
	const layout = testLayoutService();
	const contextMenuService = {
		showContextMenu: () => undefined,
	} as unknown as IContextMenuService;
	using pane = new ChatViewPane(
		dom.window.document.body,
		{
			id: CHAT_VIEW_ID,
			title: "Chat",
		},
		createChatService(api),
		sessions,
		menuService,
		contextMenuService,
		contextViewService,
		commands,
		layout,
		emptyChatContextPickService,
		unavailableQuickInputService,
	);
	dom.window.document.body.append(pane.element);

	await sessions.initialize();
	await nextTask();

	const tabs = chatTitleContent(pane).querySelectorAll<HTMLButtonElement>("[role='tab']");
	assert.equal(tabs.length, 1);
	assert.deepEqual(
		[...tabs].map((tab) => ({
			label: tab.textContent,
			selected: tab.getAttribute("aria-selected"),
		})),
		[
			{ label: "New Chat", selected: "true" },
		],
	);
	assert.equal(pane.element.querySelector<HTMLElement>(".ash-chat-view-empty")?.hidden, true);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.createThreadRequests.length, 0);
	assert.equal(sessions.sessions.length, 0);
	assert.equal(sessions.untitledSessions.length, 1);
	const untitledPane = pane.element.querySelector<HTMLElement>("[role='tabpanel']");
	assert.ok(untitledPane?.dataset.untitledSessionId);
	const input = untitledPane.querySelector<HTMLTextAreaElement>(".ash-chat-textarea-input");
	assert.ok(input);
	assert.equal(untitledPane.classList.contains("empty"), true);
	let contextResolutions = 0;
	pane.addContext({
		id: "commit-1",
		kind: "scmHistoryItem",
		name: "abc1234 · Explain context transport",
		resolve: async () => {
			contextResolutions += 1;
			return { name: "Git commit abc1234", content: "diff --git a/file b/file" };
		},
	});
	assert.equal(untitledPane.querySelector(".ash-chat-input-attachment-label")?.textContent, "abc1234 · Explain context transport");
	typeChatText(dom.window, input, "Hello from an untitled session");
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
	}));
	assert.equal(untitledPane.classList.contains("empty"), false);
	assert.equal(untitledPane.classList.contains("has-conversation"), true);
	assert.ok(untitledPane.querySelector(":scope > .ash-chat-list-widget"));
	assert.ok(untitledPane.querySelector(":scope > .ash-chat-input-part"));
	await waitFor(() => fake.turnStartRequests.length === 1);

	assert.equal(fake.createSessionRequests.length, 1);
	assert.equal(fake.createThreadRequests.length, 1);
	assert.equal(fake.turnStartRequests.length, 1);
	assert.equal(contextResolutions, 1);
	assert.deepEqual(fake.turnStartRequests[0]?.input, [
		{ type: "context", name: "Git commit abc1234", content: "diff --git a/file b/file" },
		{ type: "text", text: "Hello from an untitled session" },
	]);
	assert.equal(untitledPane.querySelector(".ash-chat-input-attachment-item"), null);
	assert.equal(sessions.untitledSessions.length, 0);
	assert.equal(sessions.active?.session.sessionId, "session-1");
	assert.equal(sessions.active?.threadId, "thread-1");
	assert.equal(
		pane.element.querySelector<HTMLElement>("[role='tabpanel']")?.dataset.sessionId,
		"session-1",
	);
	assert.equal(
		pane.element.querySelector("[role='tabpanel']")?.getAttribute(
			"aria-labelledby",
		),
		tabs[0]?.id,
	);

	pane.dispose();
	dom.window.close();
});

test("the New Chat slash command opens an untitled session", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	const initialSession = session("session-1", "thread-1", "First Chat");
	const fake = fakeApi({ sessions: [initialSession] });
	const services = new ServiceContainer();
	using sessions = new AppServerSessionsManagementService(fake.api);
	using contextKeys = new ContextKeyService();
	using viewDescriptors = new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry: new WorkbenchViewRegistry(),
	});
	services.registerInstance(ISessionsManagementService, sessions);
	let focusedView: string | undefined;
	services.registerInstance(IViewsService, {
		openView: () => undefined,
		focusView: (viewId) => {
			focusedView = viewId;
			return true;
		},
	});
	using commands = new CommandService(services);
	const menuService = new MenuService(commands, contextKeys);
	const layout = testLayoutService();
	const contextMenuService = {
		showContextMenu: () => undefined,
	} as unknown as IContextMenuService;
	using pane = new ChatViewPane(
		dom.window.document.body,
		{
			id: CHAT_VIEW_ID,
			title: "Chat",
		},
		createChatService(fake.api),
		sessions,
		menuService,
		contextMenuService,
		contextViewService,
		commands,
		layout,
		emptyChatContextPickService,
		unavailableQuickInputService,
	);
	dom.window.document.body.append(pane.element);

	await sessions.initialize();
	await nextTask();

	const input = pane.element.querySelector<HTMLTextAreaElement>(".ash-chat:not([hidden]) .ash-chat-textarea-input");
	assert.ok(input);
	typeChatText(dom.window, input, "/new");
	assert.equal(pane.element.querySelector("[data-action-id='ash.chat.input.command'] button")?.textContent, "Command");
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
	}));
	await waitFor(() => chatTitleContent(pane).querySelectorAll("[role='tab']").length === 2);

	assert.deepEqual(
		[...chatTitleContent(pane).querySelectorAll<HTMLElement>("[role='tab']")].map((tab) => ({
			label: tab.textContent,
			selected: tab.getAttribute("aria-selected"),
		})),
		[
			{ label: "New Chat", selected: "true" },
			{ label: "First Chat", selected: "false" },
		],
	);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.createThreadRequests.length, 0);
	assert.equal(sessions.untitledSessions.length, 1);
	assert.equal(focusedView, CHAT_VIEW_ID);

	dom.window.close();
});

test("failed first send keeps the untitled session and its input draft", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	const fake = fakeApi({
		sessions: [],
		createSessionError: new Error("Cannot create Session"),
	});
	const services = new ServiceContainer();
	using sessions = new AppServerSessionsManagementService(fake.api);
	using contextKeys = new ContextKeyService();
	using viewDescriptors = new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry: new WorkbenchViewRegistry(),
	});
	services.registerInstance(ISessionsManagementService, sessions);
	services.registerInstance(IViewsService, {
		openView: () => undefined,
		focusView: () => true,
	});
	using commands = new CommandService(services);
	const menuService = new MenuService(commands, contextKeys);
	const layout = testLayoutService();
	const contextMenuService = {
		showContextMenu: () => undefined,
	} as unknown as IContextMenuService;
	using pane = new ChatViewPane(
		dom.window.document.body,
		{
			id: CHAT_VIEW_ID,
			title: "Chat",
		},
		createChatService(fake.api),
		sessions,
		menuService,
		contextMenuService,
		contextViewService,
		commands,
		layout,
		emptyChatContextPickService,
		unavailableQuickInputService,
	);
	dom.window.document.body.append(pane.element);

	await sessions.initialize();
	await nextTask();

	const input = pane.element.querySelector<HTMLTextAreaElement>(".ash-chat-textarea-input");
	assert.ok(input);
	pane.addContext({
		id: "failed-commit",
		kind: "scmHistoryItem",
		name: "failed commit",
		resolve: async () => ({ name: "Git commit failed", content: "change" }),
	});
	typeChatText(dom.window, input, "Keep this draft");
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
	}));
	await waitFor(() => input.value === "Keep this draft");

	assert.equal(fake.createSessionRequests.length, 1);
	assert.equal(sessions.sessions.length, 0);
	assert.equal(sessions.untitledSessions.length, 1);
	assert.equal(pane.element.querySelector(".ash-chat-input-attachment-label")?.textContent, "failed commit");
	assert.equal(input.value, "Keep this draft");
	assert.equal(pane.element.querySelector<HTMLElement>("[role='tabpanel']")?.dataset.untitledSessionId, sessions.untitledSessions[0]?.untitledSessionId);
	assert.equal(pane.element.querySelector<HTMLElement>("[role='tabpanel']")?.classList.contains("empty"), true);
	assert.equal(pane.element.querySelector<HTMLElement>("[role='tabpanel']")?.classList.contains("has-conversation"), false);
	assert.match(pane.element.querySelector<HTMLElement>(".ash-chat-status")?.textContent ?? "", /Cannot create Session/);

	dom.window.close();
});

test("one Session retains one Chat pane while its selected Thread changes", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using contextViewService = new BrowserContextViewService(dom.window.document.body);
	const multiThreadSession: ISession = {
		...session("session-1", "thread-1", "One Chat"),
		chats: [
			{ threadId: "thread-1", origin: { type: "root" }, status: "active" },
			{
				threadId: "thread-2",
				origin: {
					type: "fork",
					parentThreadId: "thread-1",
					parentSequence: 1,
				},
				status: "active",
			},
		],
	};
	const api = fakeApi({ sessions: [multiThreadSession] }).api;
	using sessions = new AppServerSessionsManagementService(api);
	using contextKeys = new ContextKeyService();
	using viewDescriptors = new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry: new WorkbenchViewRegistry(),
	});
	using commands = new CommandService(new ServiceContainer());
	const menuService = new MenuService(commands, contextKeys);
	const layout = testLayoutService();
	const contextMenuService = {
		showContextMenu: () => undefined,
	} as unknown as IContextMenuService;
	using pane = new ChatViewPane(
		dom.window.document.body,
		{
			id: CHAT_VIEW_ID,
			title: "Chat",
		},
		createChatService(api),
		sessions,
		menuService,
		contextMenuService,
		contextViewService,
		commands,
		layout,
		emptyChatContextPickService,
		unavailableQuickInputService,
	);
	dom.window.document.body.append(pane.element);

	await sessions.initialize();
	await nextTask();

	assert.equal(chatTitleContent(pane).querySelectorAll("[role='tab']").length, 1);
	const chatPane = pane.element.querySelector<HTMLElement>(".ash-chat-pane-host > .ash-chat");
	assert.ok(chatPane);
	assert.equal(chatPane.dataset.sessionId, "session-1");
	assert.equal(chatPane.dataset.threadId, "thread-1");
	const input = chatPane.querySelector<HTMLTextAreaElement>(".ash-chat-textarea-input");
	assert.ok(input);
	input.focus();
	assert.strictEqual(dom.window.document.activeElement, input);

	sessions.selectThread("session-1", "thread-2");
	await nextTask();

	assert.strictEqual(
		pane.element.querySelector(".ash-chat-pane-host > .ash-chat"),
		chatPane,
	);
	assert.equal(chatTitleContent(pane).querySelectorAll("[role='tab']").length, 1);
	assert.equal(chatPane.dataset.threadId, "thread-2");
	assert.strictEqual(dom.window.document.activeElement, input);
	dom.window.close();
});

test("Chat history selects an active Thread through Quick Pick", async () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	const api = fakeApi({
		sessions: [
			session("session-1", "thread-1", "First Chat"),
			session("session-2", "thread-2", "Second Chat"),
		],
	}).api;
	const services = new ServiceContainer();
	using sessions = new AppServerSessionsManagementService(api);
	using contextKeys = new ContextKeyService();
	using quickInput = new WorkbenchQuickInputService({
		container: dom.window.document.body,
		contextKeyService: contextKeys,
	});
	let focusedView: string | undefined;
	services.registerInstance(ISessionsManagementService, sessions);
	services.registerInstance(IQuickInputService, quickInput);
	services.registerInstance(IViewsService, {
		openView: () => undefined,
		focusView: (viewId) => {
			focusedView = viewId;
			return true;
		},
	});
	using commands = new CommandService(services);
	await sessions.initialize();

	await commands.executeCommand(SHOW_CHAT_HISTORY_COMMAND_ID);
	assert.deepEqual(
		[...dom.window.document.querySelectorAll(
			".ash-quick-pick-row-label",
		)].map((label) => label.textContent),
		["First Chat", "Second Chat"],
	);
	const input = dom.window.document.querySelector<HTMLInputElement>(
		".ash-quick-pick-input input",
	);
	assert.ok(input);
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "ArrowDown",
	}));
	input.dispatchEvent(new dom.window.KeyboardEvent("keydown", {
		bubbles: true,
		cancelable: true,
		key: "Enter",
	}));

	assert.equal(sessions.active?.session.sessionId, "session-2");
	assert.equal(sessions.active?.threadId, "thread-2");
	assert.equal(focusedView, CHAT_VIEW_ID);
	assert.equal(
		dom.window.document.querySelector(".ash-quick-pick"),
		null,
	);
	dom.window.close();
});

test("ViewsService resolves, opens, and focuses contributed views", () => {
	const registry = new WorkbenchViewRegistry();
	registerChatViews(registry);
	using contextKeys = new ContextKeyService();
	using descriptors = new ViewDescriptorService({
		contextKeyService: contextKeys,
		registry,
	});
	let focused = 0;
	let opened = 0;
	const view = {
		id: CHAT_VIEW_ID,
		focus: () => focused++,
		isVisible: () => true,
		setVisible: () => undefined,
	};
	const service = new ViewsService({
		viewDescriptorService: descriptors,
		openViewContainer: (container) => {
			assert.equal(container.id, CHAT_VIEW_CONTAINER_ID);
			return {
				openView: (viewId: string) => {
					assert.equal(viewId, CHAT_VIEW_ID);
					opened++;
					return view;
				},
			} as unknown as ViewPaneContainer;
		},
	});

	assert.equal(service.focusView(CHAT_VIEW_ID), true);
	assert.equal(opened, 1);
	assert.equal(focused, 1);
	assert.equal(service.openView("missing"), undefined);
});

test("AppServerSessionsManagementService restores and creates active Threads", async () => {
	const initialSession = session("session-1", "thread-1");
	const createdSession = session("session-2");
	const attachedSession = session("session-2", "thread-2");
	const api = fakeApi({
		sessions: [initialSession],
		createSession: createdSession,
		createThread: {
			session: attachedSession,
			threadId: "thread-2",
		},
	}).api;
	using service = new AppServerSessionsManagementService(api);

	await service.initialize();
	assert.equal(service.active?.threadId, "thread-1");
	assert.equal(service.active?.session.title, "Session session-1");

	const active = await service.startNewSession("Another");
	assert.equal(active.threadId, "thread-2");
	assert.equal(service.sessions[0].sessionId, "session-2");
	assert.equal(service.state, "ready");
});

test("AppServerSessionsManagementService archives a Session and selects the next active one", async () => {
	const first = session("session-1", "thread-1");
	const second = session("session-2", "thread-2");
	const fake = fakeApi({ sessions: [first, second] });
	using service = new AppServerSessionsManagementService(fake.api);

	await service.initialize();
	await service.archiveSession("session-1");

	assert.deepEqual(
			fake.archiveRequests.map(({ sessionId }) => ({ sessionId })),
			[{ sessionId: "session-1" }],
	);
	assert.equal(
		service.sessions.find(({ sessionId }) => sessionId === "session-1")
			?.status,
		"archived",
	);
	assert.equal(service.active?.session.sessionId, "session-2");
	assert.equal(service.active?.threadId, "thread-2");
	assert.equal(service.state, "ready");
});

test("AppServerSessionsManagementService permits an empty selection when no durable Session remains", async () => {
	const onlySession = session("session-1", "thread-1");
	const fake = fakeApi({ sessions: [onlySession] });
	using service = new AppServerSessionsManagementService(fake.api);

	await service.initialize();
	await service.archiveSession("session-1");

	assert.equal(service.active, undefined);
	assert.equal(service.untitledSessions.length, 0);
	assert.equal(service.activeUntitledSession, undefined);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.createThreadRequests.length, 0);
});

test("AppServerSessionsManagementService selects another untitled session and permits the last one to be discarded", async () => {
	const fake = fakeApi();
	using service = new AppServerSessionsManagementService(fake.api);

	await service.initialize();
	assert.equal(service.untitledSessions.length, 0);
	const initialSession = service.createUntitledSession();
	const nextSession = service.createUntitledSession();

	service.discardUntitledSession(nextSession.untitledSessionId);
	assert.equal(service.activeUntitledSession?.untitledSessionId, initialSession.untitledSessionId);

	service.discardUntitledSession(initialSession.untitledSessionId);
	assert.equal(service.untitledSessions.length, 0);
	assert.equal(service.activeUntitledSession, undefined);
	assert.equal(fake.createSessionRequests.length, 0);
	assert.equal(fake.createThreadRequests.length, 0);
});

test("AppServerSessionsManagementService persists and reflects the model", async () => {
	const fake = fakeApi({
		sessions: [
			session("session-1", "thread-1"),
			session("session-2", "thread-2"),
		],
	});
	using service = new AppServerSessionsManagementService(fake.api);
	await service.initialize();
	const model: ModelRef = { provider: "openai", model: "gpt-session" };

	await service.setModel(model);

	assert.deepEqual(service.sessions.find(({ sessionId }) => sessionId === "session-1")?.model, model);
	assert.deepEqual(service.sessions.find(({ sessionId }) => sessionId === "session-2")?.model, model);
	assert.deepEqual(service.active?.session.model, model);
	assert.deepEqual(fake.modelRequests.map(request => request.model), [model]);
});

test("ChatPaneModel applies backend-assembled transcript entries", async () => {
	const activeSession = session("session-1", "thread-1");
	let currentThread = thread();
	const fake = fakeApi({
		sessions: [activeSession],
		thread: () => currentThread,
	});
	using sessions = new AppServerSessionsManagementService(fake.api);
	using model = new ChatPaneModel(createChatService(fake.api), {
		kind: "session",
		active: {
			session: activeSession,
			threadId: "thread-1",
		},
	}, sessions);

	await model.initialize();
	fake.emit({
		method: "session/thread/transcript/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: 1,
			revision: 2,
			changes: [{
				type: "upsert",
				entry: {
					type: "item",
					entryId: "item:item-1",
					turnId: "turn-1",
					transient: true,
					item: { type: "agentMessage", itemId: "item-1", turnId: "turn-1", text: "Hello" },
				},
			}],
		},
	});

	assert.deepEqual(model.items.map((item) => item.text), ["Hello"]);
	assert.equal(model.items[0].transient, true);

	currentThread = thread("Hello");
	fake.emit({
		method: "session/thread/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: 4,
			update: {
				type: "committed",
				event: {
					type: "itemCompleted",
					threadId: "thread-1",
					turnId: "turn-1",
					item: currentThread.turns[0].items[0],
				},
			},
		},
	});
	await nextTask();

	assert.deepEqual(model.items.map((item) => item.text), ["Hello"]);
	assert.equal(model.items[0].transient, false);
	assert.equal(model.thread?.sequence, 4);
});

test("ChatPaneModel projects and refreshes the canonical durable Turn plan", async () => {
	const activeSession = session("session-1", "thread-1");
	let currentThread: Thread = {
		...thread(),
		sequence: 3,
		turns: [{
			turnId: "turn-1",
			status: "running",
			kind: "coding",
			toolMode: "direct",
			approvalMode: "askPermissions",
			usage: emptyUsage(),
			items: [],
			plan: {
				explanation: "Implement S3",
				steps: [
					{ step: "Implement", status: "inProgress" },
					{ step: "Verify", status: "pending" },
				],
			},
		}],
	};
	const fake = fakeApi({ sessions: [activeSession], thread: () => currentThread });
	using sessions = new AppServerSessionsManagementService(fake.api);
	using model = new ChatPaneModel(createChatService(fake.api), {
		kind: "session",
		active: { session: activeSession, threadId: "thread-1" },
	}, sessions);

	await model.initialize();
	assert.equal(model.items[0]?.id, "turn-plan:turn-1");
	assert.match(model.items[0]?.text ?? "", /In progress:\*\* Implement/);

	currentThread = {
		...currentThread,
		sequence: 4,
		turns: [{
			...currentThread.turns[0],
			plan: {
				explanation: "Implementation complete",
				steps: [
					{ step: "Implement", status: "completed" },
					{ step: "Verify", status: "inProgress" },
				],
			},
		}],
	};
	fake.emit({
		method: "session/thread/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: 4,
			update: {
				type: "committed",
				event: {
					type: "planUpdated",
					threadId: "thread-1",
					turnId: "turn-1",
					plan: currentThread.turns[0].plan!,
				},
			},
		},
	});
	await nextTask();

	assert.equal(model.items.length, 1);
	assert.match(model.items[0]?.text ?? "", /\[x\] Implement/);
	assert.match(model.items[0]?.text ?? "", /In progress:\*\* Verify/);
});

test("ChatPaneModel mechanically clears and replaces transient transcript entries", async () => {
	const activeSession = session("session-1", "thread-1");
	const fake = fakeApi({
		sessions: [activeSession],
		thread: () => thread(),
	});
	using sessions = new AppServerSessionsManagementService(fake.api);
	using model = new ChatPaneModel(createChatService(fake.api), {
		kind: "session",
		active: {
			session: activeSession,
			threadId: "thread-1",
		},
	}, sessions);

	await model.initialize();
	let transcriptRevision = 1;
	const emitChanges = (
		changes: Extract<ServerNotification, { method: "session/thread/transcript/update" }>["params"]["changes"],
		revision = ++transcriptRevision,
	): void => {
		fake.emit({
			method: "session/thread/transcript/update",
			params: {
				sessionId: "session-1",
				threadId: "thread-1",
				durableSequence: 1,
				revision,
				changes,
			},
		});
	};
	const item = (itemId: string) => ({
		type: "upsert" as const,
		entry: {
			type: "item" as const,
			entryId: `item:${itemId}`,
			turnId: "turn-1",
			transient: true,
			item: { type: "agentMessage" as const, itemId, turnId: "turn-1", text: itemId },
		},
	});

	emitChanges([item("old-item")]);
	assert.deepEqual(model.items.map((item) => item.text), ["old-item"]);
	emitChanges([{ type: "clearTransient" }]);
	assert.equal(model.items.length, 0);

	emitChanges([item("new-item")]);
	assert.deepEqual(model.items.map((item) => item.text), ["new-item"]);
	emitChanges([item("duplicate-is-ignored")], transcriptRevision);
	assert.deepEqual(model.items.map((item) => item.text), ["new-item"]);
	emitChanges([item("gap-is-ignored")], transcriptRevision + 2);
	await nextTask();
	assert.deepEqual(model.items.map((item) => item.text), ["new-item"]);
	emitChanges([{ type: "clearTransient" }], transcriptRevision + 3);
	assert.equal(model.items.length, 0);
});

test("ChatPaneModel projects a durable Turn failure into the conversation", async () => {
	const activeSession = session("session-1", "thread-1");
	const failedThread: Thread = {
		advisor: { type: "default" },
		agentId: "agent-1",
		origin: { type: "root" },
		referenceCost: { knownAmounts: [], complete: true },
		sessionId: "session-1",
		threadId: "thread-1",
		title: "Main",
		status: "active",
		sequence: 3,
		usage: emptyUsage(),
		turns: [{
			turnId: "turn-1",
			status: "failed",
			kind: "coding",
			toolMode: "direct",
			approvalMode: "askPermissions",
			usage: emptyUsage(),
			items: [],
			error: {
				code: "providerAuth",
				message: "Model provider authentication failed",
				retryable: false,
			},
		}],
	};
	const fake = fakeApi({ sessions: [activeSession], thread: () => failedThread });
	using sessions = new AppServerSessionsManagementService(fake.api);
	using model = new ChatPaneModel(createChatService(fake.api), {
		kind: "session",
		active: { session: activeSession, threadId: "thread-1" },
	}, sessions);

	await model.initialize();

	assert.deepEqual(model.items, [{
		id: "turn-error:turn-1",
		type: "turnError",
		text: "Model provider authentication failed",
		transient: false,
		isError: true,
		label: "Authentication",
		detail: "Choose a model with working credentials before sending another message.",
		errorCode: "providerAuth",
		action: { type: "chooseModel", label: "Choose another model" },
	}]);
	assert.equal(model.state, "ready");
});

test("Turn error presentation is selected only from the stable error code", () => {
	const message = "same opaque message";
	const cases: readonly { readonly code: TurnError["code"]; readonly retryable: boolean }[] = [
		{ code: "modelInvocationFailed", retryable: true },
		{ code: "contextOverflow", retryable: true },
		{ code: "providerAuth", retryable: false },
		{ code: "invalidRequest", retryable: false },
		{ code: "invalidResponse", retryable: true },
		{ code: "completionPersistenceFailed", retryable: true },
		{ code: "interactionDeadlineElapsed", retryable: true },
		{ code: "toolRepetition", retryable: false },
		{ code: "usageLimited", retryable: false },
		{ code: "worktreeCaptureFailed", retryable: true },
	];

	assert.deepEqual(cases.map(({ code, retryable }) => {
		const item = chatTurnErrorListItem(failedTurn(code, retryable, message));
		return { code: item?.errorCode, label: item?.label, action: item?.action?.type, message: item?.text };
	}), [
		{ code: "modelInvocationFailed", label: "Model error", action: "retry", message },
		{ code: "contextOverflow", label: "Context limit", action: "startNewChat", message },
		{ code: "providerAuth", label: "Authentication", action: "chooseModel", message },
		{ code: "invalidRequest", label: "Invalid request", action: "revise", message },
		{ code: "invalidResponse", label: "Invalid response", action: "retry", message },
		{ code: "completionPersistenceFailed", label: "Save failed", action: "retry", message },
		{ code: "interactionDeadlineElapsed", label: "Interaction expired", action: "retry", message },
		{ code: "toolRepetition", label: "Repeated tool failure", action: "revise", message },
		{ code: "usageLimited", label: "Usage limit", action: "chooseModel", message },
		{ code: "worktreeCaptureFailed", label: "Worktree capture failed", action: "retry", message },
	]);
});

test("ChatPaneModel rebuilds error actions from canonical Thread state after refresh and reconnect", async () => {
	const activeSession = session("session-1", "thread-1");
	let currentThread = threadWithFailure("providerAuth", false);
	const fake = fakeApi({ sessions: [activeSession], thread: () => currentThread });
	using sessions = new AppServerSessionsManagementService(fake.api);
	using model = new ChatPaneModel(createChatService(fake.api), {
		kind: "session",
		active: { session: activeSession, threadId: "thread-1" },
	}, sessions);
	await model.initialize();

	currentThread = threadWithFailure("toolRepetition", false, 4);
	fake.emit({
		method: "session/thread/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: currentThread.sequence,
			update: {
				type: "committed",
				event: {
					type: "turnFailed",
					threadId: "thread-1",
					turnId: "turn-1",
					error: currentThread.turns[0]!.error!,
				},
			},
		},
	});
	await waitFor(() => model.items[0]?.errorCode === "toolRepetition");
	assert.equal(model.items[0]?.action?.type, "revise");

	currentThread = threadWithFailure("usageLimited", false, 5);
	fake.emitReady();
	await waitFor(() => model.items[0]?.errorCode === "usageLimited");
	assert.equal(model.items[0]?.action?.type, "chooseModel");
});

test("ChatPaneModel retries only the latest retryable failed Turn as a new visible Turn", async () => {
	const activeSession = session("session-1", "thread-1");
	const failedThread = threadWithFailure("modelInvocationFailed", true);
	const fake = fakeApi({ sessions: [activeSession], thread: () => failedThread });
	using sessions = new AppServerSessionsManagementService(fake.api);
	using model = new ChatPaneModel(createChatService(fake.api), {
		kind: "session",
		active: { session: activeSession, threadId: "thread-1" },
	}, sessions);
	await model.initialize();

	await model.retryFailedTurn("turn-1");

	assert.deepEqual(fake.turnStartRequests.map(({ expectedSequence, input }) => ({ expectedSequence, input })), [{
		expectedSequence: failedThread.sequence,
		input: [{ type: "text", text: "Try again." }],
	}]);
	await assert.rejects(model.retryFailedTurn("older-turn"), /Only the latest retryable failed Turn/);
});

interface FakeOptions {
	readonly sessions?: readonly ISession[];
	readonly createSession?: ISession;
	readonly createSessionError?: Error;
	readonly createThread?: {
		readonly session: ISession;
		readonly threadId: string;
	};
	readonly thread?: () => Thread;
	readonly skills?: readonly {
		readonly id: { readonly source: string; readonly name: string };
		readonly description: string;
		readonly contentDigest: string;
		readonly enabled: boolean;
		readonly compatible: boolean;
	}[];
	readonly models?: readonly {
		readonly model: ModelRef;
		readonly displayName: string;
		readonly access: "apiKey" | "subscription" | "local" | "enterprise" | "unknown";
		readonly outputTransport: "nativeStreaming" | "unary";
	}[];
}

function createChatService(api: IRendererHost, configurationService?: WorkbenchConfigurationService): ChatService {
	return new ChatService({ modelApi: api.model, threadApi: api.thread, turnApi: api.turn, turnChangesApi: api.turnChanges, skillApi: api.skills, appServerApi: api.appServer, eventApi: api.events, ...(configurationService ? { configurationService } : {}) });
}

test("Chat service retains Agent identity and branch origin when reading a Thread", async () => {
	const fake = fakeApi();
	using chat = createChatService(fake.api);
	const read = await chat.readThread("session-1", "thread-1");
	assert.equal(read.thread.agentId, "agent-1");
	assert.deepEqual(read.thread.origin, { type: "root" });
});

test("Chat service accepts committed fork-history import notifications", () => {
	const fake = fakeApi();
	using chat = createChatService(fake.api);
	const updates: ThreadUpdateEnvelope[] = [];
	using listener = chat.onDidUpdateThread(update => updates.push(update));

	fake.emit({
		method: "session/thread/update",
		params: {
			sessionId: "session-1",
			threadId: "thread-1",
			durableSequence: 2,
			update: {
				type: "committed",
				event: {
					type: "forkHistoryImported",
					threadId: "thread-1",
					sourceThreadId: "thread-source",
					sourceSequence: 7,
					turns: [],
				},
			},
		},
	});

	assert.deepEqual(updates, [{
		sessionId: "session-1",
		threadId: "thread-1",
		durableSequence: 2,
		streamCursor: undefined,
		update: { type: "committed", event: { type: "forkHistoryImported" } },
	}]);
});

test("Chat service projects unique enabled Skills and submits the exact pinned reference", async () => {
	const commit = {
		id: { source: "user:skill-source:test", name: "commit" },
		description: "Draft a commit message",
		contentDigest: "sha256:commit",
		enabled: true,
		compatible: true,
	};
	const fake = fakeApi({ skills: [
		commit,
		{ ...commit, id: { source: "workspace:disabled-commit", name: "commit" }, enabled: false },
		{ ...commit, id: { source: "workspace:one", name: "duplicate" } },
		{ ...commit, id: { source: "workspace:two", name: "duplicate" } },
		{ ...commit, id: { source: "workspace:disabled", name: "disabled" }, enabled: false },
	] });
	using chat = createChatService(fake.api);

	const selectors = await chat.listSkillSelectors();

	assert.deepEqual(selectors, [{
		name: "commit",
		description: "Draft a commit message",
		source: "user:skill-source:test",
		skill: {
			id: { source: "user:skill-source:test", name: "commit" },
			version: { type: "pinnedDigest", digest: "sha256:commit" },
		},
	}]);
	await chat.startTurn({ sessionId: "session-1", threadId: "thread-1", expectedSequence: 1, text: "$commit staged changes", skills: [selectors[0]!.skill] });
	assert.deepEqual(fake.turnStartRequests[0]?.input, [
		{ type: "skill", skill: selectors[0]!.skill },
		{ type: "text", text: "$commit staged changes" },
	]);
});

test("Chat service caches the static catalog and filters picker entries by user visibility", async () => {
	const first = {
		model: { provider: "openai", model: "gpt-5.6-sol" },
		displayName: "GPT-5.6 Sol",
		access: "subscription" as const,
		outputTransport: "nativeStreaming" as const,
	};
	const second = {
		model: { provider: "anthropic", model: "claude-opus-5" },
		displayName: "Claude Opus 5",
		access: "apiKey" as const,
		outputTransport: "nativeStreaming" as const,
	};
	const third = {
		model: { provider: "openai", model: "gpt-5.6" },
		displayName: "GPT-5.6",
		access: "apiKey" as const,
		outputTransport: "nativeStreaming" as const,
	};
	const fake = fakeApi({ models: [first, second, third] });
	using configuration = new WorkbenchConfigurationService();
	using chat = createChatService(fake.api, configuration);

	assert.deepEqual(await chat.listModels(), [first, second, third]);
	assert.deepEqual(await chat.listModelCatalog(), [first, second, third]);
	assert.equal(fake.modelListRequests.length, 1);

	await chat.setModelVisible(first.model, false);

	assert.deepEqual(await chat.listModels(), [second, third]);
	assert.deepEqual(configuration.getValue(ModelCatalogConfiguration.hiddenModels), [first.model]);
	await chat.refreshModels();
	assert.equal(fake.modelListRequests.length, 2);
});

test("Chat picker retains the selected model when it is hidden", async () => {
	const entry = {
		model: { provider: "openai", model: "gpt-5.6-sol" },
		displayName: "GPT-5.6 Sol",
		access: "subscription" as const,
		outputTransport: "nativeStreaming" as const,
	};
	const activeSession = { ...session("session-1", "thread-1"), model: entry.model };
	const fake = fakeApi({ sessions: [activeSession], models: [entry] });
	using configuration = new WorkbenchConfigurationService();
	await configuration.updateValue(ModelCatalogConfiguration.hiddenModels, [entry.model]);
	using chat = createChatService(fake.api, configuration);
	using sessions = new AppServerSessionsManagementService(fake.api);
	using model = new ChatPaneModel(chat, { kind: "session", active: { session: activeSession, threadId: "thread-1" } }, sessions);

	await model.initialize();

	assert.deepEqual(await chat.listModels(), []);
	assert.deepEqual(model.models, [entry]);
	assert.deepEqual(model.selectedModel, entry.model);
});

test("ChatPaneModel steers an active Turn instead of starting another Turn", async () => {
	const activeSession = session("session-1", "thread-1");
	const activeThread: Thread = {
		...thread(),
		sequence: 4,
		turns: [{
			turnId: "turn-running",
			status: "running",
			kind: "coding",
			toolMode: "direct",
			approvalMode: "askPermissions",
			usage: emptyUsage(),
			items: [{
				type: "userMessage",
				itemId: "item-user",
				turnId: "turn-running",
				text: "initial request",
			}],
		}],
	};
	const fake = fakeApi({ sessions: [activeSession], thread: () => activeThread });
	using chat = createChatService(fake.api);
	using sessions = new AppServerSessionsManagementService(fake.api);
	using model = new ChatPaneModel(chat, { kind: "session", active: { session: activeSession, threadId: "thread-1" } }, sessions);
	await model.initialize();

	await model.send("focus on the failing test");

	assert.equal(fake.turnStartRequests.length, 0);
	assert.deepEqual(fake.turnSteerRequests, [{
		commandId: fake.turnSteerRequests[0]?.commandId,
		sessionId: "session-1",
		threadId: "thread-1",
		turnId: "turn-running",
		expectedSequence: 4,
		input: [{ type: "text", text: "focus on the failing test" }],
	}]);
});

test("ChatPaneModel dispatches compact as a standalone server command", async () => {
	const activeSession = session("session-1", "thread-1");
	const fake = fakeApi({ sessions: [activeSession], thread: () => thread("previous answer") });
	using chat = createChatService(fake.api);
	using sessions = new AppServerSessionsManagementService(fake.api);
	using model = new ChatPaneModel(chat, { kind: "session", active: { session: activeSession, threadId: "thread-1" } }, sessions);
	await model.initialize();

	await model.executeServerCommand("compact", "preserve the deployment decision");

	assert.equal(fake.turnStartRequests.length, 0);
	assert.deepEqual(fake.turnCompactRequests, [{
		commandId: fake.turnCompactRequests[0]?.commandId,
		sessionId: "session-1",
		threadId: "thread-1",
		expectedSequence: 4,
		retentionPrompt: "preserve the deployment decision",
	}]);
});

function testLayoutService(auxiliaryBarVisible = true): IWorkbenchLayoutService {
	const visibility = new Emitter<WorkbenchPartVisibilityChangeEvent>();
	const visibleParts = new Set<WorkbenchPartId>(auxiliaryBarVisible ? ["auxiliarybar"] : []);
	const updateVisibility = (partId: WorkbenchPartId, visible: boolean): void => {
		if (visible === visibleParts.has(partId)) return;
		if (visible) visibleParts.add(partId);
		else visibleParts.delete(partId);
		visibility.fire({ partId, visible });
	};
	return {
		onDidChangePartVisibility: visibility.event,
		isPartVisible: (partId) => visibleParts.has(partId),
		showPart: (partId) => updateVisibility(partId, true),
		showParts: (partIds) => partIds.forEach((partId) => updateVisibility(partId, true)),
		hidePart: (partId) => updateVisibility(partId, false),
		hideParts: (partIds) => partIds.forEach((partId) => updateVisibility(partId, false)),
	} as IWorkbenchLayoutService;
}

function fakeApi(options: FakeOptions = {}): {
	readonly api: IRendererHost;
	readonly archiveRequests: readonly SessionMutationParams[];
	readonly stopRequests: readonly SessionMutationParams[];
	readonly createSessionRequests: readonly SessionCreateParams[];
	readonly createThreadRequests: readonly SessionOperationInput<"createThread">[];
	readonly turnStartRequests: readonly SessionOperationInput<"startTurn">[];
	readonly advisorRequests: readonly SessionOperationInput<"configureAdvisor">[];
	readonly consultRequests: readonly SessionOperationInput<"consultAdvisor">[];
	readonly turnCompactRequests: readonly SessionOperationInput<"compactContext">[];
	readonly turnSteerRequests: readonly SessionOperationInput<"steerTurn">[];
	readonly modelListRequests: readonly undefined[];
	readonly modelRequests: readonly { readonly commandId: string; readonly model: ModelRef }[];
	readonly emit: (notification: ServerNotification) => void;
	readonly emitReady: () => void;
} {
	const listeners = new Set<(notification: ServerNotification) => void>();
	const connectionListeners = new Set<(state: "ready") => void>();
	const archiveRequests: SessionMutationParams[] = [];
	const stopRequests: SessionMutationParams[] = [];
	const createSessionRequests: SessionCreateParams[] = [];
	const createThreadRequests: SessionOperationInput<"createThread">[] = [];
	const turnStartRequests: SessionOperationInput<"startTurn">[] = [];
	const advisorRequests: SessionOperationInput<"configureAdvisor">[] = [];
	const consultRequests: SessionOperationInput<"consultAdvisor">[] = [];
	const turnCompactRequests: SessionOperationInput<"compactContext">[] = [];
	const turnSteerRequests: SessionOperationInput<"steerTurn">[] = [];
	const modelListRequests: undefined[] = [];
	const modelRequests: { readonly commandId: string; readonly model: ModelRef }[] = [];
	const currentThread = () => options.thread?.() ?? thread();
	const currentSession = (sessionId: string): ISession => options.sessions?.find(candidate => candidate.sessionId === sessionId)
		?? (options.createThread?.session.sessionId === sessionId ? options.createThread.session : undefined)
		?? (options.createSession?.sessionId === sessionId ? options.createSession : undefined)
		?? session(sessionId);
	const api = {
		appServer: {
			getConnectionState: async () => "ready" as const,
			getSlashCommands: async () => [],
			onConnectionState: (next: (state: "ready") => void) => {
				connectionListeners.add(next);
				return { dispose: () => { connectionListeners.delete(next); } };
			},
		},
		session: {
			list: async () => ({ sessions: (options.sessions ?? []).map(sessionDto) }),
			read: async ({ sessionId }: { sessionId: string }) => ({
				session: sessionDto(currentSession(sessionId)),
			}),
			subscribe: async ({ sessionId }: { sessionId: string }) => ({
				session: sessionDto(currentSession(sessionId)),
				updates: [],
				threadProjections: [],
				agentTree: { roots: [] },
			}),
			unsubscribe: async () => undefined,
			create: async (params: SessionCreateParams) => {
				createSessionRequests.push(params);
				if (options.createSessionError) throw options.createSessionError;
				return { session: sessionDto(options.createSession ?? session("created")) };
			},
			createThread: async (params: SessionOperationInput<"createThread">) => {
				createThreadRequests.push(params);
				const created = options.createThread ?? {
					session: session("created", "created-thread"),
					threadId: "created-thread",
				};
				return { ...created, session: sessionDto(created.session) };
			},
			archive: async (params: SessionMutationParams) => {
				archiveRequests.push(params);
				const archived = options.sessions?.find(
					({ sessionId }) => sessionId === params.sessionId,
				) ?? session(params.sessionId);
				return {
					session: {
						...sessionDto(archived),
							status: "archived" as const,
					},
				};
			},
			stop: async (params: SessionMutationParams) => {
				stopRequests.push(params);
				const stopped = options.sessions?.find(
					({ sessionId }) => sessionId === params.sessionId,
				) ?? session(params.sessionId);
				return {
					session: {
						...sessionDto(stopped),
							status: "archived" as const,
					},
				};
			},
		},
		model: {
			list: async () => {
				modelListRequests.push(undefined);
				return { models: [...(options.models ?? [])] };
			},
			readModel: async () => options.sessions?.find(session => session.model)?.model ?? null,
			setModel: async (params: { readonly commandId: string; readonly model: ModelRef }) => {
				modelRequests.push(params);
			},
		},
		skills: {
			list: async () => ({ generation: 1, skills: options.skills ?? [] }),
		},
		thread: {
			configureAdvisor: async (params: SessionOperationInput<"configureAdvisor">) => { advisorRequests.push(params); return { sequence: params.expectedSequence + 1 }; },
			read: async () => {
				const value = currentThread();
				return { thread: value, transcript: transcript(value) };
			},
			subscribe: async () => ({
				thread: currentThread(),
				transcript: transcript(currentThread()),
				updates: [],
			}),
			unsubscribe: async () => undefined,
		},
		turn: {
			consultAdvisor: async (params: SessionOperationInput<"consultAdvisor">) => { consultRequests.push(params); return { turnId: "advisor-turn", sequence: params.expectedSequence + 1 }; },
			start: async (params: SessionOperationInput<"startTurn">) => {
				turnStartRequests.push(params);
				return { turnId: "turn-started", sequence: 2 };
			},
			compact: async (params: SessionOperationInput<"compactContext">) => {
				turnCompactRequests.push(params);
				return { turnId: "turn-compact", sequence: params.expectedSequence + 2 };
			},
			steer: async (params: SessionOperationInput<"steerTurn">) => {
				turnSteerRequests.push(params);
				return { turnId: params.turnId, sequence: params.expectedSequence + 2 };
			},
			interrupt: async () => ({ sequence: 3 }),
			resolveInteraction: async () => ({ sequence: 3 }),
		},
		events: {
			subscribe: (next: (notification: ServerNotification) => void) => {
				listeners.add(next);
				return { dispose: () => { listeners.delete(next); } };
			},
		},
	} as unknown as IRendererHost;
	return {
		api,
		archiveRequests,
		stopRequests,
		createSessionRequests,
		createThreadRequests,
		turnStartRequests,
		advisorRequests,
		consultRequests,
		turnCompactRequests,
		turnSteerRequests,
		modelListRequests,
		modelRequests,
		emit: (notification) => {
			for (const listener of listeners) listener(notification);
		},
		emitReady: () => {
			for (const listener of connectionListeners) listener("ready");
		},
	};
}

function session(
	id: string,
	threadId?: string,
	title = `Session ${id}`,
): ISession {
	return {
		sessionId: id,
		title,
		status: "active",
		nextApprovalMode: "askPermissions",
		chats: threadId
			? [{ threadId, origin: { type: "root" }, status: "active" }]
			: [],
	};
}

function sessionDto(value: ISession): SessionDto {
	return {
		sessionId: value.sessionId,
		title: value.title,
		status: value.status,
		manager: { status: "idle", statusChangedAtUnixMs: 0 },
		threads: value.chats.map(chat => ({
			threadId: chat.threadId,
			title: `Thread ${chat.threadId}`,
			createdAtUnixMs: 0,
			completedTurnDurationMs: 0,
			usage: emptyUsage(),
			status: chat.status,
			...(chat.origin.type === "root" ? {} : { parentThreadId: chat.origin.parentThreadId }),
			...(chat.origin.type === "fork" || chat.origin.type === "rewind" ? { forkedFromId: chat.origin.parentThreadId } : {}),
		})),
	};
}

function thread(agentText?: string): Thread {
	return {
		advisor: { type: "default" },
		agentId: "agent-1",
		origin: { type: "root" },
		referenceCost: { knownAmounts: [], complete: true },
		sessionId: "session-1",
		threadId: "thread-1",
		title: "Main",
		status: "active",
		sequence: agentText ? 4 : 1,
		usage: emptyUsage(),
		turns: agentText
			? [{
				turnId: "turn-1",
				status: "completed",
				kind: "coding",
				toolMode: "direct",
				approvalMode: "askPermissions",
				usage: emptyUsage(),
				items: [{
					type: "agentMessage",
					itemId: "item-1",
					turnId: "turn-1",
					text: agentText,
				}],
			}]
			: [],
	};
}

function transcript(value: Thread): ThreadTranscriptSnapshot {
	return {
		sessionId: value.sessionId,
		threadId: value.threadId,
		durableSequence: value.sequence,
		revision: value.sequence,
		entries: value.turns.flatMap((turn) => [
			...turn.items.map((item) => ({ type: "item" as const, entryId: `item:${item.itemId}`, turnId: turn.turnId, item, transient: false })),
			...(turn.plan ? [{ type: "turnPlan" as const, entryId: `turn-plan:${turn.turnId}`, turnId: turn.turnId, plan: turn.plan }] : []),
			...(turn.error ? [{ type: "turnError" as const, entryId: `turn-error:${turn.turnId}`, turnId: turn.turnId, error: turn.error }] : []),
		]),
	};
}

function failedTurn(code: TurnError["code"], retryable: boolean, message = "Turn failed"): Thread["turns"][number] {
	return {
		turnId: "turn-1",
		status: "failed",
		kind: "coding",
		toolMode: "direct",
		approvalMode: "askPermissions",
		usage: emptyUsage(),
		items: [],
		error: { code, message, retryable },
	};
}

function threadWithFailure(code: TurnError["code"], retryable: boolean, sequence = 3): Thread {
	return {
		advisor: { type: "default" },
		agentId: "agent-1",
		origin: { type: "root" },
		referenceCost: { knownAmounts: [], complete: true },
		sessionId: "session-1",
		threadId: "thread-1",
		title: "Main",
		status: "active",
		sequence,
		usage: emptyUsage(),
		turns: [failedTurn(code, retryable)],
	};
}

function emptyUsage(): Thread["usage"] {
	return {
		modelInvocations: 0,
		inputTokens: { reported: 0, complete: true },
		outputTokens: { reported: 0, complete: true },
		cachedInputTokens: { reported: 0, complete: true },
		cacheWriteInputTokens: { reported: 0, complete: true },
		reasoningTokens: { reported: 0, complete: true },
	};
}

function typeChatText(targetWindow: typeof browserEnvironment.window, input: HTMLTextAreaElement, text: string): void {
	input.value = text;
	input.dispatchEvent(new targetWindow.Event("input", { bubbles: true }));
}

function nextTask(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt += 1) {
		if (predicate()) return;
		await nextTask();
	}
	assert.fail("Timed out waiting for Chat view state");
}


test("Audio history identifies the sender and recording duration", () => {
	const dom = new JSDOM("<!doctype html><body></body>");
	using list = new ChatListWidget(dom.window.document.body);
	list.render([chatListItem({
		type: "userAudioAttachment", itemId: "audio", turnId: "turn",
		attachment: { contentDigest: "sha256:audio", mediaType: "wav", encodedBytes: 32044, durationMs: 1001 },
	})]);
	assert.equal(list.element.textContent, "YouAudio (2 seconds)");
	dom.window.close();
});


test("Advisor commands configure the Thread and consult without starting the worker", async () => {
	const activeSession = session("session-1", "thread-1");
	const fake = fakeApi({ sessions: [activeSession], thread: () => ({ ...thread("previous answer"), advisor: { type: "model", config: { model: { provider: "test", model: "reviewer" }, maxCalls: 3, maxOutputTokens: 2048 } } }) });
	using chat = createChatService(fake.api);
	using sessions = new AppServerSessionsManagementService(fake.api);
	using model = new ChatPaneModel(chat, { kind: "session", active: { session: activeSession, threadId: "thread-1" } }, sessions);
	await model.initialize();
	await model.executeServerCommand("advisor", "off");
	await model.executeServerCommand("advisor", "ask Check cancellation");
	assert.equal(fake.turnStartRequests.length, 0);
	assert.equal(fake.advisorRequests[0]?.selection.type, "off");
	assert.equal(fake.advisorRequests[0]?.expectedSequence, 4);
	assert.equal(fake.consultRequests[0]?.question, "Check cancellation");
	assert.equal(fake.consultRequests[0]?.threadId, "thread-1");
});

test("Advisor transcript groups the call and renders advice as a disclosure", () => {
	const entries: ThreadTranscriptSnapshot["entries"] = [
		{ type: "item", entryId: "call", turnId: "turn", transient: false, item: { type: "toolCall", itemId: "call", turnId: "turn", toolCallId: "consult", name: "advisor", argumentsJson: '{"question":"Check cancellation"}' } },
		{ type: "item", entryId: "result", turnId: "turn", transient: false, item: { type: "toolResult", itemId: "result", turnId: "turn", toolCallId: "consult", text: JSON.stringify({ status: "reviewed", model: { provider: "test", model: "reviewer" }, advice: "Check **cancellation**.", question: "Check cancellation", sourceSequence: 10, usage: { inputTokens: 120, outputTokens: 8 } }), isError: false } },
	];
	const items = chatTranscriptListItems(entries);
	assert.equal(items.length, 1);
	assert.equal(items[0]?.type, "advisor");
	const container = document.createElement("div");
	using widget = new ChatListWidget(container);
	widget.render(items);
	assert.equal(container.querySelector("summary")?.textContent, "Advisor · test/reviewer");
	assert.equal(container.querySelector("strong")?.textContent, "cancellation");
	assert.match(container.textContent ?? "", /120 input · 8 output/);
});
