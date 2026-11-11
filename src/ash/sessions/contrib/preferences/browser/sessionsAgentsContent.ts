import './media/sessionsAgentsContent.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IAgentSessionService } from '../../../../platform/agentHost/common/agentService.js';
import { SettingsPageRenderer } from '../../../../workbench/contrib/preferences/browser/settingsRenderers.js';
import type { SettingsSectionReference, SettingsTreeNode } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';
import { AgentRolesWidget } from '../../../../workbench/contrib/preferences/browser/agentRolesWidget.js';
import type { TeamRun, TeamRole } from '../../../services/teams/common/team.js';
import { TeamsPanel } from './teamsPanel.js';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: AccessibilityVerbositySettingId.SessionsAgents,
	defaultValue: true,
	parse(value: unknown): boolean {
		if (typeof value !== 'boolean') throw new TypeError(localize('sessions.agents.verbosityInvalid', 'Agents accessibility verbosity must be boolean.'));
		return value;
	},
	setting: {
		valueType: 'boolean',
		get title() { return localize('sessions.agents.verbosityTitle', 'Agents accessibility help'); },
		get description() { return localize('sessions.agents.verbosityDescription', 'Announce how to open accessibility help for Agent roles and teams.'); },
	},
});

/** Settings owns role and Team management; the existing services remain the state owners. */
export class SessionsAgentsContent extends SettingsPageRenderer<SettingsSectionReference> {
	readonly categoryId = 'agents';
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private readonly domNode: HTMLElement;
	private readonly teamsContainer: HTMLElement;
	private readonly roles: AgentRolesWidget;
	private readonly teams: TeamsPanel;
	private visible = false;

	constructor(container: HTMLElement, beforeOpenEditor: () => Promise<void>, openTask: (run: TeamRun) => Promise<void>, onOpenFailed: (error: unknown) => void,
		@IAgentSessionService agents: IAgentSessionService,
		@IInstantiationService instantiation: IInstantiationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		const id = `ash-agents-${generateUuid()}`;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-sessions-agents';
		this.domNode.setAttribute('aria-label', localize('sessions.settings.agents', 'Agents'));
		this.roles = this._register(instantiation.createInstance(AgentRolesWidget, this.domNode, { beforeOpenEditor, onOpenFailed }));
		this._register(this.roles.onDidChange(() => this.changed.fire()));
		this.teamsContainer = h(document, 'div');
		this.teamsContainer.className = 'ash-settings-card-section';
		const teamsHeading = h(document, 'h4');
		teamsHeading.className = 'ash-settings-card-title';
		teamsHeading.textContent = localize('sessions.teams.title', 'Teams');
		this.teamsContainer.append(teamsHeading);
		this.domNode.append(this.teamsContainer);
		const listRoles = async () => (await agents.listAgents()).agents.map(agent => ({
			name: agent.name, description: agent.description,
			role: { type: 'exact' as const, name: agent.name, source: agent.source },
		}));
		this.teams = this._register(instantiation.createInstance(TeamsPanel, this.teamsContainer, listRoles, (role: Extract<TeamRole, { type: 'exact'; }>) => this.roles.revealRole(role), openTask));
		container.append(this.domNode);
		this._register(toDisposable(() => this.domNode.remove()));
		this._register(contextKeys.createScoped(this.domNode)).createKey(id, true);
		const updateHint = (): void => {
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.SessionsAgents);
			if (hint) this.domNode.setAttribute('aria-description', hint);
			else this.domNode.removeAttribute('aria-description');
		};
		updateHint();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.SessionsAgents)) updateHint();
		}));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 105, name: `${id}-${type}`, when: ContextKeyExpr.has(id),
				getProvider: () => {
					const focused = document.activeElement;
					if (!this.visible || !isHTMLElement(focused) || !this.domNode.contains(focused)) return undefined;
					return new AccessibleContentProvider(AccessibleViewProviderId.SessionsAgents, { type },
						() => type === AccessibleViewType.Help
							? localize('sessions.agents.help', 'Agent settings\nUse Tab to move through Custom Agents and Teams. Teams manages fixed members, their roles, the lead, tasks and discussion. View role opens the custom definition used by a member. Role changes apply to new runs; existing tasks keep their member and definition snapshots. Escape closes help and returns focus.')
							: this.teamsContainer.contains(focused) ? this.teams.getAccessibleContent() : this.roles.getAccessibleContent(),
						() => { if (focused.isConnected) focused.focus(); }, AccessibilityVerbositySettingId.SessionsAgents);
				},
			}));
		}
	}

	protected override buildNodes(): readonly SettingsTreeNode<SettingsSectionReference>[] {
		return [{
			element: {
				kind: 'item', id: 'agents.management', title: localize('sessions.settings.agents', 'Agents'), description: '',
				keywords: [...this.roles.keywords, localize({ bundle: 'ash.settings', key: 'roles.custom' }, 'Custom Agents'), localize('sessions.teams.title', 'Teams'), 'teams', 'members'],
				value: this.retainElement('agents.management', this.domNode),
			},
		}];
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.roles.setVisible(visible);
		if (visible) void this.teams.show();
	}
}
