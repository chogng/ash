import assert from 'node:assert/strict';
import { test } from 'mocha';
import { createLanguageFeatureEditor } from '../../../../test/browser/testLanguageFeatureEditor.js';
import { TextDecorationCollection } from '../../../../common/model/decorationCollection.js';
import { CodeActionTriggerType, type LanguageDiagnostic } from '../../../../common/languages.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { CodeActionModel, CodeActionsState } from '../../browser/codeActionModel.js';
import { CodeActionTriggerSource } from '../../common/types.js';
import { HierarchicalKind } from '../../../../../base/common/hierarchicalKind.js';
await import('../../browser/codeActionContributions.js');

for (const [command, args, expected] of [
	['editor.action.fixAll', undefined, 'fixed'],
	['editor.action.codeAction', { kind: 'quickfix', preferred: true, apply: 'first' }, 'preferred'],
] as const) {
	test(command + ' applies only its matching action and creates one undo step', async () => {
		using fixture = createLanguageFeatureEditor();
		const original = fixture.model.getValue();
		using provider = fixture.features.codeActionProvider.register('typescript', {
			provideCodeActions: () => [
				{ title: 'Ordinary fix', kind: 'quickfix', text: 'ordinary' },
				{ title: 'Preferred fix', kind: 'quickfix', isPreferred: true, text: 'preferred' },
				{ title: 'Fix all', kind: 'source.fixAll', text: 'fixed' },
			].map(action => ({ ...action, edit: { entries: [{ kind: 'textDocument', resource: fixture.model.uri, edits: [{ range: fixture.model.getFullModelRange(), text: action.text }] }] } })),
		});
		fixture.editor.focus();
		await fixture.editor.getAction(command)!.run(args);
		assert.equal(fixture.model.getValue(), expected);
		fixture.model.undo();
		assert.equal(fixture.model.getValue(), original);
		assert.deepEqual(fixture.errors, []);
	});
}

test('code action filtering excludes families unless the user explicitly requests a child kind', async () => {
	using fixture = createLanguageFeatureEditor();
	using provider = fixture.features.codeActionProvider.register('typescript', {
		provideCodeActions: () => [
			{ title: 'Extract', kind: 'refactor.extract', isPreferred: true },
			{ title: 'Rewrite', kind: 'refactor.rewrite' },
			{ title: 'Quick fixing extension kind', kind: 'quickfixing', isPreferred: true },
		],
	});
	using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
	using model = fixture.editor.invokeWithinContext(accessor => accessor.get(IInstantiationService).createInstance(
		CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)));
	const excluded = model.trigger({
		type: CodeActionTriggerType.Invoke, triggerAction: CodeActionTriggerSource.QuickFix,
		filter: { excludes: [new HierarchicalKind('refactor')] }
	})!;
	assert.deepEqual((await excluded.actions).validActions.map(item => item.action.title), ['Quick fixing extension kind']);
	assert.equal((await excluded.actions).hasAutoFix, false);
	const explicit = model.trigger({
		type: CodeActionTriggerType.Invoke, triggerAction: CodeActionTriggerSource.Refactor,
		filter: { include: new HierarchicalKind('refactor.extract'), excludes: [new HierarchicalKind('refactor')] }
	})!;
	assert.deepEqual((await explicit.actions).validActions.map(item => item.action.title), ['Extract']);
	assert.deepEqual(fixture.errors, []);
});

test('code action model keeps filters, disabled actions and the original provider together', async () => {
	using fixture = createLanguageFeatureEditor();
	const original = { title: 'Extract', kind: 'refactor.extract', data: { symbol: 1 } };
	let resolvedOriginal: unknown;
	using provider = fixture.features.codeActionProvider.register('typescript', {
		provideCodeActions: request => {
			assert.deepEqual(request.only, ['refactor']);
			return [original, { title: 'Unavailable', kind: 'refactor', disabledReason: 'No selection' }, { title: 'Fix', kind: 'quickfix' }];
		},
		resolveCodeAction: action => { resolvedOriginal = action; return action; },
	});
	using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
	using model = fixture.editor.invokeWithinContext(accessor => accessor.get(IInstantiationService).createInstance(
		CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)));
	const state = model.trigger({ type: CodeActionTriggerType.Invoke, triggerAction: CodeActionTriggerSource.QuickFix, filter: { include: new HierarchicalKind('refactor') } })!;
	const actions = await state.actions;
	assert.deepEqual(actions.allActions.map(item => item.action.title), ['Extract', 'Unavailable']);
	assert.deepEqual(actions.validActions.map(item => item.action.title), ['Extract']);
	await actions.validActions[0]!.resolve(state.context);
	assert.equal(resolvedOriginal, original);
	assert.deepEqual(fixture.errors, []);
});

for (const change of ['content', 'language', 'selection', 'provider', 'dispose'] as const) {
	test('code action model cancels a superseded query on ' + change, async () => {
		using fixture = createLanguageFeatureEditor();
		let finish!: () => void;
		let signal!: AbortSignal;
		using provider = fixture.features.codeActionProvider.register('typescript', {
			provideCodeActions: (_request, cancellation) => {
				signal = cancellation;
				return new Promise(resolve => { finish = () => resolve([{ title: 'Late action' }]); });
			},
		});
		using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
		using model = fixture.editor.invokeWithinContext(accessor => accessor.get(IInstantiationService).createInstance(
			CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)));
		const state = model.trigger({ type: CodeActionTriggerType.Invoke, triggerAction: CodeActionTriggerSource.QuickFix })!;
		if (change === 'content') { fixture.model.setValue('changed'); }
		if (change === 'language') { fixture.model.setLanguage('javascript'); }
		if (change === 'selection') { fixture.editor.setPosition({ lineNumber: 1, column: 2 }); }
		if (change === 'provider') { provider.dispose(); }
		if (change === 'dispose') { model.dispose(); }
		assert.equal(signal.aborted, true);
		assert.equal(model.state.type, CodeActionsState.Type.Empty);
		finish();
		assert.deepEqual((await state.actions).allActions, []);
		assert.deepEqual(fixture.errors, []);
	});
}
