import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite, test } from 'mocha';
import { Event } from '../../../../base/common/event.js';
import { InstantiationService } from '../../../instantiation/common/instantiationService.js';
import { IMeteredConnectionService } from '../../../meteredConnection/common/meteredConnection.js';
import { UpdateMainService } from '../../electron-main/updateMainService.js';

suite('Desktop update download cleanup', () => {
	test('a new process removes owned downloads and preserves unknown content and worktrees', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'ash-update-cleanup-'));
		try {
			const updates = join(directory, 'updates');
			for (const name of [
				'release-owned',
				'release-legacy',
				'release-unknown',
				'release-worktree',
				'release-linked',
				'release-framework',
			]) {
				await mkdir(join(updates, name), { recursive: true });
			}
			const marker = JSON.stringify({ schemaVersion: 1, product: 'ash-desktop' });
			await writeFile(join(updates, 'release-owned', 'stage.json'), marker);
			await writeFile(join(updates, 'release-owned', 'download.exe'), 'download');
			await writeFile(join(updates, 'release-legacy', 'AshSetup-1.2.3-win32-x64.exe'), 'old download');
			await writeFile(join(updates, 'release-unknown', 'notes.txt'), 'user notes');
			await writeFile(join(updates, 'release-worktree', 'stage.json'), marker);
			await mkdir(join(updates, 'release-worktree', '.git'));
			await writeFile(join(updates, 'release-worktree', 'draft.txt'), 'uncommitted');
			const outside = join(directory, 'outside');
			await mkdir(outside);
			await writeFile(join(outside, 'important'), 'keep');
			await writeFile(join(updates, 'release-linked', 'stage.json'), marker);
			await symlink(
				outside,
				join(updates, 'release-linked', 'link'),
				process.platform === 'win32' ? 'junction' : 'dir',
			);
			await writeFile(join(updates, 'release-framework', 'stage.json'), marker);
			await mkdir(join(updates, 'release-framework', 'Versions'));
			await writeFile(join(updates, 'release-framework', 'Versions', 'binary'), 'framework');
			await symlink(
				join(updates, 'release-framework', 'Versions'),
				join(updates, 'release-framework', 'Current'),
				process.platform === 'win32' ? 'junction' : 'dir',
			);

			using services = new InstantiationService();
			services.registerInstance(IMeteredConnectionService, {
				_serviceBrand: undefined,
				isConnectionMetered: true,
				onDidChangeIsConnectionMetered: Event.None,
				whenConnectionStateInitialized: Promise.resolve(),
			});
			using update = services.createInstance(UpdateMainService, async () => { }, {
				isPackaged: true,
				getPath: () => directory,
				getVersion: () => '1.2.4',
				getAppPath: () => directory,
				quit: () => { },
				relaunch: () => { },
			});
			assert.equal(await update.checkAutomatically('latest'), undefined);
			await assert.rejects(readFile(join(updates, 'release-owned', 'download.exe')), { code: 'ENOENT' });
			await assert.rejects(readFile(join(updates, 'release-legacy', 'AshSetup-1.2.3-win32-x64.exe')), {
				code: 'ENOENT',
			});
			assert.equal(await readFile(join(updates, 'release-unknown', 'notes.txt'), 'utf8'), 'user notes');
			assert.equal(await readFile(join(updates, 'release-worktree', 'draft.txt'), 'utf8'), 'uncommitted');
			assert.equal(await readFile(join(outside, 'important'), 'utf8'), 'keep');
			if (process.platform === 'darwin')
				await assert.rejects(readFile(join(updates, 'release-framework', 'stage.json')), { code: 'ENOENT' });
			else assert.equal(await readFile(join(updates, 'release-framework', 'stage.json'), 'utf8'), marker);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
