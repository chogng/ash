import { localize } from '../../../../../nls.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import type { ExplorerItem } from '../../common/explorerModel.js';

interface ExplorerDecoration {
	readonly letter: string;
	readonly tooltip: string;
}

/** Describes file kinds that need an additional marker in the Explorer tree. */
export function provideDecorations(item: ExplorerItem): ExplorerDecoration | undefined {
	switch (item.kind) {
		case FileKind.SymbolicLink:
			return {
				letter: '↷',
				tooltip: localize('workbench.explorerSymbolicLink', 'Symbolic Link'),
			};
		case FileKind.Other:
			return {
				letter: '?',
				tooltip: localize('workbench.explorerUnknownFileType', 'Unknown File Type'),
			};
		default:
			return undefined;
	}
}
