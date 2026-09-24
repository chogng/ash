import { StandaloneCodeEditorService } from '../../../standalone/browser/standaloneCodeEditorService.js';
import { ICodeEditorService } from '../../../browser/services/codeEditorService.js';
import { h, text } from '../../../../base/browser/dom.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { ILanguageConfigurationService } from '../../../common/languages/languageConfigurationRegistry.js';
import { createTestLanguageConfigurationService } from '../../common/modes/testLanguageConfigurationService.js';
import { ILanguageFeaturesService } from '../../../common/services/languageFeatures.js';
import { LanguageFeaturesService } from '../../../common/services/languageFeaturesService.js';
import assert from "node:assert/strict";
import { test } from "mocha";
import { JSDOM } from "jsdom";
import { browserEnvironment } from '../testEditorDom.js';
import { Event as EditorEvent } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { ContentWidgetPositionPreference, type ICodeEditor, type IContentWidget } from '../../../browser/editorBrowser.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { TextModel } from "../../../common/model/textModel.js";
import { IContextKeyService, ContextKeyService } from "../../../../platform/contextkey/browser/contextKeyService.js";
import { AccessibilitySupport, IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { darkColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { type TextEditorContributionContext } from '../../../browser/editorExtensions.js';
import { IInstantiationService, ServiceConstructionDescriptor, createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

const { CodeEditorWidget } = await import("../../../browser/widget/codeEditor/codeEditorWidget.js");
const { createTestCodeEditor } = await import('../testCodeEditor.js');
const { EditorContributionInstantiation } = await import('../../../browser/editorExtensions.js');
const { ServiceContainer } = await import("../../../../platform/instantiation/common/instantiation.js");
const { ILogService, NullLoggerService } = await import('../../../../platform/log/common/log.js');
const { PlaceholderTextContribution } = await import("../../../contrib/placeholderText/browser/placeholderTextContribution.js");
const { VersionedEditorWorkerClient } = await import('../../../browser/services/editorWorkerService.js');
const { EditorWorker } = await import('../../../common/services/editorWebWorker.js');
await import("../../../contrib/placeholderText/browser/placeholderText.contribution.js");
await import('../../../contrib/inPlaceReplace/browser/inPlaceReplace.js');

const enabledAccessibilityService: IAccessibilityService = {
	onDidChangeScreenReaderOptimized: EditorEvent.None,
	onDidChangeReducedMotion: EditorEvent.None,
	onDidChangeReducedTransparency: EditorEvent.None,
	onDidChangeLinkUnderlines: EditorEvent.None,
	alwaysUnderlineAccessKeys: async () => false,
	isScreenReaderOptimized: () => true,
	isMotionReduced: () => false,
	isTransparencyReduced: () => false,
	getAccessibilitySupport: () => AccessibilitySupport.Enabled,
	setAccessibilitySupport: () => {},
	alert: () => {},
	status: () => {},
};

function delay(targetWindow: Pick<Window, 'setTimeout'>, duration: number): Promise<void> {
	return new Promise(resolve => targetWindow.setTimeout(resolve, duration));
}

test('CodeEditorWidget publishes service lifecycle in construction order', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	using service = new StandaloneCodeEditorService();
	using services = new ServiceContainer();
	services.registerInstance(ICodeEditorService, service);
	const events: string[] = [];
	using willCreate = service.onWillCreateCodeEditor(() => events.push('will'));
	using add = service.onCodeEditorAdd(editor => events.push(`add:${editor.getId()}`));
	using remove = service.onCodeEditorRemove(editor => events.push(`remove:${editor.getId()}`));
	const editor = createTestCodeEditor({
		container: requiredElement(dom.window.document, 'main'),
		model,
		lineHeight: 20,
		instantiationService: services,
	});

	assert.deepEqual(events, ['will', `add:${editor.getId()}`]);
	assert.strictEqual(service.getActiveCodeEditor(), editor);
	editor.dispose();
	assert.deepEqual(events, ['will', `add:${editor.getId()}`, `remove:${editor.getId()}`]);
	assert.equal(service.getActiveCodeEditor(), null);
	dom.window.close();
});

test('CodeEditorWidget switches models without replacing its identity or retaining the old view', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using first = new TextModel('first', { resource: URI.file('/first.ts'), languageId: 'typescript' });
	using second = new TextModel('second', { resource: URI.file('/second.md'), languageId: 'markdown' });
	const contributionEvents: string[] = [];
	class TrackingContribution extends Disposable {
		constructor(editor: ICodeEditor) {
			super();
			const resource = editor.getModel()?.uri.toString();
			contributionEvents.push(`create:${resource}`);
			this._register(toDisposable(() => contributionEvents.push(`dispose:${resource}`)));
		}
	}
	const editor = createTestCodeEditor({
		container,
		model: first,
		lineHeight: 20,
		contributions: [{ id: 'test.modelSwitch', ctor: TrackingContribution, instantiation: EditorContributionInstantiation.Eager }],
	});
	try {
		const root = editor.getDomNode();
		assert.equal(root.getAttribute('aria-label'), 'first.ts');
		const oldInput = root.querySelector('.stanza-editor-input');
		const widgetDomNode = h(dom.window.document, 'button');
		const widget: IContentWidget = {
			getId: () => 'test.modelSwitchWidget',
			getDomNode: () => widgetDomNode,
			getPosition: () => ({ position: new Position(1, 1), preference: [ContentWidgetPositionPreference.EXACT] }),
		};
		editor.addContentWidget(widget);
		assert.equal(root.contains(widgetDomNode), true);
		const decorations = editor.createDecorationsCollection([{ range: new Range(1, 1, 1, 2), options: { description: 'first model' } }]);
		assert.equal(decorations.length, 1);
		const modelEvents: string[] = [];
		const focusedAtChange: boolean[] = [];
		using willChange = editor.onWillChangeModel(event => modelEvents.push(`will:${event.oldModelUrl?.toString()}->${event.newModelUrl?.toString()}`));
		using didChange = editor.onDidChangeModel(event => {
			modelEvents.push(`did:${event.oldModelUrl?.toString()}->${event.newModelUrl?.toString()}`);
			focusedAtChange.push(editor.hasTextFocus());
		});
		let contentChanges = 0;
		using contentListener = editor.onDidChangeModelContent(() => { contentChanges += 1; });
		editor.setModel(first);
		assert.deepEqual(modelEvents, []);
		editor.focus();
		editor.setModel(second);
		assert.strictEqual(editor.getDomNode(), root);
		assert.strictEqual(editor.getModel(), second);
		assert.equal(root.getAttribute('aria-label'), 'second.md');
		assert.equal(editor.hasTextFocus(), true);
		assert.notStrictEqual(root.querySelector('.stanza-editor-input'), oldInput);
		assert.equal(root.contains(widgetDomNode), true);
		assert.equal(first.isDisposed(), false);
		assert.equal(first.getAllDecorations().length, 0);
		assert.equal(decorations.length, 0);
		decorations.set([{ range: new Range(1, 1, 1, 2), options: { description: 'second model' } }]);
		assert.equal(second.getAllDecorations().length, 1);
		first.setValue('old edit');
		assert.equal(contentChanges, 0);
		second.setValue('new edit');
		assert.equal(contentChanges, 1);

		editor.setModel(null);
		assert.deepEqual({ model: editor.getModel(), hasModel: editor.hasModel(), value: editor.getValue(), mounted: container.contains(root), input: root.querySelector('.stanza-editor-input') }, {
			model: null,
			hasModel: false,
			value: '',
			mounted: true,
			input: null,
		});
		assert.equal(widgetDomNode.isConnected, false);
		assert.equal(decorations.length, 0);
		editor.setModel(first);
		assert.strictEqual(editor.getDomNode(), root);
		assert.strictEqual(editor.getModel(), first);
		assert.equal(root.getAttribute('aria-label'), 'first.ts');
		assert.equal(root.contains(widgetDomNode), true);
		decorations.set([{ range: new Range(1, 2, 1, 3), options: { description: 'reattached' } }]);
		assert.deepEqual(decorations.getRanges(), [new Range(1, 2, 1, 3)]);
		assert.deepEqual(contributionEvents, [
			`create:${first.uri}`, `dispose:${first.uri}`,
			`create:${second.uri}`, `dispose:${second.uri}`,
			`create:${first.uri}`,
		]);
		assert.deepEqual(modelEvents, [
			`will:${first.uri}->${second.uri}`, `did:${first.uri}->${second.uri}`,
			`will:${second.uri}->undefined`, `did:${second.uri}->undefined`,
			`will:undefined->${first.uri}`, `did:undefined->${first.uri}`,
		]);
		assert.deepEqual(focusedAtChange, [true, false, false]);
	} finally {
		editor.dispose();
		dom.window.close();
	}
});

test('CodeEditorWidget detaches a disposed model and can attach a later model', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	const first = new TextModel('first');
	using second = new TextModel('second');
	const editor = createTestCodeEditor({ container, model: first, lineHeight: 20 });
	try {
		const root = editor.getDomNode();
		first.dispose();
		assert.deepEqual({ model: editor.getModel(), input: root.querySelector('.stanza-editor-input'), mounted: container.contains(root) }, { model: null, input: null, mounted: true });
		editor.setModel(second);
		assert.strictEqual(editor.getModel(), second);
		assert.strictEqual(editor.getDomNode(), root);
		assert.equal(root.querySelectorAll('.stanza-editor-input').length, 1);
		assert.throws(() => editor.setModel(first), /live TextModel/);
		assert.strictEqual(editor.getModel(), second);
	} finally {
		editor.dispose();
		dom.window.close();
	}
});

test('CodeEditorWidget leaves a usable empty editor when replacement setup fails', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using first = new TextModel('first');
	using failed = new TextModel('failed');
	const editor = createTestCodeEditor({
		container,
		model: first,
		lineHeight: 20,
		editorWorkerFactory: model => {
			if (model === failed) throw new Error('worker unavailable');
			return new VersionedEditorWorkerClient(model, () => new EditorWorker());
		},
	});
	try {
		const root = editor.getDomNode();
		const changes: string[] = [];
		using listener = editor.onDidChangeModel(event => changes.push(`${event.oldModelUrl?.toString()}->${event.newModelUrl?.toString()}`));
		assert.throws(() => editor.setModel(failed), /worker unavailable/);
		assert.deepEqual({ model: editor.getModel(), input: root.querySelector('.stanza-editor-input'), mounted: container.contains(root) }, { model: null, input: null, mounted: true });
		assert.deepEqual(changes, [`${first.uri}->undefined`]);
		editor.setModel(first);
		assert.strictEqual(editor.getModel(), first);
		assert.equal(root.querySelectorAll('.stanza-editor-input').length, 1);
	} finally {
		editor.dispose();
		dom.window.close();
	}
});

test('CodeEditorWidget stops a model switch when a will-change listener disposes it', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using first = new TextModel('first');
	using second = new TextModel('second');
	const editor = createTestCodeEditor({ container, model: first, lineHeight: 20 });
	const root = editor.getDomNode();
	using listener = editor.onWillChangeModel(() => editor.dispose());
	assert.doesNotThrow(() => editor.setModel(second));
	assert.deepEqual({ disposed: editor.isDisposed, rootMounted: container.contains(root), firstDisposed: first.isDisposed(), secondDisposed: second.isDisposed() }, {
		disposed: true,
		rootMounted: false,
		firstDisposed: false,
		secondDisposed: false,
	});
	dom.window.close();
});

test('CodeEditorWidget clears its model state when contribution disposal fails during a switch', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	using first = new TextModel('first');
	using second = new TextModel('second');
	class FailingContribution extends Disposable {
		protected override disposeCore(): void {
			super.disposeCore();
			throw new Error('contribution cleanup failed');
		}
	}
	const editor = createTestCodeEditor({
		container,
		model: first,
		lineHeight: 20,
		contributions: [{ id: 'test.failOnDispose', ctor: FailingContribution, instantiation: EditorContributionInstantiation.Eager }],
	});
	try {
		const root = editor.getDomNode();
		const events: string[] = [];
		using listener = editor.onDidChangeModel(event => events.push(`${event.oldModelUrl?.toString()}->${event.newModelUrl?.toString()}`));
		assert.throws(() => editor.setModel(second));
		assert.deepEqual({ model: editor.getModel(), mounted: container.contains(root), input: root.querySelector('.stanza-editor-input'), events }, {
			model: null,
			mounted: true,
			input: null,
			events: [`${first.uri}->undefined`],
		});
	} finally {
		editor.dispose();
		dom.window.close();
	}
});

test("CodeEditorWidget stages and owns per-instance contributions", () => {
	const dom = new JSDOM("<!doctype html><body><main></main></body>");
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, "main");
	using model = new TextModel("alpha");
	const events: string[] = [];
	let restoredState: unknown;
	class EagerContribution extends Disposable {
		constructor(editor: ICodeEditor) {
			super();
			assert.strictEqual(editor.getModel(), model);
			events.push('eager:create');
			this._register(toDisposable(() => events.push('eager:dispose')));
		}
		saveViewState(): unknown { return { marker: 'saved' }; }
		restoreViewState(state: unknown): void { restoredState = state; }
	}
	class LazyContribution extends Disposable {
		constructor(editor: ICodeEditor) {
			super();
			assert.strictEqual(editor.getModel(), model);
			events.push('lazy:create');
			this._register(toDisposable(() => events.push('lazy:dispose')));
		}
	}
	using editor = createTestCodeEditor({
		container,
		model,
		lineHeight: 20,
		contributions: [
			{
				id: "test.eager",
				instantiation: EditorContributionInstantiation.Eager,
				ctor: EagerContribution,
			},
			{
				id: "test.lazy",
				instantiation: EditorContributionInstantiation.Lazy,
				ctor: LazyContribution,
			},
		],
	});

	assert.deepEqual(events, ["eager:create"]);
	const saved = editor.saveViewState();
	assert.ok(saved);
	assert.deepEqual(saved.contributionsState, { 'test.eager': { marker: 'saved' } });
	editor.restoreViewState({ ...saved, contributionsState: { 'test.eager': { marker: 'restored' } } });
	assert.deepEqual(restoredState, { marker: 'restored' });
	assert.ok(editor.getContribution("test.lazy"));
	assert.deepEqual(events, ["eager:create", "lazy:create"]);
	editor.dispose();
	assert.deepEqual(events, ["eager:create", "lazy:create", "lazy:dispose", "eager:dispose"]);
	dom.window.close();
});

test('CodeEditorWidget owns configured resources and deferred controllers across model switches', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	const events: string[] = [];
	const modelService = createServiceIdentifier<TextModel>('test.editor.model');
	class Controller extends Disposable {
		constructor(context: TextEditorContributionContext, services: IInstantiationService, providedModel: TextModel) {
			super();
			assert.equal(services, context.instantiationService);
			assert.equal(providedModel, model);
			assert.equal(context.editor.getModel(), model);
			assert.equal(context.view.domNode.domNode.isConnected, true);
			events.push('create');
			this._register(toDisposable(() => events.push('dispose controller')));
		}
	}
	try {
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'),
			model,
			contributions: [{
				id: 'test.deferred',
				instantiation: EditorContributionInstantiation.Lazy,
				configure: context => {
					events.push('configure');
					context.provideService(modelService, context.model);
					context.register(toDisposable(() => events.push('dispose configuration')));
				},
				install: context => {
					if (context.kind !== 'text') return;
					events.push('install');
					context.register(toDisposable(() => events.push('dispose installation')));
					return context.instantiationService.createInstance(new ServiceConstructionDescriptor(Controller, { serviceDependencies: [IInstantiationService, modelService] }), context);
				},
			}],
		});
		assert.deepEqual(events, ['configure']);
		editor.setModel(null);
		assert.deepEqual(events, ['configure', 'dispose configuration']);
		editor.setModel(model);
		const controller = editor.getContribution('test.deferred');
		assert.ok(controller instanceof Controller);
		assert.equal(editor.getContribution('test.deferred'), controller);
		assert.deepEqual(events.slice(2), ['configure', 'install', 'create']);
		editor.setModel(null);
		assert.deepEqual(events.slice(5), ['dispose controller', 'dispose installation', 'dispose configuration']);
	} finally {
		dom.window.close();
	}
});

test('CodeEditorWidget keeps configuration resources alive after installation fails', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	const events: string[] = [];
	const failure = new Error('installation failed');
	const errors: unknown[] = [];
	let configurationDisposed = false;
	let view: TextEditorContributionContext['view'] | undefined;
	try {
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'),
			model,
			onContributionError: error => errors.push(error),
			guides: { bracketPairs: true },
			dimension: { width: 400, height: 100 },
			contributions: [{
				id: 'test.failedHook',
				configure: context => {
					context.register(toDisposable(() => { configurationDisposed = true; events.push('configuration'); }));
				},
				install: context => {
					if (context.kind !== 'text') return;
					view = context.view;
					context.register(toDisposable(() => events.push('installation')));
					throw failure;
				},
			}],
		});
		assert.equal(editor.getContribution('test.failedHook'), null);
		assert.deepEqual(errors, [failure]);
		assert.deepEqual(events, ['installation']);
		assert.equal(configurationDisposed, false);
		editor.layout({ width: 400, height: 100 });
		model.reset('beta');
		assert.ok(view);
		view.render(true, true);
		assert.equal(configurationDisposed, false);
		editor.setModel(null);
		assert.deepEqual(events, ['installation', 'configuration']);
		assert.equal(configurationDisposed, true);
	} finally {
		dom.window.close();
	}
});

test('CodeEditorWidget injects scoped services into contributions and releases them on model detach', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using parent = new ServiceContainer();
	using model = new TextModel('alpha');
	const instances: Contribution[] = [];
	class Contribution extends Disposable {
		constructor(readonly editor: ICodeEditor, @IInstantiationService readonly services: IInstantiationService) {
			super();
			instances.push(this);
		}
	}
	try {
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'),
			model, lineHeight: 20,
			instantiationService: parent,
			contributions: [{ id: 'test.injected', ctor: Contribution, instantiation: EditorContributionInstantiation.Eager }],
		});
		assert.equal(instances.length, 1);
		assert.equal(instances[0].editor, editor);
		assert.notEqual(instances[0].services, parent);
		assert.equal(instances[0].services, editor.invokeWithinContext(accessor => accessor.get(IInstantiationService)));
		editor.setModel(null);
		assert.equal(instances[0].isDisposed, true);
		assert.throws(() => instances[0].services.get(IInstantiationService), /disposed/i);
		editor.setModel(model);
		assert.equal(instances.length, 2);
		assert.equal(instances[1].isDisposed, false);
		assert.notEqual(instances[1].services, instances[0].services);
		assert.equal(instances[1].services, editor.invokeWithinContext(accessor => accessor.get(IInstantiationService)));
	} finally {
		dom.window.close();
	}
	assert.equal(instances[1].isDisposed, true);
	assert.equal(parent.isDisposed, false);
});

test('Suggest registration follows editor enablement and model disposal', async () => {
	const { SuggestController } = await import('../../../contrib/suggest/browser/suggestController.js');
	assert.equal(SuggestController.ID, 'editor.contrib.suggestController');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	using cleanup = { [Symbol.dispose]: () => dom.window.close() };
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	const container = requiredElement(dom.window.document, 'main');
	for (const enabled of [false, true]) {
		using model = new TextModel('alpha');
		using editor = createTestCodeEditor({ container, model, suggestions: enabled });
		assert.equal(SuggestController.get(editor) !== null, enabled);
		assert.equal(editor.getContribution('editor.contrib.suggest'), null);
		assert.equal(container.querySelectorAll('.stanza-editor-completion').length, enabled ? 1 : 0);
		editor.setModel(null);
		assert.equal(container.querySelectorAll('.stanza-editor-completion').length, 0);
	}
});

test('content events follow the attached model and retain edit, undo, redo, and reset details', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using closeWindow = toDisposable(() => dom.window.close());
	using first = new TextModel('alpha');
	using second = new TextModel('beta');
	using editor = createTestCodeEditor({ container: requiredElement(dom.window.document, 'main'), model: first });
	const events: { text: string; undo: boolean; redo: boolean; flush: boolean; version: number }[] = [];
	using listener = editor.onDidChangeModelContent(event => events.push({ text: event.changes.map(change => change.text).join(''), undo: event.isUndoing, redo: event.isRedoing, flush: event.isFlush, version: event.versionId }));
	editor.pushUndoStop();
	editor.executeEdits('test', [{ range: new Range(1, 1, 1, 6), text: 'one' }]);
	editor.pushUndoStop();
	first.undo();
	first.redo();
	editor.setModel(second);
	first.setValue('detached');
	editor.setValue('two');
	assert.deepEqual(events, [
		{ text: 'one', undo: false, redo: false, flush: false, version: 2 },
		{ text: 'alpha', undo: true, redo: false, flush: false, version: 3 },
		{ text: 'one', undo: false, redo: true, flush: false, version: 4 },
		{ text: 'two', undo: false, redo: false, flush: true, version: 2 },
	]);
	editor.setModel(null);
	second.setValue('detached too');
	assert.equal(editor.saveViewState(), null);
	assert.equal(events.length, 4);
});

test('Contribution selection distinguishes defaults, an empty list, and an explicit subset', async () => {
	const { EditorExtensionsRegistry } = await import('../../../browser/editorExtensions.js');
	const { FindController, FindStartFocusAction } = await import('../../../contrib/find/browser/findController.js');
	await import('../../../contrib/find/browser/findController.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	try {
		for (const contributions of [undefined, [], EditorExtensionsRegistry.getSomeEditorContributions([FindController.ID])]) {
			using editor = createTestCodeEditor({
				container: requiredElement(dom.window.document, 'main'),
				model, contributions,
			});
			const find = editor.getContribution(FindController.ID);
			if (contributions?.length === 0) {
				assert.equal(find, null);
				assert.equal(editor.getContribution(PlaceholderTextContribution.ID), null);
				assert.equal(dom.window.document.querySelector('.stanza-editor-find-widget'), null);
				continue;
			}
			assert.ok(find instanceof FindController);
			assert.equal(editor.getContribution(FindController.ID), find);
			await find.start({
				forceRevealReplace: false,
				seedSearchStringFromSelection: 'none',
				seedSearchStringFromNonEmptySelection: false,
				seedSearchStringFromGlobalClipboard: false,
				shouldFocus: FindStartFocusAction.NoFocusChange,
				shouldAnimate: false,
				updateSearchScope: false,
				loop: true,
			});
			assert.equal(find.getState().isRevealed, true);
			find.closeFindWidget();
			assert.equal(find.getState().isRevealed, false);
			assert.equal(editor.getContribution(PlaceholderTextContribution.ID) !== null, contributions === undefined);
			editor.setModel(null);
			assert.equal(find.isDisposed, true);
			assert.equal(editor.getContribution(FindController.ID), null);
			editor.setModel(model);
			assert.ok(editor.getContribution(FindController.ID) instanceof FindController);
			assert.notEqual(editor.getContribution(FindController.ID), find);
		}
	} finally {
		dom.window.close();
	}
});

test('Disabled and configuration-only contributions do not expose placeholder instances', async () => {
	const { EditorExtensionsRegistry } = await import('../../../browser/editorExtensions.js');
	await import('../../../contrib/unicodeHighlighter/browser/unicodeHighlighter.contribution.js');
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	const events: string[] = [];
	try {
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'),
			model, showUnicodeHighlights: false,
			contributions: [
				...EditorExtensionsRegistry.getSomeEditorContributions(['editor.contrib.unicodeHighlighter']),
				{
					id: 'test.modelConfiguration',
					configure: context => {
						events.push('configure');
						context.register(toDisposable(() => events.push('dispose')));
					},
				},
			],
		});
		assert.equal(editor.getContribution('editor.contrib.unicodeHighlighter'), null);
		assert.equal(editor.getContribution('test.modelConfiguration'), null);
		assert.deepEqual(events, ['configure']);
		editor.setModel(null);
		assert.deepEqual(events, ['configure', 'dispose']);
	} finally {
		dom.window.close();
	}
});

test('Returning an already registered controller preserves dependent listener cleanup order', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	dom.window.HTMLCanvasElement.prototype.getContext = () => null;
	using model = new TextModel('alpha');
	const events: string[] = [];
	class Controller extends Disposable {
		constructor() {
			super();
			this._register(toDisposable(() => events.push('controller')));
		}
	}
	try {
		using editor = createTestCodeEditor({
			container: requiredElement(dom.window.document, 'main'),
			model,
			contributions: [{
				id: 'test.registeredController',
				install: context => {
					if (context.kind !== 'text') return;
					const controller = context.register(new Controller());
					context.register(toDisposable(() => {
						assert.equal(controller.isDisposed, false);
						events.push('listener');
					}));
					return controller;
				},
			}],
		});
		assert.ok(editor.getContribution('test.registeredController') instanceof Controller);
		editor.setModel(null);
		assert.deepEqual(events, ['listener', 'controller']);
	} finally {
		dom.window.close();
	}
});

test('CodeEditorWidget rejects missing shared services before creating its surface', () => {
	using configurations = createTestLanguageConfigurationService();
	using features = new LanguageFeaturesService();
	using theme = new TestThemeService(darkColorTheme);
	using model = new TextModel('text');
	using contextKeys = new ContextKeyService();
	for (const missing of [
		IThemeService,
		ILanguageConfigurationService,
		ILanguageFeaturesService,
		IContextKeyService,
		IAccessibilityService,
		ICodeEditorService,
	]) {
		using services = new ServiceContainer();
		if (missing !== ICodeEditorService) {
			services.registerSingleton(ICodeEditorService, () => services.createInstance(StandaloneCodeEditorService));
		}
		if (missing !== IContextKeyService) services.registerInstance(IContextKeyService, contextKeys);
		if (missing !== IThemeService) services.registerInstance(IThemeService, theme);
		if (missing !== ILanguageConfigurationService) services.registerInstance(ILanguageConfigurationService, configurations);
		if (missing !== ILanguageFeaturesService) services.registerInstance(ILanguageFeaturesService, features);
		if (missing !== IAccessibilityService) services.registerInstance(IAccessibilityService, enabledAccessibilityService);
		const container = h(browserEnvironment.window.document, 'div');
		assert.throws(() => services.createInstance(CodeEditorWidget, {
			container, model, contributions: [],
		}), error => error instanceof Error && error.message.includes(missing.description));
		assert.equal(container.childElementCount, 0);
	}
});

test('CodeEditorWidget shares host language services across contributions and model switches', () => {
	using configurations = createTestLanguageConfigurationService();
	using features = new LanguageFeaturesService();
	using theme = new TestThemeService(darkColorTheme);
	using services = new ServiceContainer();
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerInstance(IThemeService, theme);
	services.registerInstance(ILanguageConfigurationService, configurations);
	services.registerInstance(ILanguageFeaturesService, features);
	services.registerInstance(IAccessibilityService, enabledAccessibilityService);
	services.registerSingleton(ICodeEditorService, () => services.createInstance(StandaloneCodeEditorService));
	using first = new TextModel('first');
	using second = new TextModel('second');
	const seen: ILanguageFeaturesService[] = [];
	class Contribution extends Disposable {
		constructor(_editor: ICodeEditor, @ILanguageFeaturesService service: ILanguageFeaturesService) {
			super();
			seen.push(service);
		}
	}
	const container = h(browserEnvironment.window.document, 'div');
	using editor = services.createInstance(CodeEditorWidget, {
		container, model: first,
		contributions: [
			{ id: 'test.shared.constructor', ctor: Contribution, instantiation: EditorContributionInstantiation.Eager },
			{ id: 'test.shared.hook', install: (context: TextEditorContributionContext) => { seen.push(context.languageFeaturesService); } },
		],
	});
	editor.setModel(second);
	assert.deepEqual(seen, [features, features, features, features]);
	editor.dispose();
	assert.equal(features.isDisposed, false);
	assert.equal(theme.isDisposed, false);
	assert.equal(services.get(ILanguageConfigurationService), configurations);
	assert.equal(first.isDisposed(), false);
	assert.equal(second.isDisposed(), false);
});

function requiredElement<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
	const element = root.querySelector<T>(selector);
	assert.ok(element);
	return element;
}
