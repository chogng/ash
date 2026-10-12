import type { Event } from '../../../../../base/common/event.js';
import type { IDisposable } from '../../../../../base/common/lifecycle.js';
import type { IObservable, IReader } from '../../../../../base/common/observable.js';
import type { URI } from '../../../../../base/common/uri.js';
import type { LanguageWorkspaceEdit } from '../../../../../editor/common/languages.js';
import type { Range } from '../../../../../editor/common/core/range.js';
import { createServiceIdentifier } from '../../../../../platform/instantiation/common/instantiation.js';
import type { ChatEditSource, ChatEditOutcome } from '../../../../services/chat/common/chatService.js';

export interface IModifiedFileEntryChangeHunk {
	readonly range: Range;
	readonly originalText: string;
	readonly modifiedText: string;
}

export interface ISnapshotEntry {
	readonly resource: URI;
	readonly original: string;
	readonly current: string;
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

/**
 * A service-owned view of a chat's pending reviews. Shared entries retain one baseline
 * across chats. Consumers dispose their subscriptions; the service owns this lifetime.
 */
export interface IChatEditReviewSession extends IDisposable {
	readonly isGlobalEditingSession: boolean;
	readonly chatSessionResource: URI;
	readonly onDidDispose: Event<void>;
	readonly entries: IObservable<readonly IModifiedFileEntry[]>;
	getEntry(uri: URI): IModifiedFileEntry | undefined;
	readEntry(uri: URI, reader: IReader): IModifiedFileEntry | undefined;
	accept(...uris: URI[]): Promise<void>;
	reject(...uris: URI[]): Promise<void>;
}

/** Owns pending reviews and their chat attribution for this document connection. */
export interface IChatEditingService {
	readonly entries: readonly IModifiedFileEntry[];
	readonly editingSessionsObs: IObservable<readonly IChatEditReviewSession[]>;
	readonly onDidChange: Event<void>;
	readonly onDidChangeAutoAccept: Event<IModifiedFileEntry>;
	applyEdits(edit: LanguageWorkspaceEdit, signal: AbortSignal, source: ChatEditSource): Promise<{ readonly isApplied: boolean; }>;
	finishTurn(source: ChatEditSource, outcome: ChatEditOutcome): Promise<void>;
	getAutoAcceptCountdown(entry: IModifiedFileEntry): number | undefined;
	cancelAutoAccept(entry: IModifiedFileEntry): void;
	acceptEntry(entry: IModifiedFileEntry, hunk?: IModifiedFileEntryChangeHunk): Promise<void>;
	rejectEntry(entry: IModifiedFileEntry, hunk?: IModifiedFileEntryChangeHunk): Promise<void>;
}

export const IChatEditingService = createServiceIdentifier<IChatEditingService>('chatEditingService');
