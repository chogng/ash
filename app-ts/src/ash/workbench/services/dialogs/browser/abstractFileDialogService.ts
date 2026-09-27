import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ConfirmResult, DialogSeverity, type IDialogService } from '../../../../platform/dialogs/common/dialogs.js';

/** Owns the save decision shared by browser and desktop file dialogs. */
export abstract class AbstractFileDialogService {
	constructor(protected readonly dialogs: () => IDialogService) {}

	async showSaveConfirm(fileNamesOrResources: readonly (string | URI)[], detail?: string): Promise<ConfirmResult> {
		if (fileNamesOrResources.length === 0) return ConfirmResult.DONT_SAVE;
		const names = fileNamesOrResources.map(resource => typeof resource === 'string' ? resource : resource.fsPath.split(/[\\/]/).at(-1) ?? resource.fsPath);
		const message = names.length === 1
			? localize('dialog.saveChangesOne', 'Do you want to save the changes you made to {0}?', names[0])
			: localize('dialog.saveChangesMany', 'Do you want to save the changes to the following {0} files?', names.length);
		const warning = localize('dialog.unsavedChangesWarning', "Your changes will be lost if you don't save them.");
		const description = [names.length > 1 ? names.join('\n') : undefined, warning, detail].filter(Boolean).join('\n');
		const { result } = await this.dialogs().prompt<ConfirmResult>({
			severity: DialogSeverity.Warning,
			title: localize('dialog.saveChangesTitle', 'Save Changes'),
			message,
			detail: description,
			buttons: [
				{ label: names.length > 1 ? localize('dialog.saveAll', 'Save All') : localize('dialog.save', 'Save'), run: () => ConfirmResult.SAVE },
				{ label: localize('dialog.dontSave', "Don't Save"), run: () => ConfirmResult.DONT_SAVE },
			],
			cancelButton: { label: localize('dialog.cancel', 'Cancel'), run: () => ConfirmResult.CANCEL },
		});
		return result ?? ConfirmResult.CANCEL;
	}
}
