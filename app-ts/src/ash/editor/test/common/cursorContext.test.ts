import assert from 'node:assert/strict';
import { test } from 'mocha';
import { type Event } from '../../../base/common/event.js';
import { toDisposable } from '../../../base/common/lifecycle.js';
import { MenuId } from '../../../platform/actions/common/actions.js';
import { type IEditorConfiguration } from '../../common/config/editorConfiguration.js';
import { EditorOption, EditorOptions, type ConfigurationChangedEvent, type FindComputedEditorOptionValueById, type IComputedEditorOptions, type IEditorOptions } from '../../common/config/editorOptions.js';
import { FontInfo } from '../../common/config/fontInfo.js';
import { IdentityCoordinatesConverter } from '../../common/coordinatesConverter.js';
import { CursorConfiguration } from '../../common/cursorCommon.js';
import { CursorContext } from '../../common/cursor/cursorContext.js';
import { TestLanguageConfigurationService } from './modes/testLanguageConfigurationService.js';
import { TextModel } from '../../common/model/textModel.js';

test('CursorContext keeps the model, view model, coordinates, and cursor configuration identities', () => {
	using model = new TextModel('value', { languageId: 'plaintext' });
	using languageConfigurationService = new TestLanguageConfigurationService();
	const editorConfiguration = createEditorConfiguration();
	const cursorConfig = new CursorConfiguration(model.getLanguageId(), model.getOptions(), editorConfiguration, languageConfigurationService);
	const coordinatesConverter = new IdentityCoordinatesConverter(model);
	const context = new CursorContext(model, model, coordinatesConverter, cursorConfig);

	assert.equal(context.model, model);
	assert.equal(context.viewModel, model);
	assert.equal(context.coordinatesConverter, coordinatesConverter);
	assert.equal(context.cursorConfig, cursorConfig);
	assert.equal(context.cursorConfig.tabSize, model.getOptions().tabSize);
	assert.equal(context.cursorConfig.readOnly, false);
});

function createEditorConfiguration(): IEditorConfiguration {
	const fontInfo = new FontInfo({
		pixelRatio: 1,
		fontFamily: 'monospace',
		fontWeight: 'normal',
		fontSize: 14,
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
			const option = Object.values(EditorOptions).find(candidate => typeof candidate === 'object' && candidate !== null && 'id' in candidate && candidate.id === id);
			if (!option) throw new ReferenceError(`Missing editor option ${id}`);
			return option.validate(undefined) as FindComputedEditorOptionValueById<T>;
		},
	};
	const noChange: Event<ConfigurationChangedEvent> = () => toDisposable(() => {});
	return {
		isSimpleWidget: false,
		contextMenuId: MenuId.EditorContext,
		options,
		onDidChangeFast: noChange,
		onDidChange: noChange,
		getRawOptions: (): IEditorOptions => ({}),
		updateOptions: () => {},
		observeContainer: () => {},
		setIsDominatedByLongLines: () => {},
		setModelLineCount: () => {},
		setViewLineCount: () => {},
		setReservedHeight: () => {},
		setGlyphMarginDecorationLaneCount: () => {},
		dispose: () => {},
		[Symbol.dispose]: () => {},
	};
}
