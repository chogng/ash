import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../../workbench/common/services.js';
import { showLocalOpenDialog } from '../../../../workbench/services/dialogs/electron-browser/fileDialogService.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../../workbench/services/preferences/common/preferences.js';
import { projectMaterialFilesLocation, projectMaterialFilesRoot } from '../../../../platform/projects/common/projectMaterialFiles.js';

export class ProjectMaterialFilesSettings extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'general';
	readonly itemId = projectMaterialFilesLocation;
	readonly groupId = null;
	readonly title = localize('projects.localFilesTitle', 'Project files');
	readonly description = localize('projects.localFilesDescription', 'Ash saves files from connected projects locally when you open them. Choose where to save the local copies.');
	readonly help = localize('projects.localFilesHelp', 'Project files shows the current save folder. Press Tab to reach Change and press Enter to choose a local folder.');
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private picking = false;

	constructor(
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IWorkbenchEnvironmentService private readonly environment: IWorkbenchEnvironmentService,
		@INativeHostService private readonly host: INativeHostApi,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(projectMaterialFilesLocation)) this.changed.fire();
		}));
	}

	setVisible(): void { }

	get fields(): readonly SettingsSectionField[] {
		const folder = this.folder();
		return [
			{ id: 'folder', kind: 'status', text: folder?.fsPath ?? '' },
			{ id: 'change', kind: 'action', label: localize('projects.localFilesChange', 'Change'), enabled: !this.picking, run: () => this.changeFolder() },
		];
	}

	private folder() {
		const profile = this.environment.userRoamingDataHome;
		return profile && projectMaterialFilesRoot(profile, this.configuration.getValue<string>(projectMaterialFilesLocation));
	}

	private async changeFolder(): Promise<void> {
		this.picking = true;
		this.changed.fire();
		try {
			const [folder] = await showLocalOpenDialog(this.host, {
				title: localize('projects.localFilesPick', 'Choose a folder for project files'),
				defaultUri: this.folder(),
				canSelectFolders: true, canSelectFiles: false,
			}) ?? [];
			if (folder?.scheme === 'file' && !this.isDisposed) {
				await this.configuration.updateValue(projectMaterialFilesLocation, folder.fsPath, ConfigurationTarget.USER_LOCAL);
			}
		} catch {
			if (!this.isDisposed) this.notifications.error(localize('projects.localFilesChangeFailed', 'Could not change where project files are saved.'));
		} finally {
			this.picking = false;
			if (!this.isDisposed) this.changed.fire();
		}
	}
}
