import { h } from '../../../base/browser/dom.js';
import { applyFontInfo } from './domFontInfo.js';
import { type BareFontInfo } from '../../common/config/fontInfo.js';

export const enum CharWidthRequestType {
	Regular = 0,
	Italic = 1,
	Bold = 2,
}

export class CharWidthRequest {
	width = 0;

	constructor(readonly chr: string, readonly type: CharWidthRequestType) {}

	fulfill(width: number): void {
		this.width = width;
	}
}

/** Measures all requested characters in one detached, style-normalized DOM batch. */
export function readCharWidths(targetWindow: Window, fontInfo: BareFontInfo, requests: CharWidthRequest[]): void {
	if (requests.length === 0) return;
	const document = targetWindow.document;
	const container = h(document, 'div');
	Object.assign(container.style, {
		position: 'absolute',
		top: '-100000px',
		left: '0',
		width: '100000px',
		visibility: 'hidden',
		whiteSpace: 'nowrap',
	});
	const parents = new Map<CharWidthRequestType, HTMLElement>();
	for (const type of [CharWidthRequestType.Regular, CharWidthRequestType.Italic, CharWidthRequestType.Bold]) {
		const parent = h(document, 'div');
		applyFontInfo(parent, fontInfo);
		if (type === CharWidthRequestType.Italic) parent.style.fontStyle = 'italic';
		if (type === CharWidthRequestType.Bold) parent.style.fontWeight = 'bold';
		container.append(parent);
		parents.set(type, parent);
	}
	const samples = requests.map(request => {
		const sample = h(document, 'span');
		sample.style.display = 'inline-block';
		sample.textContent = (request.chr === ' ' ? '\u00a0' : request.chr).repeat(256);
		parents.get(request.type)!.append(sample);
		return sample;
	});
	document.body.append(container);
	try {
		for (let index = 0; index < requests.length; index += 1) {
			requests[index]!.fulfill(samples[index]!.offsetWidth / 256);
		}
	} finally {
		container.remove();
	}
}
