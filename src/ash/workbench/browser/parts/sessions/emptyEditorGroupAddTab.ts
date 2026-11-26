import './media/emptyEditorGroupAddTab.css';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import type { IContextMenuProvider } from '../../../../base/browser/contextmenu.js';
import { ActionRunner } from '../../../../base/common/actions.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { MenuId } from '../../../../platform/actions/common/actions.js';
import { MenuWorkbenchToolBar, type IMenuWorkbenchToolBarOptions } from '../../../../platform/actions/browser/toolbar.js';
import type { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';

/** The editor group mounts these commands while its editor list is empty. */
export class EmptyEditorGroupAddTab extends Disposable {
	readonly element: HTMLElement;
	private readonly toolbar: MenuWorkbenchToolBar;

	constructor(
		document: Document,
		groupId: number,
		menu: MenuId,
		contextKeyService: IContextKeyService | undefined,
		contextMenuProvider: IContextMenuProvider,
		@IInstantiationService instantiation: IInstantiationService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		this.element = document.createElement('div');
		this.element.className = 'ash-empty-editor-group-add-tab';
		const runner = this._register(new ActionRunner());
		this._register(runner.onDidRun(({ error }) => {
			if (error && !isCancellationError(error)) notifications.error(error instanceof Error ? error : String(error));
		}));
		this.toolbar = this._register(instantiation.createInstance(MenuWorkbenchToolBar, this.element, menu, {
			ariaLabel: localize({ bundle: 'ash.regions', key: 'addEditorTab' }, 'Add Tab'),
			contextKeyService,
			contextMenuProvider,
			menuOptions: { arg: { groupId } },
			actionRunner: runner,
			orientation: 'vertical',
			actionViewItemProvider: (action, options) => new ButtonActionViewItem(action, { ...options, iconOnly: false }),
		} satisfies IMenuWorkbenchToolBarOptions));
	}

	focus(): boolean {
		this.toolbar.focus();
		return this.element.contains(this.element.ownerDocument.activeElement);
	}
}
