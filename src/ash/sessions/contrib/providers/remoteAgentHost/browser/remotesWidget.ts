import { addDisposableListener, getWindow, h, isHTMLElement } from '../../../../../base/browser/dom.js';
import type { ContextMenuAnchor } from '../../../../../base/browser/contextmenu.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../../base/browser/ui/dialog/dialog.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { Event } from '../../../../../base/common/event.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../../workbench/browser/parts/dialogs/dialog.js';
import './media/remotesWidget.css';

interface RemoteRow {
	readonly id: string;
	readonly name: string;
	readonly address: string;
	readonly status: { readonly label: string; readonly icon: ThemeIcon; };
	readonly actions: readonly RemoteAction[];
}

interface RemoteAction {
	readonly id: string;
	readonly label: string;
	readonly tooltip: string;
	run(): Promise<unknown> | void;
}

/** One management surface for the window's saved and connected environments. */
export class RemotesWidget extends Disposable {
	private readonly rows = this._register(new DisposableStore());
	private readonly rowMenu = this._register(new MutableDisposable<IDisposable>());
	private readonly dialog: Dialog;
	private readonly body: HTMLTableSectionElement;
	private readonly status: HTMLElement;
	private readonly content: HTMLElement;
	private readonly pending = new Set<string>();
	private loaded = false;

	constructor(
		parent: HTMLElement,
		private readonly getRows: () => readonly RemoteRow[],
		onDidChange: Event<void>,
		private readonly reportError: (error: unknown) => void,
		@IContextMenuService private readonly contextMenus: IContextMenuService,
	) {
		super();
		const document = parent.ownerDocument;
		const content = this.content = h(document, 'div', { className: 'ash-remote-environments' });
		this.status = h(document, 'p', { attributes: { role: 'status' } });
		const table = h(document, 'table');
		const heading = table.createTHead().insertRow();
		for (const label of [localize('sessions.remotes.name', 'Name'), localize('sessions.remotes.status', 'Status'), localize('sessions.remotes.actions', 'Actions')]) {
			const cell = h(document, 'th', { attributes: { scope: 'col' } });
			cell.textContent = label;
			heading.append(cell);
		}
		this.body = table.createTBody();
		content.append(this.status, table);
		this.dialog = this._register(new Dialog(parent, localize('sessions.remotes.title', 'Remote Environments'), [localize('sessions.remotes.close', 'Close')], createWorkbenchDialogOptions({
			cancelId: 0, extraClasses: ['ash-remote-environments-dialog'],
			renderBody: container => container.append(content),
		})));
		this._register(onDidChange(() => this.render()));
		this.render();
	}

	show(): Promise<unknown> { return this.dialog.show(); }

	finishLoading(): void {
		this.loaded = true;
		this.render();
	}

	private render(): void {
		if (this.isDisposed) return;
		this.rowMenu.clear();
		const focused = this.body.contains(this.body.ownerDocument.activeElement)
			? (this.body.ownerDocument.activeElement as HTMLElement).dataset : undefined;
		this.rows.clear();
		this.body.replaceChildren();
		this.body.setAttribute('aria-busy', String(this.pending.size > 0));
		const rows = this.getRows();
		this.status.textContent = !this.loaded ? localize('sessions.remotes.loading', 'Loading saved environments…')
			: rows.length ? '' : localize('sessions.remotes.empty', 'No remote environments');
		for (const row of rows) {
			const element = this.body.insertRow();
			const name = h(this.body.ownerDocument, 'th', { attributes: { scope: 'row' } });
			name.textContent = row.name;
			const address = h(this.body.ownerDocument, 'div', { className: 'ash-remote-environments-address' });
			address.textContent = row.address;
			name.append(address);
			element.append(name);
			const status = h(this.body.ownerDocument, 'span', { className: 'ash-remote-environments-connection-status' });
			appendIcon(row.status.icon, status);
			status.append(h(this.body.ownerDocument, 'span', {}, row.status.label));
			element.insertCell().append(status);
			const actions = h(this.body.ownerDocument, 'div', { className: 'ash-remote-environments-actions' });
			element.insertCell().append(actions);
			for (const action of row.actions) this.addAction(actions, element, row, action);
			this.rows.add(addDisposableListener(element, 'contextmenu', event => this.handleRowMenu(element, row, event)));
			this.rows.add(addDisposableListener(element, 'keydown', event => this.handleRowMenu(element, row, event)));
		}
		if (focused) {
			const buttons = [...this.body.querySelectorAll('button')];
			(buttons.find(button => button.dataset.remoteAction === focused.remoteAction)
				?? buttons.find(button => button.dataset.remoteRow === focused.remoteRow)
				?? buttons[0])?.focus();
		}
	}

	private handleRowMenu(element: HTMLTableRowElement, row: RemoteRow, event: MouseEvent | KeyboardEvent): void {
		if (event.defaultPrevented || row.actions.length === 0) return;
		const fromKeyboard = 'key' in event;
		let anchor: ContextMenuAnchor;
		if (fromKeyboard) {
			if (event.isComposing || event.ctrlKey || event.altKey || event.metaKey || !isHTMLElement(event.target)
				|| !(event.key === 'ContextMenu' && !event.shiftKey || event.key === 'F10' && event.shiftKey)) return;
			anchor = event.target;
		} else {
			anchor = { x: event.clientX, y: event.clientY, targetWindow: getWindow(element) };
		}
		event.preventDefault();
		event.stopPropagation();
		const lifetime = new CancellationTokenSource();
		this.rowMenu.value = toDisposable(() => lifetime.dispose(true));
		this.contextMenus.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => row.actions.map(action => ({
				id: `sessions.remotes.${action.id}`, label: action.label, tooltip: action.tooltip,
				enabled: !this.pending.has(row.id), run: () => this.runAction(element, row.id, action),
			})),
			menuTarget: { element },
			// The browser menu must be mounted inside the native modal dialog's top layer.
			contextViewContainer: this.content,
			autoSelectFirstItem: fromKeyboard,
			cancellationToken: lifetime.token,
		});
	}

	private addAction(parent: HTMLElement, element: HTMLTableRowElement, row: RemoteRow, action: RemoteAction): void {
		const button = this.rows.add(new Button(parent, {
			...defaultButtonStyles, presentation: 'quiet', size: 'small', label: action.label, title: action.tooltip,
		}));
		button.domNode.dataset.remoteAction = JSON.stringify([row.id, action.id]);
		button.domNode.dataset.remoteRow = row.id;
		button.domNode.setAttribute('aria-label', localize('sessions.remotes.rowAction', '{0}: {1}', action.label, row.name));
		button.domNode.setAttribute('aria-description', action.tooltip);
		button.domNode.setAttribute('aria-disabled', String(this.pending.has(row.id)));
		this.rows.add(addDisposableListener(button.domNode, 'click', () => { void this.runAction(element, row.id, action); }));
	}

	private async runAction(element: HTMLTableRowElement, id: string, action: RemoteAction): Promise<void> {
		if (this.isDisposed || !element.isConnected || this.pending.has(id)) return;
		this.pending.add(id);
		this.body.setAttribute('aria-busy', 'true');
		for (const button of element.querySelectorAll('button')) button.setAttribute('aria-disabled', 'true');
		try {
			await action.run();
		} catch (error) {
			this.reportError(error);
		} finally {
			this.pending.delete(id);
			this.render();
		}
	}
}
