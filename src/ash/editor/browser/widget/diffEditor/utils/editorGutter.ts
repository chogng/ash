import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun, observableValue, type IObservable, type IReader, type ISettableObservable } from '../../../../../base/common/observable.js';
import { LineRange } from '../../../../common/core/ranges/lineRange.js';
import type { IOffsetRange } from '../../../../common/core/ranges/offsetRange.js';
import type { CodeEditorWidget } from '../../codeEditor/codeEditorWidget.js';
import { appendRemoveOnDispose } from '../utils.js';

export interface IGutterItemInfo {
	readonly id: string;
	readonly range: LineRange;
}

export interface IGutterItemView extends IDisposable {
	/** Pixel offsets relative to the viewport; item offsets may lie outside it. */
	layout(itemRange: IOffsetRange, viewRange: IOffsetRange): void;
}

export interface IGutterItemProvider<T extends IGutterItemInfo> {
	getIntersectingGutterItems(range: LineRange, reader: IReader): readonly T[];
	createView(item: IObservable<T>, target: HTMLElement): IGutterItemView;
}

interface GutterView<T> extends IDisposable {
	readonly item: ISettableObservable<T>;
	readonly domNode: HTMLElement;
	readonly view: IGutterItemView;
}

/** Owns keyed gutter views and their geometry, using the editor's wrapping and view zones. */
export class EditorGutter<T extends IGutterItemInfo> extends Disposable {
	private readonly views = this._register(new DisposableMap<string, GutterView<T>>());
	private readonly geometry = observableValue(this, 0);

	constructor(editor: CodeEditorWidget, domNode: HTMLElement, provider: IGutterItemProvider<T>) {
		super();
		const invalidate = (): void => this.geometry.set(this.geometry.get() + 1);
		this._register(editor.onDidScrollChange(invalidate));
		this._register(editor.onDidLayoutChange(invalidate));
		// Alignment zones can change without changing the editor's viewport or scroll position.
		this._register(editor.onDidChangeViewZones(invalidate));
		this._register(editor.onDidContentSizeChange(invalidate));
		this._register(editor.onDidChangeCursorSelection(invalidate));
		this._register(
			addDisposableListener(domNode, 'focusout', () =>
				queueMicrotask(() => {
					if (!this.isDisposed) invalidate();
				}),
			),
		);
		this._register(
			autorun(reader => {
				this.geometry.read(reader);
				const visible = editor.getVisibleRanges();
				const range = visible.length ? LineRange.join(visible.map(range => LineRange.fromRangeInclusive(range))) : new LineRange(1, 1);
				const items = provider.getIntersectingGutterItems(range, reader);
				const live = new Set(items.map(item => item.id));
				for (const id of this.views.keys()) {
					if (live.has(id)) {
						continue;
					}
					this.views.deleteAndDispose(id);
				}
				const scrollTop = editor.getScrollTop();
				const viewport = { start: 0, endExclusive: editor.getLayoutInfo().height };
				// Read editor geometry before writing any positions.
				const bounds = items.map(item => ({
					item,
					start: editor.getTopForLineNumber(item.range.startLineNumber, true) - scrollTop,
					endExclusive:
						(item.range.isEmpty ? editor.getTopForLineNumber(item.range.startLineNumber) : editor.getBottomForLineNumber(item.range.endLineNumberExclusive - 1, true)) - scrollTop,
				}));
				let previousNode: HTMLElement | undefined;
				for (const { item, start, endExclusive } of bounds) {
					let entry = this.views.get(item.id);
					const inViewport = endExclusive > viewport.start && start < viewport.endExclusive;
					// Menu views can prepare full-document action arguments. Do not create
					// them for offscreen hunks, but retain a focused view until focus leaves.
					const focused = entry?.domNode.contains(domNode.ownerDocument.activeElement) === true;
					if (!inViewport && !focused) {
						this.views.deleteAndDispose(item.id);
						continue;
					}
					if (!entry) {
						const target = h(domNode.ownerDocument, 'div');
						const store = new DisposableStore();
						store.add(appendRemoveOnDispose(domNode, target));
						const value = observableValue(this, item);
						let view: IGutterItemView;
						try {
							view = store.add(provider.createView(value, target));
						} catch (error) {
							store.dispose();
							throw error;
						}
						entry = { ...toDisposable(() => store.dispose()), item: value, domNode: target, view };
						this.views.set(item.id, entry);
						// Newly visible views join source order without moving a focused sibling.
						const nextNode = previousNode ? previousNode.nextSibling : domNode.firstChild;
						if (nextNode !== target) domNode.insertBefore(target, nextNode);
					} else {
						entry.item.set(item);
					}
					entry.domNode.style.top = `${start}px`;
					entry.domNode.style.height = `${Math.max(0, endExclusive - start)}px`;
					entry.view.layout({ start, endExclusive }, viewport);
					previousNode = entry.domNode;
				}
			}),
		);
	}
}
