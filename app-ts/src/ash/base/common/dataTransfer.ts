import { URI } from './uri.js';
import { splitLines } from './strings.js';
import { createUuid } from './uuid.js';

export interface IDataTransferFile {
	readonly id: string;
	readonly name: string;
	readonly uri?: URI;
	data(): Promise<Uint8Array>;
}

export interface IDataTransferItem {
	readonly id?: string;
	readonly value: unknown;
	asString(): Promise<string>;
	asFile(): IDataTransferFile | undefined;
}

export function createStringDataTransferItem(value: string | Promise<string>, id?: string): IDataTransferItem {
	return {
		...(id === undefined ? {} : { id }),
		value: typeof value === 'string' ? value : undefined,
		asString: async () => value,
		asFile: () => undefined,
	};
}

export function createFileDataTransferItem(name: string, uri: URI | undefined, data: () => Promise<Uint8Array>, id?: string): IDataTransferItem {
	const file: IDataTransferFile = {
		id: createUuid(),
		name,
		...(uri === undefined ? {} : { uri }),
		data,
	};
	return {
		...(id === undefined ? {} : { id }),
		value: undefined,
		asString: async () => '',
		asFile: () => file,
	};
}

export interface IReadonlyVSDataTransfer extends Iterable<readonly [string, IDataTransferItem]> {
	readonly size: number;
	has(mimeType: string): boolean;
	matches(pattern: string): boolean;
	get(mimeType: string): IDataTransferItem | undefined;
}

/** A case-insensitive, process-owned data transfer with multiple items per MIME type. */
export class VSDataTransfer implements IReadonlyVSDataTransfer {
	private readonly entriesByMimeType = new Map<string, IDataTransferItem[]>();

	public get size(): number {
		return this.entriesByMimeType.size;
	}

	public has(mimeType: string): boolean {
		return this.entriesByMimeType.has(normalizeMimeType(mimeType));
	}

	public matches(pattern: string): boolean {
		const mimeTypes = [...this.entriesByMimeType.keys()];
		if ([...this].some(([, item]) => item.asFile() !== undefined)) mimeTypes.push('files');
		return matchesNormalizedMimeType(normalizeMimeType(pattern), mimeTypes);
	}

	public get(mimeType: string): IDataTransferItem | undefined {
		return this.entriesByMimeType.get(normalizeMimeType(mimeType))?.[0];
	}

	public append(mimeType: string, value: IDataTransferItem): void {
		const key = normalizeMimeType(mimeType);
		const entries = this.entriesByMimeType.get(key);
		if (entries) {
			entries.push(value);
			return;
		}
		this.entriesByMimeType.set(key, [value]);
	}

	public replace(mimeType: string, value: IDataTransferItem): void {
		this.entriesByMimeType.set(normalizeMimeType(mimeType), [value]);
	}

	public delete(mimeType: string): void {
		this.entriesByMimeType.delete(normalizeMimeType(mimeType));
	}

	public *[Symbol.iterator](): IterableIterator<readonly [string, IDataTransferItem]> {
		for (const [mimeType, entries] of this.entriesByMimeType) {
			for (const entry of entries) yield [mimeType, entry];
		}
	}
}

export function matchesMimeType(pattern: string, mimeTypes: readonly string[]): boolean {
	return matchesNormalizedMimeType(normalizeMimeType(pattern), mimeTypes.map(normalizeMimeType));
}

function matchesNormalizedMimeType(pattern: string, mimeTypes: readonly string[]): boolean {
	if (pattern === '*/*') return mimeTypes.length > 0;
	if (mimeTypes.includes(pattern)) return true;
	const wildcard = /^([a-z]+)\/(?:[a-z0-9.+-]+|\*)$/iu.exec(pattern);
	if (!wildcard || !pattern.endsWith('/*')) return false;
	return mimeTypes.some(mimeType => mimeType.startsWith(`${wildcard[1]}/`));
}

function normalizeMimeType(mimeType: string): string {
	return mimeType.toLowerCase();
}

export const UriList = Object.freeze({
	create(entries: ReadonlyArray<string | URI>): string {
		return [...new Set(entries.map(entry => entry.toString()))].join('\r\n');
	},
	split(value: string): string[] {
		return splitLines(value);
	},
	parse(value: string): string[] {
		return UriList.split(value).filter(entry => !entry.startsWith('#'));
	},
});
