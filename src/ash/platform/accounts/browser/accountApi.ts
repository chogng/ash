import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import type { AccountLoginStartResult } from '../../../../../crates/app-server-protocol/schema/typescript/index.js';
import type { AppServerProtocolClient } from '../../app-server/browser/appServerProtocolClient.js';
import { appServerRequest } from '../../app-server/browser/appServerRequest.js';
import type { UnavailableOperation } from '../../renderer/browser/disconnectedHost.js';
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
		const target = started.type === 'browser' ? started.authorizationUrl : started.verificationUrl;
		await hostServices.externalOpener.openExternal(target, { sourceUri: URI.parse(target) }, CancellationToken.None);
		if (started.type === 'deviceCode') await hostServices.clipboardService.writeText(started.userCode);
		return started;
	} catch (error) {
		await appServerRequest(connection, 'account/login/cancel', { loginId: started.loginId }).catch(() => undefined);
		throw error;
	}
}
