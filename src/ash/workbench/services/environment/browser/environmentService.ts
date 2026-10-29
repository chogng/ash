import { URI } from '../../../../base/common/uri.js';
import { Schemas } from '../../../../base/common/network.js';
import { IWorkbenchEnvironmentService } from '../common/environmentService.js';
import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import type { IWebWorkbenchConstructionOptions } from '../../../browser/web.api.js';

export interface IBrowserWorkbenchEnvironmentService extends IWorkbenchEnvironmentService {
	readonly options: Pick<IWebWorkbenchConstructionOptions, 'updateProvider'>;
}

export const IBrowserWorkbenchEnvironmentService = refineServiceDecorator<
	IWorkbenchEnvironmentService,
	IBrowserWorkbenchEnvironmentService
>(IWorkbenchEnvironmentService);

export class BrowserWorkbenchEnvironmentService implements IBrowserWorkbenchEnvironmentService {
	readonly argvResource = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/argv.json' });
	public readonly webviewExternalEndpoint: string;

	constructor(
		location: Location,
		webviewEndpoint?: string,
		public readonly options: Pick<IWebWorkbenchConstructionOptions, 'updateProvider'> = {},
	) {
		if (
			options.updateProvider !== undefined &&
			(options.updateProvider === null ||
				typeof options.updateProvider !== 'object' ||
				typeof options.updateProvider.checkForUpdate !== 'function')
		) {
			throw new TypeError('Web updateProvider must provide checkForUpdate()');
		}
		const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
		// Service workers require a secure context throughout the iframe's ancestor chain.
		if (location.protocol === 'http:' && !isLoopback) {
			throw new TypeError('The Web host requires HTTPS outside localhost');
		}
		if (webviewEndpoint !== undefined) {
			if (typeof webviewEndpoint !== 'string' || webviewEndpoint.split('{{uuid}}').length !== 2) {
				throw new TypeError('Webview endpoint must identify each isolated origin with {{uuid}}');
			}
			const url = new URL(webviewEndpoint.replace('{{uuid}}', 'webview'));
			const otherOrigin = new URL(webviewEndpoint.replace('{{uuid}}', 'another-webview')).origin;
			if (
				!['http:', 'https:'].includes(url.protocol) ||
				url.username ||
				url.password ||
				url.search ||
				url.hash ||
				url.origin === otherOrigin
			) {
				throw new TypeError('Webview endpoint must provide an HTTP origin for each {{uuid}}');
			}
			if (url.protocol === 'http:' && !url.hostname.endsWith('.localhost')) {
				throw new TypeError('Webview endpoint requires HTTPS outside localhost');
			}
			if (url.origin === location.origin) {
				throw new TypeError('Webview endpoint must be isolated from the Workbench origin');
			}
			this.webviewExternalEndpoint = webviewEndpoint;
		} else {
			if (!isLoopback) {
				throw new TypeError('This Web host must configure an isolated webviewEndpoint');
			}
			this.webviewExternalEndpoint = `${location.protocol}//{{uuid}}.localhost${location.port ? `:${location.port}` : ''}`;
		}
	}
}
