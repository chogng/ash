import { localize } from '../../../../nls.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';

export enum PdfScrollMode {
	Paged = 'paged',
	Continuous = 'continuous',
}

export const pdfScrollModeSetting = 'sessions.pdf.scrollMode';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: pdfScrollModeSetting,
	scope: ConfigurationScope.APPLICATION,
	defaultValue: PdfScrollMode.Continuous,
	parse(value: unknown): PdfScrollMode {
		if (value !== PdfScrollMode.Continuous && value !== PdfScrollMode.Paged) {
			throw new TypeError(localize('sessions.pdfPreview.invalidScrollMode', 'Choose Continuous scrolling or Page scrolling for PDF previews.'));
		}
		return value;
	},
	setting: {
		included: false,
		valueType: 'select',
		get title() { return localize('sessions.pdfPreview.scrollModeTitle', 'PDF scroll mode'); },
		get description() { return localize('sessions.pdfPreview.scrollModeDescription', 'Choose the scroll mode for PDF previews. New PDFs use the last mode selected in the toolbar.'); },
		get options() {
			return [
				{ value: PdfScrollMode.Continuous, label: localize('sessions.pdfPreview.continuous', 'Continuous scrolling') },
				{ value: PdfScrollMode.Paged, label: localize('sessions.pdfPreview.paged', 'Page scrolling') },
			];
		},
	},
});
