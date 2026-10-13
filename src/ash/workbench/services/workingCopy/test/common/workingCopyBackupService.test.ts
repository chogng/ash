import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { InMemoryWorkingCopyBackupService } from '../../common/workingCopyBackupService.js';

suite('InMemoryWorkingCopyBackupService', () => {
	test('recovery belongs to its workspace and disappears with its host', async () => {
		using backups = new InMemoryWorkingCopyBackupService('first');
		const backup = { resource: URI.file('/sample.ts'), kind: 'text' as const, content: 'unsaved', updatedAt: 1 };
		await backups.store(backup);
		backups.switchWorkspace('second');
		assert.deepEqual(await backups.list(), []);
		await backups.store({ ...backup, content: 'second' });
		backups.switchWorkspace('first');
		assert.deepEqual(await backups.list(), [backup]);
		await backups.delete(backup.resource);
		assert.deepEqual(await backups.list(), []);
		backups.switchWorkspace('second');
		assert.equal((await backups.list())[0]?.content, 'second');
		backups.dispose();
		await assert.rejects(backups.list(), ReferenceError);
		using anotherHost = new InMemoryWorkingCopyBackupService('second');
		assert.deepEqual(await anotherHost.list(), []);
	});
});
