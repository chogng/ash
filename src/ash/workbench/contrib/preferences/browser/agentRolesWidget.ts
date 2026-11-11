import './media/agentRolesSettingsRenderer.css';
import { h, isHTMLElement } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { localize } from '../../../../nls.js';
import { AccessibleContentProvider, AccessibleViewProviderId, AccessibleViewType, AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { AgentRoleDefinition } from '../../../../platform/agentHost/common/agent.js';
import { IAgentSessionService } from '../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IAppServerRemoteAgentService } from '../../../services/remote/common/appServerRemoteAgentService.js';

/** Shared custom Agent management; the backend owns the definitions. */
export class AgentRolesWidget extends Disposable {
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChange = this.changed.event;
	/** Hosts may mount this root; content and focus remain owned by the widget. */
	public readonly domNode: HTMLElement;
	private readonly statusDomNode: HTMLElement;
	private readonly listDomNode: HTMLElement;
	private readonly refresh: Button;
	private readonly entries = new Map<string, { readonly digest: string; readonly resource: string | undefined; readonly domNode: HTMLElement; }>();
	private readonly entryResources = this._register(new DisposableMap<string, DisposableStore>());
	private customRoles: readonly AgentRoleDefinition[] | undefined;
	private visible = false;
	private loading = false;
	private revision = 0;
	private pendingRole: Pick<AgentRoleDefinition, 'name' | 'source'> | undefined;

	constructor(container: HTMLElement, private readonly options: { readonly beforeOpenEditor?: () => Promise<void>; readonly onOpenFailed?: (error: unknown) => void; },
		@IAgentSessionService private readonly agents: IAgentSessionService,
		@IEditorService private readonly editors: IEditorService,
		@IAppServerRemoteAgentService remote: IAppServerRemoteAgentService,
		@IConfigurationService configuration: IConfigurationService,
		@IContextKeyService contextKeys: IContextKeyService,
		@IAccessibleViewService accessibleView: IAccessibleViewService,
	) {
		super();
		const document = container.ownerDocument;
		this.domNode = h(document, 'section');
		this.domNode.className = 'ash-agent-roles-settings ash-settings-card-section';
		const title = localize({ bundle: 'ash.settings', key: 'roles.custom' }, 'Custom Agents');
		this.domNode.setAttribute('aria-label', title);
		const heading = h(document, 'h4');
		heading.className = 'ash-settings-card-title';
		heading.textContent = title;
		const actions = h(document, 'div');
		actions.className = 'ash-agent-roles-actions';
		this.refresh = this._register(new Button(actions, {
			...defaultButtonStyles, presentation: 'secondary',
			label: localize({ bundle: 'ash.settings', key: 'roles.refresh' }, 'Refresh definitions'),
		}));
		this._register(this.refresh.onDidClick(() => { void this.load(); }));
		const description = h(document, 'p');
		description.textContent = localize({ bundle: 'ash.settings', key: 'roles.description' }, 'Edit Agents from .ash/agents in the authorized directory. Refresh after saving to apply changes to new runs.');
		this.statusDomNode = h(document, 'p');
		this.statusDomNode.setAttribute('role', 'status');
		this.statusDomNode.setAttribute('aria-live', 'polite');
		this.listDomNode = h(document, 'div');
		this.domNode.append(heading, description, actions, this.statusDomNode, this.listDomNode);
		container.append(this.domNode);
		this._register(toDisposable(() => { this.revision++; this.entries.clear(); this.domNode.remove(); }));
		this._register(remote.onDidChangeConnectionState(state => {
			this.revision++;
			this.customRoles = undefined;
			this.clearEntries();
			this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'roles.disconnected' }, 'Connect to App Server to inspect Agent definitions.');
			this.refresh.enabled = state === 'connected';
			if (state === 'connected' && this.visible) { void this.load(); }
		}));
		const key = `agentRolesSettings-${generateUuid()}`;
		this._register(contextKeys.createScoped(this.domNode)).createKey(key, true);
		const updateHint = (): void => {
			const hint = accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.AgentRolesSettings);
			if (hint) { this.domNode.setAttribute('aria-description', hint); }
			else { this.domNode.removeAttribute('aria-description'); }
		};
		updateHint();
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.AgentRolesSettings)) { updateHint(); }
		}));
		for (const type of [AccessibleViewType.Help, AccessibleViewType.View]) {
			this._register(AccessibleViewRegistry.register({
				type, priority: 110, name: `${key}-${type}`, when: ContextKeyExpr.has(key),
				getProvider: () => {
					const focused = document.activeElement;
					if (!this.visible || !isHTMLElement(focused) || !this.domNode.contains(focused)) { return undefined; }
					return new AccessibleContentProvider(AccessibleViewProviderId.AgentRolesSettings, { type },
						() => type === AccessibleViewType.Help
							? localize({ bundle: 'ash.settings', key: 'roles.help' }, 'Custom Agents\nUse Tab to reach a custom Agent. Press Enter or Space to expand its instructions and capabilities. Edit definition opens the file in the editor. Refresh definitions reloads saved files for new runs and reports invalid definitions. The accessible view lists custom Agents. Escape closes help and returns focus.')
							: this.getAccessibleContent(),
						() => { if (focused.isConnected) { focused.focus(); } }, AccessibilityVerbositySettingId.AgentRolesSettings);
				},
			}));
		}
	}

	public get keywords(): readonly string[] {
		return ['roles', 'prompt', 'tools', 'skills', ...this.customRoles?.flatMap(role => [role.name, role.description]) ?? []];
	}

	public revealRole(role: Pick<AgentRoleDefinition, 'name' | 'source'>): void {
		this.pendingRole = role;
		if (!this.loading) this.revealPendingRole();
	}

	private revealPendingRole(): void {
		if (!this.visible || !this.pendingRole || !this.customRoles) return;
		const requested = this.pendingRole;
		const role = this.customRoles.find(candidate => candidate.name === requested.name
			&& candidate.source.type === requested.source.type
			&& (candidate.source.type !== 'directory' || requested.source.type === 'directory' && candidate.source.id === requested.source.id));
		const entry = role && this.entries.get(JSON.stringify([role.source, role.name]));
		if (!entry) {
			this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'roles.unavailable' }, 'The role is no longer available: {0}', requested.name);
			this.pendingRole = undefined;
			this.refresh.focus();
			return;
		}
		const details = entry.domNode as HTMLDetailsElement;
		details.open = true;
		details.querySelector('summary')?.focus();
		this.pendingRole = undefined;
	}

	public setVisible(visible: boolean): void {
		if (this.visible === visible) { return; }
		this.visible = visible;
		this.revision++;
		if (visible) { void this.load(); }
		else { this.pendingRole = undefined; }
	}

	private async load(): Promise<void> {
		if (!this.visible || this.isDisposed) { return; }
		const revision = ++this.revision;
		this.loading = true;
		const document = this.domNode.ownerDocument;
		const restoreFocus = document.activeElement === this.refresh.domNode;
		this.refresh.enabled = false;
		this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'roles.loading' }, 'Loading Agent definitions…');
		try {
			const catalog = await this.agents.readRoleCatalog();
			if (!this.isCurrent(revision)) { return; }
			this.customRoles = catalog.agents.filter(role => role.source.type === 'directory');
			this.renderRoles(this.customRoles);
			this.statusDomNode.textContent = catalog.diagnostics.length
				? localize({ bundle: 'ash.settings', key: 'roles.diagnostics' }, 'Some custom definitions could not be loaded: {0}', catalog.diagnostics.join('\n'))
				: '';
			this.changed.fire();
		} catch (error) {
			if (!this.isCurrent(revision)) { return; }
			this.customRoles = undefined;
			this.clearEntries();
			this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'roles.failed' }, 'Could not load Agent definitions: {0}', String(error));
		} finally {
			if (this.isCurrent(revision)) {
				this.loading = false;
				this.refresh.enabled = true;
				if (restoreFocus && document.activeElement === document.body) { this.refresh.focus(); }
				this.revealPendingRole();
			}
		}
	}

	private isCurrent(revision: number): boolean {
		return !this.isDisposed && this.visible && this.revision === revision;
	}

	private clearEntries(): void {
		this.entryResources.clearAndDisposeAll();
		this.entries.clear();
		this.listDomNode.replaceChildren();
	}

	private renderRoles(roles: readonly AgentRoleDefinition[]): void {
		const focused = this.domNode.ownerDocument.activeElement;
		const retainedFocus = isHTMLElement(focused) && this.listDomNode.contains(focused) ? focused : undefined;
		const current = new Set<string>();
		const nodes: HTMLElement[] = [];
		for (const role of roles) {
			const id = JSON.stringify([role.source, role.name]);
			current.add(id);
			let entry = this.entries.get(id);
			if (!entry || entry.digest !== role.contentDigest || entry.resource !== role.resource?.toString()) {
				const resources = new DisposableStore();
				this.entryResources.set(id, resources);
				entry = { digest: role.contentDigest, resource: role.resource?.toString(), domNode: this.createEntry(role, resources) };
				this.entries.set(id, entry);
			}
			nodes.push(entry.domNode);
		}
		for (const id of this.entries.keys()) {
			if (!current.has(id)) { this.entries.delete(id); this.entryResources.deleteAndDispose(id); }
		}
		if (!roles.length) {
			const empty = h(this.domNode.ownerDocument, 'p');
			empty.textContent = localize({ bundle: 'ash.settings', key: 'roles.empty' }, 'No custom Agents found.');
			nodes.push(empty);
		}
		this.listDomNode.replaceChildren(...nodes);
		// Reparenting retained disclosures can drop native focus even when their content is unchanged.
		if (retainedFocus?.isConnected && this.domNode.ownerDocument.activeElement === this.domNode.ownerDocument.body) retainedFocus.focus();
	}

	private createEntry(role: AgentRoleDefinition, resources: DisposableStore): HTMLElement {
		const document = this.domNode.ownerDocument;
		const details = h(document, 'details');
		details.className = 'ash-agent-role';
		const summary = h(document, 'summary');
		const name = h(document, 'span');
		name.className = 'ash-agent-role-name';
		name.textContent = role.name;
		const description = h(document, 'span');
		description.className = 'ash-agent-role-description';
		description.textContent = role.description;
		summary.append(name, description);
		const content = h(document, 'div');
		content.className = 'ash-agent-role-content';
		const source = h(document, 'p');
		source.textContent = role.source.type === 'directory'
			? role.resource?.toString() ?? role.source.id
			: '';
		const prompt = h(document, 'pre');
		prompt.textContent = role.prompt;
		prompt.tabIndex = 0;
		prompt.setAttribute('aria-label', localize({ bundle: 'ash.settings', key: 'roles.prompt' }, 'Role instructions'));
		const declarations = h(document, 'pre');
		declarations.textContent = JSON.stringify({ launch: role.launch, callers: role.callers, delegates: role.delegates, ...this.declarations(role) }, null, 2);
		declarations.tabIndex = 0;
		declarations.setAttribute('aria-label', localize({ bundle: 'ash.settings', key: 'roles.declarations' }, 'Model, tools, Skills and instruction references'));
		content.append(source);
		const actions = h(document, 'div');
		actions.className = 'ash-agent-roles-actions';
		if (role.resource) {
			const edit = resources.add(new Button(actions, {
				...defaultButtonStyles, presentation: 'secondary',
				label: localize({ bundle: 'ash.settings', key: 'roles.edit' }, 'Edit definition'),
			}));
			resources.add(edit.onDidClick(() => { void this.openDefinition(role); }));
		}
		content.append(actions, prompt, declarations);
		details.append(summary, content);
		return details;
	}

	private declarations(role: AgentRoleDefinition): Record<string, unknown> {
		return {
			model: role.model, tools: role.tools, disallowedTools: role.disallowedTools, requiredTools: role.requiredTools,
			delegationTools: role.delegationTools, disallowedDelegationTools: role.disallowedDelegationTools,
			requiredDelegationTools: role.requiredDelegationTools, skills: role.skills, requiredSkills: role.requiredSkills,
			instructions: role.instructions,
		};
	}

	private async openDefinition(role: AgentRoleDefinition): Promise<void> {
		const current = this.customRoles?.find(candidate => candidate.name === role.name
			&& candidate.contentDigest === role.contentDigest && JSON.stringify(candidate.source) === JSON.stringify(role.source));
		if (!current?.resource) { return; }
		try {
			await this.options.beforeOpenEditor?.();
			await this.editors.openEditor({ resource: current.resource });
		} catch (error) {
			if (this.options.onOpenFailed) this.options.onOpenFailed(error);
			else if (!this.isDisposed) { this.statusDomNode.textContent = localize({ bundle: 'ash.settings', key: 'roles.openFailed' }, 'Could not open Agent definition: {0}', String(error)); }
		}
	}

	public getAccessibleContent(): string {
		return [this.statusDomNode.textContent, ...this.customRoles?.map(role =>
			[role.name, role.description, role.resource?.toString(), role.prompt, JSON.stringify(this.declarations(role), null, 2)].filter(Boolean).join('\n')) ?? []].join('\n\n');
	}
}
