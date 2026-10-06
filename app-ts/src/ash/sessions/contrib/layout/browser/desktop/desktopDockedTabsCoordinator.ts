import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import { IEditorService, type EditorInput } from '../../../../../workbench/services/editor/common/editorService.js';
import { EditorInputCapabilities } from '../../../../../workbench/common/editor.js';
import { EmptyFileEditorInput } from '../../../editor/browser/emptyFileEditorInput.js';
import { SessionChangesEditorInput } from '../../../changes/browser/sessionChangesEditorInput.js';
import type { SessionsViewSelection } from '../../../../services/sessions/browser/sessionsService.js';

/** Only settled session/reveal transitions seed tabs; ordinary closes never recreate defaults. */
export class DesktopDockedTabsCoordinator {
	constructor(@IEditorPart private readonly editor: IEditorPart, @IEditorService private readonly editors: IEditorService) { }

	public async reconcile(selection: SessionsViewSelection, detailsOnly: boolean): Promise<void> {
		const changes = new SessionChangesEditorInput(selection);
		for (const group of this.editor.groups) {
			for (const input of group.inputs.filter(input => input.resource.scheme === 'ash-session-changes' && input.resource.toString() !== changes.resource.toString())) {
				await group.replaceEditor(input, changes);
			}
		}
		const inputs = this.editor.groups.flatMap(group => group.inputs).filter(input => input.resource.scheme !== 'ash-creator' && input.resource.scheme !== 'ash-library');
		if (inputs.length === 0 || detailsOnly) {
			if (!inputs.some(input => input.resource.scheme === 'ash-sessions-files')) {
				const files = new EmptyFileEditorInput();
				files.capabilities = detailsOnly ? EditorInputCapabilities.CannotClose : EditorInputCapabilities.None;
				await this.editors.openEditor(files, { pinned: true, preserveFocus: true, inactive: true });
			}
			if (!inputs.some(input => input.resource.scheme === 'ash-session-changes')) {
				changes.capabilities = detailsOnly ? EditorInputCapabilities.CannotClose : EditorInputCapabilities.None;
				await this.editors.openEditor(changes, { pinned: true, preserveFocus: true, inactive: true });
			}
		}
		for (const input of this.editor.groups.flatMap(group => group.inputs)) {
			if (input instanceof EmptyFileEditorInput || input instanceof SessionChangesEditorInput) {
				input.capabilities = detailsOnly ? EditorInputCapabilities.CannotClose : EditorInputCapabilities.None;
				await this.editors.openEditor(input, { pinned: true, preserveFocus: true, inactive: true });
			}
		}
	}

	public async removeFilesLandingTab(): Promise<void> {
		for (const group of this.editor.groups) {
			for (const input of group.inputs.filter(input => input.resource.scheme === 'ash-sessions-files')) {
				await group.closeEditor(input, { skipConfirmation: true, reason: 'reset' });
			}
		}
	}

	public async openFiles(): Promise<void> {
		await this.editors.openEditor(new EmptyFileEditorInput(), { pinned: true });
	}

	public async openChanges(selection: SessionsViewSelection): Promise<void> {
		await this.editors.openEditor(new SessionChangesEditorInput(selection), { pinned: true });
	}

	public isManaged(input: EditorInput): boolean {
		return input.resource.scheme === 'ash-sessions-files' || input.resource.scheme === 'ash-session-changes';
	}
}
