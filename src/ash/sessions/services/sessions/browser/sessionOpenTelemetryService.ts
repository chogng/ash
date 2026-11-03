import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { ILogService } from '../../../../platform/log/common/log.js';

export interface SessionHistoryBindingDiagnostic {
	readonly outcome: 'bound' | 'superseded' | 'cancelled' | 'failed';
	readonly durationMs: number;
	readonly subscriptionMs?: number;
	readonly reconciliationMs?: number;
}

/** Records timings in the local Sessions trace without including conversation identifiers or content. */
export function logSessionHistoryBinding(log: ILogService, onDidFinish: Event<SessionHistoryBindingDiagnostic>): IDisposable {
	return onDidFinish(result => log.trace('sessions.navigation', 'Chat history binding finished', result));
}
