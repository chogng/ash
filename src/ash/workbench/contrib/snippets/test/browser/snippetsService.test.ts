import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'mocha';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { Selection } from '../../../../../editor/common/core/selection.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { LanguageCompletionTriggerKind } from '../../../../../editor/common/languages.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { LanguageService } from '../../../../../editor/common/services/languageService.js';
import { TestLanguageFeaturesService } from '../../../../../editor/test/common/testLanguageFeaturesService.js';
import { LanguageCompletionService } from '../../../../../editor/contrib/suggest/browser/suggest.js';
import { SuggestModel } from '../../../../../editor/contrib/suggest/browser/suggestModel.js';
import { SnippetController2 } from '../../../../../editor/contrib/snippet/browser/snippetController2.js';
import { EditorContributionInstantiation } from '../../../../../editor/browser/editorExtensions.js';
import { createTestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import type { ExtensionCatalog, ExtensionDescriptor } from '../../../../../platform/extensions/common/extensionApi.js';
import { ExtensionResourceLoaderService } from '../../../../../platform/extensionResourceLoader/browser/extensionResourceLoaderService.js';
import { getSingletonServiceDescriptors } from '../../../../../platform/instantiation/common/extensions.js';
import { ServiceCollection } from '../../../../../platform/instantiation/common/serviceCollection.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { AppServerExtensionService } from '../../../../services/extensions/browser/appServerExtensionService.js';
import { IExtensionService } from '../../../../services/extensions/common/extensionService.js';
import type { ITextMateService } from '../../../../services/textMate/common/textMateService.js';
import { TextMateGrammarService } from '../../../../services/textMate/common/textMateGrammarService.js';
import { createEmptyTestLanguagePacks } from '../../../../services/localization/test/common/localizationTestUtils.js';
import { ISnippetsService } from '../../browser/snippets.js';
import '../../browser/snippets.contribution.js';

const invoke = { kind: LanguageCompletionTriggerKind.Invoke } as const;

test('extension snippets reach completion acceptance, placeholder navigation and one-step undo', async () => {
	using fixture = createFixture({ Log: { prefix: ['log', 'loop'], body: 'console.${1:method}(${2:value})$0' } });
	await fixture.extensions.start();
	using model = new TextModel('first line\n  lo');
	const container = document.body.appendChild(document.createElement('div'));
	using editor = createTestCodeEditor({
		container,
		model,
		contributions: [{ id: SnippetController2.ID, ctor: SnippetController2, instantiation: EditorContributionInstantiation.Eager }],
	});
	editor.onDidDispose(() => container.remove());
	editor.setPosition(new Position(2, 5));
	using completion = new LanguageCompletionService(model, fixture.features.completionProvider);
	using suggest = new SuggestModel(completion.results, editor);
	await completion.request('typescript', editor.getPosition()!, invoke);
	assert.deepEqual(suggest.state?.items.map(item => ({ label: item.label, range: item.range })), [
		{ label: 'log', range: new Range(2, 3, 2, 5) },
		{ label: 'loop', range: new Range(2, 3, 2, 5) },
	]);
	assert.equal(suggest.acceptSelected(), true);
	assert.equal(model.getText(), 'first line\n  console.method(value)');
	assert.deepEqual(editor.getSelection(), new Selection(2, 11, 2, 17));
	const snippet = SnippetController2.get(editor)!;
	snippet.next();
	assert.deepEqual(editor.getSelection(), new Selection(2, 18, 2, 23));
	snippet.prev();
	assert.deepEqual(editor.getSelection(), new Selection(2, 11, 2, 17));
	snippet.next();
	snippet.next();
	assert.deepEqual(editor.getSelection(), new Selection(2, 24, 2, 24));
	snippet.cancel();
	model.undo();
	assert.equal(model.getText(), 'first line\n  lo');
	assert.deepEqual(editor.getSelection(), new Selection(2, 5, 2, 5));
});

test('refresh replaces snippets once, preserves a failed generation, and removes unloaded definitions', async () => {
	using fixture = createFixture({ Log: { prefix: 'log', body: 'old($1)$0' } });
	await fixture.extensions.start();
	const snapshots: Array<{ generation: number; bodies: string[]; }> = [];
	using listener = fixture.features.completionProvider.onDidChangeProviderCatalog(() => snapshots.push({
		generation: fixture.extensions.currentCatalog.generation,
		bodies: fixture.snippets.getSnippetsSync('typescript').map(snippet => snippet.body),
	}));
	fixture.replace({ Log: { prefix: 'log', body: 'new($1)$0' } });
	await fixture.extensions.reload();
	const committed = fixture.extensions.currentCatalog;
	fixture.replace({ Log: { prefix: 'log', body: 5 } });
	await assert.rejects(fixture.extensions.reload(), /body/);
	assert.equal(fixture.extensions.currentCatalog, committed);
	assert.deepEqual(fixture.snippets.getSnippetsSync('typescript').map(snippet => snippet.body), ['new($1)$0']);
	fixture.remove();
	await fixture.extensions.reload();
	assert.deepEqual(fixture.snippets.getSnippetsSync('typescript'), []);
	assert.deepEqual(snapshots, [
		{ generation: 2, bodies: ['new($1)$0'] },
		{ generation: 4, bodies: [] },
	]);
	assert.deepEqual(fixture.reads, [1, 2, 3]);
});

test('scope lists, alternate prefixes and punctuation retain their own ranges and stable identities', async () => {
	using fixture = createFixture({
		Log: { prefix: ['log', 'loop'], scope: 'typescript, javascript', body: '$1' },
		Php: { prefix: '<?php', body: 'php($1)' },
		Region: { prefix: '#region', body: 'region($1)' },
		Foreign: { prefix: 'loop', scope: 'python', body: 'foreign' },
	}, true);
	await fixture.extensions.start();
	using model = new TextModel('loo');
	using completion = new LanguageCompletionService(model, fixture.features.completionProvider);
	await completion.request('typescript', new Position(1, 4), invoke);
	assert.deepEqual(completion.results.result?.value.items.map(item => ({ label: item.label, range: item.range })), [{ label: 'loop', range: new Range(1, 1, 1, 4) }]);
	const identity = completion.results.result!.value.items[0].id;
	fixture.replace({ Earlier: { prefix: 'early', body: 'earlier' }, ...fixture.contents });
	await fixture.extensions.reload();
	await completion.request('typescript', new Position(1, 4), invoke);
	assert.equal(completion.results.result!.value.items[0].id, identity);
	for (const [text, label] of [['  <?p', '<?php'], ['  #reg', '#region']] as const) {
		model.setValue(text);
		await completion.request('typescript', new Position(1, text.length + 1), invoke);
		assert.deepEqual(completion.results.result?.value.items.map(item => ({ label: item.label, range: item.range })), [{ label, range: new Range(1, 3, 1, text.length + 1) }]);
	}
	model.setValue('catalog');
	await completion.request('typescript', new Position(1, 8), invoke);
	assert.deepEqual(completion.results.result?.value.items, []);
	assert.equal(fixture.snippets.getSnippetsSync('javascript').filter(snippet => snippet.name === 'Log').length, 2);
});

test('file-template defaults remain available without duplicating templates for each prefix', async () => {
	using fixture = createFixture({ Class: { prefix: ['class', 'cls'], body: ['class ${1:Name} {', '\t$0', '}'], isFileTemplate: true } });
	await fixture.extensions.start();
	assert.deepEqual(fixture.extensions.fileTemplates.currentCatalog.templates.map(template => ({ label: template.label, body: template.body, languageId: template.languageId })), [{ label: 'Class', body: 'class Name {\n\t\n}', languageId: 'typescript' }]);
	assert.equal(fixture.snippets.getSnippetsSync('typescript').length, 2);
});

test('extension disposal clears the snippet owner and contribution disposal removes its provider', async () => {
	using fixture = createFixture({ Log: { prefix: 'log', body: '$1' } });
	await fixture.extensions.start();
	fixture.extensions.dispose();
	assert.deepEqual(fixture.snippets.getSnippetsSync('typescript'), []);
	fixture.contributions.dispose();
	assert.deepEqual(fixture.features.completionProvider.providerCatalog.providers, []);
});

test('production creation rejects missing required services and duplicate snippet owners', () => {
	using services = new InstantiationService();
	const descriptor = getSingletonServiceDescriptors().find(([id]) => id === ISnippetsService)![1];
	assert.throws(() => services.createInstance(descriptor), /Unknown service/);
	using fixture = createFixture({});
	assert.throws(() => fixture.services.createInstance(descriptor), /already registered/);
});

function createFixture(initial: Record<string, unknown>, duplicateResource = false) {
	const resources = new DisposableStore();
	const grammars = resources.add(new TextMateGrammarService());
	const languages = resources.add(new LanguageService());
	const features = resources.add(new TestLanguageFeaturesService());
	const services = resources.add(new InstantiationService());
	let generation = 1;
	let contents = initial;
	let present = true;
	const reads: number[] = [];
	const extensions = resources.add(new AppServerExtensionService({
		api: {
			list: async (): Promise<ExtensionCatalog> => ({ generation, extensions: present ? [descriptor()] : [], diagnostics: [] }),
			resources: new ExtensionResourceLoaderService(async request => {
				reads.push(request.generation);
				return new TextEncoder().encode(JSON.stringify(contents));
			}),
		},
		textMateService: { grammars } as unknown as ITextMateService,
		languageService: languages,
		languageConfigurationService: features.languageConfigurationService,
	}, createEmptyTestLanguagePacks()));
	services.registerInstance(IExtensionService, extensions);
	services.registerInstance(ILanguageFeaturesService, features);
	const registration = getSingletonServiceDescriptors().find(([id]) => id === ISnippetsService)![1];
	services.registerCollection(new ServiceCollection([ISnippetsService, registration]));
	const snippets = services.get(ISnippetsService);
	const contributions = resources.add(WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.snippets']));
	contributions.advance(WorkbenchPhase.BlockStartup);
	return {
		extensions, features, services, snippets, contributions, reads,
		get contents() { return contents; },
		replace(next: Record<string, unknown>): void { contents = next; generation++; },
		remove(): void { present = false; generation++; },
		[Symbol.dispose](): void { resources.dispose(); },
	};

	function descriptor(): ExtensionDescriptor {
		const manifestJson = JSON.stringify({
			name: 'snippets', publisher: 'ash', version: `1.0.${generation}`, contributes: {
				languages: [{ id: 'typescript' }, { id: 'javascript' }],
				snippets: duplicateResource ? [{ language: ['typescript', 'javascript'], path: 'snippets/demo.json' }, { language: 'typescript', path: 'snippets/demo.json' }] : [{ language: 'typescript', path: 'snippets/demo.json' }],
			}
		});
		const digest = 'sha256:' + createHash('sha256').update(manifestJson).digest('hex');
		return { id: 'ash.snippets', name: 'snippets', publisher: 'ash', version: `1.0.${generation}`, displayName: 'Snippets', sourceKind: 'builtIn', manifestJson, manifestSha256: digest, packageSha256: digest };
	}
}
