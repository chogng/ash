import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { suite, test } from 'mocha';
import { createTestWorkspace, disposeTestWorkspace } from './testWorkspace.js';

const run = promisify(execFile);

suite('Test workspace Git fixtures', () => {
	test('creates a real three-way conflict without a global Git identity', async () => {
		const home = await mkdtemp(join(tmpdir(), 'ash-git-config-'));
		const config = join(home, 'gitconfig');
		await writeFile(config, '');
		const environment = {
			GIT_CONFIG_GLOBAL: config,
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_CONFIG_COUNT: '0',
			GIT_AUTHOR_NAME: undefined,
			GIT_AUTHOR_EMAIL: undefined,
			GIT_COMMITTER_NAME: undefined,
			GIT_COMMITTER_EMAIL: undefined,
			EMAIL: undefined,
		};
		const previous = new Map(Object.keys(environment).map(key => [key, process.env[key]]));
		try {
			for (const [key, value] of Object.entries(environment)) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			const workspace = await createTestWorkspace({ gitRepository: true, gitMergeConflict: true });
			try {
				const git = async (...args: string[]): Promise<string> => (await run('git', args, { cwd: workspace.directory })).stdout.trim();
				assert.deepEqual({
					unmergedStages: (await git('ls-files', '--unmerged', 'main.ts')).split('\n').map(line => Number(line.split('\t')[0]!.split(' ')[2])),
					base: await git('show', ':1:main.ts'),
					current: await git('show', ':2:main.ts'),
					incoming: await git('show', ':3:main.ts'),
					name: await git('config', '--local', 'user.name'),
					email: await git('config', '--local', 'user.email'),
					globalConfig: await readFile(config, 'utf8'),
				}, {
					unmergedStages: [1, 2, 3],
					base: 'const value = 1;',
					current: 'const value = 3;',
					incoming: 'const value = 2;',
					name: 'Ash Test',
					email: 'ash-test@example.invalid',
					globalConfig: '',
				});
			} finally {
				await disposeTestWorkspace(workspace);
			}
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
			await rm(home, { recursive: true, force: true });
		}
	});
});
