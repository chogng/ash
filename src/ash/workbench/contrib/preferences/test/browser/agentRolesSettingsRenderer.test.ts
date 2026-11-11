import assert from 'node:assert/strict';
import { test } from 'mocha';
import { browserEnvironment } from '../../../../../editor/test/browser/testEditorDom.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
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
import type { IResourceEditorInput } from '../../../../common/editor.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { productLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { IAppServerRemoteAgentService } from '../../../../services/remote/common/appServerRemoteAgentService.js';
import { AgentRolesSettingsRenderer } from '../../browser/agentRolesSettingsRenderer.js';

function definition(name: string, launch: AgentRoleDefinition['launch'] = 'host'): AgentRoleDefinition {
	return {
		name, description: `${name} description`, launch, source: { type: 'builtIn' }, contentDigest: name,
		callers: [], delegates: null, model: null, tools: [], disallowedTools: [], requiredTools: [],
		delegationTools: null, disallowedDelegationTools: [], requiredDelegationTools: [],
		skills: null, requiredSkills: [], instructions: [], prompt: `Instructions for ${name}`,
	};
}

class RolesFixture extends DisposableStore {
	public readonly root = browserEnvironment.window.document.createElement('div');
	public readonly services = this.add(new InstantiationService());
	public readonly connection = this.add(new Emitter<RemoteConnectionState>());
	public readonly inputs: IResourceEditorInput[] = [];
	public catalog: AgentRoleCatalog = {
		agents: [definition('reviewer'), definition('develop/intent', 'workflow'), {
			...definition('reviewer', 'any'), source: { type: 'directory', id: 'project' },
			resource: URI.file('/workspace/.ash/agents/reviewer.md'), contentDigest: 'custom-reviewer', prompt: 'Instructions for the custom reviewer',
		}], diagnostics: [],
	};
	public pending: Promise<AgentRoleCatalog> | undefined;
	public readonly renderer: AgentRolesSettingsRenderer;

	constructor() {
		super();
		browserEnvironment.window.document.body.append(this.root);
		this.add(toDisposable(() => this.root.remove()));
		this.services.registerInstance(IAgentSessionService, {
			readRoleCatalog: async () => { const pending = this.pending; this.pending = undefined; return pending ?? this.catalog; },
		} as IAgentSessionService);
		this.services.registerInstance(IEditorService, { openEditor: async input => { this.inputs.push(input); } } as IEditorService);
		this.services.registerInstance(IAppServerRemoteAgentService, { onDidChangeConnectionState: this.connection.event } as IAppServerRemoteAgentService);
		this.services.registerInstance(IConfigurationService, this.add(new InMemoryConfigurationService()));
		this.services.registerInstance(IContextKeyService, this.add(new ContextKeyService()));
		this.services.registerInstance(IAccessibleViewService, { getOpenAriaHint: () => 'Accessibility help' } as unknown as IAccessibleViewService);
		this.renderer = this.add(this.services.createInstance(AgentRolesSettingsRenderer, this.root));
		assert.equal(this.root.childElementCount, 0, 'Preferences retains Agent controls without mounting them on unrelated pages');
		for (const node of this.renderer.getNodes()) {
			if (node.element.kind === 'item') this.root.append(this.renderer.renderItem(node.element.value));
		}
	}
}

const settle = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('Agent settings only show custom definitions and keep their editor links current', async () => {
	using f = new RolesFixture();
	f.renderer.setVisible(true); await settle();
	assert.deepEqual([...f.root.querySelectorAll('h4')].map(node => node.textContent), ['Custom Agents']);
	assert.equal(f.root.querySelectorAll('.ash-agent-role').length, 1);
	const item = f.renderer.getNodes()[0]?.element;
	assert.ok(item?.kind === 'item');
	assert.ok(!item.keywords?.includes('develop/intent'), 'Internal workflow roles are not searchable in settings');
	const custom = f.root.querySelector<HTMLDetailsElement>('.ash-agent-role')!;
	custom.open = true;
	const edit = custom.querySelector<HTMLButtonElement>('button')!;
	edit.click(); await settle();
	assert.deepEqual(f.inputs.map(input => input.resource.toString()), ['file:///workspace/.ash/agents/reviewer.md']);
	// A fresh snapshot with the same digest retains DOM and keeps actions usable.
	f.catalog = { ...f.catalog, agents: f.catalog.agents.map(role => ({ ...role })) };
	const refresh = f.root.querySelector<HTMLButtonElement>('button')!;
	refresh.click(); await settle();
	assert.equal(f.root.querySelector('.ash-agent-role'), custom);
	assert.equal(custom.open, true);
	// Source metadata can change without changing the definition's content digest.
	f.catalog = {
		...f.catalog, agents: f.catalog.agents.map(role => role.source.type === 'directory'
			? { ...role, resource: URI.file('/renamed/.ash/agents/reviewer.md') } : role)
	};
	refresh.click(); await settle();
	f.root.querySelector<HTMLButtonElement>('.ash-agent-role button')!.click(); await settle();
	assert.equal(f.inputs[1]?.resource.toString(), 'file:///renamed/.ash/agents/reviewer.md');
	f.catalog = { ...f.catalog, agents: f.catalog.agents.map(role => role.source.type === 'directory' ? { ...role, resource: undefined } : role) };
	refresh.click(); await settle();
	assert.equal(f.root.querySelector('.ash-agent-role button'), null);
});

test('Agent settings retire late reads on disconnect, report diagnostics and provide accessible content', async () => {
	using f = new RolesFixture();
	const late = new DeferredPromise<AgentRoleCatalog>();
	f.pending = late.p;
	f.renderer.setVisible(true);
	f.connection.fire('disconnected');
	await late.complete(f.catalog); await settle();
	assert.equal(f.root.querySelectorAll('.ash-agent-role').length, 0);
	assert.match(f.root.textContent!, /Connect to App Server/);
	f.catalog = { ...f.catalog, diagnostics: ['broken.md: invalid frontmatter'] };
	f.connection.fire('connected'); await settle();
	assert.match(f.root.textContent!, /broken.md: invalid frontmatter/);
	const summary = f.root.querySelector('summary')!; summary.focus();
	const providers = AccessibleViewRegistry.getImplementations().filter(provider => provider.name.startsWith('agentRolesSettings-'));
	assert.equal(providers.length, 2);
	const help = f.services.invokeFunction(accessor => providers.find(provider => provider.type === AccessibleViewType.Help)!.getProvider(accessor))!;
	assert.match(help.provideContent(), /accessible view lists custom Agents/);
	const view = f.services.invokeFunction(accessor => providers.find(provider => provider.type === AccessibleViewType.View)!.getProvider(accessor))!;
	assert.match(view.provideContent(), /Instructions for the custom reviewer/);
	assert.doesNotMatch(view.provideContent(), /Instructions for reviewer|develop\/intent/);
	help.dispose(); view.dispose(); assert.equal(browserEnvironment.window.document.activeElement, summary);
	f.renderer.dispose();
	assert.equal(AccessibleViewRegistry.getImplementations().some(provider => provider.name.startsWith('agentRolesSettings-')), false);
});

test('Agent settings use the Chinese catalog for controls and accessibility help', async () => {
	const catalog = productLanguagePackCatalogs.find(pack => pack.locale === 'zh-CN')!;
	setNlsResolver((bundle, key, fallback, args) => formatNlsMessage(catalog.bundles[bundle]?.[key] ?? fallback, args));
	try {
		using f = new RolesFixture(); f.renderer.setVisible(true); await settle();
		assert.deepEqual([...f.root.querySelectorAll('h4')].map(node => node.textContent), ['自定义 Agent']);
		assert.match(f.root.textContent!, /编辑定义/);
		assert.match(f.root.textContent!, /保存后刷新/);
	} finally { resetNlsResolver(); }
});
