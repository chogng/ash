import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../../../base/common/async.js';
import { URI } from '../../../../../../../base/common/uri.js';
import { Position } from '../../../../../../../editor/common/core/position.js';
import { Range } from '../../../../../../../editor/common/core/range.js';
import { TextModel } from '../../../../../../../editor/common/model/textModel.js';
import { InstantiationService } from '../../../../../../../platform/instantiation/common/instantiationService.js';
import { IInstructionService } from '../../../../../../../platform/instructions/common/instructionService.js';
import { IPathService } from '../../../../../../../platform/path/common/pathService.js';
import { IPromptsService, type IAgentSkill } from '../../../../common/promptSyntax/service/promptsService.js';
import { PromptHeaderDefinitionProvider } from '../../../../common/promptSyntax/languageProviders/PromptHeaderDefinitionProvider.js';

const resource = URI.file('/project/.ash/agents/reviewer.md');
const start = new Range(1, 1, 1, 1);

function request(model: TextModel, line: number, column: number, signal: AbortSignal) {
	return { model, snapshot: model.createVersionedSnapshot(), resource: model.uri, languageId: 'markdown', modelLanguageId: 'markdown', signal, position: new Position(line, column) };
}

test('Header definition navigation uses only discovered Skill resources, preserving source and digest', async () => {
	using model = new TextModel('---\nskills: [review]\n---\nBody', { resource, languageId: 'markdown' });
	const target = URI.parse('private://skill/review/SKILL.md?source=user&digest=sha256:pinned');
	const prompts = { findAgentSkills: async () => [{ name: 'review', uri: target }, { name: 'other', uri: URI.file('/unrelated') }] } as unknown as IPromptsService;
	const provider = new PromptHeaderDefinitionProvider(prompts, { isAvailable: false, list: async () => [] }, {} as IPathService);
	const signal = new AbortController().signal;
	assert.deepEqual(await provider.provideDefinition(request(model, 2, 12, signal), signal), [{ resource: target, range: start }]);
	assert.deepEqual(await provider.provideDefinition(request(model, 4, 2, signal), signal), []);
});

test('Instruction navigation preserves catalog-owned resources and rejects ambient paths into another host', async () => {
	using model = new TextModel('---\ninstructions: [style]\n---\nBody', { resource, languageId: 'markdown' });
	const owned = URI.parse('ash-remote://source-host/user/instructions/style.md');
	const paths = { fileURI: async () => URI.parse('ash-remote://another-host/wrong/style.md') } as unknown as IPathService;
	const provider = new PromptHeaderDefinitionProvider({} as IPromptsService, {
		isAvailable: true,
		list: async () => [
			{ name: 'style', path: '/private/path', scope: 'user', resource: owned },
			{ name: 'style', path: '/wrong/style.md', scope: 'directory' },
		],
	}, paths);
	const signal = new AbortController().signal;
	assert.deepEqual(await provider.provideDefinition(request(model, 2, 18, signal), signal), [{ resource: owned, range: start }]);
});

test('Instruction host paths resolve through the owning path service', async () => {
	using model = new TextModel('---\ninstructions: [style]\n---\nBody', { resource, languageId: 'markdown' });
	const target = URI.file('/project/.ash/instructions/style.md');
	const provider = new PromptHeaderDefinitionProvider({} as IPromptsService, {
		isAvailable: true, list: async () => [{ name: 'style', path: target.fsPath, scope: 'directory' }],
	}, { fileURI: async (path: string) => { assert.equal(path, target.fsPath); return target; } } as unknown as IPathService);
	const signal = new AbortController().signal;
	assert.deepEqual(await provider.provideDefinition(request(model, 2, 18, signal), signal), [{ resource: target, range: start }]);
});

test('A cancelled header definition request ignores a late catalog result', async () => {
	using model = new TextModel('---\nrequiredSkills: [review]\n---\nBody', { resource, languageId: 'markdown' });
	const pending = new DeferredPromise<readonly IAgentSkill[]>();
	const provider = new PromptHeaderDefinitionProvider({ findAgentSkills: () => pending.p } as unknown as IPromptsService, { isAvailable: false, list: async () => [] }, {} as IPathService);
	const controller = new AbortController();
	const result = provider.provideDefinition(request(model, 2, 20, controller.signal), controller.signal);
	controller.abort();
	await pending.complete([{
		name: 'review', uri: URI.file('/late'), id: { source: 'user:test', name: 'review' },
		description: 'Review', contentDigest: `sha256:${'a'.repeat(64)}`, enabled: true, compatible: true,
	}]);
	assert.deepEqual(await result, []);
});

test('Header definition provider is assembled with all required domain registrations', () => {
	using services = new InstantiationService();
	services.registerInstance(IPromptsService, {} as IPromptsService);
	services.registerInstance(IPathService, {} as IPathService);
	assert.throws(() => services.createInstance(PromptHeaderDefinitionProvider), /Unknown service: instructionService/u);
	services.registerInstance(IInstructionService, { isAvailable: false, list: async () => [] });
	assert.ok(services.createInstance(PromptHeaderDefinitionProvider) instanceof PromptHeaderDefinitionProvider);
});
