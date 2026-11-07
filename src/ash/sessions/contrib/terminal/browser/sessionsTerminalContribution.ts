import { DisposableStore, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, RawContextKey, type IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalEditorService, ITerminalService } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { Menus } from '../../../browser/menus.js';
import type { DesktopEditorParts } from '../../../browser/parts/desktopEditorParts.js';
import type { IAgentWorkbenchLayoutService } from '../../../browser/workbench.js';
import { IsNewSessionContext, NewSessionHasUsableWorkspaceContext } from '../../../common/contextkeys.js';

const terminalVisibleContext = new RawContextKey<boolean>('sessions.terminalVisible', false);
const codeVisible = ContextKeyExpr.equals('sessions.desktopCode', true);

/** Connects the Agents Window terminal action to its retained editor groups. */
export function registerSessionsTerminalContribution(
	layout: IAgentWorkbenchLayoutService,
	contextKeys: IContextKeyService,
	editor: DesktopEditorParts,
): IDisposable {
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
							when: ContextKeyExpr.and(codeVisible, ContextKeyExpr.or(
								IsNewSessionContext.isEqualTo(false),
								NewSessionHasUsableWorkspaceContext.isEqualTo(true),
							)),
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
					const groups = editor.getToolGroups(input => input instanceof TerminalEditorInput);
					const unavailable = groups.flatMap(group => group.inputs
						.filter(input => input instanceof TerminalEditorInput && !terminalEditors.getInstanceFromResource(input.resource))
						.map(input => ({ group, input })));
					const hasLiveTerminal = groups.some(group => group.inputs.some(input =>
						input instanceof TerminalEditorInput && terminalEditors.getInstanceFromResource(input.resource)));
					if (!hasLiveTerminal) {
						// A restored tab can outlive its PTY checkpoint. Replace it in its
						// retained group only after an explicit request successfully opens a shell.
						const destination = groups.find(group => group === editor.activeGroup) ?? groups[0];
						const location = destination ? { viewColumn: destination.id } : undefined;
						// Restored processes may exist before their editor tabs. Match the
						// current folder and leave any other working set's tabs alone.
						const matchesScope = (instance: NonNullable<typeof terminals.activeInstance>): boolean =>
							(scope.folders.length ? scope.folders.some(folder => folder.id === instance.dirId) : !instance.dirId)
							&& instance.shellLaunchConfig?.type !== 'Task'
							&& !editor.groups.some(group => !groups.includes(group) && group.inputs.some(input =>
								input instanceof TerminalEditorInput && terminalEditors.getInstanceFromResource(input.resource) === instance));
						const active = terminals.activeInstance;
						const retained = active && matchesScope(active) ? active : terminals.instances.find(matchesScope);
						if (retained) {
							await terminalEditors.openEditor(retained, location);
						} else {
							await terminals.createTerminal({ location: location ?? TerminalLocation.Editor });
						}
						if (destination) {
							editor.setGroupVisible(destination.id, true);
							editor.activateGroup(destination.id);
							editor.focus();
						}
					}
					for (const { group, input } of unavailable) {
						await group.closeEditor(input, { skipConfirmation: true });
					}
					if (hasLiveTerminal) {
						await editor.toggleToolEditors(input => input instanceof TerminalEditorInput);
					}
				})().finally(() => {
					terminalToggle = undefined;
					if (!disposables.isDisposed) updateVisibility();
				});
				return terminalToggle;
			}
		},
	));
	return disposables;
}
