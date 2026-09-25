import { chromium, type Browser } from "@playwright/test";
import type { AppServerTestMode } from "./testTarget.js";
import { PlaywrightDriver } from "./playwrightDriver.js";

export interface BrowserLaunchOptions {
	readonly appServerMode: AppServerTestMode;
	readonly baseURL: string;
}

export interface BrowserLaunchResult {
	readonly application: Browser;
	readonly driver: PlaywrightDriver;
}

/** Launches the browser-hosted Ash Workbench through Playwright. */
export async function launchBrowser(options: BrowserLaunchOptions): Promise<BrowserLaunchResult> {
	const browser = await chromium.launch();
	const context = await browser.newContext();
	const page = await context.newPage();
	if (options.appServerMode === 'required') {
		const serialized = process.env.ASH_PLAYWRIGHT_WEB_SESSION;
		if (!serialized) { throw new Error('Run the browser App Server suite through test:smoke:browser:full'); }
		const { endpoint, session } = JSON.parse(serialized) as { endpoint: string; session: { token: string } };
		await page.addInitScript(({ endpoint, token }) => {
			if (!sessionStorage.getItem('ash.appServer.endpoint')) {
				sessionStorage.setItem('ash.appServer.endpoint', endpoint);
				sessionStorage.setItem(`ash.appServer.session:${new URL(endpoint).origin}`, token);
			}
		}, { endpoint, token: session.token });
	}
	const consoleErrors: string[] = [];
	page.on("console", message => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.goto(options.baseURL, { waitUntil: "domcontentloaded" });
	if (options.appServerMode === "required") {
		await page.waitForFunction(
			() => (globalThis as { ashWebWorkbenchHost?: unknown }).ashWebWorkbenchHost !== undefined,
			undefined,
			{ timeout: 30_000 },
		);
	}

	const driver = new PlaywrightDriver(browser, page, consoleErrors);
	await driver.workbench.waitForReady();
	return { application: browser, driver };
}
