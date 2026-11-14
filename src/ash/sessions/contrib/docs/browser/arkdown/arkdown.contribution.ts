import { SelectAllCommand, UndoCommand, RedoCommand } from '../../../../../editor/browser/editorExtensions.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { KeybindingWeight, KeybindingsRegistry } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { ArkdownEditor, ArkdownEditorFocused } from './arkdownEditor.js';

// The global keybinding service dispatches in capture phase. Route shared edit
// commands before its Code editor fallback reaches another visible editor.
for (const [command, operation] of [[SelectAllCommand, 'selectAll'], [UndoCommand, 'undo'], [RedoCommand, 'redo']] as const) {
	command.addImplementation(120, 'arkdown-editor', accessor => {
		const control = accessor.get(IEditorPart).activePane?.getControl();
		if (!(control instanceof ArkdownEditor) || !control.hasFocus()) return false;
		control[operation]();
		return true;
	});
}
for (const key of [KeyCode.KeyB, KeyCode.KeyI]) {
	KeybindingsRegistry.registerKeybindingPassThrough({
		keybinding: KeyMod.CtrlCmd | key, when: ArkdownEditorFocused.isEqualTo(true),
		priority: KeybindingWeight.WorkbenchContrib + 10,
	});
}

for (const keybinding of [
	KeyCode.Tab, KeyMod.Shift | KeyCode.Tab,
	...[KeyCode.Digit0, KeyCode.Digit1, KeyCode.Digit2, KeyCode.Digit3, KeyCode.Digit4, KeyCode.Digit5, KeyCode.Digit6].map(key => KeyMod.CtrlCmd | KeyMod.Alt | key),
	...[KeyCode.Digit7, KeyCode.Digit8, KeyCode.Digit9].map(key => KeyMod.CtrlCmd | KeyMod.Shift | key),
]) {
	KeybindingsRegistry.registerKeybindingPassThrough({ keybinding, when: ArkdownEditorFocused.isEqualTo(true), priority: KeybindingWeight.WorkbenchContrib + 10 });
}
