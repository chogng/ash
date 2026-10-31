import { getWindow } from '../../../../base/browser/dom.js';
import { IEditorPartsService } from '../../../browser/parts/editor/editorParts.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';
import { TerminalChatCommandId } from '../terminalContribChatExports.js';
import { TerminalTabsChatEntry } from './terminalTabsChatEntry.js';
import { TerminalIconPicker } from './terminalIconPicker.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { terminalStrings } from '../common/terminalStrings.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { localize, localize2 } from '../../../../nls.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CONTEXT_ACCESSIBILITY_MODE_ENABLED } from '../../../../platform/accessibility/common/accessibility.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AppServerAvailableContext } from '../../../common/contextkeys.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { TerminalCommandId, TERMINAL_VIEW_ID } from '../common/terminal.js';
import { TerminalContextKeys, TerminalHasActiveInstanceContext } from '../common/terminalContextKey.js';
import { ITerminalProfileService } from '../common/terminal.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalProfileQuickpick } from './terminalProfileQuickpick.js';
import { ITerminalService, ITerminalGroupService, ITerminalEditorService, ITerminalEditingService, type ITerminalInstance } from './terminal.js';
import type { TerminalViewPane } from './terminalView.js';
import { MarshalledId } from '../../../../base/common/marshallingIds.js';
import { InstanceContext } from './terminalContextMenu.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { Schemas } from '../../../../base/common/network.js';
import type { Terminal } from '@xterm/xterm';
import { IWorkspaceTrustManagementService, IWorkspaceTrustRequestService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';


/** Command definitions use the invoking window's services, never a retained View callback. */
export function registerTerminalActions(): void {
	registerAction2(class FocusTerminalHoverAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.FocusHover,
				title: localize2('terminal.focusHover', 'Terminal: Focus Hover'),
				f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: {
					primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyI),
					when: ContextKeyExpr.or(TerminalContextKeys.focus.isEqualTo(true), TerminalContextKeys.tabsFocus.isEqualTo(true)),
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(ITerminalGroupService).focusHover();
		}
	});
	const normalBufferFocused = ContextKeyExpr.and(TerminalContextKeys.focus.isEqualTo(true), TerminalContextKeys.altBufferActive.isEqualTo(false));
	// These operations use the retained screen, including exited and read-only terminals.
	for (const action of [
		{
			id: TerminalCommandId.ScrollUpLine,
			title: localize2('terminal.scrollUpLine', 'Terminal: Scroll Up (Line)'),
			operation: (raw: Terminal) => raw.scrollLines(-1),
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.PageUp, linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.UpArrow } },
		},
		{
			id: TerminalCommandId.ScrollDownLine,
			title: localize2('terminal.scrollDownLine', 'Terminal: Scroll Down (Line)'),
			operation: (raw: Terminal) => raw.scrollLines(1),
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.PageDown, linux: { primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.DownArrow } },
		},
		{
			id: TerminalCommandId.ScrollUpPage,
			title: localize2('terminal.scrollUpPage', 'Terminal: Scroll Up (Page)'),
			operation: (raw: Terminal) => raw.scrollPages(-1),
			keybinding: { primary: KeyMod.Shift | KeyCode.PageUp, mac: { primary: KeyCode.PageUp } },
		},
		{
			id: TerminalCommandId.ScrollDownPage,
			title: localize2('terminal.scrollDownPage', 'Terminal: Scroll Down (Page)'),
			operation: (raw: Terminal) => raw.scrollPages(1),
			keybinding: { primary: KeyMod.Shift | KeyCode.PageDown, mac: { primary: KeyCode.PageDown } },
		},
		{
			id: TerminalCommandId.ScrollToTop,
			title: localize2('terminal.scrollToTop', 'Terminal: Scroll to Top'),
			operation: (raw: Terminal) => raw.scrollToTop(),
			keybinding: { primary: KeyMod.CtrlCmd | KeyCode.Home, linux: { primary: KeyMod.Shift | KeyCode.Home } },
		},
		{
			id: TerminalCommandId.ScrollToBottom,
			title: localize2('terminal.scrollToBottom', 'Terminal: Scroll to Bottom'),
			operation: (raw: Terminal) => raw.scrollToBottom(),
			keybinding: { primary: KeyMod.CtrlCmd | KeyCode.End, linux: { primary: KeyMod.Shift | KeyCode.End } },
		},
	]) {
		registerAction2(class ScrollTerminalAction extends Action2 {
			constructor() {
				super({
					id: action.id,
					title: action.title,
					f1: true,
					precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
					keybinding: { ...action.keybinding, when: normalBufferFocused, weight: KeybindingWeight.WorkbenchContrib },
				});
			}
			override run(accessor: ServicesAccessor): void {
				const screen = accessor.get(ITerminalService).activeInstance?.xterm;
				if (screen && !screen.isDisposed && screen.raw.buffer.active.type === 'normal') action.operation(screen.raw);
			}
		});
	}
	registerAction2(class SelectAllTerminalAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.SelectAll, title: localize2('terminal.selectAll', 'Terminal: Select All'), f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: { primary: 0, mac: { primary: KeyMod.CtrlCmd | KeyCode.KeyA }, when: TerminalContextKeys.focus.isEqualTo(true), weight: KeybindingWeight.WorkbenchContrib },
			});
		}
		override run(accessor: ServicesAccessor): void {
			const screen = accessor.get(ITerminalService).activeInstance?.xterm;
			if (screen && !screen.isDisposed) screen.raw.selectAll();
		}
	});
	registerAction2(class ClearTerminalSelectionAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.ClearSelection, title: localize2('terminal.clearSelection', 'Terminal: Clear Selection'), f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: {
					primary: KeyCode.Escape, weight: KeybindingWeight.WorkbenchContrib,
					when: ContextKeyExpr.and(TerminalContextKeys.focus.isEqualTo(true), TerminalContextKeys.textSelectedInFocused.isEqualTo(true), TerminalContextKeys.findVisible.isEqualTo(false)),
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			const screen = accessor.get(ITerminalService).activeInstance?.xterm;
			if (screen && !screen.isDisposed && screen.raw.hasSelection()) screen.raw.clearSelection();
		}
	});
	registerAction2(class RunActiveFileTerminalAction extends Action2 {
		constructor() {
			super({ id: TerminalCommandId.RunActiveFile, title: localize2('terminal.runActiveFile', 'Terminal: Run Active File in Active Terminal'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true) });
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const resource = accessor.get(ICodeEditorService).getActiveCodeEditor()?.getModel()?.uri;
			if (!resource) return;
			if (resource.scheme !== Schemas.file && resource.scheme !== Schemas.ashRemote) throw new Error(localize('terminal.runActiveFile.diskRequired', 'Open a file on disk before running it in the terminal.'));
			const terminals = accessor.get(ITerminalService);
			let instance = terminals.activeInstance;
			if (!instance || instance.isReadOnly || instance.state === 'exited') instance = await terminals.createTerminal();
			if (!instance || !terminals.instances.includes(instance) || terminals.activeInstance !== instance || instance.isReadOnly || instance.state !== 'running') return;
			await instance.sendPath(resource, true);
			if (!terminals.instances.includes(instance) || terminals.activeInstance !== instance) return;
			if (instance.target === TerminalLocation.Editor) await accessor.get(ITerminalEditorService).openEditor(instance, { preserveFocus: true });
			else await accessor.get(ITerminalGroupService).showPanel(false);
		}
	});
	registerAction2(class RunSelectedTextTerminalAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.RunSelectedText,
				title: localize2('terminal.runSelectedText', 'Terminal: Run Selected Text in Active Terminal'),
				f1: true,
				precondition: AppServerAvailableContext.isEqualTo(true),
			});
		}

		override async run(accessor: ServicesAccessor): Promise<void> {
			const editor = accessor.get(ICodeEditorService).getActiveCodeEditor();
			const model = editor?.getModel();
			const selection = editor?.getSelection();
			if (!model || !selection) return;
			// Capture the request before folder/profile selection can yield to another edit.
			const text = selection.isEmpty()
				? model.getLineContent(selection.selectionStartLineNumber).trim()
				: model.getValueInRange(selection, EndOfLinePreference.LF);
			if (!text) return;

			const terminals = accessor.get(ITerminalService);
			const groups = accessor.get(ITerminalGroupService);
			const terminalEditors = accessor.get(ITerminalEditorService);
			let instance = terminals.activeInstance;
			if (!instance || instance.isReadOnly || instance.state === 'exited') instance = await terminals.createTerminal();
			if (!instance || !terminals.instances.includes(instance) || terminals.activeInstance !== instance
				|| instance.isReadOnly || instance.state !== 'running') return;
			await instance.sendText(text, true, true);
			if (!terminals.instances.includes(instance) || terminals.activeInstance !== instance) return;
			if (instance.target === TerminalLocation.Editor) {
				await terminalEditors.openEditor(instance, { preserveFocus: true });
			} else {
				await groups.showPanel(false);
			}
		}
	});
	registerAction2(class AttachTerminalToChatAction extends Action2 {
		constructor() {
			super({
				id: TerminalChatCommandId.AttachToChat,
				title: localize2('terminal.chat.attach', 'Terminal: Attach to Chat'),
				f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				menu: { id: MenuId.TerminalInstanceContext, group: '2_chat' },
			});
		}
		override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const instance = resolveInstance(accessor, context);
			if (!instance) return;
			using entry = accessor.get(IInstantiationService).createInstance(TerminalTabsChatEntry);
			await entry.attach(instance);
		}
	});

	registerAction2(class RenameTerminalAction extends Action2 {
		constructor() { super({ id: TerminalCommandId.Rename, title: localize2('terminal.rename.command', 'Terminal: Rename'), f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true) }); }
		override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const instance = resolveInstance(accessor, context);
			const editing = accessor.get(ITerminalEditingService);
			if (instance && editing.getEditingTerminal() !== instance) await editing.rename(instance);
		}
	});
	registerAction2(class ChangeTerminalIconAction extends Action2 {
		constructor() { super({ id: TerminalCommandId.ChangeIcon, title: localize2('terminal.icon.command', 'Terminal: Change Icon'), f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true) }); }
		override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const instance = resolveInstance(accessor, context);
			if (!instance?.changeIcon) return;
			using lifetime = new DisposableStore();
			const picker = lifetime.add(accessor.get(IInstantiationService).createInstance(TerminalIconPicker));
			const terminals = accessor.get(ITerminalService);
			lifetime.add(terminals.onDidDisposeInstance(closed => { if (closed === instance) picker.dispose(); }));
			const icon = await picker.pickIcons();
			if (icon !== undefined && terminals.instances.includes(instance)) await instance.changeIcon(icon ?? undefined);
		}
	});
	registerAction2(class MoveTerminalToEditorAction extends Action2 {
		constructor() { super({ id: TerminalCommandId.MoveToEditor, title: terminalStrings.moveToEditor, f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true) }); }
		override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const instance = resolveInstance(accessor, context);
			if (instance) await accessor.get(ITerminalEditorService).openEditor(instance);
		}
	});
	registerAction2(class MoveTerminalToPanelAction extends Action2 {
		constructor() { super({ id: TerminalCommandId.MoveToTerminalPanel, title: terminalStrings.moveToTerminalPanel, f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true) }); }
		override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const instance = resolveInstance(accessor, context);
			if (!instance) return;
			await accessor.get(ITerminalEditorService).detachInstance(instance);
			if (!accessor.get(ITerminalService).instances.includes(instance)) return;
			instance.target = TerminalLocation.Panel;
			accessor.get(ITerminalService).setActiveInstance(instance);
			await accessor.get(ITerminalGroupService).showPanel(true);
		}
	});
	registerAction2(class FocusTerminalAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.Focus,
				title: localize2({ bundle: 'ash', key: 'workbench.focusTerminal' }, 'Focus Terminal'),
				f1: true, precondition: AppServerAvailableContext.isEqualTo(true),
				menu: { id: MenuId.MenubarTerminalMenu, group: '1_terminal', order: 1 },
			});
		}

		override run(accessor: ServicesAccessor, instanceId?: unknown): Promise<boolean> {
			if (instanceId !== undefined) {
				const terminals = accessor.get(ITerminalService);
				const instance = resolveInstance(accessor, instanceId)!;
				terminals.setActiveInstance(instance);
			}
			return accessor.get(IViewsService).focusView(TERMINAL_VIEW_ID);
		}
	});

	registerAction2(class NewTerminalAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.New, title: localize2('terminal.title.new', 'New Terminal'), f1: true,
				precondition: AppServerAvailableContext.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Backquote,
					mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.Backquote },
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const instantiation = accessor.get(IInstantiationService);
			const workspaceContext = accessor.get(IWorkspaceContextService);
			const workspace = workspaceContext.getWorkspace();
			const trust = accessor.get(IWorkspaceTrustManagementService);
			const requests = accessor.get(IWorkspaceTrustRequestService);
			await trust.workspaceTrustInitialized;
			const permissions = await Promise.all(workspace.folders.map(async folder => (await trust.getUriTrustInfo(folder.uri)).permissions));
			if (workspaceContext.getWorkspace() !== workspace) return;
			if (permissions.some(allowed => !allowed?.includes('executeCommands'))) {
				const accepted = await requests.requestWorkspaceTrust({
					message: localize('workspaceTrust.terminalRequest', 'Creating a terminal can run code from this workspace. Do you trust its authors?'),
				});
				if (accepted !== true) return;
			}
			if (workspaceContext.getWorkspace() !== workspace) return;
			// Construct process owners only after authorization and its connection recovery finish.
			const { terminals, groups, quickInput } = instantiation.invokeFunction(accessor => ({
				terminals: accessor.get(ITerminalService), groups: accessor.get(ITerminalGroupService), quickInput: accessor.get(IQuickInputService),
			}));
			const instance = await terminals.createTerminal();
			// Creation may itself ask for a workspace folder. That completed prompt
			// belongs to this action; a picker still open now owns the user's focus.
			let focus = !quickInput.currentQuickInput;
			using focusRequest = quickInput.onShow(() => { focus = false; });
			terminals.setActiveInstance(instance);
			// Reveal without deferring focus inside openView: a newer picker may
			// open while process creation or view restoration is still pending.
			await groups.showPanel(false);
			if (focus && !quickInput.currentQuickInput && terminals.activeInstance === instance) instance.xterm?.focus();
		}
	});
	registerAction2(class NewTerminalWindowAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.NewInNewWindow, title: localize2('terminal.newInNewWindow', 'New Terminal Window'), f1: true,
				precondition: AppServerAvailableContext.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | KeyCode.Backquote,
					mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyMod.Alt | KeyCode.Backquote },
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			const terminals = accessor.get(ITerminalService);
			const parts = accessor.get(IEditorPartsService);
			// Acquire the popup during the user gesture, then resolve its terminal.
			const part = await parts.createAuxiliaryEditorPart();
			let instance: ITerminalInstance | undefined;
			try {
				instance = await terminals.createTerminal({ location: { viewColumn: part.activeGroup.id } });
				getWindow(part.domNode).focus();
				part.activeGroup.focus();
			} catch (error) {
				try {
					if (instance && terminals.instances.includes(instance)) await terminals.closeTerminal(instance);
				} finally {
					await parts.closeAuxiliaryEditorPart(part);
				}
				throw error;
			}
		}
	});
	registerAction2(class ConfigureTerminalSettingsAction extends Action2 {
		constructor() {
			super({ id: TerminalCommandId.ConfigureTerminalSettings, title: localize2('terminal.configureSettings', 'Configure Terminal Settings'), f1: true });
		}
		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IPreferencesService).openSettings({ jsonEditor: false, query: '@id:terminal.integrated.*' });
		}
	});
	registerAction2(class SplitTerminalAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.Split, title: localize2('terminal.group.split', 'Terminal: Split Terminal'), f1: true,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Digit5,
					mac: { primary: KeyMod.CtrlCmd | KeyCode.Backslash },
					when: TerminalContextKeys.focus.isEqualTo(true), weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		override async run(accessor: ServicesAccessor, context?: unknown, profileId?: unknown): Promise<void> {
			const parent = resolveInstance(accessor, context);
			if (!parent || parent.state !== 'running' || parent.isReadOnly || parent.shellLaunchConfig?.customPtyImplementation) return;
			const terminals = accessor.get(ITerminalService);
			const profiles = accessor.get(ITerminalProfileService);
			const config = profileId === undefined ? parent.shellLaunchConfig : resolveProfile(profiles, profileId, parent.dirId);
			const terminalEditors = accessor.get(ITerminalEditorService);
			const created = parent.target === TerminalLocation.Editor
				? await terminalEditors.splitInstance(parent, config)
				: await terminals.createTerminal({ config, location: { parentTerminal: parent } });
			created?.xterm?.focus();
		}
	});
	for (const [id, title, direction, key] of [
		[TerminalCommandId.FocusNextPane, localize2('terminal.group.next', 'Terminal: Focus Next Pane'), 'next', KeyCode.RightArrow],
		[TerminalCommandId.FocusPreviousPane, localize2('terminal.group.previous', 'Terminal: Focus Previous Pane'), 'previous', KeyCode.LeftArrow],
	] as const) {
		registerAction2(class FocusTerminalPaneAction extends Action2 {
			constructor() {
				super({
					id, title, f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
					keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | key, when: TerminalContextKeys.focus.isEqualTo(true), weight: KeybindingWeight.WorkbenchContrib },
				});
			}
			override run(accessor: ServicesAccessor): void {
				const group = accessor.get(ITerminalGroupService).activeGroup;
				if (direction === 'next') group?.focusNextPane();
				else group?.focusPreviousPane();
			}
		});
	}
	registerAction2(class UnsplitTerminalAction extends Action2 {
		constructor() {
			super({ id: TerminalCommandId.Unsplit, title: localize2('terminal.group.unsplit', 'Terminal: Unsplit Terminal'), f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true) });
		}
		override run(accessor: ServicesAccessor, context?: unknown): void {
			const instance = resolveInstance(accessor, context);
			if (!instance) return;
			accessor.get(ITerminalGroupService).unsplitInstance(instance);
			instance.xterm?.focus();
		}
	});
	registerAction2(class JoinTerminalAction extends Action2 {
		constructor() {
			super({ id: TerminalCommandId.Join, title: localize2('terminal.group.join', 'Terminal: Join or Reorder Terminals...'), f1: true, precondition: TerminalHasActiveInstanceContext.isEqualTo(true) });
		}
		override async run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
			const source = resolveInstance(accessor, context);
			const terminals = accessor.get(ITerminalService);
			const groups = accessor.get(ITerminalGroupService);
			const quickInput = accessor.get(IQuickInputService);
			if (!source || !groups.getGroupForInstance(source)) return;
			using lifetime = new DisposableStore();
			let retired = false;
			const items = groups.groups.flatMap(group => group.terminalInstances).filter(instance => instance !== source).flatMap(target => (['before', 'after'] as const).map(side => ({
				label: side === 'before' ? localize('terminal.group.moveBefore', 'Before {0}', target.title) : localize('terminal.group.moveAfter', 'After {0}', target.title),
				target, side,
			})));
			const picker = lifetime.add(quickInput.createQuickPick<typeof items[number]>());
			picker.items = items;
			picker.placeholder = localize('terminal.group.joinPlaceholder', 'Choose a terminal and pane position');
			picker.ariaLabel = picker.placeholder;
			const retire = (): void => { retired = true; picker.hide(); };
			lifetime.add(source.onDidChangeState(retire));
			lifetime.add(terminals.onDidChangeActiveInstance(retire));
			lifetime.add(terminals.onDidDisposeInstance(instance => { if (instance === source) retire(); }));
			let selected: typeof items[number] | undefined;
			const item = await new Promise<typeof selected>(resolve => {
				lifetime.add(picker.onDidAccept(() => {
					selected = picker.selectedItems[0];
					picker.hide();
				}));
				lifetime.add(picker.onDidHide(() => resolve(selected)));
				lifetime.add(toDisposable(() => resolve(undefined)));
				picker.show();
			});
			if (!item || retired || !terminals.instances.includes(source) || !terminals.instances.includes(item.target)) return;
			groups.moveInstance(source, item.target, item.side);
			source.xterm?.focus();
		}
	});
	registerAction2(class NewWithProfileAction extends Action2 {
		constructor() {
			super({ id: TerminalCommandId.NewWithProfile, title: localize2('terminal.profile.newCommand', 'Terminal: Create New Terminal With Profile'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true) });
		}
		override async run(accessor: ServicesAccessor, profileId?: unknown): Promise<void> {
			const terminals = accessor.get(ITerminalService);
			const profiles = accessor.get(ITerminalProfileService);
			const groups = accessor.get(ITerminalGroupService);
			if (profileId === undefined) {
				using picker = accessor.get(IInstantiationService).createInstance(TerminalProfileQuickpick);
				profileId = await picker.showAndGetResult('createInstance');
				if (profileId === undefined) return;
			}
			const config = resolveProfile(profiles, profileId);
			const instance = await terminals.createTerminal({ config });
			terminals.setActiveInstance(instance);
			await groups.showPanel(true);
		}
	});
	registerAction2(class SelectDefaultProfileAction extends Action2 {
		constructor() {
			super({ id: TerminalCommandId.SelectDefaultProfile, title: localize2('terminal.profile.defaultCommand', 'Terminal: Select Default Profile'), f1: true, precondition: AppServerAvailableContext.isEqualTo(true) });
		}
		override async run(accessor: ServicesAccessor): Promise<void> {
			using picker = accessor.get(IInstantiationService).createInstance(TerminalProfileQuickpick);
			await picker.showAndGetResult('setDefault');
		}
	});
	registerAction2(class ScrollToPreviousCommandAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.ScrollToPreviousCommand,
				title: terminalStrings.scrollToPreviousCommand,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyCode.UpArrow,
					when: ContextKeyExpr.and(TerminalContextKeys.focus.isEqualTo(true), CONTEXT_ACCESSIBILITY_MODE_ENABLED.isEqualTo(false)),
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			scrollToCommand(accessor, 'previous');
		}
	});
	registerAction2(class ScrollToNextCommandAction extends Action2 {
		constructor() {
			super({
				id: TerminalCommandId.ScrollToNextCommand,
				title: terminalStrings.scrollToNextCommand,
				precondition: TerminalHasActiveInstanceContext.isEqualTo(true),
				keybinding: {
					primary: KeyMod.CtrlCmd | KeyCode.DownArrow,
					when: ContextKeyExpr.and(TerminalContextKeys.focus.isEqualTo(true), CONTEXT_ACCESSIBILITY_MODE_ENABLED.isEqualTo(false)),
					weight: KeybindingWeight.WorkbenchContrib,
				},
			});
		}
		override run(accessor: ServicesAccessor): void {
			scrollToCommand(accessor, 'next');
		}
	});
	CommandsRegistry.register(TerminalCommandId.Relaunch, async (accessor, context) => {
		if (context === undefined && accessor.get(ITerminalService).activeInstance?.target !== TerminalLocation.Editor) return terminalView(accessor).relaunchActive();
		const instance = resolveInstance(accessor, context);
		if (!instance || instance.state === 'reconnecting') return;
		await accessor.get(ITerminalService).relaunchTerminal(instance, instance.xterm?.dimensions() ?? { cols: 80, rows: 24 });
	});
	CommandsRegistry.register(TerminalCommandId.Kill, (accessor, context) => {
		const instance = resolveInstance(accessor, context);
		if (!instance) return;
		if (context === undefined && instance.target !== TerminalLocation.Editor) return terminalView(accessor).killActive();
		return accessor.get(ITerminalService).safeDisposeTerminal(instance);
	});
	CommandsRegistry.register(TerminalCommandId.Clear, (accessor, context) => {
		if (context === undefined && accessor.get(ITerminalService).activeInstance?.target !== TerminalLocation.Editor) return terminalView(accessor).clearActive();
		resolveInstance(accessor, context)?.clearBuffer();
	});
}

function scrollToCommand(accessor: ServicesAccessor, direction: 'previous' | 'next'): void {
	const instance = accessor.get(ITerminalService).activeInstance;
	const screen = instance?.xterm;
	if (!screen) return;
	if (direction === 'previous') screen.scrollToPreviousCommand();
	else screen.scrollToNextCommand();
	screen.focus();
}

/** Validate command contexts once, then resolve identity through the invoking window's owner. */
function resolveInstance(accessor: ServicesAccessor, context: unknown): ITerminalInstance | undefined {
	const terminals = accessor.get(ITerminalService);
	if (context === undefined) return terminals.activeInstance;
	let instance: ITerminalInstance | undefined;
	if (typeof context === 'string') {
		instance = terminals.instances.find(instance => instance.id === context);
	} else {
		const id = context instanceof InstanceContext ? context.instanceId : context && typeof context === 'object'
			&& '$mid' in context && context.$mid === MarshalledId.TerminalContext && 'instanceId' in context ? context.instanceId : undefined;
		if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) {
			throw new TypeError(localize('terminal.context.invalid', 'Invalid terminal instance context'));
		}
		instance = terminals.instances.find(instance => instance.instanceId === id);
	}
	if (!instance) throw new Error(localize('terminal.context.closed', 'This terminal has been closed'));
	return instance;
}

function terminalView(accessor: ServicesAccessor): TerminalViewPane {
	const view = accessor.get(IViewsService).getViewWithId<TerminalViewPane>(TERMINAL_VIEW_ID);
	if (!view) { throw new Error(localize('terminal.view.unavailable', 'The terminal view is unavailable')); }
	return view;
}

function resolveProfile(profiles: ITerminalProfileService, profileId: unknown, dirId?: string) {
	const profile = profiles.getAvailableProfiles(dirId).find(profile => profile.profileId === profileId)
		?? profiles.contributedProfiles.find(profile => `extension:${profile.extensionIdentifier}/${profile.id}` === profileId);
	if (!profile) throw new TypeError(localize('terminal.profile.unknown', 'Unknown terminal profile: {0}', String(profileId)));
	return profile;
}
