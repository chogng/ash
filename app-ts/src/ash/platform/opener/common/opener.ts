import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import type { ITextEditorOptions } from '../../editor/common/editor.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface OpenOptions {
	readonly openExternal?: boolean;
	readonly openToSide?: boolean;
	readonly fromUserGesture?: boolean;
	readonly editorOptions?: ITextEditorOptions;
	readonly skipValidation?: boolean;
	readonly allowContributedOpeners?: boolean | string;
}

export interface ResolveExternalUriOptions {
	readonly allowTunneling?: boolean;
}

export interface IResolvedExternalUri extends IDisposable {
	readonly resolved: URI;
}

export interface IOpener {
	open(target: URI | string, options?: OpenOptions): Promise<boolean>;
}

export interface IValidator {
	shouldOpen(target: URI | string, options?: OpenOptions): Promise<boolean>;
}

export interface IExternalUriResolver {
	resolveExternalUri(resource: URI, options?: ResolveExternalUriOptions): Promise<IResolvedExternalUri | undefined>;
}

export interface IExternalOpener {
	openExternal(
		href: string,
		context: { readonly sourceUri: URI; readonly preferredOpenerId?: string },
		token: CancellationToken,
	): Promise<boolean>;
}

/** Routes resources with replaceable external execution handlers. */
export interface IOpenerService {
	readonly _serviceBrand: undefined;
	registerOpener(opener: IOpener): IDisposable;
	registerValidator(validator: IValidator): IDisposable;
	registerExternalUriResolver(resolver: IExternalUriResolver): IDisposable;
	setDefaultExternalOpener(opener: IExternalOpener): void;
	registerExternalOpener(opener: IExternalOpener): IDisposable;
	open(target: URI | string, options?: OpenOptions): Promise<boolean>;
	resolveExternalUri(resource: URI, options?: ResolveExternalUriOptions): Promise<IResolvedExternalUri>;
}

export const IOpenerService = createServiceIdentifier<IOpenerService>('openerService');

/** Normalizes the web and mail URLs accepted by Ash's external-opening hosts. */
export function normalizeExternalUrl(target: string): string {
	if (/[\r\n\u0000]/u.test(target)) {
		throw new TypeError('External URL contains a line break or NUL');
	}
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		throw new TypeError('External URL must be absolute');
	}
	if (url.protocol === 'mailto:') {
		if (!url.pathname) {
			throw new TypeError('Mailto URL must include a recipient');
		}
		return url.toString();
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new TypeError(`External URL scheme is not allowed: ${url.protocol}`);
	}
	if (!url.hostname) {
		throw new TypeError('External URL must include a host');
	}
	return url.toString();
}
