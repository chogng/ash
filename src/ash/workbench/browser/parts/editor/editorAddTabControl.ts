import { DropdownMenuActionViewItem } from '../../../../base/browser/ui/dropdown/dropdownMenuActionViewItem.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { SubmenuAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import type { IMenu } from '../../../../platform/actions/common/actions.js';
import { getFlatContextMenuActions } from '../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { WorkbenchToolBar } from '../../../../platform/actions/browser/toolbar.js';

/** Opens the editor group's menu of tab types. */
export class EditorAddTabControl extends Disposable {
	readonly element: HTMLElement;

	constructor(container: HTMLElement, menu: IMenu, contextMenus: IContextMenuProvider, groupId?: number) {
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
		const render = () => {
			const entries = menuEntries();
			toolbar.setActions(entries.length ? [new SubmenuAction('workbench.editor.addTab', label, entries, Lxicon.add)] : []);
		};
		this._register(menu.onDidChange(render));
		render();
	}
}
