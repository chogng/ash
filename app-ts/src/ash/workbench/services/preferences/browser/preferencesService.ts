import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IEditorService } from '../../editor/common/editorService.js';
import type { IPreferencesService } from '../common/preferences.js';
import { createPreferencesEditorInput, createUserSettingsEditorInput } from '../common/preferencesEditorInput.js';
import { createKeyboardShortcutsEditorInput } from './keybindingsEditorInput.js';

/** Routes browser Preferences entry points through the Workbench Editor Service. */
export class PreferencesService extends Disposable implements IPreferencesService {
	constructor(private readonly resolveEditorService?: () => IEditorService) {
		super();
	}

	public async openSettings(): Promise<void> {
		if (!this.resolveEditorService) throw new Error('Settings editor is unavailable.');
		await this.resolveEditorService().openEditor(createPreferencesEditorInput(), { pinned: true }, 'modalGroup');
	}

	public async openUserSettingsJson(): Promise<void> {
		if (!this.resolveEditorService) throw new Error('Settings editor is unavailable.');
		await this.resolveEditorService().openEditor(createUserSettingsEditorInput(), { pinned: true });
	}

	public async openKeybindings(): Promise<void> {
		if (!this.resolveEditorService) throw new Error('Keyboard Shortcuts editor is unavailable.');
		await this.resolveEditorService().openEditor(createKeyboardShortcutsEditorInput(), { pinned: true });
	}
}
