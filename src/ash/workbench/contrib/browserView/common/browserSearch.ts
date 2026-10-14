export enum BrowserSearchEngineId { Bing = 'bing', Google = 'google', Yahoo = 'yahoo', DuckDuckGo = 'duckduckgo' }
export const BrowserSearchEngineSettingId = 'workbench.browser.searchEngine';
export const BROWSER_SEARCH_NONE = 'none';
export type BrowserSearchEngineValue = BrowserSearchEngineId | typeof BROWSER_SEARCH_NONE;
export type AddressBarInputKind = 'empty' | 'url' | 'query' | 'unknown';

/** Classify user text without loading it or granting it network authority. */
export function resolveAddressBarInputType(rawInput: string): AddressBarInputKind {
	const input = rawInput.trim();
	if (!input) { return 'empty'; }
	if (/^[a-z][a-z\d+.-]*:/iu.test(input) && !/^localhost:\d/iu.test(input)) { return 'url'; }
	if (/\s/u.test(input)) { return 'query'; }
	const authority = input.split(/[/?#]/u, 1)[0]!;
	if (authority.includes('@')) { return 'unknown'; }
	if (/^(localhost|\[[\da-f:]+\]|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/iu.test(authority)) { return 'url'; }
	if (/^[^:]+:\d+$/u.test(authority) || input.endsWith('/')) { return 'url'; }
	return /\.[a-z]{2,}(?::\d+)?$/iu.test(authority) ? 'url' : 'unknown';
}

export function buildSearchUrl(query: string, engineId: BrowserSearchEngineId): string {
	const encoded = encodeURIComponent(query.trim().replace(/\s+/gu, ' ')).replace(/%20/gu, '+');
	switch (engineId) {
		case BrowserSearchEngineId.Google: return 'https://www.google.com/search?q=' + encoded;
		case BrowserSearchEngineId.Yahoo: return 'https://search.yahoo.com/search?p=' + encoded;
		case BrowserSearchEngineId.DuckDuckGo: return 'https://duckduckgo.com/?q=' + encoded;
		default: return 'https://www.bing.com/search?q=' + encoded;
	}
}
