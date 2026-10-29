import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { observeResize } from '../../../../../base/browser/observer.js';
import { StandardWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { appendRemoveOnDispose } from '../utils.js';
import { EditorGutter, type IGutterItemInfo, type IGutterItemView } from '../utils/editorGutter.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Lxicon } from '../../../../../base/common/lxicons.js';
import type { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { EditorContextKeys } from '../../../../common/editorContextKeys.js';
import { Range } from '../../../../common/core/range.js';
import { LineRange } from '../../../../common/core/ranges/lineRange.js';
import type { DiffModel } from '../../../../common/diff/diffModel.js';
import { DetailedLineRangeMapping } from '../../../../common/diff/rangeMapping.js';
import type { CodeEditorWidget } from '../../codeEditor/codeEditorWidget.js';
import type { DiffEditorWidget } from '../diffEditorWidget.js';

export interface DiffEditorSelectionHunkToolbarContext {
	mapping: DetailedLineRangeMapping;
	originalWithModifiedChanges: string;
	modifiedUri: URI;
	originalUri: URI;
}

interface DiffGutterItem extends IGutterItemInfo {
	readonly mapping: DetailedLineRangeMapping;
	readonly isSelection: boolean;
	height: number;
}

/** Owns hunk actions; their attached views and line geometry belong to EditorGutter. */
export class DiffEditorGutter extends Disposable {
	private readonly domNode: HTMLDivElement;
	private readonly scope: IContextKeyService;
	private readonly items: DiffGutterItem[] = [];
	private readonly renderedItems = observableValue<readonly DiffGutterItem[]>(this, []);
	private nextItemId = 0;
	private enabled = false;
	private inlineView = false;
	private available = false;
	private readonly contentHeightEmitter = this._register(new Emitter<void>());
	public readonly onDidChangeContentHeight = this.contentHeightEmitter.event;

	constructor(
		container: HTMLElement,
		private readonly editor: CodeEditorWidget,
		private readonly model: DiffModel,
		private readonly widget: DiffEditorWidget,
		private readonly onDidChangeWidth: () => void,
		@IMenuService private readonly menus: IMenuService,
		@IContextMenuService private readonly contextMenu: IContextMenuService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-diff-gutter';
		this._register(appendRemoveOnDispose(container, this.domNode));
		this.scope = this._register(contextKeys.createScoped(this.domNode));
		EditorContextKeys.diffEditorOriginalUri.bindTo(this.scope).set(model.original.uri.toString());
		EditorContextKeys.diffEditorModifiedUri.bindTo(this.scope).set(model.modified.uri.toString());
		for (const id of [MenuId.DiffEditorHunkToolbar, MenuId.DiffEditorSelectionToolbar]) {
			const menu = this._register(menus.createMenu(id, this.scope));
			this._register(
				menu.onDidChange(() => {
					// Each live toolbar updates its own menu. Rebuild mappings only when
					// action availability changes the gutter, not for unrelated editor contexts.
					if (this.available === this.hasActions()) return;
					const width = this.width;
					this.update(this.enabled, this.inlineView);
					if (this.width !== width) this.onDidChangeWidth();
				}),
			);
		}
		this._register(
			editor.onDidChangeCursorSelection(() => {
				if (
					this.items.some(item => item.isSelection) ||
					editor.getSelections()?.some(selection => !selection.isEmpty())
				) {
					this.update(this.enabled, this.inlineView);
				}
			}),
		);
		this._register(
			new EditorGutter(editor, this.domNode, {
				// Keep keyed views across scroll so keyboard focus and menu state survive.
				getIntersectingGutterItems: (_range, reader) => this.renderedItems.read(reader),
				createView: (item, target) => this.createToolbar(item.get(), target),
			}),
		);
		this._register(
			addDisposableListener(
				this.domNode,
				'wheel',
				event => {
					if (editor.getOption(EditorOption.scrollbar).handleMouseWheel)
						editor.delegateScrollFromMouseWheelEvent(new StandardWheelEvent(event));
				},
				{ passive: false },
			),
		);
	}

	public get width(): number {
		return this.enabled && this.available ? 35 : 0;
	}

	public update(enabled: boolean, inlineView: boolean): void {
		const previousHeight = this.getContentHeight();
		this.enabled = enabled;
		this.inlineView = inlineView;
		this.available = this.hasActions();
		this.domNode.hidden = this.width === 0;
		const hadFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
		this.renderedItems.set([]);
		this.items.length = 0;
		const diff = this.model.diff;
		if (this.width === 0 || !diff) {
			if (previousHeight !== 0) this.contentHeightEmitter.fire();
			if (hadFocus) this.editor.focus();
			return;
		}
		const selections = this.editor.getSelections() ?? [];
		const ranges = diff.changes.flatMap(change =>
			(change.innerChanges ?? []).filter(range =>
				selections.some(
					selection => !selection.isEmpty() && Range.areIntersecting(selection, range.modifiedRange),
				),
			),
		);
		if (ranges.length > 0) {
			const original = LineRange.join(ranges.map(range => LineRange.fromRangeInclusive(range.originalRange)));
			const modified = LineRange.join(ranges.map(range => LineRange.fromRangeInclusive(range.modifiedRange)));
			this.addToolbar(
				new DetailedLineRangeMapping(original, modified, ranges),
				MenuId.DiffEditorSelectionToolbar,
			);
		}
		for (const change of diff.changes) {
			if (!ranges.some(range => change.innerChanges?.includes(range)))
				this.addToolbar(change, MenuId.DiffEditorHunkToolbar);
		}
		this.renderedItems.set([...this.items]);
		if (previousHeight !== this.getContentHeight()) this.contentHeightEmitter.fire();
		if (hadFocus) this.editor.focus();
	}

	private get canRevert(): boolean {
		return !this.editor.getOption(EditorOption.readOnly);
	}

	private hasActions(): boolean {
		return (
			this.canRevert ||
			[MenuId.DiffEditorHunkToolbar, MenuId.DiffEditorSelectionToolbar].some(id =>
				this.menus.getMenuActions(id, undefined, this.scope).some(([, actions]) => actions.length > 0),
			)
		);
	}

	public computeStagedValue(mapping: DetailedLineRangeMapping): string {
		const original = this.model.original;
		const modified = this.model.modified;
		if (!this.model.diff?.changes.includes(mapping)) {
			let text = original.getValue();
			const edits = mapping
				.innerChanges!.map(range => ({
					start: original.getOffsetAt(range.originalRange.getStartPosition()),
					end: original.getOffsetAt(range.originalRange.getEndPosition()),
					text: modified.getValueInRange(range.modifiedRange),
				}))
				.sort((left, right) => right.start - left.start);
			for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
			return text;
		}
		const lines = original.getLinesContent();
		lines.splice(
			mapping.original.startLineNumber - 1,
			mapping.original.length,
			...modified
				.getLinesContent()
				.slice(mapping.modified.startLineNumber - 1, mapping.modified.endLineNumberExclusive - 1),
		);
		return lines.join(original.getEOL());
	}

	public layout(left: number): void {
		this.domNode.style.left = `${left}px`;
		this.domNode.style.width = `${this.width}px`;
	}

	public getContentHeight(): number {
		// Short file previews need enough room for a complete toolbar, independent of its hunk's offset.
		return this.items.reduce((height, item) => Math.max(height, item.height), 0);
	}

	private addToolbar(mapping: DetailedLineRangeMapping, menuId: MenuId): void {
		this.items.push({
			id: String(++this.nextItemId),
			range: mapping.modified,
			mapping,
			isSelection: menuId === MenuId.DiffEditorSelectionToolbar,
			height: 0,
		});
	}

	private createToolbar(item: DiffGutterItem, node: HTMLElement): IGutterItemView {
		const { mapping, isSelection } = item;
		const menuId = isSelection ? MenuId.DiffEditorSelectionToolbar : MenuId.DiffEditorHunkToolbar;
		const store = new DisposableStore();
		node.className = 'ash-diff-gutter-item';
		node.classList.toggle('ash-diff-revert', this.canRevert);
		const context: DiffEditorSelectionHunkToolbarContext = {
			mapping,
			originalWithModifiedChanges: this.computeStagedValue(mapping),
			originalUri: this.model.original.uri,
			modifiedUri: this.model.modified.uri,
		};
		const revertLabel =
			menuId === MenuId.DiffEditorSelectionToolbar
				? localize('diffEditor.revertSelection', 'Revert selected changes')
				: localize('diffEditor.revertChange', 'Revert change');
		const toolbar = store.add(
			new MenuWorkbenchToolBar(node, this.menus, this.contextMenu, menuId, {
				leadingActions: this.canRevert
					? [
							{
								id: 'diffEditor.revert',
								label: revertLabel,
								tooltip: revertLabel,
								icon: this.inlineView ? Lxicon.discard : Lxicon.arrowRight,
								enabled: true,
								run: () =>
									menuId === MenuId.DiffEditorSelectionToolbar
										? this.widget.revertRangeMappings(mapping.innerChanges ?? [])
										: this.widget.revert(mapping),
							},
						]
					: [],
				ariaLabel: localize('diffEditor.hunkActions', 'Change actions'),
				orientation: 'vertical',
				presentation: 'inherit-foreground',
				contextKeyService: this.scope,
				menuOptions: { arg: context, shouldForwardArgs: true },
				toolbarOptions: { primaryGroup: group => group.startsWith('primary') || group === 'navigation' },
			}),
		);
		item.height = toolbar.element.offsetHeight;
		store.add(
			observeResize(toolbar.element, () => {
				if (node.hidden) return;
				const height = toolbar.element.offsetHeight;
				if (height === item.height) return;
				item.height = height;
				this.renderedItems.set([...this.items]);
				this.contentHeightEmitter.fire();
			}),
		);
		return {
			...toDisposable(() => store.dispose()),
			layout: (itemRange, viewport) => {
				const cursor = this.editor.getPosition();
				node.classList.toggle(
					'active',
					isSelection || (!!cursor && mapping.modified.contains(cursor.lineNumber)),
				);
				const visibleTop = Math.max(viewport.start, itemRange.start);
				const visibleBottom = Math.min(viewport.endExclusive, itemRange.endExclusive);
				const toolbarTop = Math.max(
					viewport.start,
					Math.min(
						Math.max(viewport.start, viewport.endExclusive - item.height),
						(visibleTop + visibleBottom - item.height) / 2,
					),
				);
				toolbar.element.style.top = `${toolbarTop - itemRange.start}px`;
			},
		};
	}
}
