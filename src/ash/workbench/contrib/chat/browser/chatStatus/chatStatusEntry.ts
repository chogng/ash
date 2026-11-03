import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { getNLSLanguage, localize } from '../../../../../nls.js';
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

type StatusItem = IQuickPickItem & (
	| { readonly kind: 'command'; readonly commandId: string; readonly args?: readonly unknown[]; }
	| { readonly kind: 'refresh'; }
	| { readonly kind: 'info'; }
);

type QuotaState = { readonly status: 'loading'; } | { readonly status: 'failed'; } | { readonly status: 'loaded'; readonly value: AccountRateLimits; };

// These are the account providers supported by the existing backend usage route.
const quotaProviders = new Set(['chatgpt-subscription', 'kimi-subscription', 'xai-subscription',
	'bigmodel-coding-plan', 'zai-coding-plan', 'bigmodel-start-plan', 'zai-start-plan']);

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
		const value = quota.value;
		const unknown = localize('chat.status.notReported', 'Not reported');
		const rows: StatusItem[] = [];
		if (value.plan) { rows.push(info(localize('chat.status.subscriptionPlan', 'Subscription plan'), value.plan)); }
		if (!value.limits.length && !value.xai) { rows.push(info(title, unknown)); }
		for (const limit of value.limits) {
			const baseName = limit.name ?? limit.id;
			const name = limit.model && limit.model.toLowerCase() !== baseName.toLowerCase() ? `${baseName} · ${limit.model}` : baseName;
			if (limit.limitReached === true || limit.allowed === false) {
				rows.push(info(name, limit.limitReached === true
					? localize('chat.status.quotaReached', 'Limit reached') : localize('chat.status.quotaUnavailable', 'Access unavailable')));
			}
			const windows = [limit.primary, limit.secondary].filter(window => window !== null);
			if (!windows.length) { rows.push(info(name, unknown)); }
			for (const window of windows) {
				const seconds = window.windowSeconds;
				let duration = localize('chat.status.quotaWindow', 'Quota window');
				if (seconds > 0) {
					if (seconds % 86400 === 0) { duration = localize('chat.status.quotaDays', '{0}-day window', seconds / 86400); }
					else if (seconds % 3600 === 0) { duration = localize('chat.status.quotaHours', '{0}-hour window', seconds / 3600); }
					else { duration = localize('chat.status.quotaSeconds', '{0}-second window', seconds); }
				}
				rows.push(info(`${name} · ${duration}`, this.remaining(window.usedPercent), this.resetTime(window.resetsAt === null ? null : window.resetsAt * 1000)));
			}
		}
		if (value.credits) {
			const credits = value.credits;
			let balance = credits.balance ?? localize('chat.status.noCredits', 'No credits available');
			if (credits.unlimited) { balance = localize('chat.status.unlimited', 'Unlimited'); }
			else if (credits.balance === null && credits.hasCredits) { balance = localize('chat.status.creditsAvailable', 'Available; balance not reported'); }
			rows.push(info(localize('chat.status.credits', 'Credits'), balance));
		}
		if (value.xai) {
			const usage = value.xai;
			rows.push(info(title, usage.usedPercent === null ? unknown : this.remaining(usage.usedPercent), this.resetTime(usage.periodEnd === null ? null : Date.parse(usage.periodEnd))));
			if (usage.allowed === false || usage.message) {
				rows.push(info(localize('chat.status.access', 'Subscription access'), usage.message ?? localize('chat.status.quotaUnavailable', 'Access unavailable')));
			}
			for (const [label, cents] of [
				[localize('chat.status.prepaid', 'Prepaid balance'), usage.prepaidCents],
				[localize('chat.status.onDemandUsed', 'On-demand used'), usage.onDemandUsedCents],
				[localize('chat.status.onDemandCap', 'On-demand cap'), usage.onDemandCapCents],
			] as const) {
				// Canonical integer cents stay exact, including values beyond Number's range.
				let amount = unknown;
				if (cents !== null) {
					const negative = cents.startsWith('-');
					const digits = (negative ? cents.slice(1) : cents).padStart(3, '0');
					amount = `USD ${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
				}
				rows.push(info(label, amount));
			}
		}
		return rows.length ? rows : [info(title, unknown)];
	}

	private remaining(usedPercent: number): string {
		return localize('chat.status.remaining', '{0}% remaining ({1}% used)',
			Math.max(0, 100 - usedPercent).toLocaleString(getNLSLanguage(), { maximumFractionDigits: 3 }),
			usedPercent.toLocaleString(getNLSLanguage(), { maximumFractionDigits: 3 }));
	}

	private resetTime(milliseconds: number | null): string {
		const date = milliseconds === null ? undefined : new Date(milliseconds);
		return date && Number.isFinite(date.getTime())
			? localize('chat.status.resetsAt', 'Resets: {0}', date.toLocaleString(getNLSLanguage()))
			: localize('chat.status.resetUnknown', 'Reset time: not reported');
	}
}
