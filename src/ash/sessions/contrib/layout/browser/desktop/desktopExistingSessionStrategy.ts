import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import type { DesktopEditorParts } from '../../../../browser/parts/desktopEditorParts.js';

/** Controls the file navigation attached to one retained editor group. */
export class DesktopExistingSessionStrategy {
	constructor(@IEditorPart private readonly editor: IEditorPart) { }

	public toggleDetails(): boolean {
		const editor = this.editor as DesktopEditorParts;
		if (editor.filesDetailsOpen) { editor.filesPart.hideDetails(); return false; }
		return true;
	}

	public hideEditor(): void {
		(this.editor as DesktopEditorParts).filesPart.setEditorVisible(false);
	}
}
