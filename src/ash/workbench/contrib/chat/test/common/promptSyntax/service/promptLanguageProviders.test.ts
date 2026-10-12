import { DeferredPromise } from '../../../../../../../base/common/async.js';
import type { AgentCapabilitiesSnapshot } from '../../../../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../../../base/common/uri.js';
import { Position } from '../../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../../../editor/common/model/textModel.js';
import { LanguageCompletionTriggerKind } from '../../../../../../../editor/common/languages.js';
import { PromptHeaderAutocompletion } from '../../../../common/promptSyntax/languageProviders/promptHeaderAutocompletion.js';
import { PromptValidator } from '../../../../common/promptSyntax/languageProviders/promptValidator.js';
import { PromptFileParser } from '../../../../common/promptSyntax/promptFileParser.js';
import { PromptHoverProvider } from '../../../../common/promptSyntax/languageProviders/promptHovers.js';

async function complete(source: string, position: Position, name = 'SKILL.md', aborted = false) {
	using model = new TextModel(source, { resource: URI.file(`/skills/review/${name}`), languageId: 'markdown' });
	const controller = new AbortController();
	if (aborted) controller.abort();
	return new PromptHeaderAutocompletion({ isAvailable: false, read: async () => { throw new Error('Unexpected catalog read'); } }).provideCompletions({
		requestId: 1, resource: model.uri, languageId: 'markdown', position,
		context: { kind: LanguageCompletionTriggerKind.Invoke }, snapshot: model.createVersionedSnapshot(),
	}, controller.signal);
}

test('Skill header completion offers the existing schema keys, excluding already present root keys', async () => {
	const result = await complete('---\nname: review\n\n---\nBody', new Position(3, 1));
	assert.deepEqual(result?.items.map(item => item.label), ['description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
	const filtered = await complete('---\nname: review\nde\n---', new Position(3, 3));
	assert.deepEqual(filtered?.items.map(item => ({ label: item.label, insertText: item.insertText, range: item.range })), [
		{ label: 'description', insertText: 'description: ', range: new Range(3, 1, 3, 3) },
	]);
});

test('Skill completion does not enter body, nested mappings, other files or cancelled requests', async () => {
	assert.equal(await complete('---\nmetadata:\n  key\n---', new Position(3, 6)), undefined);
	assert.equal(await complete('---\nname: review\n---\nde', new Position(4, 3)), undefined);
	assert.equal(await complete('---\nde', new Position(2, 3), 'README.md'), undefined);
	assert.equal(await complete('Body\nde', new Position(2, 3)), undefined);
	assert.equal(await complete('---\nde', new Position(2, 3), 'SKILL.md', true), undefined);
	assert.deepEqual((await complete('---\nde', new Position(2, 3)))?.items.map(item => item.label), ['description']);
});

test('Skill hover describes only an existing header key at its exact range', () => {
	using model = new TextModel('---\nname: review\n---\nname: body', { resource: URI.file('/skills/review/SKILL.md'), languageId: 'markdown' });
	const controller = new AbortController();
	const request = {
		model, snapshot: model.createVersionedSnapshot(), resource: model.uri,
		languageId: 'markdown', modelLanguageId: 'markdown', signal: controller.signal, position: new Position(2, 2),
	};
	const provider = new PromptHoverProvider();
	const hover = provider.provideHover(request, controller.signal);
	assert.deepEqual(hover?.range, new Range(2, 1, 2, 5));
	assert.match(String(hover?.contents[0]), /Required.*parent directory/u);
	assert.equal(provider.provideHover({ ...request, position: new Position(2, 9) }, controller.signal), undefined);
	assert.equal(provider.provideHover({ ...request, position: new Position(4, 2) }, controller.signal), undefined);
	controller.abort();
	assert.equal(provider.provideHover(request, controller.signal), undefined);
});

test('Skill value completion uses the actual directory name and AST hover handles quoted keys', async () => {
	const result = await complete('---\nname: re\n---', new Position(2, 9));
	assert.deepEqual(result?.items.map(item => ({ label: item.label, range: item.range })), [{ label: 'review', range: new Range(2, 7, 2, 9) }]);
	using model = new TextModel('---\n"description": >-\n  Review changes\n---', { resource: URI.file('/skills/review/SKILL.md'), languageId: 'markdown' });
	const controller = new AbortController();
	const hover = new PromptHoverProvider().provideHover({ model, snapshot: model.createVersionedSnapshot(), resource: model.uri, languageId: 'markdown', modelLanguageId: 'markdown', signal: controller.signal, position: new Position(2, 3) }, controller.signal);
	assert.deepEqual(hover?.range, new Range(2, 1, 2, 14));
});


test('Skill draft diagnostics explain syntax and schema without accepting or executing catalog data', () => {
	const parser = new PromptFileParser();
	const validator = new PromptValidator();
	const uri = URI.file('/skills/review/SKILL.md');
	const invalid = validator.validate(parser.parse(uri, '---\nname: review\ndescription: [one, two]\nmetadata:\n  owner: [team]\nmodel: unknown\n---'));
	assert.deepEqual(invalid.map(error => error.code), ['textField', 'metadataShape', 'unknownField']);
	assert.deepEqual(invalid[0]!.range, new Range(3, 14, 3, 24));
	assert.deepEqual(validator.validate(parser.parse(uri, '---\nname: review\ndescription: >-\n  Review changes.\nmetadata: { owner: editor }\n---')), []);
	assert.deepEqual(validator.validate(parser.parse(uri, '---\n---')).map(error => error.code), ['requiredField', 'requiredField']);
	assert.deepEqual(validator.validate(parser.parse(uri, '')).map(error => error.code), ['missingHeader']);
});


test('allowed-tools suggestions read the real capability catalog, omit hidden and existing tools and reject a cancelled reply', async () => {
	using model = new TextModel('---\nname: review\nallowed-tools: existing re_file\n---', { resource: URI.file('/skills/review/SKILL.md'), languageId: 'markdown' });
	const pending = new DeferredPromise<AgentCapabilitiesSnapshot>();
	let reads = 0;
	const provider = new PromptHeaderAutocompletion({ isAvailable: true, read: () => { reads++; return pending.p; } });
	const controller = new AbortController();
	const request = { requestId: 1, resource: model.uri, languageId: 'markdown', position: new Position(3, 26), context: { kind: LanguageCompletionTriggerKind.Invoke as const }, snapshot: model.createVersionedSnapshot() };
	const first = provider.provideCompletions(request, controller.signal);
	assert.equal(reads, 1);
	const tools: AgentCapabilitiesSnapshot = { tools: ['existing', 'read_file', 'restricted'].map((name, index) => ({ name, description: name + ' description', source: 'local', sourceDetails: [], exposure: index === 2 ? 'hidden' : 'direct', authority: 'directoryRead' })), toolSets: [], localProcessSandboxConfigured: false, sandboxBackends: [], directoryGrantsReadable: true, sandboxDiagnostics: [] };
	await pending.complete(tools);
	const result = await first;
	assert.deepEqual(result?.items.map(item => ({ label: item.label, range: item.range })), [{ label: 'read_file', range: new Range(3, 25, 3, 32) }]);
	const delayed = new DeferredPromise<AgentCapabilitiesSnapshot>();
	const cancelled = new PromptHeaderAutocompletion({ isAvailable: true, read: () => delayed.p }).provideCompletions(request, controller.signal);
	controller.abort();
	await delayed.complete(tools);
	assert.equal(await cancelled, undefined);
});
