import assert from 'node:assert/strict';
import { test } from 'mocha';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import type { IModelService } from '../../../../../editor/common/services/model.js';
import type { ITextModelService, ITextModelContentProvider } from '../../../../../editor/common/services/resolverService.js';
import type { IMarkerService } from '../../../../../platform/markers/common/markers.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IAgentCapabilitiesService } from '../../../../../platform/agentCapabilities/common/agentCapabilitiesService.js';
import { PromptsService } from '../../common/promptSyntax/service/promptsServiceImpl.js';
import { PromptLanguageFeaturesProvider } from '../../browser/promptSyntax/promptFileContributions.js';

for (const end of ['disposed', 'created'] as const) test(`Skill text content provider releases a read when the contribution is ${end}`, async () => {
	using resources = new DisposableStore();
	const services = resources.add(new InstantiationService());
	services.registerInstance(IAgentCapabilitiesService, { isAvailable: false, read: async () => { throw new Error('No capability read expected'); } });
	const features = resources.add(new LanguageFeaturesService());
	const languages = resources.add(new LanguageService());
	resources.add(languages.registerLanguage({ id: 'markdown' }));
	const pending = new DeferredPromise<string>();
	let signal: AbortSignal | undefined;
	const prompts = resources.add(new PromptsService({ onDidChangeSkills: Event.None, list: async () => ({ generation: 1, skills: [] }), read: async () => ({ revision: 0, catalog: { generation: 1, skills: [{ id: { source: 'user:test', name: 'review' }, contentDigest: `sha256:${'a'.repeat(64)}`, description: 'Review', enabled: true, compatible: true }] }, diagnostics: [] }), setEnabled: async () => { }, readTextResource: (_ref, _path, current) => { signal = current; return pending.p; } }, { onDidChangeHooks: Event.None, list: async () => { throw new Error('Unexpected Hook read in Skill fixture'); } }));
	const { catalog } = await prompts.readSkillManagement();
	let provider: ITextModelContentProvider | undefined;
	const models: TextModel[] = [];
	const contribution = resources.add(new PromptLanguageFeaturesProvider(features, { getModels: () => [], getModel: () => null, onModelAdded: Event.None, onModelRemoved: Event.None, onModelLanguageChanged: Event.None, createModel: (text: string, language: { languageId: string; }, uri: URI) => { const model = resources.add(new TextModel(text, { languageId: language.languageId, resource: uri })); models.push(model); return model; } } as unknown as IModelService, {} as IMarkerService, services, languages, { registerTextModelContentProvider: (_scheme, value) => { provider = value; return toDisposable(() => { provider = undefined; }); } } as ITextModelService, prompts));
	const content = provider!.provideTextContent(catalog.skills[0].uri);
	if (end === 'disposed') contribution.dispose();
	assert.equal(signal?.aborted, end === 'disposed');
	await pending.complete('---\nname: review\ndescription: Review\n---\nBody');
	if (end === 'disposed') {
		await assert.rejects(Promise.resolve(content));
		assert.equal(models.length, 0);
		assert.equal(provider, undefined);
	} else {
		const model = await content;
		assert.equal(model?.getValue(), '---\nname: review\ndescription: Review\n---\nBody');
		assert.equal(models.length, 1);
	}
});
