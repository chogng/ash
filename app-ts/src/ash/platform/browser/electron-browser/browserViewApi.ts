import { BROWSER_VIEW_CLOSE_CHANNEL, BROWSER_VIEW_CREATE_CHANNEL, BROWSER_VIEW_EVENT_CHANNEL, BROWSER_VIEW_GO_BACK_CHANNEL, BROWSER_VIEW_GO_FORWARD_CHANNEL, BROWSER_VIEW_LAYOUT_CHANNEL, BROWSER_VIEW_NAVIGATE_CHANNEL, BROWSER_VIEW_RELOAD_CHANNEL, BROWSER_VIEW_STATE_CHANNEL, BROWSER_VIEW_STOP_CHANNEL, BROWSER_VIEW_VISIBILITY_CHANNEL, type BrowserViewEvent, type IBrowserViewApi, type IBrowserViewState } from "../common/browserView.js";
import { invoke, subscribe } from "../../ipc/electron-browser/rendererIpc.js";
import { BROWSER_VIEW_FOCUS_CHANNEL } from '../common/browserView.js';

export function createBrowserViewApi(): IBrowserViewApi {
	return {
		create: (request) => invoke<IBrowserViewState>(BROWSER_VIEW_CREATE_CHANNEL, request),
		getState: (request) => invoke<IBrowserViewState>(BROWSER_VIEW_STATE_CHANNEL, request),
		layout: (request) => invoke<void>(BROWSER_VIEW_LAYOUT_CHANNEL, request),
		setVisibility: (request) => invoke<void>(BROWSER_VIEW_VISIBILITY_CHANNEL, request),
		navigate: (request) => invoke<void>(BROWSER_VIEW_NAVIGATE_CHANNEL, request),
		goBack: (request) => invoke<void>(BROWSER_VIEW_GO_BACK_CHANNEL, request),
		goForward: (request) => invoke<void>(BROWSER_VIEW_GO_FORWARD_CHANNEL, request),
		reload: (request) => invoke<void>(BROWSER_VIEW_RELOAD_CHANNEL, request),
		stop: (request) => invoke<void>(BROWSER_VIEW_STOP_CHANNEL, request),
		focus: request => invoke<void>(BROWSER_VIEW_FOCUS_CHANNEL, request),
		close: (request) => invoke<void>(BROWSER_VIEW_CLOSE_CHANNEL, request),
		onDidEvent: (listener) => subscribe<BrowserViewEvent>(BROWSER_VIEW_EVENT_CHANNEL, listener),
	};
}
