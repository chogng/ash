import assert from 'node:assert/strict';
import { test } from 'mocha';
import { Range } from '../../common/core/range.js';
import { createLanguageFeatureEditor, flushLanguageRequests } from './testLanguageFeatureEditor.js';
await import('../../../workbench/contrib/callHierarchy/browser/callHierarchy.contribution.js');
await import('../../../workbench/contrib/typeHierarchy/browser/typeHierarchy.contribution.js');

test('hierarchy preserves provider identity and opaque data while expanding a real peek', async () => {
	using fixture = createLanguageFeatureEditor();
	const range = new Range(1, 1, 1, 9);
	const root = { name: 'root', symbolKind: 12, resource: fixture.model.uri, range, selectionRange: range, data: { opaque: 'root' } };
	let followedData: unknown;
	using provider = fixture.features.callHierarchyProvider.register('typescript', {
		prepareCallHierarchy: request => { assert.equal(request.resource, fixture.model.uri); return [root]; },
		provideIncomingCalls: request => {
			followedData = request.item.data;
			return [{ item: { ...root, name: 'caller' }, fromResource: root.resource, fromRanges: [range] }];
		},
		provideOutgoingCalls: () => [],
	});
	await fixture.editor.getAction('editor.showCallHierarchy')!.run();
	fixture.container.querySelector<HTMLButtonElement>('.stanza-editor-language-hierarchy-expand')!.click();
	await flushLanguageRequests();
	assert.deepEqual(followedData, { opaque: 'root' });
	assert.equal(fixture.container.querySelectorAll('.stanza-editor-language-hierarchy-item')[1]?.textContent, 'caller');
	assert.deepEqual(fixture.errors, []);
});

for (const change of ['content', 'language', 'dispose', 'provider', 'selection'] as const) {
	test(`hierarchy aborts in-flight expansion and removes its peek on ${change}`, async () => {
		using fixture = createLanguageFeatureEditor();
		const range = new Range(1, 1, 1, 9);
		const root = { name: 'root', symbolKind: 12, resource: fixture.model.uri, range, selectionRange: range };
		let finish!: () => void;
		let signal!: AbortSignal;
		using provider = fixture.features.typeHierarchyProvider.register('typescript', {
			prepareTypeHierarchy: () => [root],
			provideSupertypes: () => [],
			provideSubtypes: (_request, cancellation) => {
				signal = cancellation;
				return new Promise(resolve => { finish = () => resolve([{ ...root, name: 'late' }]); });
			},
		});
		await fixture.editor.getAction('editor.showTypeHierarchy')!.run();
		fixture.container.querySelector<HTMLButtonElement>('.stanza-editor-language-hierarchy-expand')!.click();
		await flushLanguageRequests();
		assert.ok(signal, 'The provider expansion must start before it is cancelled');
		if (change === 'content') fixture.model.setValue('changed');
		if (change === 'language') fixture.model.setLanguage('javascript');
		if (change === 'dispose') fixture.model.dispose();
		if (change === 'provider') provider.dispose();
		if (change === 'selection') fixture.editor.setPosition({ lineNumber: 1, column: 2 });
		assert.equal(signal.aborted, true);
		finish();
		await flushLanguageRequests();
		assert.equal(fixture.container.querySelector('.stanza-editor-peek-view'), null);
		assert.deepEqual(fixture.errors, []);
	});
}
