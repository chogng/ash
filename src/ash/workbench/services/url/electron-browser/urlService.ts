import { URI, type UriComponents } from '../../../../base/common/uri.js';
import { IMainProcessService } from '../../../../platform/ipc/common/mainProcessService.js';
import { IOpenerService, type OpenOptions } from '../../../../platform/opener/common/opener.js';
import { URLHandlerChannel, URLHandlerChannelClient } from '../../../../platform/url/common/urlIpc.js';
import { AbstractURLService } from '../../../../platform/url/common/urlService.js';
import type { IOpenURLOptions, IURLHandler } from '../../../../platform/url/common/url.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { INativeHostService } from '../../../common/services.js';

export interface IRelayOpenURLOptions extends IOpenURLOptions {
	readonly openToSide?: boolean;
	readonly openExternal?: boolean;
}

export class RelayURLService extends AbstractURLService implements IURLHandler {
	private readonly mainHandler: URLHandlerChannelClient;

	constructor(
		private readonly windowId: number,
		@IMainProcessService mainProcessService: IMainProcessService,
		@IOpenerService openerService: IOpenerService,
		@INativeHostService private readonly host: INativeHostApi,
	) {
		super();
		this.mainHandler = new URLHandlerChannelClient(mainProcessService.getChannel('url'));
		mainProcessService.registerChannel('urlHandler', new URLHandlerChannel(this));
		this._register(openerService.registerOpener({
			open: async (target, options?: OpenOptions) => {
				if (options?.openExternal) {
					return false;
				}
				return this.open(target, { trusted: true });
			},
		}));
	}

	public override create(options: Partial<UriComponents> = {}): URI {
		const path = options.authority && options.path && !options.path.startsWith('/') ? `/${options.path}` : options.path;
		const uri = URI.from({ ...options, scheme: 'ash', path });
		const url = new URL(uri.toString());
		url.searchParams.set('windowId', String(this.windowId));
		return URI.parse(url.toString());
	}

	public override async open(resource: URI | string, options?: IRelayOpenURLOptions): Promise<boolean> {
		this.assertNotDisposed();
		const uri = typeof resource === 'string' ? URI.parse(resource) : resource;
		if (uri.scheme !== 'ash' || options?.openExternal) {
			return false;
		}
		return this.mainHandler.handleURL(uri, options ? { trusted: options.trusted, originalUrl: options.originalUrl } : undefined);
	}

	public async handleURL(uri: URI, options?: IOpenURLOptions): Promise<boolean> {
		if (uri.scheme !== 'ash') {
			return false;
		}
		const handled = await super.open(uri, options);
		if (handled) {
			await this.host.focusWindow();
		}
		return handled;
	}
}
