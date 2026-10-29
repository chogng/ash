import { Disposable, MutableDisposable, toDisposable, type IDisposable } from '../../../../base/common/lifecycle.js';
import { derived, observableValue, type IObservable } from '../../../../base/common/observable.js';
import { createServiceIdentifier, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IAutomationService } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import { IAutomationDialogService } from '../../../../workbench/contrib/chat/common/automations/automationDialogService.js';
import { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import { IProjectsService } from '../../projects/browser/projectsService.js';
import { SessionsSearchDialog } from './searchDialog.js';
import type { SearchResult } from './searchModel.js';

export interface ISessionsSearchService {
	registerSource(results: IObservable<readonly SearchResult[]>): IDisposable;
	show(): Promise<void>;
	focus(): void;
}

export const ISessionsSearchService = createServiceIdentifier<ISessionsSearchService>('sessionsSearchService');

/** One independent search surface per Sessions window, disposed with that window's service scope. */
export class SessionsSearchService extends Disposable implements ISessionsSearchService {
	private readonly active = this._register(new MutableDisposable<SessionsSearchDialog>());
	private readonly sources = observableValue<readonly IObservable<readonly SearchResult[]>[]>(this, []);
	private readonly sourceResults = derived(reader => this.sources.read(reader).flatMap(source => source.read(reader)));

	constructor(
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@ILayoutService private readonly layout: ILayoutService,
		@ISessionsService private readonly sessions: ISessionsService,
		@IProjectsService private readonly projects: IProjectsService,
		@IAutomationService private readonly automations: IAutomationService,
		@IAutomationDialogService private readonly automationDialogs: IAutomationDialogService,
		@ICommandService private readonly commands: ICommandService,
	) {
		super();
	}

	/** Contributions retain their own catalogues; Search reads them only while its model is alive. */
	registerSource(results: IObservable<readonly SearchResult[]>): IDisposable {
		this.sources.set([...this.sources.get(), results]);
		return toDisposable(() => this.sources.set(this.sources.get().filter(source => source !== results)));
	}

	async show(): Promise<void> {
		if (this.active.value) {
			this.focus();
			return;
		}
		const dialog = this.instantiation.createInstance(SessionsSearchDialog, this.layout.activeContainer, this.sourceResults);
		this.active.value = dialog;
		let target;
		try {
			target = await dialog.show();
		} finally {
			this.active.clear();
		}
		// Close the modal and release its model before handing focus to a domain page.
		switch (target?.kind) {
			case 'contributed':
				await target.open();
				break;
			case 'draft':
				this.sessions.openUntitledSession(target.id);
				break;
			case 'session':
				this.sessions.openSession(target.sessionId, target.threadId);
				break;
			case 'project':
				await this.projects.openProject(target.id);
				await this.commands.executeCommand('sessions.open.projects');
				break;
			case 'automation': {
				const plan = this.automations.getAutomation(target.id);
				if (plan) {
					await this.automationDialogs.showAutomationDialog({ existing: plan });
				}
				break;
			}
			case 'newSession':
				await this.commands.executeCommand('sessions.newSession');
				break;
			case 'projects':
				await this.commands.executeCommand('sessions.open.projects');
				break;
		}
	}

	focus(): void {
		this.active.value?.focus();
	}
}
