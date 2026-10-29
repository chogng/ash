import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { Event } from '../../../../base/common/event.js';
import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

export interface IWorkingCopyHistoryEntry {
	readonly id: string;
	readonly workingCopy: { readonly resource: URI; readonly name: string; };
	readonly location: URI;
	readonly timestamp: number;
}

export interface IWorkingCopyHistoryEntryDescriptor {
	readonly resource: URI;
	readonly timestamp?: number;
	/** Saved content is supplied so a subsequent disk write cannot replace this snapshot. */
	readonly content: string;
}

export interface IWorkingCopyHistoryService {
	readonly onDidAddEntry: Event<{ readonly entry: IWorkingCopyHistoryEntry; }>;
	addEntry(descriptor: IWorkingCopyHistoryEntryDescriptor, token: CancellationToken): Promise<IWorkingCopyHistoryEntry>;
	getEntries(resource: URI, token: CancellationToken): Promise<readonly IWorkingCopyHistoryEntry[]>;
}

export const IWorkingCopyHistoryService = createDecorator<IWorkingCopyHistoryService>('workingCopyHistoryService');
