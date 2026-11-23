import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Separator } from '../../../../base/common/actions.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { localize } from '../../../../nls.js';
import type { ArtifactToolbarAction } from '../../artifact/browser/widget/artifactToolbar.js';
import type { ArkdownEditor } from '../../../../workbench/contrib/markdown/browser/arkdown/arkdownEditor.js';
import { getDocsMenuActionViewItem, type DocsSelectionAction } from './docsToolbar.js';

class SelectionActionBar extends WorkbenchToolBar {
	public override setActions(actions: readonly ArtifactToolbarAction[]): void {
		this.updateActions(actions);
	}
}

/** Places shared toolbar controls beside the editor-owned selection without taking its focus. */
export class DocsSelectionToolbar extends Disposable {
	private readonly domNode: HTMLElement;
	private readonly toolbar: WorkbenchToolBar;
	private menuVisible = false;
	private selecting = false;
	private dismissed = false;
	private renderedState: string | undefined;
	private renderedEditor: ArkdownEditor | undefined;
	private renderedImage: HTMLElement | undefined;
	private selectionIdentity: { anchor: Node | null; anchorOffset: number; focus: Node | null; focusOffset: number; } | undefined;

	constructor(
		private readonly container: HTMLElement,
		private readonly getEditor: () => ArkdownEditor | undefined,
		private readonly getActions: () => readonly ArtifactToolbarAction[],
		@IContextMenuService private readonly contextMenus: IContextMenuService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'div', { className: 'ash-docs-selection-toolbar', attributes: { 'data-arkdown-selection-controls': '' } });
		this.domNode.hidden = true;
		container.append(this.domNode);
		const menus = {
			showContextMenu: (delegate: Parameters<IContextMenuService['showContextMenu']>[0]) => {
				this.menuVisible = true;
				contextMenus.showContextMenu({
					...delegate,
					getMenuClassName: () => delegate.getActions?.().some(action => (action as DocsSelectionAction).section)
						? 'ash-docs-format-menu ash-docs-palette-menu' : 'ash-docs-format-menu',
					iconPlacement: 'leading-with-trailing-check',
					getActionViewItem: (action, options) => {
						return getDocsMenuActionViewItem(action, options) ?? delegate.getActionViewItem?.(action, options);
					},
					getKeyBinding: action => (action as DocsSelectionAction).keybinding ?? delegate.getKeyBinding?.(action),
					anchorPosition: AnchorPosition.Below,
					gap: 8,
					onHide: cancelled => {
						this.menuVisible = false;
						delegate.onHide?.(cancelled);
						this.update();
					},
				});
			},
		};
		this.toolbar = this._register(new SelectionActionBar(this.domNode, menus, {
			ariaLabel: localize({ bundle: 'ash.docs', key: 'selectionFormatting' }, 'Selection formatting'),
			highlightToggledItems: true,
			actionViewItemProvider: (action, options) => {
				if (action instanceof Separator) return undefined;
				const { menu } = action as ArtifactToolbarAction;
				const controls = { ...options, iconOnly: true, buttonClassName: action.class };
				return menu
					? new DropdownMenuActionViewItem(action, menu, menus, { ...controls, indicator: 'visible' })
					: new ButtonActionViewItem(action, controls);
			},
		}));
		// Pointer activation keeps the native selection painted. Keyboard focus still uses the shared toolbar.
		this._register(addDisposableListener(this.domNode, 'mousedown', event => event.preventDefault()));
		this._register(addDisposableListener(document, 'pointerdown', event => {
			if (this.domNode.contains(event.target as Node) || this.menuVisible) return;
			this.selecting = event.button === 0 && !!this.getEditor()?.domNode.contains(event.target as Node);
			this.hide();
		}, true));
		this._register(addDisposableListener(document, 'pointerup', () => {
			this.selecting = false;
			this.dismissed = false;
			this.update();
		}));
		this._register(addDisposableListener(document, 'selectionchange', () => {
			const selection = document.defaultView?.getSelection();
			const previous = this.selectionIdentity;
			if (!selection || selection.anchorNode !== previous?.anchor || selection.anchorOffset !== previous?.anchorOffset
				|| selection.focusNode !== previous?.focus || selection.focusOffset !== previous?.focusOffset) {
				this.dismissed = false;
			}
			this.selectionIdentity = selection ? {
				anchor: selection.anchorNode, anchorOffset: selection.anchorOffset,
				focus: selection.focusNode, focusOffset: selection.focusOffset,
			} : undefined;
			this.update();
		}));
		this._register(addDisposableListener(document, 'focusin', () => this.update()));
		this._register(addDisposableListener(container, 'keydown', event => {
			if (event.key === 'Escape' && !this.domNode.hidden && !this.menuVisible) {
				event.preventDefault();
				event.stopPropagation();
				this.dismissed = true;
				this.hide();
				if (!this.getEditor()?.hasFocus()) this.getEditor()?.focus();
			}
		}));
		this._register(addDisposableListener(document, 'scroll', () => this.update(), true));
		this._register(addDisposableListener(document.defaultView!, 'resize', () => this.update()));
	}

	update(): void {
		if (this.isDisposed || this.menuVisible) return;
		const editor = this.getEditor();
		const active = this.container.ownerDocument.activeElement;
		const bounds = editor?.getSelectionBounds();
		if (this.dismissed || this.selecting || !bounds || (!editor?.hasFocus() && !this.domNode.contains(active))) {
			this.hide();
			return;
		}
		const actions = this.getActions();
		const image = editor?.selectedImage?.domNode;
		const state = JSON.stringify(actions.map(action => [
			action.id, action.enabled, action.checked,
			action.menu?.map(item => [item.id, item.enabled, item.checked]),
		]));
		if (editor !== this.renderedEditor || image !== this.renderedImage || state !== this.renderedState) {
			this.toolbar.setActions(actions);
			this.renderedState = state;
			this.renderedEditor = editor;
			this.renderedImage = image;
		}
		this.domNode.hidden = false;
		const parent = this.container.getBoundingClientRect();
		const size = this.domNode.getBoundingClientRect();
		const left = Math.max(8, Math.min(bounds.left + bounds.width / 2 - parent.left - size.width / 2, parent.width - size.width - 8));
		const above = bounds.top - parent.top - size.height - 8;
		const top = above >= 8 ? above : Math.min(bounds.bottom - parent.top + 8, parent.height - size.height - 8);
		this.domNode.style.left = `${left}px`;
		this.domNode.style.top = `${Math.max(8, top)}px`;
	}

	/** Explicit entry for right-click and the keyboard context-menu shortcut. */
	show(focus = false): boolean {
		this.dismissed = false;
		this.selecting = false;
		this.update();
		if (this.domNode.hidden) return false;
		if (focus) this.toolbar.focus();
		return true;
	}

	private hide(): void {
		this.domNode.hidden = true;
	}

	close(): void {
		this.dismissed = true;
		this.selectionIdentity = undefined;
		if (this.menuVisible) this.contextMenus.hideContextMenu();
		this.hide();
		this.toolbar.setActions([]);
		this.renderedState = undefined;
		this.renderedEditor = undefined;
	}

	protected override disposeCore(): void {
		if (this.menuVisible) this.contextMenus.hideContextMenu();
		this.domNode.remove();
		super.disposeCore();
	}
}
