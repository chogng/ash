import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IAccountService, type AccountState } from '../../../../platform/accounts/common/accountService.js';
import type { SettingsSectionField, SettingsSectionModel } from '../../../services/preferences/common/preferences.js';
import { formatSubscriptionQuota, quotaProviders } from './chatStatus/subscriptionQuota.js';

export class SubscriptionUsageSettingsModel extends Disposable implements SettingsSectionModel {
	readonly categoryId = 'chat-usage';
	readonly itemId = 'chat.subscriptionUsage';
	readonly groupId = null;
	get title(): string { return localize('chat.status.subscriptionQuota', 'Subscription quota'); }
	get description(): string { return localize('chat.usage.subscriptionDescription', 'View the usage and reset times reported by connected subscription accounts.'); }
	get help(): string {
		return localize('chat.usage.subscriptionHelp', 'Subscription quota shows account-level limits and reset times. Use Tab to reach Refresh, then open Accessible View to read the reported limits.');
	}

	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly request = this._register(new MutableDisposable());
	private visible = false;
	private text = '';

	constructor(@IAccountService private readonly accounts: IAccountService) {
		super();
		this._register(accounts.onDidChangeAccounts(state => {
			if (this.visible) { void this.load(state); }
		}));
	}

	get fields(): readonly SettingsSectionField[] {
		return [
			{ id: 'quota', kind: 'status', text: this.text },
			{ id: 'refresh', kind: 'action', label: localize('chat.usage.refresh', 'Refresh'), enabled: this.visible, run: () => this.load() },
		];
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		if (visible) { void this.load(); }
		else { this.request.clear(); }
	}

	private async load(state?: AccountState): Promise<void> {
		const controller = new AbortController();
		this.request.value = toDisposable(() => controller.abort());
		this.text = localize('chat.status.quotaLoading', 'Loading subscription limits…');
		this.changed.fire();
		try {
			const { accounts } = state ?? await this.accounts.read();
			if (controller.signal.aborted) { return; }
			const subscriptions = accounts.filter(account => quotaProviders.has(account.provider));
			const sections = await Promise.all(subscriptions.map(async account => {
				const name = account.displayName ?? account.email ?? account.accountId;
				const heading = `${name} · ${account.provider}`;
				if (account.status !== 'ready') {
					const status = account.status === 'reauthenticationRequired'
						? localize('chat.status.reauthenticate', 'Sign in again')
						: localize('chat.status.accountUnavailable', 'Unavailable');
					return `${heading}\n${status}`;
				}
				try {
					const limits = await this.accounts.readRateLimits(account.provider, account.accountId, controller.signal);
					const rows = formatSubscriptionQuota(limits, (label, description, detail) =>
						[label, description, detail].filter(Boolean).join(' · '));
					return [heading, ...rows].join('\n');
				} catch {
					return `${heading}\n${localize('chat.status.quotaFailed', 'Could not load limits. Use Refresh to retry.')}`;
				}
			}));
			if (controller.signal.aborted) { return; }
			this.text = sections.join('\n\n') || localize('chat.usage.noSubscriptions', 'No connected subscription accounts report usage.');
		} catch {
			if (controller.signal.aborted) { return; }
			this.text = localize('chat.status.quotaFailed', 'Could not load limits. Use Refresh to retry.');
		}
		this.changed.fire();
	}
}
