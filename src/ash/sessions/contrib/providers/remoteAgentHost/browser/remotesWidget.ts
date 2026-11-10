import { addDisposableListener, h } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../../base/browser/ui/dialog/dialog.js';
import { appendIcon } from '../../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import type { Event } from '../../../../../base/common/event.js';
import type { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
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
	private readonly dialog: Dialog;
	private readonly body: HTMLTableSectionElement;
	private readonly status: HTMLElement;
	private readonly pending = new Set<string>();
	private loaded = false;

	constructor(
		parent: HTMLElement,
		private readonly getRows: () => readonly RemoteRow[],
		onDidChange: Event<void>,
		private readonly reportError: (error: unknown) => void,
	) {
		super();
		const document = parent.ownerDocument;
		const content = h(document, 'div', { className: 'ash-remote-environments' });
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
		this.dialog = this._register(new Dialog(parent, localize('sessions.remotes.title', 'Remote Environments'), [localize('sessions.remotes.close', 'Close')], {
			buttonStyles: defaultButtonStyles, checkboxStyles: defaultCheckboxStyles,
			inputBoxStyles: defaultInputBoxStyles, dialogStyles: defaultDialogStyles,
			cancelId: 0, extraClasses: ['ash-remote-environments-dialog'],
			renderBody: container => container.append(content),
		}));
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
			for (const action of row.actions) this.addAction(this.rows, actions, row.id, action, row.name);
		}
		if (focused) {
			const buttons = [...this.body.querySelectorAll('button')];
			(buttons.find(button => button.dataset.remoteAction === focused.remoteAction)
				?? buttons.find(button => button.dataset.remoteRow === focused.remoteRow)
				?? buttons[0])?.focus();
		}
	}

	private addAction(store: DisposableStore, parent: HTMLElement, id: string, action: RemoteAction, name?: string): void {
		const button = store.add(new Button(parent, {
			...defaultButtonStyles, presentation: 'quiet', size: 'small', label: action.label, title: action.tooltip,
		}));
		button.domNode.dataset.remoteAction = JSON.stringify([id, action.id]);
		button.domNode.dataset.remoteRow = id;
		if (name) button.domNode.setAttribute('aria-label', localize('sessions.remotes.rowAction', '{0}: {1}', action.label, name));
		button.domNode.setAttribute('aria-description', action.tooltip);
		button.domNode.setAttribute('aria-disabled', String(this.pending.has(id)));
		store.add(addDisposableListener(button.domNode, 'click', () => {
			if (this.pending.has(id)) return;
			this.pending.add(id);
			this.body.setAttribute('aria-busy', 'true');
			button.domNode.setAttribute('aria-busy', 'true');
			button.domNode.setAttribute('aria-disabled', 'true');
			void Promise.resolve().then(() => action.run()).catch(this.reportError).finally(() => {
				this.pending.delete(id);
				button.domNode.removeAttribute('aria-busy');
				button.domNode.setAttribute('aria-disabled', 'false');
				this.render();
			});
		}));
	}
}
