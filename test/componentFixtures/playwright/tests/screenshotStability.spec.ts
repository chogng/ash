import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { runScreenshotCommand } from './utils.js';

test('real screenshot command is stable across fresh browsers for all four themes', async ({ baseURL }, testInfo) => {
	const first = await runScreenshotCommand(testInfo, 'capture', 'first', baseURL);
	const second = await runScreenshotCommand(testInfo, 'capture', 'second', baseURL);
	expect(first.manifest.fixtures.length).toBeGreaterThanOrEqual(12);
	expect(first.manifest.fixtures.every(fixture => !fixture.hasError && fixture.imageHash && fixture.labels.includes('blocks-ci'))).toBe(true);
	expect(second.manifest).toEqual(first.manifest);
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
