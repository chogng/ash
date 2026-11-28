import './media/emptyEditor.css';
import { addDisposableListener, getActiveElement, isHTMLElement } from '../../../../base/browser/dom.js';
import { ButtonActionViewItem } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { ActionRunner } from '../../../../base/common/actions.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { MenuWorkbenchToolBar, type IMenuWorkbenchToolBarOptions } from '../../../../platform/actions/browser/toolbar.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import type { IEditorGroupEmptyState, IEditorGroupEmptyStateContext } from '../../../../workbench/browser/parts/editor/editor.js';
import { Menus } from '../../../browser/menus.js';

/** The editor group mounts these commands while its editor list is empty. */
export class EmptyEditor extends Disposable implements IEditorGroupEmptyState {
	readonly element: HTMLElement;
	private readonly toolbar: MenuWorkbenchToolBar;

	constructor(
		context: IEditorGroupEmptyStateContext,
		@IInstantiationService instantiation: IInstantiationService,
		@INotificationService notifications: INotificationService,
	) {
		super();
		const { document, groupId, contextKeyService, contextMenuProvider } = context;
		this.element = document.createElement('div');
		this.element.className = 'ash-empty-editor-group-add-tab';
		const runner = this._register(new ActionRunner());
		this._register(runner.onDidRun(({ error }) => {
			if (error && !isCancellationError(error)) notifications.error(error instanceof Error ? error : String(error));
		}));
		this.toolbar = this._register(instantiation.createInstance(MenuWorkbenchToolBar, this.element, Menus.SessionsEmptyEditorGroupAddTab, {
			ariaLabel: localize({ bundle: 'ash.regions', key: 'addEditorTab' }, 'Add Tab'),
			contextKeyService,
			contextMenuProvider,
			menuOptions: { arg: { groupId } },
			actionRunner: runner,
			actionViewItemProvider: (action, options) => new ButtonActionViewItem(action, {
				...options,
				iconOnly: false,
				buttonPresentation: 'secondary',
			}),
		} satisfies IMenuWorkbenchToolBarOptions));
		this._register(addDisposableListener(this.toolbar.element, 'keydown', event => this.navigateRows(event)));
	}

	focus(): boolean {
		this.toolbar.focus();
		return this.element.contains(this.element.ownerDocument.activeElement);
	}

	private navigateRows(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

		// The toolbar handles sequential navigation. Up and Down follow the rendered
		// columns so they also work after resizing or a context-dependent action change.
		const active = getActiveElement(this.element.ownerDocument);
		const items = Array.from(this.toolbar.element.children).filter(isHTMLElement);
		const current = items.findIndex(item => item.contains(active));
		if (current === -1) return;

		event.preventDefault();
		event.stopPropagation();
		const column = items[current]!.offsetLeft;
		const step = event.key === 'ArrowDown' ? 1 : -1;
		for (let index = current + step; index >= 0 && index < items.length; index += step) {
			if (items[index]!.offsetLeft === column && this.toolbar.getItemAction(index)?.enabled) {
				this.toolbar.focus(index);
				break;
			}
		}
	}
}
