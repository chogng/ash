import { safeIntl } from '../../../base/common/date.js';
import type { GraphemeIterator } from '../../../base/common/strings.js';
import type { ViewLineRenderingData } from '../../common/viewModel.js';
import type { ViewLineOptions } from '../viewParts/viewLines/viewLineOptions.js';

export interface IContentSegmenter {
	getSegmentAtIndex(index: number): string | undefined;
	getSegmentData(index: number): Intl.SegmentData | undefined;
}

export function createContentSegmenter(lineData: ViewLineRenderingData, options: ViewLineOptions): IContentSegmenter {
	if (lineData.isBasicASCII && options.useMonospaceOptimizations) {
		return segmentContent(lineData.content, true, true);
	}
	return segmentContent(lineData.content, false, false);
}

/** Creates the same segment view when a renderer already owns the line text. */
export function segmentContent(content: string, isBasicASCII: boolean, useMonospaceOptimizations: boolean): IContentSegmenter {
	return isBasicASCII && useMonospaceOptimizations
		? new AsciiContentSegmenter(content)
		: new GraphemeContentSegmenter(content);
}

class AsciiContentSegmenter implements IContentSegmenter {
	private readonly _content: string;

	constructor(content: string) {
		this._content = content;
	}

	getSegmentAtIndex(index: number): string {
		return this._content[index];
	}

	getSegmentData(index: number): Intl.SegmentData | undefined {
		return undefined;
	}
}

/**
 * This is a more modern version of {@link GraphemeIterator}, relying on browser APIs instead of a
 * manual table approach.
 */
class GraphemeContentSegmenter implements IContentSegmenter {
	private readonly _segments: (Intl.SegmentData | undefined)[] = [];

	constructor(content: string) {
		const segmenter = safeIntl.Segmenter(undefined, { granularity: 'grapheme' }).value;
		const segmentedContent = Array.from(segmenter.segment(content));
		let segmenterIndex = 0;

		for (let x = 0; x < content.length; x++) {
			const segment = segmentedContent[segmenterIndex];
			if (!segment) {
				break;
			}
			if (segment.index !== x) {
				this._segments.push(undefined);
				continue;
			}
			segmenterIndex++;
			this._segments.push(segment);
		}
	}

	getSegmentAtIndex(index: number): string | undefined {
		return this._segments[index]?.segment;
	}

	getSegmentData(index: number): Intl.SegmentData | undefined {
		return this._segments[index];
	}
}
