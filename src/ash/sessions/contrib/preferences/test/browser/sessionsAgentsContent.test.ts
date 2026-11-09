import assert from 'node:assert/strict';
import { test } from 'mocha';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { formatNlsMessage, resetNlsResolver, setNlsResolver } from '../../../../../nls.js';
import { IAccessibleViewService, AccessibleViewType } from '../../../../../platform/accessibility/browser/accessibleView.js';
import { AccessibleViewRegistry } from '../../../../../platform/accessibility/browser/accessibleViewRegistry.js';
import type { AgentRoleCatalog, AgentRoleDefinition } from '../../../../../platform/agentHost/common/agent.js';
import { IAgentSessionService } from '../../../../../platform/agentHost/common/agentService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../platform/contextkey/browser/contextKeyService.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import type { RemoteConnectionState } from '../../../../../platform/remote/common/remote.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import { productLanguagePackCatalogs } from '../../../../../workbench/services/localization/common/localizationCatalogs.js';
import { IAppServerRemoteAgentService } from '../../../../../workbench/services/remote/common/appServerRemoteAgentService.js';
import { SessionsAgentsContent } from '../../browser/sessionsAgentsContent.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import type { Team } from '../../../../services/teams/common/team.js';
import { ITeamsManagementService } from '../../../../services/teams/common/teamsManagement.js';

function definition(source: AgentRoleDefinition['source']): AgentRoleDefinition {
	return {
		name: 'reviewer', description: 'Reviews changes', launch: 'any', source,
		contentDigest: source.type, prompt: `Instructions from ${source.type}`,
		callers: [], delegates: null, model: null, tools: [], disallowedTools: [], requiredTools: [],
		delegationTools: null, disallowedDelegationTools: [], requiredDelegationTools: [],
		skills: null, requiredSkills: [], instructions: [],
		...(source.type === 'directory' ? { resource: URI.file('/workspace/.ash/agents/reviewer.md') } : {}),
	};
}

class AgentsFixture extends DisposableStore {
	readonly root = browserEnvironment.window.document.createElement('div');
	readonly services = this.add(new InstantiationService());
	readonly connection = this.add(new Emitter<RemoteConnectionState>());
	catalog: AgentRoleCatalog = {
		agents: [definition({ type: 'builtIn' }), definition({ type: 'directory', id: 'project' })], diagnostics: [],
	};
	readonly team: Team = {
		teamId: 'team:reviews', name: 'Review team', description: 'Independent reviews', revision: 1,
		status: 'active', coordinatorId: 'agent:lead', members: [{
			agentId: 'agent:lead', name: 'Lead reviewer', responsibility: 'Review the result',
			role: { type: 'exact', name: 'reviewer', source: { type: 'directory', id: 'project' } },
		}],
	};
	pending: Promise<AgentRoleCatalog> | undefined;
	roleReads = 0;
	teamReads = 0;

	constructor() {
		super();
		browserEnvironment.window.document.body.append(this.root);
		this.add(toDisposable(() => this.root.remove()));
		this.services.registerInstance(IAgentSessionService, {
			readRoleCatalog: async () => {
				this.roleReads++;
				const pending = this.pending;
				this.pending = undefined;
				return pending ?? this.catalog;
			},
		} as IAgentSessionService);
		this.services.registerInstance(IEditorService, { openEditor: async () => undefined } as unknown as IEditorService);
		this.services.registerInstance(IAppServerRemoteAgentService, { onDidChangeConnectionState: this.connection.event } as IAppServerRemoteAgentService);
		this.services.registerInstance(IConfigurationService, this.add(new InMemoryConfigurationService()));
		this.services.registerInstance(IContextKeyService, this.add(new ContextKeyService()));
		this.services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => 'Accessibility help' } as unknown as IAccessibleViewService);
		this.services.registerInstance(ITeamsManagementService, {
			teams: observableValue<readonly Team[]>('teams', [this.team]),
			refresh: async () => { this.teamReads++; },
			listRuns: async () => [], listMessages: async () => [{
				messageId: 'message:one', teamId: this.team.teamId, runId: null,
				senderId: 'agent:lead', receiverId: null, text: 'Keep the decision', createdAtUnixMs: 0,
			}],
		} as unknown as ITeamsManagementService);
		this.services.registerInstance(ISessionsService, { onDidChange: Event.None } as unknown as ISessionsService);
		this.services.registerInstance(IQuickInputService, {} as IQuickInputService);
	}

	create(): SessionsAgentsContent {
		return this.add(this.services.createInstance(SessionsAgentsContent, this.root, async () => { }, async () => { }, () => { }));
	}

	button(label: string): HTMLButtonElement {
		const button = [...this.root.querySelectorAll('button')].find(button => button.textContent === label);
		assert.ok(button, `Missing button: ${label}`);
		return button;
	}
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('Agents shows role definitions and teams together and reveals the exact member role', async () => {
	using f = new AgentsFixture();
	const panel = f.create();
	assert.equal(f.roleReads, 0);
	assert.equal(f.teamReads, 0);
	panel.setVisible(true);
	await settle();
	assert.equal(f.root.querySelector('[role="tablist"]'), null);
	const builtIn = f.root.querySelector<HTMLDetailsElement>('.ash-agent-role')!;
	builtIn.open = true;
	f.button('Review team · 1').click();
	await settle();
	assert.match(f.root.querySelector('.ash-teams-detail')!.textContent!, /Keep the decision/);
	f.button('View role').click();
	await settle();
	const custom = f.root.querySelector<HTMLDetailsElement>('.ash-agent-roles-group:last-child .ash-agent-role')!;
	assert.equal(custom.open, true);
	assert.equal(browserEnvironment.window.document.activeElement, custom.querySelector('summary'));
	assert.equal(f.root.querySelector('.ash-agent-role'), builtIn);
	assert.equal(builtIn.open, true);
	assert.equal(f.button('Review team · 1').getAttribute('aria-current'), 'true');
});

test('Agents retires pending role reads when the category is hidden', async () => {
	using f = new AgentsFixture();
	const late = new DeferredPromise<AgentRoleCatalog>();
	f.pending = late.p;
	const panel = f.create();
	panel.setVisible(true);
	panel.setVisible(false);
	await late.complete(f.catalog);
	await settle();
	assert.equal(f.root.querySelectorAll('.ash-agent-role').length, 0);
	panel.setVisible(true);
	await settle();
	assert.equal(f.root.querySelectorAll('.ash-agent-role').length, 2);
});

test('Agents reports a missing member role instead of revealing a same-name definition from another source', async () => {
	using f = new AgentsFixture();
	f.catalog = { agents: [definition({ type: 'builtIn' })], diagnostics: [] };
	const panel = f.create();
	panel.setVisible(true);
	await settle();
	f.button('Review team · 1').click();
	await settle();
	f.button('View role').click();
	await settle();
	assert.match(f.root.textContent!, /The role is no longer available: reviewer/);
	assert.equal(f.root.querySelector<HTMLDetailsElement>('.ash-agent-role')!.open, false);
	assert.equal(browserEnvironment.window.document.activeElement, f.button('Refresh definitions'));
});

test('Agents provides Team help and readable discussion and disposes its scoped providers', async () => {
	using f = new AgentsFixture();
	const panel = f.create();
	panel.setVisible(true);
	await settle();
	f.button('Review team · 1').click();
	await settle();
	const post = f.button('Post message');
	post.focus();
	const providers = AccessibleViewRegistry.getImplementations().filter(provider => provider.name.startsWith('ash-agents-'));
	assert.equal(providers.length, 2);
	const help = f.services.invokeFunction(accessor => providers.find(provider => provider.type === AccessibleViewType.Help)!.getProvider(accessor))!;
	assert.match(help.provideContent(), /Use Tab to move through Agent definitions and Teams/);
	assert.match(help.provideContent(), /snapshots/);
	const view = f.services.invokeFunction(accessor => providers.find(provider => provider.type === AccessibleViewType.View)!.getProvider(accessor))!;
	assert.match(view.provideContent(), /Lead reviewer: Review the result · reviewer · Lead/);
	assert.match(view.provideContent(), /Keep the decision/);
	help.dispose();
	view.dispose();
	assert.equal(browserEnvironment.window.document.activeElement, post);
	panel.dispose();
	assert.equal(AccessibleViewRegistry.getImplementations().some(provider => provider.name.startsWith('ash-agents-')), false);
});

test('Agents localizes management headings and help with the Chinese catalog', async () => {
	const catalog = productLanguagePackCatalogs.find(pack => pack.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, args) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, args));
	try {
		using f = new AgentsFixture();
		f.create().setVisible(true);
		await settle();
		assert.equal(f.root.querySelector('section')!.getAttribute('aria-label'), '智能体');
		assert.deepEqual([...f.root.querySelectorAll('.ash-settings-card-title')].map(heading => heading.textContent), ['Agent 定义', '团队']);
		f.button('新建团队').focus();
		const provider = AccessibleViewRegistry.getImplementations().find(provider => provider.name.startsWith('ash-agents-') && provider.type === AccessibleViewType.Help)!;
		const help = f.services.invokeFunction(accessor => provider.getProvider(accessor))!;
		assert.match(help.provideContent(), /角色.*团队/);
		assert.match(help.provideContent(), /按 Tab 在 Agent 定义和团队控件之间移动/);
		help.dispose();
	} finally { resetNlsResolver(); }
});
