import './artifactToolbar.css';
import { h } from '../../../../../base/browser/dom.js';
import { ButtonActionViewItem, type ActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { DropdownMenuActionViewItem } from '../../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { AnchorPosition } from '../../../../../base/browser/ui/contextview/contextview.js';
import type { IContextMenuDelegate, IContextMenuProvider } from '../../../../../base/browser/contextmenu.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { DropdownWithPrimaryActionViewItem } from '../../../../../platform/actions/browser/dropdownWithPrimaryActionViewItem.js';
import { MenuWorkbenchToolBar, WorkbenchToolBar } from '../../../../../platform/actions/browser/toolbar.js';
import { IMenuService } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';
import { Menus } from '../../../../browser/menus.js';

registerColor('sessions.design.chromeBackground', { light: '#181818', dark: '#181818', hcDark: '#000000', hcLight: '#ffffff' }, { owner: 'sessions.design', description: localize('color.sessions.design.chromeBackground', 'Background of the canvas editor toolbar and menus.') });
registerColor('sessions.design.chromeForeground', { light: '#f0f0f0', dark: '#f0f0f0', hcDark: '#ffffff', hcLight: '#000000' }, { owner: 'sessions.design', description: localize('color.sessions.design.chromeForeground', 'Foreground of the canvas editor toolbar and menus.') });

export interface ArtifactToolbarAction extends IAction {
	readonly menu?: readonly IAction[];
	readonly iconOnly?: boolean;
	readonly presentation?: ActionViewItemOptions['buttonPresentation'];
	readonly dropdown?: { readonly label: string; readonly actions: readonly IAction[]; };
}

class ArtifactActionGroup extends WorkbenchToolBar {
	public override setActions(primary: readonly IAction[], secondary: readonly IAction[] = [], trailing: readonly IAction[] = []): void {
		// Retain action views when selection changes so focus and split-button menus survive the refresh.
		this.updateActions(primary, secondary, trailing);
	}
}

/** Owns toolbar chrome and action-view lifetimes; contributors own actions and editor state. */
export class ArtifactToolbar extends Disposable {
	public readonly domNode: HTMLElement;
	private readonly workspaceToolbar: MenuWorkbenchToolBar;
	private readonly menuProvider: IContextMenuProvider;
	private menuVisible = false;

	constructor(
		ownerDocument: Document,
		options: { readonly appearance?: 'canvas'; readonly menuClassName?: string; readonly menuIconPlacement?: IContextMenuDelegate['iconPlacement']; readonly getMenuActionViewItem?: IContextMenuDelegate['getActionViewItem']; },
		@IContextMenuService private readonly contextMenus: IContextMenuService,
		@IMenuService menuService: IMenuService,
		@IContextKeyService contextKeys: IContextKeyService,
	) {
		super();
		this.domNode = h(ownerDocument, 'div', { className: 'ash-artifact-toolbar' });
		this.domNode.classList.toggle('canvas', options.appearance === 'canvas');
		this.menuProvider = {
			showContextMenu: delegate => {
				contextMenus.showContextMenu({
					...delegate,
					anchorPosition: AnchorPosition.Above,
					gap: delegate.gap ?? 8,
					getMenuClassName: () => options.menuClassName ?? (options.appearance === 'canvas' ? 'ash-canvas-editor-menu' : ''),
					iconPlacement: options.menuIconPlacement ?? (options.appearance === 'canvas' ? 'leading-with-trailing-check' : 'trailing'),
					getActionViewItem: (action, viewOptions) => options.getMenuActionViewItem?.(action, viewOptions) ?? delegate.getActionViewItem?.(action, viewOptions),
					getCheckedActionsRepresentation: options.appearance === 'canvas' ? () => 'radio' : delegate.getCheckedActionsRepresentation,
					onHide: cancelled => {
						this.menuVisible = false;
						delegate.onHide?.(cancelled);
					},
				});
				this.menuVisible = true;
			},
		};
		this._register(toDisposable(() => {
			this.hideMenu();
			this.domNode.remove();
		}));
		this.workspaceToolbar = this._register(new MenuWorkbenchToolBar(this.domNode, menuService, this.menuProvider, Menus.ArtifactToolbar, {
			ariaLabel: localize('sessions.artifacts.workspaceActions', 'Workspace actions'),
			contextKeyService: contextKeys,
			menuOptions: { shouldForwardArgs: true },
			highlightToggledItems: true,
		}));
		this.workspaceToolbar.element.classList.add('ash-artifact-toolbar-workspace');
	}

	/** The toolbar owns the group; the contributor supplies its accessible name and actions. */
	public createActionGroup(ariaLabel: string): WorkbenchToolBar {
		const container = h(this.domNode.ownerDocument, 'div', { className: 'ash-artifact-toolbar-group' });
		this.domNode.append(container);
		return this._register(new ArtifactActionGroup(container, this.menuProvider, {
			ariaLabel,
			highlightToggledItems: true,
			actionViewItemProvider: (action, options) => {
				const { dropdown, menu, iconOnly = true, presentation } = action as ArtifactToolbarAction;
				if (menu) return new DropdownMenuActionViewItem(action, menu, this.menuProvider, { ...options, iconOnly });
				if (!dropdown) return new ButtonActionViewItem(action, { ...options, iconOnly, buttonPresentation: presentation ?? options.buttonPresentation });
				const trigger: IAction = { id: `${action.id}.menu`, label: dropdown.label, tooltip: dropdown.label, enabled: action.enabled, run: () => undefined };
				return new DropdownWithPrimaryActionViewItem(action, trigger, () => dropdown.actions, this.menuProvider, { ...options, iconOnly: true });
			},
		}));
	}

	public prependControl(control: HTMLElement): void {
		this.domNode.prepend(control);
	}

	public setWorkspaceContext(context: unknown): void {
		this.workspaceToolbar.context = context;
	}

	public hideMenu(): void {
		if (this.menuVisible) this.contextMenus.hideContextMenu();
	}
}
