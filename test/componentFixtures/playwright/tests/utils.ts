import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { TestInfo } from '@playwright/test';
import type { Renderer } from '../../cssOrderShared.mts';
import type { ScreenshotManifest } from '../../../../build/lib/screenshotDiffReport.ts';

/** Exercise the shipped command with an attach config, reusing the test's Ash server. */
export async function runCssOrderCommand(testInfo: TestInfo, baseURL: string, mode: 'Scan' | 'Bisect', args: readonly string[]) {
	const config = testInfo.outputPath('component-explorer-attach.json');
	const directory = testInfo.outputPath('command-report');
	await writeFile(config, JSON.stringify({ server: { type: 'http', url: baseURL } }));
	const command = resolve(import.meta.dirname, `../../cssOrder${mode}.mts`);
	const { stdout } = await promisify(execFile)(process.execPath, [command, '--config', config, '--out', directory, ...args], {
		cwd: resolve(import.meta.dirname, '../../../..'), windowsHide: true,
		timeout: testInfo.timeout - 10_000, maxBuffer: 2 * 1024 * 1024,
	});
	console.log(stdout);
	const report = JSON.parse(await readFile(resolve(directory, 'report.json'), 'utf8')) as Awaited<ReturnType<Renderer['scan']>>;
	await testInfo.attach('css-order-report', { path: resolve(directory, 'report.md'), contentType: 'text/markdown' });
	await testInfo.attach('css-source-manifest', { path: resolve(directory, 'report.json'), contentType: 'application/json' });
	for (const images of Object.values(report.images)) {
		for (const image of images) await testInfo.attach(image.name, { path: image.path, contentType: 'image/png' });
	}
	return report;
}

export async function runScreenshotCommand(testInfo: TestInfo, mode: 'capture' | 'compare', name: string, baseURL?: string) {
	const config = testInfo.outputPath(`${name}-config.json`);
	const directory = testInfo.outputPath(name);
	await writeFile(config, JSON.stringify(mode === 'capture' ? { server: { type: 'http', url: baseURL } } : {
		sessions: [{ name: 'current' }, { name: 'baseline', source: { worktree: { ref: 'HEAD' } } }],
		compare: { baseline: 'baseline', current: 'current' },
	}));
	const { stdout } = await promisify(execFile)(process.execPath, [
		resolve(import.meta.dirname, '../../../integration/browser/run.ts'), '--component-fixtures',
		mode === 'capture' ? '--screenshots' : '--compare', '--config', config, '--out', directory,
	], { cwd: resolve(import.meta.dirname, '../../../..'), windowsHide: true, timeout: testInfo.timeout - 10_000, maxBuffer: 2 * 1024 * 1024 });
	console.log(stdout);
	const manifestPath = resolve(directory, mode === 'capture' ? 'manifest.json' : 'current/manifest.json');
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as ScreenshotManifest;
	await testInfo.attach(`${name}-manifest`, { path: manifestPath, contentType: 'application/json' });
	if (mode === 'compare') await testInfo.attach(`${name}-report`, { path: resolve(directory, 'report.md'), contentType: 'text/markdown' });
	return { manifest, directory };
}
