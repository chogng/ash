import { isWindows } from '../../../../base/common/platform.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/labelService.js';
import { localize2 } from '../../../../nls.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { SEARCH_VIEW_ID, SearchCommandIds } from '../common/constants.js';
import type { SearchView } from './searchView.js';
import type { SearchFileMatch, SearchMatch } from './searchTreeModel/searchResult.js';

const lineDelimiter = isWindows ? '\r\n' : '\n';
const fileNames = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

registerAction2(class CopyAllCommandAction extends Action2 {
	constructor() {
		super({ id: SearchCommandIds.CopyAllCommandId, title: localize2('search.copyAll', 'Copy All') });
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const view = accessor.get(IViewsService).getViewWithId<SearchView>(SEARCH_VIEW_ID);
		if (!view) { return; }
		const labels = accessor.get(ILabelService);
		// Read the retained model when invoked; collapsed rows and earlier snapshots are not the source.
		const text = view.searchResult.files.filter(file => file.matches.length).sort(compareResultFiles).map(file => {
			const rows = [...file.matches].sort((a, b) => Range.compareRangesUsingStarts(a.range, b.range)).map(formatMatch);
			return [labels.getUriLabel(file.resource, { noPrefix: true }), ...rows].join(lineDelimiter);
		}).join(lineDelimiter + lineDelimiter);
		await accessor.get(IClipboardService).writeText(text);
	}
});

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

function formatMatch(match: SearchMatch): string {
	const firstPreviewLine = match.preview.slice(0, match.previewRange.start).split(/\r\n|\r|\n/).length - 1;
	const lines = match.preview.split(/\r\n|\r|\n/).slice(firstPreviewLine, firstPreviewLine + match.range.endLineNumber - match.range.startLineNumber + 1);
	const prefixes = lines.map((_line, index) => index ? String(match.range.startLineNumber + index) : `${match.range.startLineNumber},${match.range.startColumn}`);
	const width = prefixes.reduce((maximum, prefix) => Math.max(maximum, prefix.length), 0);
	// Multi-line previews keep LF internally, including on Windows; result blocks use the host delimiter.
	return lines.map((line, index) => `  ${prefixes[index]}: ${' '.repeat(width - prefixes[index]!.length)}${line}`).join('\n');
}
