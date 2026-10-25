import { status as announceStatus } from '../../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../../nls.js';
import { addDisposableListener, isHTMLElement, stopEvent } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { CursorState, SelectionStartKind, SingleCursorState } from '../../../../../editor/common/cursorCommon.js';
import { CursorChangeReason, type ICursorSelectionChangedEvent } from '../../../../../editor/common/cursorEvents.js';
import { PositionAffinity } from '../../../../../editor/common/model.js';
import { TextModelChangeReason } from '../../../../../editor/common/core/textChange.js';
import type { IModelContentChange } from '../../../../../editor/common/model/mirrorTextModel.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import type { IChatInputEditor } from '../widget/input/chatInputEditorRegistry.js';
import { ChatAttachmentModel, type IChatAttachmentChangeEvent } from './chatAttachmentModel.js';

type InlineContext = ChatContextAttachment & { readonly reference: { readonly start: number; readonly end: number; }; };

function sameCapture(a: ChatContextAttachment, b: ChatContextAttachment): boolean {
	return a.id === b.id && a.resolve === b.resolve && a.name === b.name && a.kind === b.kind
		&& a.resource === b.resource && a.terminalSnapshot === b.terminalSnapshot && a.lifetime === b.lifetime;
}

export const dynamicVariableDecorationType = 'chat-dynamic-variable';

/** Binds canonical captures to message positions and text-model undo states. */
export class ChatDynamicVariableModel extends Disposable {
	// Current content lives in the attachment model. This is its immutable positional projection;
	// history retains old projections solely as undo snapshots, never as another current inventory.
	private projected: readonly InlineContext[] = [];
	private updatingAttachments = false;

	private get references(): readonly InlineContext[] { return this.projected; }

	private set references(value: readonly InlineContext[]) {
		const ids = new Set(value.map(entry => entry.id));
		const current = new Map(this.attachments.attachments.map(entry => [entry.id, entry]));
		const deleted = this.projected.filter(entry => entry.lifetime !== 'source' && !ids.has(entry.id)).map(entry => entry.id);
		const entries = value.filter(entry => entry.lifetime !== 'source').map(context => {
			const { reference: _reference, ...entry } = context;
			const previous = current.get(entry.id);
			return previous && sameCapture(previous, entry) ? previous : entry;
		});
		this.projected = value;
		if (!this.updatingAttachments) {
			this.updatingAttachments = true;
			try { this.attachments.updateContext(deleted, entries); }
			finally { this.updatingAttachments = false; }
		}
		const canonical = new Map(this.attachments.attachments.map(entry => [entry.id, entry]));
		this.projected = value.flatMap(context => {
			const entry = canonical.get(context.id);
			if (!entry) return [];
			// Labels describe this text version, including the intermediate edits made while
			// projecting a model transaction. Live sources always retain their current content.
			return [sameCapture(entry, context) ? context : { ...entry, name: context.name, reference: context.reference }];
		});
	}
	private text: string;
	private readonly changes = this._register(new Emitter<void>());
	readonly onDidChangeReferences = this.changes.event;
	private readonly removed = this._register(new Emitter<ChatContextAttachment>());
	readonly onDidRemoveReference = this.removed.event;
	// Alternative model versions identify actual undo states; matching text alone must not attach old code.
	private readonly history = new Map<number, readonly InlineContext[]>();
	private adjustingSelection = false;

	constructor(private readonly input: IChatInputEditor, private readonly attachments: ChatAttachmentModel) {
		super();
		this.text = input.value;
		this._register(attachments.onDidChange(event => this.updateAttachments(event)));
		const model = input.getModel?.();
		if (model) {
			this.remember();
			this._register(model.onDidChangeContent(event => {
				const restored = event.reason === TextModelChangeReason.Undo || event.reason === TextModelChangeReason.Redo ? this.history.get(model.getAlternativeVersionId()) : undefined;
				if (restored) {
					this.references = restored;
					this.text = input.value;
					this.refresh();
				} else {
					this.update(event.changes);
				}
			}));
		} else {
			this._register(input.onDidChange(() => {
				const next = input.value;
				let start = 0;
				while (start < this.text.length && start < next.length && this.text[start] === next[start]) start++;
				let oldEnd = this.text.length;
				let newEnd = next.length;
				while (oldEnd > start && newEnd > start && this.text[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
				this.update([{ range: new Range(1, 1, 1, 1), rangeOffset: start, rangeLength: oldEnd - start, text: next.slice(start, newEnd) }]);
			}));
		}
		this._register(addDisposableListener(input.element, 'keydown', event => this.handleKey(event), true));
		if (input.codeEditor) {
			this._register(input.codeEditor.onDidChangeCursorSelection(event => this.constrainSelections(event)));
		}
		this._register(toDisposable(() => {
			if (!model || !model.isDisposed()) input.renderContextReferences?.([], () => { });
			this.history.clear();
			this.projected = [];
		}));
	}

	get variables(): readonly ChatContextAttachment[] {
		return this.references;
	}

	addReference(context: ChatContextAttachment, focus = true): ChatContextAttachment {
		// Tool configuration is one persistent choice; applying a new selection replaces its visible reference.
		const previous = context.reference ? undefined : context.kind === 'toolSelection' ? this.references.find(entry => entry.kind === 'toolSelection')
			: context.kind === 'file' || context.kind === 'codeSelection' || context.kind === 'image' ? undefined : this.references.find(entry => entry.id === context.id);
		if (previous) {
			this.input.setSelection({ anchor: previous.reference.start, active: previous.reference.end });
			this.references = this.references.filter(entry => entry !== previous);
		}
		let reference = context.reference;
		if (!reference) {
			const selection = this.input.getSelection();
			const start = Math.min(selection.anchor, selection.active);
			const end = Math.max(selection.anchor, selection.active);
			const leading = start > 0 && !/\s/u.test(this.input.value[start - 1]!) ? ' ' : '';
			const trailing = end === this.input.value.length || !/\s/u.test(this.input.value[end]!) ? ' ' : '';
			this.input.insertText(`${leading}${context.name}${trailing}`);
			reference = { start: start + leading.length, end: start + leading.length + context.name.length };
			const cursor = reference.end + trailing.length;
			this.input.setSelection({ anchor: cursor, active: cursor });
		}
		// One file can occur more than once, with a different snapshot at each insertion.
		// User references represent the selected snapshot. Persistence and sending
		// share its acquisition, while failed acquisitions remain explicitly retryable.
		let snapshot: ReturnType<ChatContextAttachment['resolve']> | undefined;
		const resolve = context.lifetime === 'source' ? context.resolve : () => snapshot ??= context.resolve().catch(error => { snapshot = undefined; throw error; });
		const entry = { ...context, resolve, id: this.references.some(entry => entry.id === context.id) ? `${context.id}:${createUuid()}` : context.id, reference };
		this.references = [...this.references, entry].sort((a, b) => a.reference.start - b.reference.start);
		this.refresh();
		if (focus) this.input.focus();
		return this.references.find(reference => reference.id === entry.id)!;
	}

	getInputState(): readonly ChatContextAttachment[] {
		return this.references;
	}

	setInputState(contexts: readonly ChatContextAttachment[]): void {
		this.history.clear();
		this.text = this.input.value;
		this.references = contexts.filter((context): context is InlineContext => context.reference !== undefined);
		for (const source of this.attachments.attachments) {
			if (source.lifetime === 'source' && !this.references.some(reference => reference.id === source.id)) this.addReference(source, false);
		}
		this.refresh();
	}


	private updateAttachments(event: IChatAttachmentChangeEvent): void {
		if (this.updatingAttachments) return;
		// The model has committed the entire transaction. Text events emitted while
		// projecting it must not publish intermediate, older captures back to it.
		this.updatingAttachments = true;
		try {
			for (const id of event.deleted) this.removeReference(id);
			for (const entry of [...event.added, ...event.updated]) {
				const previous = this.references.find(reference => reference.id === entry.id);
				if (!previous) { this.addReference(entry, false); continue; }
				if (previous.name === entry.name) {
					this.projected = this.projected.map(reference => reference.id === entry.id ? { ...entry, reference: reference.reference } : reference);
					this.refresh();
				} else {
					// The source changed its label. Replace only its old text, keeping other bindings
					// under the editor's ordinary edit/undo lifecycle.
					this.projected = this.projected.filter(reference => reference.id !== entry.id);
					this.input.setSelection({ anchor: previous.reference.start, active: previous.reference.end });
					this.input.insertText(entry.name);
					this.addReference({ ...entry, reference: { start: previous.reference.start, end: previous.reference.start + entry.name.length } }, false);
				}
			}
		} finally {
			this.updatingAttachments = false;
		}
	}

	private update(edits: readonly IModelContentChange[]): void {
		if (this.references.length === 0) {
			this.text = this.input.value;
			this.remember();
			return;
		}
		const previous = this.references;
		this.references = this.references.flatMap(context => {
			let { start, end } = context.reference;
			for (const edit of [...edits].sort((a, b) => b.rangeOffset - a.rangeOffset)) {
				const editEnd = edit.rangeOffset + edit.rangeLength;
				if (edit.rangeOffset < end && editEnd > start || edit.rangeLength === 0 && edit.rangeOffset > start && edit.rangeOffset < end) return [];
				if (editEnd <= start) {
					const delta = edit.text.length - edit.rangeLength;
					start += delta;
					end += delta;
				}
			}
			return [{ ...context, reference: { start, end } }];
		});
		this.text = this.input.value;
		this.refresh();
		for (const context of previous) if (!this.references.some(current => current.id === context.id)) this.removed.fire(context);
	}

	removeReference(id: string): void {
		const context = this.references.find(reference => reference.id === id);
		if (!context) return;
		this.input.setSelection({ anchor: context.reference.start, active: context.reference.end });
		this.input.insertText('');
	}

	private refresh(): void {
		this.input.renderContextReferences?.(this.references, id => {
			const context = this.references.find(context => context.id === id);
			const reference = context?.reference;
			if (!reference) return;
			this.input.setSelection({ anchor: reference.start, active: reference.end });
			this.input.insertText('');
			announceStatus(localize('chat.context.removed', 'Removed {0}', context!.name));
			this.input.focus();
		});
		this.constrainSelections();
		this.remember();
		this.changes.fire();
	}

	private constrainSelections(event?: ICursorSelectionChangedEvent): void {
		const model = this.input.getModel?.();
		const viewModel = this.input.codeEditor?._getViewModel();
		// Content events can arrive before reference offsets have followed the edit.
		if (this.adjustingSelection || !model || !viewModel || this.references.length === 0 || this.text !== this.input.value) return;
		let changed = false;
		const states = viewModel.getCursorStates().map((state, index) => {
			const selection = state.modelState.selection;
			let anchor = model.getOffsetAt(selection.getSelectionStart());
			let active = model.getOffsetAt(selection.getPosition());
			const snap = (offset: number, edge: 'start' | 'end' | 'nearest'): number => {
				const reference = this.references.find(context => offset > context.reference.start && offset < context.reference.end)?.reference;
				if (!reference) return offset;
				return edge === 'start' || edge === 'nearest' && offset - reference.start < reference.end - offset ? reference.start : reference.end;
			};
			if (selection.isEmpty()) {
				const previous = event?.oldSelections?.[index];
				const moving = event?.source === 'keyboard' && event.modelVersionId === event.oldModelVersionId && previous;
				const edge = moving ? active < model.getOffsetAt(previous.getPosition()) ? 'start' : 'end' : 'nearest';
				anchor = active = snap(active, edge);
			} else {
				const forward = anchor < active;
				anchor = snap(anchor, forward ? 'start' : 'end');
				active = snap(active, forward ? 'end' : 'start');
			}
			const toView = (offset: number, current: Position): Position => {
				const isEnd = this.references.some(context => context.reference.end === offset);
				const isStart = this.references.some(context => context.reference.start === offset);
				if (!isEnd && !isStart && model.getOffsetAt(viewModel.coordinatesConverter.convertViewPositionToModelPosition(current)) === offset) return current;
				const position = viewModel.coordinatesConverter.convertModelPositionToViewPosition(model.getPositionAt(offset), isEnd ? PositionAffinity.Right : PositionAffinity.Left);
				return viewModel.normalizePosition(position, PositionAffinity.None);
			};
			// Both model boundaries and injected icon/padding boundaries belong outside the reference.
			const viewAnchor = toView(anchor, state.viewState.selection.getSelectionStart());
			const viewActive = toView(active, state.viewState.position);
			const viewSelection = Selection.fromPositions(viewAnchor, viewActive);
			if (state.viewState.selection.equalsSelection(viewSelection)
				&& model.getOffsetAt(selection.getSelectionStart()) === anchor && model.getOffsetAt(selection.getPosition()) === active) return state;
			changed = true;
			return CursorState.fromViewState(new SingleCursorState(Range.fromPositions(viewAnchor), SelectionStartKind.Simple, 0, viewActive, 0));
		});
		if (!changed) return;
		this.adjustingSelection = true;
		try {
			viewModel.setCursorStates('chat-reference', CursorChangeReason.Explicit, states);
		} finally {
			this.adjustingSelection = false;
		}
	}

	private remember(): void {
		const model = this.input.getModel?.();
		if (model) {
			this.history.set(model.getAlternativeVersionId(), this.references);
			// Keep undo metadata bounded alongside a long-lived composer, including obsolete redo branches.
			if (this.history.size > 1000) this.history.delete(this.history.keys().next().value!);
		}
	}

	private handleKey(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
		// A focused attachment control owns its keys; the text caret can still be at another reference.
		if (isHTMLElement(event.target) && event.target.closest('button')) return;
		const selection = this.input.getSelection();
		if (selection.anchor !== selection.active) return;
		const offset = selection.active;
		const reference = this.references.find(context => {
			const { start, end } = context.reference;
			return event.key === 'Backspace' || event.key === 'ArrowLeft' ? offset > start && offset <= end : offset >= start && offset < end;
		})?.reference;
		if (!reference) return;
		if (event.key === 'Backspace' || event.key === 'Delete') {
			stopEvent(event);
			this.input.setSelection({ anchor: reference.start, active: reference.end });
			this.input.insertText('');
		} else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
			stopEvent(event);
			const target = event.key === 'ArrowLeft' ? reference.start : reference.end;
			this.input.setSelection({ anchor: target, active: target });
		}
	}
}
