/** Retry limits for a connection owner; protocol state and timers stay with that owner. */
export interface IRemoteAgentHostReconnectPolicy {
	readonly autoRestore: boolean;
	readonly initialDelayMs: number;
	readonly maxDelayMs: number;
	readonly maxAttempts: number;
	/** Recovery time excludes intervals reported as OS sleep. */
	readonly maxElapsedTimeMs?: number;
	readonly jitter?: boolean;
}

/** The first scheduled retry is attempt 1. Jitter uses the upper half of the delay. */
export function computeReconnectDelay(policy: IRemoteAgentHostReconnectPolicy, attempt: number, random: () => number = Math.random): number {
	const delay = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** (attempt - 1));
	if (!policy.jitter) {
		return delay;
	}
	const halfDelay = delay / 2;
	return Math.floor(halfDelay + halfDelay * random());
}

/** Counts completed automatic attempts; the initial connection does not consume a retry. */
export function hasExhaustedReconnectAttempts(policy: IRemoteAgentHostReconnectPolicy, attempt: number): boolean {
	return policy.maxAttempts <= attempt;
}
