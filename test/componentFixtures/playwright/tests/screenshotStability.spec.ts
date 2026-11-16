import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { compareImages, expectImagesStable } from '../../cssOrderShared.mts';
import { runScreenshotCommand } from './utils.js';
import { generateBlocksCiMarkdown } from '../../../../build/lib/screenshotBlocksCi.ts';
import type { ScreenshotManifest } from '../../../../build/lib/screenshotDiffReport.ts';

test('real screenshot command is stable across fresh browsers for all four themes', async ({ baseURL, page }, testInfo) => {
	const first = await runScreenshotCommand(testInfo, 'capture', 'first', baseURL);
	const second = await runScreenshotCommand(testInfo, 'capture', 'second', baseURL);
	expect(first.manifest.fixtures.filter(fixture => fixture.labels.includes('blocks-ci')).length).toBeGreaterThanOrEqual(12);
	expect(first.manifest.fixtures.every(fixture => !fixture.hasError && fixture.imageHash)).toBe(true);
	expect(second.manifest.environment).toEqual(first.manifest.environment);
	expect(second.manifest.fixtures.map(({ fixtureId, labels, hasError }) => ({ fixtureId, labels, hasError })))
		.toEqual(first.manifest.fixtures.map(({ fixtureId, labels, hasError }) => ({ fixtureId, labels, hasError })));
	const before = await Promise.all(first.manifest.fixtures.map(fixture => readFile(resolve(first.directory, fixture.imagePath!))));
	const after = await Promise.all(second.manifest.fixtures.map(fixture => readFile(resolve(second.directory, fixture.imagePath!))));
	expectImagesStable(await compareImages(page, before, after), 'All fixtures must retain their pixels across fresh browsers');
});

test('Git baseline comparison uses isolated production sources and removes its temporary worktree', async ({ }, testInfo) => {
	const execute = promisify(execFile);
	const root = resolve(import.meta.dirname, '../../../..');
	const ownedWorktrees = async (): Promise<string[]> => (await execute('git', ['worktree', 'list', '--porcelain'], { cwd: root, windowsHide: true })).stdout
		.split('\n').filter(line => line.startsWith('worktree ') && line.includes('/.build/component-fixture-baseline-'));
	const before = await ownedWorktrees();
	const result = await runScreenshotCommand(testInfo, 'compare', 'comparison');
	const report = JSON.parse(await readFile(resolve(result.directory, 'report.json'), 'utf8')) as { summary: { error: number; }; entries: unknown[]; commits: { baseline: string; current: string; }; };
	expect(report.summary.error).toBe(0);
	expect(report.entries.length).toBe(result.manifest.fixtures.length);
	expect(report.commits.baseline).toMatch(/^[a-f0-9]{40}$/);
	expect(await ownedWorktrees()).toEqual(before);
});


test('approval command bounds RGB rounding and rejects alpha, size and visible changes', async ({ page }, testInfo) => {
	const directory = testInfo.outputPath('approval-policy');
	await mkdir(resolve(directory, 'baselines/images'), { recursive: true });
	await mkdir(resolve(directory, 'images'));
	const images = await page.evaluate(async () => {
		const encode = async (changedPixels: number, delta: number, alpha = 255, width = 8) => {
			const canvas = new OffscreenCanvas(width, 8);
			const context = canvas.getContext('2d')!;
			const pixels = context.createImageData(width, 8);
			for (let pixel = 0; pixel < width * 8; pixel++) pixels.data.set([128 + (pixel < changedPixels ? delta : 0), 128, 128, pixel === 0 ? alpha : 255], pixel * 4);
			context.putImageData(pixels, 0, 0);
			return Array.from(new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()));
		};
		return Promise.all([encode(0, 0), encode(1, 1), encode(1, 2), encode(33, 1), encode(0, 0, 254), encode(0, 0, 255, 9)]);
	});
	const buffers = images.map(bytes => Buffer.from(bytes));
	const hashes = buffers.map(png => createHash('sha256').update(png).digest('hex'));
	const manifest = (index: number): ScreenshotManifest => ({ environment: { platform: process.platform, browserVersion: 'policy-test' }, fixtures: [{ fixtureId: 'test/pixels', labels: ['blocks-ci'], imageHash: hashes[index], imagePath: `images/${hashes[index]}.png` }] });
	await writeFile(resolve(directory, `baselines/images/${hashes[0]}.png`), buffers[0]);
	const markdown = generateBlocksCiMarkdown(manifest(0), 'baselines');
	const markdownPath = resolve(directory, 'blocks-ci-screenshots.md');
	await writeFile(markdownPath, markdown);
	const execute = promisify(execFile);
	for (let index = 1; index < buffers.length; index++) {
		await writeFile(resolve(directory, `images/${hashes[index]}.png`), buffers[index]);
		const manifestPath = resolve(directory, 'manifest.json');
		await writeFile(manifestPath, JSON.stringify(manifest(index)));
		const result = execute(process.execPath, [resolve(import.meta.dirname, '../../../../build/lib/screenshotBlocksCi.ts'), manifestPath, markdownPath, 'baselines'], { windowsHide: true });
		if (index === 1) expect((await result).stdout).toBe(markdown);
		else await expect(result).rejects.toMatchObject({ code: 1 });
		expect(await readFile(markdownPath, 'utf8')).toBe(markdown);
	}
});
