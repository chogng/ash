import { h } from '../../../../base/browser/dom.js';
import { status } from '../../../../base/browser/ui/aria/aria.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputbox.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { isCancellationError } from '../../../../base/common/errors.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import type { AgentRoleDefinition } from '../../../../platform/agentHost/common/agent.js';
import type { IAgentSessionService } from '../../../../platform/agentHost/common/agentService.js';
import type { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IProjectService, Project } from '../../../../platform/projects/common/projectService.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../workbench/browser/parts/dialogs/dialog.js';
import { projectBotHandle, projectBotKind, type Team, type TeamMember, type TeamRole } from '../../../services/teams/common/team.js';
import type { ITeamsManagementService } from '../../../services/teams/common/teamsManagement.js';
import './media/projectBotsDialog.css';

export async function showProjectBotsDialog(container: HTMLElement, store: DisposableStore, projectId: string,
	projects: IProjectService, teams: ITeamsManagementService, agent: IAgentSessionService, dialogs: IDialogService,
): Promise<void> {
	const document = container.ownerDocument;
	const rows = store.add(new DisposableStore());
	const candidates = store.add(new DisposableStore());
	const ashResponsibility = localize('sessions.projectBots.ashResponsibility', 'Handle new project tasks.');
	const builtin = new Map([
		['advisor', localize('sessions.projectBots.advisor', 'Advisor')],
		['reviewer', localize('sessions.projectBots.reviewer', 'Code Review')],
		['issue', localize('sessions.projectBots.issue', 'Issue')],
	]);
	const memberLabel = (member: TeamMember) => member.role.type === 'exact' && member.role.source.type === 'builtIn'
		? builtin.get(member.role.name) ?? member.name : member.name;
	const handle = (role: TeamRole) => projectBotHandle(role).toLowerCase();
	const memberTitle = localize('sessions.projectBots.members', 'Project Bots');
	const addTitle = localize('sessions.projectBots.add', 'Add Bot');
	const removeTitle = localize('sessions.projectBots.remove', 'Remove');
	const projectName = h(document, 'p', { className: 'ash-project-bots-project' });
	const memberHeading = h(document, 'h2', { properties: { tabIndex: -1 } }, memberTitle);
	const header = h(document, 'div', { className: 'ash-project-bots-header' }, memberHeading);
	const list = h(document, 'ul', { attributes: { 'aria-label': memberTitle, role: 'list' } });
	const availableTitle = localize('sessions.projectBots.available', 'Available Bots');
	const available = h(document, 'ul', { attributes: { 'aria-label': availableTitle, role: 'list' } });
	const empty = h(document, 'p', { className: 'ash-project-bots-note' });
	const searchRow = h(document, 'div');
	const catalog = h(document, 'section', {
		className: 'ash-project-bots-catalog', properties: { hidden: true, id: generateUuid() },
	}, h(document, 'h2', availableTitle), searchRow, available, empty);
	const notice = h(document, 'p', { className: 'ash-project-bots-note', attributes: { role: 'status' } });
	const feedback = h(document, 'p', { className: 'ash-project-bots-error', attributes: { role: 'alert' } });
	const body = h(document, 'div', { className: 'ash-project-bots-body' }, projectName, header, list, catalog, notice, feedback);
	const footer = h(document, 'div', { className: 'ash-sessions-form-actions' });
	const searchLabel = localize('sessions.projectBots.search', 'Search Bots');
	const search = store.add(new InputBox(searchRow, { ariaLabel: searchLabel, placeholder: searchLabel, inputBoxStyles: defaultInputBoxStyles, presentation: 'field' }));
	const rowNames = new Map<string, HTMLElement>();
	let roster: { readonly project: Project; readonly team: Team | undefined; } | undefined;
	let definitions: readonly AgentRoleDefinition[] | undefined;
	let busy = false;
	let closed = false;
	store.add(search.onDidChange(() => renderCandidates()));

	const dialog = store.add(new Dialog(container, localize('sessions.projectBots.manage', 'Manage Bots'), [], createWorkbenchDialogOptions({
		layout: 'form', disableDefaultAction: true, extraClasses: ['ash-project-bots-dialog'],
		renderBody: element => element.append(body), renderFooter: element => element.append(footer),
	})));
	store.add(new Button(footer, {
		...defaultButtonStyles, presentation: 'secondary', label: localize('sessions.projectBots.done', 'Done'),
		onClick: () => void dialog.requestClose(),
	}));
	const add = store.add(new Button(header, {
		...defaultButtonStyles, presentation: 'secondary', size: 'small', label: addTitle, enabled: false,
		onClick: () => {
			if (busy) return;
			if (!catalog.hidden) {
				setCatalogOpen(false);
				return;
			}
			definitions = undefined;
			setCatalogOpen(true);
			search.value = '';
			search.focus();
			renderCandidates();
			empty.textContent = localize('sessions.projectBots.loadingAvailable', 'Loading available Bots…');
			void run(async () => {
				try {
					definitions = (await agent.readRoleCatalog()).agents;
				} finally {
					if (!closed) renderCandidates();
				}
			});
		},
	}));
	add.domNode.setAttribute('aria-expanded', 'false');
	add.domNode.setAttribute('aria-controls', catalog.id);

	function setCatalogOpen(open: boolean): void {
		catalog.hidden = !open;
		add.domNode.setAttribute('aria-expanded', String(open));
	}

	function row(root: HTMLElement, name: string, detail: string) {
		const title = h(document, 'span', { className: 'ash-project-bots-name', properties: { tabIndex: -1, title: name } }, name);
		const icon = h(document, 'span', { className: 'ash-project-bots-icon', attributes: { 'aria-hidden': 'true' } });
		appendIcon(Lxicon.bot, icon);
		const labels = h(document, 'div', { className: 'ash-project-bots-labels' }, title,
			h(document, 'span', { className: 'ash-project-bots-detail', properties: { title: detail } }, detail));
		const actions = h(document, 'div', { className: 'ash-project-bots-actions' });
		root.append(h(document, 'li', { className: 'ash-project-bots-row' }, icon, labels, actions));
		return { title, actions };
	}

	function botDetail(role: TeamRole): string {
		const name = projectBotHandle(role);
		return role.type === 'exact' && role.source.type === 'user'
			? localize('sessions.projectBots.personalSource', '@{0} · My Bots', name) : `@${name}`;
	}

	function renderRoster(): void {
		if (!roster) return;
		rows.clear();
		rowNames.clear();
		list.replaceChildren();
		const { project, team } = roster;
		projectName.textContent = project.name;
		const editable = !project.archived && team?.status !== 'archived';
		add.enabled = editable && !!projects.ensureDefaultTeam;
		if (!editable) setCatalogOpen(false);
		notice.textContent = project.archived ? localize('sessions.projectBots.projectArchived', 'Restore the project to manage its Bots.')
			: team?.status === 'archived' ? localize('sessions.projectBots.teamArchived', 'Restore the project Team in Agents settings to manage its Bots.') : '';
		const defaultLabel = localize('sessions.projectBots.currentDefault', 'Default');
		if (!team) {
			// An untouched Project already runs new work as Ash. Create its Team only when adding a Bot.
			const { actions } = row(list, 'Ash', '@Ash');
			actions.append(h(document, 'span', { className: 'ash-project-bots-default' }, defaultLabel));
			return;
		}
		const members = [...team.members].sort((a, b) => Number(b.agentId === team.coordinatorId) - Number(a.agentId === team.coordinatorId));
		for (const member of members) {
			const name = memberLabel(member);
			const { title, actions } = row(list, name, botDetail(member.role));
			const isDefault = member.agentId === team.coordinatorId;
			rowNames.set(member.agentId, title);
			if (isDefault) actions.append(h(document, 'span', { className: 'ash-project-bots-default' }, defaultLabel));
			else if (editable && projectBotKind(member.role) === 'agent') {
				rows.add(new Button(actions, {
					...defaultButtonStyles, presentation: 'secondary', size: 'small', label: localize('sessions.projectBots.setDefault', 'Set as default'),
					ariaLabel: localize('sessions.projectBots.setDefaultBot', 'Set {0} as default', name),
					onClick: () => void run(async () => {
						await mutate(() => teams.setCoordinator(team, member.agentId));
						if (closed) return;
						rowNames.get(member.agentId)?.focus();
						status(localize('sessions.projectBots.defaultChanged', '{0} is now the project default.', name));
					}),
				}));
			}
			if (editable && member.role.type !== 'default' && projects.removeBot) {
				rows.add(new Button(actions, {
					...defaultButtonStyles, presentation: 'quiet', size: 'small', label: removeTitle,
					ariaLabel: localize('sessions.projectBots.removeBot', 'Remove {0}', name),
					onClick: () => void run(async () => {
						if (isDefault) {
							const answer = await dialogs.confirm({
								message: localize('sessions.projectBots.confirmRemoveDefault', 'Remove {0} from this project?', name),
								detail: localize('sessions.projectBots.removeDefaultDetail', 'Ash will take over new tasks. Existing tasks and conversations are kept.'),
								primaryButton: removeTitle, destructive: true,
							});
							if (closed || !answer.confirmed) return;
						}
						await mutate(() => projects.removeBot!(projectId, member.agentId, team.revision, ashResponsibility));
						if (closed) return;
						memberHeading.focus();
						status(isDefault ? localize('sessions.projectBots.removedDefault', '{0} was removed. Ash is now the project default.', name)
							: localize('sessions.projectBots.removed', '{0} was removed from the project.', name));
					}),
				}));
			}
		}
	}

	function renderCandidates(): void {
		candidates.clear();
		available.replaceChildren();
		empty.textContent = '';
		if (catalog.hidden || !definitions) return;
		const existing = new Set(roster?.team?.members.map(member => handle(member.role)));
		const query = search.value.trim().toLowerCase();
		for (const definition of definitions) {
			const role: TeamRole = { type: 'exact', name: definition.name, source: definition.source };
			const name = definition.source.type === 'builtIn' ? builtin.get(definition.name) : definition.launch === 'any' ? definition.name : undefined;
			if (!name || handle(role) === 'ash' || existing.has(handle(role))) continue;
			const detail = botDetail(role);
			if (query && !name.toLowerCase().includes(query) && !detail.toLowerCase().includes(query)) continue;
			const { title, actions } = row(available, name, detail);
			title.title = definition.description || name;
			candidates.add(new Button(actions, {
				...defaultButtonStyles, presentation: 'secondary', size: 'small', label: localize('sessions.projectBots.addAction', 'Add'),
				ariaLabel: localize('sessions.projectBots.addBot', 'Add {0}', name),
				onClick: () => void run(async () => {
					await mutate(async () => {
						const project = await projects.read(projectId, 'code');
						if (closed) return;
						if (project.archived) throw new Error(localize('sessions.projectBots.projectArchived', 'Restore the project to manage its Bots.'));
						const current = project.defaultTeamId ? project : await projects.ensureDefaultTeam!(projectId, ashResponsibility);
						if (closed || !current.defaultTeamId) return;
						const team = await teams.read(current.defaultTeamId);
						if (closed || team.members.some(member => handle(member.role) === handle(role))) return;
						await teams.addMember(team, name, definition.description, role);
					});
					if (closed) return;
					search.focus();
					status(localize('sessions.projectBots.added', '{0} was added to the project.', name));
				}),
			}));
		}
		if (!available.childElementCount) empty.textContent = query ? localize('sessions.projectBots.noMatches', 'No Bots match the search.')
			: localize('sessions.projectBots.allAdded', 'All available Bots are already in this project.');
	}

	async function refreshRoster(): Promise<void> {
		const project = await projects.read(projectId, 'code');
		if (closed) return;
		const team = project.defaultTeamId ? await teams.read(project.defaultTeamId) : undefined;
		if (closed) return;
		roster = { project, team };
		renderRoster();
		renderCandidates();
	}

	async function mutate(action: () => Promise<unknown>): Promise<void> {
		try {
			await action();
		} catch (error) {
			if (!closed) {
				await refreshRoster().catch(() => undefined);
				(catalog.hidden ? memberHeading : search.inputElement).focus();
			}
			throw error;
		}
		if (!closed) await refreshRoster();
	}

	async function run(action: () => Promise<void>): Promise<void> {
		if (busy || closed) return;
		busy = true;
		body.setAttribute('aria-busy', 'true');
		feedback.textContent = '';
		try {
			await action();
		} catch (failure) {
			if (!closed && !isCancellationError(failure)) feedback.textContent = toErrorMessage(failure);
		} finally {
			busy = false;
			body.removeAttribute('aria-busy');
		}
	}

	notice.textContent = localize('sessions.projectBots.loading', 'Loading project Bots…');
	const result = dialog.show();
	memberHeading.focus();
	void run(refreshRoster);
	await result;
	closed = true;
}
