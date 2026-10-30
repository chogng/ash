import { DebugChatContextContribution } from './debugChatIntegration.js';
import { StatusBarColorProvider } from './statusbarColorProvider.js';
import { DebugMemoryFileSystemProvider } from './debugMemory.js';
import { DebugProgressContribution } from './debugProgress.js';
import { LoadedScriptsView } from './loadedScriptsView.js';
import { ReplAccessibilityHelp } from './replAccessibilityHelp.js';
import { ReplAccessibleView } from './replAccessibleView.js';
import { RunAndDebugAccessibilityHelp } from './runAndDebugAccessibilityHelp.js';
import { CallStackEditorContribution } from './callStackEditorContribution.js';
import { DebugEditorContribution } from './debugEditorContribution.js';
import { DebugLifecycle } from '../common/debugLifecycle.js';
import { StartDebugQuickAccessProvider } from './debugQuickAccess.js';
import { DebugConsoleQuickAccess } from './debugConsoleQuickAccess.js';
import { DEBUG_QUICK_ACCESS_PREFIX, DEBUG_CONSOLE_QUICK_ACCESS_PREFIX } from './debugCommands.js';
import { QuickAccessRegistry } from '../../../../platform/quickinput/common/quickAccess.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { registerWorkbenchContribution, WorkbenchPhase } from '../../../common/contributions.js';
import { DebugTitleContribution } from './debugTitle.js';
import { DebugContentProvider } from '../common/debugContentProvider.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ViewContainerLocation, type WorkbenchViewRegistry, WorkbenchViewContainerId, ViewsRegistry } from '../../../common/views.js';
import { BREAKPOINT_EDITOR_CONTRIBUTION_ID, LOADED_SCRIPTS_VIEW_ID, CONTEXT_DISASSEMBLY_VIEW_FOCUS, DEBUG_CONSOLE_VIEW_ID, DISASSEMBLY_VIEW_ID } from '../common/debug.js';
import { VariablesView } from './variablesView.js';
import { WatchExpressionsView } from './watchExpressionsView.js';
import { CallStackView } from './callStackView.js';
import { BreakpointsView } from './breakpointsView.js';
import { WelcomeView } from './welcomeView.js';
import { VARIABLES_VIEW_ID, WATCH_VIEW_ID, CALLSTACK_VIEW_ID, BREAKPOINTS_VIEW_ID, CONTEXT_DEBUG_UX, CONTEXT_BREAKPOINTS_EXIST } from '../common/debug.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { DebugViewPaneContainer } from './debugViewlet.js';
import { Repl } from './repl.js';
import { BreakpointEditorContribution } from './breakpointEditorContribution.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { localize } from '../../../../nls.js';
import { registerEditorPane } from '../../../browser/editor.js';
import { EditorPaneMatch } from '../../../browser/parts/editor/editorPane.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { DisassemblyView } from './disassemblyView.js';
import './debugCommands.js';
import './debugEditorActions.js';
import './debug.service.contribution.js';
import './media/debugViewlet.css';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<boolean>({
	key: 'debug.allowBreakpointsEverywhere', defaultValue: true,
	parse(value: unknown): boolean { if (typeof value !== 'boolean') throw new TypeError(localize('debug.breakpointPolicyInvalid', 'Breakpoint language policy must be a boolean.')); return value; },
	setting: { valueType: 'boolean', get title() { return localize('debug.allowBreakpointsEverywhere', 'Allow breakpoints in every language'); }, get description() { return localize('debug.breakpointPolicyDescription', 'When disabled, enable source breakpoints only for languages and context conditions declared by extensions.'); } },
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<string>({
	key: 'debug.confirmOnExit', defaultValue: 'never',
	parse(value: unknown): string {
		if (value !== 'always' && value !== 'never') throw new TypeError(localize('debug.confirmOnExitInvalid', 'Debug exit confirmation must be always or never.'));
		return value;
	},
	setting: {
		valueType: 'select', options: [
			{ value: 'never', get label() { return localize('debug.confirmNever', 'Never'); } },
			{ value: 'always', get label() { return localize('debug.confirmAlways', 'Always'); } },
		],
		get title() { return localize('debug.confirmOnExitTitle', 'Confirm before closing during debugging'); },
		get description() { return localize('debug.confirmOnExitDescription', 'Ask before window close, reload, or quit stops an active debug session.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<boolean>({
	key: 'accessibility.debugWatchVariableAnnouncements', defaultValue: false,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('debug.watchAnnouncementInvalid', 'Watch value announcements must be a boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('debug.watchAnnouncementTitle', 'Announce Debug Watch value changes'); },
		get description() { return localize('debug.watchAnnouncementDescription', 'Announce changed values from the current paused Watch inspection.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<string>({
	key: 'debug.inlineValues', defaultValue: 'auto',
	parse(value: unknown): string {
		if (value !== 'on' && value !== 'off' && value !== 'auto') throw new TypeError(localize('debug.inlineValuesInvalid', 'Debug inline values must be on, off, or auto.'));
		return value;
	},
	setting: {
		valueType: 'select', options: [
			{ value: 'auto', get label() { return localize('debug.inlineAuto', 'Auto'); } },
			{ value: 'on', get label() { return localize('debug.inlineOn', 'On'); } },
			{ value: 'off', get label() { return localize('debug.inlineOff', 'Off'); } },
		],
		get title() { return localize('debug.inlineValuesTitle', 'Debug inline values'); },
		get description() { return localize('debug.inlineValuesDescription', 'Show inspected variable values beside their occurrences while debugging is paused.'); },
	},
});

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<string>({
	key: 'debug.saveBeforeStart', defaultValue: 'allEditorsInActiveGroup', scope: ConfigurationScope.LANGUAGE_OVERRIDABLE,
	parse(value: unknown): string {
		if (value !== 'allEditorsInActiveGroup' && value !== 'nonUntitledEditorsInActiveGroup' && value !== 'none') {
			throw new TypeError(localize('debug.invalidSaveBeforeStart', 'Invalid debug save-before-start policy.'));
		}
		return value;
	},
	schema: {
		type: 'string', enum: ['allEditorsInActiveGroup', 'nonUntitledEditorsInActiveGroup', 'none'],
		description: localize('debug.saveBeforeStart', 'Controls which editors are saved before starting a debug session.'),
	},
	setting: {
		valueType: 'select',
		options: [
			{ value: 'allEditorsInActiveGroup', get label() { return localize('debug.saveBeforeStartAll', 'Save files and the active untitled editor'); } },
			{ value: 'nonUntitledEditorsInActiveGroup', get label() { return localize('debug.saveBeforeStartFiles', 'Save files'); } },
			{ value: 'none', get label() { return localize('debug.saveBeforeStartNone', 'Do not save'); } },
		],
		get title() { return localize('debug.saveBeforeStartTitle', 'Save before debugging'); },
		get description() { return localize('debug.saveBeforeStart', 'Controls which editors are saved before starting a debug session.'); },
	},
});

registerEditorPane({
	id: DISASSEMBLY_VIEW_ID,
	name: localize('debug.disassembly', 'Disassembly'),
	canOpen: input => input.editorId === DISASSEMBLY_VIEW_ID ? EditorPaneMatch.Default : EditorPaneMatch.None,
	create: options => options.instantiationService!.createInstance(DisassemblyView),
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
	AccessibleViewRegistry.register({
		type, priority: 110, name: `debug.disassembly.${type}`, when: CONTEXT_DISASSEMBLY_VIEW_FOCUS.isEqualTo(true),
		getProvider: accessor => {
			const view = accessor.get(IEditorPartsService).activePane?.getControl?.();
			if (!(view instanceof DisassemblyView)) { return undefined; }
			const focused = view.domNode.ownerDocument.activeElement as HTMLElement | null;
			const provider = new AccessibleContentProvider(AccessibleViewProviderId.Disassembly, { type },
				() => type === AccessibleViewType.View ? view.getAccessibleContent() : localize('debug.disassemblyHelp', 'Disassembly\nUse Up and Down to select an instruction. Press F9 to toggle its instruction breakpoint. Press Enter to open the instruction source. Use Previous instructions and Next instructions to change pages. Enter an address and activate Go to address, or activate Current instruction to return to the paused frame.\nStep Over (<keybinding:workbench.action.debug.stepOver>), Step Into (<keybinding:workbench.action.debug.stepInto>), and Step Out (<keybinding:workbench.action.debug.stepOut>) operate on instructions when this editor is active and the adapter supports instruction stepping.\nOpen Accessible View to read the loaded instructions. Press Escape to close this dialog and return to the editor.'),
				() => { if (focused?.isConnected) { focused.focus(); } else { view.focus(); } }, AccessibilityVerbositySettingId.Disassembly);
			if (type === AccessibleViewType.View) { provider.onDidChangeContent = view.onDidChangeContent; }
			return provider;
		},
	});
}

AccessibleViewRegistry.register(new ReplAccessibilityHelp());
AccessibleViewRegistry.register(new ReplAccessibleView());
AccessibleViewRegistry.register(new RunAndDebugAccessibilityHelp());

QuickAccessRegistry.register({
	prefix: DEBUG_QUICK_ACCESS_PREFIX, ctor: StartDebugQuickAccessProvider,
	get placeholder() { return localize('debug.quickAccessPlaceholder', 'Type a debug configuration name'); },
	get helpLabel() { return localize('debug.quickAccessHelp', 'Debug configurations'); },
});
QuickAccessRegistry.register({
	prefix: DEBUG_CONSOLE_QUICK_ACCESS_PREFIX, ctor: DebugConsoleQuickAccess,
	get placeholder() { return localize('debug.consoleQuickAccessPlaceholder', 'Type a Debug Console name'); },
	get helpLabel() { return localize('debug.consoleQuickAccessHelp', 'Debug consoles'); },
});

export function registerDebugView(registry: WorkbenchViewRegistry = ViewsRegistry): void {
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.Debug, title: 'Run and Debug', localizationKey: { bundle: 'ash.views', key: 'runAndDebug' }, location: ViewContainerLocation.Sidebar, icon: Lxicon.debugAlt, order: 3, ctorDescriptor: new SyncDescriptor(DebugViewPaneContainer) });
	const inspection = CONTEXT_DEBUG_UX.isEqualTo('default');
	registry.registerStaticViews(WorkbenchViewContainerId.Debug, [
		{ id: WelcomeView.ID, title: 'Run', localizationKey: { bundle: 'ash', key: 'debug.run' }, order: 1, when: CONTEXT_DEBUG_UX.isEqualTo('simple'), canToggleVisibility: false, ctorDescriptor: new SyncDescriptor(WelcomeView) },
		{ id: VARIABLES_VIEW_ID, title: 'Variables', localizationKey: { bundle: 'ash', key: 'debug.variables' }, order: 10, when: inspection, canMoveView: true, ctorDescriptor: new SyncDescriptor(VariablesView) },
		{ id: WATCH_VIEW_ID, title: 'Watch', localizationKey: { bundle: 'ash', key: 'debug.watch' }, order: 20, when: inspection, canMoveView: true, ctorDescriptor: new SyncDescriptor(WatchExpressionsView) },
		{ id: CALLSTACK_VIEW_ID, title: 'Call Stack', localizationKey: { bundle: 'ash', key: 'debug.callStack' }, order: 30, when: inspection, canMoveView: true, ctorDescriptor: new SyncDescriptor(CallStackView) },
		{ id: LOADED_SCRIPTS_VIEW_ID, title: 'Loaded Scripts', localizationKey: { bundle: 'ash', key: 'debug.loadedSources' }, order: 50, when: inspection, hideByDefault: true, canMoveView: true, ctorDescriptor: new SyncDescriptor(LoadedScriptsView) },
		{ id: BREAKPOINTS_VIEW_ID, title: 'Breakpoints', localizationKey: { bundle: 'ash', key: 'debug.breakpoints' }, order: 40, when: ContextKeyExpr.or(inspection, CONTEXT_BREAKPOINTS_EXIST.isEqualTo(true)), canMoveView: true, ctorDescriptor: new SyncDescriptor(BreakpointsView) },
	]);
	registry.registerStaticViewContainer({ id: WorkbenchViewContainerId.DebugConsole, title: 'Debug Console', localizationKey: { bundle: 'ash.views', key: 'debugConsole' }, location: ViewContainerLocation.Panel, order: 2.75 });
	registry.registerStaticViews(WorkbenchViewContainerId.DebugConsole, [{ id: DEBUG_CONSOLE_VIEW_ID, title: 'Debug Console', localizationKey: { bundle: 'ash.views', key: 'debugConsole' }, order: 1, canToggleVisibility: false, canMoveView: true, ctorDescriptor: new SyncDescriptor(Repl) }]);
}

registerDebugView();
registerEditorContribution({
	id: 'editor.contrib.debug', instantiation: EditorContributionInstantiation.Eager,
	install: context => {
		if (context.kind === 'text') return context.instantiationService.createInstance(DebugEditorContribution, context.editor, context.model);
	},
});
registerEditorContribution({
	id: 'editor.contrib.callStack',
	instantiation: EditorContributionInstantiation.Eager,
	install: context => {
		if (context.kind === 'text') return context.instantiationService.createInstance(CallStackEditorContribution, context.model);
	},
});
registerEditorContribution({
	id: BREAKPOINT_EDITOR_CONTRIBUTION_ID,
	instantiation: EditorContributionInstantiation.Eager,
	install: context => {
		if (context.kind !== 'text') return;
		return context.instantiationService.createInstance(BreakpointEditorContribution, context.editor, context.model);
	},
});

registerWorkbenchContribution('workbench.contrib.debugTitle', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(DebugTitleContribution));

registerWorkbenchContribution('workbench.contrib.debugLifecycle', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(DebugLifecycle));

registerWorkbenchContribution('workbench.contrib.debugContentProvider', WorkbenchPhase.BlockRestore, accessor =>
	accessor.get(IInstantiationService).createInstance(DebugContentProvider));

registerWorkbenchContribution('workbench.contrib.debugProgress', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(DebugProgressContribution));

registerWorkbenchContribution('workbench.contrib.debugMemory', WorkbenchPhase.BlockRestore, accessor =>
	accessor.get(IInstantiationService).createInstance(DebugMemoryFileSystemProvider));

registerWorkbenchContribution('workbench.contrib.debugStatusbar', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(StatusBarColorProvider));

registerWorkbenchContribution('workbench.contrib.debugChatContext', WorkbenchPhase.AfterRestored, accessor =>
	accessor.get(IInstantiationService).createInstance(DebugChatContextContribution));


Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration<boolean>({
	key: AccessibilityVerbositySettingId.DebugException, defaultValue: true,
	parse(value: unknown): boolean { if (typeof value !== 'boolean') throw new TypeError(localize('debug.exceptionVerbosityInvalid', 'Exception accessibility verbosity must be a boolean.')); return value; },
	setting: { valueType: 'boolean', get title() { return localize('debug.exceptionVerbosityTitle', 'Debug exception accessibility help'); }, get description() { return localize('debug.exceptionVerbosityDescription', 'Announce how to open help when exception details receive focus.'); } },
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) AccessibleViewRegistry.register({
	type, priority: 160, name: `debug.breakpoint.${type}`,
	getProvider: accessor => {
		const focused = document.activeElement as HTMLElement | null;
		const widget = focused?.closest<HTMLElement>('.ash-breakpoint-widget');
		if (!widget) return undefined;
		const editors = accessor.get(IEditorService);
		return new AccessibleContentProvider(AccessibleViewProviderId.RunAndDebug, { type },
			() => type === AccessibleViewType.View
				? [widget.innerText, ...[...widget.querySelectorAll('input, textarea')].map(input => `${input.getAttribute('aria-label')}: ${(input as HTMLInputElement | HTMLTextAreaElement).value}`)].join('\n')
				: localize('debug.breakpointWidgetHelp', 'Breakpoint editor\nChoose Expression condition, Hit count condition, or Log message. Each mode keeps its draft when you switch. Put expressions in braces in a log message. Enter or Save breakpoint applies the draft. Escape or Cancel breakpoint edit closes without changing the breakpoint and returns focus to the editor.\nUse Debug: Add Conditional Breakpoint, Debug: Add Logpoint, or Debug: Edit Breakpoint from the Command Palette to open this editor with the keyboard. Debug: Move Breakpoint moves the current line breakpoint by entering a line number. The glyph margin context menu offers add, edit, enable, disable, remove, and move actions. Dragging a breakpoint to another gutter line preserves its conditions; Escape cancels a drag.'),
			() => { if (focused?.isConnected) focused.focus(); else editors.focusActiveEditor(); }, AccessibilityVerbositySettingId.Debug);
	},
});

for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) AccessibleViewRegistry.register({
	type, priority: 150, name: `debug.exception.${type}`,
	getProvider: accessor => {
		const focused = document.activeElement as HTMLElement | null;
		const widget = focused?.closest<HTMLElement>('.ash-debug-exception');
		if (!widget) return undefined;
		const editors = accessor.get(IEditorService);
		return new AccessibleContentProvider(AccessibleViewProviderId.DebugException, { type },
			() => type === AccessibleViewType.View ? widget.innerText : localize('debug.exceptionHelp', 'Debug exception details\nRead the exception name, message and stack trace. Use Tab to move to the details and Close button. Use Accessible View to read the complete text. Press Escape or activate Close exception details to dismiss the widget and return to the editor. Continuing execution removes the widget.'),
			() => { if (focused?.isConnected && focused.offsetParent !== null) focused.focus(); else editors.focusActiveEditor(); }, AccessibilityVerbositySettingId.DebugException);
	},
});

AccessibleViewRegistry.register({
	type: AccessibleViewType.View, priority: 125, name: 'debug.loadedSources',
	getProvider: accessor => {
		const focused = document.activeElement as HTMLElement | null;
		const pane = focused?.closest<HTMLElement>(`[data-pane-view-id="${LOADED_SCRIPTS_VIEW_ID}"]`);
		if (!pane) return undefined;
		return new AccessibleContentProvider(AccessibleViewProviderId.RunAndDebug, { type: AccessibleViewType.View },
			() => [...pane.querySelectorAll('li')].map(row => row.textContent).join('\n'),
			() => focused?.isConnected && focused.focus(), AccessibilityVerbositySettingId.Debug);
	},
});
