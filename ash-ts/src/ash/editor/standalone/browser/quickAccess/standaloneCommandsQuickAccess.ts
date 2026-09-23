import { KeyCode } from '../../../../base/common/keyCodes.js';
import { getKeybindingLabel } from '../../../../base/common/keybindingLabels.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import type { ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, EditorExtensionsRegistry, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { EditorContextKeys } from '../../../common/editorContextKeys.js';
import type { IEditorAction } from '../../../common/editorCommon.js';

interface CommandPick extends IQuickPickItem {
	readonly action: IEditorAction;
}

export class GotoLineAction extends EditorAction {
	static readonly ID = 'editor.action.quickCommand';

	constructor() {
		super({
			id: GotoLineAction.ID,
			label: localize2('quickCommand.label', 'Command Palette'),
			precondition: undefined,
			kbOpts: {
				primary: KeyCode.F1,
				weight: KeybindingWeight.EditorContrib,
				kbExpr: EditorContextKeys.editorTextFocus.isEqualTo(true),
			},
		});
	}

	run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const resources = new DisposableStore();
		const picker = resources.add(accessor.get(IQuickInputService).createQuickPick<CommandPick>());
		const keybindings = accessor.get(IKeybindingService);
		const notifications = accessor.get(INotificationService);
		picker.placeholder = localize('quickCommand.placeholder', 'Type the name of a command to run');
		const updateItems = () => {
			picker.items = [...EditorExtensionsRegistry.getEditorActions()].flatMap(registered => {
				const action = editor.getAction(registered.id);
				if (!action?.isSupported() || action.id === GotoLineAction.ID) {
					return [];
				}
				const keybinding = keybindings.lookupKeybinding(action.id);
				return [{
					action,
					label: action.label,
					description: action.id,
					keybinding: keybinding ? getKeybindingLabel(keybinding) : undefined,
				}];
			});
		};
		resources.add(keybindings.onDidUpdateKeybindings(updateItems));
		resources.add(picker.onDidAccept(item => {
			picker.hide();
			void item.action.run().catch(error => notifications.error(String(error)));
		}));
		resources.add(picker.onDidHide(() => resources.dispose()));
		updateItems();
		picker.show();
	}
}

registerEditorAction(GotoLineAction);
