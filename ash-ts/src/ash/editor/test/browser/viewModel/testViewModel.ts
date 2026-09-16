import { scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { darkColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { type EditorViewportOptions, View } from '../../../browser/view.js';
import { EditorLineWrapping, editorOptionsRegistry, type IEditorOptions, WrappingIndent } from '../../../common/config/editorOptions.js';
import { type CursorsController } from '../../../common/cursor/cursor.js';
import { CursorState } from '../../../common/cursorCommon.js';
import { CursorChangeReason } from '../../../common/cursorEvents.js';
import { type TextModel } from '../../../common/model/textModel.js';
import { MonospaceLineBreaksComputerFactory } from '../../../common/viewModel/monospaceLineBreaksComputer.js';
import { getViewModelCursorController, ViewModel } from '../../../common/viewModel/viewModelImpl.js';
import { TestLanguageConfigurationService } from '../../common/modes/testLanguageConfigurationService.js';
import { createTestConfiguration } from '../config/testConfiguration.js';

export type TestViewOptions = Omit<EditorViewportOptions, 'configuration' | 'theme' | 'viewModel' | 'padding'> & Omit<IEditorOptions, 'padding' | 'wrappingIndent'> & {
	readonly lineWrapping?: EditorLineWrapping;
	readonly wrappingIndent?: WrappingIndent;
	readonly cursorOptions?: IEditorOptions;
	readonly padding?: { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number };
	readonly model: TextModel;
	readonly selectionController?: CursorsController;
};

/** Builds the same configuration-model-view chain used by an editor widget. */
export class TestView extends View {
	private readonly setupStore: DisposableStore;
	readonly testConfiguration: ReturnType<typeof createTestConfiguration>;
	readonly testViewModel: ViewModel;
	readonly testSelectionController: CursorsController;

	constructor(options: TestViewOptions) {
		const setup = createViewModel(options);
		const { model: _model, selectionController: _selectionController, ...viewOptions } = options;
		super({
			...viewOptions,
			configuration: setup.configuration,
			theme: setup.theme,
			viewModel: setup.viewModel,
		});
		this.setupStore = setup.store;
		this.testConfiguration = setup.configuration;
		this.testViewModel = setup.viewModel;
		this.testSelectionController = setup.viewModelSelectionController;
	}

	protected override disposeCore(): void {
		try {
			super.disposeCore();
		} finally {
			this.setupStore.dispose();
		}
	}
}

function createViewModel(options: TestViewOptions): {
	readonly configuration: ReturnType<typeof createTestConfiguration>;
	readonly theme: ReturnType<TestThemeService['getColorTheme']>;
	readonly viewModel: ViewModel;
	readonly viewModelSelectionController: CursorsController;
	readonly store: DisposableStore;
} {
	const ownerWindow = options.container.ownerDocument.defaultView;
	if (!ownerWindow) throw new ReferenceError('Test editor requires a browser window');
	const store = new DisposableStore();
	const editorOptions: IEditorOptions = {
		...Object.fromEntries(editorOptionsRegistry.map(option => [option.name, options[option.name as keyof TestViewOptions]])),
		...options.cursorOptions,
		ariaLabel: options.ariaLabel,
		automaticLayout: options.automaticLayout,
		fontFamily: options.fontFamily,
		fontSize: options.fontSize,
		fontLigatures: options.fontLigatures,
		lineHeight: options.lineHeight,
		lineNumbers: options.lineNumbers ?? (options.presentation === 'embedded' ? 'off' : undefined),
		lineNumbersMinChars: 1,
		glyphMargin: options.glyphMargin,
		guides: {
			...options.guides,
			indentation: options.guides?.indentation ?? options.presentation !== 'embedded',
		},
		minimap: { ...options.minimap, enabled: options.minimap?.enabled ?? options.presentation !== 'embedded' },
		renderWhitespace: options.renderWhitespace,
		padding: options.padding ? { top: options.padding.top, bottom: options.padding.bottom } : undefined,
		wordWrap: options.lineWrapping === EditorLineWrapping.On ? 'on' : 'off',
		wrappingIndent: testWrappingIndent(options.wrappingIndent),
	};
	const configuration = store.add(createTestConfiguration(options.container, editorOptions));
	configuration.setModelLineCount(options.model.lineCount);
	const languageConfigurationService = store.add(new TestLanguageConfigurationService());
	const themeService = store.add(new TestThemeService(darkColorTheme));
	const attachedView = options.model.onBeforeAttached();
	store.add(toDisposable(() => options.model.onBeforeDetached(attachedView)));
	const lineBreaksComputerFactory = MonospaceLineBreaksComputerFactory.create(configuration.options);
	const viewModel = store.add(new ViewModel(
		1,
		configuration,
		options.model,
		lineBreaksComputerFactory,
		lineBreaksComputerFactory,
		callback => scheduleAtNextAnimationFrame(ownerWindow, callback),
		languageConfigurationService,
		themeService,
		attachedView,
		{ batchChanges: callback => callback() },
	));
	if (options.selectionController) {
		const synchronizeSelections = (): void => {
			viewModel.setCursorStates(
				'test',
				CursorChangeReason.Explicit,
				CursorState.fromModelSelections(options.selectionController!.getSelections()),
			);
		};
		synchronizeSelections();
		store.add(options.selectionController.onDidChange(synchronizeSelections));
	}
	const viewModelSelectionController = getViewModelCursorController(viewModel);
	return {
		configuration,
		theme: themeService.getColorTheme(),
		viewModel,
		viewModelSelectionController,
		store,
	};
}

function testWrappingIndent(value: WrappingIndent | undefined): IEditorOptions['wrappingIndent'] {
	switch (value) {
		case WrappingIndent.None: return 'none';
		case WrappingIndent.Same: return 'same';
		case WrappingIndent.Indent: return 'indent';
		case WrappingIndent.DeepIndent: return 'deepIndent';
		default: return undefined;
	}
}
