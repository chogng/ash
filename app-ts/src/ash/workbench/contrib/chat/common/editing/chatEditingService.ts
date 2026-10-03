import type { Event } from '../../../../../base/common/event.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { LanguageWorkspaceEdit } from '../../../../../editor/common/languages.js';
import type { Range } from '../../../../../editor/common/core/range.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';

export interface IModifiedFileEntryChangeHunk {
	readonly range: Range;
	readonly originalText: string;
	readonly modifiedText: string;
}

/** A review baseline, not a second editable document. File operations retain their atomic batch. */
export interface IModifiedFileEntry extends IDisposable {
	readonly id: string;
	readonly modifiedURI: URI;
	readonly isFileOperation: boolean;
	readonly resources: readonly URI[];
	readonly hunks: readonly IModifiedFileEntryChangeHunk[];
	readonly isBusy: boolean;
	readonly onDidChange: Event<void>;
	accept(hunk?: IModifiedFileEntryChangeHunk): Promise<void>;
	reject(hunk?: IModifiedFileEntryChangeHunk): Promise<void>;
	getAccessibleContent(): string;
}

/** Window-owned reviews of edits delivered to this window's document connection. */
export interface IChatEditingService {
	readonly entries: readonly IModifiedFileEntry[];
	readonly onDidChange: Event<void>;
	applyEdits(edit: LanguageWorkspaceEdit, signal: AbortSignal): Promise<{ readonly isApplied: boolean }>;
	acceptEntry(entry: IModifiedFileEntry, hunk?: IModifiedFileEntryChangeHunk): Promise<void>;
	rejectEntry(entry: IModifiedFileEntry, hunk?: IModifiedFileEntryChangeHunk): Promise<void>;
	accept(...resources: URI[]): Promise<void>;
	reject(...resources: URI[]): Promise<void>;
}

export const IChatEditingService = createServiceIdentifier<IChatEditingService>('chatEditingService');
