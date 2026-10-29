import { protocol, net } from 'electron/main';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AbstractDisposable } from '../../../base/common/lifecycle.js';
import { Schemas } from '../../../base/common/network.js';

/** Serves only the two trusted bootstrap assets, never workspace or arbitrary disk files. */
export class WebviewProtocolProvider extends AbstractDisposable {
	constructor(rendererRoot: string, developmentUrl: string | undefined) {
		super();
		protocol.handle(Schemas.vscodeWebview, async request => {
			const url = new URL(request.url);
			const asset = /^\/assets\/(index-[\w-]+\.html|service-worker-[\w-]+\.js)$/.exec(url.pathname)?.[1];
			const developmentAsset = /\/src\/ash\/workbench\/contrib\/webview\/browser\/pre\/(index\.html|service-worker\.js)$/.test(url.pathname);
			if (request.method !== 'GET' || (!asset && !(developmentUrl && developmentAsset))) {
				return new Response(null, { status: 404 });
			}
			if (developmentUrl) {
				return net.fetch(new URL(url.pathname, developmentUrl).href);
			}
			try {
				const bytes = await readFile(join(rendererRoot, 'assets', asset!));
				return new Response(bytes, {
					headers: {
						'Content-Type': asset!.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8',
						'Cache-Control': 'no-cache',
					},
				});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
					return new Response(null, { status: 404 });
				}
				throw error;
			}
		});
	}

	protected override disposeCore(): void {
		protocol.unhandle(Schemas.vscodeWebview);
	}
}
