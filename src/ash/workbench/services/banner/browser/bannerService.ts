import type { MarkdownString } from '../../../../base/common/htmlContent.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import type { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { ILinkDescriptor } from '../../../../platform/opener/browser/link.js';

export interface IBannerItem {
	readonly id: string;
	readonly icon: ThemeIcon | URI | undefined;
	readonly message: string | MarkdownString;
	readonly actions?: ReadonlyArray<ILinkDescriptor>;
	readonly ariaLabel?: string;
	readonly onClose?: () => void;
	readonly closeLabel?: string;
	/** Higher priority wins; equal priorities show the most recently submitted item. */
	readonly priority?: number;
	readonly neutral?: boolean;
}

export const IBannerService = createDecorator<IBannerService>('bannerService');

/** Window-scoped, persistent notices. Connection and feature state remain with their producers. */
export interface IBannerService {
	readonly _serviceBrand: undefined;
	focus(): void;
	focusNextAction(): void;
	focusPreviousAction(): void;
	hide(id: string): void;
	show(item: IBannerItem): void;
}
