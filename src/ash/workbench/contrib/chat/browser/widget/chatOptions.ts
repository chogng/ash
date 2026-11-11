import { DEFAULT_FONT_FAMILY } from '../../../../../base/browser/fonts.js';
import { BareFontInfo, EDITOR_FONT_DEFAULTS } from '../../../../../editor/common/config/fontInfo.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { CodeEditorConfiguration } from '../../../codeEditor/common/editorConfiguration.js';
import { ChatEditorConfiguration, ChatInputConfiguration } from '../../common/constants.js';

export function getChatInputEditorFont(configuration: IConfigurationService) {
	const fontSize = configuration.getValue<number>(ChatInputConfiguration.fontSize);
	const configuredLineHeight = configuration.getValue<number>(ChatInputConfiguration.lineHeight);
	return {
		fontFamily: configuration.getValue<string>(ChatInputConfiguration.fontFamily) || DEFAULT_FONT_FAMILY,
		fontSize,
		lineHeight: configuredLineHeight === 0 ? Math.round(fontSize * 1.5) : configuredLineHeight,
	};
}

/** Resolves the same response editor metrics for rendered and virtualized code blocks. */
export function getChatResultEditorOptions(configuration: IConfigurationService) {
	const family = configuration.getValue<string>(ChatEditorConfiguration.fontFamily)
		|| configuration.getValue<string>(CodeEditorConfiguration.fontFamily)
		|| EDITOR_FONT_DEFAULTS.fontFamily;
	const size = configuration.getValue<number>(ChatEditorConfiguration.fontSize)
		|| configuration.getValue<number>(CodeEditorConfiguration.fontSize);
	const height = configuration.getValue<number>(ChatEditorConfiguration.lineHeight)
		|| configuration.getValue<number>(CodeEditorConfiguration.lineHeight);
	const font = BareFontInfo._create(family, 'normal', size, 'normal', 'normal', height, 0, 1, true);
	const wordWrap = configuration.getValue<string>(ChatEditorConfiguration.wordWrap) === 'on' ? 'on' : 'off';
	return { font, wordWrap } as const;
}
