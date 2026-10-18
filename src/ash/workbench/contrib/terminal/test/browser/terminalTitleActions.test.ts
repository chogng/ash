import { ActivityService } from '../../../../services/activity/browser/activityService.js';
import { IActivityService } from '../../../../services/activity/common/activity.js';
import { IChatSpeechToTextService, ChatSpeechToTextService } from '../../../chat/browser/speechToText/chatSpeechToTextService.js';
import { IVoiceCodeTranscriptionClient, VoiceCodeTranscriptionClient } from '../../../chat/browser/speechToText/voiceCodeTranscriptionClient.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { NullTelemetryService } from '../../../../../platform/telemetry/common/telemetryUtils.js';
import { ILocalTranscriptionService, ILocalTranscriptionModelService } from '../../../../../platform/localTranscription/common/localTranscription.js';
import { NullLocalTranscriptionService } from '../../../../services/localTranscription/browser/localTranscriptionService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IEnvironmentVariableService } from '../../common/environmentVariable.js';
import { EnvironmentVariableService } from '../../common/environmentVariableService.js';
import { ITerminalGroupService } from '../../../../services/terminal/browser/terminal.js';
import { TerminalGroupService } from '../../browser/terminalGroupService.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { setIconResolver } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { getIconDefinition } from '../../../../../platform/theme/common/iconRegistry.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import { ITerminalContributionService, ITerminalProfileResolverService, ITerminalProfileService } from '../../../../services/terminal/common/terminal.js';

import { TerminalProfileService } from '../../browser/terminalProfileService.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { ITerminalProcessService } from '../../../../../platform/terminal/common/terminal.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { CommandRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { TerminalCommandId } from '../../common/terminal.js';
import { setupTerminalMenus } from '../../browser/terminalMenus.js';
import assert from "node:assert/strict";
import { test, suite, suiteTeardown } from "mocha";
import { ensureNoDisposablesAreLeakedInTestSuite } from "../../../../../base/test/common/utils.js";
import { JSDOM } from "jsdom";
import type { IAction } from "../../../../../base/common/actions.js";
import { Event } from "../../../../../base/common/event.js";
import { IContextMenuService } from "../../../../../platform/contextview/browser/contextView.js";
import type { ITerminalInstance } from "../../../../services/terminal/browser/terminal.js";
import { AppServerAvailableContext } from '../../../../common/contextkeys.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../services/configuration/test/common/testServices.js';
import { TerminalContextKeys } from '../../common/terminalContextKey.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';

const browserEnvironment = new JSDOM("<!doctype html><body></body>");
setIconResolver(browserEnvironment.window.document, icon => getIconDefinition(icon));
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
const { registerTerminalActions } = await import("../../browser/terminalActions.js");
registerTerminalActions();

let shownProfileActions: readonly IAction[] = [];
let shownProfileAnchor: unknown;

const contextMenuService: IContextMenuService = {
	contextMenuStyle: 'custom' as const,
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
	let splitCount = 0;
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
		{ id: TerminalCommandId.Split, handler: () => splitCount++ },
		{ id: TerminalCommandId.SelectDefaultProfile, handler: () => { } },
	]);
	using commandService = new CommandService(registryOwner, registry);
	const menuService = new MenuService(commandService, contextKeyService);
	registryOwner.registerInstance(ICommandService, commandService);
	registryOwner.registerInstance(IMenuService, menuService);
	registryOwner.registerInstance(IContextMenuService, contextMenuService);
	registryOwner.registerInstance(IContextKeyService, contextKeyService);
	using configuration = new TestConfigurationService();
	registryOwner.registerInstance(IConfigurationService, configuration);
	registryOwner.registerInstance(IKeybindingService, { onDidUpdateKeybindings: Event.None, lookupKeybinding: () => undefined } as unknown as IKeybindingService);
	using titleActions = registryOwner.createInstance(TerminalTitleActions, ownerDocument.body);

	const commandPromptProfile = { profileId: "cmd", title: "Command Prompt", isDefault: true };
	const powerShellProfile = { profileId: "pwsh", title: "PowerShell", isDefault: false };
	const unavailableProfile = titleActions.element.querySelector<HTMLButtonElement>(".ash-dropdown-with-primary-dropdown > .ash-button");
	assert.ok(unavailableProfile);
	assert.equal(unavailableProfile.disabled, false, 'The menu also offers New Terminal and Select Default Profile before discovery');
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
	assert.equal(focusCount, 0, 'The title opens its instance menu instead of focusing the terminal');
	assert.equal(activeTerminal.getAttribute('aria-expanded'), 'true');
	assert.ok(shownProfileActions.find(action => action.id === TerminalCommandId.Rename));
	await shownProfileActions.find(action => action.id === TerminalCommandId.Focus)!.run();
	assert.equal(focusCount, 1);
	activeTerminal.dispatchEvent(new browserEnvironment.window.MouseEvent('click', { bubbles: true, altKey: true }));
	await Promise.resolve();
	assert.equal(splitCount, 1);
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
	assert.equal(toolbar.textContent?.includes("Kill Terminal"), false);
	contextKeyService.setContext(TerminalContextKeys.tabsNarrow.key, true);
	assert.ok(toolbar.querySelector('.ash-terminal-active-action'));
	assert.ok(toolbar.querySelector(`[data-action-id='${TerminalCommandId.Split}']`));
	await configuration.updateValue('terminal.integrated.tabs.showActions', 'never');
	assert.equal(toolbar.querySelector(`[data-action-id='${TerminalCommandId.Kill}']`), null);
	await configuration.updateValue('terminal.integrated.tabs.showActiveTerminal', 'never');
	assert.equal(toolbar.querySelector('.ash-terminal-active-action'), null);
	await configuration.updateValue('terminal.integrated.tabs.showActiveTerminal', 'always');
	assert.ok(toolbar.querySelector('.ash-terminal-active-action'));
	contextKeyService.setContext(TerminalContextKeys.tabsNarrow.key, false);
	await configuration.updateValue('terminal.integrated.tabs.showActiveTerminal', 'singleTerminalOrNarrow');
	await configuration.updateValue('terminal.integrated.tabs.showActions', 'singleTerminalOrNarrow');
	titleActions.setActiveInstance({
		id: "terminal-1",
		title: "Backend shell",
		profile: commandPromptProfile,
		state: "exited",
	} as ITerminalInstance, "list");
	assert.equal(toolbar.textContent?.includes("Relaunch Terminal"), false, 'Relaunch is available in the overflow menu');
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
	assert.equal(commandPrompt.checked, undefined);
	assert.equal(powerShell.checked, undefined);
	await powerShell.run();
	await Promise.resolve();
	assert.deepEqual(createdProfiles, [undefined, "pwsh"]);
});


test('Terminal View lends its actual title toolbar to Panel and retains it through switching', async () => {
	const { Disposable, DisposableStore, toDisposable } = await import('../../../../../base/common/lifecycle.js');
	const { registerTestComponentServices } = await import('../../../../test/common/testEditorServices.js');
	const { ITerminalService } = await import('../../../../services/terminal/browser/terminal.js');
	const { TerminalViewPane } = await import('../../browser/terminalView.js');
	const { IWorkbenchLayoutService } = await import('../../../../services/layout/browser/layoutService.js');
	const { TestWorkspaceService } = await import('../../../../services/configuration/test/common/testServices.js');
	const { IWorkspaceContextService } = await import('../../../../../platform/workspace/common/workspace.js');
	const { IPreferencesService } = await import('../../../../services/preferences/common/preferences.js');
	const { INotificationService } = await import('../../../../../platform/notification/common/notification.js');
	const { NotificationService } = await import('../../../../services/notification/common/notificationService.js');
	const { WorkbenchLayout } = await import('../../../../browser/layout.js');
	const { Dimension } = await import('../../../../../base/browser/dom.js');
	const { TestConfigurationService: WorkbenchConfigurationService } = await import("../../../../services/configuration/test/common/testServices.js");
	const { IConfigurationService } = await import('../../../../../platform/configuration/common/configuration.js');
	const { IAccessibleViewService } = await import('../../../../../platform/accessibility/browser/accessibleView.js');
	const { ISpeechService } = await import('../../../speech/common/speechService.js');
	const { IVoiceCodeTranscriptionBackendService } = await import('../../../../../platform/renderer/common/dictation.js');
	const { SpeechService } = await import('../../../speech/browser/speechService.js');
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
	services.registerInstance(IKeybindingService, { onDidUpdateKeybindings: Event.None, lookupKeybinding: () => undefined } as unknown as IKeybindingService);
	services.registerInstance(IMenuService, new MenuService(commandService, context));
	services.registerInstance(IContextMenuService, contextMenuService);
	services.registerInstance(IWorkspaceContextService, resources.add(new TestWorkspaceService({ id: 'terminal-title-test', folders: [] })));
	// This scenario has no workspace or shell. Any shell acquisition would violate the title lifecycle boundary.
	services.registerInstance(ITerminalService, {
		instances: [], activeInstance: undefined,
		onDidCreateInstance: Event.None, onDidDisposeInstance: Event.None, onDidChangeInstances: Event.None, onDidChangeActiveInstance: Event.None,
		getProfiles: async () => [], createTerminal: async () => { throw new Error('Unexpected shell acquisition'); },
		relaunchTerminal: async () => { }, setActiveInstance() { }, moveTerminal() { }, whenConnected: Promise.resolve(), safeDisposeTerminal: async () => { }, closeTerminal: async () => { },
		...toDisposable(() => { }),
	});
	services.registerInstance(IConfigurationService, resources.add(new WorkbenchConfigurationService()));
	services.registerInstance(ITerminalProcessService, { onConnectionState: Event.None } as ITerminalProcessService);
	services.registerInstance(IViewsService, { openView: async () => null } as unknown as IViewsService);
	services.registerInstance(ITerminalGroupService, resources.add(services.createInstance(TerminalGroupService)));
	services.registerSingleton(IEnvironmentVariableService, () => services.createInstance(EnvironmentVariableService));
	services.registerInstance(ITerminalContributionService, { terminalProfiles: [], onDidChangeTerminalProfiles: Event.None, ...Disposable.None });
	services.registerInstance(IExtensionService, { getExtensionPointContributions: () => [], onDidChange: Event.None } as unknown as IExtensionService);
	services.registerInstance(ITerminalProfileService, resources.add(services.createInstance(TerminalProfileService)));
	services.registerInstance(IEditorService, { activeEditor: undefined } as unknown as IEditorService);
	services.registerInstance(IQuickInputService, {} as IQuickInputService);
	services.registerInstance(ITerminalProfileResolverService, { resolveShellLaunchConfig: async () => { throw new Error('Unexpected shell resolution'); } } as unknown as ITerminalProfileResolverService);
	services.registerInstance(IWorkbenchLayoutService, resources.add(services.createInstance(WorkbenchLayout, browserEnvironment.window.document.body, { initialDimension: new Dimension(800, 600) })));
	services.registerInstance(IPreferencesService, { openSettings: async () => { } } as import('../../../../services/preferences/common/preferences.js').IPreferencesService);
	services.registerInstance(INotificationService, resources.add(new NotificationService()));
	services.registerInstance(IAccessibleViewService, { ...toDisposable(() => { }), show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp() { } });
	services.registerInstance(ISpeechService, resources.add(new SpeechService(undefined)));
	services.registerSingleton(IChatSpeechToTextService, () => services.createInstance(ChatSpeechToTextService));
	services.registerSingleton(IVoiceCodeTranscriptionClient, () => services.createInstance(VoiceCodeTranscriptionClient));
	services.registerInstance(ITelemetryService, NullTelemetryService);
	services.registerInstance(IVoiceCodeTranscriptionBackendService, undefined);
	const localTranscription = resources.add(new NullLocalTranscriptionService());
	services.registerInstance(ILocalTranscriptionService, localTranscription);
	services.registerInstance(ILocalTranscriptionModelService, localTranscription);
	services.registerInstance(ILogService, resources.add(new NullLoggerService()));
	services.registerInstance(IDictationOnboardingService, resources.add(services.createInstance(DictationOnboardingService)));
	services.registerInstance(ILocalizationService, { whenReady: Promise.resolve(), translate: (_bundle, _key, source) => source });
	const unhosted = resources.add(services.createInstance(TerminalViewPane, browserEnvironment.window.document.body, { id: 'test.terminalGeometry', title: 'Terminal' }));
	assert.equal(unhosted.minimumSize, unhosted.minimumBodySize, 'A hidden Terminal header must not reserve body space');
	unhosted.setHeaderVisible(true);
	assert.equal(unhosted.minimumSize, unhosted.minimumBodySize + 28);
	assert.ok(unhosted.element.querySelector('.ash-pane-view-header-button'), 'A host must be able to show the retained header');
	const registry = new WorkbenchViewRegistry();
	const terminal = { id: 'test.terminal', title: 'Terminal', location: ViewContainerLocation.Panel };
	const empty = { id: 'test.empty', title: 'Empty', location: ViewContainerLocation.Panel };
	resources.add(registry.registerViewContainer(terminal));
	resources.add(registry.registerViewContainer(empty));
	resources.add(registry.registerViews(terminal.id, [{ id: 'test.terminalView', title: 'Terminal', canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(TerminalViewPane) }]));
	const descriptors = resources.add(new ViewDescriptorService({ registry }, context));
	services.registerInstance(IViewDescriptorService, descriptors);
	if (!services.has(IActivityService)) services.registerSingleton(IActivityService, () => services.createInstance(ActivityService));
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


suite('Terminal context command lifecycle', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('Terminal context commands resolve captured and serialized identities through the current window', async () => {
		const { InstanceContext } = await import('../../browser/terminalContextMenu.js');
		const { ITerminalService } = await import('../../../../services/terminal/browser/terminal.js');
		const { Disposable } = await import('../../../../../base/common/lifecycle.js');
		const effects: unknown[] = [];
		const create = (instanceId: number) => ({
			...Disposable.None, instanceId, id: `terminal-instance-${instanceId}`, state: 'exited', xterm: undefined,
			dirId: 'workspace', processId: 100 + instanceId, initialCwd: '/workspace', title: 'Shell',
			profile: { profileId: 'shell', title: 'Shell', isDefault: true }, exitCode: 0,
			onDidWriteData: Event.None, onDidChangeCommandStatus: Event.None, onDidExit: Event.None, onDidChangeState: Event.None,
			xtermReadyPromise: Promise.resolve(undefined), getContribution: () => null,
			start() { }, attachToElement() { }, detachFromElement() { }, async sendSignal() { }, async sendText() { }, async processBinary() { }, resize() { },
			async reuseTerminal() { }, async close() { }, clearBuffer: () => { effects.push(['clear', instanceId]); },
			refreshProperty: async () => { throw new Error("No OS process in action fixture"); }, serializeState: async () => { throw new Error("No process checkpoint in action fixture"); },
		} satisfies ITerminalInstance);
		const first = create(1);
		const second = create(2);
		const instances: ITerminalInstance[] = [first, second];
		let active: ITerminalInstance | undefined = second;
		using services = new InstantiationService();
		services.registerInstance(ITerminalService, {
			...Disposable.None, instances, get activeInstance() { return active; },
			onDidCreateInstance: Event.None, onDidDisposeInstance: Event.None, onDidChangeInstances: Event.None, onDidChangeActiveInstance: Event.None,
			getProfiles: async () => [], createTerminal: async () => { throw new Error('Unexpected creation'); },
			setActiveInstance: instance => { active = instance; }, moveTerminal() { },
			whenConnected: Promise.resolve(), safeDisposeTerminal: async instance => { effects.push(['close', instance.instanceId]); instances.splice(instances.indexOf(instance), 1); }, closeTerminal: async instance => { await instance.close(); },
			relaunchTerminal: async (instance, dimensions) => { effects.push(['relaunch', instance.instanceId, dimensions]); },
		});
		using commands = new CommandService(services);
		const context = new InstanceContext(first);
		assert.deepEqual(JSON.parse(JSON.stringify(context)), { $mid: 15, instanceId: 1 });
		assert.deepEqual(Object.keys(context), ['instanceId']);
		await commands.executeCommand(TerminalCommandId.Clear, context);
		await commands.executeCommand(TerminalCommandId.Clear, context.toJSON());
		await commands.executeCommand(TerminalCommandId.Clear, second.id);
		assert.equal(active, second);
		await commands.executeCommand(TerminalCommandId.Relaunch, context);
		assert.deepEqual(effects, [['clear', 1], ['clear', 1], ['clear', 2], ['relaunch', 1, { cols: 80, rows: 24 }]]);
		for (const invalid of [{ $mid: 15, instanceId: '1' }, { $mid: 15, instanceId: -1 }, { $mid: 1, instanceId: 1 }, { instanceId: 1 }]) {
			await assert.rejects(commands.executeCommand(TerminalCommandId.Kill, invalid), /Invalid terminal instance context/);
		}
		await commands.executeCommand(TerminalCommandId.Kill, context);
		assert.deepEqual(effects.at(-1), ['close', 1]);
		await assert.rejects(commands.executeCommand(TerminalCommandId.Clear, context), /This terminal has been closed/);
		assert.equal(instances.length, 1);
	});

	test('Terminal context action runner forwards the focused target and complete selection', async () => {
		const { InstanceContext, TerminalContextActionRunner } = await import('../../browser/terminalContextMenu.js');
		const contexts = [1, 2].map(instanceId => new InstanceContext({ instanceId } as ITerminalInstance));
		let args: readonly unknown[] = [];
		using runner = new TerminalContextActionRunner();
		await runner.run({ id: 'selected', label: 'Selected', tooltip: '', enabled: true, run: (...values) => { args = values; } }, contexts);
		assert.deepEqual(args, [contexts[0], contexts]);
		const error = new Error('action failed');
		let reported: unknown;
		using listener = runner.onDidRun(event => { reported = event.error; });
		await runner.run({ id: 'failed', label: 'Failed', tooltip: '', enabled: true, run: async () => { throw error; } }, contexts);
		assert.equal(reported, error);
	});

	test('Terminal menu releases cancellation resources and keeps the runner through asynchronous completion', async () => {
		const { openContextMenu, TerminalContextActionRunner } = await import('../../browser/terminalContextMenu.js');
		const { Disposable } = await import('../../../../../base/common/lifecycle.js');
		const { DeferredPromise } = await import('../../../../../base/common/async.js');
		const { ModifierKeyEmitter } = await import('../../../../../base/browser/dom.js');
		const menuDom = new JSDOM('<!doctype html><body></body>');
		try {
			using modifiers = ModifierKeyEmitter.getInstance(menuDom.window as unknown as Window);
			const ready = new DeferredPromise<void>();
			const action: IAction = { id: 'async', label: 'Async', tooltip: '', enabled: true, run: () => ready.p };
			const menu = { ...Disposable.None, onDidChange: Event.None, getActions: () => [['terminal', [action]] as const] };
			let delegate: import('../../../../../base/browser/contextmenu.js').IContextMenuDelegate | undefined;
			const service: IContextMenuService = {
				contextMenuStyle: 'custom',
				onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None, hideContextMenu() { },
				showContextMenu: value => { delegate = value as typeof delegate; },
			};
			const show = () => openContextMenu(menuDom.window as unknown as Window,
				new menuDom.window.MouseEvent('contextmenu'), { instanceId: 1 } as ITerminalInstance, menu, service);
			show();
			const canceled = delegate!.actionRunner;
			assert.ok(canceled instanceof TerminalContextActionRunner);
			delegate!.onHide!(true);
			assert.equal(canceled.isDisposed, true);
			show();
			const runner = delegate!.actionRunner;
			assert.ok(runner instanceof TerminalContextActionRunner);
			let completed = 0;
			using listener = runner.onDidRun(() => { completed++; });
			const operation = runner.run(action, delegate!.getActionsContext!());
			delegate!.onHide!(false);
			assert.equal(runner.isDisposed, false);
			await ready.complete();
			await operation;
			assert.equal(completed, 1);
			assert.equal(runner.isDisposed, true);
		} finally { menuDom.window.close(); }
	});

});
