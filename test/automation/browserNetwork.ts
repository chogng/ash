import type { ElectronApplication } from '@playwright/test';
import { resolve } from 'node:path';
import type { BrowserView } from '../../src/ash/platform/browserView/electron-main/browserView.js';
import type { BrowserViewEvent } from '../../src/ash/platform/browserView/common/browserView.js';

export const browserNetworkToken = 'browser-test-authority';

/** Substitute backend decisions for host-only scenarios while retaining Chromium interception and revocation. */
export async function installBrowserNetworkPolicy(application: ElectronApplication, allowedOrigin: string): Promise<void> {
	const modulePath = resolve('.build/desktop/main/src/ash/platform/browserView/electron-main/browserView.js');
	await application.evaluate((_electron, { modulePath, allowedOrigin, token }) => {
		const require = process.getBuiltinModule('module').createRequire(modulePath);
		const { BrowserView } = require(modulePath) as { BrowserView: { prototype: BrowserView; }; };
		const initialize = BrowserView.prototype.initialize;
		BrowserView.prototype.initialize = function () {
			const view = this as unknown as { emitEvent: (event: BrowserViewEvent) => void; } & Pick<BrowserView, 'session' | 'webContents'>;
			const emit = view.emitEvent;
			view.emitEvent = event => {
				if (event.type !== 'networkRequested') { emit(event); return; }
				const url = new URL(event.url);
				const origin = new URL(allowedOrigin);
				view.session.respondToNetworkRequest(view.webContents.id, event.requestId,
					event.networkToken === token && url.hostname === origin.hostname && url.port === origin.port && url.protocol === 'http:');
			};
			initialize.call(this);
		};
	}, { modulePath, allowedOrigin, token: browserNetworkToken });
}
