import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import type { DesktopMainEditorPart } from '../../../../browser/parts/desktopEditorPart.js';

/** Controls the file navigation attached to one retained editor group. */
export class DesktopExistingSessionStrategy {
	constructor(@IEditorPart private readonly editor: IEditorPart) { }

	public toggleDetails(): boolean {
		const editor = this.editor as DesktopMainEditorPart;
		if (editor.filesDetailsOpen) { editor.filesDetails.hide(); return false; }
		return true;
	}

	public hideEditor(): void {
		(this.editor as DesktopMainEditorPart).filesDetails.setEditorVisible(false);
	}
}
