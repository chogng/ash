import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import type { DesktopMainEditorPart } from '../../../../browser/parts/desktopEditorPart.js';

/** Controls the file navigation attached to one retained editor group. */
export class DesktopExistingSessionStrategy {
	constructor(@IEditorPart private readonly editor: IEditorPart) { }

	public toggleDetails(): boolean {
		const editor = this.editor as DesktopMainEditorPart;
		if (editor.filesVisible) { editor.fileNavigation.hide(); return false; }
		return true;
	}

	public hideEditor(): void {
		const navigation = (this.editor as DesktopMainEditorPart).fileNavigation;
		navigation.editorVisible = false;
		navigation.layout();
	}
}
