import { ITerminalService, ITerminalEditorService } from '../../workbench/contrib/terminal/browser/terminal.js';
import { TerminalEditorInput } from '../../workbench/contrib/terminal/browser/terminalEditorInput.js';
import { TerminalLocation } from '../../platform/terminal/common/terminal.js';
import type { DesktopEditorParts } from './parts/desktopEditorParts.js';
import type { ServicesAccessor } from '../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../nls.js';
import { Lxicon } from '../../base/common/lxicons.js';
import { DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import { MenusRegistry, MenuId, Action2, registerAction2 } from '../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../platform/commands/common/commands.js';
import { RawContextKey, type IContextKeyService } from '../../platform/contextkey/common/contextkey.js';
import {
	SideBarVisibleContext,
	PanelVisibleContext,
} from '../../workbench/common/contextkeys.js';
import { Keybinding, logicalKey } from '../../base/common/keybindings.js';
import type { ISessionsService } from '../services/sessions/browser/sessionsService.js';
import type { IAgentWorkbenchLayoutService } from './workbench.js';
import { Menus } from './menus.js';
import { CanGoBackContext, CanGoForwardContext } from '../common/contextkeys.js';

const sessionTools = new RawContextKey<boolean>('sessions.toolsAvailable', false);
const terminalVisibleContext = new RawContextKey<boolean>('sessions.terminalVisible', false);

/** Registers window-local commands and derives their menu state from the layout and session owners. */
export function registerLayoutActions(
	layout: IAgentWorkbenchLayoutService,
	sessions: ISessionsService,
	contextKeys: IContextKeyService,
	editor: DesktopEditorParts,
): IDisposable {
	const disposables = new DisposableStore();
	const sidebarVisible = SideBarVisibleContext.bindTo(contextKeys);
	const backEnabled = CanGoBackContext.bindTo(contextKeys);
	const forwardEnabled = CanGoForwardContext.bindTo(contextKeys);
	const codeAvailable = sessionTools.bindTo(contextKeys);
	const panelVisible = PanelVisibleContext.bindTo(contextKeys);
	const terminalVisible = terminalVisibleContext.bindTo(contextKeys);
	let terminalToggle: Promise<void> | undefined;
	const updateContext = (): void =>
		contextKeys.bufferChangeEvents(() => {
			sidebarVisible.set(layout.isPartVisible('sidebar'));
			backEnabled.set(sessions.canNavigateBack);
			forwardEnabled.set(sessions.canNavigateForward);
			codeAvailable.set(contextKeys.getValue('sessions.desktopCode') === true);
			panelVisible.set(false);
			terminalVisible.set(layout.isPartVisible('editor') && editor.groups.some(group => editor.isGroupVisible(group.id) && group.activeInput instanceof TerminalEditorInput));
		});
	updateContext();
	disposables.add(layout.onDidChangePartVisibility(updateContext));
	disposables.add(editor.onDidChangeEditors(updateContext));
	disposables.add(sessions.onDidChange(updateContext));
	disposables.add(layout.onDidLayoutMainContainer(updateContext));
	disposables.add(
		toDisposable(() =>
			contextKeys.bufferChangeEvents(() => {
				sidebarVisible.reset();
				backEnabled.reset();
				forwardEnabled.reset();
				codeAvailable.reset();
				panelVisible.reset();
				terminalVisible.reset();
			}),
		),
	);
	disposables.add(
		CommandsRegistry.register('ash.sessions.toggleSidebar', () => {
			if (layout.isPartVisible('sidebar')) {
				layout.hidePart('sidebar');
			} else {
				layout.showPart('sidebar');
			}
		}),
	);
	disposables.add(CommandsRegistry.register('ash.sessions.back', () => sessions.navigateBack()));
	disposables.add(CommandsRegistry.register('ash.sessions.forward', () => sessions.navigateForward()));
	disposables.add(
		registerAction2(
			class extends Action2 {
				constructor() {
					super({
						id: 'ash.sessions.togglePanel',
						title: localize2({ bundle: 'ash', key: 'sessions.layout.toggleTerminal' }, 'Toggle terminal'),
						icon: Lxicon.terminalSession,
						f1: true,
						precondition: sessionTools.isEqualTo(true),
						keybinding: {
							primary: new Keybinding([logicalKey('`', { ctrlKey: true })]),
							when: sessionTools.isEqualTo(true),
						},
						menu: [
							{
								id: Menus.TitleBarRightLayout,
								group: 'navigation',
								order: 3,
								when: sessionTools.isEqualTo(true),
							},
							{
								id: MenuId.MenubarViewMenu,
								group: '2_code_layout',
								order: 3,
								when: sessionTools.isEqualTo(true),
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
						await terminals.whenConnected;
						if (disposables.isDisposed) {
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
							const retained = terminals.activeInstance ?? terminals.instances[0];
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
						updateContext();
					});
					return terminalToggle;
				}
			},
		),
	);
	disposables.add(
		MenusRegistry.appendMenuItems([
			{
				id: Menus.TitleBarLeftLayout,
				item: {
					command: {
						id: 'ash.sessions.toggleSidebar',
						title: localize2({ bundle: 'ash', key: 'sessions.navigation.showSidebar' }, 'Show sidebar'),
						icon: Lxicon.layoutSidebarLeftOffSession,
						toggled: {
							condition: SideBarVisibleContext.isEqualTo(true),
							title: localize2({ bundle: 'ash', key: 'sessions.navigation.hideSidebar' }, 'Hide sidebar'),
							tooltip: localize2(
								{ bundle: 'ash', key: 'sessions.navigation.hideSidebar' },
								'Hide sidebar',
							),
							icon: Lxicon.layoutSidebarLeftSession,
						},
					},
					group: 'navigation',
					order: 0,
				},
			},
		]),
	);
	for (const [id, title, icon, precondition, order] of [
		[
			'ash.sessions.back',
			localize2({ bundle: 'ash', key: 'sessions.navigation.back' }, 'Back'),
			Lxicon.chevronLeft,
			CanGoBackContext.isEqualTo(true),
			1,
		],
		[
			'ash.sessions.forward',
			localize2({ bundle: 'ash', key: 'sessions.navigation.forward' }, 'Forward'),
			Lxicon.chevronRight,
			CanGoForwardContext.isEqualTo(true),
			2,
		],
	] as const) {
		const command = { id, title, icon, precondition };
		disposables.add(
			MenusRegistry.appendMenuItems([
				{ id: Menus.TitleBarLeftLayout, item: { command, group: 'navigation', order } },
				{ id: MenuId.MenubarGoMenu, item: { command, group: 'navigation', order } },
			]),
		);
	}

	return disposables;
}
