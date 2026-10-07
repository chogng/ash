import { isWindows } from '../../../../base/common/platform.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/labelService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { localize2 } from '../../../../nls.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { SEARCH_VIEW_ID, SearchCommandIds, SearchContext } from '../common/constants.js';
import type { SearchView } from './searchView.js';
import type { RenderableMatch, SearchFileMatch, SearchFolderMatch, SearchMatch } from './searchTreeModel/searchResult.js';

const lineDelimiter = isWindows ? '\r\n' : '\n';
const fileNames = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

registerAction2(class CopyMatchCommandAction extends Action2 {
	constructor() {
		super({
			id: SearchCommandIds.CopyMatchCommandId,
			title: localize2('search.copy', 'Copy'),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				when: ContextKeyExpr.and(SearchContext.SearchViewFocusedKey.isEqualTo(true), SearchContext.FileMatchOrMatchFocusKey.isEqualTo(true)),
				primary: KeyMod.CtrlCmd | KeyCode.KeyC,
			},
		});
	}

	public override async run(accessor: ServicesAccessor, match?: RenderableMatch): Promise<void> {
		// Explicit row arguments remain valid inputs even after dismissal; only implicit selection needs an active view.
		match ??= accessor.get(IViewsService).getActiveViewWithId<SearchView>(SEARCH_VIEW_ID)?.getControl().selection[0];
		if (!match) { return; }
		let text: string;
		if (match.kind === 'match') {
			text = formatMatch(match, 0);
		} else {
			const files = match.kind === 'file' ? [match] : folderFiles(match);
			text = formatFiles(files, accessor.get(ILabelService));
		}
		if (text) { await accessor.get(IClipboardService).writeText(text); }
	}
});

registerAction2(class CopyAllCommandAction extends Action2 {
	constructor() {
		super({ id: SearchCommandIds.CopyAllCommandId, title: localize2('search.copyAll', 'Copy All') });
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const view = accessor.get(IViewsService).getActiveViewWithId<SearchView>(SEARCH_VIEW_ID);
		if (!view) { return; }
		const labels = accessor.get(ILabelService);
		// Read the retained model when invoked; collapsed rows and earlier snapshots are not the source.
		const text = formatFiles(view.searchResult.files.filter(file => file.matches.length), labels);
		await accessor.get(IClipboardService).writeText(text);
	}
});

function folderFiles(folder: SearchFolderMatch): SearchFileMatch[] {
	return [...folder.children.values()].flatMap(child => child.kind === 'file' ? [child] : folderFiles(child));
}

function formatFiles(files: readonly SearchFileMatch[], labels: ILabelService): string {
	return [...files].sort(compareResultFiles).map(file => {
		const rows = [...file.matches].sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range)).map(match => formatMatch(match));
		return labels.getUriLabel(file.resource, { noPrefix: true }) + lineDelimiter + rows.join(lineDelimiter);
	}).join(lineDelimiter + lineDelimiter);
}

function compareResultFiles(a: SearchFileMatch, b: SearchFileMatch): number {
	// Copy All keeps the default hierarchy even when the view is flat or sorted by match count.
	if (a.folder.index !== b.folder.index) { return a.folder.index - b.folder.index; }
	const left = a.path.split('/');
	const right = b.path.split('/');
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const leftFolder = index < left.length - 1;
		const rightFolder = index < right.length - 1;
		if (leftFolder !== rightFolder) { return leftFolder ? -1 : 1; }
		const order = fileNames.compare(left[index]!, right[index]!);
		if (order) { return order; }
		if (left[index] !== right[index]) { return left[index]! < right[index]! ? -1 : 1; }
	}
	return 0;
}

function formatMatch(match: SearchMatch, indent = 2): string {
	const firstPreviewLine = match.preview.slice(0, match.previewRange.start).split(/\r\n|\r|\n/).length - 1;
	const lines = match.preview.split(/\r\n|\r|\n/).slice(firstPreviewLine, firstPreviewLine + match.range.endLineNumber - match.range.startLineNumber + 1);
	const prefixes = lines.map((_line, index) => index ? String(match.range.startLineNumber + index) : `${match.range.startLineNumber},${match.range.startColumn}`);
	const width = prefixes.reduce((maximum, prefix) => Math.max(maximum, prefix.length), 0);
	// Multi-line previews keep LF internally, including on Windows; result blocks use the host delimiter.
	return lines.map((line, index) => `${' '.repeat(indent)}${prefixes[index]}: ${' '.repeat(width - prefixes[index]!.length)}${line}`).join('\n');
}
