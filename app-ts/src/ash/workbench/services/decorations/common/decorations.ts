import type { CancellationToken } from '../../../../base/common/cancellation.js';
import type { Event } from '../../../../base/common/event.js';
import type { IDisposable } from '../../../../base/common/lifecycle.js';
import type { ThemeIcon } from '../../../../base/common/themables.js';
import type { URI } from '../../../../base/common/uri.js';
import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import type { ColorIdentifier } from '../../../../platform/theme/common/colorRegistry.js';

export interface IDecorationData {
	readonly weight?: number;
	readonly color?: ColorIdentifier;
	readonly letter?: string | ThemeIcon;
	readonly tooltip?: string;
	readonly strikethrough?: boolean;
	readonly bubble?: boolean;
}

/** A label owns this handle for as long as it uses the generated style classes. */
export interface IDecoration extends IDisposable {
	readonly tooltip: string;
	readonly strikethrough: boolean;
	readonly labelClassName: string;
	readonly badgeClassName: string;
	readonly iconClassName: string;
	readonly isTextBadge: boolean;
}

export interface IDecorationsProvider {
	readonly label: string;
	/** An empty list invalidates every resource supplied by this provider. */
	readonly onDidChange: Event<readonly URI[]>;
	provideDecorations(uri: URI, token: CancellationToken): IDecorationData | Promise<IDecorationData | undefined> | undefined;
}

export interface IResourceDecorationChangeEvent {
	affectsResource(uri: URI): boolean;
}

export interface IDecorationsService {
	readonly onDidChangeDecorations: Event<IResourceDecorationChangeEvent>;
	registerDecorationsProvider(provider: IDecorationsProvider): IDisposable;
	getDecoration(uri: URI, includeChildren: boolean): IDecoration | undefined;
}

export const IDecorationsService = createServiceIdentifier<IDecorationsService>('IFileDecorationsService');
