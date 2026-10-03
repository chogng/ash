import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { StandardWheelEvent } from '../../../../../base/browser/mouseEvent.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import { localize, onDidChangeNls } from '../../../../../nls.js';
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { EditorOption } from '../../../../common/config/editorOptions.js';
import { Range } from '../../../../common/core/range.js';
import { LineRange } from '../../../../common/core/ranges/lineRange.js';
import type { DiffModel } from '../../../../common/diff/diffModel.js';
import { DetailedLineRangeMapping } from '../../../../common/diff/rangeMapping.js';
import type { CodeEditorWidget } from '../../codeEditor/codeEditorWidget.js';

export interface DiffEditorSelectionHunkToolbarContext {
	mapping: DetailedLineRangeMapping;
	originalWithModifiedChanges: string;
	modifiedUri: URI;
	originalUri: URI;
}

/** Owns menu-backed hunk controls; coordinates come from the modified editor. */
export class DiffEditorGutter extends Disposable {
	private readonly domNode: HTMLDivElement;
	private readonly toolbars = this._register(new DisposableStore());
	private readonly scope: IContextKeyService;
	private readonly items: { domNode: HTMLElement; lineNumber: number }[] = [];
	private enabled = false;
	private available = false;
	private height = 0;

	constructor(
		container: HTMLElement,
		private readonly editor: CodeEditorWidget,
		private readonly model: DiffModel,
		private readonly onDidChangeWidth: () => void,
		@IMenuService private readonly menus: IMenuService,
		@IContextMenuService private readonly contextMenu: IContextMenuService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.domNode = h(container.ownerDocument, 'div');
		this.domNode.className = 'ash-diff-gutter';
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this.scope = this._register(contextKeys.createScoped(this.domNode));
		for (const id of [MenuId.DiffEditorHunkToolbar, MenuId.DiffEditorSelectionToolbar]) {
			const menu = this._register(menus.createMenu(id, this.scope));
			this._register(menu.onDidChange(() => {
				const width = this.width;
				this.update(this.enabled);
				if (this.width !== width) this.onDidChangeWidth();
			}));
		}
		this._register(editor.onDidChangeCursorSelection(() => this.update(this.enabled)));
		this._register(editor.onDidScrollChange(() => this.positionItems()));
		this._register(editor.onDidLayoutChange(() => this.positionItems()));
		this._register(onDidChangeNls(() => this.update(this.enabled)));
		this._register(addDisposableListener(this.domNode, 'wheel', event => {
			if (editor.getOption(EditorOption.scrollbar).handleMouseWheel) editor.delegateScrollFromMouseWheelEvent(new StandardWheelEvent(event));
		}, { passive: false }));
	}

	public get width(): number {
		return this.enabled && this.available ? 36 : 0;
	}

	public update(enabled: boolean): void {
		this.enabled = enabled;
		this.available = [MenuId.DiffEditorHunkToolbar, MenuId.DiffEditorSelectionToolbar].some(id =>
			this.menus.getMenuActions(id, undefined, this.scope).some(([, actions]) => actions.length > 0));
		this.domNode.hidden = this.width === 0;
		const hadFocus = this.domNode.contains(this.domNode.ownerDocument.activeElement);
		this.toolbars.clear();
		this.items.length = 0;
		const diff = this.model.diff;
		if (this.width === 0 || !diff) {
			if (hadFocus) this.editor.focus();
			return;
		}
		const selections = this.editor.getSelections() ?? [];
		const ranges = diff.changes.flatMap(change => (change.innerChanges ?? []).filter(range =>
			selections.some(selection => !selection.isEmpty() && Range.areIntersecting(selection, range.modifiedRange))));
		if (ranges.length > 0) {
			const original = LineRange.join(ranges.map(range => LineRange.fromRangeInclusive(range.originalRange)));
			const modified = LineRange.join(ranges.map(range => LineRange.fromRangeInclusive(range.modifiedRange)));
			this.addToolbar(new DetailedLineRangeMapping(original, modified, ranges), MenuId.DiffEditorSelectionToolbar);
		} else {
			for (const change of diff.changes) this.addToolbar(change, MenuId.DiffEditorHunkToolbar);
		}
		this.positionItems();
		if (hadFocus) this.editor.focus();
	}

	public computeStagedValue(mapping: DetailedLineRangeMapping): string {
		const original = this.model.original;
		const modified = this.model.modified;
		if (!this.model.diff?.changes.includes(mapping)) {
			let text = original.getValue();
			const edits = mapping.innerChanges!.map(range => ({
				start: original.getOffsetAt(range.originalRange.getStartPosition()),
				end: original.getOffsetAt(range.originalRange.getEndPosition()),
				text: modified.getValueInRange(range.modifiedRange),
			})).sort((left, right) => right.start - left.start);
			for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
			return text;
		}
		const lines = original.getLinesContent();
		lines.splice(mapping.original.startLineNumber - 1, mapping.original.length,
			...modified.getLinesContent().slice(mapping.modified.startLineNumber - 1, mapping.modified.endLineNumberExclusive - 1));
		return lines.join(original.getEOL());
	}

	public layout(left: number, height: number): void {
		this.height = height;
		this.domNode.style.left = `${left}px`;
		this.domNode.style.width = `${this.width}px`;
		this.positionItems();
	}

	private addToolbar(mapping: DetailedLineRangeMapping, menuId: MenuId): void {
		const node = h(this.domNode.ownerDocument, 'div');
		node.className = 'ash-diff-gutter-item';
		this.domNode.append(node);
		this.toolbars.add(toDisposable(() => node.remove()));
		const context: DiffEditorSelectionHunkToolbarContext = {
			mapping,
			originalWithModifiedChanges: this.computeStagedValue(mapping),
			originalUri: this.model.original.uri,
			modifiedUri: this.model.modified.uri,
		};
		this.toolbars.add(new MenuWorkbenchToolBar(node, this.menus, this.contextMenu, menuId, {
			ariaLabel: localize('diffEditor.hunkActions', 'Change actions'),
			orientation: 'vertical',
			contextKeyService: this.scope,
			menuOptions: { arg: context, shouldForwardArgs: true },
			toolbarOptions: { primaryGroup: group => group.startsWith('primary') || group === 'navigation' },
		}));
		this.items.push({ domNode: node, lineNumber: Math.min(this.model.modified.getLineCount(), mapping.modified.startLineNumber) });
	}

	private positionItems(): void {
		const scrollTop = this.editor.getScrollTop();
		for (const item of this.items) {
			const top = this.editor.getTopForLineNumber(item.lineNumber) - scrollTop;
			item.domNode.hidden = top < -36 || top >= this.height;
			item.domNode.style.top = `${top}px`;
		}
	}
}
