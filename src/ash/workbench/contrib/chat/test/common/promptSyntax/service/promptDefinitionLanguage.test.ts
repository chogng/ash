import type { CancellationToken } from '../../../../../../../base/common/cancellation.js';
import { DeferredPromise } from '../../../../../../../base/common/async.js';
import { IPromptsService } from '../../../../common/promptSyntax/service/promptsService.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../../../../../base/common/uri.js';
import { Schemas } from '../../../../../../../base/common/network.js';
import { Position } from '../../../../../../../editor/common/core/position.js';
import { TextModel } from '../../../../../../../editor/common/model/textModel.js';
import { LanguageCompletionTriggerKind, LanguageDiagnosticSeverity } from '../../../../../../../editor/common/languages.js';
import { PromptFileParser } from '../../../../common/promptSyntax/promptFileParser.js';
import { getPromptFileType, PromptsType } from '../../../../common/promptSyntax/promptTypes.js';
import { PromptValidator } from '../../../../common/promptSyntax/languageProviders/promptValidator.js';
import { PromptHeaderAutocompletion } from '../../../../common/promptSyntax/languageProviders/promptHeaderAutocompletion.js';
import { PromptHoverProvider } from '../../../../common/promptSyntax/languageProviders/promptHovers.js';
import { createTestLanguageModelToolsService } from '../../tools/testLanguageModelToolsService.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { PromptCodeActionProvider } from '../../../../common/promptSyntax/languageProviders/promptCodeActions.js';

const agent = URI.file('/workspace/.ash/agents/reviewer.md');
const instruction = URI.file('/workspace/.ash/instructions/style.md');
const parser = new PromptFileParser();
const validator = new PromptValidator();

function validate(resource: URI, header: string, body = 'Review changes.'): ReturnType<PromptValidator['validate']> {
	return validator.validate(parser.parse(resource, `---\n${header}\n---\n${body}`));
}

test('Definition recognition follows catalog directories and leaves unrelated Markdown alone', () => {
	assert.equal(getPromptFileType(agent), PromptsType.agent);
	assert.equal(getPromptFileType(instruction), PromptsType.instructions);
	assert.equal(getPromptFileType(URI.file('/project/.ash/agents/SKILL.md')), PromptsType.agent);
	assert.equal(getPromptFileType(URI.from({ scheme: Schemas.vscodeUserData, path: '/user/instructions/style.md' })), PromptsType.instructions);
	assert.equal(getPromptFileType(URI.file('/skills/review/SKILL.md')), PromptsType.skill);
	for (const path of ['/docs/agents/reviewer.md', '/docs/instructions/style.md', '/workspace/.ash/agents/nested/reviewer.md', '/workspace/reviewer.agent.md']) {
		assert.equal(getPromptFileType(URI.file(path)), undefined, path);
	}
});

test('Agent draft validation accepts the backend role fields and nullable optional filters', () => {
	assert.deepEqual(validate(agent, 'name: reviewer\ndescription: Review code\nmodel: openai/model\ntools: [read_file]\nrequiredTools: [read_file]\ndisallowedTools: [write_file]\ndelegationTools: [write_file]\nrequiredDelegationTools: [write_file]\ndisallowedDelegationTools: []\nskills: [review]\nrequiredSkills: [review]\ninstructions: [style]'), []);
	assert.deepEqual(validate(agent, 'name: reviewer\ndescription: Review\nmodel: null\ntools: null\ndelegationTools: null\nskills: null\nversion: null\nlaunch: any\ncallers: []\ndelegates: null'), []);
});

test('Directory Agent drafts reject packaged launch restrictions and report typed reference errors', () => {
	for (const field of ['version: 1', 'launch: workflow', 'callers: [host]', 'delegates: []']) {
		assert.deepEqual(validate(agent, `name: reviewer\ndescription: Review\n${field}`).map(item => item.code), ['productField']);
	}
	assert.deepEqual(validate(agent, 'name: wrong\ndescription: Review\nmodel: bad*model\ntools: [read_file, read_file]\nskills: skill-name\nallowed-tools: read_file').map(item => item.code), ['nameMismatch', 'invalidReference', 'invalidReference', 'sequenceField', 'unknownField']);
});

test('Agent required capabilities must survive their allow and deny filters', () => {
	assert.deepEqual(validate(agent, 'name: reviewer\ndescription: Review\ntools: []\nrequiredTools: [read_file]\ndelegationTools: [write_file]\ndisallowedDelegationTools: [write_file]\nrequiredDelegationTools: [write_file]\nskills: []\nrequiredSkills: [review]').map(item => item.code), ['unavailableReference', 'unavailableReference', 'unavailableReference']);
});

test('Definition diagnostics use UTF-8 byte limits and require a nonempty body', () => {
	assert.deepEqual(validate(agent, `name: reviewer\ndescription: ${'中'.repeat(342)}`).map(item => item.code), ['descriptionLength']);
	assert.deepEqual(validate(agent, 'name: reviewer\ndescription: Review', '').map(item => item.code), ['emptyBody']);
	assert.deepEqual(validate(agent, 'name: reviewer\ndescription: Review', 'x'.repeat(32 * 1024)).map(item => item.code), ['fileTooLarge']);
	assert.deepEqual(validate(agent, 'name: reviewer\ndescription: Review\ntools:\n' + Array.from({ length: 270 }, (_, index) => `  - tool_${index}`).join('\n')), []);
});

test('Instructions validate the existing load policies independently of Skill and Agent fields', () => {
	for (const load of ['global', 'on-demand']) {
		assert.deepEqual(validate(instruction, `load: ${load}`), []);
		assert.deepEqual(validate(instruction, `load: ${load}\npatterns: ['src/**']`).map(item => item.code), ['loadPolicy']);
	}
	assert.deepEqual(validate(instruction, "name: style\nload: contextual\npatterns: ['src/**/*.rs']"), []);
	assert.deepEqual(validate(instruction, 'load: contextual').map(item => item.code), ['loadPolicy']);
	assert.deepEqual(validate(instruction, "load: contextual\npatterns: ['../secret']").map(item => item.code), ['invalidPatterns']);
	assert.deepEqual(validate(instruction, 'description: Styles').map(item => item.code), ['requiredField']);
	assert.deepEqual(validate(instruction, 'load: unknown').map(item => item.code), ['loadPolicy']);
});

test('Unsupported definition YAML produces a warning without inferring missing fields', () => {
	const diagnostics = validate(agent, 'name: &role reviewer\ndescription: *role');
	assert.ok(diagnostics.length > 0);
	assert.ok(diagnostics.every(item => item.code === 'unsupportedYaml' && item.severity === LanguageDiagnosticSeverity.Warning));
});

test('Agent completion offers camelCase backend keys, filename values and excludes product restrictions', async () => {
	using tools = createTestLanguageModelToolsService({ isAvailable: false, read: async () => { throw new Error('Unexpected catalog read'); } });
	const provider = new PromptHeaderAutocompletion(tools, emptyPrompts, emptyInstructions);
	for (const [line, expected] of [['requiredDe', ['requiredDelegationTools']], ['name: re', ['reviewer']]] as const) {
		using model = new TextModel(`---\n${line}\n---\nBody`, { resource: agent, languageId: 'markdown' });
		const result = await provider.provideCompletions({
			requestId: 1, resource: agent, snapshot: model.createVersionedSnapshot(), languageId: 'markdown',
			position: new Position(2, line.length + 1), context: { kind: LanguageCompletionTriggerKind.Invoke },
		}, new AbortController().signal);
		assert.deepEqual(result?.items.map(item => item.label), expected);
	}
});

test('Instruction completion replaces load values and hover explains the actual field schema', async () => {
	using tools = createTestLanguageModelToolsService({ isAvailable: false, read: async () => { throw new Error('Unexpected catalog read'); } });
	using model = new TextModel('---\nload: co\n---\nBody', { resource: instruction, languageId: 'markdown' });
	const signal = new AbortController().signal;
	const completion = await new PromptHeaderAutocompletion(tools, emptyPrompts, emptyInstructions).provideCompletions({
		requestId: 1, resource: instruction, snapshot: model.createVersionedSnapshot(), languageId: 'markdown',
		position: new Position(2, 9), context: { kind: LanguageCompletionTriggerKind.Invoke },
	}, signal);
	assert.deepEqual(completion?.items.map(item => ({ label: item.label, start: item.range.startColumn, end: item.range.endColumn })), [{ label: 'contextual', start: 7, end: 9 }]);
	const hover = new PromptHoverProvider().provideHover({
		model, snapshot: model.createVersionedSnapshot(), resource: instruction, languageId: 'markdown', modelLanguageId: 'markdown',
		position: new Position(2, 2), signal,
	}, signal);
	assert.match(String(hover?.contents.at(-1)), /contextual Instructions/u);
});

test('Agent tool sequences complete backend tool names and omit existing or hidden capabilities', async () => {
	using tools = createTestLanguageModelToolsService({
		isAvailable: true, read: async () => ({
			tools: ['read_file', 'write_file', 'hidden_tool'].map(name => ({ name, description: name, source: 'local', sourceDetails: [], exposure: name === 'hidden_tool' ? 'hidden' : 'direct', authority: 'directoryRead' })),
			sourceGroups: [],
		})
	});
	for (const [header, line, column] of [['tools: [read_file, wr]', 2, 21], ['delegationTools:\n  - wr', 3, 7]] as const) {
		using model = new TextModel(`---\n${header}\n---\nBody`, { resource: agent, languageId: 'markdown' });
		const result = await new PromptHeaderAutocompletion(tools, emptyPrompts, emptyInstructions).provideCompletions({
			requestId: 1, resource: agent, snapshot: model.createVersionedSnapshot(), languageId: 'markdown',
			position: new Position(line, column), context: { kind: LanguageCompletionTriggerKind.Invoke },
		}, new AbortController().signal);
		assert.deepEqual(result?.items.map(item => item.insertText), ['write_file']);
	}
});

test('Definition Quick Fix edits only the erroneous value and pins the current model version', () => {
	using model = new TextModel('---\nname: wrong\ndescription: Review\n---\nBody', { resource: agent, languageId: 'markdown' });
	const signal = new AbortController().signal;
	const request = {
		model, snapshot: model.createVersionedSnapshot(), resource: agent, languageId: 'markdown', modelLanguageId: 'markdown', signal,
		range: new Range(2, 8, 2, 8), diagnostics: [],
	};
	const provider = new PromptCodeActionProvider();
	const actions = provider.provideCodeActions(request, signal);
	assert.equal(actions.length, 1);
	assert.deepEqual(actions[0].edit, {
		entries: [{
			kind: 'textDocument', resource: agent, version: model.getVersionId(),
			edits: [{ range: new Range(2, 7, 2, 12), text: '"reviewer"' }],
		}]
	});
	assert.deepEqual(provider.provideCodeActions({ ...request, only: ['refactor'] }, signal), []);
	assert.deepEqual(provider.provideCodeActions({ ...request, range: new Range(5, 1, 5, 2) }, signal), []);
	const controller = new AbortController();
	controller.abort();
	assert.deepEqual(provider.provideCodeActions(request, controller.signal), []);
});

test('Instruction Quick Fix preserves patterns and offers only compatible loading policies', () => {
	const provider = new PromptCodeActionProvider();
	for (const [header, replacements] of [['load: contextual', ['global', 'on-demand']], ["load: global\npatterns: ['src/**']", ['contextual']]] as const) {
		using model = new TextModel(`---\n${header}\n---\nBody`, { resource: instruction, languageId: 'markdown' });
		const signal = new AbortController().signal;
		const actions = provider.provideCodeActions({
			model, snapshot: model.createVersionedSnapshot(), resource: instruction, languageId: 'markdown', modelLanguageId: 'markdown', signal,
			range: new Range(2, 8, 2, 8), diagnostics: [],
		}, signal);
		assert.deepEqual(actions.map(action => action.edit?.entries.flatMap(entry => entry.kind === 'textDocument' ? entry.edits.map(edit => edit.text) : [])), replacements.map(text => [text]));
	}
});

test('Definition Quick Fix leaves block scalar boundaries for the author to edit', () => {
	using model = new TextModel('---\nname: |-\n  wrong\ndescription: Review\n---\nBody', { resource: agent, languageId: 'markdown' });
	const signal = new AbortController().signal;
	assert.deepEqual(new PromptCodeActionProvider().provideCodeActions({
		model, snapshot: model.createVersionedSnapshot(), resource: agent, languageId: 'markdown', modelLanguageId: 'markdown', signal,
		range: new Range(3, 4, 3, 4), diagnostics: [],
	}, signal), []);
});

const emptyPrompts = { findAgentSkills: async () => { throw new Error('Unexpected Skill catalog read'); } } as unknown as IPromptsService;
const emptyInstructions = { isAvailable: false, list: async () => { throw new Error('Unexpected Instructions catalog read'); } };


test('Agent Skill value completion uses enabled catalog names, removes duplicates and replaces the full token', async () => {
	using tools = createTestLanguageModelToolsService({ isAvailable: false, read: async () => { throw new Error('Unexpected tool read'); } });
	const prompts = {
		findAgentSkills: async () => [
			{ name: 'review', enabled: true, compatible: true },
			{ name: 'review', enabled: true, compatible: true },
			{ name: 'retired', enabled: false, compatible: true },
			{ name: 'remote-only', enabled: true, compatible: false },
			{ name: 'required', enabled: true, compatible: true },
		]
	} as unknown as IPromptsService;
	const provider = new PromptHeaderAutocompletion(tools, prompts, emptyInstructions);
	for (const key of ['skills', 'requiredSkills']) {
		const line = `${key}: [required, reviewSuffix]`;
		using model = new TextModel(`---\n${line}\n---\nBody`, { resource: agent, languageId: 'markdown' });
		const result = await provider.provideCompletions({ requestId: 1, resource: agent, languageId: 'markdown', snapshot: model.createVersionedSnapshot(), position: new Position(2, line.indexOf('reviewSuffix') + 3), context: { kind: LanguageCompletionTriggerKind.Invoke } }, new AbortController().signal);
		assert.deepEqual(result?.items.map(item => item.label), ['review']);
		const item = result!.items[0];
		model.applyEdits([{ range: item.range, text: item.insertText }]);
		assert.equal(model.getLineContent(2), `${key}: [required, "review"]`);
	}
});

test('Agent Instructions completion keeps a valid boolean-shaped name as a YAML string', async () => {
	using tools = createTestLanguageModelToolsService({ isAvailable: false, read: async () => { throw new Error('Unexpected tool read'); } });
	const provider = new PromptHeaderAutocompletion(tools, emptyPrompts, { isAvailable: true, list: async () => [{ name: 'true', path: '/true', scope: 'directory', description: 'Project style.' }] });
	using model = new TextModel('---\ninstructions: [tr]\n---\nBody', { resource: agent, languageId: 'markdown' });
	const result = await provider.provideCompletions({ requestId: 1, resource: agent, languageId: 'markdown', snapshot: model.createVersionedSnapshot(), position: new Position(2, 18), context: { kind: LanguageCompletionTriggerKind.Invoke } }, new AbortController().signal);
	assert.deepEqual(result?.items.map(item => [item.label, item.insertText]), [['true', '"true"']]);
	model.applyEdits([{ range: result!.items[0].range, text: result!.items[0].insertText }]);
	const value = parser.parse(agent, model.getValue()).header!.getAttribute('instructions')!.value;
	assert.equal(value.type === 'sequence' && value.items[0].type === 'scalar' && value.items[0].value, 'true');
});

test('Cancelling Agent reference completion cancels the Skill catalog read and discards late results', async () => {
	using tools = createTestLanguageModelToolsService({ isAvailable: false, read: async () => { throw new Error('Unexpected tool read'); } });
	const pending = new DeferredPromise<never[]>();
	let token: CancellationToken | undefined;
	const provider = new PromptHeaderAutocompletion(tools, { findAgentSkills: (current: CancellationToken) => { token = current; return pending.p; } } as unknown as IPromptsService, emptyInstructions);
	using model = new TextModel('---\nskills: [re]\n---\nBody', { resource: agent, languageId: 'markdown' });
	const cancellation = new AbortController();
	const running = provider.provideCompletions({ requestId: 1, resource: agent, languageId: 'markdown', snapshot: model.createVersionedSnapshot(), position: new Position(2, 12), context: { kind: LanguageCompletionTriggerKind.Invoke } }, cancellation.signal);
	cancellation.abort();
	assert.equal(token?.isCancellationRequested, true);
	await pending.complete([]);
	assert.equal(await running, undefined);
});


test('Agent model completion inserts an exact catalog reference and validation requires a provider', async () => {
	using tools = createTestLanguageModelToolsService({ isAvailable: false, read: async () => { throw new Error('Unexpected tool read'); } });
	const provider = new PromptHeaderAutocompletion(tools, emptyPrompts, emptyInstructions, {
		listModelCatalog: async () => [{ model: { provider: 'custom', model: 'vendor/reviewer' }, displayName: 'Reviewer', longContext: null }],
	});
	for (const [line, start, expected] of [
		['model:', 7, ' "custom/vendor/reviewer"'],
		['model: custom/ven', 8, '"custom/vendor/reviewer"'],
		['model: "custom/ven"', 8, '"custom/vendor/reviewer"'],
	] as const) {
		using model = new TextModel(`---\n${line}\n---\nBody`, { resource: agent, languageId: 'markdown' });
		const result = await provider.provideCompletions({
			requestId: 1, resource: agent, snapshot: model.createVersionedSnapshot(), languageId: 'markdown',
			position: new Position(2, line.length + 1), context: { kind: LanguageCompletionTriggerKind.Invoke },
		}, new AbortController().signal);
		assert.equal(result?.items[0]?.insertText, expected);
		assert.deepEqual(result?.items[0]?.range, new Range(2, start, 2, line.length + 1));
	}
	assert.deepEqual(validate(agent, 'name: reviewer\ndescription: Review\nmodel: reviewer').map(item => item.code), ['invalidReference']);
	assert.deepEqual(validate(agent, 'name: reviewer\ndescription: Review\nmodel: "custom/vendor/reviewer"'), []);
});
