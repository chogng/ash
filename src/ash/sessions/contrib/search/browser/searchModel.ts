import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	derived,
	observableSignalFromEvent,
	observableValue,
	type IObservable,
} from '../../../../base/common/observable.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IAutomationService } from '../../../../workbench/contrib/chat/common/automations/automationService.js';
import { ISessionsManagementService } from '../../../services/sessions/common/sessionsManagement.js';
import type { SessionId, ThreadId } from '../../../services/sessions/common/session.js';
import { IProjectsService } from '../../projects/browser/projectsService.js';

export type SearchCategory = 'all' | 'sessions' | 'projects' | 'scheduled';
export type SearchTarget =
	| { readonly kind: 'draft'; readonly id: string }
	| { readonly kind: 'session'; readonly sessionId: SessionId; readonly threadId: ThreadId }
	| { readonly kind: 'project'; readonly id: string }
	| { readonly kind: 'automation'; readonly id: string }
	| { readonly kind: 'contributed'; readonly open: () => Promise<void> }
	| { readonly kind: 'newSession' }
	| { readonly kind: 'projects' };

export interface SearchResult {
	readonly id: string;
	readonly category: Exclude<SearchCategory, 'all'> | 'actions';
	readonly title: string;
	readonly description?: string;
	readonly icon: ThemeIcon;
	readonly target: SearchTarget;
}

export interface SearchState {
	readonly query: string;
	readonly category: SearchCategory;
	readonly results: readonly SearchResult[];
	readonly loading: boolean;
	readonly error: string | undefined;
}

/** Owns only this search's query and category. Results project the domain catalogues. */
export class SessionsSearchModel extends Disposable {
	private readonly query = observableValue(this, '');
	private readonly category = observableValue<SearchCategory>(this, 'all');
	private readonly error = observableValue<string | undefined>(this, undefined);
	readonly state;

	constructor(
		sourceResults: IObservable<readonly SearchResult[]>,
		@ISessionsManagementService sessions: ISessionsManagementService,
		@IProjectsService private readonly projects: IProjectsService,
		@IAutomationService private readonly automations: IAutomationService,
	) {
		super();
		const sessionsChanged = observableSignalFromEvent(this, sessions.onDidChange);
		this.state = derived<SearchState>(reader => {
			sessionsChanged.read(reader);
			const query = this.query.read(reader);
			const category = this.category.read(reader);
			const projectState = projects.state.read(reader);
			const schedules = automations.automations.read(reader);
			const scheduleState = automations.catalogueState.read(reader);
			const results: SearchResult[] = [...sourceResults.read(reader)];
			for (const draft of sessions.untitledSessions) {
				results.push({
					id: `draft:${draft.untitledSessionId}`,
					category: 'sessions',
					title: draft.title.trim() || localize('chat.sessions.new', 'New Session'),
					description: localize('sessions.history.draft', 'Draft'),
					icon: Lxicon.chat4,
					target: { kind: 'draft', id: draft.untitledSessionId },
				});
			}
			for (const session of sessions.sessions) {
				if (session.status !== 'active') {
					continue;
				}
				for (const thread of session.chats) {
					if (thread.status !== 'active') {
						continue;
					}
					results.push({
						id: `session:${session.sessionId}:${thread.threadId}`,
						category: 'sessions',
						title:
							(thread.origin.type === 'root' ? session.title : thread.title || session.title).trim() ||
							localize('chat.sessions.new', 'New Session'),
						description: [session.providerLabel, thread.origin.type !== 'root' ? session.title : undefined]
							.filter(Boolean)
							.join(' · '),
						icon: Lxicon.chat4,
						target: { kind: 'session', sessionId: session.sessionId, threadId: thread.threadId },
					});
				}
			}
			for (const project of projectState.projects) {
				if (!project.archived) {
					results.push({
						id: `project:${project.id}`,
						category: 'projects',
						title: project.name,
						icon: Lxicon.projects,
						target: { kind: 'project', id: project.id },
					});
				}
			}
			if (projectState.message) {
				results.push({
					id: 'projects:retry',
					category: 'projects',
					title: localize('sessions.search.projectsFailed', 'Could not load projects'),
					description: localize('sessions.search.projectsRetry', 'Open Projects to try again'),
					icon: Lxicon.warning,
					target: { kind: 'projects' },
				});
			}
			for (const plan of schedules) {
				results.push({
					id: `automation:${plan.id}`,
					category: 'scheduled',
					title: plan.name,
					description: plan.target.directory,
					icon: Lxicon.history,
					target: { kind: 'automation', id: plan.id },
				});
			}
			results.push({
				id: 'action:newSession',
				category: 'actions',
				title: localize('chat.sessions.new', 'New Session'),
				icon: Lxicon.add,
				target: { kind: 'newSession' },
			});
			const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
			return {
				query,
				category,
				results: results.filter(
					result =>
						(category === 'all' || result.category === category) &&
						words.every(word =>
							`${result.title} ${result.description ?? ''}`.toLocaleLowerCase().includes(word),
						),
				),
				loading: sessions.state === 'loading' || projectState.loading || scheduleState === 'loading',
				error: this.error.read(reader),
			};
		});
	}

	setQuery(value: string): void {
		this.query.set(value);
	}
	setCategory(value: SearchCategory): void {
		this.category.set(value);
	}

	async refresh(): Promise<void> {
		this.error.set(undefined);
		await Promise.all([
			this.projects.reload(),
			this.automations.refresh().catch(() => {
				if (!this.isDisposed) {
					this.error.set(
						localize(
							'sessions.search.schedulesFailed',
							'Could not load schedules. Try opening Search again.',
						),
					);
				}
			}),
		]);
	}
}
