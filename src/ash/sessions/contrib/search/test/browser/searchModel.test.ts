import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { Event } from '../../../../../base/common/event.js';
import { observableValue } from '../../../../../base/common/observable.js';
import type { ISessionsManagementService } from '../../../../services/sessions/common/sessionsManagement.js';
import type { ISession } from '../../../../services/sessions/common/session.js';
import type { IAutomationService, AutomationCatalogueState } from '../../../../../workbench/contrib/chat/common/automations/automationService.js';
import type { IAutomationDescriptor } from '../../../../../workbench/contrib/chat/common/automations/automation.js';
import type { IProjectsService, ProjectsState } from '../../../projects/browser/projectsService.js';
import { SessionsSearchModel } from '../../browser/searchModel.js';

function fixture() {
	const session: ISession = {
		sessionId: 'alpha', title: 'Alpha review', providerLabel: 'Host A', status: 'active', nextApprovalMode: 'manual', agentTree: [],
		chats: [
			{ threadId: 'root', status: 'active', origin: { type: 'root' } },
			{ threadId: 'archived', status: 'archived', origin: { type: 'root' } },
		],
	};
	const sessions = { onDidChange: Event.None, sessions: [session, { ...session, sessionId: 'old', status: 'archived' }], untitledSessions: [], state: 'ready' } as unknown as ISessionsManagementService;
	const projectState = observableValue<ProjectsState>('projects', {
		projects: [{ id: 'beta', revision: 1, name: 'Beta project', archived: false, sessionCount: 0 }],
		query: 'Unrelated page filter', descending: false, loading: false, busy: false, selectedId: undefined, selected: undefined, message: undefined,
	});
	const projects = { state: projectState, reload: async () => { } } as unknown as IProjectsService;
	const automations = {
		automations: observableValue<readonly IAutomationDescriptor[]>('plans', []),
		catalogueState: observableValue<AutomationCatalogueState>('planState', 'ready'), refresh: async () => { },
	} as unknown as IAutomationService;
	return { sessions, projects, projectState, automations };
}

suite('Sessions search model', () => {
	test('queries and categories belong to each search, independently of the source page filter', () => {
		const source = fixture();
		using first = new SessionsSearchModel(source.sessions, source.projects, source.automations);
		using second = new SessionsSearchModel(source.sessions, source.projects, source.automations);
		first.setQuery('beta');
		first.setCategory('projects');
		assert.deepEqual(first.state.get().results.map(result => result.target), [{ kind: 'project', id: 'beta' }]);
		assert.equal(second.state.get().query, '');
		assert.equal(second.state.get().category, 'all');
		assert.equal(source.projectState.get().query, 'Unrelated page filter');
	});

	test('filters active threads by title and host while retaining the exact navigation target', () => {
		const source = fixture();
		using model = new SessionsSearchModel(source.sessions, source.projects, source.automations);
		model.setCategory('sessions');
		model.setQuery('alpha host a');
		assert.deepEqual(model.state.get().results.map(result => result.target), [{ kind: 'session', sessionId: 'alpha', threadId: 'root' }]);
	});

	test('projects source changes without copying the catalogue into search state', () => {
		const source = fixture();
		using model = new SessionsSearchModel(source.sessions, source.projects, source.automations);
		model.setCategory('projects');
		assert.deepEqual(model.state.get().results.map(result => result.title), ['Beta project']);
		source.projectState.set({ ...source.projectState.get(), projects: [] });
		assert.deepEqual(model.state.get().results, []);
	});
});
