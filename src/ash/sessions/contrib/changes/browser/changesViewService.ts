import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { observableValue, type IReader } from '../../../../base/common/observable.js';
import { URI } from '../../../../base/common/uri.js';
import { isRecord } from '../../../../base/common/types.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ChangesViewMode } from '../common/changes.js';
import type {
	IChangesDetailsViewState,
	IChangesViewService,
	IChangesViewSectionCollapseState,
	ChangesViewSection,
} from '../common/changesViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';

const stateKey = 'changesView.sessionViewState';

interface StoredChangesState {
	readonly version: 1;
	readonly changesets: readonly (readonly [string, string])[];
	readonly details: readonly (readonly [string, IChangesDetailsViewState])[];
	readonly sections: readonly (readonly [string, IChangesViewSectionCollapseState])[];
	readonly reviewed: readonly string[];
}

/** Restorable workspace presentation state; Turn contents and revisions remain in ChatService. */
export class ChangesViewService extends Disposable implements IChangesViewService {
	private readonly mode = observableValue(this, ChangesViewMode.List);
	private readonly reviewed = observableValue<ReadonlySet<string>>(this, new Set());
	private readonly details = new Map<string, IChangesDetailsViewState>();
	private readonly sections = new Map<string, IChangesViewSectionCollapseState>();
	private readonly changesetSelections = observableValue<ReadonlyMap<string, string>>(this, new Map());
	private readonly sectionState = observableValue<IChangesViewSectionCollapseState>(this, { checks: false });
	public readonly viewModeObs = this.mode;
	public readonly reviewedFilesObs = this.reviewed;
	public readonly activeSessionSectionCollapseStateObs = this.sectionState;

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@ISessionsService private readonly sessions: ISessionsService,
		@IContextKeyService context: IContextKeyService,
	) {
		super();
		this.restoreState();
		const restore = (): void => {
			const value = storage.get('sessions.changes.viewMode', StorageScope.PROFILE);
			this.mode.set(value === ChangesViewMode.Tree ? ChangesViewMode.Tree : ChangesViewMode.List);
		};
		restore();
		this._register(
			storage.onDidChangeValue(event => {
				if (event.key === 'sessions.changes.viewMode' && event.scope === StorageScope.PROFILE) {
					restore();
				}
				if (event.external && event.key === stateKey && event.scope === StorageScope.WORKSPACE) {
					this.restoreState();
				}
			}),
		);
		this._register(sessions.onDidChange(() => this.updateSections()));
		this.updateSections();
		const reviewedResources = context.createKey<readonly string[]>('sessions.changesReviewedFiles', []);
		const updateReviewed = (): void =>
			reviewedResources.set(
				[...this.reviewed.get()].flatMap(resource => [
					resource,
					`${resource}&side=before`,
					`${resource}&side=after`,
				]),
			);
		this._register(this.reviewed.onDidChange(updateReviewed));
		this._register(toDisposable(() => reviewedResources.reset()));
		updateReviewed();
	}

	public setSectionCollapsed(resource: URI, section: ChangesViewSection, collapsed: boolean): void {
		if (this.isDisposed) {
			return;
		}
		const key = resource.toString();
		const state = { ...(this.sections.get(key) ?? { checks: false }), [section]: collapsed };
		this.sections.delete(key);
		this.sections.set(key, state);
		if (this.sections.size > 64) {
			this.sections.delete(this.sections.keys().next().value!);
		}
		const selected = this.sessions.activeSelection;
		if (selected && new SessionChangesEditorInput(selected).resource.toString() === key) {
			this.sectionState.set(state);
		}
		this.saveState();
	}

	public setViewMode(mode: ChangesViewMode): void {
		if (this.isDisposed) {
			return;
		}
		this.mode.set(mode);
		this.storage.store('sessions.changes.viewMode', mode, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	public getChangesetId(resource: URI | undefined, reader?: IReader): string | undefined {
		const selections = reader ? this.changesetSelections.read(reader) : this.changesetSelections.get();
		return resource
			? selections.get(resource.with({ scheme: 'ash-session-changes', fragment: '' }).toString())
			: undefined;
	}

	public setChangesetId(id: string | undefined, resource?: URI): void {
		if (this.isDisposed) {
			return;
		}
		const selected = this.sessions.activeSelection;
		const target = resource ?? (selected && new SessionChangesEditorInput(selected).resource);
		if (!target) {
			return;
		}
		const key = target.with({ scheme: 'ash-session-changes', fragment: '' }).toString();
		const selections = new Map(this.changesetSelections.get());
		if (selections.get(key) === id && (id === undefined || [...selections.keys()].at(-1) === key)) {
			return;
		}
		selections.delete(key);
		if (id !== undefined) {
			selections.set(key, id);
		}
		if (selections.size > 64) {
			selections.delete(selections.keys().next().value!);
		}
		this.changesetSelections.set(selections);
		this.saveState();
	}

	public getDetailsViewState(resource: URI, mode: ChangesViewMode): IChangesDetailsViewState | undefined {
		return this.details.get(`${resource.toString()}\n${mode}`);
	}

	public setDetailsViewState(resource: URI, mode: ChangesViewMode, state: IChangesDetailsViewState): void {
		if (this.isDisposed) {
			return;
		}
		const key = `${resource.toString()}\n${mode}`;
		this.details.delete(key);
		this.details.set(key, state);
		// The window can visit many conversations; retain only its recent presentation snapshots.
		if (this.details.size > 64) {
			this.details.delete(this.details.keys().next().value!);
		}
		this.saveState();
	}

	public setChangesetFilesReviewState(resources: readonly URI[], reviewed: boolean): void {
		if (this.isDisposed) {
			return;
		}
		const next = new Set(this.reviewed.get());
		for (const resource of resources) {
			if (reviewed) {
				next.add(resource.toString());
			} else {
				next.delete(resource.toString());
			}
		}
		while (next.size > 4096) {
			next.delete(next.values().next().value!);
		}
		this.reviewed.set(next);
		this.saveState();
	}

	private updateSections(): void {
		const selected = this.sessions.activeSelection;
		const resource = selected && new SessionChangesEditorInput(selected).resource.toString();
		this.sectionState.set(resource ? (this.sections.get(resource) ?? { checks: false }) : { checks: false });
	}

	private saveState(): void {
		const state: StoredChangesState = {
			version: 1,
			changesets: [...this.changesetSelections.get()],
			details: [...this.details],
			sections: [...this.sections],
			reviewed: [...this.reviewed.get()],
		};
		this.storage.store(stateKey, JSON.stringify(state), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	private restoreState(): void {
		const stored = this.storage.get(stateKey, StorageScope.WORKSPACE);
		const state =
			stored === undefined
				? { version: 1 as const, changesets: [], details: [], sections: [], reviewed: [] }
				: readChangesState(stored);
		// Invalid cache data must not partially replace a valid live snapshot.
		if (!state) {
			return;
		}
		this.details.clear();
		for (const [key, value] of state.details) {
			this.details.set(key, value);
		}
		this.sections.clear();
		for (const [key, value] of state.sections) {
			this.sections.set(key, value);
		}
		this.updateSections();
		this.reviewed.set(new Set(state.reviewed));
		this.changesetSelections.set(new Map(state.changesets));
	}
}

function readChangesState(stored: string): StoredChangesState | undefined {
	try {
		const value: unknown = JSON.parse(stored);
		if (!isRecord(value) || value.version !== 1) {
			return undefined;
		}
		const entries = (
			candidate: unknown,
			validKey: (key: string) => boolean,
			validValue: (entry: unknown) => boolean,
		): boolean => {
			if (!Array.isArray(candidate) || candidate.length > 64) {
				return false;
			}
			const keys = new Set<string>();
			return candidate.every(entry => {
				if (
					!Array.isArray(entry) ||
					entry.length !== 2 ||
					typeof entry[0] !== 'string' ||
					keys.has(entry[0]) ||
					!validKey(entry[0]) ||
					!validValue(entry[1])
				) {
					return false;
				}
				keys.add(entry[0]);
				return true;
			});
		};
		const strings = (candidate: unknown): candidate is string[] =>
			Array.isArray(candidate) && candidate.every(item => typeof item === 'string');
		const validResource = (key: string): boolean => {
			const resource = URI.parse(key);
			return (
				resource.scheme === 'ash-session-changes' &&
				resource.path.startsWith('/') &&
				resource.path.length > 1 &&
				(resource.path.startsWith('/draft/') || !!new URLSearchParams(resource.query).get('thread'))
			);
		};
		if (
			!entries(
				value.changesets,
				key => validResource(key) && !URI.parse(key).fragment,
				entry => typeof entry === 'string' && entry.length > 0,
			) ||
			!entries(value.sections, validResource, entry => isRecord(entry) && typeof entry.checks === 'boolean') ||
			!entries(
				value.details,
				key => {
					const delimiter = key.lastIndexOf('\n');
					return (
						delimiter > 0 &&
						validResource(key.slice(0, delimiter)) &&
						[ChangesViewMode.List, ChangesViewMode.Tree].includes(
							key.slice(delimiter + 1) as ChangesViewMode,
						)
					);
				},
				entry =>
					isRecord(entry) &&
					strings(entry.focus) &&
					strings(entry.selection) &&
					isRecord(entry.expanded) &&
					Object.values(entry.expanded).every(expanded => expanded === 0 || expanded === 1) &&
					typeof entry.scrollTop === 'number' &&
					Number.isFinite(entry.scrollTop) &&
					entry.scrollTop >= 0,
			) ||
			!strings(value.reviewed) ||
			value.reviewed.length > 4096 ||
			new Set(value.reviewed).size !== value.reviewed.length
		) {
			return undefined;
		}
		for (const key of value.reviewed) {
			const resource = URI.parse(key);
			const query = new URLSearchParams(resource.query);
			const revision = Number(query.get('revision'));
			if (
				resource.scheme !== 'ash-turn-diff' ||
				!/^\/[^/]+\/.+/u.test(resource.path) ||
				!query.get('session') ||
				!query.get('thread') ||
				!query.get('revision') ||
				!Number.isSafeInteger(revision) ||
				revision < 0 ||
				query.has('side')
			) {
				return undefined;
			}
		}
		return value as unknown as StoredChangesState;
	} catch {
		return undefined;
	}
}
