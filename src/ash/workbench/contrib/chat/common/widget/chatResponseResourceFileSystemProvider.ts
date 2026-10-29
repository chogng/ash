import { Event } from '../../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import { createUuid } from '../../../../../base/common/uuid.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import {
	FileKind,
	FileSystemProviderCapabilities,
	FileSystemProviderError,
	FileSystemProviderErrorCode,
	IFileService,
	type IFileBytes,
	type IFileEntry,
	type IFileStat,
	type IFileSystemProvider,
} from '../../../../../platform/files/common/files.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';

const scheme = 'chat-response-resource';

export interface IChatResourceAssociation extends IDisposable {
	readonly resource: URI;
}

export interface IChatResourceAssociateOptions {
	readonly id?: string;
	readonly name?: string;
}

export interface IChatResponseResourceFileSystemProvider extends IFileSystemProvider {
	readonly _serviceBrand: undefined;
	associate(data: Uint8Array, options?: IChatResourceAssociateOptions): IChatResourceAssociation;
}

export const IChatResponseResourceFileSystemProvider = createServiceIdentifier<IChatResponseResourceFileSystemProvider>(
	'chatResponseResourceFileSystemProvider',
);

interface Entry {
	readonly resource: URI;
	readonly data: Uint8Array;
	readonly revision: string;
	references: number;
}

/** Owns immutable view data until its last response association releases it. */
export class ChatResponseResourceFileSystemProvider
	extends Disposable
	implements IChatResponseResourceFileSystemProvider
{
	declare readonly _serviceBrand: undefined;
	public readonly capabilities =
		FileSystemProviderCapabilities.FileReadWrite |
		FileSystemProviderCapabilities.Readonly |
		FileSystemProviderCapabilities.PathCaseSensitive;
	public readonly onDidChangeCapabilities = Event.None;
	public readonly onDidChangeFiles = Event.None;
	private readonly entries = new Map<string, Entry>();

	constructor() {
		super();
		this._register(toDisposable(() => this.entries.clear()));
	}

	public associate(data: Uint8Array, options: IChatResourceAssociateOptions = {}): IChatResourceAssociation {
		this.assertNotDisposed();
		const id = options.id ?? createUuid();
		let entry = this.entries.get(id);
		if (!entry) {
			const name = (options.name ?? 'resource').replace(/[\\/]/gu, '_');
			const resource = URI.from({
				scheme,
				authority: createUuid(),
				path: `/${name === '.' || name === '..' ? 'resource' : name}`,
			});
			entry = { resource, data: data.slice(), revision: createUuid(), references: 0 };
			this.entries.set(id, entry);
		}
		entry.references++;
		const owned = entry;
		return Object.assign(
			toDisposable(() => {
				if (--owned.references === 0 && this.entries.get(id) === owned) this.entries.delete(id);
			}),
			{ resource: entry.resource },
		);
	}

	public watch(): IDisposable {
		return toDisposable(() => {});
	}

	public async stat(resource: URI): Promise<IFileStat> {
		const entry = this.find(resource);
		return {
			resource,
			kind: FileKind.File,
			sizeBytes: entry.data.length,
			readonly: true,
			modifiedAtMillis: undefined,
		};
	}

	public async readFile(resource: URI): Promise<IFileBytes> {
		const entry = this.find(resource);
		return { resource, bytes: entry.data.slice(), revision: entry.revision };
	}

	public async readDirectory(resource: URI): Promise<readonly IFileEntry[]> {
		if (resource.scheme !== scheme || resource.path !== '/') throw unavailable();
		return [...this.entries.values()]
			.filter(entry => !resource.authority || entry.resource.authority === resource.authority)
			.map(entry => ({ resource: entry.resource, name: entry.resource.path.slice(1), kind: FileKind.File }));
	}

	public async writeFile(): Promise<never> {
		throw readonlyError();
	}
	public async createFile(): Promise<never> {
		throw readonlyError();
	}
	public async createDirectory(): Promise<never> {
		throw readonlyError();
	}
	public async copy(): Promise<never> {
		throw readonlyError();
	}
	public async rename(): Promise<never> {
		throw readonlyError();
	}
	public async delete(): Promise<never> {
		throw readonlyError();
	}

	private find(resource: URI): Entry {
		this.assertNotDisposed();
		const entry = [...this.entries.values()].find(entry => entry.resource.toString() === resource.toString());
		if (!entry) throw unavailable();
		return entry;
	}
}

export class ChatResponseResourceWorkbenchContribution extends Disposable {
	public static readonly ID = 'chatResponseResourceWorkbenchContribution';

	constructor(
		@IFileService files: IFileService,
		@IChatResponseResourceFileSystemProvider provider: IChatResponseResourceFileSystemProvider,
	) {
		super();
		this._register(files.registerProvider(scheme, provider));
	}
}

function unavailable(): Error {
	return new FileSystemProviderError(
		localize('chat.resource.unavailable', 'This response resource is no longer available.'),
		FileSystemProviderErrorCode.FileNotFound,
	);
}

function readonlyError(): Error {
	return new FileSystemProviderError(
		localize('chat.resource.readonly', 'Response resources are read-only. Save a copy to edit them.'),
		FileSystemProviderErrorCode.NoPermissions,
	);
}
