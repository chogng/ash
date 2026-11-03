import { getNLSLanguage, localize } from '../../../../../nls.js';
import type { AccountRateLimits } from '../../../../../platform/accounts/common/accountService.js';

// These are the account providers supported by the existing backend usage route.
export const quotaProviders = new Set(['chatgpt-subscription', 'kimi-subscription', 'xai-subscription',
	'bigmodel-coding-plan', 'zai-coding-plan', 'bigmodel-start-plan', 'zai-start-plan']);

export function formatSubscriptionQuota<T>(value: AccountRateLimits, info: (label: string, description: string, detail?: string) => T): T[] {
	const title = localize('chat.status.subscriptionQuota', 'Subscription quota');
	const unknown = localize('chat.status.notReported', 'Not reported');
	const rows: T[] = [];
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
			rows.push(info(`${name} · ${duration}`, remaining(window.usedPercent), resetTime(window.resetsAt === null ? null : window.resetsAt * 1000)));
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
		rows.push(info(title, usage.usedPercent === null ? unknown : remaining(usage.usedPercent), resetTime(usage.periodEnd === null ? null : Date.parse(usage.periodEnd))));
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

function remaining(usedPercent: number): string {
	return localize('chat.status.remaining', '{0}% remaining ({1}% used)',
		Math.max(0, 100 - usedPercent).toLocaleString(getNLSLanguage(), { maximumFractionDigits: 3 }),
		usedPercent.toLocaleString(getNLSLanguage(), { maximumFractionDigits: 3 }));
}

function resetTime(milliseconds: number | null): string {
	const date = milliseconds === null ? undefined : new Date(milliseconds);
	return date && Number.isFinite(date.getTime())
		? localize('chat.status.resetsAt', 'Resets: {0}', date.toLocaleString(getNLSLanguage()))
		: localize('chat.status.resetUnknown', 'Reset time: not reported');
}
