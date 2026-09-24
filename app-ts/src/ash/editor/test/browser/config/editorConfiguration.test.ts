import { h } from '../../../../base/browser/dom.js';
import assert from 'node:assert/strict';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { createFastDomNode } from '../../../../base/browser/fastDomNode.js';
import { CharWidthRequest, CharWidthRequestType } from '../../../browser/config/charWidthReader.js';
import { applyFontInfo } from '../../../browser/config/domFontInfo.js';
import { ComputedEditorOptions, EditorConfiguration } from '../../../browser/config/editorConfiguration.js';
import { FontMeasurements } from '../../../browser/config/fontMeasurements.js';
import { migrateOptions } from '../../../browser/config/migrateOptions.js';
import { TabFocus } from '../../../browser/config/tabFocus.js';
import { EditorOption, type IEditorOptions } from '../../../common/config/editorOptions.js';
import { type BareFontInfo, FontInfo } from '../../../common/config/fontInfo.js';
import { createBareFontInfoFromRawSettings } from '../../../common/config/fontInfoFromSettings.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { createConfigurationServices, createTestConfiguration, TEST_FONT_INFO } from './testConfiguration.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { AccessibilitySupport, IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ServiceContainer } from '../../../../platform/instantiation/common/instantiation.js';
import { installEditorTestGlobals } from '../editorTestGlobals.js';

test('ComputedEditorOptions stores canonical option IDs', () => {
	const options = new ComputedEditorOptions();
	options._write(EditorOption.fontSize, 18);
	assert.equal(options.get(EditorOption.fontSize), 18);
	assert.throws(() => options.get(EditorOption.lineHeight), /has not been computed/);
});

test('applyFontInfo writes the complete normalized font contract to both DOM owners', () => {
	const dom = new JSDOM('<div></div><span></span>');
	const element = dom.window.document.querySelector<HTMLElement>('div')!;
	const fastNode = createFastDomNode(dom.window.document.querySelector<HTMLElement>('span')!);
	const expectedFontFamily = h(dom.window.document, 'div');
	expectedFontFamily.style.fontFamily = TEST_FONT_INFO.getMassagedFontFamily();
	applyFontInfo(element, TEST_FONT_INFO);
	applyFontInfo(fastNode, TEST_FONT_INFO);

	for (const target of [element, fastNode.domNode]) {
		assert.deepEqual({
			fontFamily: target.style.fontFamily,
			fontWeight: target.style.fontWeight,
			fontSize: target.style.fontSize,
			fontFeatureSettings: target.style.fontFeatureSettings,
			fontVariationSettings: target.style.fontVariationSettings,
			lineHeight: target.style.lineHeight,
			letterSpacing: target.style.letterSpacing,
		}, {
			fontFamily: expectedFontFamily.style.fontFamily,
			fontWeight: TEST_FONT_INFO.fontWeight,
			fontSize: `${TEST_FONT_INFO.fontSize}px`,
			fontFeatureSettings: TEST_FONT_INFO.fontFeatureSettings,
			fontVariationSettings: TEST_FONT_INFO.fontVariationSettings,
			lineHeight: `${TEST_FONT_INFO.lineHeight}px`,
			letterSpacing: `${TEST_FONT_INFO.letterSpacing}px`,
		});
	}
	dom.window.close();
});

test('FontMeasurements caches one window/font result and evicts unreliable readings on clear', () => {
	const request = new CharWidthRequest('n', CharWidthRequestType.Bold);
	request.fulfill(9);
	assert.deepEqual({ chr: request.chr, type: request.type, width: request.width }, {
		chr: 'n', type: CharWidthRequestType.Bold, width: 9,
	});

	const dom = new JSDOM('<div></div>');
	const targetWindow = dom.window as unknown as Window;
	const font = createBareFontInfoFromRawSettings({ fontFamily: 'Test Mono', fontSize: 14, lineHeight: 20 }, 1, true);
	FontMeasurements.clearAllFontInfos();
	let changes = 0;
	using listener = FontMeasurements.onDidChange(() => changes += 1);
	try {
		const first = FontMeasurements.readFontInfo(targetWindow, font);
		const second = FontMeasurements.readFontInfo(targetWindow, font);
		assert.strictEqual(second, first);
		assert.equal(first.typicalHalfwidthCharacterWidth >= 5, true);
		assert.equal(first.isTrusted, false);
		assert.deepEqual(FontMeasurements.serializeFontInfo(targetWindow), []);
	} finally {
		FontMeasurements.clearAllFontInfos();
		dom.window.close();
	}
	assert.equal(changes, 1);
});

test('EditorConfiguration validates updates and reports the changed option', () => {
	const dom = new JSDOM('<div id="editor"></div>');
	const container = dom.window.document.querySelector<HTMLElement>('#editor')!;
	using configuration = createTestConfiguration(container, { fontSize: 14 });
	let changed = false;
	configuration.onDidChange(event => changed = event.hasChanged(EditorOption.fontSize));
	configuration.updateOptions({ fontSize: 18 });
	assert.equal(configuration.options.get(EditorOption.fontSize), 18);
	assert.equal(changed, true);
	dom.window.close();
});

test('EditorConfiguration requires the registered accessibility service at construction', () => {
	const dom = new JSDOM('<div></div>');
	using services = new ServiceContainer();
	try {
		assert.throws(() => services.createInstance(EditorConfiguration, false, MenuId.EditorContext, {}, dom.window.document.body), /accessibilityService/);
	} finally {
		dom.window.close();
	}
});

test('EditorConfiguration follows host accessibility and gives explicit editor settings precedence', () => {
	const dom = new JSDOM('<div></div>');
	using resources = new DisposableStore();
	const services = createConfigurationServices(resources, dom.window.document.body);
	const accessibility = services.get(IAccessibilityService);
	const configuration = services.createInstance(EditorConfiguration, false, MenuId.EditorContext, { wrappingIndent: 'indent' }, dom.window.document.body);
	const notifications: string[] = [];
	using fast = configuration.onDidChangeFast(event => {
		if (event.hasChanged(EditorOption.accessibilitySupport)) notifications.push('fast');
	});
	using normal = configuration.onDidChange(event => {
		if (event.hasChanged(EditorOption.accessibilitySupport)) notifications.push('normal');
	});
	try {
		accessibility.setAccessibilitySupport(AccessibilitySupport.Enabled);
		assert.deepEqual({
			support: configuration.options.get(EditorOption.accessibilitySupport),
			indent: configuration.options.get(EditorOption.wrappingIndent),
			notifications,
		}, { support: AccessibilitySupport.Enabled, indent: 0, notifications: ['fast', 'normal'] });
		configuration.updateOptions({ accessibilitySupport: 'off' });
		assert.equal(configuration.options.get(EditorOption.accessibilitySupport), AccessibilitySupport.Disabled);
		assert.equal(configuration.options.get(EditorOption.wrappingIndent), 2);
		configuration.updateOptions({ accessibilitySupport: 'auto' });
		assert.equal(configuration.options.get(EditorOption.accessibilitySupport), AccessibilitySupport.Enabled);
		accessibility.setAccessibilitySupport(AccessibilitySupport.Disabled);
		assert.equal(configuration.options.get(EditorOption.accessibilitySupport), AccessibilitySupport.Disabled);
		configuration.updateOptions({ accessibilitySupport: 'on' });
		assert.equal(configuration.options.get(EditorOption.accessibilitySupport), AccessibilitySupport.Enabled);
		const count = notifications.length;
		configuration.dispose();
		accessibility.setAccessibilitySupport(AccessibilitySupport.Enabled);
		assert.equal(notifications.length, count);
	} finally {
		configuration.dispose();
		dom.window.close();
	}
});

test('EditorConfiguration owns the rich screen-reader content option', () => {
	const dom = new JSDOM('<div id="editor"></div>');
	const container = dom.window.document.querySelector<HTMLElement>('#editor')!;
	using configuration = createTestConfiguration(container);
	assert.equal(configuration.options.get(EditorOption.renderRichScreenReaderContent), false);
	let changed = false;
	configuration.onDidChange(event => changed = event.hasChanged(EditorOption.renderRichScreenReaderContent));

	configuration.updateOptions({ renderRichScreenReaderContent: true });

	assert.equal(configuration.options.get(EditorOption.renderRichScreenReaderContent), true);
	assert.equal(changed, true);
	dom.window.close();
});

test('EditorConfiguration computes and updates the overview-ruler cursor visibility option', () => {
	const dom = new JSDOM('<div id="editor"></div>');
	const container = dom.window.document.querySelector<HTMLElement>('#editor')!;
	using configuration = createTestConfiguration(container);
	assert.equal(configuration.options.get(EditorOption.hideCursorInOverviewRuler), false);
	let changed = false;
	configuration.onDidChange(event => changed = event.hasChanged(EditorOption.hideCursorInOverviewRuler));

	configuration.updateOptions({ hideCursorInOverviewRuler: true });

	assert.equal(configuration.options.get(EditorOption.hideCursorInOverviewRuler), true);
	assert.equal(changed, true);
	dom.window.close();
});

test('EditorConfiguration recomputes measured font options when the cache changes', () => {
	let width = 8;
	class MeasuredConfiguration extends EditorConfiguration {
		protected override _readFontInfo(font: BareFontInfo): FontInfo {
			return measuredFont(font, width);
		}
	}
	const dom = new JSDOM('<div id="editor"></div>');
	const container = dom.window.document.querySelector<HTMLElement>('#editor')!;
	using resources = new DisposableStore();
	const services = createConfigurationServices(resources, container);
	using configuration = services.createInstance(MeasuredConfiguration, false, MenuId.EditorContext, { fontSize: 14 }, container);
	let changed = false;
	configuration.onDidChange(event => changed ||= event.hasChanged(EditorOption.fontInfo));
	width = 10;
	FontMeasurements.clearAllFontInfos();
	assert.equal(configuration.options.get(EditorOption.fontInfo).spaceWidth, 10);
	assert.equal(changed, true);
	dom.window.close();
});

test('EditorConfiguration owns automatic container observation and stops it with the option', () => {
	const observers: TestResizeObserver[] = [];
	class TestResizeObserver implements ResizeObserver {
		private target: Element | undefined;
		disconnected = false;

		constructor(private readonly callback: ResizeObserverCallback) {
			observers.push(this);
		}

		observe(target: Element): void { this.target = target; }
		unobserve(): void {}
		disconnect(): void { this.disconnected = true; }
		takeRecords(): ResizeObserverEntry[] { return []; }

		emit(width: number, height: number): void {
			assert.ok(this.target);
			this.callback([{ contentRect: { width, height } } as ResizeObserverEntry], this);
		}
	}

	using installedObserver = installEditorTestGlobals({ ResizeObserver: TestResizeObserver });
	const dom = new JSDOM('<div id="editor"></div>');
	const container = dom.window.document.querySelector<HTMLElement>('#editor')!;
	const configuration = createTestConfiguration(container, { automaticLayout: true });
	try {
		const observer = observers[0]!;
		observer.emit(240, 120);
		assert.deepEqual({
			width: configuration.options.get(EditorOption.layoutInfo).width,
			height: configuration.options.get(EditorOption.layoutInfo).height,
		}, { width: 240, height: 120 });

		configuration.updateOptions({ automaticLayout: false });
		assert.equal(observer.disconnected, true);
		observer.emit(300, 180);
		assert.equal(configuration.options.get(EditorOption.layoutInfo).width, 240);

		configuration.updateOptions({ automaticLayout: true });
		using restart = configuration.onDidChange(event => {
			if (event.hasChanged(EditorOption.layoutInfo) && configuration.options.get(EditorOption.layoutInfo).width === 320) {
				configuration.updateOptions({ automaticLayout: false });
				configuration.updateOptions({ automaticLayout: true });
			}
		});
		observers[1]!.emit(320, 180);
		assert.equal(observers[1]!.disconnected, true);
		observers[2]!.emit(340, 180);
		assert.equal(configuration.options.get(EditorOption.layoutInfo).width, 340);
	} finally {
		configuration.dispose();
		dom.window.close();
	}
});

test('TabFocus updates computed editor configuration and reports every global assignment', () => {
	TabFocus.setTabFocusMode(false);
	const assignments: boolean[] = [];
	using listener = TabFocus.onDidChangeTabFocus(value => assignments.push(value));
	const dom = new JSDOM('<div id="editor"></div>');
	const container = dom.window.document.querySelector<HTMLElement>('#editor')!;
	using configuration = createTestConfiguration(container);
	let configurationChanges = 0;
	configuration.onDidChange(event => {
		if (event.hasChanged(EditorOption.tabFocusMode)) configurationChanges += 1;
	});

	try {
		TabFocus.setTabFocusMode(true);
		TabFocus.setTabFocusMode(true);
		assert.deepEqual({
			assignments,
			tabFocusMode: configuration.options.get(EditorOption.tabFocusMode),
			configurationChanges,
		}, {
			assignments: [true, true],
			tabFocusMode: true,
			configurationChanges: 1,
		});
	} finally {
		TabFocus.setTabFocusMode(false);
		dom.window.close();
	}
});

test('migrateOptions upgrades nested legacy settings through their current owners', () => {
	const options = migrate({
		wordBasedSuggestions: true,
		hover: true,
		suggest: {
			filteredTypes: { method: false, function: true, variable: false },
			showMethods: true,
		},
		experimental: { stickyScroll: { enabled: true, maxLineCount: 7 } },
		stickyScroll: { enabled: false },
		editor: { experimentalEditContextEnabled: true },
		codeActionsOnSave: { 'source.fixAll': true, 'source.organizeImports': false, keep: 'always' },
		codeActionWidget: { includeNearbyQuickfixes: true },
		lightbulb: { enabled: false },
		inlineSuggest: { edits: { codeShifting: true } },
	});

	assert.deepEqual(options, {
		wordBasedSuggestions: 'matchingDocuments',
		hover: { enabled: 'on' },
		suggest: {
			filteredTypes: undefined,
			showMethods: true,
			showVariables: false,
		},
		experimental: { stickyScroll: { enabled: undefined, maxLineCount: undefined } },
		stickyScroll: { enabled: false, maxLineCount: 7 },
		editor: { experimentalEditContextEnabled: undefined, editContext: true },
		codeActionsOnSave: { 'source.fixAll': 'explicit', 'source.organizeImports': 'never', keep: 'always' },
		codeActionWidget: { includeNearbyQuickfixes: undefined, includeNearbyQuickFixes: true },
		lightbulb: { enabled: 'off' },
		inlineSuggest: { edits: { codeShifting: undefined, allowCodeShifting: 'always' } },
	});
});

test('migrateOptions removes obsolete keys without overwriting current settings', () => {
	const options = migrate({
		renderIndentGuides: true,
		highlightActiveIndentGuide: true,
		guides: { indentation: false, highlightActiveIndentation: false },
		experimental: { stickyScroll: { enabled: true } },
		stickyScroll: { enabled: false },
		codeActionWidget: { includeNearbyQuickfixes: false, includeNearbyQuickFixes: true },
	});

	assert.deepEqual(options, {
		renderIndentGuides: undefined,
		highlightActiveIndentGuide: undefined,
		guides: { indentation: false, highlightActiveIndentation: false },
		experimental: { stickyScroll: { enabled: undefined } },
		stickyScroll: { enabled: false },
		codeActionWidget: { includeNearbyQuickfixes: undefined, includeNearbyQuickFixes: true },
	});
});

test('EditorConfiguration keeps migrated nested options private to each editor', () => {
	const dom = new JSDOM('<div></div>');
	try {
		using first = createTestConfiguration(dom.window.document.body, { hover: false } as unknown as IEditorOptions);
		first.updateOptions({ hover: { enabled: 'on', delay: 900 } });
		using second = createTestConfiguration(dom.window.document.body, { hover: false } as unknown as IEditorOptions);
		assert.deepEqual({
			first: first.options.get(EditorOption.hover),
			second: second.getRawOptions().hover,
		}, {
			first: { ...second.options.get(EditorOption.hover), enabled: 'on', delay: 900 },
			second: { enabled: 'off' },
		});
	} finally {
		dom.window.close();
	}
});

test('migrateOptions preserves an explicit code shifting mode when the legacy key is also present', () => {
	const options = migrate({ inlineSuggest: { edits: { codeShifting: false, allowCodeShifting: 'horizontal' } } });
	assert.deepEqual(options, { inlineSuggest: { edits: { codeShifting: undefined, allowCodeShifting: 'horizontal' } } });
});

function migrate<T extends Record<string, unknown>>(options: T): T {
	migrateOptions(options as IEditorOptions);
	return options;
}

function measuredFont(font: BareFontInfo, width: number): FontInfo {
	return new FontInfo({
		...font,
		isMonospace: true,
		typicalHalfwidthCharacterWidth: width,
		typicalFullwidthCharacterWidth: width * 2,
		canUseHalfwidthRightwardsArrow: true,
		spaceWidth: width,
		middotWidth: width,
		wsmiddotWidth: width,
		maxDigitWidth: width,
	}, true);
}
