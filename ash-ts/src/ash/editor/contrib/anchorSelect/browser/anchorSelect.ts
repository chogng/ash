import './anchorSelect.css';
import { addDisposableListener, stopEvent } from '../../../../base/browser/dom.js';
import { disposableWindowTimeout } from '../../../../base/browser/scheduler.js';
import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { type ICodeEditor } from '../../../browser/editorBrowser.js';
import { type EditorCapability, registerEditorContribution } from '../../../browser/editorExtensions.js';
import { type View } from '../../../browser/view.js';
import { Selection } from '../../../common/core/selection.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { TextDecorationCollection, type TextDecorationId } from '../../../common/model/decorationCollection.js';
import { TrackedRangeStickiness } from '../../../common/model.js';


const selectionAnchorDecorations: EditorCapability<TextDecorationCollection<void>> = Object.freeze({ id: 'editor.capability.selectionAnchorDecorations' });

/** Owns one editor-local selection anchor and its commands. */
export class SelectionAnchorController extends Disposable {
	private readonly chordTimeout = this._register(new MutableDisposable<IDisposable>());
	private decorationId: TextDecorationId | undefined;
	private awaitingChord = false;

	constructor(
		input: HTMLElement,
		private readonly editor: ICodeEditor,
		private readonly viewport: View,
		private readonly decorations: TextDecorationCollection<void>,
	) {
		super();
		try {
			if (viewport.textModel !== editor.getModel() || viewport.textModel !== decorations.textModel) {
				throw new TypeError('Selection anchor dependencies must share one text model');
			}
			this._register(addDisposableListener(input, 'keydown', event => this.handleKeydown(event), true));
			this._register(toDisposable(() => this.cancelSelectionAnchor()));
		} catch (error) {
			this.dispose();
			throw error;
		}
	}

	get selectionAnchorSet(): boolean {
		return this.decorationId !== undefined;
	}

	setSelectionAnchor(): void {
		const position = Position.lift(this.editor.getPosition()!);
		const [decorationId] = this.decorations.replaceAll([{
			range: Range.fromPositions(position),
			stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
			options: {
				description: 'selection-anchor',
				className: 'selection-anchor',
				hoverMessage: { value: 'Selection Anchor' },
			},
			metadata: undefined,
		}]);
		this.decorationId = decorationId;
		this.viewport.announceAccessibilityStatus(`Anchor set at ${position.lineNumber}:${position.column}`);
	}

	goToSelectionAnchor(): void {
		const position = this.selectionAnchorPosition;
		if (!position) return;
		this.editor.setSelection(Selection.fromPositions(position), 'selectionAnchor');
		this.viewport.revealPosition(position);
	}

	selectFromAnchorToCursor(): void {
		const anchor = this.selectionAnchorPosition;
		if (!anchor) return;
		const cursor = Position.lift(this.editor.getPosition()!);
		this.editor.setSelection(Selection.fromPositions(anchor, cursor), 'selectionAnchor');
		this.cancelSelectionAnchor();
		this.viewport.revealPosition(cursor);
	}

	cancelSelectionAnchor(): void {
		if (this.decorationId === undefined) return;
		this.decorations.delete(this.decorationId);
		this.decorationId = undefined;
	}

	private get selectionAnchorPosition(): Position | undefined {
		if (this.decorationId === undefined) return undefined;
		return this.decorations.get(this.decorationId)?.range.getStartPosition();
	}

	private handleKeydown(event: KeyboardEvent): void {
		if (event.isComposing || event.getModifierState('AltGraph')) return;
		if (this.awaitingChord) {
			this.clearPendingChord();
			if (!isPrimaryChord(event)) return;
			const key = event.key.toLowerCase();
			if (key === 'b') {
				stopEvent(event, { immediate: true });
				this.setSelectionAnchor();
			} else if (key === 'k' && this.selectionAnchorSet) {
				stopEvent(event, { immediate: true });
				this.selectFromAnchorToCursor();
			}
			return;
		}
		if (!event.defaultPrevented && isPrimaryChord(event) && event.key.toLowerCase() === 'k') {
			this.awaitingChord = true;
			const targetWindow = event.view ?? (event.currentTarget instanceof HTMLElement ? event.currentTarget.ownerDocument.defaultView : undefined);
			if (targetWindow) this.chordTimeout.value = disposableWindowTimeout(targetWindow, () => this.clearPendingChord(), 5_000);
			return;
		}
		if (!event.defaultPrevented && event.key === 'Escape' && this.selectionAnchorSet) {
			stopEvent(event, { immediate: true });
			this.cancelSelectionAnchor();
		}
	}

	private clearPendingChord(): void {
		this.awaitingChord = false;
		this.chordTimeout.clear();
	}
}

registerEditorContribution({
	id: 'editor.contrib.selectionAnchorController',
	configure: context => {
		const decorations = context.register(new TextDecorationCollection<void>(context.model));
		context.provideCapability(selectionAnchorDecorations, decorations);
	},
	install: context => {
		if (context.kind !== 'text') return;
		context.register(new SelectionAnchorController(context.controller.element, context.editor, context.view, context.getCapability(selectionAnchorDecorations)));
	},
});

function isPrimaryChord(event: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>): boolean {
	return (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
}
