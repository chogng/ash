import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rmdir, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, type Browser, type BrowserContext, type BrowserServer, type Page } from '@playwright/test';
import type { ProcessRun } from '../../build/processes.ts';
import { collectTests, playwrightArguments } from '../../build/playwright.ts';
import { writeScreenshotDiffReport, type ScreenshotFixture, type ScreenshotManifest } from '../../build/lib/screenshotDiffReport.ts';
import { generateBlocksCiMarkdown } from '../../build/lib/screenshotBlocksCi.ts';

interface Sample {
	readonly element: string;
	readonly values: Record<string, string | number>;
}

interface Change {
	readonly element: string;
	readonly property: string;
	readonly baseline: string | number | undefined;
	readonly probe: string | number | undefined;
}

export async function capture(page: Page, selectors: readonly string[]): Promise<{ samples: Sample[]; images: Buffer[]; imageHash: string; }> {
	const samples = await page.evaluate(async selectors => {
		await document.fonts.ready;
		await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		const elements = new Set<Element>();
		for (const selector of selectors) {
			for (const root of document.querySelectorAll(selector)) {
				elements.add(root);
				for (const element of root.querySelectorAll('*')) elements.add(element);
			}
		}
		const identify = (element: Element): string => {
			const parts: string[] = [];
			for (let node: Element | null = element; node; node = node.parentElement) {
				if (node.id) { parts.unshift(`#${node.id}`); break; }
				const index = node.parentElement ? [...node.parentElement.children].indexOf(node) + 1 : 1;
				parts.unshift(`${node.localName}:nth-child(${index})`);
			}
			return parts.join(' > ');
		};
		return [...elements].map(element => {
			const values: Record<string, string | number> = {};
			const sampleStyle = (pseudo?: string): void => {
				const style = getComputedStyle(element, pseudo);
				if (pseudo && (style.content === 'none' || style.content === 'normal')) return;
				for (const property of style) {
					// Theme variables remain fixed; compare their resolved effects on rendered properties.
					// This shorthand serializes differently after minification; its x/y longhands are sampled.
					if (!property.startsWith('--') && property !== 'background-position') values[`${pseudo ?? ''}/${property}`] = style.getPropertyValue(property);
				}
			};
			sampleStyle();
			sampleStyle('::before');
			sampleStyle('::after');
			const bounds = element.getBoundingClientRect();
			for (const property of ['x', 'y', 'width', 'height'] as const) values[`bounds/${property}`] = bounds[property];
			values.scrollWidth = element.scrollWidth;
			values.scrollHeight = element.scrollHeight;
			values.focused = String(document.activeElement === element);
			for (const attribute of ['class', 'aria-selected', 'aria-expanded', 'aria-activedescendant']) {
				values[attribute] = element.getAttribute(attribute) ?? '';
			}
			return { element: identify(element), values };
		});
	}, selectors);
	// Include the popup's owning ContextView, while excluding unrelated content elsewhere in the page.
	const images: Buffer[] = [];
	for (const root of await page.locator(selectors.join(', ')).all()) {
		images.push(await root.screenshot({ animations: 'disabled', caret: 'hide' }));
	}
	const hash = createHash('sha256');
	for (const image of images) hash.update(image);
	return { samples, images, imageHash: hash.digest('hex') };
}

export function changesBetween(baseline: readonly Sample[], probe: readonly Sample[]): Change[] {
	expect(probe.map(sample => sample.element), 'CSS probes must retain the same real component DOM').toEqual(baseline.map(sample => sample.element));
	return baseline.flatMap((sample, index) => {
		const next = probe[index];
		return [...new Set([...Object.keys(sample.values), ...Object.keys(next.values)])]
			.filter(property => sample.values[property] !== next.values[property])
			.map(property => ({ element: sample.element, property, baseline: sample.values[property], probe: next.values[property] }));
	});
}

export async function compareImages(page: Page, baseline: readonly Buffer[], probe: readonly Buffer[]) {
	expect(probe.length, 'Every sampled component must retain its screenshot').toBe(baseline.length);
	return page.evaluate(async ({ baseline, probe }) => {
		const decode = async (base64: string): Promise<ImageData> => {
			const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
			const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
			try {
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const context = canvas.getContext('2d')!;
				context.drawImage(bitmap, 0, 0);
				return context.getImageData(0, 0, bitmap.width, bitmap.height);
			} finally { bitmap.close(); }
		};
		const differences = [];
		for (let index = 0; index < baseline.length; index++) {
			const before = await decode(baseline[index]);
			const after = await decode(probe[index]);
			const sizeChanged = before.width !== after.width || before.height !== after.height;
			let changedPixels = 0;
			let significantPixels = 0;
			let maxChannelDelta = 0;
			if (!sizeChanged) {
				for (let offset = 0; offset < before.data.length; offset += 4) {
					let delta = 0;
					for (let channel = 0; channel < 4; channel++) delta = Math.max(delta, Math.abs(before.data[offset + channel] - after.data[offset + channel]));
					if (delta > 0) changedPixels++;
					// Repainting unchanged HC edges can differ by 1/255. Keep the raw count
					// in the report; only larger changes contribute to the visual verdict.
					if (delta > 1) significantPixels++;
					maxChannelDelta = Math.max(maxChannelDelta, delta);
				}
			}
			differences.push({ index, sizeChanged, changedPixels, significantPixels, maxChannelDelta });
		}
		return differences;
	}, { baseline: baseline.map(image => image.toString('base64')), probe: probe.map(image => image.toString('base64')) });
}

export function expectImagesStable(differences: Awaited<ReturnType<typeof compareImages>>, message: string): void {
	expect(differences.filter(difference => difference.sizeChanged || difference.significantPixels > 0), message).toEqual([]);
}

export class ScanBudgetExceeded extends Error {
	constructor() { super('Scan time budget exceeded'); }
}

async function beforeDeadline<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new ScanBudgetExceeded();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation(), new Promise<never>((_done, reject) => {
			timer = setTimeout(() => reject(new ScanBudgetExceeded()), remaining);
		})]);
	} finally { clearTimeout(timer); }
}

/** Reverses only the selected document slots, retaining all other document positions. */
export function reverseDocuments(count: number, selected: readonly number[] = Array.from({ length: count }, (_, index) => index)): number[] {
	const order = Array.from({ length: count }, (_, index) => index);
	for (const [index, slot] of selected.entries()) order[slot] = selected[selected.length - index - 1];
	return order;
}

/**
 * Bisects an adjacent-swap path from product order to the requested order. Endpoints
 * always have different verdicts; monotonicity is not required. The final two
 * states differ by exactly one adjacent pair, avoiding false pairs where an
 * irrelevant distant document merely moves a real conflict past a third file.
 */
export async function bisectConflict(count: number, changed: (order: readonly number[]) => Promise<boolean>, deadline: number, target: readonly number[] = reverseDocuments(count)) {
	const identity = Array.from({ length: count }, (_, index) => index);
	const state = [...identity];
	const moves: { from: number; to: number; }[] = [];
	for (const [to, document] of target.entries()) {
		const from = state.indexOf(document, to);
		if (from === to) continue;
		moves.push({ from, to });
		state.splice(to, 0, state.splice(from, 1)[0]);
	}
	const orderAfterSwaps = (steps: number): number[] => {
		const order = [...identity];
		for (const { from, to } of moves) {
			if (steps === 0) break;
			const length = Math.min(from - to, steps);
			order.splice(from - length, 0, order.splice(from, 1)[0]);
			steps -= length;
		}
		return order;
	};
	let probes = 0;
	const cache = new Map<number, boolean>();
	const probe = async (steps: number, confirm = false): Promise<boolean> => {
		if (Date.now() >= deadline) throw new ScanBudgetExceeded();
		if (!confirm && cache.has(steps)) return cache.get(steps)!;
		probes++;
		const result = await changed(orderAfterSwaps(steps));
		cache.set(steps, result);
		return result;
	};
	let lo = 0;
	let hi = moves.reduce((sum, { from, to }) => sum + from - to, 0);
	if (count < 2 || await probe(lo) || !await probe(hi)) {
		return { kind: 'unlocalized' as const, indices: [], probes, reason: 'Product order or requested reversal was not reproducible', witness: undefined };
	}
	while (hi - lo > 1) {
		const mid = Math.floor((lo + hi) / 2);
		if (await probe(mid)) hi = mid;
		else lo = mid;
	}
	const before = orderAfterSwaps(lo);
	const after = orderAfterSwaps(hi);
	const indices = before.filter((value, index) => value !== after[index]).sort((left, right) => left - right);
	if (await probe(lo, true) || !await probe(hi, true)) {
		return { kind: 'unlocalized' as const, indices, probes, reason: 'Adjacent pair failed confirmation', witness: undefined };
	}
	return { kind: 'pair' as const, indices, probes, reason: undefined, witness: { before, after } };
}

export interface FixtureScanOptions {
	readonly pattern: string;
	readonly sourcePattern: string;
	readonly budgetMs: number;
	readonly concurrency: number;
	readonly batchSize: number;
}

function normalize(value: unknown): FixtureScanOptions {
	if (!value || typeof value !== 'object') throw new Error('Invalid component fixture options');
	const { pattern, sourcePattern, budgetMs, concurrency, batchSize = 1000 } = value as Partial<FixtureScanOptions>;
	if (typeof pattern !== 'string' || !pattern.trim()) throw new Error('Fixture regex must be nonempty');
	new RegExp(pattern);
	if (typeof sourcePattern !== 'string' || !sourcePattern.trim()) throw new Error('Stylesheet regex must be nonempty');
	new RegExp(sourcePattern);
	if (typeof budgetMs !== 'number' || !Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error('Time budget must be positive');
	if (!Number.isInteger(concurrency) || concurrency! < 1 || concurrency! > 8) throw new Error('Concurrency must be an integer from 1 to 8');
	if (!Number.isSafeInteger(batchSize) || batchSize <= 0) throw new Error('Batch size must be a positive integer');
	return { pattern, sourcePattern, budgetMs, concurrency: concurrency!, batchSize };
}

export function parseFixtureArguments(args: readonly string[]) {
	let pattern = '.*';
	let sourcePattern = '.*';
	let budgetMs = 180_000;
	let concurrency = 4;
	let batchSize = 1000;
	let config = resolve(import.meta.dirname, 'component-explorer.json');
	let out: string | undefined;
	let explore = false;
	let screenshots = false;
	let compare = false;
	let updateScreenshots = false;
	let baselineRef: string | undefined;
	const playwrightArgs: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const argument = args[index];
		if (argument === '--explore') { explore = true; continue; }
		if (argument === '--screenshots') { screenshots = true; continue; }
		if (argument === '--compare') { compare = true; continue; }
		if (argument === '--update-screenshots') { updateScreenshots = screenshots = true; continue; }
		if (['--fixture-id-regex', '--stylesheet-source-regex', '--time-budget-minutes', '--concurrency', '--batch-size', '--config', '--out', '--baseline-ref'].includes(argument)) {
			const value = args[++index];
			if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
			if (argument === '--fixture-id-regex') pattern = value;
			else if (argument === '--stylesheet-source-regex') sourcePattern = value;
			else if (argument === '--concurrency') concurrency = Number(value);
			else if (argument === '--batch-size') batchSize = Number(value);
			else if (argument === '--config') config = resolve(value);
			else if (argument === '--out') out = resolve(value);
			else if (argument === '--baseline-ref') baselineRef = value;
			else budgetMs = Number(value) * 60_000;
		} else playwrightArgs.push(argument);
	}
	if (compare && !args.includes('--config')) config = resolve(import.meta.dirname, 'component-explorer-diff.json');
	if (updateScreenshots && (compare || pattern !== '.*')) throw new Error('Updating screenshot baselines requires a complete current capture');
	return { options: normalize({ pattern, sourcePattern, budgetMs, concurrency, batchSize }), config, out, explore, screenshots, compare, updateScreenshots, baselineRef, playwrightArgs };
}

/** Environment values cross the runner/Playwright process boundary. */
export function readFixtureOptions(): FixtureScanOptions {
	return process.env.ASH_COMPONENT_FIXTURE_OPTIONS
		? normalize(JSON.parse(process.env.ASH_COMPONENT_FIXTURE_OPTIONS))
		: normalize({ pattern: '.*', sourcePattern: '.*', budgetMs: 180_000, concurrency: 4 });
}

interface DocumentSource {
	readonly index: number;
	readonly position: number;
	readonly source: string;
	readonly path: string;
	readonly hash: string;
	readonly selected: boolean;
}

interface RenderDifference {
	readonly styles: ReturnType<typeof changesBetween>;
	readonly images: Awaited<ReturnType<typeof compareImages>>;
}

export interface FixtureScanResult {
	readonly id: string;
	readonly status: 'clean' | 'localized' | 'unlocalized' | 'error' | 'not-scanned';
	readonly detected?: boolean;
	readonly reason?: string;
	readonly documents: readonly DocumentSource[];
	readonly conflict?: readonly DocumentSource[];
	readonly witness?: { readonly before: readonly number[]; readonly after: readonly number[]; };
	readonly difference?: RenderDifference;
	readonly probes: number;
	readonly elapsedMs: number;
}

/** One page is retained for every probe of a fixture; the caller owns and closes it. */
export async function scanFixture(
	page: Page,
	id: string,
	deadline: number,
	sourcePattern: RegExp,
	recordImages: (name: string, images: readonly Buffer[]) => Promise<void>,
	prepare?: (page: Page) => Promise<void>,
): Promise<FixtureScanResult> {
	const started = Date.now();
	let detected: boolean | undefined;
	let documents: DocumentSource[] = [];
	let probes = 0;
	const bounded = <T,>(operation: () => Promise<T>): Promise<T> => beforeDeadline(deadline, operation);
	const finish = (status: FixtureScanResult['status'], reason?: string, conflict?: readonly DocumentSource[]): FixtureScanResult =>
		({ id, status, detected, reason, conflict, documents, probes, elapsedMs: Date.now() - started });
	try {
		await bounded(async () => {
			await page.goto(`/componentFixture.html?fixture=${encodeURIComponent(id)}`);
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			await page.mouse.move(0, 0);
			await prepare?.(page);
		});
		const manifest = await bounded(() => page.evaluate(() => window.componentFixture.documents()));
		const workspace = resolve(import.meta.dirname, '../..');
		documents = manifest.map(({ index, source, text, position }) => {
			const path = source.replace(/^\/(?=[a-z]:\/)/i, '').split('?')[0];
			const label = relative(workspace, path).replaceAll('\\', '/');
			return { index, position, source: label, path, hash: createHash('sha256').update(text).digest('hex'), selected: sourcePattern.test(label) };
		});
		const selected = documents.filter(document => document.selected).map(document => document.index);
		if (!selected.length) return finish('not-scanned', 'No stylesheet documents matched the source filter');
		const selectors = await bounded(() => page.evaluate(() => window.componentFixture.selectors));
		const render = async (order: readonly number[]) => bounded(async () => {
			probes++;
			await page.evaluate(order => window.componentFixture.setOrder(order), order);
			return capture(page, selectors);
		});
		const original = documents.map(document => document.index);
		const baseline = await render(original);
		const control = await render(original);
		expect(changesBetween(baseline.samples, control.samples), 'Unchanged fixture must have stable styles and state').toEqual([]);
		expectImagesStable(await bounded(() => compareImages(page, baseline.images, control.images)), 'Unchanged fixture must have stable pixels');
		await recordImages('baseline', baseline.images);
		const difference = async (before: Awaited<ReturnType<typeof capture>>, after: Awaited<ReturnType<typeof capture>>): Promise<RenderDifference> => ({
			styles: changesBetween(before.samples, after.samples),
			images: await bounded(() => compareImages(page, before.images, after.images)),
		});
		const differs = (difference: RenderDifference): boolean => {
			return difference.styles.length > 0 || difference.images.some(image => image.sizeChanged || image.significantPixels > 0);
		};
		const reversedOrder = reverseDocuments(documents.length, selected);
		const reversed = await render(reversedOrder);
		const reversedDifference = await difference(baseline, reversed);
		detected = differs(reversedDifference);
		let result = finish('clean');
		if (detected) {
			await recordImages('reversed', reversed.images);
			const localization = await bisectConflict(documents.length, async order => differs(await difference(baseline, await render(order))), deadline, reversedOrder);
			if (localization.witness) {
				const slots = localization.indices.map(index => localization.witness!.before.indexOf(index));
				if (Math.abs(documents[slots[0]].position - documents[slots[1]].position) !== 1) {
					return finish('unlocalized', 'Witness crosses an unmapped dynamic stylesheet; a source pair cannot be confirmed');
				}
			}
			const conflict = localization.kind === 'pair' ? localization.indices.map(index => documents[index]) : undefined;
			result = { ...finish(localization.kind === 'pair' ? 'localized' : 'unlocalized', localization.reason, conflict), difference: reversedDifference };
			if (localization.witness) {
				const before = await render(localization.witness.before);
				const after = await render(localization.witness.after);
				await recordImages('witness-before', before.images);
				await recordImages('witness-after', after.images);
				result = {
					...result, difference: await difference(before, after), witness: {
						before: localization.witness.before,
						after: localization.witness.after,
					},
				};
			}
		}
		const restored = await render(original);
		expect(changesBetween(baseline.samples, restored.samples), 'Restoring CSS order must restore fixture state and geometry').toEqual([]);
		expectImagesStable(await bounded(() => compareImages(page, baseline.images, restored.images)), 'Restoring CSS order must restore pixels');
		return { ...result, probes, elapsedMs: Date.now() - started };
	} catch (error) {
		const reason = error instanceof Error ? error.message.split('\n').find(line => line.trim())! : String(error);
		return finish(error instanceof ScanBudgetExceeded ? (detected ? 'unlocalized' : 'not-scanned') : (detected ? 'unlocalized' : 'error'), reason);
	} finally {
		if (!page.isClosed() && Date.now() < deadline) await bounded(() => page.evaluate(() => window.componentFixture?.resetStyles())).catch(() => undefined);
	}
}

export function scanMarkdown(results: readonly FixtureScanResult[]): string {
	const count = (status: FixtureScanResult['status']): number => results.filter(result => result.status === status).length;
	const lines = [
		'# Component CSS order scan', '',
		`Fixtures: ${results.length}; clean: ${count('clean')}; localized: ${count('localized')}; unlocalized: ${count('unlocalized')}; error: ${count('error')}; not scanned: ${count('not-scanned')}.`, '',
		'CSS documents are reordered in their real Vite slots. Dynamic theme styles retain their positions. Binary search follows an adjacent-swap path; the final witness changes only two neighboring source documents. With a source filter, the path can expose a conflict with an unselected document crossed by a selected one. A fixture may contain further conflicts. Incomplete scans remain explicit.', '',
		'| Fixture | Status | Conflict / reason |', '| --- | --- | --- |',
	];
	for (const result of results) {
		const detail = [result.conflict?.map(document => `[${document.source}](<${document.path}>)`).join(' ↔ '), result.reason].filter(Boolean).join('; ') || '—';
		lines.push(`| ${result.id} | ${result.status} | ${detail.replaceAll('|', '\\|')} |`);
	}
	for (const result of results.filter(result => result.detected)) {
		lines.push('', `## Finding: ${result.id}`, '');
		if (result.witness) lines.push(`Witness document order: ${result.witness.before.join(', ')} → ${result.witness.after.join(', ')}`, '');
		if (result.difference) {
			lines.push('```json', JSON.stringify(result.difference, null, 2), '```', '');
		}
	}
	lines.push('', '## CSS source documents', '');
	for (const result of results) {
		lines.push(`### ${result.id}`, '', ...result.documents.map(document => `- ${document.index}: [${document.source}](<${document.path}>) (${document.selected ? 'selected' : 'unselected'}, SHA-256 ${document.hash})`), '');
	}
	return lines.join('\n');
}

/** Each invocation retains its own diagnostics; no shared output is cleared. */
export async function createResultsDirectory(prefix: string, out?: string): Promise<string> {
	if (out) {
		await mkdir(out, { recursive: true });
		return out;
	}
	const parent = resolve(import.meta.dirname, '../../.build/desktop/playwright');
	await mkdir(parent, { recursive: true });
	return mkdtemp(resolve(parent, `${prefix}-`));
}

async function explorerURL(run: ProcessRun, environment: NodeJS.ProcessEnv, configPath: string): Promise<string> {
	const config: unknown = JSON.parse(await readFile(configPath, 'utf8'));
	const server = (config as { server?: { type?: unknown; url?: unknown; cmd?: unknown; cwd?: unknown; wait?: { stdout?: unknown; }; }; } | null)?.server;
	if (server?.type !== 'http' || typeof server.url !== 'string') throw new Error('Explorer config requires an HTTP server URL');
	let url = server.url;
	if (server.cmd !== undefined) {
		if (typeof server.cmd !== 'string' || !server.cmd.trim() || typeof server.cwd !== 'string' || typeof server.wait?.stdout !== 'string') {
			throw new Error('Explorer server command requires cwd and a stdout readiness expression');
		}
		const ready = new RegExp(server.wait.stdout);
		const child = spawn(server.cmd, {
			cwd: resolve(dirname(configPath), server.cwd), env: environment,
			shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
		});
		// The existing process owner retains this root until cleanup, including descendants.
		// Do not kill only the shell here: that would orphan its server before collection.
		const startup = new Promise<RegExpExecArray>((done, reject) => {
			let output = '';
			const timer = setTimeout(() => finish(new Error('Explorer server did not become ready within 30 seconds')), 30_000);
			const finish = (error?: Error, match?: RegExpExecArray): void => {
				clearTimeout(timer);
				child.stdout!.off('data', onData);
				child.off('error', onError);
				child.off('exit', onExit);
				if (error) reject(error);
				else done(match!);
			};
			const onData = (data: Buffer): void => {
				output = (output + data.toString()).slice(-20_000);
				const match = ready.exec(output);
				if (match) finish(undefined, match);
			};
			const onError = (error: Error): void => finish(error);
			const onExit = (code: number | null): void => finish(new Error(`Explorer server exited before readiness (${code})`));
			child.stdout!.on('data', onData);
			child.once('error', onError);
			child.once('exit', onExit);
		});
		child.stderr!.on('data', (data: Buffer) => process.stderr.write(data));
		// Observe startup rejection immediately while process registration is asynchronous.
		const registered = Promise.all([run.own(child), startup]);
		const [, match] = await registered;
		child.stdout!.resume();
		url = url.replace(/\$\{var:([^}]+)\}/g, (_token, name: string) => {
			const value = match.groups?.[name];
			if (!value) throw new Error(`Explorer URL references an unknown readiness variable: ${name}`);
			return value;
		});
	}
	const parsed = new URL(url);
	if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || url.includes('${')) throw new Error('Invalid explorer HTTP URL');
	return parsed.href.replace(/\/$/, '');
}

/** Shared browser owner for the independent scan and single-fixture bisection commands. */
export class Renderer {
	private browserServer: BrowserServer | undefined;
	private browser: Browser | undefined;
	private context: BrowserContext | undefined;
	private readonly configPath: string;
	private readonly outputDirectory: string;

	constructor(configPath: string, outputDirectory: string) {
		this.configPath = configPath;
		this.outputDirectory = outputDirectory;
	}

	async start(run: ProcessRun, environment: NodeJS.ProcessEnv): Promise<void> {
		const baseURL = await explorerURL(run, environment, this.configPath);
		this.browserServer = await chromium.launchServer({ headless: true });
		await run.own(this.browserServer.process());
		this.browser = await chromium.connect(this.browserServer.wsEndpoint());
		this.context = await this.browser.newContext({ baseURL, viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
		console.log(`Component explorer: ${baseURL}/componentExplorer.html`);
	}

	async fixtures(pattern: string): Promise<readonly { id: string; labels: readonly string[]; }[]> {
		const page = await this.context!.newPage();
		try {
			await page.goto('/componentExplorer.html');
			await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
			const catalog = await page.evaluate(() => window.componentExplorer.catalog);
			const fixtures = catalog.filter(entry => new RegExp(pattern).test(entry.id));
			if (!fixtures.length) throw new Error(`No component fixtures matched ${pattern}`);
			return fixtures;
		} finally { await page.close(); }
	}

	async scan(fixtures: readonly { id: string; }[], options: FixtureScanOptions) {
		const deadline = Date.now() + options.budgetMs;
		const results: FixtureScanResult[] = new Array(fixtures.length);
		const images: Record<string, { name: string; path: string; }[]> = {};
		const directory = resolve(this.outputDirectory, 'images');
		await mkdir(directory, { recursive: true });
		for (let offset = 0; offset < fixtures.length; offset += options.batchSize) {
			const end = Math.min(offset + options.batchSize, fixtures.length);
			let next = offset;
			await Promise.all(Array.from({ length: Math.min(options.concurrency, end - offset) }, async () => {
				while (next < end) {
					const index = next++;
					const { id } = fixtures[index];
					if (Date.now() >= deadline) {
						results[index] = { id, status: 'not-scanned', reason: 'Scan time budget exceeded', documents: [], probes: 0, elapsedMs: 0 };
						continue;
					}
					let page: Page | undefined;
					try {
						page = await this.context!.newPage();
						images[id] = [];
						const prefix = createHash('sha256').update(id).digest('hex').slice(0, 16);
						results[index] = await scanFixture(page, id, deadline, new RegExp(options.sourcePattern), async (name, buffers) => {
							for (const [index, buffer] of buffers.entries()) {
								const path = resolve(directory, `${prefix}-${name}-${index}.png`);
								await writeFile(path, buffer);
								images[id].push({ name: `${name}-${index}`, path });
							}
						});
					} catch (error) {
						results[index] = { id, status: 'error', reason: String(error), documents: [], probes: 0, elapsedMs: 0 };
					} finally { await page?.close(); }
					console.log(`${id}: ${results[index].status}${results[index].reason ? ` (${results[index].reason})` : ''}`);
				}
			}));
		}
		return { options, results, images };
	}

	/** Capture the union of actual roots, preserving popup position and overlaps. */
	async screenshots(fixtures: readonly { id: string; labels: readonly string[]; }[], options: FixtureScanOptions): Promise<ScreenshotManifest> {
		const results: ScreenshotFixture[] = new Array(fixtures.length);
		const deadline = Date.now() + options.budgetMs;
		await mkdir(resolve(this.outputDirectory, 'images'), { recursive: true });
		let next = 0;
		await Promise.all(Array.from({ length: Math.min(options.concurrency, fixtures.length) }, async () => {
			while (next < fixtures.length) {
				const index = next++;
				const fixture = fixtures[index];
				let page: Page | undefined;
				try {
					results[index] = await beforeDeadline(deadline, async () => {
						page = await this.context!.newPage();
						page.setDefaultTimeout(Math.max(1, deadline - Date.now()));
						await page.goto(`/componentFixture.html?fixture=${encodeURIComponent(fixture.id)}`);
						await expect(page.locator('body')).toHaveAttribute('data-ready', 'true');
						await page.mouse.move(0, 0);
						const selectors = await page.evaluate(() => window.componentFixture.selectors);
						const image = async (): Promise<Buffer> => {
							const clip = await page!.evaluate(selectors => {
								const bounds = selectors.flatMap(selector => [...document.querySelectorAll(selector)].map(root => root.getBoundingClientRect()));
								const x = Math.max(0, Math.floor(Math.min(...bounds.map(rect => rect.x))));
								const y = Math.max(0, Math.floor(Math.min(...bounds.map(rect => rect.y))));
								return { x, y, width: Math.ceil(Math.max(...bounds.map(rect => rect.right))) - x, height: Math.ceil(Math.max(...bounds.map(rect => rect.bottom))) - y };
							}, selectors);
							return page!.screenshot({ clip, animations: 'disabled', caret: 'hide' });
						};
						const first = await capture(page, selectors);
						const png = await image();
						const second = await capture(page, selectors);
						expect(changesBetween(first.samples, second.samples), 'Screenshot fixture state must be stable').toEqual([]);
						expect(png.equals(await image()), 'Unchanged screenshot must repeat byte for byte').toBe(true);
						const imageHash = createHash('sha256').update(png).digest('hex');
						const imagePath = `images/${imageHash}.png`;
						await writeFile(resolve(this.outputDirectory, imagePath), png);
						return { fixtureId: fixture.id, labels: fixture.labels, imageHash, imagePath };
					});
				} catch (error) {
					results[index] = { fixtureId: fixture.id, labels: fixture.labels, hasError: true, error: String(error) };
				} finally { await page?.close(); }
			}
		}));
		const manifest: ScreenshotManifest = { environment: { platform: process.platform, browserVersion: this.browser!.version() }, fixtures: results };
		await writeFile(resolve(this.outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
		return manifest;
	}

	async dispose(): Promise<void> {
		try { await this.context?.close(); }
		finally {
			try { await this.browser?.close(); }
			finally { await this.browserServer?.close(); }
		}
	}
}

export async function writeScanReport(directory: string, report: Awaited<ReturnType<Renderer['scan']>>): Promise<void> {
	await writeFile(resolve(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
	const lines = [scanMarkdown(report.results), '', '## Captures', ''];
	for (const [id, images] of Object.entries(report.images)) {
		lines.push(`### ${id}`, '', ...images.map(image => `![${image.name}](<${relative(directory, image.path).replaceAll('\\', '/')}>)`), '');
	}
	await writeFile(resolve(directory, 'report.md'), `${lines.join('\n')}\n`);
	console.log(`CSS order report: ${resolve(directory, 'report.md')}`);
}

/** The baseline worktree supplies production sources; both sides use one current fixture harness and toolchain. */
async function runScreenshots(run: ProcessRun, environment: NodeJS.ProcessEnv, request: ReturnType<typeof parseFixtureArguments>): Promise<void> {
	if (request.playwrightArgs.length) throw new Error(`Unexpected screenshot arguments: ${request.playwrightArgs.join(' ')}`);
	if (request.baselineRef && !request.compare) throw new Error('--baseline-ref requires --compare');
	const root = resolve(import.meta.dirname, '../..');
	const config = JSON.parse(await readFile(request.config, 'utf8')) as {
		screenshotDir?: unknown; server?: unknown;
		sessions?: { name?: string; source?: { worktree?: { ref?: string; }; }; }[];
		compare?: { baseline?: string; current?: string; };
	} | null;
	if (!config || typeof config !== 'object') throw new Error('Invalid screenshot configuration');
	if (config.screenshotDir !== undefined && typeof config.screenshotDir !== 'string') throw new Error('Invalid screenshotDir');
	const defaultOut = resolve(dirname(request.config), config.screenshotDir ?? '../../.build/component-fixtures/screenshots');
	const out = resolve(request.out ?? (request.compare ? defaultOut : resolve(defaultOut, 'current')));
	const launchConfig = config.server ? request.config : resolve(import.meta.dirname, 'component-explorer.json');
	if (request.compare) {
		const launch = JSON.parse(await readFile(launchConfig, 'utf8')) as { server?: { cmd?: unknown; }; };
		if (typeof launch.server?.cmd !== 'string') throw new Error('Worktree comparison requires a launch config; an attached server cannot switch production sources');
	}
	const execute = promisify(execFile);
	const git = async (args: readonly string[]): Promise<string> => (await execute('git', [...args], { cwd: root, windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
	let baselineCommit: string | undefined;
	let worktree: string | undefined;
	let worktreeAdded = false;
	if (request.compare) {
		if (!Array.isArray(config.sessions) || !config.compare?.baseline || !config.compare.current || config.compare.baseline === config.compare.current) throw new Error('Comparison requires distinct baseline/current sessions');
		const baseline = config.sessions.find(session => session.name === config.compare!.baseline);
		const current = config.sessions.find(session => session.name === config.compare!.current);
		const ref = request.baselineRef ?? baseline?.source?.worktree?.ref;
		if (!baseline || !current || current.source || typeof ref !== 'string' || !ref.trim()) throw new Error('Comparison needs one current session and a baseline Git worktree ref');
		baselineCommit = await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
		await mkdir(resolve(root, '.build'), { recursive: true });
		worktree = await mkdtemp(resolve(root, '.build/component-fixture-baseline-'));
	}
	const current = new Renderer(launchConfig, request.compare ? resolve(out, 'current') : out);
	let baseline: Renderer | undefined;
	try {
		if (worktree) {
			await git(['-c', 'core.longpaths=true', 'worktree', 'add', '--detach', worktree, baselineCommit!]);
			worktreeAdded = true;
		}
		await current.start(run, { ...environment, ASH_COMPONENT_FIXTURE_SOURCE_ROOT: undefined });
		const fixtures = await current.fixtures(request.options.pattern);
		const manifest = await current.screenshots(fixtures, request.options);
		if (request.updateScreenshots) {
			const markdown = generateBlocksCiMarkdown(manifest, '../../.build/component-fixtures/screenshots/current');
			await writeFile(resolve(import.meta.dirname, 'blocks-ci-screenshots.md'), markdown);
		}
		if (request.compare) {
			baseline = new Renderer(launchConfig, resolve(out, 'baseline'));
			await baseline.start(run, { ...environment, ASH_COMPONENT_FIXTURE_SOURCE_ROOT: resolve(worktree!, 'src/ash') });
			const baselineFixtures = await baseline.fixtures(request.options.pattern);
			await baseline.screenshots(baselineFixtures, request.options);
			const report = await writeScreenshotDiffReport(resolve(out, 'baseline/manifest.json'), resolve(out, 'current/manifest.json'), out, {
				baseline: baselineCommit!, current: await git(['rev-parse', 'HEAD']),
			});
			if (report.summary.error) process.exitCode = 1;
			console.log(`Screenshot comparison: ${resolve(out, 'report.md')}`);
		} else {
			if (manifest.fixtures.some(fixture => fixture.hasError)) process.exitCode = 1;
			console.log(`Screenshot manifest: ${resolve(out, 'manifest.json')}`);
		}
	} finally {
		try {
			const closed = await Promise.allSettled([current.dispose(), baseline?.dispose()]);
			const failures = closed.filter(result => result.status === 'rejected');
			if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Screenshot browser cleanup failed');
		} finally {
			if (worktree) {
				const inside = relative(resolve(root, '.build'), resolve(worktree));
				if (!inside || inside.startsWith('..') || inside.includes('/') || inside.includes('\\') || !inside.startsWith('component-fixture-baseline-')) throw new Error('Refusing to remove an unexpected baseline worktree path');
				// No force: unexpected edits to the owned, read-only worktree must remain recoverable.
				if (worktreeAdded) await git(['-c', 'core.longpaths=true', 'worktree', 'remove', worktree]);
				else await rmdir(worktree);
			}
		}
	}
}

/** Keeps fixture tests on the existing integration runner's selection and process lifecycle. */
export async function runComponentFixtures(run: ProcessRun, environment: NodeJS.ProcessEnv, request: ReturnType<typeof parseFixtureArguments>): Promise<void> {
	const root = resolve(import.meta.dirname, '../..');
	if (request.screenshots || request.compare) {
		await runScreenshots(run, environment, request);
		return;
	}
	const args = playwrightArguments(request.playwrightArgs);
	const cli = ['node_modules/@playwright/test/cli.js', 'test', '--config', 'test/componentFixtures/playwright/playwright.config.ts', ...args];
	const env = { ...environment, ASH_COMPONENT_FIXTURE_OPTIONS: JSON.stringify(request.options) };
	if (!request.explore && !await collectTests(run, cli, args, env)) return;
	const results = await createResultsDirectory('component-fixtures', request.out);
	if (!request.explore) {
		const baseURL = await explorerURL(run, environment, request.config);
		console.log(`Component explorer: ${baseURL}/componentExplorer.html`);
		console.log(`Component fixture results: ${results}`);
		process.exitCode = (await run.command(process.execPath, cli, {
			...env, ASH_EDITOR_BROWSER_BASE_URL: baseURL, ASH_EDITOR_BROWSER_RUN_DIRECTORY: results,
		})).code;
		return;
	}
	const { createServer } = await import('vite');
	const port = process.env.ASH_COMPONENT_EXPLORER_PORT;
	if (port && (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)) throw new Error('Invalid component explorer port');
	const server = await createServer({
		configFile: resolve(root, 'test/integration/browser/vite.config.ts'),
		cacheDir: resolve(results, 'vite-cache'), optimizeDeps: { entries: ['componentExplorer.html', 'componentFixture.html'] },
		server: { host: '127.0.0.1', port: port ? Number(port) : 0, strictPort: !!port, open: false }, logLevel: 'warn',
	});
	try {
		await server.listen();
		const address = server.httpServer?.address();
		if (!address || typeof address === 'string') throw new Error('Component explorer requires a TCP listener');
		console.log(`Component explorer: http://127.0.0.1:${address.port}/componentExplorer.html`);
		await new Promise<void>(done => {
			const stop = (): void => { process.off('SIGINT', stop); process.off('SIGTERM', stop); done(); };
			process.once('SIGINT', stop);
			process.once('SIGTERM', stop);
		});
	} finally { await server.close(); }
}
