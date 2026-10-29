import { type ISingleEditOperation } from '../../../common/core/editOperation.js';
import { Range } from '../../../common/core/range.js';
import { type ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { type ITextModel } from '../../../common/model.js';
import { generateIndent, getSpaceCnt } from './indentUtils.js';

/** Computes deterministic brace/rule-based reindent edits for a physical line range. */
export function getReindentEditOperations(
	model: ITextModel,
	languageConfigurationService: ILanguageConfigurationService,
	startLineNumber: number,
	endLineNumber: number,
): ISingleEditOperation[] {
	if (!Number.isSafeInteger(startLineNumber) || !Number.isSafeInteger(endLineNumber)) {
		throw new TypeError('Reindent line numbers must be safe integers');
	}
	const start = Math.max(1, startLineNumber);
	const end = Math.min(model.getLineCount(), endLineNumber);
	if (start >= end) return [];
	const rules = languageConfigurationService.getLanguageConfiguration(model.getLanguageId()).indentRulesSupport;
	if (!rules) return [];
	const options = model.getOptions();
	const first = model.getLineContent(start);
	let nextColumns = getSpaceCnt(leadingWhitespace(first), options.tabSize);
	if (rules.shouldIncrease(first) || rules.shouldIndentNextLine(first)) nextColumns += options.indentSize;
	const edits: ISingleEditOperation[] = [];

	for (let lineNumber = start + 1; lineNumber <= end; lineNumber += 1) {
		const line = model.getLineContent(lineNumber);
		if (rules.shouldIgnore(line)) continue;
		let currentColumns = nextColumns;
		if (rules.shouldDecrease(line)) currentColumns = Math.max(0, currentColumns - options.indentSize);
		const before = leadingWhitespace(line);
		const after = generateIndent(currentColumns, options.tabSize, options.insertSpaces);
		if (before !== after) edits.push({ range: new Range(lineNumber, 1, lineNumber, before.length + 1), text: after });
		nextColumns = rules.shouldIncrease(line) || rules.shouldIndentNextLine(line)
			? currentColumns + options.indentSize
			: currentColumns;
	}
	return edits;
}

function leadingWhitespace(value: string): string {
	return /^[\t ]*/.exec(value)![0];
}
