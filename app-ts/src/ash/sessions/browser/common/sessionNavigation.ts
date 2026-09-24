import type { ISessionsWindowApi } from "../../common/sessionsWindow.js";

/** Resolves a sibling renderer page without depending on a bundler-specific base URL. */
export function resolveSessionsPageUrl(relativePath: string, locationHref: string): string {
	if (!relativePath.startsWith("../")) throw new TypeError("Sessions page navigation must stay within a sibling renderer directory");
	return new URL(relativePath, locationHref).href;
}

/** Replaces the current renderer page with a dedicated Sessions or Workbench page. */
export function navigateToSessionsPage(relativePath: string, location: Location): void {
	location.assign(resolveSessionsPageUrl(relativePath, location.href));
}

/** Returns from Sessions by closing its Electron window or navigating in a browser build. */
export function returnToWorkbench(relativePath: string, sessionsWindowApi: ISessionsWindowApi | undefined, location: Location): void {
	if (sessionsWindowApi) {
		void sessionsWindowApi.returnToWorkbench();
		return;
	}
	navigateToSessionsPage(relativePath, location);
}
