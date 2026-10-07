import './media/teamsPanel.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import type { ISessionsService } from '../../../services/sessions/browser/sessionsService.js';
import type { Team, TeamMessage, TeamRole, TeamRun } from '../../../services/teams/common/team.js';
import type { ITeamsManagementService } from '../../../services/teams/common/teamsManagement.js';

export interface TeamRoleOption {
	readonly name: string;
	readonly description: string;
	readonly role: TeamRole;
}

/** Team catalog and task entry in the Agents sidebar. */
export class TeamsPanel extends Disposable {
	readonly domNode: HTMLElement;
	private readonly content: HTMLDivElement;
	private readonly status: HTMLParagraphElement;
	private readonly renderListeners = this._register(new DisposableStore());
	private selectedId: string | undefined;
	private runs: readonly TeamRun[] = [];
	private messages: readonly TeamMessage[] = [];
	private error: string | undefined;

	constructor(
		container: HTMLElement,
		private readonly teams: ITeamsManagementService,
		private readonly sessions: ISessionsService,
		private readonly quickInput: IQuickInputService,
		private readonly listRoles: () => Promise<readonly TeamRoleOption[]>,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-teams-panel';
		this.domNode.hidden = true;
		const heading = h(document, 'h2');
		heading.textContent = localize('sessions.teams.title', 'Teams');
		this.content = h(document, 'div');
		this.content.className = 'ash-teams-content';
		this.status = h(document, 'p');
		this.status.className = 'ash-teams-status';
		this.status.setAttribute('role', 'status');
		this.status.setAttribute('aria-live', 'polite');
		this.domNode.append(heading, this.status, this.content);
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(this.teams.teams.onDidChange(() => this.render()));
		this.render();
	}

	async show(): Promise<void> {
		this.domNode.hidden = false;
		await this.perform(async () => { await this.teams.refresh(); await this.loadSelected(); });
	}

	focus(): void { this.content.querySelector<HTMLButtonElement>('button')?.focus(); }

	private async perform(operation: () => Promise<void>): Promise<void> {
		this.error = undefined;
		this.status.textContent = localize('sessions.teams.working', 'Working…');
		try { await operation(); }
		catch (error) { this.error = error instanceof Error ? error.message : String(error); }
		this.render();
	}

	private async loadSelected(): Promise<void> {
		const team = this.current();
		if (!team) { this.runs = []; this.messages = []; return; }
		const id = team.teamId;
		const [runs, messages] = await Promise.all([
			this.teams.listRuns(id),
			this.teams.listMessages(id, team.coordinatorId),
		]);
		if (this.selectedId !== id) return;
		this.runs = runs;
		this.messages = messages;
	}

	private current(): Team | undefined { return this.teams.teams.get().find(team => team.teamId === this.selectedId); }

	private render(): void {
		this.renderListeners.clear();
		this.content.replaceChildren();
		this.status.textContent = this.error ?? '';
		this.status.setAttribute('role', this.error ? 'alert' : 'status');
		const document = this.domNode.ownerDocument;
		const toolbar = h(document, 'div');
		toolbar.className = 'ash-teams-toolbar';
		this.button(toolbar, localize('sessions.teams.new', 'New Team'), () => this.perform(() => this.createTeam()));
		this.button(toolbar, localize('sessions.teams.refresh', 'Refresh'), () => this.perform(async () => { await this.teams.refresh(); await this.loadSelected(); }));
		this.content.append(toolbar);
		const list = h(document, 'div');
		list.className = 'ash-teams-list';
		for (const team of this.teams.teams.get()) {
			const label = `${team.name} · ${team.members.length}`;
			const entry = this.button(list, label, () => this.perform(async () => { this.selectedId = team.teamId; await this.loadSelected(); }));
			entry.setAttribute('aria-current', team.teamId === this.selectedId ? 'true' : 'false');
			entry.classList.add('ash-teams-list-item');
			entry.classList.toggle('selected', team.teamId === this.selectedId);
		}
		this.content.append(list);
		const team = this.current();
		if (!team) return;
		const detail = h(document, 'div');
		detail.className = 'ash-teams-detail';
		const title = h(document, 'h3');
		title.textContent = team.name;
		detail.append(title);
		if (team.description) this.paragraph(detail, team.description);
		this.paragraph(detail, team.status === 'archived' ? localize('sessions.teams.archived', 'Archived') : localize('sessions.teams.active', 'Active'));
		const actions = h(document, 'div');
		actions.className = 'ash-teams-actions';
		if (team.status === 'active') {
			this.button(actions, localize('sessions.teams.start', 'Start task'), () => this.perform(() => this.startTask(team)));
			this.button(actions, localize('sessions.teams.edit', 'Edit Team'), () => this.perform(async () => {
				const name = await this.input(localize('sessions.teams.name', 'Team name'), team.name);
				if (!name) return;
				const description = await this.quickInput.input({ title: localize('sessions.teams.description', 'Team description'), placeHolder: team.description });
				if (description === undefined) return;
				await this.teams.updateDetails(team, name, description);
				await this.loadSelected();
			}));
			this.button(actions, localize('sessions.teams.add', 'Add member'), () => this.perform(() => this.addMember(team)));
			this.button(actions, localize('sessions.teams.archive', 'Archive'), () => this.perform(async () => { await this.teams.archive(team); await this.loadSelected(); }));
		} else {
			this.button(actions, localize('sessions.teams.restore', 'Restore'), () => this.perform(async () => { await this.teams.restore(team); await this.loadSelected(); }));
		}
		detail.append(actions);
		const members = h(document, 'div');
		members.className = 'ash-teams-members';
		const membersHeading = h(document, 'h4');
		membersHeading.textContent = localize('sessions.teams.members', 'Members');
		members.append(membersHeading);
		for (const member of team.members) {
			const row = h(document, 'div');
			row.className = 'ash-teams-member';
			this.paragraph(row, `${member.name} · ${member.responsibility}${member.agentId === team.coordinatorId ? ` · ${localize('sessions.teams.lead', 'Lead')}` : ''}`);
			this.paragraph(row, member.role.type === 'exact' ? member.role.name : localize('sessions.teams.defaultRole', 'Default Agent'));
			if (team.status === 'active') {
				this.button(row, localize('sessions.teams.editMember', 'Edit member'), () => this.perform(async () => {
					const name = await this.input(localize('sessions.teams.memberName', 'Member name'), member.name);
					if (!name) return;
					const responsibility = await this.input(localize('sessions.teams.memberResponsibility', 'Member responsibility'), member.responsibility);
					if (!responsibility) return;
					await this.teams.updateMember(team, { ...member, name, responsibility });
					await this.loadSelected();
				}));
				this.button(row, localize('sessions.teams.changeRole', 'Change role'), () => this.perform(async () => {
					const role = await this.pickRole();
					if (role) { await this.teams.updateMember(team, { ...member, role }); await this.loadSelected(); }
				}));
				if (member.agentId !== team.coordinatorId) {
					this.button(row, localize('sessions.teams.makeLead', 'Make lead'), () => this.perform(async () => { await this.teams.setCoordinator(team, member.agentId); await this.loadSelected(); }));
					this.button(row, localize('sessions.teams.remove', 'Remove'), () => this.perform(async () => { await this.teams.removeMember(team, member.agentId); await this.loadSelected(); }));
				}
			}
			members.append(row);
		}
		detail.append(members);
		const runs = h(document, 'div');
		const runsHeading = h(document, 'h4');
		runsHeading.textContent = localize('sessions.teams.tasks', 'Tasks');
		runs.append(runsHeading);
		for (const run of this.runs) this.button(runs, run.objective, () => this.perform(() => this.sessions.openThread(run.sessionId, run.coordinatorThreadId)));
		detail.append(runs);
		const discussion = h(document, 'div');
		const discussionHeading = h(document, 'h4');
		discussionHeading.textContent = localize('sessions.teams.discussion', 'Discussion');
		discussion.append(discussionHeading);
		for (const message of this.messages) {
			const author = team.members.find(member => member.agentId === message.senderId)?.name ?? message.senderId;
			this.paragraph(discussion, `${author}: ${message.text}`);
		}
		this.button(discussion, localize('sessions.teams.post', 'Post message'), () => this.perform(() => this.postMessage(team)));
		detail.append(discussion);
		this.content.append(detail);
	}

	private async createTeam(): Promise<void> {
		const name = await this.input(localize('sessions.teams.name', 'Team name'));
		if (!name) return;
		const description = await this.quickInput.input({ title: localize('sessions.teams.description', 'Team description') });
		if (description === undefined) return;
		const coordinatorName = await this.input(localize('sessions.teams.coordinatorName', 'Lead name'));
		if (!coordinatorName) return;
		const responsibility = await this.input(localize('sessions.teams.coordinatorResponsibility', 'Lead responsibility'));
		if (!responsibility) return;
		const role = await this.pickRole();
		if (!role) return;
		const team = await this.teams.create(name, description, coordinatorName, responsibility, role);
		this.selectedId = team.teamId;
		await this.loadSelected();
	}

	private async addMember(team: Team): Promise<void> {
		const name = await this.input(localize('sessions.teams.memberName', 'Member name'));
		if (!name) return;
		const responsibility = await this.input(localize('sessions.teams.memberResponsibility', 'Member responsibility'));
		if (!responsibility) return;
		const role = await this.pickRole();
		if (!role) return;
		await this.teams.addMember(team, name, responsibility, role);
		await this.loadSelected();
	}

	private async startTask(team: Team): Promise<void> {
		const objective = await this.input(localize('sessions.teams.objective', 'Team task'));
		if (!objective) return;
		const run = await this.teams.startRun(team, objective);
		await this.loadSelected();
		await this.sessions.openThread(run.sessionId, run.coordinatorThreadId);
	}

	private async postMessage(team: Team): Promise<void> {
		const text = await this.input(localize('sessions.teams.message', 'Team message'));
		if (!text) return;
		await this.teams.postMessage(team.teamId, null, team.coordinatorId, null, text);
		await this.loadSelected();
	}

	private input(title: string, current?: string): Promise<string | undefined> {
		return this.quickInput.input({ title, placeHolder: current, validateInput: async value => value.trim() ? null : localize('sessions.teams.required', 'Enter a value') });
	}

	private async pickRole(): Promise<TeamRole | undefined> {
		const options = [{ name: localize('sessions.teams.defaultRole', 'Default Agent'), description: '', role: { type: 'default' } as TeamRole }, ...await this.listRoles()];
		interface RoleItem extends IQuickPickItem { readonly role: TeamRole; }
		const picker = this.quickInput.createQuickPick<RoleItem>();
		picker.placeholder = localize('sessions.teams.chooseRole', 'Choose Agent role');
		picker.ariaLabel = picker.placeholder;
		picker.items = options.map(option => ({ label: option.name, description: option.description, role: option.role }));
		return new Promise(resolve => {
			let settled = false;
			const finish = (role: TeamRole | undefined): void => { if (settled) return; settled = true; resolve(role); picker.hide(); };
			const accepted = picker.onDidAccept(item => finish(item.role));
			const hidden = picker.onDidHide(() => { finish(undefined); accepted.dispose(); hidden.dispose(); picker.dispose(); });
			picker.show();
		});
	}

	private button(parent: HTMLElement, label: string, action: () => void | Promise<void>): HTMLButtonElement {
		const button = h(parent.ownerDocument, 'button');
		button.type = 'button';
		button.textContent = label;
		button.setAttribute('aria-label', label);
		parent.append(button);
		this.renderListeners.add(addDisposableListener(button, 'click', () => { void action(); }));
		return button;
	}

	private paragraph(parent: HTMLElement, text: string): void {
		const paragraph = h(parent.ownerDocument, 'p');
		paragraph.textContent = text;
		parent.append(paragraph);
	}
}
