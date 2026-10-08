import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../base/common/uri.js';
import { BackupError, IBackupService, type IBackupContent, type IBackupRecord, type IBackupWorkspace } from '../../../../../platform/backup/common/backup.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { ILogService, NullLoggerService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { WorkspaceContextService } from '../../../workspaces/browser/workspaceContextService.js';
import { WorkingCopyBackupService } from '../../browser/workingCopyBackupService.js';
import type { WorkingCopyBackup } from '../../common/workingCopyBackupService.js';

function assemble(services: InstantiationService, backend: IBackupService, context: WorkspaceContextService): WorkingCopyBackupService {
	services.registerInstance(IBackupService, backend);
	services.registerInstance(IWorkspaceContextService, context);
	services.registerInstance(ILogService, new NullLoggerService());
	return services.createInstance(WorkingCopyBackupService);
}

test('working-copy backups preserve text and structured metadata using the backend timestamp', async () => {
	using services = new InstantiationService();
	using context = new WorkspaceContextService({ id: 'one' });
	const backend = new VersionedBackups();
	using backups = assemble(services, backend, context);
	const text: WorkingCopyBackup = { resource: URI.parse('untitled:/draft'), kind: 'text', content: '内容\nunsaved', languageId: 'typescript', label: 'draft', updatedAt: 1 };
	const structured: WorkingCopyBackup = { resource: URI.file('C:\\project\\note.ash'), kind: 'structuredDocument', content: '{"cells":["draft"]}', contentType: 'application/ash', updatedAt: 2 };
	await backups.store(text);
	await backups.store(structured);
	assert.deepEqual(await backups.list(), [{ ...text, updatedAt: 101 }, { ...structured, updatedAt: 102 }]);
	assert.deepEqual(await backend.getWorkspaces(), [{ id: 'one', folders: [] }]);
	await backups.delete(text.resource);
	await backups.delete(structured.resource);
	assert.deepEqual(await backend.getWorkspaces(), []);
});

test('an editor cannot overwrite or delete an unobserved recovery record', async () => {
	using services = new InstantiationService();
	using context = new WorkspaceContextService({ id: 'one' });
	const backend = new VersionedBackups();
	const resource = URI.parse('untitled:/draft');
	const stored = await backend.store({ id: 'one', folders: [] }, { resource, format: 'ash.working-copy.v1', content: JSON.stringify({ kind: 'text', content: 'recovery' }) });
	using backups = assemble(services, backend, context);
	await backups.delete(resource);
	await assert.rejects(backups.store({ resource, kind: 'text', content: 'new unrelated content', updatedAt: 1 }), error => error instanceof BackupError && error.code === 'conflict');
	assert.deepEqual(await backend.list('one'), [stored]);
});

test('stale editors preserve another window\'s latest backup when writing or deleting', async () => {
	using services = new InstantiationService();
	using context = new WorkspaceContextService({ id: 'one' });
	const backend = new VersionedBackups();
	using first = assemble(services, backend, context);
	using second = services.createInstance(WorkingCopyBackupService);
	const backup: WorkingCopyBackup = { resource: URI.parse('untitled:/draft'), kind: 'text', content: 'first', updatedAt: 1 };
	await first.store(backup);
	await second.list();
	await second.store({ ...backup, content: 'second window' });
	await assert.rejects(first.store({ ...backup, content: 'stale first window' }), BackupError);
	await assert.rejects(first.delete(backup.resource), BackupError);
	assert.equal((await second.list())[0]?.content, 'second window');
});

test('switching workspaces clears observed revisions and keeps each workspace\'s content', async () => {
	using services = new InstantiationService();
	using context = new WorkspaceContextService({ id: 'one' });
	const backend = new VersionedBackups();
	using backups = assemble(services, backend, context);
	const backup: WorkingCopyBackup = { resource: URI.parse('untitled:/draft'), kind: 'text', content: 'workspace one', updatedAt: 1 };
	await backups.store(backup);
	backups.switchWorkspace('two');
	context.updateWorkspace({ id: 'two' });
	assert.deepEqual(await backups.list(), []);
	await backups.store({ ...backup, content: 'workspace two' });
	backups.switchWorkspace('one');
	context.updateWorkspace({ id: 'one' });
	assert.equal((await backups.list())[0]?.content, 'workspace one');
});

test('a saved checkpoint cannot discard a later recovery version from another writer', async () => {
	using services = new InstantiationService();
	using context = new WorkspaceContextService({ id: 'save-checkpoint' });
	const backend = new VersionedBackups();
	using saving = assemble(services, backend, context);
	using other = services.createInstance(WorkingCopyBackupService);
	const checkpoint: WorkingCopyBackup = { resource: URI.file('/save/checkpoint.txt'), kind: 'text', content: 'published checkpoint', updatedAt: 1 };
	await saving.store(checkpoint);
	await other.list();
	await other.store({ ...checkpoint, content: 'newer writer recovery' });
	await assert.rejects(saving.delete(checkpoint.resource), error => error instanceof BackupError && error.code === 'conflict');
	await assert.rejects(saving.store({ ...checkpoint, content: 'retry without observing other writer' }), error => error instanceof BackupError && error.code === 'conflict');
	assert.equal((await other.list())[0]?.content, 'newer writer recovery');
});

test('unreadable backup content stays durable while supported backups still restore', async () => {
	using services = new InstantiationService();
	using context = new WorkspaceContextService({ id: 'one' });
	const backend = new VersionedBackups();
	using backups = assemble(services, backend, context);
	await backend.store({ id: 'one', folders: [] }, { resource: URI.parse('untitled:/future'), format: 'future.v2', content: 'keep this' });
	await backend.store({ id: 'one', folders: [] }, { resource: URI.parse('untitled:/corrupt'), format: 'ash.working-copy.v1', content: 'invalid json' });
	await backups.store({ resource: URI.parse('untitled:/valid'), kind: 'text', content: 'restorable', updatedAt: 1 });
	assert.deepEqual((await backups.list()).map(backup => backup.content), ['restorable']);
	await backups.delete(URI.parse('untitled:/future'));
	assert.equal((await backend.list('one')).length, 3);
});

test('working-copy backup construction requires its registered backend', () => {
	using services = new InstantiationService();
	assert.throws(() => services.createInstance(WorkingCopyBackupService), /backupService/);
});

class VersionedBackups implements IBackupService {
	private sequence = 0;
	private readonly records = new Map<string, IBackupRecord>();
	private readonly workspaces = new Map<string, IBackupWorkspace>();
	async getWorkspaces(): Promise<readonly IBackupWorkspace[]> { return [...this.workspaces.values()]; }
	async list(id: string): Promise<readonly IBackupRecord[]> { return [...this.records.entries()].filter(([key]) => key.startsWith(`${id}\0`)).map(([, record]) => record); }
	async store(workspace: IBackupWorkspace, content: IBackupContent, expectedRevision?: string): Promise<IBackupRecord> {
		const key = `${workspace.id}\0${content.resource.toString()}`;
		const current = this.records.get(key);
		if (current?.content.content === content.content && current.content.format === content.format) return current;
		if (current?.revision !== expectedRevision) throw new BackupError('conflict');
		const record = { content, revision: String(++this.sequence), updatedAt: 100 + this.sequence };
		this.workspaces.set(workspace.id, workspace);
		this.records.set(key, record);
		return record;
	}
	async discard(id: string, resource: URI, expectedRevision: string): Promise<void> {
		const key = `${id}\0${resource.toString()}`;
		const current = this.records.get(key);
		if (current && current.revision !== expectedRevision) throw new BackupError('conflict');
		this.records.delete(key);
		if ((await this.list(id)).length === 0) this.workspaces.delete(id);
	}
}
