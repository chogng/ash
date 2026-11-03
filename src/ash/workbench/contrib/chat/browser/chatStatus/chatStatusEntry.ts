import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import {
	IAccountService, type Account, type AccountRateLimits, type AccountState, type AccountStatus,
} from '../../../../../platform/accounts/common/accountService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, type IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import type { IWorkbenchContribution } from '../../../../common/contributions.js';
import { IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { IStatusbarService, StatusbarAlignment, type IStatusbarEntryAccessor } from '../../../../services/statusbar/browser/statusbar.js';
import { MANAGE_CHAT_COMMAND_ID } from '../../common/constants.js';
import { formatSubscriptionQuota, quotaProviders } from './subscriptionQuota.js';

type StatusItem = IQuickPickItem & (
	| { readonly kind: 'command'; readonly commandId: string; readonly args?: readonly unknown[]; }
	| { readonly kind: 'refresh'; }
	| { readonly kind: 'info'; }
);

type QuotaState = { readonly status: 'loading'; } | { readonly status: 'failed'; } | { readonly status: 'loaded'; readonly value: AccountRateLimits; };

/** Window-owned account projection; authentication and model access remain service-owned. */
export class ChatStatusBarEntry extends Disposable implements IWorkbenchContribution {
	public static readonly ID = 'workbench.contrib.chatStatusBarEntry';
	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly picker = this._register(new MutableDisposable<DisposableStore>());
	private readonly quotaRequest = this._register(new MutableDisposable());
	private readonly quotas = new Map<string, QuotaState>();
	private state: AccountState | undefined;
	private generation = 0;
	private failed = false;
	private restored = false;
	private updatePicker: (() => void) | undefined;

	constructor(
		@IAccountService private readonly accounts: IAccountService,
		@IChatEntitlementService private readonly entitlement: IChatEntitlementService,
		@IStatusbarService private readonly statusbar: IStatusbarService,
		@IQuickInputService private readonly quickInput: IQuickInputService,
		@ICommandService private readonly commands: ICommandService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
		this._register(accounts.onDidChangeAccounts(state => {
			// An authoritative event retires any older read still in flight.
			this.generation++;
			this.state = state;
			this.failed = false;
			this.quotaRequest.clear();
			this.quotas.clear();
			this.update();
			if (this.picker.value) { this.refreshLimits(); }
		}));
		this._register(entitlement.onDidChangeSentiment(() => {
			this.update();
			if (this.restored && !entitlement.sentiment.hidden) { void this.refresh(); }
		}));
		this.update();
	}

	public onWorkspaceRestored(): void {
		this.restored = true;
		if (!this.entitlement.sentiment.hidden) { void this.refresh(); }
	}

	private async refresh(): Promise<void> {
		const generation = ++this.generation;
		try {
			const state = await this.accounts.read();
			if (this.isDisposed || generation !== this.generation) { return; }
			this.state = state;
			this.failed = false;
		} catch {
			if (this.isDisposed || generation !== this.generation) { return; }
			this.state = undefined;
			this.failed = true;
		}
		this.quotaRequest.clear();
		this.quotas.clear();
		this.update();
		if (this.picker.value) { this.refreshLimits(); }
	}

	private refreshLimits(): void {
		this.quotaRequest.clear();
		const controller = new AbortController();
		this.quotaRequest.value = toDisposable(() => controller.abort());
		this.quotas.clear();
		for (const account of this.state?.accounts ?? []) {
			if (account.status !== 'ready' || !quotaProviders.has(account.provider)) { continue; }
			const key = JSON.stringify([account.provider, account.accountId]);
			this.quotas.set(key, { status: 'loading' });
			void this.accounts.readRateLimits(account.provider, account.accountId, controller.signal).then(value => {
				if (controller.signal.aborted || this.isDisposed) { return; }
				this.quotas.set(key, { status: 'loaded', value });
				this.update();
			}, () => {
				if (controller.signal.aborted || this.isDisposed) { return; }
				this.quotas.set(key, { status: 'failed' });
				this.update();
			});
		}
		this.update();
	}

	private update(): void {
		if (this.entitlement.sentiment.hidden) {
			this.quotaRequest.clear();
			this.quotas.clear();
			this.entry.clear();
			this.picker.clear();
			return;
		}
		let text: string;
		if (this.failed) {
			text = localize('chat.status.unavailable', 'AI · Account status unavailable');
		} else if (!this.state) {
			text = localize('chat.status.loading', 'AI · Checking accounts');
		} else if (this.state.accounts.some(account => account.status !== 'ready')) {
			text = localize('chat.status.attention', 'AI · Accounts need attention');
		} else if ([...this.quotas.values()].some(quota => quota.status === 'loaded' && (
			quota.value.limits.some(limit => limit.limitReached === true || [limit.primary, limit.secondary].some(window => window && window.usedPercent >= 100))
			|| (quota.value.xai?.usedPercent ?? 0) >= 100
		))) {
			text = localize('chat.status.limitReached', 'AI · Subscription limit reached');
		} else if (this.state.accounts.length > 0) {
			text = localize('chat.status.ready', 'AI · Accounts ready');
		} else {
			text = localize('chat.status.noAccounts', 'AI · No subscription accounts');
		}
		const properties = {
			text, ariaLabel: text,
			tooltip: localize('chat.status.tooltip', 'Review AI accounts, configure models, or inspect chat usage'),
			run: () => this.show(),
		};
		if (this.entry.value) { this.entry.value.update(properties); }
		else {
			this.entry.value = this.statusbar.addEntry(properties, {
				id: 'chat.statusBarEntry', alignment: StatusbarAlignment.Right, priority: 100,
			});
		}
		this.updatePicker?.();
	}

	private show(): void {
		if (this.isDisposed || this.entitlement.sentiment.hidden) { return; }
		if (this.picker.value) { this.quickInput.focus(); return; }
		const resources = new DisposableStore();
		this.picker.value = resources;
		const picker = resources.add(this.quickInput.createQuickPick<StatusItem>());
		picker.placeholder = localize('chat.status.placeholder', 'AI status — account status is separate from API model access');
		picker.ariaLabel = picker.placeholder;
		this.updatePicker = () => {
			picker.busy = [...this.quotas.values()].some(quota => quota.status === 'loading');
			const statuses: Record<AccountStatus, string> = {
				ready: localize('chat.status.accountReady', 'Signed in'),
				reauthenticationRequired: localize('chat.status.reauthenticate', 'Sign in again'),
				unavailable: localize('chat.status.accountUnavailable', 'Unavailable'),
			};
			picker.items = [
				...(this.state?.accounts.flatMap(account => [{
					kind: 'command' as const,
					label: account.displayName ?? account.email ?? account.provider,
					description: `${account.provider} · ${statuses[account.status]}`,
					detail: account.plan,
					commandId: 'workbench.action.manageAccounts',
				}, ...this.quotaItems(account)]) ?? []),
				{ kind: 'command', label: localize('chat.status.manageAccounts', 'Manage Accounts'), commandId: 'workbench.action.manageAccounts' },
				{ kind: 'command', label: localize('chat.status.models', 'Configure Model Connections'), commandId: MANAGE_CHAT_COMMAND_ID },
				{
					kind: 'command',
					label: localize('chat.status.usage', 'View Chat Usage'), commandId: 'workbench.action.openSettings',
					args: [{ section: 'chat-usage', jsonEditor: false }],
				},
				{ kind: 'refresh', label: localize('chat.status.refresh', 'Refresh Account Status and Limits') },
			];
		};
		this.updatePicker();
		resources.add(picker.onDidAccept(() => {
			const choice = picker.selectedItems[0];
			if (!choice) { return; }
			if (choice.kind === 'info') { return; }
			if (choice.kind === 'refresh') { void this.refresh(); return; }
			picker.hide();
			if (this.isDisposed || this.entitlement.sentiment.hidden) { return; }
			void this.commands.executeCommand(choice.commandId, ...(choice.args ?? []))
				.catch(error => this.notifications.error(error));
		}));
		resources.add(picker.onDidHide(() => {
			this.quotaRequest.clear();
			this.updatePicker = undefined;
			this.picker.clear();
		}));
		picker.show();
		void this.refresh();
	}

	private quotaItems(account: Account): StatusItem[] {
		if (!quotaProviders.has(account.provider) || account.status !== 'ready') { return []; }
		const quota = this.quotas.get(JSON.stringify([account.provider, account.accountId]));
		const info = (label: string, description: string, detail?: string): StatusItem => {
			const accountName = account.displayName ?? account.email ?? account.accountId;
			const title = `${accountName} · ${label}`;
			const content = [account.provider, title, description, detail].filter(Boolean).join(' · ');
			return { kind: 'info', label: title, description, detail, ariaLabel: content, tooltip: content };
		};
		const title = localize('chat.status.subscriptionQuota', 'Subscription quota');
		if (!quota || quota.status === 'loading') { return [info(title, localize('chat.status.quotaLoading', 'Loading subscription limits…'))]; }
		if (quota.status === 'failed') { return [info(title, localize('chat.status.quotaFailed', 'Could not load limits. Use Refresh to retry.'))]; }
		return formatSubscriptionQuota(quota.value, info);
	}
}
