import assert from 'node:assert/strict';
import { test } from 'mocha';
import { CancellationToken, CancellationTokenSource } from '../../../../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../../../base/common/event.js';
import { Disposable } from '../../../../../../../base/common/lifecycle.js';
import { isCancellationError } from '../../../../../../../base/common/errors.js';
import { URI } from '../../../../../../../base/common/uri.js';
import type { IAppServerSkillApi, SkillCatalog, SkillReference } from '../../../../../../../platform/agentHost/common/appServerApi.js';
import { AppServerRemoteError } from '../../../../../../../platform/agentHost/common/appServerError.js';
import { SkillManagementConflictError } from '../../../../common/promptSyntax/service/promptsService.js';
import { PromptsService } from '../../../../common/promptSyntax/service/promptsServiceImpl.js';
import { CONFIGURE_SKILLS_ACTION_ID, registerSkillActions } from '../../../../browser/promptSyntax/skillActions.js';
import { CommandsRegistry, ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { InstantiationService } from '../../../../../../../platform/instantiation/common/instantiationService.js';

const id = { source: 'user:review-source', name: 'review' };
const digest = `sha256:${'a'.repeat(64)}`;
const catalog: SkillCatalog = { generation: 3, skills: [{ id, contentDigest: digest, description: 'Review changes', enabled: true, compatible: true }] };
const instructions = '---\r\nname: review\r\n---\r\n# Review\r\nKeep the exact file.\r\n';

class Backend extends Disposable implements IAppServerSkillApi {
	readonly changed = this._register(new Emitter<void>());
	readonly onDidChangeSkills = this.changed.event;
	readonly calls: unknown[] = [];
	public list = async (reload: 'cached' | 'refresh', sessionId?: string): Promise<SkillCatalog> => { this.calls.push(['list', reload, sessionId]); return catalog; };
	public read = async (sessionId?: string) => { this.calls.push(['read', sessionId]); return { revision: 7, catalog, diagnostics: [] }; };
	public setEnabled = async (skillId: typeof id, enabled: boolean, revision: number, sessionId?: string) => { this.calls.push(['set', skillId, enabled, revision, sessionId]); };
	public readTextResource = async (reference: SkillReference, path: string, signal: AbortSignal, sessionId?: string) => { this.calls.push(['body', reference, sessionId, signal.aborted, path]); return instructions; };
}

test('Prompt discovery is metadata-only and reading pins source, digest and Session', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	const [first] = await prompts.findAgentSkills(CancellationToken.None, 'first');
	const [second] = await prompts.findAgentSkills(CancellationToken.None, 'second');
	assert.notEqual(first.uri.toString(), second.uri.toString());
	assert.equal(first.uri.scheme, 'private');
	assert.deepEqual(backend.calls, [['list', 'cached', 'first'], ['list', 'cached', 'second']]);
	const parsed = await prompts.parseNew(first.uri);
	assert.deepEqual({ content: parsed.content, body: parsed.body?.getContent(), uri: parsed.uri }, { content: instructions, body: '# Review\r\nKeep the exact file.\r\n', uri: first.uri });
	assert.deepEqual(backend.calls.at(-1), ['body', { id, version: { type: 'pinnedDigest', digest } }, 'first', false, 'SKILL.md']);
});

test('Prompt management uses the same discovered URIs and backend revision authority', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	const snapshot = await prompts.readSkillManagement('first');
	const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'first');
	assert.equal(snapshot.catalog.skills[0].uri.toString(), skill.uri.toString());
	await prompts.setSkillEnablement(id, false, snapshot.revision, 'first');
	assert.deepEqual(backend.calls.at(-1), ['set', id, false, 7, 'first']);
});

test('Prompt URIs from another window or a changed catalog cannot open instructions', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	using otherWindow = new PromptsService(backend);
	const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'first');
	await assert.rejects(otherWindow.parseNew(skill.uri), /not discovered/u);
	await assert.rejects(prompts.parseNew(URI.file('/private/SKILL.md')), /not discovered/u);
	backend.changed.fire();
	await assert.rejects(prompts.parseNew(skill.uri), /not discovered/u);
	assert.equal(backend.calls.filter(call => Array.isArray(call) && call[0] === 'body').length, 0);
});

test('Prompt discovery discards a reply completed after catalog invalidation', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	const pending = new DeferredPromise<SkillCatalog>();
	backend.list = () => pending.p;
	const discovery = prompts.findAgentSkills(CancellationToken.None, 'first');
	backend.changed.fire();
	await pending.complete(catalog);
	await assert.rejects(discovery, isCancellationError);
});

for (const reason of ['token', 'catalog', 'window'] as const) {
	test(`Prompt body reading aborts and rejects a late reply after ${reason} cancellation`, async () => {
		using backend = new Backend();
		using prompts = new PromptsService(backend);
		using cancellation = new CancellationTokenSource();
		const pending = new DeferredPromise<string>();
		let signal: AbortSignal | undefined;
		backend.readTextResource = (_reference, _path, current) => { signal = current; return pending.p; };
		const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'first');
		const reading = prompts.parseNew(skill.uri, cancellation.token);
		if (reason === 'token') cancellation.cancel();
		if (reason === 'catalog') backend.changed.fire();
		if (reason === 'window') prompts.dispose();
		assert.equal(signal?.aborted, true);
		await pending.complete(instructions);
		await assert.rejects(reading, isCancellationError);
		if (reason === 'window') assert.equal(backend.changed.hasListeners(), false);
	});
}

registerSkillActions();

test('Configure Skills opens the Extensions Skills pane without opening Settings', async () => {
	using services = new InstantiationService();
	const calls: unknown[] = [];
	services.registerInstance(ICommandService, { executeCommand: async (id, options) => { calls.push([id, options]); } } as ICommandService);
	await services.invokeFunction(CommandsRegistry.getCommand(CONFIGURE_SKILLS_ACTION_ID)!);
	assert.deepEqual(calls, [['ash.extensions.open', { view: 'skills' }]]);
});

test('Prompt relative references preserve source, pinned digest and Session and reject forged or escaping URIs', async () => {
	using backend = new Backend();
	backend.readTextResource = async (reference, path, signal, sessionId) => { backend.calls.push(['resource', reference, path, sessionId, signal.aborted]); return 'See [next](nested/checks.md).'; };
	using prompts = new PromptsService(backend);
	const [skill] = await prompts.findAgentSkills(CancellationToken.None, 'reference-session');
	const root = await prompts.parseNew(skill.uri);
	const child = root.body!.resolveFilePath('references/guide.md')!;
	const parsed = await prompts.parseNew(child);
	assert.equal(parsed.uri.toString(), child.toString());
	assert.equal(parsed.content, 'See [next](nested/checks.md).');
	assert.deepEqual(backend.calls.at(-1), ['resource', { id, version: { type: 'pinnedDigest', digest } }, 'references/guide.md', 'reference-session', false]);
	const next = parsed.body!.resolveFilePath('nested/checks.md')!;
	await prompts.parseNew(next);
	assert.equal((backend.calls.at(-1) as unknown[])[2], 'references/nested/checks.md');
	for (const invalid of [child.with({ query: 'forged' }), child.with({ authority: 'other' }), skill.uri.with({ path: '/review/../secret' }), skill.uri.with({ path: '/review/assets\\secret' }), skill.uri.with({ path: '/escape.md' })]) {
		await assert.rejects(prompts.parseNew(invalid), /not discovered/u);
	}
});


test('Prompt management re-reads the catalog when its own refresh publishes a change, without retrying mutation conflicts', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	let reads = 0;
	backend.read = async () => {
		reads++;
		if (reads === 1) backend.changed.fire();
		return { revision: 8, catalog, diagnostics: [] };
	};
	const snapshot = await prompts.readSkillManagement('session');
	assert.equal(reads, 2);
	assert.equal(snapshot.revision, 8);
	assert.equal((await prompts.parseNew(snapshot.catalog.skills[0].uri)).content, instructions);
	const conflict = new Error('ConfigRevisionConflict');
	let mutations = 0;
	backend.setEnabled = async () => { mutations++; throw conflict; };
	await assert.rejects(prompts.setSkillEnablement(id, false, 7, 'session'), error => error === conflict);
	assert.equal(mutations, 1);
});

test('Prompt management bounds continuous invalidation and cannot rediscover after disposal', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	let reads = 0;
	backend.read = async () => { reads++; backend.changed.fire(); return { revision: 8, catalog, diagnostics: [] }; };
	await assert.rejects(prompts.readSkillManagement(), isCancellationError);
	assert.equal(reads, 2);
	prompts.dispose();
	await assert.rejects(prompts.readSkillManagement(), isCancellationError);
	await assert.rejects(prompts.setSkillEnablement(id, false, 8), isCancellationError);
	assert.equal(reads, 2);
});


test('Skill enablement exposes a domain conflict with the displayed revision and does not overwrite a newer configuration', async () => {
	using backend = new Backend();
	using prompts = new PromptsService(backend);
	let writes = 0;
	backend.setEnabled = async () => { writes++; throw new AppServerRemoteError(-32031, 'ConfigRevisionConflict', { kind: 'ConfigRevisionConflict' }); };
	await assert.rejects(prompts.setSkillEnablement(id, false, 7, 'session'), error => error instanceof SkillManagementConflictError && error.expectedRevision === 7 && /Refresh Skills/u.test(error.message));
	assert.equal(writes, 1);
});
