import { throwIfCancelled, type CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { FileKind, FileNotFoundError, IFileService } from '../../../../platform/files/common/files.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IUserDataProfileService } from '../../userDataProfile/common/userDataProfile.js';
import { IWorkingCopyHistoryService, type IWorkingCopyHistoryEntry, type IWorkingCopyHistoryEntryDescriptor } from './workingCopyHistory.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: 'workbench.localHistory.maxFileEntries', defaultValue: 50, scope: ConfigurationScope.RESOURCE, parse(value: unknown): number {
		if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 1000) throw new TypeError(localize('localHistory.invalidEntries', 'Local history entries must be an integer between 1 and 1000.'));
		return value;
	}, setting: { valueType: 'number', minimum: 1, maximum: 1000, title: localize('localHistory.entriesTitle', 'Local history entry limit'), description: localize('localHistory.entriesDescription', 'Maximum saved versions retained for each file.') }
});

/** Stores immutable snapshots through the profile's existing file provider. */
export class WorkingCopyHistoryService extends Disposable implements IWorkingCopyHistoryService {
	private readonly added = this._register(new Emitter<{ readonly entry: IWorkingCopyHistoryEntry; }>());
	public readonly onDidAddEntry = this.added.event;
	// Consecutive saves must retain their order even while snapshot writes are pending.
	private readonly writes = new Map<string, Promise<unknown>>();

	constructor(
		@IFileService private readonly files: IFileService,
		@IUserDataProfileService private readonly profiles: IUserDataProfileService,
		@IConfigurationService private readonly configuration: IConfigurationService,
	) {
		super();
	}

	public async addEntry(descriptor: IWorkingCopyHistoryEntryDescriptor, token: CancellationToken): Promise<IWorkingCopyHistoryEntry> {
		const key = extUri.getComparisonKey(descriptor.resource);
		const previous = this.writes.get(key);
		const writing = (previous ? previous.then(() => undefined, () => undefined) : Promise.resolve()).then(() => this.writeEntry(descriptor, token));
		this.writes.set(key, writing);
		try {
			return await writing;
		} finally {
			if (this.writes.get(key) === writing) this.writes.delete(key);
		}
	}

	private async writeEntry(descriptor: IWorkingCopyHistoryEntryDescriptor, token: CancellationToken): Promise<IWorkingCopyHistoryEntry> {
		throwIfCancelled(token);
		const directory = this.directory(descriptor.resource);
		await this.files.createDirectory(directory);
		const previousEntries = await this.readEntries(descriptor.resource, token);
		throwIfCancelled(token);
		const timestamp = descriptor.timestamp ?? Math.max(Date.now(), (previousEntries[0]?.timestamp ?? 0) + 1);
		const id = `${timestamp}-${generateUuid()}.snapshot`;
		const entry: IWorkingCopyHistoryEntry = { id, workingCopy: { resource: descriptor.resource, name: basename(descriptor.resource) }, location: URI.joinPath(directory, id), timestamp };
		await this.files.writeFileBytes(entry.location, new TextEncoder().encode(descriptor.content));
		const entries = [entry, ...previousEntries].sort((left, right) => right.timestamp - left.timestamp);
		await Promise.all(entries.slice(this.configuration.getValue<number>('workbench.localHistory.maxFileEntries')).map(old => this.files.delete(old.location, 'ignore', 'fileOrEmptyDirectory')));
		this.added.fire({ entry });
		return entry;
	}

	public async getEntries(resource: URI, token: CancellationToken): Promise<readonly IWorkingCopyHistoryEntry[]> {
		await this.writes.get(extUri.getComparisonKey(resource));
		return this.readEntries(resource, token);
	}

	private async readEntries(resource: URI, token: CancellationToken): Promise<readonly IWorkingCopyHistoryEntry[]> {
		throwIfCancelled(token);
		let entries;
		try {
			entries = await this.files.readDirectory(this.directory(resource));
		} catch (error) {
			if (error instanceof FileNotFoundError) return [];
			throw error;
		}
		throwIfCancelled(token);
		return entries.filter(entry => entry.kind === FileKind.File && /^\d+-[a-f0-9-]+\.snapshot$/.test(entry.name)).map(entry => ({ id: entry.name, location: entry.resource, timestamp: Number(entry.name.slice(0, entry.name.indexOf('-'))), workingCopy: { resource, name: basename(resource) } })).sort((left, right) => right.timestamp - left.timestamp || right.id.localeCompare(left.id));
	}

	private directory(resource: URI): URI {
		const hash = new StringSHA1();
		hash.update(extUri.getComparisonKey(resource));
		return URI.joinPath(this.profiles.currentProfile.location, 'History', hash.digest());
	}
}

registerSingleton(IWorkingCopyHistoryService, WorkingCopyHistoryService, InstantiationType.Delayed);
