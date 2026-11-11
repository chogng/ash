import { DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, RawContextKey, type IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import type { IEditorGroupView } from '../../../../workbench/browser/parts/editor/editor.js';
import { ITerminalEditorService, ITerminalService, type ITerminalInstance } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { ILifecycleService } from '../../../../workbench/services/lifecycle/common/lifecycle.js';
import { Menus } from '../../../browser/menus.js';
import type { DesktopEditorParts } from '../../../browser/parts/desktopEditorParts.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';

const terminalVisibleContext = new RawContextKey<boolean>('sessions.terminalVisible', false);
const codeVisible = ContextKeyExpr.equals('sessions.desktopCode', true);

/** Connects the Agents Window terminal action to its retained editor groups. */
export function registerSessionsTerminalContribution(
	layout: IAgentWorkbenchLayoutService,
	contextKeys: IContextKeyService,
	editor: DesktopEditorParts,
): IDisposable & { startRestoringTabs(accessor: ServicesAccessor): Promise<void>; } {
	const disposables = new DisposableStore();
	const terminalVisible = terminalVisibleContext.bindTo(contextKeys);
	const updateVisibility = (): void => {
		terminalVisible.set(layout.isPartVisible('editor') && editor.groups.some(group =>
			editor.isGroupVisible(group.id) && group.activeInput instanceof TerminalEditorInput));
	};
	updateVisibility();
	disposables.add(layout.onDidChangePartVisibility(updateVisibility));
	disposables.add(layout.onDidLayoutMainContainer(updateVisibility));
	disposables.add(editor.onDidChangeEditors(updateVisibility));
	disposables.add(toDisposable(() => terminalVisible.reset()));

	const isTerminal = (input: unknown): input is TerminalEditorInput => input instanceof TerminalEditorInput;
	const hasShell = (input: TerminalEditorInput, terminalEditors: ITerminalEditorService): boolean =>
		input.panes.get().some(pane => terminalEditors.getInstanceFromResource(pane.resource));
	const restoring = new WeakMap<TerminalEditorInput, Promise<boolean>>();
	const restoreTab = (
		input: TerminalEditorInput, group: IEditorGroupView, terminals: ITerminalService, terminalEditors: ITerminalEditorService,
		workspace: IWorkspaceContextService, retained?: ITerminalInstance, willShutdown?: () => boolean,
	): Promise<boolean> => {
		const pending = restoring.get(input);
		if (pending) return pending;
		const scope = workspace.getWorkspace();
		const isCurrent = () => !disposables.isDisposed && !willShutdown?.() && workspace.getWorkspace() === scope
			&& group.inputs.includes(input) && editor.getToolGroups(isTerminal).includes(group);
		const operation = Promise.resolve().then(async () => {
			if (!isCurrent()) return false;
			if (hasShell(input, terminalEditors)) return true;
			// A saved tab identifies its old process, but has no executable or CWD
			// to replay. Resolve a fresh default shell in the current workspace.
			const instance = retained ?? await terminals.createTerminal({
				location: { viewColumn: group.id },
				dirId: scope.folders[0]?.id,
				deferEditorOpen: true,
				preserveFocus: true,
				skipContributedProfileCheck: true,
			});
			if (!isCurrent() || !instance.resource || !terminals.instances.includes(instance) || hasShell(input, terminalEditors)) {
				if (!retained && terminals.instances.includes(instance)) await terminals.closeTerminal(instance);
				return isCurrent() && hasShell(input, terminalEditors);
			}
			instance.target = TerminalLocation.Editor;
			input.restoreShell(instance, terminals.onDidChangeInstances);
			if (editor.activeGroup === group && group.activeInput === input) terminals.setActiveInstance(instance);
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
			if (disposables.isDisposed || lifecycle.willShutdown || !contextKeys.contextMatchesRules(codeVisible) || !layout.isPartVisible('editor')) return;
			for (const group of editor.getToolGroups(isTerminal)) {
				const input = group.activeInput;
				if (!isTerminal(input) || !editor.isGroupVisible(group.id) || attempted.has(input) || hasShell(input, terminalEditors)) continue;
				attempted.add(input);
				try {
					if (!await restoreTab(input, group, terminals, terminalEditors, workspace, undefined, () => lifecycle.willShutdown)) attempted.delete(input);
				} catch (error) {
					if (!isCancellationError(error)) log.error('terminal', error);
				}
			}
		};
		const scheduler = disposables.add(new RunOnceScheduler(() => { void restoreVisibleTabs(); }, 0));
		disposables.add(editor.onDidChangeEditors(() => scheduler.schedule()));
		disposables.add(layout.onDidChangePartVisibility(() => scheduler.schedule()));
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
				if (!layout.isPartAvailable('editor')) {
					return;
				}
				terminalToggle ??= (async () => {
					const terminals = accessor.get(ITerminalService);
					const workspace = accessor.get(IWorkspaceContextService);
					const scope = workspace.getWorkspace();
					await terminals.whenConnected;
					if (disposables.isDisposed || workspace.getWorkspace() !== scope) {
						return;
					}
					const terminalEditors = accessor.get(ITerminalEditorService);
					const groups = editor.getToolGroups(isTerminal);
					const destination = groups.find(group => group === editor.activeGroup) ?? groups[0];
					const selected = destination?.activeInput;
					const hasLiveTerminal = groups.some(group => group.inputs.some(input => isTerminal(input) && hasShell(input, terminalEditors)));
					if (!hasLiveTerminal || isTerminal(selected) && !hasShell(selected, terminalEditors)) {
						const location = destination ? { viewColumn: destination.id } : undefined;
						// Restored processes may exist before their editor tabs. Match the
						// current folder without taking a process already hosted by a tab.
						const matchesScope = (instance: NonNullable<typeof terminals.activeInstance>): boolean =>
							(scope.folders.length ? scope.folders.some(folder => folder.id === instance.dirId) : !instance.dirId)
							&& instance.shellLaunchConfig?.type !== 'Task'
							&& !editor.groups.some(group => group.inputs.some(input =>
								input instanceof TerminalEditorInput && instance.resource && input.contains(instance.resource)));
						const active = terminals.activeInstance;
						const retained = active && matchesScope(active) ? active : terminals.instances.find(matchesScope);
						const saved = isTerminal(selected) ? selected : destination?.inputs.find(isTerminal);
						if (destination && saved) {
							if (!await restoreTab(saved, destination, terminals, terminalEditors, workspace, retained)) return;
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
