import './accessibleDiffViewer.css';
import { addDisposableListener, h, isHTMLElement, stopEvent } from '../../../../../base/browser/dom.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, onDidChangeNls } from '../../../../../nls.js';
import { type DiffModel } from '../../../../common/diff/diffModel.js';
import { LineDiffKind, type LineDiff, type LineDiffHunk, type LineDiffRow } from '../../../../common/diff/lineDiff.js';

/** Reads one changed hunk at a time from the current versioned comparison. */
export class AccessibleDiffViewer extends Disposable {
	public readonly domNode: HTMLDivElement;
	private readonly summaryDomNode: HTMLSpanElement;
	private readonly contentDomNode: HTMLTextAreaElement;
	private readonly previousDomNode: HTMLButtonElement;
	private readonly nextDomNode: HTMLButtonElement;
	private readonly closeDomNode: HTMLButtonElement;
	private currentRow = -1;
	private previousFocus: HTMLElement | undefined;

	constructor(
		container: HTMLElement,
		private readonly model: DiffModel,
		private readonly getDiff: () => LineDiff | undefined,
		private readonly navigate: (direction: -1 | 1) => number | undefined,
		private readonly setVisible: (visible: boolean) => void,
		private readonly restoreEditorFocus: () => void,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div');
		this.domNode.className = 'stanza-accessible-diff-viewer';
		this.domNode.hidden = true;
		this.domNode.setAttribute('role', 'region');
		const toolbar = h(document, 'div');
		toolbar.className = 'stanza-accessible-diff-toolbar';
		this.summaryDomNode = h(document, 'span');
		this.summaryDomNode.setAttribute('role', 'status');
		this.summaryDomNode.setAttribute('aria-live', 'polite');
		this.previousDomNode = h(document, 'button');
		this.previousDomNode.type = 'button';
		this.nextDomNode = h(document, 'button');
		this.nextDomNode.type = 'button';
		this.closeDomNode = h(document, 'button');
		this.closeDomNode.type = 'button';
		toolbar.append(this.summaryDomNode, this.previousDomNode, this.nextDomNode, this.closeDomNode);
		this.contentDomNode = h(document, 'textarea');
		this.contentDomNode.className = 'stanza-accessible-diff-content';
		this.contentDomNode.readOnly = true;
		this.domNode.append(toolbar, this.contentDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(addDisposableListener(this.previousDomNode, 'click', () => this.previous()));
		this._register(addDisposableListener(this.nextDomNode, 'click', () => this.next()));
		this._register(addDisposableListener(this.closeDomNode, 'click', () => this.close()));
		this._register(addDisposableListener(this.domNode, 'keydown', event => {
			if (event.key !== 'Escape') return;
			stopEvent(event);
			this.close();
		}));
		this._register(model.onDidChange(() => { if (!this.domNode.hidden) this.close(); }));
		this._register(onDidChangeNls(() => this.render()));
		this.render();
	}

	public get isVisible(): boolean {
		return !this.domNode.hidden;
	}

	public next(): void {
		this.move(1);
	}

	public previous(): void {
		this.move(-1);
	}

	public close(): void {
		if (this.domNode.hidden) return;
		this.domNode.hidden = true;
		this.setVisible(false);
		const previousFocus = this.previousFocus;
		this.previousFocus = undefined;
		if (previousFocus?.isConnected) previousFocus.focus();
		else this.restoreEditorFocus();
	}

	public getAccessibleContent(): string {
		const state = this.model.state;
		if (state.kind === 'loading') return localize('diffEditor.computing', 'Computing differences');
		if (state.kind === 'error') return localize('diffEditor.error', 'Could not compute differences: {0}', state.error.message);
		const diff = this.getDiff()!;
		const content = diff.hunks.map((hunk, index) => this.hunkContent(hunk, index, diff.hunks.length));
		if (content.length === 0) {
			content.push(localize('diffEditor.noChanges', 'No differences'));
		}
		for (const move of diff.moves) {
			const mapping = move.lineRangeMapping;
			content.push(localize('diffEditor.movedLines', 'Moved original lines {0}–{1} to modified lines {2}–{3}',
				mapping.original.startLineNumber, mapping.original.endLineNumberExclusive - 1,
				mapping.modified.startLineNumber, mapping.modified.endLineNumberExclusive - 1));
		}
		return content.join('\n\n');
	}

	private move(direction: -1 | 1): void {
		const focused = this.domNode.ownerDocument.activeElement;
		const rowIndex = this.navigate(direction);
		if (rowIndex === undefined) return;
		if (this.domNode.hidden) {
			this.previousFocus = isHTMLElement(focused) ? focused : undefined;
			this.domNode.hidden = false;
			this.setVisible(true);
		}
		this.currentRow = rowIndex;
		this.render();
		this.contentDomNode.focus();
		this.contentDomNode.setSelectionRange(0, 0);
	}

	private render(): void {
		this.domNode.setAttribute('aria-label', localize('diffEditor.accessibleViewer.title', 'Accessible Diff Viewer'));
		this.contentDomNode.setAttribute('aria-label', localize('diffEditor.accessibleViewer.content', 'Difference content'));
		this.previousDomNode.textContent = localize('diffEditor.accessibleViewer.previous', 'Previous difference');
		this.nextDomNode.textContent = localize('diffEditor.accessibleViewer.next', 'Next difference');
		this.closeDomNode.textContent = localize('diffEditor.accessibleViewer.close', 'Close');
		const diff = this.getDiff();
		const changedRows = diff?.rows.flatMap((row, index) => row.kind === LineDiffKind.Unchanged ? [] : [index]) ?? [];
		if (!diff || changedRows.length === 0) {
			this.currentRow = -1;
			this.summaryDomNode.textContent = this.getAccessibleContent();
			this.contentDomNode.value = this.getAccessibleContent();
			this.previousDomNode.disabled = true;
			this.nextDomNode.disabled = true;
			return;
		}
		const position = Math.max(0, changedRows.indexOf(this.currentRow));
		this.summaryDomNode.textContent = localize('diffEditor.accessibleViewer.position', 'Difference {0} of {1}', position + 1, changedRows.length);
		this.contentDomNode.value = this.rowContent(diff.rows[changedRows[position]!]!).join('\n');
		this.previousDomNode.disabled = false;
		this.nextDomNode.disabled = false;
	}

	private hunkContent(hunk: LineDiffHunk, index: number, count: number): string {
		const rows = this.getDiff()!.rows.slice(hunk.rowStart, hunk.rowEnd);
		const lines = rows.flatMap(row => this.rowContent(row));
		return [localize('diffEditor.accessibleViewer.position', 'Difference {0} of {1}', index + 1, count), ...lines].join('\n');
	}

	private rowContent(row: LineDiffRow): string[] {
		const lines: string[] = [];
		if (row.originalLineIndex !== undefined) {
			lines.push(localize('diffEditor.accessibleViewer.removedLine', 'Original line {0}: {1}', row.originalLineIndex + 1, this.model.original.getLineContent(row.originalLineIndex + 1)));
		}
		if (row.modifiedLineIndex !== undefined) {
			lines.push(localize('diffEditor.accessibleViewer.addedLine', 'Modified line {0}: {1}', row.modifiedLineIndex + 1, this.model.modified.getLineContent(row.modifiedLineIndex + 1)));
		}
		return lines;
	}
}
