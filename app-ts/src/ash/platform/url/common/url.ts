import type { IDisposable } from '../../../base/common/lifecycle.js';
import type { URI, UriComponents } from '../../../base/common/uri.js';
import { createServiceIdentifier } from '../../instantiation/common/instantiation.js';

export interface IOpenURLOptions {
	/** Only product-originated links carry trust; external callbacks remain untrusted. */
	readonly trusted?: boolean;
	readonly originalUrl?: string;
}

export interface IURLHandler {
	handleURL(uri: URI, options?: IOpenURLOptions): Promise<boolean>;
}

export interface IURLService {
	readonly _serviceBrand: undefined;
	create(options?: Partial<UriComponents>): URI;
	open(url: URI, options?: IOpenURLOptions): Promise<boolean>;
	registerHandler(handler: IURLHandler): IDisposable;
}

export const IURLService = createServiceIdentifier<IURLService>('urlService');
