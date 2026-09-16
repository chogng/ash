import assert from "node:assert/strict";
import { test } from "mocha";
import { URI } from "../../../base/common/uri.js";
import { Position } from "../../common/core/position.js";
import { Range } from "../../common/core/range.js";
import { TextModel } from "../../common/model/textModel.js";
import { LanguageFeaturesService } from "../../common/services/languageFeaturesService.js";
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { LanguageHierarchyService } from '../../contrib/callHierarchy/common/languageHierarchy.js';

test("language hierarchy keeps prepare and follow-up requests on the same provider", async () => {
	using configurations = new TestLanguageConfigurationService();
	using languages = new LanguageFeaturesService(configurations);
	using model = new TextModel("function root() {}\n", { languageId: 'typescript' });
	const source = URI.file("C:\\project\\main.ts");
	const root = item("root", source, 0);
	const caller = item("caller", URI.file("C:\\project\\caller.ts"), 2);
	let followedData: unknown;
	languages.callHierarchyProvider.register('typescript', {
		prepareCallHierarchy: request => {
			assert.equal(request.resource, source);
			return [root];
		},
		provideIncomingCalls: request => {
			followedData = request.item.data;
			return [{ item: caller, fromResource: caller.resource, fromRanges: [caller.selectionRange] }];
		},
		provideOutgoingCalls: () => [],
	});
	using service = new LanguageHierarchyService(model, source, languages.callHierarchyProvider, languages.typeHierarchyProvider);

	const prepared = await service.prepareCallHierarchy("typescript", new Position((0) + 1, (10) + 1));
	const incoming = await prepared[0]!.incoming(prepared[0]!.roots[0]!);

	assert.deepEqual(followedData, { opaque: "root" });
	assert.equal(incoming[0]!.item.name, "caller");
	assert.equal(Object.isFrozen(incoming), true);
});

test("language hierarchy discards follow-up results when the source revision changes", async () => {
	using configurations = new TestLanguageConfigurationService();
	using languages = new LanguageFeaturesService(configurations);
	using model = new TextModel("class Root {}\n", { languageId: 'typescript' });
	const source = URI.file("C:\\project\\main.ts");
	const root = item("Root", source, 0);
	const pending = deferred<readonly ReturnType<typeof item>[]>();
	languages.typeHierarchyProvider.register('typescript', {
		prepareTypeHierarchy: () => [root],
		provideSupertypes: () => pending.promise,
		provideSubtypes: () => [],
	});
	using service = new LanguageHierarchyService(model, source, languages.callHierarchyProvider, languages.typeHierarchyProvider);
	const prepared = await service.prepareTypeHierarchy("typescript", new Position((0) + 1, (7) + 1));
	const result = prepared[0]!.supertypes(root);
	model.applyEdits([{ range: Range.fromPositions(new Position((0) + 1, (13) + 1)), text: " " }]);
	pending.resolve([item("Base", source, 1)]);
	assert.deepEqual(await result, []);
});

for (const change of ['content', 'language', 'dispose'] as const) {
	test(`prepared hierarchies reject follow-ups after ${change}`, async () => {
		using configurations = new TestLanguageConfigurationService();
		using languages = new LanguageFeaturesService(configurations);
		using model = new TextModel('class Root {}', { languageId: 'typescript' });
		const root = item('Root', model.uri, 0);
		let calls = 0;
		using callProvider = languages.callHierarchyProvider.register('typescript', {
			prepareCallHierarchy: () => [root],
			provideIncomingCalls: () => { calls++; return []; },
			provideOutgoingCalls: () => { calls++; return []; },
		});
		using typeProvider = languages.typeHierarchyProvider.register('typescript', {
			prepareTypeHierarchy: () => [root],
			provideSupertypes: () => { calls++; return [root]; },
			provideSubtypes: () => { calls++; return [root]; },
		});
		using service = new LanguageHierarchyService(model, model.uri, languages.callHierarchyProvider, languages.typeHierarchyProvider);
		const [call] = await service.prepareCallHierarchy('typescript', new Position(1, 7));
		const [type] = await service.prepareTypeHierarchy('typescript', new Position(1, 7));
		if (change === 'content') model.setValue('class Other {}');
		else if (change === 'language') model.setLanguage('javascript');
		else model.dispose();
		assert.deepEqual(await Promise.all([call!.incoming(root), call!.outgoing(root), type!.supertypes(root), type!.subtypes(root)]), [[], [], [], []]);
		assert.equal(calls, 0);
	});
}

function item(name: string, resource: URI, line: number) {
	const range = Range.fromPositions(new Position((line) + 1, (0) + 1), new Position((line) + 1, (name.length + 2) + 1));
	const selectionRange = Range.fromPositions(new Position((line) + 1, (1) + 1), new Position((line) + 1, (name.length + 1) + 1));
	return { name, symbolKind: 12, resource, range, selectionRange, data: { opaque: name } };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(accept => { resolve = accept; });
	return { promise, resolve };
}
