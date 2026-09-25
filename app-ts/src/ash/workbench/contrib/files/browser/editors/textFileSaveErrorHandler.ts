import { type URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { DialogSeverity, type IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { TextModelConflictError } from '../../../../services/textmodelResolver/common/textModelResourceService.js';

/** Presents save failures without discarding the editor's unsaved working copy. */
export class TextFileSaveErrorHandler {
	constructor(private readonly dialogs: IDialogService) {}

	async onSaveError(error: unknown, resource: URI | undefined): Promise<void> {
		if (error instanceof TextModelConflictError) {
			await this.dialogs.showMessage({
				severity: DialogSeverity.Warning,
				title: localize('files.saveConflictTitle', 'File changed on disk'),
				message: localize(
					'files.saveConflictMessage',
					"Could not save '{0}' because the file changed on disk. Your unsaved changes are still open in the editor.",
					fileName(error.resource),
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
				resource ? fileName(resource) : localize('files.untitledFile', 'Untitled'),
				errorMessage(error),
			),
		});
	}
}

function fileName(resource: URI): string {
	return decodeURIComponent(resource.path.split('/').pop() || resource.path);
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
}
