import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { compareScreenshotManifests, readScreenshotManifest, writeScreenshotDiffReport, type ScreenshotManifest } from '../screenshotDiffReport.ts';

const environment = { platform: 'win32', browserVersion: 'test-browser' };
const fixture = (fixtureId: string, imageHash = 'a'.repeat(64)) => ({
	fixtureId,
	labels: ['blocks-ci'],
	imageHash,
	imagePath: `images/${imageHash}.png`,
});

test('manifest comparison accounts for changed, added, removed and errored fixtures', () => {
	const baseline: ScreenshotManifest = {
		environment,
		fixtures: [fixture('same'), fixture('changed'), fixture('removed')],
	};
	const current: ScreenshotManifest = {
		environment,
		fixtures: [fixture('same'), fixture('changed', 'b'.repeat(64)), fixture('added'), { fixtureId: 'error', labels: [], hasError: true, error: 'Deliberate render error' }],
	};
	const result = compareScreenshotManifests(baseline, current);
	assert.deepEqual(result.summary, { unchanged: 1, changed: 1, added: 1, removed: 1, error: 1 });
	assert.equal(result.entries.find(entry => entry.fixtureId === 'error')?.current?.error, 'Deliberate render error');
	assert.throws(() => compareScreenshotManifests(baseline, { ...current, environment: { ...environment, platform: 'linux' } }), /same platform/);
});

test('manifest boundary rejects missing images, duplicate IDs, escaped paths and corrupt hashes', async () => {
	const directory = await mkdtemp(resolve(tmpdir(), 'ash-screenshot-boundary-'));
	try {
		const path = resolve(directory, 'manifest.json');
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64');
		const hash = createHash('sha256').update(png).digest('hex');
		await mkdir(resolve(directory, 'images'));
		await writeFile(resolve(directory, 'images', `${hash}.png`), png);
		await writeFile(path, JSON.stringify({ environment, fixtures: [fixture('repeat', hash), fixture('repeat', hash)] }));
		await assert.rejects(readScreenshotManifest(path), /unique/);
		await writeFile(path, JSON.stringify({ environment, fixtures: [fixture('missing')] }));
		await assert.rejects(readScreenshotManifest(path), /ENOENT/);
		await writeFile(path, JSON.stringify({ environment, fixtures: [{ ...fixture('escape'), imagePath: '../outside.png' }] }));
		await assert.rejects(readScreenshotManifest(path), /inside/);
		await writeFile(resolve(directory, fixture('corrupt').imagePath), 'not a PNG');
		await writeFile(path, JSON.stringify({ environment, fixtures: [fixture('corrupt')] }));
		await assert.rejects(readScreenshotManifest(path), /PNG or hash/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test('reports copy verified before and after PNGs and retain rendering errors', async () => {
	const directory = await mkdtemp(resolve(tmpdir(), 'ash-screenshot-report-'));
	try {
		const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMioAAAAASUVORK5CYII=', 'base64');
		const hash = createHash('sha256').update(png).digest('hex');
		for (const name of ['baseline', 'current']) {
			await mkdir(resolve(directory, name, 'images'), { recursive: true });
			await writeFile(resolve(directory, name, 'images', `${hash}.png`), png);
		}
		const baseline: ScreenshotManifest = { environment, fixtures: [fixture('removed', hash)] };
		const current: ScreenshotManifest = {
			environment,
			fixtures: [fixture('added', hash), { fixtureId: 'broken', labels: [], hasError: true, error: 'Deliberate fixture failure' }],
		};
		const before = resolve(directory, 'baseline/manifest.json');
		const after = resolve(directory, 'current/manifest.json');
		await writeFile(before, JSON.stringify(baseline));
		await writeFile(after, JSON.stringify(current));
		const report = await writeScreenshotDiffReport(before, after, resolve(directory, 'report'));
		assert.deepEqual(report.summary, { unchanged: 0, changed: 0, added: 1, removed: 1, error: 1 });
		assert.deepEqual(await readFile(resolve(directory, 'report/images', `${hash}.png`)), png);
		const markdown = await readFile(resolve(directory, 'report/report.md'), 'utf8');
		assert.match(markdown, /Deliberate fixture failure/);
		assert.match(markdown, /Baseline \| Current/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
