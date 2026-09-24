import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';

/** Presentation metadata supplied by source control, search, or extensions. */
export interface IFileLabelDecoration {
	readonly tooltip?: string;
	readonly colorClassName?: string;
	readonly badgeClassName?: string;
	readonly iconClassName?: string;
	readonly strikethrough?: boolean;
}

export interface IFileLabelDecorationChangeEvent {
	readonly resources?: readonly URI[];
}

/** Workbench-level file label decorations, intentionally separate from editor text decorations. */
export interface IFileLabelDecorationService extends IDisposable {
	readonly onDidChange: Event<IFileLabelDecorationChangeEvent>;

	getDecoration(resource: URI, isFolder: boolean): IFileLabelDecoration | undefined;
	setDecoration(resource: URI, decoration: IFileLabelDecoration): void;
	clearDecoration(resource: URI): void;
}

export const IFileLabelDecorationService = createServiceIdentifier<IFileLabelDecorationService>('fileLabelDecorationService');
