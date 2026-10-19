import { onActivate } from '../../../registration.js';
import { alert } from '../../../../../../src/ash/base/browser/ui/aria/aria.js';
import { KeyCode, KeyMod } from '../../../../../../src/ash/base/common/keyCodes.js';
import { TabFocus } from '../../../../../../src/ash/editor/browser/config/tabFocus.js';
import * as nls from '../../../../../../src/ash/nls.js';
import { Action2, registerAction2 } from '../../../../../../src/ash/platform/actions/common/actions.js';
import { KeybindingWeight } from '../../../../../../src/ash/platform/keybinding/common/keybindingsRegistry.js';

export class ToggleTabFocusModeAction extends Action2 {
	public static readonly ID = 'editor.action.toggleTabFocusMode';

	constructor() {
		super({
			id: ToggleTabFocusModeAction.ID,
			title: nls.localize2({ key: 'toggle.tabMovesFocus', comment: ['Turn on/off use of tab key for moving focus around VS Code'] }, 'Toggle Tab Key Moves Focus'),
			precondition: undefined,
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.KeyM,
				mac: { primary: KeyMod.WinCtrl | KeyMod.Shift | KeyCode.KeyM },
				weight: KeybindingWeight.EditorContrib
			},
			metadata: {
				description: nls.localize2('tabMovesFocusDescriptions', "Determines whether the tab key moves focus around the workbench or inserts the tab character in the current editor. This is also called tab trapping, tab navigation, or tab focus mode."),
			},
			f1: true
		});
	}

	public run(): void {
		const movesFocus = !TabFocus.getTabFocusMode();
		TabFocus.setTabFocusMode(movesFocus);
		alert(movesFocus
			? nls.localize('toggle.tabMovesFocus.on', "Pressing Tab will now move focus to the next focusable element")
			: nls.localize('toggle.tabMovesFocus.off', "Pressing Tab will now insert the tab character"));
	}
}

onActivate(() => registerAction2(ToggleTabFocusModeAction));
