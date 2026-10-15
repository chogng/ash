/** Product pages run in a browser sandbox, with no Node or Workbench bridge. */
export const browserPageScheme = 'ash-browser-page';
export const browserPageRequestHeader = 'X-Ash-Browser-Page';
export const browserPageAccountHeader = 'X-Ash-Browser-Account';
export const browserPageAccountScopeHeader = 'X-Ash-Browser-Account-Scope';

export interface IBrowserPageDescriptor {
	readonly host: string;
	readonly entry: string;
	readonly upstream: string;
	readonly upstreamPaths: readonly string[];
	readonly requestHeaders?: readonly string[];
}
