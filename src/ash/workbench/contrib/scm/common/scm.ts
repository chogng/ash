import type { Event } from '../../../../base/common/event.js';
import type { IAction } from '../../../../base/common/actions.js';
import type { Icon } from '../../../../base/common/icon.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import type { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { ISCMHistoryProvider } from './history.js';

export const VIEW_PANE_ID = 'ash.gitView';

export interface ISCMResourceDecorations {
	readonly badge: string;
	readonly tooltip: string;
	readonly kind: string;
}

export interface ISCMResource {
	readonly sourceUri: URI;
	readonly path: string;
	readonly originalPath?: string;
	readonly decorations: ISCMResourceDecorations;
	readonly openLabel: string;
	readonly actions: readonly IAction[];
	/** The view supplies interaction intent; the editor service owns target-group selection. */
	open(options: IEditorOptions, sideBySide: boolean): Promise<void>;
}

export interface ISCMResourceGroup {
	readonly id: string;
	readonly label: string;
	readonly resources: readonly ISCMResource[];
	readonly actions: readonly IAction[];
}

export interface ISCMInput {
	value: string;
	readonly placeholder: string;
	readonly enabled: boolean;
	readonly canAccept: boolean;
	readonly buttonLabel: string;
	readonly buttonTooltip: string;
	accept(): Promise<string | undefined>;
}

export interface ISCMStatusBarCommand {
	readonly id: string;
	readonly icon?: Icon;
	readonly text: string;
	readonly ariaLabel: string;
	readonly tooltip: string;
	readonly priority: number;
	readonly compactGroup?: string;
	run(): unknown;
}

export type ISCMConflictContent = { readonly kind: 'missing'; } | { readonly kind: 'binary'; } | { readonly kind: 'text'; readonly text: string; };

export interface ISCMConflictFile {
	readonly stageIds: readonly (string | null)[];
	readonly resultObjectId: string | null;
	readonly base: ISCMConflictContent;
	readonly current: ISCMConflictContent;
	readonly incoming: ISCMConflictContent;
	readonly result: ISCMConflictContent;
}

export type ISCMConflictResolution = { readonly kind: 'edited'; readonly text: string; } | { readonly kind: 'current'; } | { readonly kind: 'incoming'; };

export interface ISCMConflictProvider {
	resolve(path: string): Promise<ISCMConflictFile>;
	complete(path: string, stageIds: readonly (string | null)[], resultObjectId: string | null, resolution: ISCMConflictResolution): Promise<void>;
	errorMessage(error: unknown): string;
}

export interface ISCMProvider {
	readonly id: string;
	readonly providerId: string;
	readonly label: string;
	readonly rootUri?: URI;
	readonly groups: readonly ISCMResourceGroup[];
	readonly onDidChangeResources: Event<void>;
	readonly input: ISCMInput;
	readonly activeRepositoryName: string | undefined;
	readonly statusBarCommands: readonly ISCMStatusBarCommand[];
	readonly statusMessage: string;
	readonly isBusy: boolean;
	readonly historyProvider?: ISCMHistoryProvider;
	readonly mergeProvider?: ISCMConflictProvider;
	refresh(): Promise<void>;
	activate(): Promise<void>;
}

export interface ISCMRepository extends IDisposable {
	readonly id: string;
	readonly provider: ISCMProvider;
}

export interface ISCMService {
	readonly repositories: Iterable<ISCMRepository>;
	readonly onDidAddRepository: Event<ISCMRepository>;
	readonly onDidRemoveRepository: Event<ISCMRepository>;
	registerSCMProvider(provider: ISCMProvider): ISCMRepository;
	getRepository(id: string): ISCMRepository | undefined;
}

export const ISCMService = createServiceIdentifier<ISCMService>('scm');

export interface ISCMViewService {
	readonly activeRepository: ISCMRepository | undefined;
	readonly onDidChangeActiveRepository: Event<ISCMRepository | undefined>;
	selectRepository(id: string | undefined): void;
}

export const ISCMViewService = createServiceIdentifier<ISCMViewService>('scmView');

export const SCMHistoryBusyContext = new RawContextKey<boolean>('scmHistoryBusy', false);
export const SCMHistoryProviderIdContext = new RawContextKey<string>('scmHistoryProviderId', '');
