import type { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IFileService } from '../../../../platform/files/common/files.js';
import { localize } from '../../../../nls.js';

/** Uses the host's existing clipboard and Save As paths; no image presentation is involved. */
export async function writeImageOutput(kind: 'copy' | 'save', image: Uint8Array, clipboard: IClipboardService, dialogs: IFileDialogService, files: IFileService): Promise<boolean> {
	if (kind === 'copy') {
		await clipboard.writeImage(image);
		return true;
	}
	const destination = await dialogs.showSaveDialog({ title: localize('imageEditor.saveTitle', 'Save image'), filters: [{ name: 'PNG', extensions: ['png'] }] });
	if (!destination) { return false; }
	await files.writeFileBytes(destination, new Uint8Array(image));
	return true;
}
