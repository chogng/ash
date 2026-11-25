import { DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Direction } from '../../../../base/browser/ui/grid/grid.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { CancellationError, isCancellationError } from '../../../../base/common/errors.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenusRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, RawContextKey, type IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import type { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import type { IEditorGroupView } from '../../../../workbench/browser/parts/editor/editor.js';
import { AppServerAvailableContext, SessionsCodeEditorContext } from '../../../../workbench/common/contextkeys.js';
import { ITerminalConfigurationService, ITerminalEditorService, ITerminalGroupService, ITerminalService, type ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditor } from '../../../../workbench/contrib/terminal/browser/terminalEditor.js';
import { TerminalEditorCanSplitContext } from '../../../../workbench/contrib/terminal/common/terminalContextKey.js';
import { TERMINAL_CONFIG_SECTION } from '../../../../workbench/contrib/terminal/common/terminal.js';
import { resolveCommandsContext } from '../../../../workbench/browser/parts/editor/editorCommandsContext.js';
import { IEditorGroupsService } from '../../../../workbench/services/editor/common/editorGroupsService.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { SessionsEditorToolContext } from '../../../common/contextkeys.js';
import { Menus, SessionsFlatLayoutContext } from '../../../browser/menus.js';
import type { EditorParts } from '../../../browser/parts/editorParts.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';

const terminalVisibleContext = new RawContextKey<boolean>('sessions.terminalVisible', false);
const codeVisible = SessionsCodeEditorContext.isEqualTo(true);

/** Connects the Agents Window terminal action to its retained editor groups. */
export function registerSessionsTerminalContribution(
	layout: IAgentWorkbenchLayoutService,
	contextKeys: IContextKeyService,
	editor: EditorParts,
): IDisposable & { startRestoringTabs(accessor: ServicesAccessor): Promise<void>; } {
	const disposables = new DisposableStore();
	const terminalVisible = terminalVisibleContext.bindTo(contextKeys);
	const updateVisibility = (): void => {
		terminalVisible.set(layout.isPartVisible('panel') || (layout.isPartVisible('editor') && editor.mainWindowGroups.some(group =>
			editor.isGroupVisible(group.id) && group.activeInput instanceof TerminalEditorInput)));
	};
	updateVisibility();
	disposables.add(layout.onDidChangePartVisibility(updateVisibility));
	disposables.add(layout.onDidLayoutMainContainer(updateVisibility));
	disposables.add(editor.onDidChangeEditors(updateVisibility));
	disposables.add(toDisposable(() => terminalVisible.reset()));

	const isTerminal = (input: unknown): input is TerminalEditorInput => input instanceof TerminalEditorInput;
	const hasShell = (input: TerminalEditorInput, terminalEditors: ITerminalEditorService): boolean =>
		input.panes.get().some(pane => terminalEditors.getInstanceFromResource(pane.resource));
	const terminalGroups = () => editor.groups.filter(group => group.inputs.some(isTerminal));
	const restoring = new WeakMap<TerminalEditorInput, Promise<boolean>>();
	const restoreTab = (
		input: TerminalEditorInput, group: IEditorGroupView, terminals: ITerminalService, terminalEditors: ITerminalEditorService,
		workspace: IWorkspaceContextService, options: {
			readonly retained?: ITerminalInstance;
			readonly willShutdown?: () => boolean;
			readonly reveal?: () => void;
		},
	): Promise<boolean> => {
		const pending = restoring.get(input);
		if (pending) return pending;
		const scope = workspace.getWorkspace();
		const isCurrent = () => !disposables.isDisposed && !options.willShutdown?.() && workspace.getWorkspace() === scope
			&& group.inputs.includes(input) && terminalGroups().includes(group);
		const operation = Promise.resolve().then(async () => {
			if (!isCurrent()) return false;
			if (hasShell(input, terminalEditors)) return true;
			let rollback: (() => void) | undefined;
			const mount = (instance: ITerminalInstance): (() => void) => {
				if (!isCurrent() || !instance.resource || !terminals.instances.includes(instance) || hasShell(input, terminalEditors)) throw new CancellationError();
				instance.target = TerminalLocation.Editor;
				const restoreSavedTab = input.restoreShell(instance, terminals.onDidChangeInstances);
				rollback = () => { if (group.inputs.includes(input)) restoreSavedTab(); };
				options.reveal?.();
				if (editor.activeGroup === group && group.activeInput === input) terminals.setActiveInstance(instance);
				return rollback;
			};
			try {
				if (options.retained) {
					mount(options.retained);
				} else {
					// A saved tab identifies its old process. A fresh shell resolves its
					// profile and directory in the current workspace, then uses this pane's grid.
					const instance = await terminals.createTerminal({
						location: { viewColumn: group.id },
						dirId: scope.folders[0]?.id,
						preserveFocus: true,
						skipContributedProfileCheck: true,
						placeInEditor: mount,
					});
					if (!isCurrent()) {
						rollback?.();
						await terminals.closeTerminal(instance);
						return false;
					}
				}
			} catch (error) {
				if (!isCancellationError(error)) throw error;
				return isCurrent() && hasShell(input, terminalEditors);
			}
			return true;
		}).finally(() => restoring.delete(input));
		restoring.set(input, operation);
		return operation;
	};

	const startRestoringTabs = (accessor: ServicesAccessor): Promise<void> => {
		const terminals = accessor.get(ITerminalService);
		const terminalEditors = accessor.get(ITerminalEditorService);
		const workspace = accessor.get(IWorkspaceContextService);
		const lifecycle = accessor.get(ILifecycleService);
		const log = accessor.get(ILogService);
		const attempted = new WeakSet<TerminalEditorInput>();
		const restoreVisibleTabs = async (): Promise<void> => {
			if (disposables.isDisposed || lifecycle.willShutdown) return;
			const mainVisible = contextKeys.contextMatchesRules(codeVisible) && layout.isPartVisible('editor');
			const localGroups = new Set(mainVisible ? editor.getToolGroups(isTerminal) : []);
			const mainGroups = new Set(editor.mainWindowGroups);
			for (const group of terminalGroups()) {
				if (mainGroups.has(group) && (!localGroups.has(group) || !editor.isGroupVisible(group.id))) continue;
				const input = group.activeInput;
				if (!isTerminal(input) || attempted.has(input) || hasShell(input, terminalEditors)) continue;
				attempted.add(input);
				try {
					if (!await restoreTab(input, group, terminals, terminalEditors, workspace, { willShutdown: () => lifecycle.willShutdown })) {
						attempted.delete(input);
					}
				} catch (error) {
					if (!isCancellationError(error)) log.error('terminal', error);
				}
			}
		};
		const scheduler = disposables.add(new RunOnceScheduler(() => { void restoreVisibleTabs(); }, 0));
		disposables.add(editor.onDidChangeEditors(() => scheduler.schedule()));
		disposables.add(layout.onDidChangePartVisibility(() => scheduler.schedule()));
		disposables.add(workspace.onDidChangeWorkspace(() => scheduler.schedule()));
		return restoreVisibleTabs();
	};

	let terminalToggle: Promise<void> | undefined;
	disposables.add(registerAction2(
		class ToggleTerminalAction extends Action2 {
			constructor() {
				super({
					id: 'ash.sessions.togglePanel',
					title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleTerminal' }, 'Toggle terminal'),
					icon: Lxicon.terminalSession,
					f1: true,
					precondition: codeVisible,
					keybinding: {
						primary: new Keybinding([logicalKey('`', { ctrlKey: true })]),
						when: codeVisible,
					},
					menu: [
						{
							id: Menus.TitleBarRightLayout,
							group: 'navigation',
							order: 3,
							when: codeVisible,
						},
						{
							id: MenuId.MenubarViewMenu,
							group: '2_code_layout',
							order: 3,
							when: codeVisible,
						},
					],
					toggled: terminalVisibleContext.isEqualTo(true),
				});
			}
			override async run(accessor: ServicesAccessor): Promise<void> {
				if (!contextKeys.contextMatchesRules(codeVisible) || !layout.isPartAvailable('editor')) {
					return;
				}
				if (terminalToggle) return terminalToggle;
				if (layout.isPartVisible('panel')) {
					layout.hidePart('panel');
					return;
				}
				const panelAvailable = layout.isPartAvailable('panel');
				const defaultInPanel = panelAvailable && accessor.get(ITerminalConfigurationService).defaultLocation === TerminalLocation.Panel;
				const terminals = accessor.get(ITerminalService);
				const terminalEditors = accessor.get(ITerminalEditorService);
				const panelGroups = panelAvailable ? accessor.get(ITerminalGroupService) : undefined;
				const workspace = accessor.get(IWorkspaceContextService);
				terminalToggle = (async () => {
					const scope = workspace.getWorkspace();
					await terminals.whenConnected;
					if (disposables.isDisposed || !contextKeys.contextMatchesRules(codeVisible) || workspace.getWorkspace() !== scope) {
						return;
					}
					const groups = editor.getToolGroups(isTerminal);
					const active = terminals.activeInstance;
					const matchesScope = (instance: ITerminalInstance): boolean =>
						(scope.folders.length ? scope.folders.some(folder => folder.id === instance.dirId) : !instance.dirId)
						&& instance.shellLaunchConfig?.type !== 'Task';
					const activeInPanel = active?.target === TerminalLocation.Panel && matchesScope(active);
					if (panelGroups && (activeInPanel || (!groups.length && defaultInPanel))) {
						const existing = activeInPanel ? active : terminals.instances.find(instance => instance.target === TerminalLocation.Panel && matchesScope(instance));
						const instance = existing ?? await terminals.createTerminal({ location: TerminalLocation.Panel });
						if (!disposables.isDisposed && layout.isPartAvailable('panel') && workspace.getWorkspace() === scope) {
							terminals.setActiveInstance(instance);
							await panelGroups.showPanel(true);
						}
						return;
					}
					const destination = groups.find(group => group === editor.activeGroup) ?? groups[0];
					const selected = destination?.activeInput;
					const hasLiveTerminal = groups.some(group => group.inputs.some(input => isTerminal(input) && hasShell(input, terminalEditors)));
					if (!hasLiveTerminal || isTerminal(selected) && !hasShell(selected, terminalEditors)) {
						const location = destination ? { viewColumn: destination.id } : undefined;
						// Restored processes may exist before their editor tabs. Match the
						// current folder without taking a process already hosted by a tab.
						const canRestore = (instance: ITerminalInstance): boolean =>
							matchesScope(instance) && (!panelAvailable || instance.target === TerminalLocation.Editor)
							&& !editor.groups.some(group => group.inputs.some(input =>
								input instanceof TerminalEditorInput && instance.resource && input.contains(instance.resource)));
						const retained = active && canRestore(active) ? active : terminals.instances.find(canRestore);
						const saved = isTerminal(selected) ? selected : destination?.inputs.find(isTerminal);
						if (destination && saved) {
							if (!await restoreTab(saved, destination, terminals, terminalEditors, workspace, { retained, reveal: () => editor.setGroupVisible(destination.id, true) })) return;
						} else if (retained) {
							await terminalEditors.openEditor(retained, location);
						} else {
							await terminals.createTerminal({ location: location ?? TerminalLocation.Editor });
						}
						if (destination) {
							editor.setGroupVisible(destination.id, true);
							editor.activateGroup(destination.id);
							editor.focus();
						}
					} else {
						await editor.toggleToolEditors(isTerminal);
					}
				})().finally(() => {
					terminalToggle = undefined;
					if (!disposables.isDisposed) updateVisibility();
				});
				return terminalToggle;
			}
		},
	));
	return Object.assign(disposables, { startRestoringTabs });
}

const terminalCursorBlinkingSetting = `${TERMINAL_CONFIG_SECTION}.cursorBlinking`;
const terminalCursorBlinkingContext = new RawContextKey<boolean>('sessions.terminalCursorBlinking', false);

/** Contributes commands to the Terminal tool's editor title. */
export function registerSessionsTerminalTitleActions(
	editor: IEditorPart,
	contextKeys: IContextKeyService,
	configuration: IConfigurationService,
): IDisposable {
	const disposables = new DisposableStore();
	const terminalInCode = ContextKeyExpr.and(codeVisible, SessionsEditorToolContext.isEqualTo('terminal'));
	const liveShell = TerminalEditorCanSplitContext.isEqualTo(true);
	const appServerAvailable = AppServerAvailableContext.isEqualTo(true);
	const canSplit = ContextKeyExpr.and(liveShell, appServerAvailable);
	const flatLayout = SessionsFlatLayoutContext.isEqualTo(true);
	const modernLayout = ContextKeyExpr.not(SessionsFlatLayoutContext.key);
	const flatTerminal = ContextKeyExpr.and(terminalInCode, flatLayout);
	disposables.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
		submenu: Menus.SessionsTerminalSplit,
		title: localize2('terminal.group.splitMenu', 'Split Terminal'),
		isSplitButton: true,
		when: ContextKeyExpr.and(terminalInCode, liveShell, modernLayout),
		group: 'navigation',
	}));
	for (const [order, [id, direction, title, modernTitle, icon, modernOrder]] of ([
		['ash.sessions.splitTerminalUp', Direction.Up, localize2('sessions.terminal.menu.up', 'Up'), localize2('workbench.splitEditorUp', 'Split Up'), Lxicon.splitVertical, 1],
		['ash.sessions.splitTerminalDown', Direction.Down, localize2('sessions.terminal.menu.down', 'Down'), localize2('workbench.splitEditorDown', 'Split Down'), Lxicon.splitVertical, 0],
		['ash.sessions.splitTerminalLeft', Direction.Left, localize2('sessions.terminal.menu.left', 'Left'), localize2('workbench.splitEditorLeft', 'Split Left'), Lxicon.splitHorizontal, 2],
		['ash.sessions.splitTerminalRight', Direction.Right, localize2('sessions.terminal.menu.right', 'Right'), localize2('workbench.splitEditorRight', 'Split Right'), Lxicon.splitHorizontal, 3],
	] as const).entries()) {
		disposables.add(CommandsRegistry.register(id, async (accessor, ...args) => {
			const { groupedEditors: [source], preserveFocus } = resolveCommandsContext(args, accessor.get(IEditorGroupsService));
			const input = source?.group.activeInput;
			if (input instanceof TerminalEditorInput) await accessor.get(ITerminalEditorService).splitPane(input, preserveFocus, direction);
		}));
		disposables.add(MenusRegistry.appendMenuItems([
			{ id: Menus.SessionsTerminalSplit, item: { command: { id, title, precondition: canSplit }, when: flatLayout, order } },
			{ id: Menus.SessionsTerminalSplit, item: { command: { id, title: modernTitle, icon, precondition: appServerAvailable }, when: modernLayout, order: modernOrder } },
		]));
	}
	disposables.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
		submenu: Menus.SessionsTerminalSplit, title: localize2('workbench.splitMenu', 'Split'), when: flatTerminal, group: '1_terminal', order: 0,
	}));
	disposables.add(CommandsRegistry.register('ash.sessions.clearTerminal', (accessor, ...args) => {
		const { groupedEditors: [source] } = resolveCommandsContext(args, accessor.get(IEditorGroupsService));
		const pane = editor.groups.find(group => group.id === source?.group.id)?.activePane;
		if (pane instanceof TerminalEditor) pane.getControl()?.clearBuffer();
	}));
	disposables.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
		command: { id: 'ash.sessions.clearTerminal', title: localize2('sessions.terminal.menu.clear', 'Clear'), precondition: liveShell },
		when: flatTerminal, group: '1_terminal', order: 1,
	}));
	const cursorBlinking = terminalCursorBlinkingContext.bindTo(contextKeys);
	const updateCursorBlinking = () => cursorBlinking.set(configuration.getValue<boolean>(terminalCursorBlinkingSetting) === true);
	updateCursorBlinking();
	disposables.add(configuration.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(terminalCursorBlinkingSetting)) updateCursorBlinking();
	}));
	disposables.add(toDisposable(() => cursorBlinking.reset()));
	disposables.add(CommandsRegistry.register('ash.sessions.toggleTerminalCursorBlinking', () =>
		configuration.updateValue(terminalCursorBlinkingSetting, !configuration.getValue<boolean>(terminalCursorBlinkingSetting))));
	disposables.add(MenusRegistry.appendMenuItem(Menus.SessionsEditorTitle, {
		command: {
			id: 'ash.sessions.toggleTerminalCursorBlinking',
			title: localize2('sessions.terminal.menu.cursorBlink', 'Cursor Blink'),
			toggled: terminalCursorBlinkingContext.isEqualTo(true),
		},
		when: flatTerminal, group: '1_terminal', order: 2,
	}));
	return disposables;
}
