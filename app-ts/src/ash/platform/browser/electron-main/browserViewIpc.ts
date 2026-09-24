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
	type IBrowserViewState,
	validateBrowserViewCreateRequest,
	validateBrowserViewLayoutRequest,
	validateBrowserViewNavigateRequest,
	validateBrowserViewTargetRequest,
	validateBrowserViewVisibilityRequest,
} from "../common/browserView.js";

/** Main-process operations exposed through trusted browser-view IPC routes. */
export interface IBrowserViewMainService {
	createTarget(request: IBrowserViewCreateRequest): Promise<IBrowserViewState>;
	observe(targetId: string): IBrowserViewState;
	layout(request: IBrowserViewLayoutRequest): void;
	setVisibility(request: IBrowserViewVisibilityRequest): void;
	navigate(request: IBrowserViewNavigateRequest): Promise<void>;
	goBack(targetId: string): void;
	goForward(targetId: string): void;
	reload(targetId: string): void;
	stop(targetId: string): void;
	focus(targetId: string): void;
	close(targetId: string): void;
}

/** Binds the main-owned browser-view service to trusted workbench IPC. */
export function browserViewIpcRoutes(
	service: IBrowserViewMainService,
): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: BROWSER_VIEW_CREATE_CHANNEL,
			validate: validateBrowserViewCreateRequest,
			invoke: (request) =>
				service.createTarget(request as IBrowserViewCreateRequest),
		},
		{
			channel: BROWSER_VIEW_STATE_CHANNEL,
			validate: validateBrowserViewTargetRequest,
			invoke: (request) =>
				service.observe((request as IBrowserViewTargetRequest).targetId),
		},
		{
			channel: BROWSER_VIEW_LAYOUT_CHANNEL,
			validate: validateBrowserViewLayoutRequest,
			invoke: (request) =>
				service.layout(request as IBrowserViewLayoutRequest),
		},
		{
			channel: BROWSER_VIEW_VISIBILITY_CHANNEL,
			validate: validateBrowserViewVisibilityRequest,
			invoke: (request) =>
				service.setVisibility(request as IBrowserViewVisibilityRequest),
		},
		{
			channel: BROWSER_VIEW_NAVIGATE_CHANNEL,
			validate: validateBrowserViewNavigateRequest,
			invoke: (request) =>
				service.navigate(request as IBrowserViewNavigateRequest),
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
			service.close(targetId)),
	];
}

function targetRoute(
	channel: string,
	invoke: (targetId: string) => void,
): IpcRoute<unknown, unknown> {
	return {
		channel,
		validate: validateBrowserViewTargetRequest,
		invoke: (request) =>
			invoke((request as IBrowserViewTargetRequest).targetId),
	};
}
