import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright-core';
import { setup, suiteSetup, suiteTeardown } from 'mocha';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
		const id = createHash('sha256')
			.update(currentTest.file! + currentTest.fullTitle())
			.digest('hex')
			.slice(0, 16);
		const path = resolve(outputRoot, id, ...parts);
		mkdirSync(resolve(path, '..'), { recursive: true });
		return path;
	};
	suiteSetup(async function () {
		this.timeout(60_000);
		// Register after the suite has finished declaring its own teardown hooks.
		// Those hooks still need their live page, as they did under Playwright.
		this.test!.parent!.afterEach('close browser context', async () => {
			try {
				await context?.tracing.stop(currentTest.state === 'failed' || pageErrors.length > 0 ? { path: outputPath('trace.zip') } : {});
			} finally {
				await context?.close();
			}
			assert.deepEqual(pageErrors, [], 'Unhandled browser errors');
		});
		if (!baseURL) throw new Error('Run browser component tests through pnpm test:unit.');
		browser = await chromium.launch();
	});
	setup(async function () {
		currentTest = this.currentTest!;
		pageErrors = [];
		context = await browser.newContext({ viewport: { width: 1280, height: 720 }, baseURL, ...options });
		// Context events also cover popups and errors raised by the suite's teardown.
		context.on('weberror', error => pageErrors.push(`${error.page()?.url() ?? 'Browser'}\n${error.error().stack ?? error.error().message}`));
		await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
		page = await context.newPage();
	});
	suiteTeardown(async () => {
		await browser?.close();
	});
	return {
		get page(): Page {
			return page;
		},
		get context(): BrowserContext {
			return context;
		},
		get browser(): Browser {
			return browser;
		},
		get baseURL(): string {
			return baseURL!;
		},
		timeout(milliseconds: number): void {
			currentTest.timeout(milliseconds);
		},
		info: {
			outputPath,
			async attach(name: string, attachment: { body?: string | Buffer; path?: string; contentType?: string }): Promise<void> {
				const path = outputPath(name.replace(/[^a-zA-Z0-9._-]/gu, '_'));
				if (attachment.body !== undefined) writeFileSync(path, attachment.body);
				else if (attachment.path) copyFileSync(attachment.path, path);
			},
		},
		use(value: BrowserContextOptions): void {
			let previous: BrowserContextOptions;
			suiteSetup(() => {
				previous = options;
				options = { ...options, ...value };
			});
			suiteTeardown(() => {
				options = previous;
			});
		},
	};
}
