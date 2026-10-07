import type {
	IpcRoute,
} from "../../ipc/electron-main/trustedIpcRouter.js";
import {
	BROWSER_VIEW_CLOSE_CHANNEL,
	BROWSER_VIEW_CREATE_CHANNEL,
	BROWSER_VIEW_GO_BACK_CHANNEL,
	BROWSER_VIEW_GO_FORWARD_CHANNEL,
	BROWSER_VIEW_LAYOUT_CHANNEL,
	BROWSER_VIEW_NAVIGATE_CHANNEL,
	BROWSER_VIEW_RELOAD_CHANNEL,
	BROWSER_VIEW_STATE_CHANNEL,
	BROWSER_VIEW_STOP_CHANNEL,
	BROWSER_VIEW_FOCUS_CHANNEL,
	BROWSER_VIEW_VISIBILITY_CHANNEL,
	type IBrowserViewCreateRequest,
	type IBrowserViewLayoutRequest,
	type IBrowserViewNavigateRequest,
	type IBrowserViewTargetRequest,
	type IBrowserViewVisibilityRequest,
	validateBrowserViewCreateRequest,
	validateBrowserViewLayoutRequest,
	validateBrowserViewNavigateRequest,
	validateBrowserViewTargetRequest,
	validateBrowserViewVisibilityRequest,
} from "../common/browserView.js";

import type { IBrowserViewService } from '../common/browserView.js';
import { BROWSER_VIEW_LIST_CHANNEL, BROWSER_VIEW_SHARING_CHANNEL } from '../common/browserView.js';
import { BROWSER_VIEW_PERMISSION_CHANNEL, BROWSER_VIEW_PERMISSIONS_CLEAR_CHANNEL, BROWSER_VIEW_DOWNLOAD_CANCEL_CHANNEL } from '../common/browserView.js';
import { isRecord } from '../../../base/common/types.js';

/** Binds the main-owned browser-view service to trusted workbench IPC. */
export function browserViewIpcRoutes(
	service: Omit<IBrowserViewService, 'onDidEvent'>,
): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: BROWSER_VIEW_PERMISSION_CHANNEL, validate: value => {
				if (!isRecord(value) || Object.keys(value).length !== 3 || typeof value.requestId !== 'string' || typeof value.allowed !== 'boolean') { throw new TypeError('Invalid browser permission response'); }
				return { ...validateBrowserViewTargetRequest({ targetId: value.targetId }), requestId: value.requestId, allowed: value.allowed };
			}, invoke: value => { const request = value as { targetId: string; requestId: string; allowed: boolean; }; return service.respondToPermission(request.targetId, request.requestId, request.allowed); }
		},
		targetRoute(BROWSER_VIEW_PERMISSIONS_CLEAR_CHANNEL, id => service.clearPermissions(id)),
		targetRoute(BROWSER_VIEW_DOWNLOAD_CANCEL_CHANNEL, id => service.cancelDownloads(id)),
		{ channel: BROWSER_VIEW_SHARING_CHANNEL, validate: validateBrowserViewTargetRequest, invoke: request => service.getSharing((request as IBrowserViewTargetRequest).targetId) },
		{
			channel: BROWSER_VIEW_LIST_CHANNEL,
			validate: value => {
				if (value !== undefined) { throw new TypeError('Browser list does not accept parameters'); }
				return undefined;
			},
			invoke: () => service.getBrowserViews(),
		},
		{
			channel: BROWSER_VIEW_CREATE_CHANNEL,
			validate: validateBrowserViewCreateRequest,
			invoke: (request) =>
				service.getOrCreateBrowserView((request as IBrowserViewCreateRequest).targetId, (request as IBrowserViewCreateRequest).options),
		},
		{
			channel: BROWSER_VIEW_STATE_CHANNEL,
			validate: validateBrowserViewTargetRequest,
			invoke: (request) =>
				service.getState((request as IBrowserViewTargetRequest).targetId),
		},
		{
			channel: BROWSER_VIEW_LAYOUT_CHANNEL,
			validate: validateBrowserViewLayoutRequest,
			invoke: (request) =>
				service.layout((request as IBrowserViewLayoutRequest).targetId, (request as IBrowserViewLayoutRequest).bounds),
		},
		{
			channel: BROWSER_VIEW_VISIBILITY_CHANNEL,
			validate: validateBrowserViewVisibilityRequest,
			invoke: (request) =>
				service.setVisible((request as IBrowserViewVisibilityRequest).targetId, (request as IBrowserViewVisibilityRequest).visible),
		},
		{
			channel: BROWSER_VIEW_NAVIGATE_CHANNEL,
			validate: validateBrowserViewNavigateRequest,
			invoke: (request) =>
				service.loadURL((request as IBrowserViewNavigateRequest).targetId, (request as IBrowserViewNavigateRequest).url),
		},
		targetRoute(BROWSER_VIEW_GO_BACK_CHANNEL, (targetId) =>
			service.goBack(targetId)),
		targetRoute(BROWSER_VIEW_GO_FORWARD_CHANNEL, (targetId) =>
			service.goForward(targetId)),
		targetRoute(BROWSER_VIEW_RELOAD_CHANNEL, (targetId) =>
			service.reload(targetId)),
		targetRoute(BROWSER_VIEW_STOP_CHANNEL, (targetId) =>
			service.stop(targetId)),
		targetRoute(BROWSER_VIEW_FOCUS_CHANNEL, targetId => service.focus(targetId)),
		targetRoute(BROWSER_VIEW_CLOSE_CHANNEL, (targetId) =>
			service.destroyBrowserView(targetId)),
	];
}

function targetRoute(
	channel: string,
	invoke: (targetId: string) => Promise<void>,
): IpcRoute<unknown, unknown> {
	return {
		channel,
		validate: validateBrowserViewTargetRequest,
		invoke: (request) =>
			invoke((request as IBrowserViewTargetRequest).targetId),
	};
}
