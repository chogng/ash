import type { IEditorPane } from '../../../common/editor.js';
import { SideBySideEditor } from '../../../browser/parts/editor/sideBySideEditor.js';
import { ImagePreviewEditor } from './imagePreviewEditor.js';

/** Status and commands follow the focused side of an image comparison. */
export function getActiveImagePreview(pane: IEditorPane | undefined): ImagePreviewEditor | undefined {
	if (pane instanceof ImagePreviewEditor) return pane;
	if (pane instanceof SideBySideEditor) {
		const secondary = pane.getSecondaryEditorPane();
		const primary = pane.getPrimaryEditorPane();
		if (secondary instanceof ImagePreviewEditor && secondary.hasFocus()) return secondary;
		if (primary instanceof ImagePreviewEditor) return primary;
	}
	return undefined;
}
