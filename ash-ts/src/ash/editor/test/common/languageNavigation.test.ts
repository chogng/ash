import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../base/common/uri.js";
import { TextModel } from "../../common/model/textModel.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { LanguageFeaturesService } from "../../common/services/languageFeaturesService.js";
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { LanguageNavigationService } from '../../contrib/gotoSymbol/common/languageNavigation.js';

test("language navigation collects provider results with source resource identity and removes duplicates", async () => {
	using configurations = new TestLanguageConfigurationService();
	using languages = new LanguageFeaturesService(configurations);
	using model = new TextModel("const answer = value;", { languageId: 'typescript' });
	const source = URI.file("C:\\project\\main.ts");
	const target = URI.file("C:\\project\\value.ts");
	const range = Range.fromPositions(new Position((2) + 1, (0) + 1), new Position((2) + 1, (12) + 1));
	const selectionRange = Range.fromPositions(new Position((2) + 1, (6) + 1), new Position((2) + 1, (11) + 1));
	let observedResource: URI | undefined;
	languages.definitionProvider.register('typescript', {
		provideDefinition: request => {
			observedResource = request.resource;
			return [{ resource: target, range, selectionRange }];
		},
	});
	languages.definitionProvider.register('typescript', {
		provideDefinition: () => [{ resource: target, range, selectionRange }],
	});
	using navigation = createNavigationService(languages, model, source);

	const locations = await navigation.provideDefinition("typescript", new Position((0) + 1, (15) + 1));

	assert.equal(observedResource, source);
	assert.deepEqual(locations, [{ resource: target, range, selectionRange }]);
	assert.equal(Object.isFrozen(locations), true);
	assert.equal(Object.isFrozen(locations[0]), true);
});

test("language navigation exposes declaration, implementation, type definition, and references independently", async () => {
	using configurations = new TestLanguageConfigurationService();
	using languages = new LanguageFeaturesService(configurations);
	using model = new TextModel("value", { languageId: 'typescript' });
	const source = URI.file("C:\\project\\main.ts");
	const location = { resource: source, range: Range.fromPositions(new Position((0) + 1, (0) + 1), new Position((0) + 1, (5) + 1)) };
	let includeDeclaration: boolean | undefined;
	languages.declarationProvider.register('typescript', { provideDeclaration: () => [location] });
	languages.implementationProvider.register('typescript', { provideImplementation: () => [location] });
	languages.typeDefinitionProvider.register('typescript', { provideTypeDefinition: () => [location] });
	languages.referenceProvider.register('typescript', { provideReferences: request => {
		includeDeclaration = request.includeDeclaration;
		return [location];
	} });
	using navigation = createNavigationService(languages, model, source);
	const position = new Position((0) + 1, (2) + 1);

	assert.equal((await navigation.provideDeclaration("typescript", position)).length, 1);
	assert.equal((await navigation.provideImplementation("typescript", position)).length, 1);
	assert.equal((await navigation.provideTypeDefinition("typescript", position)).length, 1);
	assert.equal((await navigation.provideReferences("typescript", position, false)).length, 1);
	assert.equal(includeDeclaration, false);
});

test("language navigation discards results after the source model changes", async () => {
	using configurations = new TestLanguageConfigurationService();
	using languages = new LanguageFeaturesService(configurations);
	using model = new TextModel("value", { languageId: 'typescript' });
	const source = URI.file("C:\\project\\main.ts");
	const pending = deferred<readonly { readonly resource: URI; readonly range: Range }[]>();
	languages.definitionProvider.register('typescript', { provideDefinition: () => pending.promise });
	using navigation = createNavigationService(languages, model, source);
	const result = navigation.provideDefinition("typescript", new Position((0) + 1, (2) + 1));
	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (5) + 1)), text: "!" }]);
	pending.resolve([{ resource: source, range: Range.fromPositions(new Position((0) + 1, (0) + 1)) }]);

	assert.deepEqual(await result, []);
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => {
		resolve = accept;
	});
	return { promise, resolve };
}

for (const change of ['language', 'dispose'] as const) {
	test(`language navigation discards pending results after ${change}`, async () => {
		using configurations = new TestLanguageConfigurationService();
		using languages = new LanguageFeaturesService(configurations);
		using model = new TextModel('value', { languageId: 'typescript' });
		const source = URI.file('/project/main.ts');
		const pending = deferred<readonly { resource: URI; range: Range }[]>();
		using provider = languages.definitionProvider.register('typescript', { provideDefinition: () => pending.promise });
		using navigation = createNavigationService(languages, model, source);
		const result = navigation.provideDefinition('typescript', new Position(1, 2));
		if (change === 'language') model.setLanguage('javascript');
		else model.dispose();
		pending.resolve([{ resource: source, range: new Range(1, 1, 1, 6) }]);
		assert.deepEqual(await result, []);
	});
}

function createNavigationService(languages: LanguageFeaturesService, model: TextModel, resource: URI): LanguageNavigationService {
	return new LanguageNavigationService(model, resource, {
		definitions: languages.definitionProvider,
		declarations: languages.declarationProvider,
		implementations: languages.implementationProvider,
		typeDefinitions: languages.typeDefinitionProvider,
		references: languages.referenceProvider,
	});
}
