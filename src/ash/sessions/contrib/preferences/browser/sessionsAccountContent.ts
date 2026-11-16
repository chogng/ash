import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { getAccountProviderLabel, IAccountService, type Account, type AccountLoginCompletion, type AccountLoginMethod, type AccountState, type AccountStatus } from '../../../../platform/accounts/common/accountService.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { ILanguageModelsService } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { formatSubscriptionQuota, quotaProviders } from '../../../../workbench/contrib/chat/browser/chatStatus/subscriptionQuota.js';
import { SettingsPageRenderer } from '../../../../workbench/contrib/preferences/browser/settingsRenderers.js';
import { SettingsSectionRenderer } from '../../../../workbench/contrib/preferences/browser/settingsSectionRenderer.js';
import type { SettingsSectionReference, SettingsTreeNode } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';
import type { SettingsSectionField } from '../../../../workbench/services/preferences/common/preferences.js';
import './media/sessionsAccountContent.css';

const loginMethods = new Map<string, AccountLoginMethod>([
	['chatgpt-subscription', { type: 'openAiChatGptBrowser' }],
	['chatgpt-web', { type: 'chatGptWebDeviceCode' }],
	['kimi-subscription', { type: 'kimiDeviceCode' }],
	['xai-subscription', { type: 'xaiDeviceCode' }],
	['bigmodel-coding-plan', { type: 'bigModelBrowser' }],
	['zai-coding-plan', { type: 'zaiBrowser' }],
	['bigmodel-start-plan', { type: 'bigModelStartPlanBrowser' }],
	['zai-start-plan', { type: 'zaiStartPlanBrowser' }],
	['github', { type: 'gitHubBrowser' }],
]);

interface AccountEntry {
	readonly id: string;
	readonly provider: string;
	readonly account?: Account;
	readonly title: string;
	readonly description: string;
	readonly status: AccountStatus | 'disconnected';
	quota: string;
}

interface AccountOperation {
	readonly kind: 'connect' | 'disconnect';
	loginId?: string;
	cancelling?: boolean;
}

const accountHelp = () => localize('sessions.account.help', 'Account settings show subscription usage and reset times below each account. Use Tab to reach Connect or Disconnect beside the account name. Connect starts sign-in in the browser. During sign-in, Cancel stops that attempt. Disconnect signs out only the selected account. External client accounts are read-only. Usage updates when this page opens or account state changes. Accessible View reads account details and usage. Escape closes Settings and cancels pending sign-in attempts.');
const usageKeywords = () => [localize('chat.usage.title', 'Usage'), localize('chat.status.subscriptionQuota', 'Subscription quota'), 'usage', 'quota'];

/** A retained account section and its shared header button have one lifetime. */
class AccountRow extends Disposable {
	public readonly content: SettingsSectionRenderer;
	public readonly header: HTMLElement;
	public readonly button: Button | undefined;
	private readonly title: HTMLElement;
	private restoreFocus = false;

	constructor(container: HTMLElement, entry: () => AccountEntry, activate: () => void,
		@IInstantiationService instantiation: IInstantiationService,
	) {
		super();
		const document = container.ownerDocument;
		this.header = h(document, 'span', { className: 'ash-sessions-account-heading' });
		this.title = h(document, 'span');
		this.header.append(this.title);
		if (loginMethods.has(entry().provider)) {
			this.button = this._register(new Button(this.header, { ...defaultButtonStyles, presentation: 'secondary', label: '' }));
			this._register(this.button.onDidClick(activate));
		}
		this.content = this._register(instantiation.createInstance(SettingsSectionRenderer, container, {
			categoryId: 'account', itemId: entry().id, groupId: `${entry().id}.group`, hideInnerTitle: true,
			keywords: usageKeywords(),
			get title() { return entry().title; },
			get description() { return entry().description; },
			get help() { return accountHelp(); },
			get fields(): readonly SettingsSectionField[] {
				const current = entry();
				return [{ id: 'usage', kind: 'status', text: current.quota }];
			},
		}, AccessibleViewProviderId.SessionsSettings, AccessibilityVerbositySettingId.SessionsSettings));
		this._register(toDisposable(() => this.header.remove()));
	}

	public update(entry: AccountEntry, operation: AccountOperation | undefined): void {
		this.title.textContent = entry.title;
		if (!this.button) { return; }
		let label = entry.status === 'ready'
			? localize('sessions.account.disconnect', 'Disconnect') : localize('sessions.account.connect', 'Connect');
		if (operation) {
			label = operation.cancelling ? localize('sessions.account.cancelling', 'Cancelling…') : operation.loginId
				? localize('sessions.account.cancel', 'Cancel')
				: operation.kind === 'disconnect'
					? localize('sessions.account.disconnecting', 'Disconnecting…') : localize('sessions.account.connecting', 'Connecting…');
		}
		if (this.button.hasFocus()) { this.restoreFocus = true; }
		this.button.label = label;
		this.button.enabled = !operation || !!operation.loginId && !operation.cancelling;
		this.button.domNode.setAttribute('aria-label', localize('sessions.account.actionLabel', '{0}: {1}', label, [entry.title, entry.description].filter(Boolean).join(' · ')));
		this.button.domNode.setAttribute('aria-busy', String(!!operation));
		const document = this.header.ownerDocument;
		if (this.button.enabled && this.restoreFocus && document.activeElement === document.body) { this.button.focus(); }
		if (document.activeElement !== document.body) { this.restoreFocus = false; }
	}
}

/** Projects identity, authentication actions and quota; the account service owns authentication. */
export class SessionsAccountContent extends SettingsPageRenderer<SettingsSectionReference> {
	public readonly categoryId = 'account';
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	private readonly request = this._register(new MutableDisposable());
	private readonly rows = this._register(new DisposableMap<string, AccountRow>());
	private readonly status: SettingsSectionRenderer;
	private readonly operations = new Map<string, AccountOperation>();
	private readonly earlyCompletions = new Map<string, AccountLoginCompletion>();
	private entries: readonly AccountEntry[] = [];
	private visible = false;
	private message = '';

	constructor(private readonly container: HTMLElement,
		@IAccountService private readonly accounts: IAccountService,
		@ILanguageModelsService private readonly languageModels: ILanguageModelsService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		const content = this;
		this.status = this._register(instantiation.createInstance(SettingsSectionRenderer, container, {
			categoryId: this.categoryId, itemId: 'sessions.accounts', title: localize('sessions.settings.account', 'Account'),
			description: '', hideInnerTitle: true, keywords: usageKeywords(),
			get help() { return accountHelp(); },
			get fields(): readonly SettingsSectionField[] { return [{ id: 'state', kind: 'status', text: content.message }]; },
			onDidChange: this.onDidChange,
		}, AccessibleViewProviderId.SessionsSettings, AccessibilityVerbositySettingId.SessionsSettings));
		this._register(accounts.onDidChangeAccounts(state => {
			if (this.visible) { void this.load(state); }
		}));
		this._register(languageModels.onDidChangeModels(() => {
			if (this.visible) { void this.load(); }
		}));
		this._register(accounts.onDidCompleteLogin(completion => {
			const pending = [...this.operations].find(([, operation]) => operation.loginId === completion.loginId);
			if (pending) { this.completeLogin(pending[0], completion); }
			else if ([...this.operations.values()].some(operation => operation.kind === 'connect' && !operation.loginId)) {
				// The browser handoff may delay startLogin's response past the completion event.
				this.earlyCompletions.set(completion.loginId, completion);
			}
		}));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 110, name: `sessions-account-header-${this.rendererId}-${type}`,
				getProvider: () => {
					const focused = container.ownerDocument.activeElement;
					if (!this.visible || !isHTMLElement(focused)) { return undefined; }
					const row = [...this.rows].find(([, row]) => row.header.contains(focused));
					const entry = row && this.entries.find(entry => entry.id === row[0]);
					if (!entry) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.SessionsSettings, { type },
						() => type === AccessibleViewType.Help ? accountHelp() : [entry.title, entry.description, entry.quota].filter(Boolean).join('\n'),
						() => { if (focused.isConnected) { focused.focus(); } }, AccessibilityVerbositySettingId.SessionsSettings);
				},
			}));
		}
		this._register(toDisposable(() => {
			for (const operation of this.operations.values()) {
				if (operation.loginId) { void this.accounts.cancelLogin(operation.loginId).catch(() => undefined); }
			}
			this.operations.clear();
			this.earlyCompletions.clear();
		}));
	}

	protected override buildNodes(): readonly SettingsTreeNode<SettingsSectionReference>[] {
		return [...this.message ? this.retainNodes(this.status) : [], ...this.entries.flatMap(entry => {
			let row = this.rows.get(entry.id);
			if (!row) {
				row = this.instantiation.createInstance(AccountRow, this.container,
					() => this.entries.find(candidate => candidate.id === entry.id)!, () => { void this.activate(entry.id); });
				this.rows.set(entry.id, row);
				row.content.setVisible(this.visible);
			}
			row.update(entry, this.operations.get(entry.id));
			const header = this.retainElement(`${entry.id}.heading`, row.header);
			return this.retainNodes(row.content).map(node => node.element.kind === 'group'
				? { ...node, element: { ...node.element, header } } : node);
		})];
	}

	private retainNodes(source: SettingsSectionRenderer): readonly SettingsTreeNode<SettingsSectionReference>[] {
		const retain = (node: SettingsTreeNode<SettingsSectionReference>): SettingsTreeNode<SettingsSectionReference> => {
			if (node.element.kind === 'item') {
				return { element: { ...node.element, value: this.retainElement(node.element.id, source.renderItem(node.element.value)) } };
			}
			return { ...node, children: node.children?.map(retain) };
		};
		return source.getNodes().map(retain);
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		this.status.setVisible(visible);
		for (const [, row] of this.rows) { row.content.setVisible(visible); }
		if (visible) { void this.load(); }
		else { this.request.clear(); }
	}

	private async activate(id: string): Promise<void> {
		const entry = this.entries.find(entry => entry.id === id);
		if (!entry) { return; }
		const pending = this.operations.get(id);
		if (pending) {
			if (!pending.loginId || pending.cancelling) { return; }
			pending.cancelling = true;
			this.changed.fire();
			try {
				await this.accounts.cancelLogin(pending.loginId);
				if (this.operations.get(id) === pending) { this.operations.delete(id); }
			} catch {
				if (this.operations.get(id) === pending) { pending.cancelling = false; }
				if (!this.isDisposed) { this.notifications.error(localize('sessions.account.cancelFailed', 'Could not cancel sign-in. Try again.')); }
			}
			if (!this.isDisposed) { this.changed.fire(); }
			return;
		}
		const method = loginMethods.get(entry.provider);
		if (!method) { return; }
		const disconnect = entry.status === 'ready' && entry.account !== undefined;
		const operation: AccountOperation = { kind: disconnect ? 'disconnect' : 'connect' };
		this.operations.set(id, operation);
		this.changed.fire();
		try {
			if (disconnect) {
				await this.accounts.logout(entry.provider, entry.account!.accountId);
				this.operations.delete(id);
			} else {
				const challenge = await this.accounts.startLogin(method);
				if (this.isDisposed) {
					if (challenge.type !== 'connected') { await this.accounts.cancelLogin(challenge.loginId); }
					return;
				}
				if (challenge.type === 'connected') { this.operations.delete(id); }
				else {
					operation.loginId = challenge.loginId;
					const completed = this.earlyCompletions.get(challenge.loginId);
					if (completed) { this.completeLogin(id, completed); }
				}
			}
			if (!this.isDisposed && this.visible) { await this.load(); }
		} catch {
			this.operations.delete(id);
			if (!this.isDisposed) {
				this.notifications.error(disconnect
					? localize('sessions.account.disconnectFailed', 'Could not disconnect {0}. Try again.', entry.title)
					: localize('sessions.account.connectFailed', 'Could not connect {0}. Try again.', entry.title));
			}
		} finally {
			if (![...this.operations.values()].some(operation => operation.kind === 'connect' && !operation.loginId)) { this.earlyCompletions.clear(); }
			if (!this.isDisposed) { this.changed.fire(); }
		}
	}

	private completeLogin(id: string, completion: AccountLoginCompletion): void {
		this.operations.delete(id);
		if (completion.status.type === 'failed' && completion.status.failure.code !== 'cancelled') {
			this.notifications.error(localize('sessions.account.connectFailed', 'Could not connect {0}. Try again.', this.entries.find(entry => entry.id === id)?.title ?? ''));
		}
		if (this.visible) { void this.load(completion.account); }
		else { this.changed.fire(); }
	}

	private async load(state?: AccountState): Promise<void> {
		const controller = new AbortController();
		this.request.value = toDisposable(() => controller.abort());
		const active = () => !controller.signal.aborted && !this.isDisposed;
		this.message = this.entries.length ? '' : localize('models.connections.loading', 'Loading subscription accounts…');
		this.changed.fire();
		try {
			const [{ accounts }, providers] = await Promise.all([
				state ?? this.accounts.read(), this.languageModels.listModelProviders().catch(() => []),
			]);
			if (!active()) { return; }
			const labels = new Map(providers.map(provider => [provider.connection, provider.displayName]));
			labels.set('github', 'GitHub');
			const managed = new Set<string>();
			this.entries = accounts.map(account => {
				const id = managed.has(account.provider) ? `sessions.account.${JSON.stringify([account.provider, account.accountId])}` : `sessions.account.${account.provider}`;
				managed.add(account.provider);
				return {
					account, id, provider: account.provider,
					title: labels.get(account.provider) ?? getAccountProviderLabel(account.provider) ?? account.provider,
					description: [account.displayName, account.email ?? account.accountId].filter((value, index, values) => value && values.indexOf(value) === index).join(' · '),
					status: account.status,
					quota: account.status === 'ready' && quotaProviders.has(account.provider) ? localize('chat.status.quotaLoading', 'Loading subscription limits…') : '',
				};
			});
			const available = providers.filter(provider => provider.access === 'subscription' && (provider.configured || loginMethods.has(provider.connection)))
				.map(provider => ({ provider: provider.connection, title: provider.displayName, ready: provider.ready }));
			available.push({ provider: 'github', title: 'GitHub', ready: false });
			const webLabel = getAccountProviderLabel('chatgpt-web');
			if (webLabel) { available.push({ provider: 'chatgpt-web', title: webLabel, ready: false }); }
			this.entries = [...this.entries, ...available.filter(provider => !managed.has(provider.provider)).map(provider => ({
				id: `sessions.account.${provider.provider}`, provider: provider.provider, title: provider.title, description: '',
				status: loginMethods.has(provider.provider) ? 'disconnected' as const : provider.ready ? 'ready' as const : 'unavailable' as const,
				quota: loginMethods.has(provider.provider) ? '' : [localize('chat.status.subscriptionQuota', 'Subscription quota'), localize('chat.status.notReported', 'Not reported')].join(' · '),
			}))];
			const ids = new Set(this.entries.map(entry => entry.id));
			for (const [id] of this.rows) { if (!ids.has(id)) { this.rows.deleteAndDispose(id); } }
			this.message = this.entries.length ? '' : localize('models.connections.none', 'No subscription accounts connected.');
			this.changed.fire();
			await Promise.all(this.entries.map(async entry => {
				if (!entry.account || entry.account.status !== 'ready' || !quotaProviders.has(entry.account.provider)) { return; }
				try {
					const limits = await this.accounts.readRateLimits(entry.account.provider, entry.account.accountId, controller.signal);
					if (!active()) { return; }
					entry.quota = formatSubscriptionQuota(limits, (label, description, detail) => [label, description, detail].filter(Boolean).join(' · ')).join('\n');
				} catch {
					if (!active()) { return; }
					entry.quota = localize('sessions.account.quotaFailed', 'Could not load usage. Reopen Account settings to retry.');
				}
				this.changed.fire();
			}));
		} catch {
			if (!active()) { return; }
			this.message = localize('models.connections.loadFailed', 'Could not load subscription accounts.');
			this.changed.fire();
		}
	}
}
