import { ResourceQueue } from '../../../../base/common/async.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { Schemas } from '../../../../base/common/network.js';
import { FileNotFoundError, IFileService } from '../../../../platform/files/common/files.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import type { IResourceEditorInput } from '../../../../workbench/common/editor.js';
import { IWorkingCopyBackupService } from '../../../../workbench/services/workingCopy/common/workingCopyBackupService.js';
import { IWorkingCopyService } from '../../../../workbench/services/workingCopy/common/workingCopyService.js';
import { localize } from '../../../../nls.js';
import { createArkdownDocsInput } from './docsEditorInput.js';
import { legacyDocsToMarkdown } from './docsImport.js';

interface MigrationReceipt {
	readonly sourceHash: string;
	readonly recoveryHash?: string;
}

const migrationQueues = new WeakMap<IWorkingCopyBackupService, { readonly queue: ResourceQueue; pending: number; }>();

/** Files remain beside their Markdown successor. A receipt makes later Markdown edits authoritative. */
export function migrateLegacyDocsInput(source: IResourceEditorInput, accessor: ServicesAccessor): Promise<IResourceEditorInput> {
	const files = accessor.get(IFileService);
	const backups = accessor.get(IWorkingCopyBackupService);
	const storage = accessor.get(IStorageService);
	const copies = accessor.get(IWorkingCopyService);
	let pending = migrationQueues.get(backups);
	if (!pending) migrationQueues.set(backups, pending = { queue: new ResourceQueue(), pending: 0 });
	const operation = pending;
	operation.pending++;
	return operation.queue.queueFor(source.resource, async () => {
		const resource = source.resource;
		if (!/\.ash-doc$/iu.test(resource.path) || ![Schemas.file, Schemas.untitled, Schemas.vscodeUserData].includes(resource.scheme)) {
			throw new TypeError(localize({ bundle: 'ash.docs', key: 'invalidLegacyResource' }, 'This legacy document resource cannot be migrated.'));
		}
		const target = resource.with({ path: resource.path.replace(/\.ash-doc$/iu, '.md') });
		const receiptKey = `sessions.docs.migration.${resource.toString()}`;
		const savedReceipt = storage.get(receiptKey, StorageScope.PROFILE);
		const receipt = savedReceipt === undefined ? undefined : parseReceipt(savedReceipt);
		const backup = await backups.resolve(resource);
		const live = copies.get(resource).find(copy => copy.isDirty && copy.backupKind === 'structuredDocument');
		const initialText = source.initialText ?? (source.initialBytes ? new TextDecoder('utf-8', { fatal: true }).decode(source.initialBytes) : undefined);
		const recovery = live?.backup() ?? backup?.content ?? initialText;
		let serialized = initialText;
		if (resource.scheme !== Schemas.untitled) {
			try {
				if ((await files.stat(resource)).sizeBytes > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
				serialized = (await files.readFile(resource)).content;
			} catch (error) {
				if (!(error instanceof FileNotFoundError) || recovery === undefined) throw error;
			}
		}
		serialized ??= recovery ?? (resource.scheme === Schemas.untitled ? '' : undefined);
		if (serialized === undefined) throw new Error(localize({ bundle: 'ash.docs', key: 'missingLegacyDraft' }, 'The legacy document draft has no recoverable content.'));
		if (serialized.length > 64 * 1024 * 1024 || recovery !== undefined && recovery.length > 64 * 1024 * 1024) throw new RangeError(localize('document.output.tooLarge', 'Document output exceeds 64 MiB.'));
		const sourceHash = digest(serialized);
		const recoveryHash = recovery === undefined ? undefined : digest(recovery);
		if (receipt) {
			if (receipt.sourceHash !== sourceHash || recoveryHash !== undefined && receipt.recoveryHash !== recoveryHash) throw migrationConflict();
			// A previous attempt may have updated the window cache before its flush failed.
			await storage.flush();
			if (resource.scheme === Schemas.untitled) {
				const recovered = await backups.resolve(target);
				if (recovered?.kind === 'text') {
					if (backup && !live) await backups.delete(resource);
					return createArkdownDocsInput({ ...source, resource: target, initialText: recovered.content, initialBytes: undefined });
				}
			} else {
				try {
					await files.stat(target);
					if (backup && !live) await backups.delete(resource);
					return createArkdownDocsInput({ ...source, resource: target, initialText: undefined, initialBytes: undefined });
				} catch (error) { if (!(error instanceof FileNotFoundError)) throw error; }
			}
		}
		const markdown = legacyDocsToMarkdown(serialized);
		const recoveredMarkdown = recovery === undefined ? markdown : legacyDocsToMarkdown(recovery);
		const targetBackup = await backups.resolve(target);
		if (targetBackup && (targetBackup.kind !== 'text' || targetBackup.content !== recoveredMarkdown)) throw migrationConflict();
		const targetCopy = copies.get(target).find(copy => copy.isDirty);
		if (targetCopy && targetCopy.backup() !== recoveredMarkdown) throw migrationConflict();
		if (resource.scheme !== Schemas.untitled) {
			try {
				await files.writeFile({ resource: target, content: markdown }, { create: true, overwrite: false });
			} catch (error) {
				// Remote file providers can report an opaque create failure for an existing file.
				let existing;
				try { existing = await files.readFile(target); }
				catch { throw error; }
				if (existing.content !== markdown) throw migrationConflict();
			}
		}
		if (recovery !== undefined || resource.scheme === Schemas.untitled) {
			await backups.store({ resource: target, kind: 'text', content: recoveredMarkdown, updatedAt: backup?.updatedAt ?? Date.now(), languageId: 'markdown', contentType: 'text/markdown', label: source.label ?? backup?.label });
		}
		storage.store(receiptKey, JSON.stringify({ sourceHash, recoveryHash }), StorageScope.PROFILE, StorageTarget.MACHINE);
		await storage.flush();
		// A restart between these operations sees the target and receipt before retiring old recovery.
		if (backup && !live) await backups.delete(resource);
		return createArkdownDocsInput({ ...source, resource: target, initialText: resource.scheme === Schemas.untitled ? recoveredMarkdown : undefined, initialBytes: undefined });
	}).finally(() => {
		if (--operation.pending === 0) {
			migrationQueues.delete(backups);
			operation.queue.dispose();
		}
	});
}

function digest(value: string): string {
	const hash = new StringSHA1();
	hash.update(value);
	return hash.digest();
}

function parseReceipt(serialized: string): MigrationReceipt {
	const value: unknown = JSON.parse(serialized);
	if (typeof value !== 'object' || value === null || !('sourceHash' in value) || typeof value.sourceHash !== 'string' || !/^[a-f0-9]{40}$/u.test(value.sourceHash)
		|| 'recoveryHash' in value && (typeof value.recoveryHash !== 'string' || !/^[a-f0-9]{40}$/u.test(value.recoveryHash))) throw migrationConflict();
	return value as MigrationReceipt;
}

function migrationConflict(): Error {
	return new Error(localize({ bundle: 'ash.docs', key: 'migrationConflict' }, 'The legacy document and its Markdown successor have conflicting changes. Both copies have been preserved.'));
}
