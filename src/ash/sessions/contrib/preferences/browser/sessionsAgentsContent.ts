import './media/sessionsAgentsContent.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { TabList, type TabListItem } from '../../../../base/browser/ui/tablist/tabList.js';
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
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IAgentSessionService } from '../../../../platform/agentHost/common/agentService.js';
import { SettingsPageRenderer, SettingsRenderer } from '../../../../workbench/contrib/preferences/browser/settingsRenderers.js';
import { SettingsTree } from '../../../../workbench/contrib/preferences/browser/settingsTree.js';
import { SettingsTreeModel, type SettingsSectionReference, type SettingsTreeNode } from '../../../../workbench/contrib/preferences/browser/settingsTreeModels.js';
import { SettingsSearchQuery } from '../../../../workbench/contrib/preferences/browser/settingsSearch.js';
import { AgentRolesWidget } from '../../../../workbench/contrib/preferences/browser/agentRolesWidget.js';
import type { TeamRun, TeamRole } from '../../../services/teams/common/team.js';
import { TeamsPanel } from './teamsPanel.js';

type AgentsView = 'roles' | 'teams';
const activeViewKey = 'sessions.agents.activeView';

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
	private readonly settingsModel = this._register(new SettingsTreeModel<SettingsSectionReference>());
	private query = new SettingsSearchQuery('');
	private readonly domNode: HTMLElement;
	private readonly tabs: TabList<AgentsView>;
	private readonly tabItems: readonly TabListItem<AgentsView>[];
	private readonly rolesContainer: HTMLElement;
	private readonly teamsContainer: HTMLElement;
	private readonly roles: AgentRolesWidget;
	private readonly teams: TeamsPanel;
	private activeView: AgentsView;
	private visible = false;
	private teamsVisible = false;

	constructor(container: HTMLElement, private readonly settings: readonly SettingsPageRenderer<SettingsSectionReference>[],
		beforeOpenEditor: () => Promise<void>, openTask: (run: TeamRun) => Promise<void>, onOpenFailed: (error: unknown) => void,
		@IAgentSessionService agents: IAgentSessionService,
		@IInstantiationService instantiation: IInstantiationService,
		@IStorageService private readonly storage: IStorageService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IConfigurationService configuration: IConfigurationService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		const id = `ash-agents-${generateUuid()}`;
		this.activeView = storage.get(activeViewKey, StorageScope.PROFILE) === 'teams' ? 'teams' : 'roles';
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-sessions-agents';
		this.domNode.setAttribute('aria-label', localize('sessions.settings.agents', 'Agents'));
		const navigation = h(document, 'div');
		navigation.className = 'ash-agents-tabs';
		this.tabs = this._register(new TabList(navigation, {
			ariaLabel: localize('sessions.agents.views', 'Agent views'),
			presentation: 'inset',
			onActivate: view => this.selectView(view),
		}));
		this.tabItems = (['roles', 'teams'] as const).map(view => ({
			id: view, value: view,
			label: view === 'roles' ? localize('sessions.agents.roles', 'Roles') : localize('sessions.teams.title', 'Teams'),
			tabId: `${id}-${view}-tab`, panelId: `${id}-${view}-panel`,
		}));
		const createPanel = (tab: TabListItem<AgentsView>): HTMLElement => {
			const panel = h(document, 'div');
			panel.id = tab.panelId!;
			panel.className = `ash-agents-view ash-agents-${tab.id}`;
			panel.setAttribute('role', 'tabpanel');
			panel.setAttribute('aria-labelledby', tab.tabId);
			return panel;
		};
		this.rolesContainer = createPanel(this.tabItems[0]!);
		this.teamsContainer = createPanel(this.tabItems[1]!);
		const settingsContainer = h(document, 'div');
		this.rolesContainer.append(settingsContainer);
		const renderer = this._register(instantiation.createInstance(SettingsRenderer, settingsContainer, {}));
		for (const section of settings) {
			this._register(renderer.registerPage(section));
			this._register(section.onDidChange(() => this.changed.fire()));
		}
		this._register(new SettingsTree(settingsContainer, {
			model: this.settingsModel,
			rootClassName: 'ash-sessions-agents-settings-tree',
			groupClassName: 'ash-sessions-settings-content-group',
			groupDescriptionClassName: 'ash-sessions-settings-group-description',
			itemsClassName: 'ash-sessions-settings-list ash-settings-card',
			renderGroupHeader: header => renderer.render(header),
			renderItem: item => renderer.render(item.value),
		}));
		this.roles = this._register(instantiation.createInstance(AgentRolesWidget, this.rolesContainer, { beforeOpenEditor, onOpenFailed }));
		this._register(this.roles.onDidChange(() => this.changed.fire()));
		const listRoles = async () => (await agents.listAgents()).agents.map(agent => ({
			name: agent.name, description: agent.description,
			role: { type: 'exact' as const, name: agent.name, source: agent.source },
		}));
		this.teams = this._register(instantiation.createInstance(TeamsPanel, this.teamsContainer, listRoles, (role: Extract<TeamRole, { type: 'exact'; }>) => {
			this.selectView('roles');
			this.roles.revealRole(role);
		}, openTask));
		this.domNode.append(navigation, this.rolesContainer, this.teamsContainer);
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
							? localize('sessions.agents.help', 'Agent settings\nRoles and Teams share this Settings page. Use Left and Right, Home or End to move between tabs, then Enter or Space to open a view. Tab moves into the selected view. Roles shows built-in and custom definitions; expand a role to inspect its instructions and capabilities, edit a custom definition or copy an eligible built-in role. Teams manages fixed members, their roles, the lead, tasks and discussion. View role opens the exact definition used by a member. Switching views retains role disclosures and the selected team. Role changes apply to new runs; existing tasks keep their member and definition snapshots. Escape closes help and returns focus.')
							: this.activeView === 'roles' ? this.roles.getAccessibleContent() : this.teams.getAccessibleContent(),
						() => { if (focused.isConnected) focused.focus(); }, AccessibilityVerbositySettingId.SessionsAgents);
				},
			}));
		}
		this.update();
	}

	protected override buildNodes(query: SettingsSearchQuery): readonly SettingsTreeNode<SettingsSectionReference>[] {
		this.query = query;
		this.update();
		const management: SettingsTreeNode<SettingsSectionReference> = {
			element: {
				kind: 'item', id: 'agents.management', title: localize('sessions.settings.agents', 'Agents'), description: '',
				keywords: [...this.roles.keywords, ...this.tabItems.map(tab => tab.label), 'teams', 'members'],
				value: this.retainElement('agents.management', this.domNode),
			}
		};
		// Search preserves the original setting IDs and retained service-backed controls.
		return query.isEmpty ? [management] : [...this.settings.flatMap(section => section.getNodes(query)), management];
	}

	setVisible(visible: boolean): void {
		if (this.visible === visible) return;
		this.visible = visible;
		this.update();
	}


	private selectView(view: AgentsView): void {
		this.activeView = view;
		this.storage.store(activeViewKey, view, StorageScope.PROFILE, StorageTarget.USER);
		this.update();
	}

	private update(): void {
		const searching = !this.query.isEmpty;
		this.settingsModel.setChildren(searching ? [] : this.settings.flatMap(section => section.getNodes(this.query)));
		this.settingsModel.setQuery(this.query);
		this.tabs.element.hidden = searching;
		this.tabs.setTabs(this.tabItems, this.activeView);
		this.rolesContainer.hidden = !searching && this.activeView !== 'roles';
		this.teamsContainer.hidden = !searching && this.activeView !== 'teams';
		const showRoles = this.visible && (searching || this.activeView === 'roles');
		this.roles.setVisible(showRoles);
		for (const section of this.settings) section.setVisible(showRoles);
		const showTeams = this.visible && (searching || this.activeView === 'teams');
		if (showTeams && !this.teamsVisible) void this.teams.show();
		this.teamsVisible = showTeams;
	}
}
