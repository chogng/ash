import { localize2 } from '../../../../nls.js';
import { Keybinding, logicalKey } from '../../../../base/common/keybindings.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { FocusTextDiffEditorMode, IDiffEditorCommandsService, type DiffEditorViewMode } from './diffEditorCommandsService.js';
import { IEditorPart } from './editorPart.js';

export const TOGGLE_DIFF_SIDE_BY_SIDE = 'toggle.diff.renderSideBySide';
export const SET_DIFF_VIEW_MODE_INLINE = 'diffEditor.setViewMode.inline';
export const SET_DIFF_VIEW_MODE_SIDE_BY_SIDE = 'diffEditor.setViewMode.sideBySide';
export const SET_DIFF_VIEW_MODE_AUTOMATIC = 'diffEditor.setViewMode.automatic';

export const GOTO_NEXT_CHANGE = 'workbench.action.compareEditor.nextChange';
export const GOTO_PREVIOUS_CHANGE = 'workbench.action.compareEditor.previousChange';
export const DIFF_FOCUS_PRIMARY_SIDE = 'workbench.action.compareEditor.focusPrimarySide';
export const DIFF_FOCUS_SECONDARY_SIDE = 'workbench.action.compareEditor.focusSecondarySide';
export const DIFF_FOCUS_OTHER_SIDE = 'workbench.action.compareEditor.focusOtherSide';
export const DIFF_OPEN_SIDE = 'workbench.action.compareEditor.openSide';
export const TOGGLE_DIFF_IGNORE_TRIM_WHITESPACE = 'toggle.diff.ignoreTrimWhitespace';
export const DIFF_SWAP_SIDES = 'workbench.action.compareEditor.swapSides';

export function registerDiffEditorCommands(): void {
	registerAction2(class ToggleDiffLayoutAction extends Action2 {
		constructor() { super({ id: TOGGLE_DIFF_SIDE_BY_SIDE, title: localize2({ bundle: 'ash.workbench', key: 'command.ToggleDiffLayoutAction' }, 'Toggle Inline Diff View'), f1: true }); }
		override run(accessor: ServicesAccessor): Promise<void> {
			return accessor.get(IDiffEditorCommandsService).toggleRenderSideBySide();
		}
	});

	for (const [id, title, mode] of [
		[SET_DIFF_VIEW_MODE_INLINE, 'Show Inline Diff', 'inline'],
		[SET_DIFF_VIEW_MODE_SIDE_BY_SIDE, 'Show Side by Side Diff', 'sideBySide'],
		[SET_DIFF_VIEW_MODE_AUTOMATIC, 'Use Automatic Diff Layout', 'automatic'],
	] as const satisfies readonly (readonly [string, string, DiffEditorViewMode])[]) {
		registerAction2(class SetDiffLayoutAction extends Action2 {
			constructor() { super({ id, title, f1: true }); }
			override run(accessor: ServicesAccessor): Promise<void> {
				return accessor.get(IDiffEditorCommandsService).setViewMode(mode);
			}
		});
	}
	registerAction2(class NextChangeAction extends Action2 {
		constructor() {
			super({
				id: GOTO_NEXT_CHANGE,
				title: localize2({ bundle: 'ash.workbench', key: 'command.NextChangeAction' }, 'Go to Next Change'),
				f1: true,
				keybinding: { primary: Keybinding.single(logicalKey('f5', { altKey: true })) },
			});
		}

		override run(accessor: ServicesAccessor, context?: unknown): void {
			activateEditorGroup(accessor, context);
			accessor.get(IDiffEditorCommandsService).navigateInDiffEditor(true);
		}
	});

	registerAction2(class PreviousChangeAction extends Action2 {
		constructor() {
			super({
				id: GOTO_PREVIOUS_CHANGE,
				title: localize2({ bundle: 'ash.workbench', key: 'command.PreviousChangeAction' }, 'Go to Previous Change'),
				f1: true,
				keybinding: { primary: Keybinding.single(logicalKey('f5', { altKey: true, shiftKey: true })) },
			});
		}

		override run(accessor: ServicesAccessor, context?: unknown): void {
			activateEditorGroup(accessor, context);
			accessor.get(IDiffEditorCommandsService).navigateInDiffEditor(false);
		}
	});

	for (const [id, title, mode] of [
		[DIFF_FOCUS_PRIMARY_SIDE, 'Focus Modified Side of Diff', FocusTextDiffEditorMode.Modified],
		[DIFF_FOCUS_SECONDARY_SIDE, 'Focus Original Side of Diff', FocusTextDiffEditorMode.Original],
		[DIFF_FOCUS_OTHER_SIDE, 'Focus Other Side of Diff', FocusTextDiffEditorMode.Toggle],
	] as const) {
		registerAction2(class FocusDiffSideAction extends Action2 {
			constructor() { super({ id, title, f1: true }); }
			override run(accessor: ServicesAccessor): void {
				accessor.get(IDiffEditorCommandsService).focusInDiffEditor(mode);
			}
		});
	}

	for (const [id, title, operation] of [
		[DIFF_OPEN_SIDE, localize2({ bundle: 'ash.workbench', key: 'compare.openSide' }, 'Open Active Diff Side'), (service: IDiffEditorCommandsService) => service.openActiveDiffSide()],
		[TOGGLE_DIFF_IGNORE_TRIM_WHITESPACE, 'Toggle Diff Ignore Trim Whitespace', (service: IDiffEditorCommandsService) => service.toggleDiffIgnoreTrimWhitespace()],
		[DIFF_SWAP_SIDES, 'Swap Left and Right Editor Side', (service: IDiffEditorCommandsService) => service.swapDiffSides()],
	] as const) {
		registerAction2(class DiffOperationAction extends Action2 {
			constructor() { super({ id, title, f1: true }); }
			override run(accessor: ServicesAccessor, context?: unknown): Promise<void> {
				activateEditorGroup(accessor, context);
				return operation(accessor.get(IDiffEditorCommandsService));
			}
		});
	}
}

function activateEditorGroup(accessor: ServicesAccessor, context: unknown): void {
	if (typeof context === 'object' && context !== null && 'groupId' in context && typeof context.groupId === 'string') {
		accessor.get(IEditorPart).activateGroup(context.groupId);
	}
}
