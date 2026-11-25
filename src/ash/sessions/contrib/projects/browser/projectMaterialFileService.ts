import { CancellationError } from '../../../../base/common/errors.js';
import { extname } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { projectMaterialFilesLocation, projectMaterialFilesRoot, projectMaterialFilesScheme } from '../../../../platform/projects/common/projectMaterialFiles.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorPart } from '../../../../workbench/browser/parts/editor/editorPart.js';
import type { IEditorIdentifier } from '../../../../workbench/common/editor.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { IHistoryService } from '../../../../workbench/services/history/common/history.js';
import { retireDocumentConversation } from '../../chat/browser/documentConversation.js';
import { IPdfWorkingCopyService } from '../../pdf/browser/pdfWorkingCopyService.js';
import { ProjectMaterialFiles } from './projectMaterialFiles.js';

export const IProjectMaterialFileService = createServiceIdentifier<IProjectMaterialFileService>('projectMaterialFileService');
export interface IProjectMaterialFileService {
	copies(key: string): ProjectMaterialFiles | undefined;
	removeCopy(copies: ProjectMaterialFiles, file: { readonly id: string; readonly name: string; }, replacement?: URI): Promise<void>;
	prepareTransfer(resource: URI): Promise<void>;
}

export class ProjectMaterialFileService implements IProjectMaterialFileService {
	constructor(
		@IFileService private readonly files: IFileService,
		@IWorkbenchEnvironmentService private readonly environment: IWorkbenchEnvironmentService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IEditorPart private readonly editors: IEditorPart,
		@IPdfWorkingCopyService private readonly pdfWorkingCopies: IPdfWorkingCopyService,
		@IHistoryService private readonly history: IHistoryService,
		@IStorageService private readonly storage: IStorageService,
	) { }

	public copies(key: string): ProjectMaterialFiles | undefined {
		const profile = this.environment.userRoamingDataHome;
		if (!profile || !this.files.hasProvider(URI.from({ scheme: projectMaterialFilesScheme }))) return undefined;
		return new ProjectMaterialFiles(this.files, projectMaterialFilesRoot(profile, this.configuration.getValue<string>(projectMaterialFilesLocation)), key);
	}

	public removeCopy(copies: ProjectMaterialFiles, file: { readonly id: string; readonly name: string; }, replacement?: URI): Promise<void> {
		return copies.remove(file, async resource => {
			const editors = this.editorsFor(resource);
			if (editors.length) await this.editors.closeAllEditors({ skipConfirmation: true, reason: 'reset' }, editors);
			this.history.remove(resource);
			if (extname(resource.path).toLowerCase() === '.pdf') {
				await this.pdfWorkingCopies.discardBackup(resource);
				retireDocumentConversation(this.storage, resource, replacement);
			}
		});
	}

	public async prepareTransfer(resource: URI): Promise<void> {
		const editors = this.editorsFor(resource);
		if (editors.length && !await this.editors.closeAllEditors({ reason: 'reset' }, editors)) throw new CancellationError();
		if (!editors.length && extname(resource.path).toLowerCase() === '.pdf' && await this.pdfWorkingCopies.backups.resolve(resource)) {
			throw new Error(localize('projects.fileTransferPendingDraft', 'Open the PDF and resolve its unsaved changes before moving or renaming it.'));
		}
	}

	private editorsFor(resource: URI): IEditorIdentifier[] {
		const matches = (input: { readonly resource: URI; }) => input.resource.toString() === resource.toString();
		const editors = this.editors.groups.flatMap(group => group.inputs.filter(matches).map(editor => ({ editor, groupId: group.id })));
		const modal = this.editors.isModalEditorVisible ? this.editors.activeInput : undefined;
		if (modal && matches(modal)) editors.push({ editor: modal, groupId: -1 });
		return editors;
	}
}
