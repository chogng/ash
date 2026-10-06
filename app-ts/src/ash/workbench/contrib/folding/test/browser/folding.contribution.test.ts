import '../../../../../editor/test/browser/testEditorDom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { TextModel } from '../../../../../editor/common/model/textModel.js';
import { Position } from '../../../../../editor/common/core/position.js';
import { createLanguageFeatureRequest, LanguageCompletionTriggerKind } from '../../../../../editor/common/languages.js';
import { LanguageFeaturesService } from '../../../../../editor/common/services/languageFeaturesService.js';
import { ILanguageFeaturesService } from '../../../../../editor/common/services/languageFeatures.js';
import { FoldingController } from '../../../../../editor/contrib/folding/browser/folding.js';
import { createTestCodeEditor } from '../../../../../editor/test/browser/testCodeEditor.js';
import { resetNlsResolver, setNlsMessages } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { Extensions, type IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { createConfigurationSchema } from '../../../../../platform/configuration/common/configurationSchema.js';
import { JsonSchemaRegistry } from '../../../../../platform/jsonschemas/common/jsonSchemaRegistry.js';
import { WorkbenchContributionsRegistry, WorkbenchPhase } from '../../../../common/contributions.js';
import { WorkbenchConfigurationService } from '../../../../services/configuration/browser/configurationService.js';
import { IExtensionService, type ExtensionCatalog } from '../../../../services/extensions/common/extensionService.js';
import { builtinLanguagePackCatalogs } from '../../../../services/localization/common/localizationCatalogs.js';
import { createJsonCompletionProvider } from '../../../../services/language/common/jsonLanguageFeatures.js';
import '../../browser/folding.contribution.js';

const configName = 'editor.defaultFoldingRangeProvider';

function createServices(resources: DisposableStore): {
	services: InstantiationService;
	configuration: WorkbenchConfigurationService;
	features: LanguageFeaturesService;
	catalogChanged: Emitter<ExtensionCatalog>;
} {
	const services = resources.add(new InstantiationService());
	const configuration = resources.add(new WorkbenchConfigurationService());
	const features = resources.add(new LanguageFeaturesService());
	const catalogChanged = resources.add(new Emitter<ExtensionCatalog>());
	let catalog: ExtensionCatalog = { generation: 0, extensions: [], diagnostics: [] };
	resources.add(catalogChanged.event(next => { catalog = next; }));
	const extensions: IExtensionService = Object.assign(toDisposable(() => { }), {
		currentCatalog: catalog,
		themes: { currentCatalog: { revision: 0, themes: [] }, onDidChange: Event.None },
		fileTemplates: { currentCatalog: { revision: 0, templates: [] }, onDidChange: Event.None },
		debugAdapters: { definitions: [], onDidChange: Event.None, get: () => undefined },
		onDidChange: catalogChanged.event,
		onDidFail: Event.None,
		start: async () => { },
		reload: async () => { },
	});
	Object.defineProperty(extensions, 'currentCatalog', { get: () => catalog });
	resources.add(extensions);
	services.registerInstance(IConfigurationService, configuration);
	services.registerInstance(ILanguageFeaturesService, features);
	services.registerInstance(IExtensionService, extensions);
	return { services, configuration, features, catalogChanged };
}

test('folding contribution applies persisted language overrides through the production host and releases selection', async () => {
	using resources = new DisposableStore();
	const { services, configuration, features } = createServices(resources);
	resources.add(features.foldingRangeProvider.register('*', { id: 'test.first', provideFoldingRanges: () => [] }));
	resources.add(features.foldingRangeProvider.register('*', { id: 'test.second', provideFoldingRanges: () => [] }));
	resources.add(features.foldingRangeProvider.register('*', { provideFoldingRanges: () => [] }));
	using model = new TextModel('one\ntwo', { languageId: 'plaintext' });
	await configuration.write('{\n// Keep this comment\n"editor.defaultFoldingRangeProvider": "test.first",\n"[plaintext]": { "editor.defaultFoldingRangeProvider": "test.second" }\n}', 0);
	const errors: unknown[] = [];
	const host = resources.add(WorkbenchContributionsRegistry.createHost(services, error => errors.push(error), ['workbench.contrib.folding']));
	host.advance(WorkbenchPhase.AfterRestored);
	const selected = () => FoldingController.getFoldingRangeProviders(features, model).map(provider => provider.id);
	assert.deepEqual(selected(), ['test.second']);
	model.setLanguage('javascript');
	assert.deepEqual(selected(), ['test.first']);
	await configuration.updateValue(configName, 'missing.provider');
	assert.deepEqual(selected(), []);
	await configuration.updateValue(configName, null);
	assert.equal(selected().length, 3);
	assert.match((await configuration.read()).source, /Keep this comment/);
	await configuration.updateValue(configName, 'test.first');
	host.dispose();
	assert.equal(selected().length, 3);
	assert.deepEqual(errors, []);
});

test('changing the default folding provider cancels pending results and refreshes an open editor', async () => {
	using resources = new DisposableStore();
	const { services, configuration, features } = createServices(resources);
	await configuration.updateValue(configName, 'test.pending');
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.folding']);
	host.advance(WorkbenchPhase.AfterRestored);
	const pending: { signal: AbortSignal; resolve: (ranges: { startLineIndex: number; endLineIndex: number; }[]) => void; }[] = [];
	let readyRequests = 0;
	resources.add(features.foldingRangeProvider.register('plaintext', {
		id: 'test.pending',
		provideFoldingRanges: (_request, signal) => new Promise(resolve => pending.push({ signal, resolve })),
	}));
	resources.add(features.foldingRangeProvider.register('plaintext', {
		id: 'test.ready',
		provideFoldingRanges: () => {
			readyRequests++;
			return [{ startLineIndex: 1, endLineIndex: 3 }];
		},
	}));
	using model = new TextModel('one\ntwo\nthree\nfour\nfive');
	const container = document.createElement('div');
	document.body.appendChild(container);
	resources.add(toDisposable(() => container.remove()));
	using editor = createTestCodeEditor({ container, model, instantiationService: services, languageFeaturesService: features });
	const foldingRanges = () => model.getAllDecorations().filter(decoration => decoration.options.description === 'folding-expanded').map(decoration => [decoration.range.startLineNumber, decoration.range.endLineNumber]);
	const changed = new Promise<void>(resolve => {
		resources.add(model.onDidChangeDecorations(() => {
			if (foldingRanges().some(range => range[0] === 2 && range[1] === 4)) resolve();
		}));
	});
	await configuration.updateValue(configName, 'test.ready');
	await changed;
	assert.ok(pending.length > 0);
	assert.ok(pending.every(request => request.signal.aborted));
	for (const request of pending) request.resolve([{ startLineIndex: 0, endLineIndex: 4 }]);
	await Promise.all(pending.map(() => Promise.resolve()));
	assert.deepEqual(foldingRanges(), [[2, 4]]);
	editor.setPosition({ lineNumber: 2, column: 1 });
	await editor.getAction('editor.fold')!.run();
	assert.deepEqual(model.getAllDecorations().filter(decoration => decoration.options.description === 'folding-collapsed').map(decoration => [decoration.range.startLineNumber, decoration.range.endLineNumber]), [[2, 4]]);
	const requestCounts = [pending.length, readyRequests];
	host.dispose();
	assert.deepEqual([pending.length, readyRequests], requestCounts, 'Releasing the Workbench policy must not request providers during transport teardown');
});

test('folding candidates follow providers and extension labels and use Chinese configuration text', async () => {
	using resources = new DisposableStore();
	const { services, features, catalogChanged } = createServices(resources);
	using host = WorkbenchContributionsRegistry.createHost(services, error => { throw error; }, ['workbench.contrib.folding']);
	host.advance(WorkbenchPhase.AfterRestored);
	const registration = resources.add(features.foldingRangeProvider.register('*', { id: 'test.extension', provideFoldingRanges: () => [] }));
	catalogChanged.fire({ generation: 1, diagnostics: [], extensions: [{ id: 'test.extension', displayName: 'Test extension', name: 'extension', publisher: 'test', version: '1', sourceKind: 'user', manifestSha256: '', packageSha256: '' }] });
	const definition = Registry.as<IConfigurationRegistry>(Extensions.Configuration).getConfiguration(configName)!;
	const choices = definition.schema!.anyOf![0]!;
	assert.deepEqual({ ids: choices.enum, label: choices.enumDescriptions?.[1] }, { ids: [null, 'test.extension'], label: 'Test extension' });
	using schemas = new JsonSchemaRegistry();
	resources.add(schemas.registerSchema('test.settings', createConfigurationSchema()));
	const source = '{"editor.defaultFoldingRangeProvider": ""}';
	using model = new TextModel(source, { languageId: 'json' });
	resources.add(schemas.registerAssociation(model.uri, 'test.settings'));
	const completion = createJsonCompletionProvider(schemas);
	const complete = async (): Promise<readonly string[]> => {
		const signal = new AbortController().signal;
		const result = await completion.provideCompletions({
			...createLanguageFeatureRequest(model, 'json', signal),
			requestId: 1,
			resource: model.uri,
			position: new Position(1, source.length - 1),
			context: { kind: LanguageCompletionTriggerKind.Invoke },
		}, signal);
		return result?.items.map(item => item.label) ?? [];
	};
	assert.deepEqual(await complete(), ['null', '"test.extension"']);
	registration.dispose();
	assert.deepEqual(choices.enum, [null]);
	assert.deepEqual(await complete(), ['null']);
	setNlsMessages('zh-CN', builtinLanguagePackCatalogs.find(catalog => catalog.locale === 'zh-CN')!.bundles);
	try {
		assert.match(definition.schema!.description!, /折叠范围提供者/);
		assert.deepEqual(choices.enumDescriptions, ['所有当前启用的折叠范围提供者']);
		assert.throws(() => definition.parse(''), /默认折叠范围提供者/);
		assert.throws(() => definition.parse(12), /默认折叠范围提供者/);
		assert.equal(definition.parse('unavailable.extension'), 'unavailable.extension');
	} finally {
		resetNlsResolver();
	}
});
