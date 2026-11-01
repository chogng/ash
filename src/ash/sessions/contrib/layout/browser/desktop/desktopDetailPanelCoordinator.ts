import { IEditorPart } from '../../../../../workbench/browser/parts/editor/editorPart.js';
import type { DesktopMainEditorPart } from '../../../../browser/parts/desktopEditorPart.js';

/** Tool selection is explicit; opening or closing a document never hides Files. */
export class DesktopDetailPanelCoordinator {
	constructor(@IEditorPart private readonly editor: IEditorPart) { }

	public get supportsActiveEditor(): boolean {
		return true;
	}

	public async update(reveal: boolean): Promise<void> {
		if (reveal && !(this.editor as DesktopMainEditorPart).filesVisible) await this.openFiles();
	}

	public async openFiles(): Promise<void> {
		await (this.editor as DesktopMainEditorPart).openFiles();
	}

}
