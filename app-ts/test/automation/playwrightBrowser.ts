import { chromium, type Browser } from "@playwright/test";
import type { AppServerTestMode } from "./testTarget.js";
import { PlaywrightDriver } from "./playwrightDriver.js";
import { StartupDeadline } from "./startupDeadline.js";

export interface BrowserLaunchOptions {
	readonly appServerMode: AppServerTestMode;
	readonly baseURL: string;
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
	const deadline = new StartupDeadline();
	const browser = await chromium.launch({ headless: options.headless, timeout: deadline.remaining('browser process launch') });
	try {
		const context = await deadline.run('browser context', () => browser.newContext({
			recordVideo: options.recordVideo ? { dir: options.recordVideo.directory, size: options.recordVideo.size } : undefined,
			viewport: options.recordVideo?.size,
		}));
		const videoStartedAt = options.recordVideo ? Date.now() : undefined;
		const page = await deadline.run('browser page', () => context.newPage());
		if (options.appServerMode === 'required') {
			const serialized = process.env.ASH_PLAYWRIGHT_WEB_SESSION;
			if (!serialized) { throw new Error('Run the browser App Server suite through test:smoke:browser:full'); }
			const { endpoint, session } = JSON.parse(serialized) as { endpoint: string; session: { token: string } };
			await deadline.run('Web session setup', () => page.addInitScript(({ endpoint, token }) => {
				if (!sessionStorage.getItem('ash.appServer.endpoint')) {
					sessionStorage.setItem('ash.appServer.endpoint', endpoint);
					sessionStorage.setItem(`ash.appServer.session:${new URL(endpoint).origin}`, token);
				}
			}, { endpoint, token: session.token }));
		}
		const consoleErrors: string[] = [];
		page.on("console", message => {
			if (message.type() === "error") consoleErrors.push(message.text());
		});
		await page.goto(options.baseURL, { waitUntil: "domcontentloaded", timeout: deadline.remaining("browser navigation") });
		if (options.appServerMode === "required") {
			await page.waitForFunction(
				() => (globalThis as { ashWebWorkbenchHost?: unknown }).ashWebWorkbenchHost !== undefined,
				undefined,
				{ timeout: deadline.remaining("Web host initialization") },
			);
		}

		const driver = new PlaywrightDriver(browser, page, consoleErrors);
		await driver.workbench.waitForReady(deadline);
		return { application: browser, driver, videoStartedAt };
	} catch (error) {
		try {
			await browser.close();
		} catch (closeError) {
			throw new AggregateError([error, closeError], 'Browser startup and cleanup failed', { cause: error });
		}
		throw error;
	}
}
