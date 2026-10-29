import { readWorkspaceSymbolSource, getWorkspaceSymbolRevision } from '../common/search.js';
import type { LanguageWorkspaceSymbol } from '../../../../editor/common/languages.js';
import { type IFileService } from '../../../../platform/files/common/files.js';
import { type IEditorService } from '../../../services/editor/common/editorService.js';
import { type IWorkingCopyService } from '../../../services/workingCopy/common/workingCopyService.js';

/** Opens a Workspace Symbol only after a local index result still matches current file content. */
export async function acceptWorkspaceSymbol(
	symbol: LanguageWorkspaceSymbol,
	files: IFileService,
	workingCopies: IWorkingCopyService,
	editor: IEditorService,
	quickPick: { hide(): void },
	refresh: () => void,
): Promise<void> {
	const revision = getWorkspaceSymbolRevision(symbol);
	if (revision) {
		try {
			if ((await readWorkspaceSymbolSource(symbol, files, workingCopies)) === undefined) {
				refresh();
				return;
			}
		} catch (error) {
			console.error('Could not verify workspace symbol', error);
			refresh();
			return;
		}
	}
	quickPick.hide();
	await editor
		.openEditor({ resource: symbol.resource }, { selection: symbol.range })
		.catch(error => console.error('Could not open workspace symbol', error));
}
