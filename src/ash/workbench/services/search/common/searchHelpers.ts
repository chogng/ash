import type { FindMatch, ITextModel } from '../../../../editor/common/model.js';
import type { ITextSearchMatch } from './search.js';

/** Converts model matches without changing their source ranges or the model's text. */
export function editorMatchesToTextSearchResults(matches: FindMatch[], model: ITextModel): ITextSearchMatch[] {
	const lines = model.getLinesContent();
	return matches.map(({ range }) => ({
		previewText: lines.slice(range.startLineNumber - 1, range.endLineNumber).join('\n'),
		rangeLocations: [{
			source: {
				startLineNumber: range.startLineNumber - 1,
				startColumn: range.startColumn - 1,
				endLineNumber: range.endLineNumber - 1,
				endColumn: range.endColumn - 1,
			},
			preview: {
				startLineNumber: 0,
				startColumn: range.startColumn - 1,
				endLineNumber: range.endLineNumber - range.startLineNumber,
				endColumn: range.endColumn - 1,
			},
		}],
	}));
}
