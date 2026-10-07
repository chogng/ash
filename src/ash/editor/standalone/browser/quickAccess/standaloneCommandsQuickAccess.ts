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
import { getStandaloneHelpPicks } from './standaloneHelpQuickAccess.js';

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

	run(accessor: ServicesAccessor, editor: ICodeEditor, args?: unknown): void {
		const resources = new DisposableStore();
		const picker = resources.add(accessor.get(IQuickInputService).createQuickPick<CommandPick>());
		picker.filterValue = value => value.startsWith('>') ? value.slice(1) : value;
		const keybindings = accessor.get(IKeybindingService);
		const notifications = accessor.get(INotificationService);
		const updateMode = () => {
			if (picker.value.startsWith('@')) {
				const symbolAction = editor.getAction('editor.action.quickOutline');
				if (symbolAction?.isSupported()) {
					const query = picker.value.slice(1);
					picker.hide();
					void symbolAction.run(query).catch(error => notifications.error(String(error)));
					return;
				}
			}
			const isHelp = picker.value.startsWith('?');
			picker.ariaLabel = isHelp ? localize('quickHelp.dialog', 'Quick Access Help') : localize('quickCommand.label', 'Command Palette');
			picker.placeholder = isHelp
				? localize('quickHelp.placeholder', 'Choose a command or type to filter')
				: localize('quickCommand.placeholder', 'Type > for commands, ? for help, or @ for symbols');
			picker.items = isHelp ? getStandaloneHelpPicks(editor, keybindings) : [...EditorExtensionsRegistry.getEditorActions()].flatMap(registered => {
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
		resources.add(keybindings.onDidUpdateKeybindings(updateMode));
		resources.add(picker.onDidChangeValue(updateMode));
		resources.add(picker.onDidAccept(item => {
			picker.hide();
			void item.action.run().catch(error => notifications.error(String(error)));
		}));
		resources.add(picker.onDidHide(() => resources.dispose()));
		updateMode();
		picker.show();
		if (typeof args === 'string') {
			picker.value = args;
		}
	}
}

registerEditorAction(GotoLineAction);
