import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeService } from '../../../../platform/theme/common/themeService.js';
import { darkColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { EditorConfiguration } from '../../../browser/config/editorConfiguration.js';
import { CursorState } from '../../../common/cursorCommon.js';
import { CursorChangeReason } from '../../../common/cursorEvents.js';
import { Position } from '../../../common/core/position.js';
import { Range } from '../../../common/core/range.js';
import { Selection } from '../../../common/core/selection.js';
import { ScrollType } from '../../../common/editorCommon.js';
import { createBuiltinLanguageConfigurationService } from '../../../common/languages/languageBuiltinConfigurations.js';
import { TextModel } from '../../../common/model/textModel.js';
import { MonospaceLineBreaksComputerFactory } from '../../../common/viewModel/monospaceLineBreaksComputer.js';
import { getViewModelCursorController, ViewModel } from '../../../common/viewModel/viewModelImpl.js';
import { CursorStateChangedEvent, ModelTokensChangedEvent } from '../../../common/viewModelEventDispatcher.js';
import { ViewEventHandler } from '../../../common/viewEventHandler.js';
import { type ViewCursorStateChangedEvent, type ViewDecorationsChangedEvent, type ViewFlushedEvent, type ViewLanguageConfigurationEvent, type ViewLineMappingChangedEvent, type ViewRevealRangeRequestEvent, type ViewTokensChangedEvent } from '../../../common/viewEvents.js';

class CapturedViewEvents extends ViewEventHandler {
	readonly cursorEvents: ViewCursorStateChangedEvent[] = [];
	readonly revealEvents: ViewRevealRangeRequestEvent[] = [];
	readonly decorationsEvents: ViewDecorationsChangedEvent[] = [];
	readonly flushedEvents: ViewFlushedEvent[] = [];
	readonly languageConfigurationEvents: ViewLanguageConfigurationEvent[] = [];
	readonly lineMappingEvents: ViewLineMappingChangedEvent[] = [];
	readonly tokenEvents: ViewTokensChangedEvent[] = [];

	public override onCursorStateChanged(event: ViewCursorStateChangedEvent): boolean {
		this.cursorEvents.push(event);
		return false;
	}

	public override onRevealRangeRequest(event: ViewRevealRangeRequestEvent): boolean {
		this.revealEvents.push(event);
		return false;
	}

	public override onDecorationsChanged(event: ViewDecorationsChangedEvent): boolean {
		this.decorationsEvents.push(event);
		return false;
	}

	public override onFlushed(event: ViewFlushedEvent): boolean {
		this.flushedEvents.push(event);
		return false;
	}

	public override onLanguageConfigurationChanged(event: ViewLanguageConfigurationEvent): boolean {
		this.languageConfigurationEvents.push(event);
		return false;
	}

	public override onLineMappingChanged(event: ViewLineMappingChangedEvent): boolean {
		this.lineMappingEvents.push(event);
		return false;
	}

	public override onTokensChanged(event: ViewTokensChangedEvent): boolean {
		this.tokenEvents.push(event);
		return false;
	}
}

test('ViewModel owns line projection, cursor, layout, and visible-line publication', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector('main')!;
	using cleanup = toDisposable(() => dom.window.close());
	using configuration = new EditorConfiguration(false, MenuId.EditorContext, {
		dimension: { width: 200, height: 40 },
		lineHeight: 20,
	}, container);
	using languages = createBuiltinLanguageConfigurationService();
	using model = new TextModel('one\ntwo\nthree', { languageConfigurationService: languages });
	using theme = new ThemeService(darkColorTheme);
	const factory = MonospaceLineBreaksComputerFactory.create(configuration.options);
	const visible: Array<{ startLineNumber: number; endLineNumber: number }> = [];
	using viewModel = new ViewModel(
		1,
		configuration,
		model,
		factory,
		factory,
		callback => {
			queueMicrotask(callback);
			return Disposable.None;
		},
		languages,
		theme,
		{ setVisibleLines: ranges => visible.push(...ranges) },
		{ batchChanges: callback => callback() },
	);
	using captured = new CapturedViewEvents();
	viewModel.addViewEventHandler(captured);
	using detachCaptured = toDisposable(() => viewModel.removeViewEventHandler(captured));
	const outgoingCursorSources: string[] = [];
	let outgoingTokenChanges = 0;
	let controllerSelectionChanges = 0;
	using controllerListener = getViewModelCursorController(viewModel).onDidChange(() => controllerSelectionChanges += 1);
	using outgoingListener = viewModel.onEvent(event => {
		if (event instanceof CursorStateChangedEvent) outgoingCursorSources.push(event.source);
		if (event instanceof ModelTokensChangedEvent) outgoingTokenChanges += 1;
	});

	assert.equal(viewModel.getLineCount(), 3);
	assert.equal(viewModel.viewLayout.getScrollHeight(), 60);
	assert.deepEqual(viewModel.getPrimaryCursorState().modelState.position, new Position(1, 1));

	viewModel.setCursorStates('test', CursorChangeReason.Explicit, [CursorState.fromModelSelection(new Selection(3, 2, 3, 2))]);
	assert.deepEqual(viewModel.getPrimaryCursorState().modelState.position, new Position(3, 2));
	assert.deepEqual(outgoingCursorSources, ['test']);
	assert.equal(captured.cursorEvents.length, 1);
	assert.equal(controllerSelectionChanges, 1);
	const columnSelection = { isReal: true, fromViewLineNumber: 1, fromViewVisualColumn: 2, toViewLineNumber: 3, toViewVisualColumn: 4 };
	viewModel.setCursorColumnSelectData(columnSelection);
	assert.deepEqual(viewModel.getCursorColumnSelectData(), columnSelection);
	const cursorState = viewModel.saveCursorState();
	viewModel.setSelections('test', [new Selection(1, 2, 1, 2)], CursorChangeReason.Explicit);
	assert.equal(viewModel.getCursorColumnSelectData().isReal, false);
	viewModel.restoreCursorState(cursorState);
	assert.deepEqual(viewModel.getSelection(), new Selection(3, 2, 3, 2));
	assert.deepEqual(viewModel.getSelections(), [new Selection(3, 2, 3, 2)]);
	assert.equal(captured.revealEvents.at(-1)?.scrollType, ScrollType.Immediate);

	const initialCursorConfiguration = viewModel.cursorConfig;
	configuration.updateOptions({ readOnly: true });
	assert.notStrictEqual(viewModel.cursorConfig, initialCursorConfiguration);
	assert.equal(viewModel.cursorConfig.readOnly, true);

	model.updateOptions({ tabSize: 8 });
	assert.equal(captured.flushedEvents.length, 1);
	assert.equal(captured.decorationsEvents.length, 1);
	assert.equal(captured.lineMappingEvents.length, 1);
	using languageConfiguration = languages.register('plaintext', { comments: { lineComment: '//' } });
	assert.equal(captured.languageConfigurationEvents.length, 1);
	model.tokenization.setSemanticTokens(null, false);
	assert.deepEqual(captured.tokenEvents.at(-1)?.ranges, [{ fromLineNumber: 1, toLineNumber: 3 }]);
	assert.equal(outgoingTokenChanges, 1);

	viewModel.viewLayout.setScrollPosition({ scrollTop: 20 }, ScrollType.Immediate);
	const viewState = viewModel.saveState();
	assert.deepEqual(viewModel.reduceRestoreState(viewState), { scrollLeft: 0, scrollTop: 20 });

	viewModel.setHiddenAreas([new Range(2, 1, 2, 1)]);
	assert.equal(viewModel.getLineCount(), 2);
	assert.equal(viewModel.getLineContent(2), 'three');
	assert.deepEqual(viewModel.getVisibleRanges(), [new Range(1, 1, 1, 4), new Range(3, 1, 3, 6)]);
	model.applyEdits([{
		range: Range.fromPositions(new Position(1, 4)),
		text: '!',
	}]);
	assert.equal(viewModel.getLineContent(1), 'one!');
	viewModel.visibleLinesStabilized();
	assert.deepEqual(visible.at(-1), { startLineNumber: 1, endLineNumber: 3 });
});

test('ViewModel resets cursor markers through CursorsController after model flush', () => {
	const dom = new JSDOM('<!doctype html><body><main></main></body>');
	const container = dom.window.document.querySelector('main')!;
	using cleanup = toDisposable(() => dom.window.close());
	using configuration = new EditorConfiguration(false, MenuId.EditorContext, { dimension: { width: 200, height: 40 } }, container);
	using languages = createBuiltinLanguageConfigurationService();
	using model = new TextModel('one\ntwo', { languageConfigurationService: languages });
	using theme = new ThemeService(darkColorTheme);
	const factory = MonospaceLineBreaksComputerFactory.create(configuration.options);
	using viewModel = new ViewModel(
		1,
		configuration,
		model,
		factory,
		factory,
		() => Disposable.None,
		languages,
		theme,
		{ setVisibleLines: () => {} },
		{ batchChanges: callback => callback() },
	);
	using captured = new CapturedViewEvents();
	viewModel.addViewEventHandler(captured);
	using detachCaptured = toDisposable(() => viewModel.removeViewEventHandler(captured));
	const outgoing: CursorStateChangedEvent[] = [];
	using listener = viewModel.onEvent(event => {
		if (event instanceof CursorStateChangedEvent) outgoing.push(event);
	});
	viewModel.setSelections('test', [new Selection(1, 2, 1, 2), new Selection(2, 2, 2, 2)], CursorChangeReason.Explicit);
	outgoing.length = 0;
	captured.cursorEvents.length = 0;

	model.setValue('reset');

	assert.deepEqual({
		selections: viewModel.getSelections(),
		flushViewReasons: captured.cursorEvents.map(event => event.reason).filter(reason => reason === CursorChangeReason.ContentFlush),
		outgoingReasons: outgoing.map(event => event.reason),
	}, {
		selections: [new Selection(1, 1, 1, 1)],
		flushViewReasons: [CursorChangeReason.ContentFlush],
		outgoingReasons: [CursorChangeReason.ContentFlush],
	});
});
