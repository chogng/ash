export type GitAutofetch = false | true | 'all';
export const GitConfiguration = { autofetch: 'git.autofetch', autofetchPeriod: 'git.autofetchPeriod', rebaseWhenSync: 'git.rebaseWhenSync' } as const;

/** Settings values read from the authoritative shared Git profile. */
export interface GitSettings {
	readonly autoFetch: GitAutofetch;
	readonly autoFetchPeriod: number;
	readonly rebaseWhenSync: boolean;
}
