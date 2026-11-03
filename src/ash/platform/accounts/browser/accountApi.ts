import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import { APP_SERVER_METHODS, type AccountLoginStartResult } from '../../../../../.build/protocol/typescript/index.js';
import type { AppServerProtocolClient } from '../../agentHost/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../agentHost/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../agentHost/browser/disconnectedAppServer.js';
import type { IAccountApi } from '../common/accountApi.js';
import type { IClipboardService } from '../../clipboard/common/clipboardService.js';
import type { IExternalOpener } from '../../opener/common/opener.js';

export interface BrowserAccountLoginHostServices {
	readonly externalOpener: IExternalOpener;
	readonly clipboardService: IClipboardService;
}

export function createDisconnectedAccountApi(unavailable: UnavailableOperation): IAccountApi {
	return {
		read: () => unavailable('accounts.read'),
		readRateLimits: () => unavailable('accounts.readRateLimits'),
		startLogin: () => unavailable('accounts.startLogin'),
		cancelLogin: () => unavailable('accounts.cancelLogin'),
		logout: () => unavailable('accounts.logout'),
	};
}

export function createAppServerAccountApi(connection: AppServerProtocolClient, hostServices: BrowserAccountLoginHostServices): IAccountApi {
	return {
		read: () => appServerRequest(connection, 'account/read', {}),
		readRateLimits: (params, signal) => connection.request(APP_SERVER_METHODS['account/rateLimits/read'], params, { signal }),
		startLogin: params => startLogin(connection, params, hostServices),
		cancelLogin: params => appServerRequest(connection, 'account/login/cancel', params),
		logout: params => appServerRequest(connection, 'account/logout', params),
	};
}

async function startLogin(connection: AppServerProtocolClient, params: Parameters<IAccountApi['startLogin']>[0], hostServices: BrowserAccountLoginHostServices): Promise<AccountLoginStartResult> {
	const started = await appServerRequest(connection, 'account/login/start', params);
	if (started.type === 'connected') {
		return started;
	}
	try {
		const target = started.type === 'browser' ? started.authorizationUrl : started.verificationUrl;
		await hostServices.externalOpener.openExternal(target, { sourceUri: URI.parse(target) }, CancellationToken.None);
		if (started.type === 'deviceCode') await hostServices.clipboardService.writeText(started.userCode);
		return started;
	} catch (error) {
		await appServerRequest(connection, 'account/login/cancel', { loginId: started.loginId }).catch(() => undefined);
		throw error;
	}
}
