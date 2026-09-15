import { Selection } from "../../../common/core/selection.js";
import { Position } from "../../../common/core/position.js";
import { Range } from "../../../common/core/range.js";

import { type ITextModel } from "../../../common/model.js";
import * as nls from '../../../../nls.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { EditorAction, registerEditorAction, type ServicesAccessor } from '../../../browser/editorExtensions.js';
import { MoveOperations } from '../../../common/cursor/cursorMoveOperations.js';
import { type ICommand } from '../../../common/editorCommon.js';
import { type IActionOptions } from '../../../browser/editorExtensions.js';
import { CopyLinesCommand } from './copyLinesCommand.js';
import { MoveLinesCommand } from './moveLinesCommand.js';
import { SortLinesCommand } from './sortLinesCommand.js';
import { ReplaceCommand, ReplaceCommandThatSelectsText } from '../../../common/commands/replaceCommand.js';
import { EnterOperation } from '../../../common/cursor/cursorTypeEditOperations.js';
import { EditorAutoIndentStrategy } from '../../../common/config/editorOptions.js';
import { ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';

interface OffsetEdit {
	readonly startOffset: number;
	readonly endOffset: number;
	readonly text: string;
	readonly edit: { readonly range: Range; readonly text: string };
}

interface TransposeOperation {
	readonly selectionIndex: number;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly edit: { readonly range: Range; readonly text: string };
}

abstract class CopyLinesAction extends EditorAction {
	constructor(private readonly down: boolean, options: IActionOptions) {
		super(options);
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const selections = editor.getSelections() ?? [];
		editor.pushUndoStop();
		editor.executeCommands(this.id, selections.map(selection => new CopyLinesCommand(selection, this.down)));
		editor.pushUndoStop();
	}
}

class CopyLinesUpAction extends CopyLinesAction {
	constructor() {
		super(false, { id: 'editor.action.copyLinesUpAction', label: nls.localize2('lines.copyUp', 'Copy Line Up'), precondition: undefined, canTriggerInlineEdits: true });
	}
}

class CopyLinesDownAction extends CopyLinesAction {
	constructor() {
		super(true, { id: 'editor.action.copyLinesDownAction', label: nls.localize2('lines.copyDown', 'Copy Line Down'), precondition: undefined, canTriggerInlineEdits: true });
	}
}

/** Duplicates selected text, or the selected physical line for an empty selection. */
export class DuplicateSelectionAction extends EditorAction {
	constructor() {
		super({ id: 'editor.action.duplicateSelection', label: nls.localize2('duplicateSelection', 'Duplicate Selection'), precondition: undefined, canTriggerInlineEdits: true });
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const model = editor.getModel();
		if (!model) return;
		const commands = (editor.getSelections() ?? []).map(selection => selection.isEmpty()
			? new CopyLinesCommand(selection, true)
			: new ReplaceCommandThatSelectsText(
				Selection.fromPositions(selection.getEndPosition()),
				model.getValueInRange(selection),
			));
		editor.pushUndoStop();
		editor.executeCommands(this.id, commands);
		editor.pushUndoStop();
	}
}

abstract class MoveLinesAction extends EditorAction {
	constructor(private readonly down: boolean, options: IActionOptions) {
		super(options);
	}

	public run(accessor: ServicesAccessor, editor: ICodeEditor): void {
		const configurations = accessor.get(ILanguageConfigurationService);
		const commands = (editor.getSelections() ?? []).map(selection => new MoveLinesCommand(
			selection,
			this.down,
			EditorAutoIndentStrategy.None,
			configurations,
		));
		editor.pushUndoStop();
		editor.executeCommands(this.id, commands);
		editor.pushUndoStop();
	}
}

class MoveLinesUpAction extends MoveLinesAction {
	constructor() {
		super(false, { id: 'editor.action.moveLinesUpAction', label: nls.localize2('lines.moveUp', 'Move Line Up'), precondition: undefined, canTriggerInlineEdits: true });
	}
}

class MoveLinesDownAction extends MoveLinesAction {
	constructor() {
		super(true, { id: 'editor.action.moveLinesDownAction', label: nls.localize2('lines.moveDown', 'Move Line Down'), precondition: undefined, canTriggerInlineEdits: true });
	}
}

export abstract class AbstractSortLinesAction extends EditorAction {
	constructor(private readonly descending: boolean, options: IActionOptions) {
		super(options);
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		const model = editor.getModel();
		if (!model) return;
		let selections = editor.getSelections() ?? [];
		if (selections.length === 1 && selections[0]!.isSingleLine()) {
			selections = [new Selection(1, 1, model.getLineCount(), model.getLineMaxColumn(model.getLineCount()))];
		}
		if (!selections.every(selection => SortLinesCommand.canRun(model, selection, this.descending))) return;
		editor.pushUndoStop();
		editor.executeCommands(this.id, selections.map(selection => new SortLinesCommand(selection, this.descending)));
		editor.pushUndoStop();
	}
}

export class SortLinesAscendingAction extends AbstractSortLinesAction {
	constructor() {
		super(false, { id: 'editor.action.sortLinesAscending', label: nls.localize2('lines.sortAscending', 'Sort Lines Ascending'), precondition: undefined, canTriggerInlineEdits: true });
	}
}

export class SortLinesDescendingAction extends AbstractSortLinesAction {
	constructor() {
		super(true, { id: 'editor.action.sortLinesDescending', label: nls.localize2('lines.sortDescending', 'Sort Lines Descending'), precondition: undefined, canTriggerInlineEdits: true });
	}
}

export class TransposeAction extends EditorAction {
	constructor() {
		super({
			id: 'editor.action.transpose',
			label: nls.localize2('editor.transpose', 'Transpose Characters around the Cursor'),
			precondition: undefined,
			canTriggerInlineEdits: true,
		});
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		transpose(editor);
	}
}

export class DeleteLinesAction extends EditorAction {
	constructor() {
		super({ id: 'editor.action.deleteLines', label: nls.localize2('lines.delete', 'Delete Line'), precondition: undefined, canTriggerInlineEdits: true });
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		deleteLines(editor);
	}
}

export class InsertLineBeforeAction extends EditorAction {
	public static readonly ID = 'editor.action.insertLineBefore';

	constructor() {
		super({ id: InsertLineBeforeAction.ID, label: nls.localize2('lines.insertBefore', 'Insert Line Above'), precondition: undefined, canTriggerInlineEdits: true });
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		insertLine(editor, true);
	}
}

export class InsertLineAfterAction extends EditorAction {
	public static readonly ID = 'editor.action.insertLineAfter';

	constructor() {
		super({ id: InsertLineAfterAction.ID, label: nls.localize2('lines.insertAfter', 'Insert Line Below'), precondition: undefined, canTriggerInlineEdits: true });
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		insertLine(editor, false);
	}
}

export class JoinLinesAction extends EditorAction {
	constructor() {
		super({ id: 'editor.action.joinLines', label: nls.localize2('lines.joinLines', 'Join Lines'), precondition: undefined, canTriggerInlineEdits: true });
	}

	public run(_accessor: ServicesAccessor, editor: ICodeEditor): void {
		joinLines(editor);
	}
}

function transpose(editor: ICodeEditor): void {
	const model = editor.getModel();
	const selections = editor.getSelections();
	if (!model || !selections) return;
	const commands = createTransposeCommands(model, selections);
	if (commands.every(command => command === null)) return;
	editor.pushUndoStop();
	editor.executeCommands('editor.action.transpose', commands);
	editor.pushUndoStop();
}

function createTransposeCommands(model: ITextModel, selections: readonly Selection[]): (ICommand | null)[] {
	const candidates = selections.flatMap((selection, selectionIndex) => {
		if (!selection.isEmpty()) return [];
		const cursor = selection.getPosition();
		const isLineEnd = cursor.column === model.getLineContent(cursor.lineNumber).length + 1;
		if (isLineEnd && cursor.lineNumber === model.getLineCount()) return [];
		const begin = cursor.column === 1 ? cursor : MoveOperations.leftPosition(model, cursor);
		const end = MoveOperations.rightPosition(model, cursor.lineNumber, cursor.column);
		if (Position.compare(cursor, end) === 0) return [];
		const range = Range.fromPositions(begin, end);
		const left = model.getValueInRange(Range.fromPositions(begin, cursor));
		const right = model.getValueInRange(Range.fromPositions(cursor, end));
		return [Object.freeze({
			selectionIndex,
			startOffset: model.getOffsetAt(begin),
			endOffset: model.getOffsetAt(end),
			edit: Object.freeze({ range, text: `${right}${left}` }),
		})];
	});
	const operations = selectTransposeOperations(candidates);
	const operationBySelection = new Map(operations.map(operation => [operation.selectionIndex, operation]));
	return selections.map((_selection, selectionIndex) => {
		const operation = operationBySelection.get(selectionIndex);
		return operation ? new ReplaceCommand(operation.edit.range, operation.edit.text) : null;
	});
}

function selectTransposeOperations(candidates: readonly TransposeOperation[]): readonly TransposeOperation[] {
	const selected: TransposeOperation[] = [];
	for (const candidate of [...candidates].sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset || left.selectionIndex - right.selectionIndex)) {
		const overlapIndex = selected.findIndex(existing => candidate.startOffset < existing.endOffset && existing.startOffset < candidate.endOffset);
		if (overlapIndex < 0) {
			selected.push(candidate);
			continue;
		}
		if (candidate.selectionIndex === 0 && selected[overlapIndex]!.selectionIndex !== 0) selected[overlapIndex] = candidate;
	}
	return Object.freeze(selected.sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset));
}

function deleteLines(editor: ICodeEditor): void {
	const model = editor.getModel();
	const selections = editor.getSelections();
	if (!model || !selections || (model.getLineCount() === 1 && model.getLineMaxColumn(1) === 1)) return;
	const groups = contiguousLineGroups(selectedLineIndices(selections));
	const edits = groups.flatMap<OffsetEdit>(group => deleteLineGroup(model, group));
	const finalText = applyOffsetEdits(model.getValue(), edits);
	const cursorState = selections.map(selection => Selection.fromPositions(
		positionAtOffset(finalText, mapOffsetThroughEdits(model.getOffsetAt(selection.getSelectionStart()), edits)),
		positionAtOffset(finalText, mapOffsetThroughEdits(model.getOffsetAt(selection.getPosition()), edits)),
	));
	editor.pushUndoStop();
	editor.executeEdits('editor.action.deleteLines', edits.map(edit => edit.edit), cursorState);
	editor.pushUndoStop();
}

function insertLine(editor: ICodeEditor, before: boolean): void {
	const model = editor.getModel();
	const selections = editor.getSelections();
	const viewModel = editor._getViewModel();
	if (!model || !selections || !viewModel) return;
	const commands = before
		? EnterOperation.lineInsertBefore(viewModel.cursorConfig, model, selections)
		: EnterOperation.lineInsertAfter(viewModel.cursorConfig, model, selections);
	editor.pushUndoStop();
	editor.executeCommands(before ? InsertLineBeforeAction.ID : InsertLineAfterAction.ID, commands);
	editor.pushUndoStop();
}

interface JoinTarget {
	readonly start: Position;
	readonly end: Position;
	readonly primary: boolean;
}

interface JoinEdit {
	readonly target: JoinTarget;
	readonly range: Range;
	readonly startOffset: number;
	readonly endOffset: number;
	readonly text: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
}

function joinLines(editor: ICodeEditor): void {
	const model = editor.getModel();
	const selections = editor.getSelections();
	if (!model || !selections) return;
	const edits = reduceJoinTargets(selections).map(target => joinEdit(model, target));
	if (edits.every(edit => edit.startOffset === edit.endOffset)) return;
	const operations: Array<{ readonly range: Range; readonly text: string }> = [];
	const selectionOffsets: Array<{ readonly anchorOffset: number; readonly activeOffset: number }> = [];
	let primarySelectionIndex = 0;
	let delta = 0;
	for (const edit of edits) {
		const base = edit.startOffset + delta;
		selectionOffsets.push({ anchorOffset: base + edit.selectionStart, activeOffset: base + edit.selectionEnd });
		if (edit.target.primary) primarySelectionIndex = selectionOffsets.length - 1;
		if (edit.startOffset === edit.endOffset) continue;
		operations.push({ range: edit.range, text: edit.text });
		delta += edit.text.length - (edit.endOffset - edit.startOffset);
	}
	const finalText = applyOffsetEdits(model.getValue(), edits.map(edit => ({ ...edit, edit: { range: edit.range, text: edit.text } })));
	const cursorState = selectionOffsets.map(offsets => Selection.fromPositions(
		positionAtOffset(finalText, offsets.anchorOffset),
		positionAtOffset(finalText, offsets.activeOffset),
	));
	if (primarySelectionIndex > 0) cursorState.unshift(cursorState.splice(primarySelectionIndex, 1)[0]!);
	editor.pushUndoStop();
	editor.executeEdits('editor.action.joinLines', operations, cursorState);
	editor.pushUndoStop();
}

function reduceJoinTargets(selections: readonly Selection[]): readonly JoinTarget[] {
	const ordered = selections.map((selection, index) => ({
		start: selection.getStartPosition(),
		end: selection.getEndPosition(),
		primary: index === 0,
	})).sort((left, right) => Position.compare(left.start, right.start) || Position.compare(left.end, right.end));
	const result: JoinTarget[] = [];
	for (const target of ordered) {
		const previous = result.at(-1);
		if (!previous) {
			result.push(target);
			continue;
		}
		const previousCollapsed = Position.compare(previous.start, previous.end) === 0;
		if (previousCollapsed && previous.end.lineNumber === target.start.lineNumber) {
			result[result.length - 1] = { ...target, primary: previous.primary || target.primary };
			continue;
		}
		const separate = previousCollapsed
			? target.start.lineNumber > previous.end.lineNumber + 1
			: target.start.lineNumber > previous.end.lineNumber;
		if (separate) {
			result.push(target);
			continue;
		}
		result[result.length - 1] = { start: previous.start, end: target.end, primary: previous.primary || target.primary };
	}
	return result;
}

function joinEdit(model: ITextModel, target: JoinTarget): JoinEdit {
	const collapsed = Position.compare(target.start, target.end) === 0;
	const endLineNumber = collapsed ? Math.min(target.start.lineNumber + 1, model.getLineCount()) : target.end.lineNumber;
	if (endLineNumber === target.start.lineNumber) {
		const lineStart = new Position(target.start.lineNumber, 1);
		const offset = model.getOffsetAt(lineStart);
		return {
			target,
			range: Range.fromPositions(lineStart),
			startOffset: offset,
			endOffset: offset,
			text: '',
			selectionStart: target.start.column - 1,
			selectionEnd: target.end.column - 1,
		};
	}
	const end = new Position(endLineNumber, model.getLineMaxColumn(endLineNumber));
	const joined = joinText(model, target.start.lineNumber, endLineNumber);
	const selectionTail = model.getLineContent(target.end.lineNumber).length - (target.end.column - 1);
	const boundary = collapsed ? joined.text.length - joined.lastPartLength : target.start.column - 1;
	return {
		target: { ...target, end },
		range: Range.fromPositions(new Position(target.start.lineNumber, 1), end),
		startOffset: model.getOffsetAt(new Position(target.start.lineNumber, 1)),
		endOffset: model.getOffsetAt(end),
		text: joined.text,
		selectionStart: boundary,
		selectionEnd: collapsed ? boundary : joined.text.length - selectionTail,
	};
}

function joinText(model: ITextModel, startLineNumber: number, endLineNumber: number): { readonly text: string; readonly lastPartLength: number } {
	let text = model.getLineContent(startLineNumber);
	let lastPartLength = 0;
	for (let lineNumber = startLineNumber + 1; lineNumber <= endLineNumber; lineNumber += 1) {
		const part = model.getLineContent(lineNumber).replace(/^[\s\uFEFF\xA0]+/u, '');
		if (!part) {
			lastPartLength = 0;
			continue;
		}
		let separator = text.length > 0 ? ' ' : '';
		if (separator && /[\s\uFEFF\xA0]$/u.test(text)) {
			text = text.replace(/[\s\uFEFF\xA0]+$/u, ' ');
			separator = '';
		}
		text += separator + part;
		lastPartLength = separator.length + part.length;
	}
	return { text, lastPartLength };
}

function deleteLineGroup(model: ITextModel, group: EditorLineGroup): readonly OffsetEdit[] {
	const first = group.startLineIndex;
	const last = group.endLineIndex;
	if (first === 0 && last === model.getLineCount() - 1) {
		const start = new Position((0) + 1, (0) + 1);
		const end = new Position((last) + 1, (model.getLineContent((last) + 1).length) + 1);
		return [offsetEdit(model, start, end, "")];
	}
	if (last + 1 < model.getLineCount()) {
		return [offsetEdit(model, new Position((first) + 1, (0) + 1), new Position((last + 1) + 1, (0) + 1), "")];
	}
	const previousLineIndex = first - 1;
	return [offsetEdit(
		model,
		new Position((previousLineIndex) + 1, (model.getLineContent((previousLineIndex) + 1).length) + 1),
		new Position((last) + 1, (model.getLineContent((last) + 1).length) + 1),
		"",
	)];
}

function offsetEdit(model: ITextModel, start: Position, end: Position, text: string): OffsetEdit {
	return Object.freeze({
		startOffset: model.getOffsetAt(start),
		endOffset: model.getOffsetAt(end),
		text,
		edit: Object.freeze({ range: Range.fromPositions(start, end), text }),
	});
}

interface EditorLineGroup {
	readonly startLineIndex: number;
	readonly endLineIndex: number;
}

function selectedLineIndices(selections: readonly Selection[]): readonly number[] {
	const indices = new Set<number>();
	for (const selection of selections) {
		const range = selection;
		let endLineIndex = range.endLineNumber - 1;
		if (!selection.isEmpty() && range.endColumn === 1 && endLineIndex > range.startLineNumber - 1) {
			endLineIndex -= 1;
		}
		for (let lineIndex = range.startLineNumber - 1; lineIndex <= endLineIndex; lineIndex += 1) indices.add(lineIndex);
	}
	return Object.freeze([...indices].sort((left, right) => left - right));
}

function contiguousLineGroups(lineIndices: readonly number[]): readonly EditorLineGroup[] {
	const groups: EditorLineGroup[] = [];
	for (const lineIndex of lineIndices) {
		const previous = groups.at(-1);
		if (previous && lineIndex === previous.endLineIndex + 1) {
			groups[groups.length - 1] = Object.freeze({ ...previous, endLineIndex: lineIndex });
		} else {
			groups.push(Object.freeze({ startLineIndex: lineIndex, endLineIndex: lineIndex }));
		}
	}
	return Object.freeze(groups);
}

function mapOffsetThroughEdits(offset: number, edits: readonly OffsetEdit[]): number {
	let delta = 0;
	for (const edit of edits) {
		if (offset < edit.startOffset) break;
		if (edit.startOffset === edit.endOffset && offset === edit.startOffset) {
			return offset + delta + edit.text.length;
		}
		if (offset <= edit.endOffset) {
			return edit.startOffset + delta + Math.min(offset - edit.startOffset, edit.text.length);
		}
		delta += edit.text.length - (edit.endOffset - edit.startOffset);
	}
	return offset + delta;
}

function applyOffsetEdits(text: string, edits: readonly OffsetEdit[]): string {
	let result = text;
	for (let index = edits.length - 1; index >= 0; index -= 1) {
		const edit = edits[index]!;
		result = result.slice(0, edit.startOffset) + edit.text + result.slice(edit.endOffset);
	}
	return result;
}

function positionAtOffset(text: string, offset: number): Position {
	if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) throw new RangeError('Line operation cursor offset is outside the result text');
	let lineNumber = 1;
	let lineStartOffset = 0;
	for (let index = 0; index < offset; index += 1) {
		if (text.charCodeAt(index) === 10) {
			lineNumber += 1;
			lineStartOffset = index + 1;
		}
	}
	return new Position(lineNumber, offset - lineStartOffset + 1);
}

registerEditorAction(CopyLinesUpAction);
registerEditorAction(CopyLinesDownAction);
registerEditorAction(DuplicateSelectionAction);
registerEditorAction(MoveLinesUpAction);
registerEditorAction(MoveLinesDownAction);
registerEditorAction(SortLinesAscendingAction);
registerEditorAction(SortLinesDescendingAction);
registerEditorAction(TransposeAction);
registerEditorAction(DeleteLinesAction);
registerEditorAction(InsertLineBeforeAction);
registerEditorAction(InsertLineAfterAction);
registerEditorAction(JoinLinesAction);
