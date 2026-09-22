import { EditorConfiguration } from '../../../browser/config/editorConfiguration.js';
import { EditorFontLigatures, EditorFontVariations, type IEditorOptions } from '../../../common/config/editorOptions.js';
import { type BareFontInfo, FontInfo } from '../../../common/config/fontInfo.js';
import { MenuId } from '../../../../platform/actions/common/actions.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { ServiceContainer } from '../../../../platform/instantiation/common/instantiation.js';
import { ContextKeyService, IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { AccessibilityService } from '../../../../platform/accessibility/browser/accessibilityService.js';

export function createConfigurationServices(resources: DisposableStore, container: HTMLElement): ServiceContainer {
	const services = resources.add(new ServiceContainer());
	services.registerSingleton(IContextKeyService, () => new ContextKeyService());
	services.registerSingleton(IConfigurationService, () => new InMemoryConfigurationService());
	services.registerSingleton(IAccessibilityService, accessor => new AccessibilityService({
		root: container.ownerDocument.body,
		contextKeyService: accessor.get(IContextKeyService),
		configurationService: accessor.get(IConfigurationService),
	}));
	return services;
}

export function createTestConfiguration(container: HTMLElement, options: IEditorOptions = {}): EditorConfiguration {
	const resources = new DisposableStore();
	try {
		const services = createConfigurationServices(resources, container);
		return services.createInstance(TestEditorConfiguration, options, container, resources);
	} catch (error) {
		resources.dispose();
		throw error;
	}
}

class TestEditorConfiguration extends EditorConfiguration {
	constructor(
		options: IEditorOptions,
		container: HTMLElement,
		resources: DisposableStore,
		@IAccessibilityService accessibilityService: IAccessibilityService,
	) {
		super(false, MenuId.EditorContext, options, container, accessibilityService);
		this._register(resources);
	}

	protected override _readFontInfo(font: BareFontInfo): FontInfo {
		return new FontInfo({
			...font,
			isMonospace: TEST_FONT_INFO.isMonospace,
			typicalHalfwidthCharacterWidth: TEST_FONT_INFO.typicalHalfwidthCharacterWidth,
			typicalFullwidthCharacterWidth: TEST_FONT_INFO.typicalFullwidthCharacterWidth,
			canUseHalfwidthRightwardsArrow: TEST_FONT_INFO.canUseHalfwidthRightwardsArrow,
			spaceWidth: TEST_FONT_INFO.spaceWidth,
			middotWidth: TEST_FONT_INFO.middotWidth,
			wsmiddotWidth: TEST_FONT_INFO.wsmiddotWidth,
			maxDigitWidth: TEST_FONT_INFO.maxDigitWidth,
		}, true);
	}
}

export const TEST_FONT_INFO = new FontInfo({
	pixelRatio: 1,
	fontFamily: 'Ash Test Mono',
	fontWeight: 'normal',
	fontSize: 14,
	fontFeatureSettings: EditorFontLigatures.OFF,
	fontVariationSettings: EditorFontVariations.OFF,
	lineHeight: 20,
	letterSpacing: 0,
	isMonospace: true,
	typicalHalfwidthCharacterWidth: 8,
	typicalFullwidthCharacterWidth: 16,
	canUseHalfwidthRightwardsArrow: true,
	spaceWidth: 8,
	middotWidth: 8,
	wsmiddotWidth: 8,
	maxDigitWidth: 8,
}, true);
