import { type Event, Emitter } from '../../base/common/event.js';
import { Disposable, DisposableStore, toDisposable, type IDisposable } from '../../base/common/lifecycle.js';
import {
	autorun,
	constObservable,
	derived,
	isObservable,
	transaction,
	type IObservable,
	type IReader,
	type ISettableObservable,
	type ITransaction,
} from '../../base/common/observable.js';
import { type IPosition, Position } from '../common/core/position.js';
import { Point } from '../common/core/2d/point.js';
import { LineRange } from '../common/core/ranges/lineRange.js';
import { Selection } from '../common/core/selection.js';
import { EditorOption, type EditorLayoutInfo, type FindComputedEditorOptionValueById } from '../common/config/editorOptions.js';
import { type IModelDeltaDecoration, type ITextModel } from '../common/model.js';
import { type IClipboardPasteEvent } from './controller/editContext/clipboardUtils.js';
import { type ICodeEditor, type IContentWidget, type IContentWidgetPosition, type IEditorMouseEvent, type IOverlayWidget, type IOverlayWidgetPosition } from './editorBrowser.js';
import { OffsetRange } from '../common/core/ranges/offsetRange.js';

/** Returns the observable facade for one canonical Stanza code editor widget. */
export function observableCodeEditor(editor: ICodeEditor): ObservableCodeEditor {
	return ObservableCodeEditor.get(editor);
}

/**
 * Observable state exposed by a {@link CodeEditorWidget}.
 *
 * The facade observes the widget's existing model, selection controller,
 * EditContext, and viewport. It does not create a second text model, scroll
 * owner, or DOM projection.
 */
export class ObservableCodeEditor extends Disposable {
	private static readonly _map = new Map<ICodeEditor, ObservableCodeEditor>();
	private readonly modelState: ObservableState<ITextModel | null>;
	private readonly versionState: ObservableState<number | null>;
	private readonly selectionsState: ObservableState<readonly Selection[] | null>;
	private readonly focusState: ObservableState<boolean>;
	private readonly textFocusState: ObservableState<boolean>;
	private readonly compositionState: ObservableState<boolean>;
	private readonly layoutState: ObservableState<EditorLayoutInfo>;
	private readonly typeChannel: ObservableChannel<string>;
	private readonly pasteChannel: ObservableChannel<IClipboardPasteEvent | undefined>;
	private currentTransaction: ITransaction | undefined;

	public readonly editor: ICodeEditor;
	public readonly model: IObservable<ITextModel | null>;
	public readonly isReadonly: IObservable<boolean>;
	public readonly versionId: IObservable<number | null>;
	public readonly selections: IObservable<readonly Selection[] | null>;
	public readonly positions: IObservable<readonly Position[] | null>;
	public readonly isFocused: IObservable<boolean>;
	public readonly isTextFocused: IObservable<boolean>;
	public readonly inComposition: IObservable<boolean>;
	public readonly value: ISettableObservable<string>;
	public readonly valueIsEmpty: IObservable<boolean>;
	public readonly cursorSelection: IObservable<Selection | null>;
	public readonly cursorPosition: IObservable<Position | null>;
	/** The primary cursor's zero-based line index. */
	public readonly cursorLineIndex: IObservable<number | null>;
	/** The primary cursor's one-based line number. */
	public readonly cursorLineNumber: IObservable<number | null>;
	public readonly onDidType: IObservable<string>;
	/** The latest normalized paste event; Ash exposes it at the EditContext boundary. */
	public readonly onDidPaste: IObservable<IClipboardPasteEvent | undefined>;
	public readonly layoutInfo: IObservable<EditorLayoutInfo>;
	public readonly layoutInfoContentLeft: IObservable<number>;
	public readonly layoutInfoDecorationsLeft: IObservable<number>;
	public readonly layoutInfoWidth: IObservable<number>;
	public readonly layoutInfoHeight: IObservable<number>;
	public readonly layoutInfoMinimap: IObservable<EditorLayoutInfo['minimap']>;
	public readonly layoutInfoVerticalScrollbarWidth: IObservable<number>;
	public readonly scrollTop: IObservable<number>;
	public readonly scrollLeft: IObservable<number>;
	public readonly contentWidth: IObservable<number>;
	public readonly contentHeight: IObservable<number>;
	public readonly domNode: IObservable<HTMLElement | null>;
	public readonly openedPeekWidgets: ISettableObservable<number>;
	private widgetCounter = 0;

	public static get(editor: ICodeEditor): ObservableCodeEditor {
		const existing = ObservableCodeEditor._map.get(editor);
		if (existing) return existing;
		const result = new ObservableCodeEditor(editor);
		ObservableCodeEditor._map.set(editor, result);
		return result;
	}

	private constructor(editor: ICodeEditor) {
		super();
		this.editor = editor;
		this._register(toDisposable(() => {
			if (ObservableCodeEditor._map.get(editor) === this) ObservableCodeEditor._map.delete(editor);
		}));

		const model = editor.getModel();
		this.modelState = this._register(new ObservableState(model));
		this.versionState = this._register(new ObservableState(model?.getVersionId() ?? null));
		this.selectionsState = this._register(new ObservableState<readonly Selection[] | null>(editor.getSelections()));
		this.focusState = this._register(new ObservableState(editor.hasWidgetFocus()));
		this.textFocusState = this._register(new ObservableState(editor.hasTextFocus()));
		this.compositionState = this._register(new ObservableState(editor.inComposition));
		this.layoutState = this._register(new ObservableState(editor.getLayoutInfo()));
		this.typeChannel = this._register(new ObservableChannel(''));
		this.pasteChannel = this._register(new ObservableChannel<IClipboardPasteEvent | undefined>(undefined));

		this.model = this.modelState;
		this.isReadonly = constObservable(editor.getOption(EditorOption.readOnly));
		this.versionId = this.versionState;
		this.selections = this.selectionsState;
		this.positions = derived(reader => Object.freeze(
			this.selections.read(reader)?.map(selection => selection.getSelectionStart()) ?? null,
		));
		this.isFocused = this.focusState;
		this.isTextFocused = this.textFocusState;
		this.inComposition = this.compositionState;

		const valueSource = derived(reader => {
			this.versionId.read(reader);
			return this.model.read(reader)?.getValue() ?? '';
		});
		this.value = this._register(new SettableDerivedObservable(valueSource, (value, suppliedTransaction) => {
			const update = (): void => {
				const currentModel = this.modelState.get();
				if (currentModel && currentModel.getValue() !== value) currentModel.setValue(value);
			};
			if (suppliedTransaction && suppliedTransaction === this.currentTransaction) update();
			else this.runInTransaction(() => update());
		}));
		this.valueIsEmpty = derived(reader => {
			this.versionId.read(reader);
			return (this.model.read(reader)?.getValueLength() ?? 0) === 0;
		});
		this.cursorSelection = derived(reader => this.selections.read(reader)?.[0] ?? null);
		this.cursorPosition = derived(reader => this.cursorSelection.read(reader)?.getPosition() ?? null);
		this.cursorLineIndex = derived(reader => {
			const position = this.cursorPosition.read(reader);
			return position ? position.lineNumber - 1 : null;
		});
		this.cursorLineNumber = derived(reader => {
			const lineIndex = this.cursorLineIndex.read(reader);
			return lineIndex === null ? null : lineIndex + 1;
		});

		this.onDidType = this.typeChannel;
		this.onDidPaste = this.pasteChannel;
		this.layoutInfo = this.layoutState;
		this.layoutInfoContentLeft = derived(reader => {
			this.layoutInfo.read(reader);
			this.value.read(reader);
			return editor.getLayoutInfo().contentLeft;
		});
		this.layoutInfoDecorationsLeft = this.layoutInfoContentLeft;
		this.layoutInfoWidth = this.layoutInfo.map(layout => layout.width);
		this.layoutInfoHeight = this.layoutInfo.map(layout => layout.height);
		this.layoutInfoMinimap = this.layoutInfo.map(layout => layout.minimap);
		this.layoutInfoVerticalScrollbarWidth = this.layoutInfo.map(layout => layout.verticalScrollbarWidth);
		this.scrollTop = this.layoutInfo.map(() => editor.getScrollTop());
		this.scrollLeft = this.layoutInfo.map(() => editor.getScrollLeft());
		this.contentWidth = this.layoutInfo.map(() => editor.getContentWidth());
		this.contentHeight = this.layoutInfo.map(() => editor.getContentHeight());
		this.domNode = derived(reader => {
			this.model.read(reader);
			return editor.getDomNode();
		});
		this.openedPeekWidgets = this._register(new ObservableState(0));

		this._register(editor.onDidChangeModelContent(() => this.runInTransaction(transaction => this.synchronizeState(transaction))));
		this._register(editor.onDidChangeModel(() => {
			this.runInTransaction(transaction => this.synchronizeState(transaction, true));
		}));
		this._register(editor.onDidChangeCursorSelection(() => this.runInTransaction(transaction => this.synchronizeState(transaction))));
		this._register(editor.onDidLayoutChange(layout => this.runInTransaction(transaction => {
			this.layoutState.set(layout, transaction);
		})));
		this._register(editor.onDidType(text => this.runInTransaction(transaction => {
			this.synchronizeState(transaction);
			this.typeChannel.emit(text, transaction);
		})));
		this._register(editor.onDidPaste(event => this.runInTransaction(transaction => {
			this.pasteChannel.emit(event, transaction);
		})));
		this._register(editor.onDidCompositionStart(() => this.runInTransaction(transaction => this.compositionState.set(true, transaction))));
		this._register(editor.onDidCompositionEnd(() => this.runInTransaction(transaction => this.compositionState.set(false, transaction))));
		this._register(editor.onDidFocusEditorText(() => this.refreshFocusState()));
		this._register(editor.onDidBlurEditorText(() => this.refreshFocusState()));
		this._register(editor.onDidFocusEditorWidget(() => this.refreshFocusState()));
		this._register(editor.onDidBlurEditorWidget(() => this.refreshFocusState()));
		this._register(editor.onDidDispose(() => this.dispose()));
	}

	/** Batches state notifications caused by synchronous editor work. */
	public transaction<T>(callback: (transaction: ITransaction) => T): T {
		return this.runInTransaction(callback);
	}

	/** Re-reads model, selection, composition, and layout state immediately. */
	public forceUpdate(): void;
	public forceUpdate<T>(callback: (transaction: ITransaction) => T): T;
	public forceUpdate<T>(callback?: (transaction: ITransaction) => T): T | undefined {
		return this.runInTransaction(transaction => {
			this.synchronizeState(transaction, true);
			return callback ? callback(transaction) : undefined;
		});
	}

	public getOption<T extends EditorOption>(id: T): IObservable<FindComputedEditorOptionValueById<T>> {
		return derived(reader => {
			this.layoutInfo.read(reader);
			return this.editor.getOption(id);
		});
	}

	public setDecorations(decorations: IObservable<IModelDeltaDecoration[]>): IDisposable {
		const store = new DisposableStore();
		const collection = this.editor.createDecorationsCollection();
		store.add(autorun(reader => {
			this.model.read(reader);
			collection.set(decorations.read(reader));
		}));
		store.add(toDisposable(() => collection.clear()));
		return store;
	}

	public createOverlayWidget(widget: IObservableOverlayWidget): IDisposable {
		const id = `observableOverlayWidget${this.widgetCounter++}`;
		const editorWidget: IOverlayWidget = {
			getId: () => id,
			getDomNode: () => widget.domNode,
			getPosition: () => widget.position.get(),
			allowEditorOverflow: widget.allowEditorOverflow,
			getMinContentWidthInPx: () => widget.minContentWidthInPx.get(),
		};
		this.editor.addOverlayWidget(editorWidget);
		const layout = autorun(reader => {
			widget.position.read(reader);
			widget.minContentWidthInPx.read(reader);
			this.editor.layoutOverlayWidget(editorWidget);
		});
		return toDisposable(() => {
			layout.dispose();
			this.editor.removeOverlayWidget(editorWidget);
		});
	}

	public createContentWidget(widget: IObservableContentWidget): IDisposable {
		const id = `observableContentWidget${this.widgetCounter++}`;
		const editorWidget: IContentWidget = {
			getId: () => id,
			getDomNode: () => widget.domNode,
			getPosition: () => widget.position.get(),
			allowEditorOverflow: widget.allowEditorOverflow,
		};
		this.editor.addContentWidget(editorWidget);
		const layout = autorun(reader => {
			widget.position.read(reader);
			this.editor.layoutContentWidget(editorWidget);
		});
		return toDisposable(() => {
			layout.dispose();
			this.editor.removeContentWidget(editorWidget);
		});
	}

	public observeLineOffsetRange(lineRange: IObservable<LineRange>, _store: DisposableStore): IObservable<OffsetRange> {
		return derived(reader => {
			this.layoutInfo.read(reader);
			const range = lineRange.read(reader);
			const start = this.editor.getTopForLineNumber(range.startLineNumber) - this.editor.getScrollTop();
			const end = range.isEmpty ? start : this.editor.getBottomForLineNumber(range.endLineNumberExclusive - 1) - this.editor.getScrollTop();
			return new OffsetRange(start, end);
		});
	}

	public isTargetHovered(predicate: (target: IEditorMouseEvent) => boolean, store: DisposableStore): IObservable<boolean> {
		const hovered = store.add(new ObservableState(false));
		store.add(this.editor.onMouseMove(event => hovered.set(predicate(event))));
		store.add(this.editor.onMouseLeave(() => hovered.set(false)));
		return hovered;
	}

	/** Returns the model-relative x offset of a position from the text origin. */
	public getLeftOfPosition(position: IPosition, reader: IReader | undefined = undefined): number {
		this.layoutInfo.read(reader);
		this.value.read(reader);
		const visible = this.editor.getScrolledVisiblePosition(Position.lift(position));
		return visible ? visible.left + this.editor.getScrollLeft() - this.editor.getLayoutInfo().contentLeft : 0;
	}

	/** Observes a position in viewport coordinates, including scroll changes. */
	public observePosition(position: IObservable<IPosition | null>): IObservable<Point | null> {
		return derived(reader => {
			const currentPosition = position.read(reader);
			if (currentPosition === null) return null;
			this.layoutInfo.read(reader);
			const model = this.model.read(reader);
			const liftedPosition = Position.lift(currentPosition);
			model?.validatePosition(liftedPosition);
			const visible = this.editor.getScrolledVisiblePosition(liftedPosition);
			return visible ? new Point(visible.left, visible.top) : null;
		});
	}

	public observeLineHeightForPosition(position: IObservable<IPosition | null>): IObservable<number | null>;
	public observeLineHeightForPosition(position: IPosition): IObservable<number>;
	public observeLineHeightForPosition(position: IObservable<IPosition | null> | IPosition): IObservable<number | null> {
		return derived(reader => {
			const currentPosition = readValue(position, reader);
			if (currentPosition === null) return null;
			const model = this.model.read(reader);
			model?.validatePosition(Position.lift(currentPosition));
			this.layoutInfo.read(reader);
			return this.editor.getOption(EditorOption.lineHeight);
		});
	}

	public observeLineHeightForLine(lineNumber: IObservable<number | null>): IObservable<number | null>;
	public observeLineHeightForLine(lineNumber: number): IObservable<number>;
	public observeLineHeightForLine(lineNumber: IObservable<number | null> | number): IObservable<number | null> {
		return derived(reader => {
			const currentLineNumber = readValue(lineNumber, reader);
			if (currentLineNumber === null) return null;
			return this.readLineHeight(currentLineNumber, reader);
		});
	}

	public observeLineHeightsForLineRange(lineRange: IObservable<LineRange> | LineRange): IObservable<readonly number[]> {
		return derived(reader => {
			const currentLineRange = readValue(lineRange, reader);
			return currentLineRange.mapToLineArray(lineNumber => this.readLineHeight(lineNumber, reader));
		});
	}

	public getWidthOfLine(lineNumber: number, reader: IReader | undefined = undefined): number {
		this.layoutInfo.read(reader);
		this.value.read(reader);
		const model = this.model.read(reader);
		if (!model) return 0;
		validateLineNumber(model, lineNumber);
		return this.editor.getWidthOfLine(lineNumber);
	}

	public observeTopForLineNumber(lineNumber: number): IObservable<number> {
		return derived(reader => {
			this.layoutInfo.read(reader);
			const model = this.model.read(reader);
			return this.readLineTop(model, lineNumber);
		});
	}

	public observeBottomForLineNumber(lineNumber: number): IObservable<number> {
		return derived(reader => {
			this.layoutInfo.read(reader);
			const model = this.model.read(reader);
			return this.readLineBottom(model, lineNumber);
		});
	}

	private runInTransaction<T>(callback: (transaction: ITransaction) => T): T {
		if (this.currentTransaction) return callback(this.currentTransaction);
		return transaction(activeTransaction => {
			this.currentTransaction = activeTransaction;
			try {
				return callback(activeTransaction);
			} finally {
				this.currentTransaction = undefined;
			}
		});
	}

	private synchronizeState(transaction: ITransaction, force = false): void {
		const model = this.editor.getModel();
		this.modelState.update(model, transaction, force);
		this.versionState.update(model?.getVersionId() ?? null, transaction, force);
		this.selectionsState.update(this.editor.getSelections(), transaction, force);
		this.layoutState.update(this.editor.getLayoutInfo(), transaction, force);
		this.focusState.update(this.editor.hasWidgetFocus(), transaction, force);
		this.textFocusState.update(this.editor.hasTextFocus(), transaction, force);
		this.compositionState.update(this.editor.inComposition, transaction, force);
	}

	private refreshFocusState(): void {
		this.runInTransaction(transaction => {
			this.focusState.set(this.editor.hasWidgetFocus(), transaction);
			this.textFocusState.set(this.editor.hasTextFocus(), transaction);
		});
	}

	private readLineHeight(lineNumber: number, reader: IReader): number {
		const model = this.model.read(reader);
		if (!model) return 0;
		validateLineNumber(model, lineNumber);
		this.layoutInfo.read(reader);
		return this.editor.getOption(EditorOption.lineHeight);
	}

	private readLineTop(model: ITextModel | null, lineNumber: number): number {
		if (!model) return 0;
		validateLineNumber(model, lineNumber);
		return this.editor.getTopForLineNumber(lineNumber);
	}

	private readLineBottom(model: ITextModel | null, lineNumber: number): number {
		if (!model) return 0;
		validateLineNumber(model, lineNumber);
		return this.editor.getBottomForLineNumber(lineNumber);
	}
}

class ObservableState<T> extends Disposable implements ISettableObservable<T> {
	private readonly emitter: Emitter<T>;
	private value: T;

	public readonly onDidChange: Event<T>;

	public constructor(initialValue: T) {
		super();
		this.value = initialValue;
		this.emitter = this._register(new Emitter<T>());
		this.onDidChange = this.emitter.event;
	}

	public get(): T {
		return this.value;
	}

	public read(reader: IReader | undefined): T {
		return reader ? reader.readObservable(this) : this.value;
	}

	public map<TMapped>(mapValue: (value: T, reader: IReader) => TMapped): IObservable<TMapped> {
		return derived(reader => mapValue(this.read(reader), reader));
	}

	public set(value: T, activeTransaction?: ITransaction): void {
		this.update(value, activeTransaction, false);
	}

	public update(value: T, activeTransaction: ITransaction | undefined, force: boolean): void {
		if (!force && Object.is(this.value, value)) return;
		this.value = value;
		this.publish(activeTransaction);
	}

	private publish(activeTransaction: ITransaction | undefined): void {
		if (activeTransaction) activeTransaction.enqueue(this, () => this.emitter.fire(this.value));
		else this.emitter.fire(this.value);
	}
}

class ObservableChannel<T> extends Disposable implements IObservable<T> {
	private readonly emitter: Emitter<T>;
	private value: T;

	public readonly onDidChange: Event<T>;

	public constructor(initialValue: T) {
		super();
		this.value = initialValue;
		this.emitter = this._register(new Emitter<T>());
		this.onDidChange = this.emitter.event;
	}

	public get(): T {
		return this.value;
	}

	public read(reader: IReader | undefined): T {
		return reader ? reader.readObservable(this) : this.value;
	}

	public map<TMapped>(mapValue: (value: T, reader: IReader) => TMapped): IObservable<TMapped> {
		return derived(reader => mapValue(this.read(reader), reader));
	}

	public emit(value: T, activeTransaction: ITransaction | undefined): void {
		this.value = value;
		if (activeTransaction) activeTransaction.enqueue(this, () => this.emitter.fire(this.value));
		else this.emitter.fire(value);
	}
}

class SettableDerivedObservable<T> extends Disposable implements ISettableObservable<T> {
	public constructor(
		private readonly source: IObservable<T>,
		private readonly setter: (value: T, transaction: ITransaction | undefined) => void,
	) {
		super();
	}

	public get(): T {
		return this.source.get();
	}

	public read(reader: IReader | undefined): T {
		return this.source.read(reader);
	}

	public onDidChange: Event<T> = listener => this.source.onDidChange(listener);

	public map<TMapped>(mapValue: (value: T, reader: IReader) => TMapped): IObservable<TMapped> {
		return derived(reader => mapValue(this.read(reader), reader));
	}

	public set(value: T, transaction?: ITransaction): void {
		this.setter(value, transaction);
	}
}

function readValue<T>(value: T | IObservable<T>, reader: IReader): T {
	return isObservable(value)
		? (value as IObservable<T>).read(reader)
		: value;
}

function validateLineNumber(model: ITextModel, lineNumber: number): void {
	if (!Number.isSafeInteger(lineNumber) || lineNumber < 1 || lineNumber > model.getLineCount()) {
		throw new RangeError(`Line number must be between 1 and ${model.getLineCount()}`);
	}
}

interface IObservableOverlayWidget {
	readonly domNode: HTMLElement;
	readonly position: IObservable<IOverlayWidgetPosition | null>;
	readonly minContentWidthInPx: IObservable<number>;
	readonly allowEditorOverflow: boolean;
}

interface IObservableContentWidget {
	readonly domNode: HTMLElement;
	readonly position: IObservable<IContentWidgetPosition | null>;
	readonly allowEditorOverflow: boolean;
}
