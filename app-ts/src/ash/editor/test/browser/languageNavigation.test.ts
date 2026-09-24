import assert from 'node:assert/strict';
import { test } from 'mocha';
import { URI } from '../../../base/common/uri.js';
import { Range } from '../../common/core/range.js';
import { createLanguageFeatureEditor } from './testLanguageFeatureEditor.js';
import type { LanguageNavigationController } from '../../contrib/gotoSymbol/browser/languageNavigationController.js';
await import('../../contrib/gotoSymbol/browser/languageNavigation.contribution.js');

test('navigation keeps source identity and deduplicates targets before opening', async () => {
	using fixture = createLanguageFeatureEditor();
	const target = { resource: URI.file('/other.ts'), range: new Range(2, 1, 2, 13), selectionRange: new Range(2, 7, 2, 12) };
	let resource: URI | undefined;
	using first = fixture.features.definitionProvider.register('typescript', {
		provideDefinition: request => { resource = request.resource; return [target]; },
	});
	using duplicate = fixture.features.definitionProvider.register('typescript', { provideDefinition: () => [target] });
	await fixture.editor.getContribution<LanguageNavigationController>('editor.contrib.languageNavigation')!.navigate('definition');
	assert.equal(resource, fixture.model.uri);
	assert.deepEqual(fixture.opened, [target]);
	assert.equal(Object.isFrozen(fixture.opened[0]), true);
});

test('navigation queries every supported operation and passes the reference context', async () => {
	using fixture = createLanguageFeatureEditor();
	const location = { resource: URI.file('/other.ts'), range: new Range(1, 1, 1, 6) };
	let includeDeclaration: boolean | undefined;
	using declarations = fixture.features.declarationProvider.register('typescript', { provideDeclaration: () => [location] });
	using implementations = fixture.features.implementationProvider.register('typescript', { provideImplementation: () => [location] });
	using types = fixture.features.typeDefinitionProvider.register('typescript', { provideTypeDefinition: () => [location] });
	using references = fixture.features.referenceProvider.register('typescript', { provideReferences: request => {
		includeDeclaration = request.includeDeclaration;
		return [location];
	} });
	const controller = fixture.editor.getContribution<LanguageNavigationController>('editor.contrib.languageNavigation')!;
	for (const kind of ['declaration', 'implementation', 'typeDefinition', 'references'] as const) {
		await controller.navigate(kind, { includeDeclaration: false });
	}
	assert.equal(includeDeclaration, false);
	assert.deepEqual(fixture.opened, [location, location, location, location]);
});

for (const change of ['content', 'language', 'dispose', 'provider', 'selection'] as const) {
	test(`navigation cancels on ${change} without opening stale targets`, async () => {
		using fixture = createLanguageFeatureEditor();
		let finish!: () => void;
		let signal!: AbortSignal;
		using provider = fixture.features.definitionProvider.register('typescript', {
			provideDefinition: (_request, cancellation) => {
				signal = cancellation;
				return new Promise(resolve => { finish = () => resolve([{ resource: URI.file('/other.ts'), range: new Range(1, 1, 1, 6) }]); });
			},
		});
		const pending = fixture.editor.getContribution<LanguageNavigationController>('editor.contrib.languageNavigation')!.navigate('definition');
		if (change === 'content') fixture.model.setValue('changed');
		if (change === 'language') fixture.model.setLanguage('javascript');
		if (change === 'dispose') fixture.model.dispose();
		if (change === 'provider') provider.dispose();
		if (change === 'selection') fixture.editor.setPosition({ lineNumber: 1, column: 2 });
		assert.equal(signal.aborted, true);
		finish();
		await pending;
		assert.deepEqual(fixture.opened, []);
		assert.deepEqual(fixture.errors, []);
	});
}
