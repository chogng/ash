import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Event } from '../../../base/common/event.js';
import { canceled, isCancellationError } from '../../../base/common/errors.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import type { IAppServerSkillApi, SkillCatalog } from '../../../platform/agentHost/common/appServerApi.js';
import { PromptsService } from '../../../workbench/contrib/chat/common/promptSyntax/service/promptsServiceImpl.js';
import { SessionScopedPromptsService } from '../../browser/agentHost/sessionScopedPromptsService.js';
import { SessionsPromptsService } from '../../browser/agentHost/sessionsPromptsService.js';
import { captureInstructionImports, type ISessionProviderScope, type ISessionProviderScopeService } from '../../browser/agentHost/sessionProviderScopeService.js';

const catalog: SkillCatalog = { generation: 1, skills: [{ id: { source: 'user:cloned-source', name: 'review' }, contentDigest: `sha256:${'a'.repeat(64)}`, description: 'Review changes.', enabled: true, compatible: true }] };
const content = '---\nname: review\ndescription: Review changes.\n---\n[Nested](references/checks.md)\n';

class HostFixture extends Disposable {
	readonly calls: unknown[] = [];
	current = true;
	readonly backend = {
		onDidChangeSkills: Event.None,
		setEnabled: async () => { throw new Error('Unexpected Skill enablement change'); },
		registerSource: async () => { throw new Error('Unexpected Skill source registration'); },
		list: async (_reload: unknown, sessionId?: string) => { this.calls.push(['list', sessionId]); return catalog; },
		read: async (sessionId?: string) => { this.calls.push(['read', sessionId]); return { revision: 1, catalog, diagnostics: [] }; },
		readTextResource: async (_reference: unknown, path: string, _signal: AbortSignal, sessionId?: string) => { this.calls.push(['body', path, sessionId]); return content; },
	} as IAppServerSkillApi;
	readonly prompts = this._register(new PromptsService(this.backend, { onDidChangeHooks: Event.None, list: async () => [] }));
	readonly scope: ISessionProviderScope;
	readonly scoped: SessionScopedPromptsService;

	constructor(providerId: string) {
		super();
		this.scope = {
			providerId, services: { prompts: this.prompts },
			backendIdentity: (value: string) => value.replace(/^qualified:/u, ''),
			assertCurrent: () => { if (!this.current) throw canceled(); },
		} as unknown as ISessionProviderScope;
		this.scoped = new SessionScopedPromptsService(this.scope);
	}
}

function windowPrompts(hosts: readonly HostFixture[], selected: HostFixture): SessionsPromptsService {
	return new SessionsPromptsService({
		onDidChange: Event.None, onDidChangeScopes: Event.None,
		getScopes: () => hosts.map(host => host.scope),
		createScope: () => { throw new Error('Unexpected provider scope creation'); },
		getScope: () => selected.scope,
		getProviderScope: id => { const host = hosts.find(host => host.scope.providerId === id && host.current); if (!host) throw canceled(); return host.scope; },
	} as ISessionProviderScopeService);
}

test('Scoped Prompt discovery binds its provider and original Session without changing the backend snapshot', async () => {
	using host = new HostFixture('host-a');
	const [skill] = await host.scoped.findAgentSkills(CancellationToken.None, 'qualified:source-session');
	assert.equal(skill.providerId, 'host-a');
	assert.equal(SessionScopedPromptsService.getResourceProvider(skill.uri), 'host-a');
	assert.equal(skill.uri.path, '/review/SKILL.md');
	const metadata = await host.scoped.readSkillManagement('qualified:source-session');
	assert.equal(metadata.catalog.skills[0].uri.toString(), skill.uri.toString());
	assert.equal((await host.scoped.resolveSkill(skill.uri, CancellationToken.None))?.providerId, 'host-a');
	assert.deepEqual(host.calls.at(-1), ['list', 'source-session']);
	assert.equal('providerId' in catalog.skills[0], false);
	const parsed = await host.scoped.parseNew(skill.uri, CancellationToken.None);
	assert.equal(parsed.uri.toString(), skill.uri.toString());
	assert.equal(parsed.header?.uri.toString(), skill.uri.toString());
	assert.equal(parsed.body?.uri.toString(), skill.uri.toString());
	const nested = parsed.body!.resolveFilePath('references/checks.md')!;
	await host.scoped.parseNew(nested, CancellationToken.None);
	assert.deepEqual(host.calls.at(-1), ['body', 'references/checks.md', 'source-session']);
});

test('Equal backend Skill IDs and digests remain distinct resources across hosts and never follow ambient selection', async () => {
	using first = new HostFixture('host-a');
	using second = new HostFixture('host-b');
	using prompts = windowPrompts([first, second], second);
	const [a] = await first.scoped.findAgentSkills(CancellationToken.None, 'qualified:equal-session');
	const [b] = await second.scoped.findAgentSkills(CancellationToken.None, 'qualified:equal-session');
	assert.notEqual(a.uri.toString(), b.uri.toString());
	const before = second.calls.length;
	assert.equal((await prompts.resolveSkill(a.uri, CancellationToken.None))?.providerId, 'host-a');
	await prompts.parseNew(a.uri, CancellationToken.None);
	assert.equal(second.calls.length, before);
	first.current = false;
	await assert.rejects(prompts.parseNew(a.uri, CancellationToken.None), isCancellationError);
	assert.equal(second.calls.length, before, 'a retired host never falls back to an equal resource on another host');
	assert.equal((await prompts.resolveSkill(b.uri, CancellationToken.None))?.providerId, 'host-b');
});

test('Unqualified, foreign-provider and cross-package Prompt resources cannot reach backend reads', async () => {
	using first = new HostFixture('host-a');
	using second = new HostFixture('host-b');
	using prompts = windowPrompts([first, second], second);
	const [a] = await first.scoped.findAgentSkills(CancellationToken.None);
	const backendResource = JSON.parse(a.uri.query).resource as string;
	const before = first.calls.length;
	assert.equal(await prompts.resolveSkill(URI.parse(backendResource), CancellationToken.None), undefined);
	assert.equal(await second.scoped.resolveSkill(a.uri, CancellationToken.None), undefined);
	await assert.rejects(second.scoped.parseNew(a.uri, CancellationToken.None), /original host/u);
	await assert.rejects(first.scoped.parseNew(a.uri.with({ path: '/other/SKILL.md' }), CancellationToken.None), /original host/u);
	await assert.rejects(first.scoped.parseNew(a.uri.with({ path: '/review/../escape.md' }), CancellationToken.None));
	assert.equal(first.calls.length, before);
	assert.deepEqual(second.calls, []);
});

test('A retired provider cannot publish a late Prompt read', async () => {
	using host = new HostFixture('host-a');
	const [skill] = await host.scoped.findAgentSkills(CancellationToken.None);
	const body = new DeferredPromise<string>();
	host.backend.readTextResource = async () => body.p;
	const pending = host.scoped.parseNew(skill.uri, CancellationToken.None);
	host.current = false;
	await body.complete(content);
	await assert.rejects(pending, isCancellationError);
});

test('Window Prompt resolution observes cancellation and window disposal before and after reads', async () => {
	using host = new HostFixture('host-a');
	using prompts = windowPrompts([host], host);
	const [skill] = await host.scoped.findAgentSkills(CancellationToken.None);
	await assert.rejects(prompts.resolveSkill(skill.uri, CancellationToken.Cancelled), isCancellationError);
	await assert.rejects(host.scoped.resolveSkill(URI.file('/unknown/SKILL.md'), CancellationToken.Cancelled), isCancellationError);
	const body = new DeferredPromise<string>();
	host.backend.readTextResource = async () => body.p;
	const pending = prompts.parseNew(skill.uri, CancellationToken.None);
	prompts.dispose();
	await body.complete(content);
	await assert.rejects(pending, isCancellationError);
	await assert.rejects(prompts.resolveSkill(skill.uri, CancellationToken.None), isCancellationError);
});


test('Instruction import captures the originating provider Session and rejects retired scopes', async () => {
	const calls: unknown[] = [];
	let retired = false;
	const imports = {
		directories: async () => { calls.push('directories'); return []; },
		preview: async () => { throw new Error('Unexpected preview'); },
		apply: async () => { calls.push('apply'); return []; },
	};
	const scope = { services: { host: { instructions: { captureImports: (id: string) => { calls.push(id); return imports; } } } }, backendIdentity: (id: string) => { assert.equal(id, 'provider:session'); return 'backend-session'; }, assertCurrent: () => { if (retired) throw canceled(); } } as unknown as ISessionProviderScope;
	const captured = captureInstructionImports(scope, 'provider:session');
	await captured.directories();
	assert.deepEqual(calls, ['backend-session', 'directories']);
	retired = true;
	await assert.rejects(captured.apply({ directory: '/project', source: 'cursor', sources: [] }, 'reviewed'), isCancellationError);
	assert.deepEqual(calls, ['backend-session', 'directories']);
});
