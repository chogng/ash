import assert from 'node:assert/strict';
import { test } from 'mocha';
import { AccessibilitySupport } from '../../../platform/accessibility/common/accessibility.js';
import { isMacintosh } from '../../../base/common/platform.js';
import { Extensions as ConfigurationExtensions, type IConfigurationRegistry } from '../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../platform/registry/common/platform.js';
import {
	EditorFontLigatures,
	EditorFontVariations,
	EditorLayoutInfoComputer,
	EditorOption,
	EditorOptions,
	EditorLineWrapping,
	RenderLineNumbersType,
	TextEditorCursorStyle,
	WrappingIndent,
	editorOptionsRegistry,
} from '../../common/config/editorOptions.js';
import { EditorZoom } from '../../common/config/editorZoom.js';
import { createBareFontInfoFromRawSettings } from '../../common/config/fontInfoFromSettings.js';
import { EDITOR_FONT_DEFAULTS } from '../../common/config/fontInfo.js';
import { diffEditorDefaultOptions, resolveDiffEditorOptions } from '../../common/config/diffEditor.js';
import { editorConfiguration, isDiffEditorConfigurationKey, isEditorConfigurationKey } from '../../common/config/editorConfigurationSchema.js';
import { CodeEditorConfiguration } from '../../../workbench/contrib/codeEditor/common/editorConfiguration.js';

const configurationRegistry = Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration);

test('common editor options normalize shared editor settings', () => {
	assert.equal(EditorOptions.fontFamily.validate(undefined), EDITOR_FONT_DEFAULTS.fontFamily);
	assert.equal(EditorOptions.fontSize.validate(5), 6);
	assert.equal(EditorOptions.fontSize.validate(101), 100);
	assert.equal(EditorOptions.fontLigatures.validate(true), EditorFontLigatures.ON);
	assert.equal(EditorOptions.fontVariations.validate(true), EditorFontVariations.TRANSLATE);
	assert.equal(EditorOptions.wordWrap.validate('on'), EditorLineWrapping.On);
	assert.equal(EditorOptions.wordWrap.validate('bounded'), 'bounded');
	assert.ok(Object.isFrozen(EditorOptions.minimap.validate({ enabled: false })));
	assert.equal(editorOptionsRegistry.length, EditorOption.doubleClickSelectsBlock + 1);
});

test('common editor options preserve VS Code internal enum and nested option contracts', () => {
	assert.equal(EditorOptions.accessibilitySupport.validate('auto'), AccessibilitySupport.Unknown);
	assert.equal(EditorOptions.accessibilitySupport.validate('on'), AccessibilitySupport.Enabled);
	assert.equal(EditorOptions.cursorStyle.validate('block'), TextEditorCursorStyle.Block);
	assert.equal(EditorOptions.cursorStyle.validate('not-a-cursor-style'), TextEditorCursorStyle.Line);
	assert.equal(EditorOptions.overtypeCursorStyle.validate(undefined), TextEditorCursorStyle.Block);
	assert.equal(EditorOptions.overtypeCursorStyle.validate('not-a-cursor-style'), TextEditorCursorStyle.Block);
	assert.equal(EditorOptions.mouseStyle.validate(undefined), 'text');
	assert.equal(EditorOptions.mouseStyle.validate('not-a-mouse-style'), 'text');
	assert.equal(EditorOptions.lineNumbers.validate('relative').renderType, RenderLineNumbersType.Relative);
	assert.equal(EditorOptions.wrappingIndent.validate('deepIndent'), WrappingIndent.DeepIndent);

	const inlineSuggest = EditorOptions.inlineSuggest.validate({
		mode: 'prefix',
		edits: { showCollapsed: true },
	});
	assert.equal(inlineSuggest.mode, 'prefix');
	assert.equal(inlineSuggest.edits.showCollapsed, true);
	assert.equal(inlineSuggest.edits.showLongDistanceHint, true);
	assert.equal(inlineSuggest.experimental.emptyResponseInformation, true);

	const unicodeHighlight = EditorOptions.unicodeHighlighting.validate({
		includeStrings: false,
		allowedLocales: { 'zh-CN': true, en: false },
	});
	assert.equal(unicodeHighlight.includeStrings, false);
	assert.equal(unicodeHighlight.allowedLocales['zh-CN'], true);
	assert.equal(unicodeHighlight.allowedLocales.en, undefined);

	const quickSuggestions = EditorOptions.quickSuggestions.validate(false);
	assert.deepEqual(quickSuggestions, { other: 'off', comments: 'off', strings: 'off' });
	const suggest = EditorOptions.suggest.validate({ showMethods: false });
	assert.equal(suggest.showMethods, false);
	assert.equal(suggest.showFunctions, true);
});

test('common layout option follows the VS Code minimap and wrapping geometry contract', () => {
	const defaults = new Map(editorOptionsRegistry.map(option => [option.id, option.defaultValue]));
	const options = {
		get<T extends EditorOption>(id: T) {
			return defaults.get(id) as never;
		},
	};
	const layout = EditorLayoutInfoComputer.computeLayout(options, {
		memory: null,
		outerWidth: 800,
		outerHeight: 600,
		isDominatedByLongLines: false,
		lineHeight: 20,
		viewLineCount: 100,
		lineNumbersDigitCount: 3,
		typicalHalfwidthCharacterWidth: 8,
		maxDigitWidth: 8,
		pixelRatio: 1,
		glyphMarginDecorationLaneCount: 1,
	});

	assert.equal(layout.width, 800);
	assert.equal(layout.height, 600);
	assert.equal(layout.isViewportWrapping, false);
	assert.equal(layout.wrappingColumn, -1);
	assert.ok(layout.viewportColumn > 0);
	assert.equal(layout.minimap.renderMinimap > 0, true);
});

test('common font settings produce a zoom-aware bare font descriptor', () => {
	const previousZoomLevel = EditorZoom.getZoomLevel();
	const subscription = EditorZoom.onDidChangeZoomLevel(() => undefined);
	try {
		EditorZoom.setZoomLevel(2);
		const fontInfo = createBareFontInfoFromRawSettings({
			fontFamily: 'Stanza Mono',
			fontWeight: 700,
			fontSize: 14,
			fontLigatures: true,
			fontVariations: true,
			lineHeight: 0,
			letterSpacing: 1,
		}, 2);

		assert.equal(fontInfo.fontSize, 16.8);
		assert.equal(fontInfo.lineHeight, isMacintosh ? 25 : 23);
		assert.equal(fontInfo.fontWeight, 'normal');
		assert.equal(fontInfo.fontVariationSettings, "'wght' 700");
		assert.equal(fontInfo.fontFeatureSettings, '"liga" on, "calt" on');
		assert.match(fontInfo.getMassagedFontFamily(), /^"Stanza Mono"/u);
	} finally {
		EditorZoom.setZoomLevel(previousZoomLevel);
		subscription.dispose();
	}
});

test('editor zoom clamps levels and emits only effective changes', () => {
	const previousZoomLevel = EditorZoom.getZoomLevel();
	const changes: number[] = [];
	const subscription = EditorZoom.onDidChangeZoomLevel(level => changes.push(level));
	try {
		EditorZoom.setZoomLevel(100);
		EditorZoom.setZoomLevel(100);
		EditorZoom.setZoomLevel(-100);
		assert.deepEqual(changes, [20, -5]);
		assert.throws(() => EditorZoom.setZoomLevel(Number.NaN), TypeError);
	} finally {
		EditorZoom.setZoomLevel(previousZoomLevel);
		subscription.dispose();
	}
});

test('diff editor options merge nested defaults and validate limits', () => {
	const options = resolveDiffEditorOptions({
		splitViewDefaultRatio: 0.75,
		experimental: { showMoves: true },
		hideUnchangedRegions: { enabled: true },
	});

	assert.equal(options.splitViewDefaultRatio, 0.75);
	assert.equal(options.experimental.showMoves, true);
	assert.equal(options.experimental.showEmptyDecorations, diffEditorDefaultOptions.experimental.showEmptyDecorations);
	assert.equal(options.hideUnchangedRegions.enabled, true);
	assert.equal(options.hideUnchangedRegions.contextLineCount, diffEditorDefaultOptions.hideUnchangedRegions.contextLineCount);
	assert.ok(Object.isFrozen(options));
	assert.ok(Object.isFrozen(options.experimental));
	assert.throws(() => resolveDiffEditorOptions({ splitViewDefaultRatio: 2 }), RangeError);
});

test('editor settings are registered by the common configuration owner', () => {
	assert.equal(configurationRegistry.getConfiguration(CodeEditorConfiguration.fontSize)?.defaultValue, 13);
	assert.equal(configurationRegistry.getConfiguration(CodeEditorConfiguration.wordWrap)?.defaultValue, EditorLineWrapping.Off);
	assert.equal(configurationRegistry.getConfiguration(CodeEditorConfiguration.colorDecorators)?.defaultValue, true);
	assert.equal(configurationRegistry.getConfiguration(CodeEditorConfiguration.colorDecoratorsActivatedOn)?.defaultValue, 'clickAndHover');
	assert.equal(configurationRegistry.getConfiguration(CodeEditorConfiguration.colorDecoratorsLimit)?.defaultValue, 500);
	assert.equal(configurationRegistry.getConfiguration(CodeEditorConfiguration.defaultColorDecorators)?.defaultValue, 'auto');
	assert.equal(configurationRegistry.getConfiguration('editor.fontSize')?.key, CodeEditorConfiguration.fontSize);
	assert.equal(configurationRegistry.getConfiguration('editor.colorDecorators')?.key, CodeEditorConfiguration.colorDecorators);
	assert.equal(configurationRegistry.getConfiguration('diffEditor.showInlineChanges')?.key, CodeEditorConfiguration.diffShowInlineChanges);
	assert.equal(editorConfiguration.properties['editor.tabSize']?.default, 4);
	assert.equal(isEditorConfigurationKey('tabSize'), true);
	assert.equal(isEditorConfigurationKey('notAnEditorSetting'), false);
	assert.equal(isDiffEditorConfigurationKey('diffAlgorithm'), true);
	assert.equal(isDiffEditorConfigurationKey('notADiffSetting'), false);
});
