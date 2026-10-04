import { type IAction } from '../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { CopyPasteController, pasteAsPreferenceConfig } from '../../../../editor/contrib/dropOrPasteInto/browser/copyPasteController.js';
import { DropIntoEditorController, dropAsPreferenceConfig } from '../../../../editor/contrib/dropOrPasteInto/browser/dropIntoEditorController.js';
import { localize } from '../../../../nls.js';
import { MenuId, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { type IWorkbenchContribution } from '../../../common/contributions.js';
import { IPreferencesService } from '../../../services/preferences/common/preferences.js';

export class DropOrPasteIntoCommands extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'workbench.contrib.dropOrPasteInto';

	constructor() {
		super();
		const actions: readonly [IAction, string][] = [
			[{
				id: 'workbench.action.configurePreferredPasteAction',
				get label() { return localize('dropOrPaste.configurePaste', 'Configure preferred paste action...'); },
				tooltip: '', enabled: true,
				run: (editor: ICodeEditor) => editor.invokeWithinContext(accessor => accessor.get(IPreferencesService).openUserSettings({
					revealSetting: { key: pasteAsPreferenceConfig, edit: true },
				})),
			}, pasteAsPreferenceConfig],
			[{
				id: 'workbench.action.configurePreferredDropAction',
				get label() { return localize('dropOrPaste.configureDrop', 'Configure preferred drop action...'); },
				tooltip: '', enabled: true,
				run: (editor: ICodeEditor) => editor.invokeWithinContext(accessor => accessor.get(IPreferencesService).openUserSettings({
					revealSetting: { key: dropAsPreferenceConfig, edit: true },
				})),
			}, dropAsPreferenceConfig],
		];
		for (const [action, key] of actions) {
			this._register(CommandsRegistry.register(action.id, accessor => accessor.get(IPreferencesService).openUserSettings({
				revealSetting: { key, edit: true },
			})));
			this._register(MenusRegistry.appendMenuItem(MenuId.CommandPalette, {
				command: { id: action.id, get title() { return action.label; } },
			}));
		}
		// Shared actions resolve the service from the invoking editor's window, never the creating window.
		CopyPasteController.setConfigureDefaultAction(actions[0]![0]);
		DropIntoEditorController.setConfigureDefaultAction(actions[1]![0]);
		this._register(toDisposable(() => {
			CopyPasteController.setConfigureDefaultAction(undefined);
			DropIntoEditorController.setConfigureDefaultAction(undefined);
		}));
	}
}
