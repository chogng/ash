import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import './testEditorDom.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../base/test/common/utils.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { EditorContributionInstantiation, EditorExtensionsRegistry } from '../../browser/editorExtensions.js';
import { TriggerInlineEditCommandsRegistry } from '../../browser/triggerInlineEditCommandsRegistry.js';

await import('../../editor.all.js');
const unadmittedBaseline = EditorExtensionsRegistry.getEditorContributions();
const { getEditorFeatures } = await import('../../browser/editorFeatures.js');

suite('Admitted editor contribution batches', () => {
	ensureNoDisposablesAreLeakedInTestSuite();
	test('plain entry and importing package declarations do not activate optional features', async () => {
		const baseline = unadmittedBaseline;
		assert.deepEqual(EditorExtensionsRegistry.getEditorContributions(), baseline);
		assert.ok(getEditorFeatures().contributions.some(value => value.id === 'editor.contrib.renameController'));
		assert.ok(
			!baseline.some(
				value => value.id === 'editor.contrib.documentFormatting' || value.id === 'editor.contrib.folding',
			),
		);
	});
	test('batch conflicts roll back and retirement aborts the exact admitted instances', () => {
		class Contribution extends Disposable {}
		const baseline = EditorExtensionsRegistry.getEditorContributions();
		const descriptions = [
			{ id: 'test.leased', ctor: Contribution, instantiation: EditorContributionInstantiation.Lazy },
		];
		let signal: AbortSignal;
		{
			using lease = EditorExtensionsRegistry.registerEditorContributions(descriptions);
			signal = EditorExtensionsRegistry.getSomeEditorContributions(['test.leased'])[0].providerSignal!;
			assert.equal(signal.aborted, false);
			assert.throws(
				() =>
					EditorExtensionsRegistry.registerEditorContributions([
						{ id: 'test.partial', install() {} },
						...descriptions,
					]),
				/Duplicate/,
			);
			assert.equal(EditorExtensionsRegistry.getSomeEditorContributions(['test.partial']).length, 0);
		}
		assert.equal(signal.aborted, true);
		assert.deepEqual(EditorExtensionsRegistry.getEditorContributions(), baseline);
		using again = EditorExtensionsRegistry.registerEditorContributions(descriptions);
		assert.notEqual(EditorExtensionsRegistry.getSomeEditorContributions(['test.leased'])[0].providerSignal, signal);
	});
	test('trigger metadata leases retain other owners and disappear after the last release', () => {
		const id = 'test.leased.trigger';
		const first = TriggerInlineEditCommandsRegistry.registerScopedCommand(id);
		const second = TriggerInlineEditCommandsRegistry.registerScopedCommand(id);
		first.dispose();
		assert.equal(TriggerInlineEditCommandsRegistry.getRegisteredCommands().includes(id), true);
		second.dispose();
		assert.equal(TriggerInlineEditCommandsRegistry.getRegisteredCommands().includes(id), false);
		assert.throws(() => TriggerInlineEditCommandsRegistry.registerScopedCommand(''), /non-empty/);
	});
});
