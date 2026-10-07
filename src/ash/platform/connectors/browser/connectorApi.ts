import { CancellationToken } from '../../../base/common/cancellation.js';
import { URI } from '../../../base/common/uri.js';
import { timeout } from "../../../base/common/async.js";
import type { AppServerProtocolClient } from "../../agentHost/browser/appServerProtocolClient.js";
import { appServerRequest } from "../../agentHost/browser/appServerRequest.js";
import type { UnavailableOperation } from "../../renderer/browser/disconnectedHost.js";
import type { IConnectorApi } from "../common/connectorApi.js";
import type { IClipboardService } from "../../clipboard/common/clipboardService.js";
import type { IExternalOpener } from "../../opener/common/opener.js";

export interface BrowserConnectorHostServices {
	readonly externalOpener: IExternalOpener;
	readonly clipboardService: IClipboardService;
	readonly callbackHost?: {
		listen(): Promise<{ readonly id: string; readonly redirectUri: string; }>;
		wait(id: string): Promise<{ readonly state: string; readonly code: string; }>;
		close(id: string): Promise<void>;
	};
}

export function createDisconnectedConnectorApi(unavailable: UnavailableOperation): IConnectorApi {
	return {
		list: () => unavailable("connectors.list"),
		connectApiToken: () => unavailable("connectors.connectApiToken"),
		connectOAuth: () => unavailable("connectors.connectOAuth"),
		disconnect: () => unavailable("connectors.disconnect"),
		refreshOAuth: () => unavailable("connectors.refreshOAuth"),
		revokeOAuth: () => unavailable("connectors.revokeOAuth"),
	};
}

export function createAppServerConnectorApi(connection: AppServerProtocolClient, hostServices: BrowserConnectorHostServices): IConnectorApi {
	return {
		list: () => appServerRequest(connection, "connector/list", {}),
		connectApiToken: params => appServerRequest(connection, "connector/connect/apiToken", params),
		connectOAuth: async params => {
			const catalog = await appServerRequest(connection, 'connector/list', {});
			const connector = catalog.connectors.find(candidate => candidate.id === params.connectorId);
			if (connector?.oauthMethods.includes('browser') && hostServices.callbackHost) {
				return connectBrowserOAuth(connection, params, hostServices, hostServices.callbackHost);
			}
			if (connector?.oauthMethods.includes('device')) { return connectDeviceOAuth(connection, params, hostServices); }
			throw new Error('Connector OAuth is unavailable in this host');
		},
		disconnect: params => appServerRequest(connection, "connector/disconnect", params),
		refreshOAuth: async connectorId => { await appServerRequest(connection, "connector/oauth/refresh", { connectorId }); },
		revokeOAuth: params => appServerRequest(connection, "connector/oauth/revoke", params),
	};
}

async function connectDeviceOAuth(connection: AppServerProtocolClient, params: Parameters<IConnectorApi["connectOAuth"]>[0], hostServices: BrowserConnectorHostServices) {
	const catalog = await appServerRequest(connection, "connector/list", {});
	const connector = catalog.connectors.find(candidate => candidate.id === params.connectorId);
	if (!connector?.oauthMethods.includes("device")) throw new Error("Connector device OAuth is unavailable in this browser host");
	const started = await appServerRequest(connection, "connector/connect/oauth/device/start", params);
	let completed = false;
	try {
		await hostServices.externalOpener.openExternal(started.verificationUri, { sourceUri: URI.parse(started.verificationUri) }, CancellationToken.None);
		await hostServices.clipboardService.writeText(started.userCode);
		let waitSeconds = started.pollIntervalSeconds;
		for (; ;) {
			await timeout(Math.min(waitSeconds, 30) * 1_000);
			const result = await appServerRequest(connection, "connector/connect/oauth/device/poll", { flowId: started.flowId });
			if (result.status === "connected") {
				completed = true;
				return result.command;
			}
			waitSeconds = result.retryAfterSeconds;
		}
	} finally {
		if (!completed) await appServerRequest(connection, "connector/connect/oauth/device/cancel", { flowId: started.flowId }).catch(() => undefined);
	}
}

async function connectBrowserOAuth(connection: AppServerProtocolClient, params: Parameters<IConnectorApi['connectOAuth']>[0], host: BrowserConnectorHostServices, callbacks: NonNullable<BrowserConnectorHostServices['callbackHost']>) {
	const callback = await callbacks.listen();
	let flowId: string | undefined;
	let completed = false;
	try {
		const started = await appServerRequest(connection, 'connector/connect/oauth/start', { ...params, redirectUri: callback.redirectUri });
		flowId = started.flowId;
		await host.externalOpener.openExternal(started.authorizationUrl, { sourceUri: URI.parse(started.authorizationUrl) }, CancellationToken.None);
		const values = await callbacks.wait(callback.id);
		const result = await appServerRequest(connection, 'connector/connect/oauth/complete', { flowId, state: values.state, authorizationCode: values.code });
		completed = true;
		return result;
	} finally {
		await callbacks.close(callback.id);
		if (flowId && !completed) { await appServerRequest(connection, 'connector/connect/oauth/cancel', { flowId }).catch(() => undefined); }
	}
}
