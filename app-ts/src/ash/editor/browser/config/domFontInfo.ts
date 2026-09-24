import { FastDomNode } from '../../../base/browser/fastDomNode.js';
import { type BareFontInfo } from '../../common/config/fontInfo.js';

/** Applies one normalized editor font description to a DOM node. */
export function applyFontInfo(domNode: FastDomNode<HTMLElement> | HTMLElement, fontInfo: BareFontInfo): void {
	const fontFamily = fontInfo.getMassagedFontFamily();
	if (domNode instanceof FastDomNode) {
		domNode.setFontFamily(fontFamily);
		domNode.setFontWeight(fontInfo.fontWeight);
		domNode.setFontSize(fontInfo.fontSize);
		domNode.setFontFeatureSettings(fontInfo.fontFeatureSettings);
		domNode.setFontVariationSettings(fontInfo.fontVariationSettings);
		domNode.setLineHeight(fontInfo.lineHeight);
		domNode.setLetterSpacing(fontInfo.letterSpacing);
		return;
	}
	Object.assign(domNode.style, {
		fontFamily,
		fontWeight: fontInfo.fontWeight,
		fontSize: `${fontInfo.fontSize}px`,
		fontFeatureSettings: fontInfo.fontFeatureSettings,
		fontVariationSettings: fontInfo.fontVariationSettings,
		lineHeight: `${fontInfo.lineHeight}px`,
		letterSpacing: `${fontInfo.letterSpacing}px`,
	});
}
