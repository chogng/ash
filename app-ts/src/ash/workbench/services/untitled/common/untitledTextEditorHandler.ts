import type { WorkingCopyBackup } from '../../workingCopy/common/workingCopyBackupService.js';
import { IUntitledTextEditorService } from './untitledTextEditorService.js';
import { UntitledTextEditorInput } from './untitledTextEditorInput.js';

/** Maps text backups to the same untitled model used by New File and template commands. */
export class UntitledTextEditorWorkingCopyEditorHandler {
	constructor(@IUntitledTextEditorService private readonly untitled: IUntitledTextEditorService) {}

	public handles(workingCopy: WorkingCopyBackup): boolean {
		return workingCopy.kind === 'text' && this.untitled.isUntitled(workingCopy.resource);
	}

	public createEditor(workingCopy: WorkingCopyBackup): UntitledTextEditorInput {
		if (!this.handles(workingCopy)) {
			throw new TypeError('Untitled text editor handler requires an untitled text backup');
		}
		const model = this.untitled.create({ untitledResource: workingCopy.resource, initialValue: workingCopy.content, languageId: workingCopy.languageId, label: workingCopy.label });
		return new UntitledTextEditorInput(model);
	}
}
