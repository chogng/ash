import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { Action, SubmenuAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import type { IMenu } from '../../../../platform/actions/common/actions.js';
import { getFlatContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';

/** The tab strip's Add Tab button can open a launcher with the menu as a secondary action. */
export class EditorAddTabControl extends Disposable {
	readonly element: HTMLElement;

	constructor(container: HTMLElement, menu: IMenu, contextMenus: IContextMenuProvider, groupId?: number, openTab?: () => Promise<unknown>) {
		super();
		this._register(menu);
		const label = localize({ bundle: 'ash.regions', key: 'addEditorTab' }, 'Add Tab');
		const toolbar = this._register(new WorkbenchToolBar(container, contextMenus, {
			ariaLabel: label,
			actionViewItemProvider: (action, options) => action instanceof SubmenuAction
				? new DropdownMenuActionViewItem(action, action.actions, contextMenus, options)
				: undefined,
		}));
		this.element = toolbar.element;
		this.element.classList.add('ash-editor-add-tab');
		const menuEntries = () => getFlatContextMenuActions(menu.getActions(groupId === undefined ? undefined : { arg: { groupId } }));
		if (openTab) {
			const action = this._register(new Action('workbench.editor.addTab', label, undefined, true, openTab));
			action.icon = Lxicon.add;
			toolbar.setActions([action]);
			const showMenu = (event: Event) => {
				const entries = menuEntries();
				const button = this.element.querySelector<HTMLElement>('button');
				if (!entries.length || !button) return;
				event.preventDefault();
				event.stopPropagation();
				contextMenus.showContextMenu({
					getAnchor: () => button, getActions: () => entries,
					onHide: cancelled => { if (cancelled && button.isConnected) button.focus(); },
				});
			};
			this._register(addDisposableListener(this.element, 'contextmenu', showMenu));
			this._register(addDisposableListener(this.element, 'keydown', event => {
				if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showMenu(event);
			}));
			return;
		}
		const render = () => {
			const entries = menuEntries();
			toolbar.setActions(entries.length ? [new SubmenuAction('workbench.editor.addTab', label, entries, Lxicon.add)] : []);
		};
		this._register(menu.onDidChange(render));
		render();
	}
}
