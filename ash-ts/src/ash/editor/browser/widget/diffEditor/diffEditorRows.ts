import { fragment as createFragment, h, reset } from '../../../../base/browser/dom.js';
import { type DiffModel } from '../../../common/diff/diffModel.js';
import { LineDiffKind, type DiffRange, type LineDiffRow } from '../../../common/diff/lineDiff.js';

/** Creates one side-by-side row shared by the single- and multi-diff widgets. */
export interface WrappedDiffRow {
	readonly height: number;
	readonly originalBreaks: readonly number[];
	readonly modifiedBreaks: readonly number[];
}

export function createDiffEditorRow(ownerDocument: Document, row: LineDiffRow, model: DiffModel, lineHeight: number, active: boolean, showInlineChanges: boolean, wrapped?: WrappedDiffRow): HTMLDivElement {
	const element = h(ownerDocument, 'div');
	element.className = `stanza-diff-editor-row ${row.kind}`;
	element.classList.toggle('active', active);
	element.classList.toggle('word-wrapped', !!wrapped);
	element.style.height = `${wrapped?.height ?? lineHeight}px`;
	element.style.lineHeight = `${lineHeight}px`;
	element.append(
		createDiffCell(ownerDocument, 'original', row.kind, row.originalLineIndex,
			row.originalLineIndex === undefined ? undefined : model.original.getLineContent(row.originalLineIndex + 1),
			row.originalChanges, showInlineChanges, wrapped?.originalBreaks, model.original.getOptions().tabSize),
		createDiffCell(ownerDocument, 'modified', row.kind, row.modifiedLineIndex,
			row.modifiedLineIndex === undefined ? undefined : model.modified.getLineContent(row.modifiedLineIndex + 1),
			row.modifiedChanges, showInlineChanges, wrapped?.modifiedBreaks, model.modified.getOptions().tabSize),
	);
	return element;
}

function createDiffCell(ownerDocument: Document, side: 'original' | 'modified', kind: LineDiffKind, lineIndex: number | undefined, text: string | undefined, changes: readonly DiffRange[], showInlineChanges: boolean, breaks?: readonly number[], tabSize?: number): HTMLDivElement {
	const cell = h(ownerDocument, 'div');
	cell.className = `stanza-diff-editor-cell ${side}`;
	const number = h(ownerDocument, 'span');
	number.className = 'stanza-diff-editor-line-number';
	number.textContent = lineIndex === undefined ? '' : String(lineIndex + 1);
	const content = h(ownerDocument, 'span');
	content.className = 'stanza-diff-editor-line-content';
	if (breaks && tabSize !== undefined) content.style.tabSize = String(tabSize);
	if (text === undefined) {
		cell.classList.add('missing');
	} else {
		const changedKind = side === 'original' ? LineDiffKind.Removed : LineDiffKind.Added;
		if (breaks) projectWrappedText(ownerDocument, content, text, breaks, changes, changedKind, showInlineChanges);
		else if (showInlineChanges) projectDiffText(ownerDocument, content, text, changes, changedKind);
		else content.textContent = text;
		if (kind === LineDiffKind.Modified) cell.classList.add(side === 'original' ? 'removed' : 'added');
		else if (kind === LineDiffKind.Removed && side === 'original') cell.classList.add('removed');
		else if (kind === LineDiffKind.Added && side === 'modified') cell.classList.add('added');
	}
	cell.append(number, content);
	return cell;
}

function projectWrappedText(ownerDocument: Document, content: HTMLElement, text: string, breaks: readonly number[], changes: readonly DiffRange[], changedKind: LineDiffKind, showInlineChanges: boolean): void {
	let start = 0;
	for (const end of breaks) {
		const visualLine = h(ownerDocument, 'span');
		visualLine.className = 'stanza-diff-editor-visual-line';
		const segment = text.slice(start, end);
		if (showInlineChanges) {
			const segmentChanges = changes
				.filter(change => change.endColumn > start && change.startColumn < end)
				.map(change => ({
					startColumn: Math.max(0, change.startColumn - start),
					endColumn: Math.min(end, change.endColumn) - start,
				}));
			projectDiffText(ownerDocument, visualLine, segment, segmentChanges, changedKind);
		} else {
			visualLine.textContent = segment;
		}
		content.append(visualLine);
		start = end;
	}
}

function projectDiffText(ownerDocument: Document, target: HTMLElement, text: string, changes: readonly DiffRange[], changedKind: LineDiffKind): void {
	const fragment = createFragment(ownerDocument);
	let previousEnd = 0;
	for (const change of changes) {
		fragment.append(text.slice(previousEnd, change.startColumn));
		const changed = h(ownerDocument, 'span');
		changed.className = `stanza-diff-editor-inline ${changedKind}`;
		changed.textContent = text.slice(change.startColumn, change.endColumn);
		fragment.append(changed);
		previousEnd = change.endColumn;
	}
	fragment.append(text.slice(previousEnd));
	reset(target, fragment);
}
