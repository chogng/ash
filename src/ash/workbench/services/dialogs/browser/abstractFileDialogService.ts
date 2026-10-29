import type { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import {
	ConfirmResult,
	DialogSeverity,
	type IDialogService,
	type IPickAndOpenOptions,
	type IOpenDialogOptions,
} from '../../../../platform/dialogs/common/dialogs.js';
import type { IHostService } from '../../host/browser/host.js';

/** Owns the save decision shared by browser and desktop file dialogs. */
export abstract class AbstractFileDialogService {
	constructor(
		protected readonly dialogs: () => IDialogService,
		protected readonly hostService: IHostService,
	) {}

	abstract showOpenDialog(options: IOpenDialogOptions): Promise<readonly URI[] | undefined>;

	async pickFolderAndOpen(options: IPickAndOpenOptions = {}): Promise<void> {
		const resources = await this.showOpenDialog({
			canSelectFiles: false,
			canSelectFolders: true,
			defaultUri: options.defaultUri,
		});
		if (!resources?.[0]) return;
		try {
			await this.hostService.openWindow([{ folderUri: resources[0] }], {
				forceNewWindow: options.forceNewWindow,
			});
		} catch (error) {
			if (error instanceof Error && error.message.includes('Directory permissions were not selected')) return;
			if (!(error instanceof Error) || !error.message.includes('Finish the active request')) throw error;
			await this.dialogs().showMessage({
				severity: DialogSeverity.Info,
				message: localize(
					{ bundle: 'ash', key: 'workbench.folderOpenBlocked' },
					'Finish the active request before opening another folder.',
				),
				detail: localize(
					{ bundle: 'ash', key: 'workbench.folderOpenBlockedDetail' },
					'The current Workspace was kept unchanged.',
				),
			});
		}
	}

	async pickWorkspaceAndOpen(options: IPickAndOpenOptions = {}): Promise<void> {
		const resources = await this.showOpenDialog({
			canSelectFiles: true,
			canSelectFolders: false,
			defaultUri: options.defaultUri,
			filters: [
				{
					name: localize('workspace.fileType', 'Ash Workspace'),
					extensions: ['ash-workspace', 'code-workspace'],
				},
			],
		});
		if (resources?.[0])
			await this.hostService.openWindow([{ workspaceUri: resources[0] }], {
				forceNewWindow: options.forceNewWindow,
			});
	}

	async showSaveConfirm(fileNamesOrResources: readonly (string | URI)[], detail?: string): Promise<ConfirmResult> {
		if (fileNamesOrResources.length === 0) return ConfirmResult.DONT_SAVE;
		const names = fileNamesOrResources.map(resource =>
			typeof resource === 'string' ? resource : (resource.fsPath.split(/[\\/]/).at(-1) ?? resource.fsPath),
		);
		const message =
			names.length === 1
				? localize('dialog.saveChangesOne', 'Do you want to save the changes you made to {0}?', names[0])
				: localize(
						'dialog.saveChangesMany',
						'Do you want to save the changes to the following {0} files?',
						names.length,
					);
		const warning = localize('dialog.unsavedChangesWarning', "Your changes will be lost if you don't save them.");
		const description = [names.length > 1 ? names.join('\n') : undefined, warning, detail]
			.filter(Boolean)
			.join('\n');
		const { result } = await this.dialogs().prompt<ConfirmResult>({
			severity: DialogSeverity.Warning,
			title: localize('dialog.saveChangesTitle', 'Save Changes'),
			message,
			detail: description,
			buttons: [
				{
					label: names.length > 1 ? localize('dialog.saveAll', 'Save All') : localize('dialog.save', 'Save'),
					run: () => ConfirmResult.SAVE,
				},
				{ label: localize('dialog.dontSave', "Don't Save"), run: () => ConfirmResult.DONT_SAVE },
			],
			cancelButton: { label: localize('dialog.cancel', 'Cancel'), run: () => ConfirmResult.CANCEL },
		});
		return result ?? ConfirmResult.CANCEL;
	}
}
