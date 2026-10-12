import { Disposable } from '../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../base/common/observable.js';
import type { URI } from '../../../../base/common/uri.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ChangesViewMode } from '../common/changes.js';
import type { IChangesDetailsViewState, IChangesViewService, IChangesViewSectionCollapseState, ChangesViewSection } from '../common/changesViewService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { SessionChangesEditorInput } from './sessionChangesEditorInput.js';

/** View snapshots survive hiding a pane without becoming another owner of Turn state. */
export class ChangesViewService extends Disposable implements IChangesViewService {
	private readonly mode = observableValue(this, ChangesViewMode.List);
	private readonly reviewed = observableValue<ReadonlySet<string>>(this, new Set());
	private readonly details = new Map<string, IChangesDetailsViewState>();
	private readonly sections = new Map<string, IChangesViewSectionCollapseState>();
	private readonly sectionState = observableValue<IChangesViewSectionCollapseState>(this, { checks: false });
	public readonly viewModeObs = this.mode;
	public readonly reviewedFilesObs = this.reviewed;
	public readonly activeSessionSectionCollapseStateObs = this.sectionState;

	constructor(
		@IStorageService private readonly storage: IStorageService,
		@ISessionsService private readonly sessions: ISessionsService,
	) {
		super();
		const restore = (): void => {
			const value = storage.get('sessions.changes.viewMode', StorageScope.PROFILE);
			this.mode.set(value === ChangesViewMode.Tree ? ChangesViewMode.Tree : ChangesViewMode.List);
		};
		restore();
		this._register(storage.onDidChangeValue(event => {
			if (event.key === 'sessions.changes.viewMode' && event.scope === StorageScope.PROFILE) { restore(); }
		}));
		const updateSections = (): void => {
			const selected = sessions.activeSelection;
			const resource = selected && new SessionChangesEditorInput(selected).resource.toString();
			this.sectionState.set(resource ? this.sections.get(resource) ?? { checks: false } : { checks: false });
		};
		this._register(sessions.onDidChange(updateSections));
		updateSections();
	}

	public setSectionCollapsed(resource: URI, section: ChangesViewSection, collapsed: boolean): void {
		const key = resource.toString();
		const state = { ...this.sections.get(key) ?? { checks: false }, [section]: collapsed };
		this.sections.delete(key);
		this.sections.set(key, state);
		if (this.sections.size > 64) { this.sections.delete(this.sections.keys().next().value!); }
		const selected = this.sessions.activeSelection;
		if (selected && new SessionChangesEditorInput(selected).resource.toString() === key) { this.sectionState.set(state); }
	}

	public setViewMode(mode: ChangesViewMode): void {
		this.mode.set(mode);
		this.storage.store('sessions.changes.viewMode', mode, StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	public getDetailsViewState(resource: URI, mode: ChangesViewMode): IChangesDetailsViewState | undefined {
		return this.details.get(`${resource.toString()}\n${mode}`);
	}

	public setDetailsViewState(resource: URI, mode: ChangesViewMode, state: IChangesDetailsViewState): void {
		const key = `${resource.toString()}\n${mode}`;
		this.details.delete(key);
		this.details.set(key, state);
		// The window can visit many conversations; retain only its recent presentation snapshots.
		if (this.details.size > 64) { this.details.delete(this.details.keys().next().value!); }
	}

	public setChangesetFilesReviewState(resources: readonly URI[], reviewed: boolean): void {
		const next = new Set(this.reviewed.get());
		for (const resource of resources) {
			if (reviewed) { next.add(resource.toString()); }
			else { next.delete(resource.toString()); }
		}
		while (next.size > 4096) { next.delete(next.values().next().value!); }
		this.reviewed.set(next);
	}
}
