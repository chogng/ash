import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { CommandRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TerminalCommandId } from '../../common/terminal.js';
import { setupTerminalMenus } from '../../browser/terminalMenus.js';
import assert from "node:assert/strict";
import { test, suiteTeardown } from "mocha";
import { JSDOM } from "jsdom";
import type { IAction } from "../../../../../base/common/actions.js";
import { Event } from "../../../../../base/common/event.js";
import { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import type { ITerminalInstance } from "../../browser/terminal.js";
import { AppServerAvailableContext } from '../../../../common/contextkeys.js';

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
	Object.defineProperty(globalThis, name, {
		configurable: true,
		value,
	});
}

const [
	{ ContextKeyService },
	{ MenuService },
	{ InstantiationService },
	{ CommandService },
	{ TerminalTitleActions },
] = await Promise.all([
	import("../../../../../platform/contextkey/browser/contextKeyService.js"),
	import("../../../../../platform/actions/common/menuService.js"),
	import('../../../../../platform/instantiation/common/instantiationService.js'),
	import("../../../../../workbench/services/commands/common/commandService.js"),
	import("../../../../../workbench/contrib/terminal/browser/terminalView.js"),
]);

suiteTeardown(() => {
	browserEnvironment.window.close();
	for (const name of ["window", "document", "Node", "Element", "HTMLElement", "Event", "MouseEvent", "navigator"]) {
		Reflect.deleteProperty(globalThis, name);
	}
});

setupTerminalMenus();

let shownProfileActions: readonly IAction[] = [];
let shownProfileAnchor: unknown;

const contextMenuService: IContextMenuService = {
	onDidShowContextMenu: Event.None,
	onDidHideContextMenu: Event.None,
	showContextMenu(options) {
		shownProfileActions = options.getActions?.() ?? [];
		shownProfileAnchor = options.getAnchor();
	},
	hideContextMenu() { },
};

test("Terminal profile menu launches the selected shell profile", async () => {
	const ownerDocument = browserEnvironment.window.document;
	ownerDocument.body.replaceChildren();
	shownProfileActions = [];
	shownProfileAnchor = undefined;
	const createdProfiles: Array<string | undefined> = [];
	let focusCount = 0;
	let clearCount = 0;
	using contextKeyService = new ContextKeyService();
	const appServerAvailable = AppServerAvailableContext.bindTo(contextKeyService);
	appServerAvailable.set(true);
	using registryOwner = new InstantiationService();
	const registry = new CommandRegistry();
	using registration = registry.registerMany([
		{ id: TerminalCommandId.New, handler: () => { createdProfiles.push(undefined); } },
		{ id: TerminalCommandId.NewWithProfile, handler: (_accessor, profileId) => { createdProfiles.push(String(profileId)); } },
		{ id: TerminalCommandId.Focus, handler: () => focusCount++ },
		{ id: TerminalCommandId.Relaunch, handler: () => { } },
		{ id: TerminalCommandId.Kill, handler: () => { } },
		{ id: TerminalCommandId.Clear, handler: () => clearCount++ },
	]);
	using commandService = new CommandService(registryOwner, registry);
	const menuService = new MenuService(commandService, contextKeyService);
	registryOwner.registerInstance(ICommandService, commandService);
	registryOwner.registerInstance(IMenuService, menuService);
	registryOwner.registerInstance(IContextMenuService, contextMenuService);
	registryOwner.registerInstance(IContextKeyService, contextKeyService);
	using titleActions = registryOwner.createInstance(TerminalTitleActions, ownerDocument.body);

	const commandPromptProfile = { profileId: "cmd", title: "Command Prompt", isDefault: true };
	const powerShellProfile = { profileId: "pwsh", title: "PowerShell", isDefault: false };
	const unavailableProfile = titleActions.element.querySelector<HTMLButtonElement>(".ash-dropdown-with-primary-dropdown > .ash-button");
	assert.ok(unavailableProfile);
	assert.equal(unavailableProfile.disabled, true);
	titleActions.setProfiles([commandPromptProfile, powerShellProfile]);
	ownerDocument.body.append(titleActions.element);

	const toolbar = titleActions.element;
	assert.equal(toolbar.getAttribute("role"), "toolbar");
	assert.equal(toolbar.classList.contains("highlight-toggled"), true);
	const splitNewTerminal = toolbar.querySelector<HTMLElement>(".ash-dropdown-with-primary-action-view-item");
	const profile = splitNewTerminal?.querySelector<HTMLButtonElement>(".ash-dropdown-with-primary-dropdown > .ash-button");
	assert.ok(splitNewTerminal);
	assert.ok(profile);
	assert.equal(profile.disabled, false);
	assert.equal(profile.querySelector(".ash-button-label")?.textContent, "Select Terminal Profile");
	assert.equal(profile.getAttribute("aria-label"), "Select Terminal Profile");
	assert.ok(profile.querySelector("svg.ash-icon"));
	assert.equal(toolbar.querySelectorAll("[data-action-id='workbench.action.terminal.new']").length, 1);
	assert.equal(toolbar.querySelector("[data-action-id='workbench.action.terminal.newWithProfile']"), null);
	const newTerminal = [...toolbar.querySelectorAll("button")].find((button) => button.textContent === "New Terminal");
	assert.ok(newTerminal);
	assert.equal([...toolbar.querySelectorAll("button")].some((button) => button.textContent === "Close Panel"), false);
	assert.equal([...toolbar.querySelectorAll("button")].some((button) => button.textContent === "Maximize Panel"), false);
	const currentNewTerminal = [...toolbar.querySelectorAll("button")].find((button) => button.textContent === "New Terminal");
	assert.ok(currentNewTerminal);
	currentNewTerminal.click();
	await Promise.resolve();
	assert.deepEqual(createdProfiles, [undefined]);
	appServerAvailable.set(false);
	assert.equal([...toolbar.querySelectorAll("button")].find(button => button.textContent === "New Terminal")?.disabled, true);
	appServerAvailable.set(true);
	assert.equal([...toolbar.querySelectorAll("button")].find(button => button.textContent === "New Terminal")?.disabled, false);
	titleActions.setCreating(true);
	assert.equal([...toolbar.querySelectorAll("button")].find((button) => button.textContent === "New Terminal")?.disabled, true);
	titleActions.setCreating(false);
	const activeInstance = {
		id: "terminal-1",
		title: "Backend shell",
		profile: commandPromptProfile,
		state: "running",
	} as ITerminalInstance;
	titleActions.setActiveInstance(activeInstance, "title");
	const activeTerminal = toolbar.querySelector<HTMLButtonElement>(".ash-terminal-active-action .ash-action-label");
	assert.ok(activeTerminal);
	assert.equal(activeTerminal.querySelector(".ash-action-label-text")?.textContent, "Backend shell");
	assert.ok(activeTerminal.querySelector(".ash-action-label-icon > svg.ash-icon"));
	assert.equal(activeTerminal.classList.contains("ash-button"), false);
	assert.equal(activeTerminal.querySelector(".ash-button-label"), null);
	assert.equal(activeTerminal.querySelector(".ash-icon-label"), null);
	assert.equal(activeTerminal.getAttribute("aria-label"), "Active terminal: Backend shell (Command Prompt)");
	activeTerminal.click();
	await Promise.resolve();
	assert.equal(focusCount, 1);
	assert.equal(toolbar.textContent?.includes("Kill Terminal"), true);
	assert.equal(toolbar.textContent?.includes("Relaunch Terminal"), false);
	const killTerminal = [...toolbar.querySelectorAll("[data-action-id]")].find((item) => item.getAttribute("data-action-id") === "workbench.action.terminal.kill");
	const moreActions = toolbar.querySelector<HTMLElement>("[data-action-id='ash.toolbar.moreActions']");
	assert.ok(killTerminal);
	assert.ok(moreActions);
	assert.equal(killTerminal.compareDocumentPosition(moreActions) & browserEnvironment.window.Node.DOCUMENT_POSITION_FOLLOWING, browserEnvironment.window.Node.DOCUMENT_POSITION_FOLLOWING);
	assert.equal(toolbar.querySelector("[data-action-id='workbench.action.toggleMaximizedPanel']"), null);
	moreActions.querySelector("button")?.click();
	const clearTerminal = shownProfileActions.find((action) => action.id === "workbench.action.terminal.clear");
	assert.ok(clearTerminal);
	assert.equal(shownProfileActions.some((action) => action.id.startsWith("ash.compositeBar.open.")), false);
	await clearTerminal.run();
	assert.equal(clearCount, 1);
	titleActions.setActiveInstance(activeInstance, "list");
	assert.equal(toolbar.querySelector(".ash-terminal-active-action"), null);
	assert.equal(toolbar.textContent?.includes("Kill Terminal"), true);
	titleActions.setActiveInstance({
		id: "terminal-1",
		title: "Backend shell",
		profile: commandPromptProfile,
		state: "exited",
	} as ITerminalInstance, "list");
	assert.equal(toolbar.textContent?.includes("Relaunch Terminal"), true);
	titleActions.setActiveInstance(activeInstance, "title");
	assert.doesNotThrow(() => titleActions.setActiveInstance(undefined, "title"));
	assert.equal(toolbar.querySelector(".ash-terminal-active-action"), null);
	assert.equal(toolbar.textContent?.includes("Kill Terminal"), false);
	titleActions.setActiveInstance(activeInstance, "list");

	const currentProfile = toolbar.querySelector<HTMLButtonElement>(".ash-dropdown-with-primary-dropdown > .ash-button");
	assert.ok(currentProfile);
	currentProfile.click();
	assert.equal(currentProfile.getAttribute("aria-haspopup"), "menu");
	assert.equal(currentProfile.getAttribute("aria-expanded"), "true");
	assert.equal(shownProfileAnchor, currentProfile);
	assert.equal(ownerDocument.querySelector(".ash-quick-pick"), null);
	const commandPrompt = shownProfileActions.find((action) => action.label.includes("Command Prompt"));
	const powerShell = shownProfileActions.find((action) => action.label.includes("PowerShell"));
	assert.ok(commandPrompt);
	assert.ok(powerShell);
	assert.match(commandPrompt.label, /Default/);
	assert.equal(commandPrompt.checked, true);
	assert.equal(powerShell.checked, false);
	await powerShell.run();
	await Promise.resolve();
	assert.deepEqual(createdProfiles, [undefined, "pwsh"]);
});


test('Terminal View lends its actual title toolbar to Panel and retains it through switching', async () => {
	const { DisposableStore, toDisposable } = await import('../../../../../base/common/lifecycle.js');
	const { registerTestComponentServices } = await import('../../../../test/common/testEditorServices.js');
	const { ITerminalService } = await import('../../browser/terminal.js');
	const { TerminalViewPane } = await import('../../browser/terminalView.js');
	const { IWorkbenchLayoutService } = await import('../../../../services/layout/browser/layoutService.js');
	const { WorkspaceContextService } = await import('../../../../services/workspaces/browser/workspaceContextService.js');
	const { IWorkspaceContextService } = await import('../../../../../platform/workspace/common/workspace.js');
	const { IPreferencesService } = await import('../../../../services/preferences/common/preferences.js');
	const { INotificationService } = await import('../../../../../platform/notification/common/notification.js');
	const { NotificationService } = await import('../../../../services/notification/common/notificationService.js');
	const { WorkbenchLayout } = await import('../../../../browser/layout.js');
	const { Dimension } = await import('../../../../../base/browser/dom.js');
	const { WorkbenchConfigurationService } = await import('../../../../services/configuration/browser/configurationService.js');
	const { IConfigurationService } = await import('../../../../../platform/configuration/common/configuration.js');
	const { IAccessibleViewService } = await import('../../../../../platform/accessibility/browser/accessibleView.js');
	const { IChatSpeechToTextService, ChatSpeechToTextService } = await import('../../../chat/browser/speechToText/chatSpeechToTextService.js');
	const { IDictationOnboardingService, DictationOnboardingService } = await import('../../../chat/browser/speechToText/dictationOnboarding.js');
	const { WorkbenchViewRegistry, IViewDescriptorService, ViewContainerLocation } = await import('../../../../common/views.js');
	const { ViewDescriptorService } = await import('../../../../services/views/browser/viewDescriptorService.js');
	const { SyncDescriptor } = await import('../../../../../platform/instantiation/common/descriptors.js');
	const { PaneComposite } = await import('../../../../browser/parts/views/paneComposite.js');
	const { PanelPart } = await import('../../../../browser/parts/panel/panelPart.js');
	const { ILocalizationService } = await import('../../../../services/localization/common/localizationService.js');
	using resources = new DisposableStore();
	const services = resources.add(registerTestComponentServices(new InstantiationService()));
	const context = resources.add(new ContextKeyService());
	services.registerInstance(IContextKeyService, context);
	AppServerAvailableContext.bindTo(context).set(true);
	const commands = new CommandRegistry();
	let created = 0;
	resources.add(commands.registerMany([{ id: TerminalCommandId.New, handler: () => { created++; } }]));
	const commandService = resources.add(new CommandService(services, commands));
	services.registerInstance(ICommandService, commandService);
	services.registerInstance(IMenuService, new MenuService(commandService, context));
	services.registerInstance(IContextMenuService, contextMenuService);
	services.registerInstance(IWorkspaceContextService, resources.add(new WorkspaceContextService({ id: 'terminal-title-test', folders: [] })));
	// This scenario has no workspace or shell. Any shell acquisition would violate the title lifecycle boundary.
	services.registerInstance(ITerminalService, {
		instances: [], activeInstance: undefined,
		onDidCreateInstance: Event.None, onDidDisposeInstance: Event.None, onDidChangeInstances: Event.None, onDidChangeActiveInstance: Event.None,
		getProfiles: async () => [], createTerminal: async () => { throw new Error('Unexpected shell acquisition'); },
		relaunchTerminal: async () => { }, setActiveInstance() { }, moveTerminal() { }, closeTerminal: async () => { },
		...toDisposable(() => { }),
	});
	services.registerInstance(IConfigurationService, resources.add(new WorkbenchConfigurationService()));
	services.registerInstance(IWorkbenchLayoutService, resources.add(services.createInstance(WorkbenchLayout, browserEnvironment.window.document.body, { initialDimension: new Dimension(800, 600) })));
	services.registerInstance(IPreferencesService, { openSettings: async () => { } } as import('../../../../services/preferences/common/preferences.js').IPreferencesService);
	services.registerInstance(INotificationService, resources.add(new NotificationService()));
	services.registerInstance(IAccessibleViewService, { ...toDisposable(() => { }), show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp() { } });
	services.registerInstance(IChatSpeechToTextService, resources.add(new ChatSpeechToTextService(undefined)));
	services.registerInstance(IDictationOnboardingService, resources.add(services.createInstance(DictationOnboardingService)));
	services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, source) => source });
	const registry = new WorkbenchViewRegistry();
	const terminal = { id: 'test.terminal', title: 'Terminal', location: ViewContainerLocation.Panel };
	const empty = { id: 'test.empty', title: 'Empty', location: ViewContainerLocation.Panel };
	resources.add(registry.registerViewContainer(terminal));
	resources.add(registry.registerViewContainer(empty));
	resources.add(registry.registerViews(terminal.id, [{ id: 'test.terminalView', title: 'Terminal', canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(TerminalViewPane) }]));
	const descriptors = resources.add(new ViewDescriptorService({ registry }, context));
	services.registerInstance(IViewDescriptorService, descriptors);
	const panel = resources.add(services.createInstance(PanelPart, browserEnvironment.window.document.body));
	const create = (descriptor: typeof terminal) => services.createInstance(PaneComposite, panel.domNode, {
		viewContainer: descriptor, model: descriptors.getViewContainerModel(descriptor.id), instantiationService: services,
		contextKeyService: context, paneHeaders: 'hidden', paneLayout: 'fill',
	});
	const composite = create(terminal);
	panel.addComposite(composite);
	panel.addComposite(create(empty));
	panel.showComposite(terminal.id);
	const pane = composite.getView('test.terminalView')!;
	const toolbar = pane.partTitleProjection!.actions!;
	assert.equal(panel.domNode.querySelector('.ash-pane-composite-title-view-actions [role="toolbar"][aria-label="Terminal actions"]'), toolbar);
	assert.equal(toolbar.getAttribute('role'), 'toolbar');
	assert.equal(toolbar.querySelectorAll('[data-action-id="workbench.action.terminal.new"]').length, 1);
	toolbar.querySelector<HTMLButtonElement>('[data-action-id="workbench.action.terminal.new"] button')!.click();
	await Promise.resolve();
	assert.equal(created, 1);
	panel.showComposite(empty.id);
	assert.equal(toolbar.isConnected, false);
	panel.showComposite(terminal.id);
	assert.equal(composite.getView('test.terminalView'), pane);
	assert.equal(panel.domNode.querySelector('.ash-pane-composite-title-view-actions [role="toolbar"][aria-label="Terminal actions"]'), toolbar);
	panel.dispose();
	assert.equal(toolbar.isConnected, false);
});
