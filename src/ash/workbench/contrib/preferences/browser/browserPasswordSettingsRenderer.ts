import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { IBrowserPasswordService, type BrowserPasswordState, type BrowserSavedPassword } from '../../../../platform/browserView/common/browserPasswordService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../nls.js';
import { SettingsPageRenderer } from './settingsRenderers.js';
import type { SettingsSectionReference, SettingsTreeNode } from './settingsTreeModels.js';
import './media/browserPasswordSettingsRenderer.css';

/** Preferences retains metadata only. Password mutations use a new masked input, never a readback. */
export class BrowserPasswordSettingsRenderer extends SettingsPageRenderer<SettingsSectionReference> {
	readonly categoryId = 'browser';
	readonly domNode: HTMLElement;
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly controls = this._register(new DisposableStore());
	private readonly search: InputBox;
	private readonly list: HTMLUListElement;
	private readonly status: HTMLElement;
	private state: BrowserPasswordState = { available: false, entries: [], corrupted: 0 };
	private visible = false;
	private revision = 0;

	constructor(container: HTMLElement,
		@IBrowserPasswordService private readonly passwords: IBrowserPasswordService,
		@IDialogService private readonly dialogs: IDialogService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
		@IConfigurationService configuration: IConfigurationService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-browser-passwords ash-settings-card';
		this.domNode.setAttribute('aria-label', localize('browser.passwords.title', 'Saved website passwords'));
		const title = h(document, 'h4'); title.textContent = localize('browser.passwords.title', 'Saved website passwords');
		const description = h(document, 'p');
		description.textContent = localize('browser.passwords.description', 'Manage encrypted website logins on this device. Accounts are isolated by browser storage session. Password values are never displayed here.');
		this.domNode.append(title, description);
		this.search = this._register(new InputBox(this.domNode, { inputBoxStyles: defaultInputBoxStyles, ariaLabel: localize('browser.passwords.search', 'Search saved accounts'), placeholder: localize('browser.passwords.search', 'Search saved accounts') }));
		this._register(this.search.onDidChange(() => this.renderAccounts()));
		const actions = h(document, 'div'); actions.className = 'ash-browser-passwords-actions'; this.domNode.append(actions);
		for (const [label, run] of [
			[localize('browser.passwords.refresh', 'Refresh saved passwords'), () => this.load()],
			[localize('browser.passwords.clear', 'Delete all saved website passwords'), async () => {
				if ((await this.dialogs.confirm({ message: localize('browser.passwords.clearConfirm', 'Delete all saved website passwords on this device?'), detail: localize('browser.passwords.clearDetail', 'This removes accounts from all browser storage sessions. HTTP and proxy authentication credentials are separate.') })).confirmed) { await this.passwords.clear(); }
			}],
		] as const) {
			const button = this._register(new Button(actions, { ...defaultButtonStyles, label })); button.label = label;
			this._register(button.onDidClick(() => { void this.perform(run); }));
		}
		this.status = h(document, 'p'); this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
		this.list = h(document, 'ul'); this.list.setAttribute('aria-label', localize('browser.passwords.title', 'Saved website passwords'));
		this.domNode.append(this.status, this.list);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(passwords.onDidChange(() => { if (this.visible) { void this.load(); } }));
		const hint = (): void => { this.domNode.setAttribute('aria-description', accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.Browser) ?? ''); };
		hint(); this._register(configuration.onDidChangeConfiguration(event => { if (event.affectsConfiguration(AccessibilityVerbositySettingId.Browser)) { hint(); } }));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, name: 'browser-passwords-' + generateUuid(), priority: 115,
				getProvider: () => {
					const focused = document.activeElement;
					if (!this.visible || !isHTMLElement(focused) || !this.domNode.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.Browser, { type }, () => type === AccessibleViewType.View
						? [title.textContent, this.status.textContent, ...this.state.entries.map(entry => `${entry.origin} ${entry.username}`)].join('\n')
						: localize('browser.passwords.help', 'Saved website passwords\nUse Search saved accounts to filter sites and usernames. Tab reaches Refresh, Delete all, and each account’s Edit and Delete buttons. Editing requires entering a new password; existing passwords are never shown. Escape cancels dialogs. Saved accounts use system encryption and are isolated by browser storage session. The save and autofill switches are in this Browser settings page. Autofill requires interaction with a visible same-origin login form or SPA panel. Username-first login can continue within this page and origin for two minutes. Verification codes are never filled. Agent and ephemeral sessions do not use saved accounts.'),
						() => focused.isConnected ? focused.focus() : this.search.focus(), AccessibilityVerbositySettingId.Browser);
				},
			}));
		}
	}

	protected override buildNodes(): readonly SettingsTreeNode<SettingsSectionReference>[] {
		return [{ element: { kind: 'item', id: 'browser.savedPasswords', title: localize('browser.passwords.title', 'Saved website passwords'), description: localize('browser.passwords.description', 'Manage encrypted website logins on this device. Accounts are isolated by browser storage session. Password values are never displayed here.'), keywords: ['password', 'autofill', 'login', 'credentials'], value: this.retainElement('browser.savedPasswords', this.domNode) } }];
	}
	setVisible(visible: boolean): void { this.visible = visible; this.revision++; if (visible) { void this.load(); } }
	private async load(): Promise<void> {
		const revision = ++this.revision;
		try {
			const state = await this.passwords.readState();
			if (this.isDisposed || !this.visible || revision !== this.revision) { return; }
			this.state = state; this.renderAccounts();
		} catch { if (!this.isDisposed && revision === this.revision) { this.status.textContent = localize('browser.passwords.failed', 'Could not access saved website passwords. Check system encryption and retry.'); } }
	}
	private renderAccounts(): void {
		const restoreFocus = this.list.contains(this.domNode.ownerDocument.activeElement);
		this.controls.clear(); this.list.replaceChildren();
		const query = this.search.value.toLowerCase();
		const entries = this.state.entries.filter(entry => `${entry.origin} ${entry.username}`.toLowerCase().includes(query));
		this.status.textContent = !this.state.available ? localize('browser.passwords.unavailable', 'Website password storage requires Desktop and available system encryption.')
			: this.state.corrupted ? localize('browser.passwords.corrupted', '{0} saved accounts. {1} encrypted records could not be read and have been preserved.', this.state.entries.length, this.state.corrupted)
				: localize('browser.passwords.count', '{0} saved accounts.', this.state.entries.length);
		for (const entry of entries) {
			const row = h(this.list.ownerDocument, 'li');
			const label = h(this.list.ownerDocument, 'span');
			label.textContent = `${entry.origin} · ${entry.username} · ${entry.scope === 'global' ? localize('browser.passwords.global', 'Global') : localize('browser.passwords.workspace', 'Workspace')}`;
			row.append(label); this.list.append(row);
			for (const [label, ariaLabel, run] of [
				[localize('browser.passwords.edit', 'Edit'), localize('browser.passwords.editAccount', 'Edit account {0} on {1}', entry.username, entry.origin), () => this.edit(entry)],
				[localize('browser.passwords.delete', 'Delete'), localize('browser.passwords.deleteAccount', 'Delete account {0} on {1}', entry.username, entry.origin), async () => {
					if ((await this.dialogs.confirm({ message: localize('browser.passwords.deleteConfirm', 'Delete the saved account {0} on {1}?', entry.username, entry.origin) })).confirmed) { await this.passwords.delete(entry.id); }
				}],
			] as const) {
				const button = this.controls.add(new Button(row, { ...defaultButtonStyles, label, ariaLabel, presentation: 'secondary' })); button.label = label;
				this.controls.add(button.onDidClick(() => { void this.perform(run); }));
			}
		}
		if (restoreFocus) { this.search.focus(); }
	}
	private async edit(entry: BrowserSavedPassword): Promise<void> {
		const result = await this.dialogs.input({
			title: localize('browser.passwords.editTitle', 'Edit saved website account'), message: entry.origin,
			inputs: [{ placeholder: localize({ bundle: 'ash.workbench', key: 'browser.auth.username' }, 'Username'), value: entry.username }, { type: 'password', placeholder: localize('browser.passwords.newPassword', 'New password') }],
		});
		if (result.confirmed) {
			if (!result.values?.[0] || !result.values[1]) { this.status.textContent = localize('browser.passwords.required', 'Enter a username and a new password.'); return; }
			await this.passwords.update(entry.id, result.values[0], result.values[1]);
		}
	}
	private async perform(run: () => Promise<void>): Promise<void> {
		try { await run(); if (this.visible && !this.isDisposed) { await this.load(); } }
		catch { if (!this.isDisposed) { this.status.textContent = localize('browser.passwords.failed', 'Could not access saved website passwords. Check system encryption and retry.'); } }
	}
}
