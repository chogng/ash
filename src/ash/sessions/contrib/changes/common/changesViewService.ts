import type { IObservable } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { ChangesViewMode } from './changes.js';

export interface IChangesDetailsViewState {
	readonly focus: readonly string[];
	readonly selection: readonly string[];
	readonly expanded: Readonly<Record<string, 0 | 1>>;
	readonly scrollTop: number;
}

export interface IChangesViewSectionCollapseState { readonly checks: boolean; }
export type ChangesViewSection = keyof IChangesViewSectionCollapseState;

/** Owns reconstructable Changes presentation state; Turn contents remain in ChatService. */
export interface IChangesViewService {
	readonly viewModeObs: IObservable<ChangesViewMode>;
	readonly reviewedFilesObs: IObservable<ReadonlySet<string>>;
	readonly activeSessionSectionCollapseStateObs: IObservable<IChangesViewSectionCollapseState>;
	setViewMode(mode: ChangesViewMode): void;
	setSectionCollapsed(sessionResource: URI, section: ChangesViewSection, collapsed: boolean): void;
	getDetailsViewState(sessionResource: URI, viewMode: ChangesViewMode): IChangesDetailsViewState | undefined;
	setDetailsViewState(sessionResource: URI, viewMode: ChangesViewMode, state: IChangesDetailsViewState): void;
	setChangesetFilesReviewState(resources: readonly URI[], reviewed: boolean): void;
}

export const IChangesViewService = createServiceIdentifier<IChangesViewService>('changesViewService');
