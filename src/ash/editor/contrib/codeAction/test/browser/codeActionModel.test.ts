import { registerTestCodeEditorFeatures } from '../../../../../../../test/fixtures/codeEditorFeatures.js';
import { after as afterCodeFeatures } from 'mocha';
import assert from 'node:assert/strict';
import { setup, suite, teardown, test } from 'mocha';
import { createLanguageFeatureEditor } from '../../../../test/browser/testLanguageFeatureEditor.js';
import { TextDecorationCollection } from '../../../../common/model/decorationCollection.js';
import { CodeActionTriggerType, type LanguageCodeAction, type LanguageDiagnostic } from '../../../../common/languages.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { CodeActionModel, CodeActionsState } from '../../browser/codeActionModel.js';
import { CodeActionTriggerSource } from '../../common/types.js';
import { HierarchicalKind } from '../../../../../base/common/hierarchicalKind.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IActionWidgetService } from '../../../../../platform/actionWidget/browser/actionWidget.js';
import { getCodeActions } from '../../browser/codeAction.js';
await import('../../browser/codeActionContributions.js');

for (const [command, args, expected] of [
	['editor.action.fixAll', undefined, 'fixed'],
	['editor.action.codeAction', { kind: 'quickfix', preferred: true, apply: 'first' }, 'preferred'],
] as const) {
	test(command + ' applies only its matching action and creates one undo step', async () => {
		using fixture = createLanguageFeatureEditor();
		const original = fixture.model.getValue();
		using provider = fixture.features.codeActionProvider.register('typescript', {
			provideCodeActions: () =>
				[
					{ title: 'Ordinary fix', kind: 'quickfix', text: 'ordinary' },
					{ title: 'Preferred fix', kind: 'quickfix', isPreferred: true, text: 'preferred' },
					{ title: 'Fix all', kind: 'source.fixAll', text: 'fixed' },
				].map(action => ({
					...action,
					edit: {
						entries: [
							{
								kind: 'textDocument',
								resource: fixture.model.uri,
								edits: [{ range: fixture.model.getFullModelRange(), text: action.text }],
							},
						],
					},
				})),
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
	using model = fixture.editor.invokeWithinContext(accessor =>
		accessor.get(IInstantiationService).createInstance(CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)),
	);
	const excluded = model.trigger({
		type: CodeActionTriggerType.Invoke,
		triggerAction: CodeActionTriggerSource.QuickFix,
		filter: { excludes: [new HierarchicalKind('refactor')] },
	})!;
	assert.deepEqual(
		(await excluded.actions).validActions.map(item => item.action.title),
		['Quick fixing extension kind'],
	);
	assert.equal((await excluded.actions).hasAutoFix, false);
	const explicit = model.trigger({
		type: CodeActionTriggerType.Invoke,
		triggerAction: CodeActionTriggerSource.Refactor,
		filter: { include: new HierarchicalKind('refactor.extract'), excludes: [new HierarchicalKind('refactor')] },
	})!;
	assert.deepEqual(
		(await explicit.actions).validActions.map(item => item.action.title),
		['Extract'],
	);
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
		resolveCodeAction: action => {
			resolvedOriginal = action;
			return action;
		},
	});
	using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
	using model = fixture.editor.invokeWithinContext(accessor =>
		accessor.get(IInstantiationService).createInstance(CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)),
	);
	const state = model.trigger({
		type: CodeActionTriggerType.Invoke,
		triggerAction: CodeActionTriggerSource.QuickFix,
		filter: { include: new HierarchicalKind('refactor') },
	})!;
	const actions = await state.actions;
	assert.deepEqual(
		actions.allActions.map(item => item.action.title),
		['Extract', 'Unavailable'],
	);
	assert.deepEqual(
		actions.validActions.map(item => item.action.title),
		['Extract'],
	);
	await actions.validActions[0]!.resolve(state.context);
	assert.equal(resolvedOriginal, original);
	assert.deepEqual(fixture.errors, []);
});

for (const change of ['content', 'language', 'selection', 'provider', 'dispose'] as const) {
	test('code action model cancels a superseded query on ' + change, async () => {
		using fixture = createLanguageFeatureEditor();
		let finish!: () => void;
		let signal!: AbortSignal;
		let released = 0;
		using provider = fixture.features.codeActionProvider.register('typescript', {
			provideCodeActions: (_request, cancellation) => {
				signal = cancellation;
				return new Promise(resolve => {
					finish = () => resolve({ actions: [{ title: 'Late action', isAI: true }], ...toDisposable(() => released++) });
				});
			},
		});
		using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
		using model = fixture.editor.invokeWithinContext(accessor =>
			accessor.get(IInstantiationService).createInstance(CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)),
		);
		const state = model.trigger({
			type: CodeActionTriggerType.Invoke,
			triggerAction: CodeActionTriggerSource.QuickFix,
		})!;
		if (change === 'content') {
			fixture.model.setValue('changed');
		}
		if (change === 'language') {
			fixture.model.setLanguage('javascript');
		}
		if (change === 'selection') {
			fixture.editor.setPosition({ lineNumber: 1, column: 2 });
		}
		if (change === 'provider') {
			provider.dispose();
		}
		if (change === 'dispose') {
			model.dispose();
		}
		assert.equal(signal.aborted, true);
		assert.equal(model.state.type, CodeActionsState.Type.Empty);
		finish();
		assert.deepEqual((await state.actions).allActions, []);
		assert.equal(released, 1);
		assert.deepEqual(fixture.errors, []);
	});
}

suite('Code action result ownership and AI markers', () => {
	let fixture: ReturnType<typeof createLanguageFeatureEditor>;
	// The shared editor fixture creates a window-wide ARIA region. Track the
	// action request resources after that window infrastructure is installed.
	setup(() => {
		fixture = createLanguageFeatureEditor();
	});
	teardown(() => fixture[Symbol.dispose]());
	ensureNoDisposablesAreLeakedInTestSuite();

	for (const [label, entries, expected] of [
		['empty', [], [false, true, false]],
		['ordinary', [{ title: 'Fix' }], [false, false, false]],
		['AI only', [{ title: 'AI fix', isAI: true }], [true, true, false]],
		[
			'mixed',
			[
				{ title: 'AI fix', isAI: true },
				{ title: 'Fix', isAI: false },
			],
			[true, false, false],
		],
		['disabled AI', [{ title: 'AI fix', isAI: true, disabledReason: 'Unavailable' }, { title: 'Fix' }], [false, false, false]],
		[
			'disabled ordinary',
			[
				{ title: 'AI fix', isAI: true },
				{ title: 'Fix', disabledReason: 'Unavailable' },
			],
			[true, true, false],
		],
		['all disabled', [{ title: 'AI fix', isAI: true, disabledReason: 'Unavailable' }], [false, true, false]],
		['preferred AI quick fix', [{ title: 'AI fix', kind: 'quickfix', isAI: true, isPreferred: true }], [true, true, true]],
	] as const) {
		test('computes flags from valid actions: ' + label, async () => {
			using provider = fixture.features.codeActionProvider.register('typescript', {
				provideCodeActions: () => entries,
			});
			using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
			using model = fixture.editor.invokeWithinContext(accessor =>
				accessor.get(IInstantiationService).createInstance(CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)),
			);
			const state = model.trigger({
				type: CodeActionTriggerType.Invoke,
				triggerAction: CodeActionTriggerSource.QuickFix,
			})!;
			const actions = await state.actions;
			assert.deepEqual([actions.hasAIFix, actions.allAIFixes, actions.hasAutoFix], expected);
			assert.deepEqual(
				actions.allActions.map(item => item.action.isAI),
				entries.map(item => (item as LanguageCodeAction).isAI),
			);
			assert.deepEqual(fixture.errors, []);
		});
	}

	for (const change of ['replace', 'content', 'language', 'selection', 'provider', 'dispose'] as const) {
		test('releases resolved provider resources on ' + change, async () => {
			let released = 0;
			using provider = fixture.features.codeActionProvider.register('typescript', {
				provideCodeActions: () => ({
					actions: [{ title: 'AI fix', isAI: true }],
					...toDisposable(() => released++),
				}),
			});
			using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
			using model = fixture.editor.invokeWithinContext(accessor =>
				accessor.get(IInstantiationService).createInstance(CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)),
			);
			const trigger = { type: CodeActionTriggerType.Invoke, triggerAction: CodeActionTriggerSource.QuickFix };
			const state = model.trigger(trigger)!;
			const actions = await state.actions;
			assert.equal(released, 0);
			if (change === 'replace') {
				await model.trigger(trigger)!.actions;
			}
			if (change === 'content') {
				fixture.model.setValue('changed');
			}
			if (change === 'language') {
				fixture.model.setLanguage('javascript');
			}
			if (change === 'selection') {
				fixture.editor.setPosition({ lineNumber: 1, column: 2 });
			}
			if (change === 'provider') {
				provider.dispose();
			}
			if (change === 'dispose') {
				model.dispose();
			}
			assert.equal(released, 1);
			actions.dispose();
			assert.equal(released, 1, 'result disposal is idempotent');
			model.reset();
			assert.equal(released, change === 'replace' ? 2 : 1);
			assert.deepEqual(fixture.errors, []);
		});
	}

	test('releases collected resources while a later provider is still pending', async () => {
		let released = 0;
		let finish!: () => void;
		let started!: () => void;
		const pending = new Promise<void>(resolve => {
			started = resolve;
		});
		using slow = fixture.features.codeActionProvider.register('typescript', {
			provideCodeActions: () => {
				started();
				return new Promise(resolve => {
					finish = () => resolve({ actions: [], ...toDisposable(() => released++) });
				});
			},
		});
		using first = fixture.features.codeActionProvider.register('typescript', {
			provideCodeActions: () => ({ actions: [{ title: 'Ready' }], ...toDisposable(() => released++) }),
		});
		using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
		using model = fixture.editor.invokeWithinContext(accessor =>
			accessor.get(IInstantiationService).createInstance(CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)),
		);
		const state = model.trigger({
			type: CodeActionTriggerType.Invoke,
			triggerAction: CodeActionTriggerSource.QuickFix,
		})!;
		await pending;
		model.reset();
		assert.equal(released, 1);
		finish();
		assert.deepEqual((await state.actions).allActions, []);
		assert.equal(released, 2);
	});

	test('rejects an invalid AI marker and releases that provider list', async () => {
		let released = 0;
		using provider = fixture.features.codeActionProvider.register('typescript', {
			provideCodeActions: () => ({
				actions: [{ title: 'Invalid', isAI: 'yes' as unknown as boolean }],
				...toDisposable(() => released++),
			}),
		});
		using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
		using model = fixture.editor.invokeWithinContext(accessor =>
			accessor.get(IInstantiationService).createInstance(CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)),
		);
		const state = model.trigger({
			type: CodeActionTriggerType.Invoke,
			triggerAction: CodeActionTriggerSource.QuickFix,
		})!;
		assert.deepEqual((await state.actions).allActions, []);
		assert.deepEqual(
			fixture.errors.map(error => (error as Error).message),
			['Code action AI marker must be boolean'],
		);
		assert.equal(released, 1);
	});

	test('flags read the resolved action and preserve the original provider input', async () => {
		const original = { title: 'Fix', isAI: false };
		using provider = fixture.features.codeActionProvider.register('typescript', {
			provideCodeActions: () => [original],
			resolveCodeAction: input => {
				assert.equal(input, original);
				return { ...input, isAI: true };
			},
		});
		using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
		using model = fixture.editor.invokeWithinContext(accessor =>
			accessor.get(IInstantiationService).createInstance(CodeActionModel, fixture.editor, diagnostics, (error: unknown) => fixture.errors.push(error)),
		);
		const state = model.trigger({
			type: CodeActionTriggerType.Invoke,
			triggerAction: CodeActionTriggerSource.QuickFix,
		})!;
		const actions = await state.actions;
		assert.deepEqual([actions.hasAIFix, actions.allAIFixes], [false, false]);
		await actions.validActions[0]!.resolve(state.context);
		assert.deepEqual([actions.hasAIFix, actions.allAIFixes], [true, true]);
		assert.equal(original.isAI, false);
	});

	test('releases preceding providers when error reporting throws', async () => {
		let released = 0;
		using failed = fixture.features.codeActionProvider.register('typescript', {
			provideCodeActions: () => {
				throw new Error('provider failed');
			},
		});
		using first = fixture.features.codeActionProvider.register('typescript', {
			provideCodeActions: () => ({ actions: [{ title: 'Ready' }], ...toDisposable(() => released++) }),
		});
		using diagnostics = new TextDecorationCollection<LanguageDiagnostic>(fixture.model);
		using model = fixture.editor.invokeWithinContext(accessor => accessor.get(IInstantiationService).createInstance(CodeActionModel, fixture.editor, diagnostics, () => {}));
		const state = model.trigger({
			type: CodeActionTriggerType.Invoke,
			triggerAction: CodeActionTriggerSource.QuickFix,
		})!;
		await state.actions;
		await assert.rejects(
			getCodeActions(fixture.features.codeActionProvider, state.context, {}, error => {
				throw error;
			}),
			/provider failed/,
		);
		assert.equal(released, 1);
		model.reset();
		assert.equal(released, 2);
	});

	for (const outcome of ['dismiss', 'replace', 'apply', 'dispose'] as const) {
		test('the Quick Fix command releases its result on ' + outcome, async () => {
			let released = 0;
			using provider = fixture.features.codeActionProvider.register('typescript', {
				provideCodeActions: () => ({
					actions: [
						{
							title: 'AI fix',
							isAI: true,
							edit: {
								entries: [
									{
										kind: 'textDocument',
										resource: fixture.model.uri,
										edits: [{ range: fixture.model.getFullModelRange(), text: 'fixed' }],
									},
								],
							},
						},
					],
					...toDisposable(() => released++),
				}),
			});
			fixture.editor.focus();
			await fixture.editor.getAction('editor.action.quickFix')!.run();
			assert.equal(released, 0);
			const widget = fixture.editor.invokeWithinContext(accessor => accessor.get(IActionWidgetService));
			assert.equal(widget.isVisible, true);
			if (outcome === 'dismiss') {
				widget.hide();
			}
			if (outcome === 'replace') {
				await fixture.editor.getAction('editor.action.quickFix')!.run();
			}
			if (outcome === 'apply') {
				await fixture.editor.getAction('editor.action.codeAction')!.run({ apply: 'first' });
				assert.equal(fixture.model.getValue(), 'fixed');
			}
			if (outcome === 'dispose') {
				fixture.editor.dispose();
			}
			assert.equal(released, outcome === 'apply' ? 2 : 1);
			if (outcome === 'replace') {
				widget.hide();
				assert.equal(released, 2);
			}
			assert.deepEqual(fixture.errors, []);
		});
	}
});

const codeFeatures = registerTestCodeEditorFeatures();
afterCodeFeatures(() => codeFeatures.dispose());
