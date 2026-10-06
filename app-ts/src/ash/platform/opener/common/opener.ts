import type { CancellationToken } from '../../../base/common/cancellation.js';
import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI } from '../../../base/common/uri.js';
import type { ITextEditorOptions } from '../../editor/common/editor.js';
import type { ITextEditorSelection } from '../../editor/common/editor.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

/** Explicitly selects the host's external opener and bypasses contributed handlers. */
export const defaultExternalUriOpenerId = 'default';

export function withSelection(uri: URI, selection: ITextEditorSelection): URI {
	const end = selection.endLineNumber === undefined ? '' : `-${selection.endLineNumber},${selection.endColumn ?? 1}`;
	return uri.with({ fragment: `${selection.startLineNumber},${selection.startColumn}${end}` });
}

/** Separates editor coordinates before the resource enters file or model resolution. */
export function extractSelection(uri: URI): { selection: ITextEditorSelection | undefined; uri: URI; } {
	const points = uri.fragment.split('-');
	if (points.length > 2 || points.some(point => !/^L?\d+(,\d+)?$/.test(point))) {
		return { uri, selection: undefined };
	}
	const coordinates = points.map(point => point.replace(/^L/, '').split(',').map(Number));
	if (coordinates.flat().some(value => !Number.isSafeInteger(value) || value < 1)) {
		return { uri, selection: undefined };
	}
	const start = coordinates[0]!;
	const end = coordinates[1];
	return {
		uri: uri.with({ fragment: '' }),
		selection: { startLineNumber: start[0]!, startColumn: start[1] ?? 1, endLineNumber: end?.[0], endColumn: end ? end[1] ?? 1 : undefined },
	};
}

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
		context: { readonly sourceUri: URI; readonly preferredOpenerId?: string; },
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
