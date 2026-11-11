import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import { normalizeTextLineEndings, TextModelChangeReason, type TextModelChange } from '../../../../../editor/common/core/textChange.js';
import { TextEdit, TextReplacement } from '../../../../../editor/common/core/edits/textEdit.js';
import { StringEdit, StringReplacement } from '../../../../../editor/common/core/edits/stringEdit.js';
import type { TextEdit as LanguageTextEdit } from '../../../../../editor/common/languages.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { OffsetRange } from '../../../../../editor/common/core/ranges/offsetRange.js';
import { StringText } from '../../../../../editor/common/core/text/abstractText.js';
import { DefaultLinesDiffComputer } from '../../../../../editor/common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.js';
import type { TextModelReference } from '../../../../services/textmodelResolver/common/textModelResourceService.js';
import { localize } from '../../../../../nls.js';
import type { IModifiedFileEntry, IModifiedFileEntryChangeHunk, ISnapshotEntry } from '../../common/editing/chatEditingService.js';

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
	private rejectionSource: string | undefined;
	// Agent attribution ends at the model event, but its operation owns busy until endAgentEdit.
	private agentEditInProgress = false;
	private reviewSaving = false;
	private reviewSuspended = false;
	private agentEditRevision = 0;
	public get isBusy(): boolean { return this.agentEditInProgress || this.reviewSaving; }
	private readonly computer = new DefaultLinesDiffComputer();

	constructor(public readonly modifiedURI: URI, private readonly reference: TextModelReference, private readonly complete: () => void, notify: () => void, snapshot?: ISnapshotEntry) {
		super();
		this._register(reference);
		this._register(this.onDidChange(notify));
		this.id = crypto.randomUUID();
		this.resources = [modifiedURI];
		this.originalText = this.previousText = reference.model.getText();
		if (snapshot) {
			// Recover the unsaved decision only while the file still matches its
			// recorded source. Existing dirty models and later file edits belong to
			// their owner; they must not be replaced by review recovery.
			if (snapshot.pendingSaveSource !== undefined && !reference.isDirty && reference.model.getText() === snapshot.pendingSaveSource) {
				reference.model.pushStackElement();
				reference.model.applyOperations([{ range: reference.model.getFullModelRange(), text: snapshot.current }]);
				reference.model.pushStackElement();
			}
			this.originalText = snapshot.original;
			this.previousText = snapshot.current;
			// Changes made while this window was closed belong to the user. Rebase
			// the review baseline instead of overwriting the current file on reopen.
			this.reconcileModelChange();
			if (snapshot.pendingSaveSource !== undefined && reference.isDirty) { this.rejectionSource = snapshot.pendingSaveSource; }
		}
		this._register(reference.onDidChangeDirty(() => {
			if (this.rejectionSource !== undefined && !reference.isDirty) {
				this.rejectionSource = undefined;
				this.changed.fire();
				if (!this.isBusy && !this.isReviewSuspended && this.changes.length === 0) { this.complete(); }
			}
		}));
		this._register(reference.model.onDidChangeContent(event => this.handleModelChange(event)));
	}

	public createSnapshot(): ISnapshotEntry {
		// The source is a recovery precondition, not an editable document. It
		// prevents a restart from treating a failed partial decision as accepted.
		// Keep the last attributable state across restart while the live text conflicts.
		return { resource: this.modifiedURI, original: this.originalText, current: this.previousText, ...(this.rejectionSource === undefined ? {} : { pendingSaveSource: this.rejectionSource }) };
	}

	public get hasPendingSave(): boolean { return this.rejectionSource !== undefined; }

	public get isReviewSuspended(): boolean { return this.reviewSuspended; }
	public get hunks(): readonly ReviewHunk[] { return this.reviewSuspended ? [] : this.changes; }

	public beginAgentEdit(edits: readonly LanguageTextEdit[]): void {
		this.assertReviewAvailable();
		const eol = this.reference.model.getEOL();
		this.expectedAgentText = TextEdit.fromParallelReplacementsUnsorted(edits.map(edit => new TextReplacement(Range.lift(edit.range), normalizeTextLineEndings(edit.text).replaceAll('\n', eol)))).applyToString(this.reference.model.getText());
		this.agentEditing = this.agentEditInProgress = true;
		this.agentEditRevision++;
		this.changed.fire();
	}

	public endAgentEdit(): void {
		this.agentEditing = false;
		this.expectedAgentText = undefined;
		this.agentEditInProgress = false;
		this.updateDiff();
		if (!this.isBusy && !this.reviewSuspended && this.changes.length === 0 && !this.hasPendingSave) { this.complete(); }
	}

	public beginRestore(): void {
		this.agentEditing = this.agentEditInProgress = true;
		this.agentEditRevision++;
		this.expectedAgentText = undefined;
	}

	public async accept(hunk?: IModifiedFileEntryChangeHunk): Promise<void> {
		this.assertNotDisposed();
		this.assertReviewAvailable();
		if (this.isBusy) { return; }
		const version = this.reference.model.version;
		const agentEditRevision = this.agentEditRevision;
		// Saving acknowledges a captured text, not later edits or a new Agent operation.
		// The user's decision must not retire a review that changed while the write awaited.
		if (this.hasPendingSave || this.reference.isDirty) { await this.saveReviewedChanges(); }
		if (this.isDisposed || this.isBusy || this.reviewSuspended || this.reference.isDirty || this.reference.model.version !== version || this.agentEditRevision !== agentEditRevision) { return; }
		if (hunk) {
			const current = this.requireHunk(hunk);
			this.originalText = this.originalText.slice(0, current.originalStart) + current.modifiedText + this.originalText.slice(current.originalEnd);
			this.updateDiff();
		}
		if (!hunk || this.changes.length === 0) { this.complete(); }
	}

	public async reject(hunk?: IModifiedFileEntryChangeHunk): Promise<void> {
		this.assertNotDisposed();
		this.assertReviewAvailable();
		if (this.isBusy) { return; }
		const changes = hunk ? [this.requireHunk(hunk)] : this.changes;
		this.rejectionSource ??= this.reference.model.getText();
		this.expectedAgentText = undefined;
		this.agentEditing = this.reviewSaving = true;
		this.changed.fire();
		try {
			try {
				this.reference.model.pushStackElement();
				this.reference.model.applyOperations(changes.map(change => ({ range: change.range, text: change.originalText })));
				this.reference.model.pushStackElement();
			} finally { this.agentEditing = false; }
			// A rejected tool edit must also disappear from the file read by subsequent commands.
			await this.reference.save(new AbortController().signal);
			if (!this.reference.isDirty) { this.rejectionSource = undefined; }
		} finally {
			this.reviewSaving = false;
			this.updateDiff();
		}
		if (!this.isBusy && !this.reviewSuspended && !this.reference.isDirty && this.changes.length === 0) { this.complete(); }
	}

	public async retrySave(): Promise<void> {
		this.assertNotDisposed();
		if (this.isBusy || !this.hasPendingSave) { return; }
		await this.saveReviewedChanges();
		if (!this.isBusy && !this.reviewSuspended && !this.reference.isDirty && this.changes.length === 0) { this.complete(); }
	}

	private async saveReviewedChanges(): Promise<void> {
		this.reviewSaving = true;
		this.changed.fire();
		try {
			await this.reference.save(new AbortController().signal);
			if (!this.reference.isDirty) { this.rejectionSource = undefined; }
		} finally { this.reviewSaving = false; this.changed.fire(); }
	}

	public getAccessibleContent(): string {
		const changes = this.reviewSuspended ? suspendedReviewMessage() : this.changes.map((hunk, index) => localize('chatEditing.accessibleHunk', 'Change {0}, line {1}\nBefore:\n{2}\nAfter:\n{3}', index + 1, hunk.range.startLineNumber, hunk.originalText, hunk.modifiedText)).join('\n\n');
		return this.hasPendingSave ? localize('chatEditing.savePending', 'Rejected changes have not been saved. Retry saving to finish this review.') + (changes ? '\n\n' + changes : '') : changes;
	}

	private assertReviewAvailable(): void {
		if (this.reviewSuspended) { throw new Error(suspendedReviewMessage()); }
	}

	private requireHunk(hunk: IModifiedFileEntryChangeHunk): ReviewHunk {
		const current = this.changes.find(change => change === hunk);
		if (!current) { throw new Error(localize('chatEditing.stale', 'The change has changed. Review it again.')); }
		return current;
	}

	private handleModelChange(event: TextModelChange): void {
		const isAgentEdit = this.agentEditing && (this.expectedAgentText === undefined || this.reference.model.getText() === this.expectedAgentText);
		if (isAgentEdit) { this.agentEditing = false; }
		const needsReconciliation = event.reason === TextModelChangeReason.Undo || event.reason === TextModelChangeReason.Redo
			|| event.reason === TextModelChangeReason.Reset || event.reason === TextModelChangeReason.HistoryCancellation
			|| event.isEolChange || event.detailedReasons.some(reason => reason.metadata.source === 'reloadFromDisk');
		if (this.reviewSuspended || !isAgentEdit && needsReconciliation) {
			this.reconcileModelChange();
		} else {
			// User edits outside Agent hunks update the baseline. Editing an Agent hunk
			// adopts that hunk, so Reject never discards the user's replacement.
			if (!isAgentEdit) this.adoptUserEdits(event.changes.map(change => ({ start: change.rangeOffset, end: change.rangeOffset + change.rangeLength, text: change.text })));
			this.updateDiff();
		}
		if (!this.isBusy && !this.reviewSuspended && !this.hasPendingSave && this.changes.length === 0) { this.complete(); }
	}

	private reconcileModelChange(): void {
		const baseline = normalizeTextLineEndings(this.originalText);
		const previous = normalizeTextLineEndings(this.previousText);
		const current = normalizeTextLineEndings(this.reference.model.getText());
		const next = previous === current || current === baseline ? baseline
			: baseline === previous ? current : this.rebaseExternalEdits(baseline, previous, current);
		this.reviewSuspended = next === undefined;
		if (next !== undefined) this.originalText = next.replaceAll('\n', this.reference.model.getEOL());
		this.updateDiff();
	}

	private rebaseExternalEdits(baseline: string, previous: string, current: string): string | undefined {
		const external = this.computePreciseEdit(previous, current);
		const pending = this.computePreciseEdit(baseline, previous);
		if (!external || !pending) return undefined;
		const inverse = pending.inverse(baseline);
		// An exact reversal removes a pending edit. Any other overlap is ambiguous,
		// so retain the last known baseline until a later edit resolves the conflict.
		const reversals = new Map(inverse.replacements.map(edit => [edit.replaceRange.start, edit]));
		const remaining = new StringEdit(external.replacements.filter(edit => !reversals.get(edit.replaceRange.start)?.equals(edit)));
		return remaining.tryRebase(inverse)?.apply(baseline);
	}

	private computePreciseEdit(original: string, modified: string): StringEdit | undefined {
		const originalLines = original.split('\n');
		const modifiedLines = modified.split('\n');
		const diff = this.computer.computeDiff(originalLines, modifiedLines, {
			ignoreTrimWhitespace: false, computeMoves: false, computeRawChanges: true, maxComputationTimeMs: 50,
		});
		if (diff.hitTimeout) return undefined;
		const originalOffsets = new StringText(original).getTransformer();
		const modifiedOffsets = new StringText(modified).getTransformer();
		const replacements: StringReplacement[] = [];
		const append = (left: number, leftEnd: number, right: number, rightEnd: number): void => {
			const replacement = StringReplacement.replace(new OffsetRange(left, leftEnd), modified.slice(right, rightEnd)).removeCommonSuffixAndPrefix(original);
			if (!replacement.isEmpty) replacements.push(replacement);
		};
		for (const change of diff.changes) {
			let left = originalOffsets.getOffset(new Position(change.original.startLineNumber, 1));
			let right = modifiedOffsets.getOffset(new Position(change.modified.startLineNumber, 1));
			// A new or removed last line owns the separator on the side where it exists.
			if (change.original.startLineNumber > originalLines.length && modified[right - 1] === '\n') right--;
			if (change.modified.startLineNumber > modifiedLines.length && original[left - 1] === '\n') left--;
			for (const mapping of change.innerChanges ?? []) {
				const source = originalOffsets.getOffsetRange(mapping.originalRange);
				const target = modifiedOffsets.getOffsetRange(mapping.modifiedRange);
				append(left, source.start, right, target.start);
				append(source.start, source.endExclusive, target.start, target.endExclusive);
				left = source.endExclusive;
				right = target.endExclusive;
			}
			const leftEnd = originalOffsets.getOffset(new Position(change.original.endLineNumberExclusive, 1));
			const rightEnd = modifiedOffsets.getOffset(new Position(change.modified.endLineNumberExclusive, 1));
			append(left, leftEnd, right, rightEnd);
		}
		const edit = new StringEdit(replacements);
		return edit.apply(original) === modified ? edit : undefined;
	}

	private adoptUserEdits(edits: { start: number; end: number; text: string; }[]): void {
		const groups: { start: number; end: number; edits: typeof edits; }[] = [];
		for (const edit of edits.sort((a, b) => a.start - b.start)) {
			let start = edit.start;
			let end = edit.end;
			for (const hunk of this.changes) {
				const overlaps = hunk.modifiedStart === hunk.modifiedEnd
					? start <= hunk.modifiedStart && end >= hunk.modifiedEnd
					: start === end
						? hunk.modifiedStart <= start && start < hunk.modifiedEnd
						: hunk.modifiedStart < end && hunk.modifiedEnd > start;
				if (overlaps) {
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

	private originalOffset(offset: number, end: boolean): number {
		let delta = 0;
		for (const hunk of this.changes) {
			if (offset < hunk.modifiedStart) { break; }
			if (offset === hunk.modifiedStart) {
				return end && hunk.modifiedStart === hunk.modifiedEnd ? hunk.originalEnd : hunk.originalStart;
			}
			if (offset < hunk.modifiedEnd) { return end ? hunk.originalEnd : hunk.originalStart; }
			delta = hunk.originalEnd - hunk.modifiedEnd;
		}
		return offset + delta;
	}

	private updateDiff(): void {
		if (!this.reviewSuspended) {
			const current = this.reference.model.getText();
			this.changes = this.computeChanges(this.originalText, current);
			this.previousText = current;
		}
		this.changed.fire();
	}

	private computeChanges(original: string, current: string): readonly ReviewHunk[] {
		const originalLines = original.split('\n');
		const modifiedLines = current.split('\n');
		const diff = this.computer.computeDiff(originalLines, modifiedLines, { ignoreTrimWhitespace: false, computeMoves: false, maxComputationTimeMs: 0 });
		return diff.changes.map(change => {
			let originalStart = lineOffset(originalLines, change.original.startLineNumber);
			const originalEnd = lineOffset(originalLines, change.original.endLineNumberExclusive);
			let modifiedStart = lineOffset(modifiedLines, change.modified.startLineNumber);
			const modifiedEnd = lineOffset(modifiedLines, change.modified.endLineNumberExclusive);
			// The final newline belongs to the preceding line when a hunk reaches EOF.
			if (originalStart === original.length || modifiedStart === current.length) {
				if (original[originalStart - 1] === '\n') { originalStart -= original[originalStart - 2] === '\r' ? 2 : 1; }
				if (current[modifiedStart - 1] === '\n') { modifiedStart -= current[modifiedStart - 2] === '\r' ? 2 : 1; }
			}
			const start = this.reference.model.getPositionAt(modifiedStart);
			const end = this.reference.model.getPositionAt(modifiedEnd);
			return { originalStart, originalEnd, modifiedStart, modifiedEnd, range: Range.fromPositions(start, end), originalText: original.slice(originalStart, originalEnd), modifiedText: current.slice(modifiedStart, modifiedEnd) };
		});
	}
}

function suspendedReviewMessage(): string {
	return localize('chatEditing.suspendedReview', 'Agent edit review is paused because the editor could not separate file changes from pending Agent edits. Undo or resolve the conflicting change to resume review.');
}

function lineOffset(lines: readonly string[], line: number): number {
	let offset = 0;
	for (let index = 0; index < Math.min(line - 1, lines.length); index++) { offset += lines[index]!.length + (index < lines.length - 1 ? 1 : 0); }
	return offset;
}
