import type { AccountLoginStartResult } from '../../app-server/common/generated/index.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
import type { IAccountApi } from '../common/accountApi.js';
import type { IClipboardService } from '../../clipboard/common/clipboardService.js';
import type { IOpenerService } from '../../opener/common/openerService.js';

export interface BrowserAccountLoginHostServices {
	readonly openerService: IOpenerService;
	readonly clipboardService: IClipboardService;
}

export function createDisconnectedAccountApi(unavailable: UnavailableOperation): IAccountApi {
	return {
		read: () => unavailable('accounts.read'),
		startLogin: () => unavailable('accounts.startLogin'),
		cancelLogin: () => unavailable('accounts.cancelLogin'),
		logout: () => unavailable('accounts.logout'),
	};
}

export function createAppServerAccountApi(connection: AppServerProtocolClient, hostServices: BrowserAccountLoginHostServices): IAccountApi {
	return {
		read: () => appServerRequest(connection, 'account/read', {}),
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
		await hostServices.openerService.openExternal(started.type === 'browser' ? started.authorizationUrl : started.verificationUrl);
		if (started.type === 'deviceCode') await hostServices.clipboardService.writeText(started.userCode);
		return started;
	} catch (error) {
		await appServerRequest(connection, 'account/login/cancel', { loginId: started.loginId }).catch(() => undefined);
		throw error;
	}
}
