import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import { normalizeTextLineEndings, type TextModelChange } from '../../../../../editor/common/core/textChange.js';
import { TextEdit, TextReplacement } from '../../../../../editor/common/core/edits/textEdit.js';
import type { TextEdit as LanguageTextEdit } from '../../../../../editor/common/languages.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { DefaultLinesDiffComputer } from '../../../../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import type { TextModelReference } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { localize } from '../../../../../nls.js';
import type { IModifiedFileEntry, IModifiedFileEntryChangeHunk } from '../../common/editing/chatEditingService.js';

interface ReviewHunk extends IModifiedFileEntryChangeHunk {
	readonly originalStart: number;
	readonly originalEnd: number;
	readonly modifiedStart: number;
	readonly modifiedEnd: number;
}

/** Owns the accepted baseline; the shared TextModel remains the text and undo authority. */
export class ChatEditingModifiedDocumentEntry extends Disposable implements IModifiedFileEntry {
	public readonly isFileOperation = false;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	public readonly resources: readonly URI[];
	public readonly id: string;
	private originalText: string;
	private previousText: string;
	private changes: readonly ReviewHunk[] = [];
	private agentEditing = false;
	private expectedAgentText: string | undefined;
	public isBusy = false;
	private readonly computer = new DefaultLinesDiffComputer();

	constructor(public readonly modifiedURI: URI, private readonly reference: TextModelReference, private readonly complete: () => void, notify: () => void) {
		super();
		this._register(reference);
		this._register(this.onDidChange(notify));
		this.id = crypto.randomUUID();
		this.resources = [modifiedURI];
		this.originalText = this.previousText = reference.model.getText();
		this._register(reference.model.onDidChangeContent(event => this.handleModelChange(event)));
	}

	public get hunks(): readonly ReviewHunk[] { return this.changes; }

	public beginAgentEdit(edits: readonly LanguageTextEdit[]): void {
		const eol = this.reference.model.getEOL();
		this.expectedAgentText = TextEdit.fromParallelReplacementsUnsorted(edits.map(edit => new TextReplacement(Range.lift(edit.range), normalizeTextLineEndings(edit.text).replaceAll('\n', eol)))).applyToString(this.reference.model.getText());
		this.agentEditing = true;
		this.isBusy = true;
		this.changed.fire();
	}

	public endAgentEdit(): void {
		this.agentEditing = false;
		this.expectedAgentText = undefined;
		this.isBusy = false;
		this.updateDiff();
		if (this.changes.length === 0) { this.complete(); }
	}

	public beginRestore(): void {
		this.agentEditing = this.isBusy = true;
		this.expectedAgentText = undefined;
	}

	public async accept(hunk?: IModifiedFileEntryChangeHunk): Promise<void> {
		this.assertNotDisposed();
		if (this.isBusy) { return; }
		if (hunk) {
			const current = this.requireHunk(hunk);
			this.originalText = this.originalText.slice(0, current.originalStart) + current.modifiedText + this.originalText.slice(current.originalEnd);
			this.updateDiff();
		}
		if (!hunk || this.changes.length === 0) { this.complete(); }
	}

	public async reject(hunk?: IModifiedFileEntryChangeHunk): Promise<void> {
		this.assertNotDisposed();
		if (this.isBusy) { return; }
		const changes = hunk ? [this.requireHunk(hunk)] : this.changes;
		this.expectedAgentText = undefined;
		this.agentEditing = this.isBusy = true;
		this.changed.fire();
		try {
			this.reference.model.pushStackElement();
			this.reference.model.applyOperations(changes.map(change => ({ range: change.range, text: change.originalText })));
			this.reference.model.pushStackElement();
			this.agentEditing = false;
			// A rejected tool edit must also disappear from the file read by subsequent commands.
			await this.reference.save(new AbortController().signal);
		} finally {
			this.agentEditing = this.isBusy = false;
			this.updateDiff();
		}
		if (this.changes.length === 0) { this.complete(); }
	}

	public getAccessibleContent(): string {
		return this.changes.map((hunk, index) => localize('chatEditing.accessibleHunk', 'Change {0}, line {1}\nBefore:\n{2}\nAfter:\n{3}', index + 1, hunk.range.startLineNumber, hunk.originalText, hunk.modifiedText)).join('\n\n');
	}

	private requireHunk(hunk: IModifiedFileEntryChangeHunk): ReviewHunk {
		const current = this.changes.find(change => change === hunk);
		if (!current) { throw new Error(localize('chatEditing.stale', 'The change has changed. Review it again.')); }
		return current;
	}

	private handleModelChange(event: TextModelChange): void {
		const isAgentEdit = this.agentEditing && (this.expectedAgentText === undefined || this.reference.model.getText() === this.expectedAgentText);
		if (isAgentEdit) { this.agentEditing = false; }
		if (!isAgentEdit) {
			// User edits outside Agent hunks update the baseline. Editing an Agent hunk
			// adopts that hunk, so Reject never discards the user's replacement.
			const edits = event.changes.map(change => ({ start: change.rangeOffset, end: change.rangeOffset + change.rangeLength, text: change.text }));
			const groups: { start: number; end: number; edits: typeof edits; }[] = [];
			for (const edit of edits.sort((a, b) => a.start - b.start)) {
				let start = edit.start;
				let end = edit.end;
				for (const hunk of this.changes) {
					if (hunk.modifiedStart <= end && hunk.modifiedEnd >= start) {
						start = Math.min(start, hunk.modifiedStart);
						end = Math.max(end, hunk.modifiedEnd);
					}
				}
				const previous = groups.at(-1);
				if (previous && previous.end >= start) {
					previous.end = Math.max(previous.end, end);
					previous.edits.push(edit);
				} else { groups.push({ start, end, edits: [edit] }); }
			}
			for (const group of groups.reverse()) {
				let text = this.previousText.slice(group.start, group.end);
				for (const edit of group.edits.reverse()) {
					text = text.slice(0, edit.start - group.start) + edit.text + text.slice(edit.end - group.start);
				}
				const start = this.originalOffset(group.start, false);
				const end = this.originalOffset(group.end, true);
				this.originalText = this.originalText.slice(0, start) + text + this.originalText.slice(end);
			}
		}
		this.updateDiff();
		if (!this.isBusy && this.changes.length === 0) { this.complete(); }
	}

	private originalOffset(offset: number, end: boolean): number {
		let delta = 0;
		for (const hunk of this.changes) {
			if (offset < hunk.modifiedStart) { break; }
			if (offset <= hunk.modifiedEnd) { return end ? hunk.originalEnd : hunk.originalStart; }
			delta = hunk.originalEnd - hunk.modifiedEnd;
		}
		return offset + delta;
	}

	private updateDiff(): void {
		const current = this.reference.model.getText();
		const originalLines = this.originalText.split('\n');
		const modifiedLines = current.split('\n');
		const diff = this.computer.computeDiff(originalLines, modifiedLines, { ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: 0 });
		this.changes = diff.changes.map(change => {
			let originalStart = lineOffset(originalLines, change.original.startLineNumber);
			const originalEnd = lineOffset(originalLines, change.original.endLineNumberExclusive);
			let modifiedStart = lineOffset(modifiedLines, change.modified.startLineNumber);
			const modifiedEnd = lineOffset(modifiedLines, change.modified.endLineNumberExclusive);
			// The final newline belongs to the preceding line when a hunk reaches EOF.
			if (originalStart === this.originalText.length || modifiedStart === current.length) {
				if (this.originalText[originalStart - 1] === '\n') { originalStart -= this.originalText[originalStart - 2] === '\r' ? 2 : 1; }
				if (current[modifiedStart - 1] === '\n') { modifiedStart -= current[modifiedStart - 2] === '\r' ? 2 : 1; }
			}
			const start = this.reference.model.getPositionAt(modifiedStart);
			const end = this.reference.model.getPositionAt(modifiedEnd);
			return { originalStart, originalEnd, modifiedStart, modifiedEnd, range: Range.fromPositions(start, end), originalText: this.originalText.slice(originalStart, originalEnd), modifiedText: current.slice(modifiedStart, modifiedEnd) };
		});
		this.previousText = current;
		this.changed.fire();
	}
}

function lineOffset(lines: readonly string[], line: number): number {
	let offset = 0;
	for (let index = 0; index < Math.min(line - 1, lines.length); index++) { offset += lines[index]!.length + (index < lines.length - 1 ? 1 : 0); }
	return offset;
}
