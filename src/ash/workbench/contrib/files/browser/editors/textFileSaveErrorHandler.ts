import { FileSystemProviderErrorCode, toFileSystemProviderErrorCode } from '../../../../../platform/files/common/files.js';
import { IElevatedFileService } from '../../../../services/files/common/elevatedFileService.js';
import { basename } from '../../../../../base/common/resources.js';
import { type URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { DialogSeverity, IDialogService, type IActionPromptButton } from '../../../../../platform/dialogs/common/dialogs.js';
import { TextModelConflictError, TextModelSaveCompletionError } from '../../../../services/textmodelResolver/common/textModelResourceService.js';

import type { ISaveOptions } from '../../../../common/editor.js';

/** Presents save failures without discarding the editor's unsaved working copy. */
export class TextFileSaveErrorHandler {
	constructor(@IDialogService private readonly dialogs: IDialogService, @IElevatedFileService private readonly elevatedFiles: IElevatedFileService) { }

	public async onSaveError(error: unknown, resource: URI | undefined, retry?: (options: ISaveOptions) => Promise<void>, recovery?: { saveAs(): Promise<boolean>; revert(): Promise<void>; }, triedToUnlock = false): Promise<boolean> {
		const code = error instanceof Error ? toFileSystemProviderErrorCode(error) : FileSystemProviderErrorCode.Unknown;
		const locked = code === FileSystemProviderErrorCode.FileWriteLocked;
		const elevated = !!resource && !!retry && this.elevatedFiles.isSupported(resource) && (code === FileSystemProviderErrorCode.NoPermissions || (locked && triedToUnlock));
		if (resource && retry && (elevated || (locked && !triedToUnlock))) {
			const options: ISaveOptions = elevated ? { writeElevated: true, skipSaveParticipants: true } : { unlock: true, skipSaveParticipants: true };
			const result = await this.dialogs.prompt<boolean>({
				title: elevated ? localize('files.saveElevatedTitle', 'Save with administrator permission') : localize('files.saveLockedTitle', 'Save a read-only file'),
				message: elevated ? localize('files.saveElevatedMessage', "The operating system prevented saving '{0}'. Request administrator permission to retry?", basename(resource)) : localize('files.saveLockedMessage', "'{0}' is read-only. Overwrite to make it writable and save?", basename(resource)),
				detail: elevated ? localize('files.saveElevatedDetail', 'The system will ask for authorization. Your unsaved changes remain open if you cancel or the save fails.') : localize('files.saveLockedDetail', 'Overwrite uses your current permissions. Your changes remain open if you cancel or the save fails.'),
				buttons: [
					{
						label: elevated ? localize('files.saveElevatedRetry', 'Retry with administrator permission') : localize('files.saveOverwrite', 'Overwrite'), run: async () => {
							try { await retry(options); return true; }
							catch (retryError) { return this.onSaveError(retryError, resource, options.unlock ? retry : undefined, recovery, !!options.unlock); }
						}
					},
					...this.recoveryButtons(recovery),
				],
			});
			return result.result === true;
		}
		if (error instanceof TextModelSaveCompletionError) {
			await this.dialogs.showMessage({
				severity: DialogSeverity.Warning,
				title: localize('files.saveBackupFailedTitle', 'File saved; recovery backup incomplete'),
				message: localize('files.saveBackupFailedMessage', "'{0}' was saved, but its recovery backup could not be completed: {1}. Save again to retry. Any changes made after that save remain in the editor.", basename(error.resource), errorMessage(error)),
			});
			return false;
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
			return false;
		}
		const message = {
			severity: DialogSeverity.Error,
			title: localize('files.saveFailedTitle', 'Could not save file'),
			message: localize(
				'files.saveFailedMessage',
				"Could not save '{0}': {1}. Your unsaved changes are still open in the editor.",
				resource ? basename(resource) : localize('files.untitledFile', 'Untitled'),
				errorMessage(error),
			),
		};
		if (recovery) {
			return (await this.dialogs.prompt({ ...message, buttons: this.recoveryButtons(recovery) })).result === true;
		}
		await this.dialogs.showMessage(message);
		return false;
	}

	private recoveryButtons(recovery: { saveAs(): Promise<boolean>; revert(): Promise<void>; } | undefined): IActionPromptButton<boolean>[] {
		if (!recovery) { return []; }
		return [
			{ label: localize('files.saveRecoveryAs', 'Save As...'), run: () => recovery.saveAs() },
			{ label: localize('files.saveRecoveryRevert', 'Revert'), run: async () => { await recovery.revert(); return true; } },
		];
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error && error.message.trim() ? error.message.trim() : String(error);
}
