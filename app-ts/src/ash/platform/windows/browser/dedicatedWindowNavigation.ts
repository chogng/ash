/** Resolves a sibling renderer page without depending on a bundler-specific base URL. */
export function resolveDedicatedWindowPageUrl(relativePath: string, locationHref: string): string {
	if (!relativePath.startsWith('../')) throw new TypeError('Dedicated window navigation must stay within a sibling renderer directory');
	return new URL(relativePath, locationHref).href;
}

/** Opens a sibling page in the current browser window. */
export function navigateToDedicatedWindowPage(relativePath: string, location: Location): void {
	location.assign(resolveDedicatedWindowPageUrl(relativePath, location.href));
}

