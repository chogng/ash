import { normalizeBrowserViewUrl } from "./browserView.js";

/** One host-owned mapping between the URL shown to callers and the URL loaded by Electron. */
export interface BrowserViewNavigation {
	readonly requestedUrl: string;
	readonly loadUrl: string;
	ownsRequestedUrl(url: string): boolean;
	ownsLoadedUrl(url: string): boolean;
	loadUrlFor(requestedUrl: string): string;
	requestedUrlFor(loadedUrl: string): string;
	isReusable(): boolean;
	release(): void;
}

/** Resolves one validated Browser URL and owns any host resource needed to load it. */
export interface IBrowserViewNavigationResolver {
	resolve(url: string, signal: AbortSignal): Promise<BrowserViewNavigation>;
}

/** Creates a resource-free navigation whose requested and loaded origins are identical. */
export function directBrowserViewNavigation(value: string): BrowserViewNavigation {
	const url = normalizeBrowserViewUrl(value);
	return new DirectBrowserViewNavigation(url);
}

class DirectBrowserViewNavigation implements BrowserViewNavigation {
	readonly requestedUrl: string;
	readonly loadUrl: string;
	private readonly origin: string;

	constructor(url: string) {
		this.requestedUrl = url;
		this.loadUrl = url;
		this.origin = new URL(url).origin;
	}

	ownsRequestedUrl(url: string): boolean {
		return this.owns(url);
	}

	ownsLoadedUrl(url: string): boolean {
		return this.owns(url);
	}

	loadUrlFor(requestedUrl: string): string {
		const url = normalizeBrowserViewUrl(requestedUrl);
		if (!this.owns(url)) throw new Error("Direct Browser navigation does not own the requested URL");
		return url;
	}

	requestedUrlFor(loadedUrl: string): string {
		const url = normalizeBrowserViewUrl(loadedUrl);
		if (!this.owns(url)) throw new Error("Direct Browser navigation does not own the loaded URL");
		return url;
	}

	isReusable(): boolean {
		return true;
	}

	release(): void {}

	private owns(value: string): boolean {
		const url = normalizeBrowserViewUrl(value);
		return new URL(url).origin === this.origin;
	}
}
