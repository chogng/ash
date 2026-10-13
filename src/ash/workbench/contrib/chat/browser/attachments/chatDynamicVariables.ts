import { status as announceStatus } from '../../../../../base/browser/ui/aria/aria.js';
import { localize } from '../../../../../nls.js';
import { addDisposableListener, stopEvent } from '../../../../../base/browser/dom.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { TextModelChangeReason } from '../../../../../editor/common/core/textChange.js';
import { InjectedTextCursorStops, TrackedRangeStickiness } from '../../../../../editor/common/model.js';
import type { IModelContentChange } from '../../../../../editor/common/model/mirrorTextModel.js';
import type { ChatContextAttachment } from '../../../../services/chat/common/chatContextService.js';
import type { IChatInputEditor } from '../widget/input/chatInputEditorRegistry.js';

type InlineContext = ChatContextAttachment & { readonly reference: { readonly start: number; readonly end: number; }; };

/** Owns context snapshots bound to references in the message text. */
export class ChatDynamicVariableModel extends Disposable {
	private references: readonly InlineContext[] = [];
	private text: string;
	private decorations: string[] = [];
	private readonly changes = this._register(new Emitter<void>());
	readonly onDidChangeReferences = this.changes.event;
	private readonly removed = this._register(new Emitter<ChatContextAttachment>());
	readonly onDidRemoveReference = this.removed.event;
	// Alternative model versions identify actual undo states; matching text alone must not attach old code.
	private readonly history = new Map<number, readonly InlineContext[]>();

	constructor(private readonly input: IChatInputEditor) {
		super();
		this.text = input.value;
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
		this._register(toDisposable(() => {
			if (model && !model.isDisposed()) model.deltaDecorations(this.decorations, []);
			this.history.clear();
		}));
	}

	get variables(): readonly ChatContextAttachment[] {
		return this.references;
	}

	addReference(context: ChatContextAttachment, focus = true): ChatContextAttachment {
		// Tool configuration is one persistent choice; applying a new selection replaces its visible reference.
		const previous = context.kind === 'toolSelection' ? this.references.find(entry => entry.kind === 'toolSelection')
			: context.kind === 'file' || context.kind === 'codeSelection' || context.kind === 'image' ? undefined : this.references.find(entry => entry.id === context.id);
		if (previous) {
			this.input.setSelection({ anchor: previous.reference.start, active: previous.reference.end });
			this.references = this.references.filter(entry => entry !== previous);
		}
		const selection = this.input.getSelection();
		const start = Math.min(selection.anchor, selection.active);
		const end = Math.max(selection.anchor, selection.active);
		const leading = start > 0 && !/\s/u.test(this.input.value[start - 1]!) ? ' ' : '';
		const trailing = end === this.input.value.length || !/\s/u.test(this.input.value[end]!) ? ' ' : '';
		this.input.insertText(`${leading}${context.name}${trailing}`);
		const reference = { start: start + leading.length, end: start + leading.length + context.name.length };
		const cursor = reference.end + trailing.length;
		this.input.setSelection({ anchor: cursor, active: cursor });
		// One file can occur more than once, with a different snapshot at each insertion.
		const entry = { ...context, id: this.references.some(entry => entry.id === context.id) ? `${context.id}:${createUuid()}` : context.id, reference };
		this.references = [...this.references, entry].sort((a, b) => a.reference.start - b.reference.start);
		this.refresh();
		if (focus) this.input.focus();
		return entry;
	}

	setInputState(contexts: readonly ChatContextAttachment[]): void {
		this.history.clear();
		this.text = this.input.value;
		this.references = contexts.filter((context): context is InlineContext => context.reference !== undefined);
		this.refresh();
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
		const model = this.input.getModel?.();
		if (model) {
			this.decorations = model.deltaDecorations(this.decorations, this.references.map(context => ({
				range: Range.fromPositions(model.getPositionAt(context.reference.start), model.getPositionAt(context.reference.end)),
				options: {
					description: 'chat-context-reference',
					inlineClassName: context.kind === 'image' ? 'ash-chat-image-reference' : context.kind === 'file' || context.kind === 'codeSelection' ? 'ash-chat-code-reference' : 'ash-chat-context-reference',
					stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
					...(context.kind === 'image' ? {
						before: { content: '\uFFFC', widthInEm: 2, inlineClassName: 'ash-chat-image-reference-space', cursorStops: InjectedTextCursorStops.None },
						after: { content: '\uFFFC', widthInEm: 2, inlineClassName: 'ash-chat-image-reference-space', cursorStops: InjectedTextCursorStops.None },
					} : context.kind === 'file' || context.kind === 'codeSelection' ? {} : {
						...(context.resource || context.terminalSnapshot ? { before: { content: '\uFFFC', widthInEm: 2, inlineClassName: 'ash-chat-context-reference-space', cursorStops: InjectedTextCursorStops.None } } : {}),
						after: { content: '\uFFFC', widthInEm: 2, inlineClassName: 'ash-chat-context-reference-space', cursorStops: InjectedTextCursorStops.None },
					}),
				},
			})));
		}
		this.input.renderContextReferences?.(this.references.filter(context => context.kind !== 'file' && context.kind !== 'codeSelection'), id => {
			const context = this.references.find(context => context.id === id);
			const reference = context?.reference;
			if (!reference) return;
			this.input.setSelection({ anchor: reference.start, active: reference.end });
			this.input.insertText('');
			announceStatus(localize('chat.context.removed', 'Removed {0}', context!.name));
			this.input.focus();
		});
		this.remember();
		this.changes.fire();
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
