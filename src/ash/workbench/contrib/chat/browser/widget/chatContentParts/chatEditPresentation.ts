import type { IDisposable } from '../../../../../../base/common/lifecycle.js';

export interface IChatEditDiff {
	readonly beforeContent: string;
	readonly afterContent: string;
	readonly languageId: string;
}

export interface IChatEditFileDiff extends IChatEditDiff {
	readonly path?: string;
}

export interface IChatEditPresentation extends IDisposable {
	focus(original?: boolean): void;
}
