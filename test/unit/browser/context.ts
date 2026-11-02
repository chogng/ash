import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright-core';
import { setup, suiteSetup, suiteTeardown } from 'mocha';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

/** Real browser fixtures for source-owned Mocha component tests. Each test gets a fresh context. */
export function useBrowserTests() {
	let browser: Browser;
	let context: BrowserContext;
	let page: Page;
	let currentTest: Mocha.Test;
	let pageErrors: string[] = [];
	let options: BrowserContextOptions = {};
	const baseURL = process.env.ASH_BROWSER_UNIT_BASE_URL;
	const outputRoot = process.env.ASH_BROWSER_UNIT_RESULTS;
	const outputPath = (...parts: string[]): string => {
		if (!outputRoot) throw new Error('Run browser component tests through pnpm test:unit.');
		const id = createHash('sha256').update(currentTest.file! + currentTest.fullTitle()).digest('hex').slice(0, 16);
		const path = resolve(outputRoot, id, ...parts);
		mkdirSync(resolve(path, '..'), { recursive: true });
		return path;
	};
	suiteSetup(async function () {
		this.timeout(60_000);
		// Register after the suite has finished declaring its own teardown hooks.
		// Those hooks still need their live page, as they did under Playwright.
		this.test!.parent!.afterEach('close browser context', async () => {
			try { await context?.tracing.stop(currentTest.state === 'failed' || pageErrors.length > 0 ? { path: outputPath('trace.zip') } : {}); }
			finally { await context?.close(); }
			assert.deepEqual(pageErrors, [], 'Unhandled browser errors');
		});
		if (!baseURL) throw new Error('Run browser component tests through pnpm test:unit.');
		browser = await chromium.launch();
	});
	setup(async function () {
		currentTest = this.currentTest!;
		pageErrors = [];
		context = await browser.newContext({ viewport: { width: 1280, height: 720 }, baseURL, ...options });
		await collectBrowserCoverage(context);
		// Context events also cover popups and errors raised by the suite's teardown.
		context.on('weberror', error => pageErrors.push(`${error.page()?.url() ?? 'Browser'}\n${error.error().stack ?? error.error().message}`));
		await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
		page = await context.newPage();
	});
	suiteTeardown(async () => { await browser?.close(); });
	return {
		get page(): Page { return page; },
		get context(): BrowserContext { return context; },
		get browser(): Browser { return browser; },
		get baseURL(): string { return baseURL!; },
		timeout(milliseconds: number): void { currentTest.timeout(milliseconds); },
		info: {
			outputPath,
			async attach(name: string, attachment: { body?: string | Buffer; path?: string; contentType?: string; }): Promise<void> {
				const path = outputPath(name.replace(/[^a-zA-Z0-9._-]/gu, '_'));
				if (attachment.body !== undefined) writeFileSync(path, attachment.body);
				else if (attachment.path) copyFileSync(attachment.path, path);
			},
		},
		use(value: BrowserContextOptions): void {
			let previous: BrowserContextOptions;
			suiteSetup(() => { previous = options; options = { ...options, ...value }; });
			suiteTeardown(() => { options = previous; });
		},
	};
}

/** Collect each page before it closes; keep navigation counts for the whole test. */
async function collectBrowserCoverage(context: BrowserContext): Promise<void> {
	const directory = process.env.ASH_UNIT_COVERAGE_DIRECTORY;
	const assets = process.env.ASH_UNIT_COVERAGE_ASSETS;
	const baseURL = process.env.ASH_BROWSER_UNIT_BASE_URL;
	if (!directory || !assets || !baseURL) return;
	const pages = new Map<Page, Promise<void>>();
	const finish = async (page: Page): Promise<void> => {
		const ready = pages.get(page);
		if (!ready) return;
		pages.delete(page);
		await ready;
		const entries = await page.coverage.stopJSCoverage();
		const result = entries.flatMap(entry => {
			const url = new URL(entry.url, baseURL);
			if (url.origin !== baseURL || !url.pathname.endsWith('.js')) return [];
			const path = resolve(assets, '.' + decodeURIComponent(url.pathname));
			const child = relative(assets, path);
			if (!child || isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`)) throw new Error(`Coverage URL escapes browser assets: ${url.href}`);
			return [{ ...entry, url: pathToFileURL(path).href }];
		});
		writeFileSync(resolve(directory, `browser-${process.pid}-${randomUUID()}.json`), JSON.stringify({ result }));
	};
	const start = (page: Page): Promise<void> => {
		let ready = pages.get(page);
		if (!ready) {
			ready = page.coverage.startJSCoverage({ resetOnNavigation: false });
			pages.set(page, ready);
			const close = page.close.bind(page);
			page.close = async options => { try { await finish(page); } finally { await close(options); } };
		}
		return ready;
	};
	// Start before newPage returns so an immediate goto cannot outrun instrumentation.
	const newPage = context.newPage.bind(context);
	// Popups do not pass through context.newPage. Observe them at creation too;
	// the retained promise is awaited again when the context collects its pages.
	context.on('page', page => { void start(page).catch(() => { }); });
	context.newPage = async () => { const page = await newPage(); await start(page); return page; };
	const close = context.close.bind(context);
	context.close = async options => {
		// A page closed by its own script cannot be flushed afterward. Keep it in
		// this set so collection fails visibly instead of silently losing counts.
		try { await Promise.all([...pages.keys()].map(finish)); }
		finally { await close(options); }
	};
	await Promise.all(context.pages().map(start));
}
