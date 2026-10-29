import { chromium, type Browser } from '@playwright/test';
import type { AppServerTestMode } from './testTarget.js';
import { PlaywrightDriver, WorkbenchDiagnostics } from './playwrightDriver.js';

export interface BrowserLaunchOptions {
	readonly appServerMode: AppServerTestMode;
	readonly baseURL: string;
	readonly webSession?: { readonly endpoint: string; readonly token: string };
	readonly headless?: boolean;
	readonly recordVideo?: {
		readonly directory: string;
		readonly size: { readonly width: number; readonly height: number };
	};
}

export interface BrowserLaunchResult {
	readonly application: Browser;
	readonly driver: PlaywrightDriver;
	readonly videoStartedAt?: number;
}

/** Launches the browser-hosted Ash Workbench through Playwright. */
export async function launchBrowser(options: BrowserLaunchOptions): Promise<BrowserLaunchResult> {
	const webSession = options.webSession;
	if (options.appServerMode === 'required' && !webSession) {
		throw new Error('A connected browser requires its scenario Web session');
	}
	const browser = await chromium.launch({ headless: options.headless });
	let diagnostics: WorkbenchDiagnostics | undefined;
	try {
		const context = await browser.newContext({
			baseURL: options.baseURL,
			recordVideo: options.recordVideo ? { dir: options.recordVideo.directory, size: options.recordVideo.size } : undefined,
			viewport: options.recordVideo?.size,
		});
		diagnostics = new WorkbenchDiagnostics(context);
		const videoStartedAt = options.recordVideo ? Date.now() : undefined;
		const page = await context.newPage();
		if (webSession) {
			const { endpoint, token } = webSession;
			await context.addInitScript(
				({ endpoint, token, origin }) => {
					if (location.origin !== origin) return;
					if (!sessionStorage.getItem('ash.appServer.endpoint')) {
						sessionStorage.setItem('ash.appServer.endpoint', endpoint);
						sessionStorage.setItem(`ash.appServer.session:${new URL(endpoint).origin}`, token);
					}
				},
				{ endpoint, token, origin: new URL(options.baseURL).origin },
			);
		}
		await page.goto(options.baseURL, { waitUntil: 'domcontentloaded' });
		if (options.appServerMode === 'required') {
			await page.waitForFunction(() => (globalThis as { ashWebWorkbenchHost?: unknown }).ashWebWorkbenchHost !== undefined, undefined, { timeout: 30_000 });
		}

		const driver = new PlaywrightDriver(browser, page, diagnostics);
		await driver.workbench.waitForReady();
		return { application: browser, driver, videoStartedAt };
	} catch (error) {
		const startupErrors = [...(diagnostics?.pageErrors ?? []), ...(diagnostics?.consoleErrors ?? [])];
		await browser.close();
		if (startupErrors.length > 0) {
			throw new Error(`Browser Workbench startup failed:\n${startupErrors.join('\n')}`, { cause: error });
		}
		throw error;
	}
}
