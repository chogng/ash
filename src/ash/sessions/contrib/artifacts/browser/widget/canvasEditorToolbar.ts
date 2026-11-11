import './canvasEditorToolbar.css';
import { h } from '../../../../../base/browser/dom.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import type { IContextMenuProvider } from '../../../../../base/browser/contextmenu.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { MenuWorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';
import { Menus } from '../../../../browser/menus.js';

registerColor('sessions.design.chromeBackground', { light: '#181818', dark: '#181818', hcDark: '#000000', hcLight: '#ffffff' }, { owner: 'sessions.design', description: localize('color.sessions.design.chromeBackground', 'Background of the canvas editor toolbar and menus.') });
registerColor('sessions.design.chromeForeground', { light: '#f0f0f0', dark: '#f0f0f0', hcDark: '#ffffff', hcLight: '#000000' }, { owner: 'sessions.design', description: localize('color.sessions.design.chromeForeground', 'Foreground of the canvas editor toolbar and menus.') });

export interface CanvasToolbarAction extends IAction {
	readonly dropdown?: { readonly label: string; readonly actions: readonly IAction[]; };
}

/** Renders actions supplied by the canvas editor and its active workspace. */
export class CanvasEditorToolbar extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly tools: ActionBar;
	private readonly modes: ActionBar;
	private readonly workspaceToolbar: MenuWorkbenchToolBar;
	private menuVisible = false;

	constructor(
		ownerDocument: Document,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-canvas-editor-toolbar' });
		const tools = h(ownerDocument, 'div', { className: 'ash-canvas-editor-toolbar-group' });
		const modes = h(ownerDocument, 'div', { className: 'ash-canvas-editor-toolbar-group' });
		this.domNode.append(tools, modes);
		const menuProvider: IContextMenuProvider = {
			showContextMenu: delegate => {
				contextMenus.showContextMenu({
					...delegate,
					getMenuClassName: () => 'ash-canvas-editor-menu',
					iconPlacement: 'leading-with-trailing-check',
					getCheckedActionsRepresentation: () => 'radio',
					onHide: cancelled => {
						this.menuVisible = false;
						delegate.onHide?.(cancelled);
					},
				});
				this.menuVisible = true;
			},
		};
		this._register(toDisposable(() => this.hideMenu()));
		this.tools = this._register(new ActionBar(tools, {
			actionViewItemOptions: { buttonStyles: defaultButtonStyles, iconOnly: true },
			ariaLabel: localize('sessions.artifacts.canvasTools', 'Canvas tools'),
			highlightToggledItems: true,
			actionViewItemProvider: (action, options) => {
				const { dropdown } = action as CanvasToolbarAction;
				if (!dropdown) return undefined;
				const trigger: IAction = { id: `${action.id}.menu`, label: dropdown.label, tooltip: dropdown.label, enabled: action.enabled, run: () => undefined };
				return new DropdownWithPrimaryActionViewItem(action, trigger, () => dropdown.actions, menuProvider, options);
			},
		}));
		this.modes = this._register(new ActionBar(modes, {
			actionViewItemOptions: { buttonStyles: defaultButtonStyles, iconOnly: true },
			ariaLabel: localize('sessions.artifacts.canvasEditorModes', 'Editor modes'),
			highlightToggledItems: true,
		}));
		this.workspaceToolbar = this._register(new MenuWorkbenchToolBar(this.domNode, menuService, menuProvider, Menus.ArtifactCanvasToolbar, {
			ariaLabel: localize('sessions.creator.workspaceActions', 'Workspace actions'),
			contextKeyService: contextKeys,
			menuOptions: { shouldForwardArgs: true },
		}));
		this.workspaceToolbar.element.classList.add('ash-canvas-editor-toolbar-workspace');
	}

	public setEditorActions(tools: readonly CanvasToolbarAction[], modes: readonly IAction[]): void {
		this.tools.updateActions(tools);
		this.modes.updateActions(modes);
	}

	public setWorkspaceContext(context: unknown): void {
		this.workspaceToolbar.context = context;
	}

	public hideMenu(): void {
		if (this.menuVisible) this.contextMenus.hideContextMenu();
	}
}
