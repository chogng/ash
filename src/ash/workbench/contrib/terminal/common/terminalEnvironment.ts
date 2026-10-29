/** Merges overrides in place; null remains a deletion instruction for the execution host. */
export function mergeEnvironments(parent: Record<string, string | null>, other: Readonly<Record<string, string | null>> | undefined, caseSensitive: boolean): void {
	if (!other) return;
	for (const [key, value] of Object.entries(other)) {
		const existing = caseSensitive ? key : (Object.keys(parent).find(candidate => candidate.toLowerCase() === key.toLowerCase()) ?? key);
		Object.defineProperty(parent, existing, { value, enumerable: true, configurable: true, writable: true });
	}
}

/** Resolves launch overrides without changing the execution host's inherited environment. */
export async function createTerminalEnvironment(overrides: Readonly<Record<string, string | null>>, resolve: (value: string) => Promise<string>): Promise<Record<string, string | null>> {
	return Object.fromEntries(await Promise.all(Object.entries(overrides).map(async ([key, value]) => [key, value === null ? null : await resolve(value)])));
}
