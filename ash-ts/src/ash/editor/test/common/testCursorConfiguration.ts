import { Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { type IEditorConfiguration } from '../../common/config/editorConfiguration.js';
import { EditorOption, editorOptionsRegistry, type ConfigurationChangedEvent, type FindComputedEditorOptionValueById, type IComputedEditorOptions, type IEditorOptions } from '../../common/config/editorOptions.js';
import { FontInfo } from '../../common/config/fontInfo.js';
import { CursorConfiguration, CursorState, type EditOperationResult, type EditOperationType } from '../../common/cursorCommon.js';
import { CursorsController } from '../../common/cursor/cursor.js';
import { type DeleteWordContext } from '../../common/cursor/cursorWordOperations.js';
import { CursorChangeReason } from '../../common/cursorEvents.js';
import { IdentityCoordinatesConverter } from '../../common/coordinatesConverter.js';
import { type Selection } from '../../common/core/selection.js';
import { getMapForWordSeparators } from '../../common/core/wordCharacterClassifier.js';
import { type Range } from '../../common/core/range.js';
import { createTestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { type ILanguageConfigurationService } from '../../common/languages/languageConfigurationRegistry.js';
import { type TextModel } from '../../common/model/textModel.js';
import { ViewModelEventsCollector } from '../../common/viewModelEventDispatcher.js';
import { type ICommand } from '../../common/editorCommon.js';

export interface TestCursorsControllerOptions extends IEditorOptions {
	readonly selectionHistoryLimit?: number;
	readonly cursorHistoryLimit?: number;
}

export function createTestCursorsController(
	model: TextModel,
	selections: readonly Selection[],
	options: TestCursorsControllerOptions = {},
	languageConfigurationService?: ILanguageConfigurationService,
): CursorsController {
	const ownedLanguageConfigurationService = languageConfigurationService ? undefined : createTestLanguageConfigurationService();
	const configurations = languageConfigurationService ?? ownedLanguageConfigurationService!;
	const cursorConfig = createTestCursorConfiguration(model, configurations, options);
	const controller = new TestCursorsController(
		model,
		new IdentityCoordinatesConverter(model),
		cursorConfig,
		ownedLanguageConfigurationService,
		options,
	);
	setTestCursorSelections(controller, selections);
	return controller;
}

export function setTestCursorSelections(controller: CursorsController, selections: readonly Selection[], reason = CursorChangeReason.NotSet): ViewModelEventsCollector {
	const eventsCollector = new ViewModelEventsCollector();
	controller.setStates(eventsCollector, 'test', reason, CursorState.fromModelSelections(selections));
	return eventsCollector;
}

export function executeTestEditOperation(controller: CursorsController, operation: EditOperationResult): void {
	if (operation.shouldPushStackElementBefore) controller.pushUndoStop();
	controller.executeCommands(operation.commands, 'test');
	controller.setPrevEditOperationType(operation.type);
	if (operation.shouldPushStackElementAfter) controller.pushUndoStop();
}

export function executeTestDeleteOperation(controller: CursorsController, operation: readonly [boolean, Array<ICommand | null>], type: EditOperationType): void {
	if (operation[0]) controller.pushUndoStop();
	controller.executeCommands(operation[1], 'test');
	controller.setPrevEditOperationType(type);
}

export function createTestDeleteWordContext(config: CursorConfiguration, model: TextModel, selection: Selection, autoClosedCharacters: Range[] = []): DeleteWordContext {
	return {
		wordSeparators: getMapForWordSeparators(config.wordSeparators, config.wordSegmenterLocales),
		model,
		selection,
		whitespaceHeuristics: true,
		autoClosingDelete: config.autoClosingDelete,
		autoClosingBrackets: config.autoClosingBrackets,
		autoClosingQuotes: config.autoClosingQuotes,
		autoClosingPairs: config.autoClosingPairs,
		autoClosedCharacters,
	};
}

class TestCursorsController extends CursorsController {
	constructor(
		model: TextModel,
		coordinatesConverter: IdentityCoordinatesConverter,
		cursorConfig: CursorConfiguration,
		private readonly languageConfigurationService: ReturnType<typeof createTestLanguageConfigurationService> | undefined,
		options: TestCursorsControllerOptions,
	) {
		super(model, model, coordinatesConverter, cursorConfig, options);
	}

	public override dispose(): void {
		super.dispose();
		this.languageConfigurationService?.dispose();
	}
}

export function createTestCursorConfiguration(model: TextModel, languageConfigurationService: ILanguageConfigurationService, rawOptions: IEditorOptions = {}): CursorConfiguration {
	const fontInfo = new FontInfo({
		pixelRatio: 1,
		fontFamily: 'monospace',
		fontWeight: 'normal',
		fontSize: 10,
		fontFeatureSettings: 'none',
		fontVariationSettings: 'normal',
		lineHeight: 20,
		letterSpacing: 0,
		isMonospace: true,
		typicalHalfwidthCharacterWidth: 10,
		typicalFullwidthCharacterWidth: 20,
		canUseHalfwidthRightwardsArrow: true,
		spaceWidth: 10,
		middotWidth: 10,
		wsmiddotWidth: 10,
		maxDigitWidth: 10,
	}, true);
	const options: IComputedEditorOptions = {
		get<T extends EditorOption>(id: T): FindComputedEditorOptionValueById<T> {
			if (id === EditorOption.fontInfo) return fontInfo as unknown as FindComputedEditorOptionValueById<T>;
			if (id === EditorOption.layoutInfo) return { height: 200 } as unknown as FindComputedEditorOptionValueById<T>;
			const option = editorOptionsRegistry[id];
			if (!option) throw new ReferenceError(`Missing editor option ${id}`);
			return option.validate((rawOptions as Record<string, unknown>)[option.name]) as FindComputedEditorOptionValueById<T>;
		},
	};
	const configuration: IEditorConfiguration = {
		isSimpleWidget: false,
		contextMenuId: MenuId.EditorContext,
		options,
		onDidChangeFast: Event.None as Event<ConfigurationChangedEvent>,
		onDidChange: Event.None as Event<ConfigurationChangedEvent>,
		getRawOptions: () => ({ ...rawOptions }),
		updateOptions: () => {},
		observeContainer: () => {},
		setIsDominatedByLongLines: () => {},
		setModelLineCount: () => {},
		setViewLineCount: () => {},
		setReservedHeight: () => {},
		setGlyphMarginDecorationLaneCount: () => {},
		dispose: Disposable.None.dispose,
		[Symbol.dispose]: Disposable.None[Symbol.dispose],
	};
	return new CursorConfiguration(model.getLanguageId(), model.getOptions(), configuration, languageConfigurationService);
}
