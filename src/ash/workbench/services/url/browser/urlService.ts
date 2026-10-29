import type { Event } from '../../../../base/common/event.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { URI, type UriComponents } from '../../../../base/common/uri.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { AbstractURLService } from '../../../../platform/url/common/urlService.js';

export interface IURLCallbackProvider {
	readonly onCallback: Event<URI>;
	/** The callback must restore the supplied URI components before emitting onCallback. */
	create(options?: Partial<UriComponents>): URI;
}

export class BrowserURLService extends AbstractURLService {
	constructor(
		private readonly provider: IURLCallbackProvider | undefined,
		@IOpenerService openerService: IOpenerService,
	) {
		super();
		this._register(openerService.registerOpener({
			open: async (target, options) => {
				const uri = typeof target === 'string' ? URI.parse(target) : target;
				if (options?.openExternal || uri.scheme !== 'ash') {
					return false;
				}
				return this.open(uri, { trusted: true });
			},
		}));
		if (provider) {
			this._register(provider.onCallback(uri => {
				if (uri.scheme === 'ash') {
					void this.open(uri).catch(onUnexpectedError);
				}
			}));
		}
	}

	public override create(options?: Partial<UriComponents>): URI {
		if (!this.provider) {
			throw new Error('The browser host has no URL callback provider');
		}
		return this.provider.create(options);
	}
}
