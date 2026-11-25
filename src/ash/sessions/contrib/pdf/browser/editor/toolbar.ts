import { addDisposableListener } from '../../../../../base/browser/dom.js';
import { ButtonActionViewItem, type ActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { DropdownMenuActionViewItem } from '../../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import type { IAction } from '../../../../../base/common/actions.js';
import { WorkbenchToolBar, type IWorkbenchToolBarOptions } from '../../../../../platform/actions/browser/toolbar.js';
import type { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import type { AuxiliaryBarPart } from '../../../../browser/parts/auxiliaryBarPart.js';

interface PdfToolbarOptions {
	readonly ariaLabel: string;
	readonly tabNavigation?: IWorkbenchToolBarOptions['tabNavigation'];
	readonly sidebarToggle?: { readonly action: IAction; readonly sidebar: AuxiliaryBarPart; };
	readonly scrollMode?: { readonly action: IAction; readonly choices: readonly IAction[]; };
}

export function createPdfToolbar(
	parent: HTMLElement,
	contextMenus: IContextMenuService,
	actions: readonly IAction[],
	{ ariaLabel, tabNavigation, sidebarToggle, scrollMode }: PdfToolbarOptions,
): WorkbenchToolBar {
	const toolbar = new WorkbenchToolBar(parent, contextMenus, {
		ariaLabel,
		tabNavigation,
		highlightToggledItems: true,
		actionViewItemProvider: (action, options) => {
			if (action === sidebarToggle?.action) {
				return new SidebarToggleActionViewItem(action, options, sidebarToggle.sidebar);
			}
			if (action === scrollMode?.action) {
				return new DropdownMenuActionViewItem(action, () => scrollMode.choices, {
					showContextMenu: delegate => contextMenus.showContextMenu({
						...delegate,
						getCheckedActionsRepresentation: () => 'radio',
					}),
				}, { ...options, iconOnly: true });
			}
			return new ButtonActionViewItem(action, { ...options, iconOnly: true });
		},
	});
	toolbar.setActions(actions);
	return toolbar;
}

class SidebarToggleActionViewItem extends ButtonActionViewItem {
	constructor(action: IAction, options: ActionViewItemOptions, private readonly sidebar: AuxiliaryBarPart) {
		super(action, { ...options, iconOnly: true });
	}

	override render(container: HTMLElement): void {
		super.render(container);
		this.button.domNode.setAttribute('aria-controls', this.sidebar.domNode.id);
		this.setExpanded(this.sidebar.visible);
		this._register(this.sidebar.onDidChangeVisibility(visible => this.setExpanded(visible)));
		this._register(addDisposableListener(this.sidebar.domNode, 'keydown', event => {
			if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) { return; }
			event.preventDefault();
			event.stopPropagation();
			void this.runActionWithContext();
			this.focus();
		}));
	}

	private setExpanded(expanded: boolean): void {
		this.button.toggleClassName('checked', expanded);
		this.button.domNode.setAttribute('aria-expanded', String(expanded));
	}
}
