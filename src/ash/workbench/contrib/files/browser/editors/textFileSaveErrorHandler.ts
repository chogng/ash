import { basename } from '../../../../../base/common/resources.js';
import { type URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { DialogSeverity, IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TextModelConflictError, TextModelSaveCompletionError } from '../../../../services/textmodelResolver/common/textModelResourceService.js';

/** Presents save failures without discarding the editor's unsaved working copy. */
export class TextFileSaveErrorHandler {
	constructor(@IDialogService private readonly dialogs: IDialogService) { }

	async onSaveError(error: unknown, resource: URI | undefined): Promise<void> {
		if (error instanceof TextModelSaveCompletionError) {
			await this.dialogs.showMessage({
				severity: DialogSeverity.Warning,
				title: localize('files.saveBackupFailedTitle', 'File saved; recovery backup incomplete'),
				message: localize('files.saveBackupFailedMessage', "'{0}' was saved, but its recovery backup could not be completed: {1}. Save again to retry. Any changes made after that save remain in the editor.", basename(error.resource), errorMessage(error)),
			});
			return;
		}
		if (error instanceof TextModelConflictError) {
			await this.dialogs.showMessage({
				severity: DialogSeverity.Warning,
				title: localize('files.saveConflictTitle', 'File changed on disk'),
				message: localize(
					'files.saveConflictMessage',
					"Could not save '{0}' because the file changed on disk. Your unsaved changes are still open in the editor.",
					basename(error.resource),
				),
			});
			return;
		}
		await this.dialogs.showMessage({
			severity: DialogSeverity.Error,
			title: localize('files.saveFailedTitle', 'Could not save file'),
			message: localize(
				'files.saveFailedMessage',
				"Could not save '{0}': {1}. Your unsaved changes are still open in the editor.",
				resource ? basename(resource) : localize('files.untitledFile', 'Untitled'),
				errorMessage(error),
			),
		});
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
}
