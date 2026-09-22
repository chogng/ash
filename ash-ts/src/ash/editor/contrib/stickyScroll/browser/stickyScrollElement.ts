import type { URI } from '../../../../base/common/uri.js';

export class StickyRange {
	constructor(public readonly startLineNumber: number, public readonly endLineNumber: number) {}
}

export class StickyElement {
	constructor(
		public readonly range: StickyRange | undefined,
		public readonly children: StickyElement[],
		public readonly parent: StickyElement | undefined,
	) {}
}

export class StickyModel {
	constructor(
		public readonly uri: URI,
		public readonly version: number,
		public readonly element: StickyElement | undefined,
		public readonly outlineProviderId: string | undefined,
	) {}
}
