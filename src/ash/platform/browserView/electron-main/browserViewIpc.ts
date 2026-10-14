import type { Event } from '../../../base/common/event.js';
import type { IChannel, IServerChannel } from '../../../base/parts/ipc/common/ipc.js';
import type {
	IpcRoute,
} from "../../ipc/electron-main/trustedIpcRouter.js";
import {
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
import { isRecord } from '../../../base/common/types.js';

/** The page owner stays in Main; sharing is authorized by the window's app-server adapter. */
export function browserViewChannel(service: IBrowserViewService, sharing: IChannel): IServerChannel<string> {
	const routes = new Map(browserViewIpcRoutes(service).map(route => [route.channel, route]));
	const parameters = new Map<string, readonly string[]>([
		['getBrowserViews', []],
		['getOrCreateBrowserView', ['targetId', 'options']],
		['getState', ['targetId']],
		['layout', ['targetId', 'bounds']],
		['setVisible', ['targetId', 'visible']],
		['loadURL', ['targetId', 'url']],
		['getBrowserHistory', ['targetId']],
		['deleteBrowserHistory', ['targetId', 'entryIds']],
		['getSharing', ['targetId']],
		['respondToPermission', ['targetId', 'requestId', 'allowed']],
		...['goBack', 'goForward', 'reload', 'stop', 'focus', 'destroyBrowserView', 'clearPermissions', 'cancelDownloads'].map(command => [command, ['targetId']] as const),
	]);
	return {
		call: async <T>(_context: string, command: string, arg: unknown): Promise<T> => {
			if (command === 'setSharing') {
				if (!Array.isArray(arg) || arg.length !== 2) { throw new TypeError('Invalid browser sharing arguments'); }
				validateBrowserViewTargetRequest({ targetId: arg[0] });
				return sharing.call<T>(command, arg);
			}
			const route = routes.get(command);
			const keys = parameters.get(command);
			if (!route || !keys) { throw new Error('Unknown browser view command: ' + command); }
			const minimum = command === 'deleteBrowserHistory' ? 1 : keys.length;
			if (!Array.isArray(arg) || arg.length < minimum || arg.length > keys.length) { throw new TypeError('Invalid browser view arguments'); }
			// JSON encodes an explicitly omitted positional argument as null.
			const values = command === 'deleteBrowserHistory' && arg[1] === null ? [arg[0], undefined] : arg;
			const request = keys.length ? Object.fromEntries(keys.map((key, index) => [key, values[index]])) : undefined;
			return await route.invoke(route.validate(request)) as T;
		},
		listen: <T>(_context: string, event: string, arg: unknown): Event<T> => {
			if (event !== 'onDidEvent' || arg !== undefined) { throw new Error('Unknown browser view event: ' + event); }
			return service.onDidEvent as Event<T>;
		},
	};
}

/** Validates page commands before they reach the main-owned view. */
function browserViewIpcRoutes(
	service: Omit<IBrowserViewService, 'onDidEvent'>,
): readonly IpcRoute<unknown, unknown>[] {
	return [
		{ channel: 'getBrowserHistory', validate: validateBrowserViewTargetRequest, invoke: value => service.getBrowserHistory((value as IBrowserViewTargetRequest).targetId) },
		{
			channel: 'deleteBrowserHistory',
			validate: value => {
				if (!isRecord(value) || Object.keys(value).some(key => key !== 'targetId' && key !== 'entryIds')) { throw new TypeError('Invalid browser history request'); }
				if (value.entryIds !== undefined && (!Array.isArray(value.entryIds) || value.entryIds.length > 200 || value.entryIds.some(id => !Number.isSafeInteger(id) || id < 1))) { throw new TypeError('Invalid browser history entries'); }
				return { ...validateBrowserViewTargetRequest({ targetId: value.targetId }), entryIds: value.entryIds };
			},
			invoke: value => { const request = value as IBrowserViewTargetRequest & { entryIds?: number[]; }; return service.deleteBrowserHistory(request.targetId, request.entryIds); },
		},
		{
			channel: 'respondToPermission', validate: value => {
				if (!isRecord(value) || Object.keys(value).length !== 3 || typeof value.requestId !== 'string' || typeof value.allowed !== 'boolean') { throw new TypeError('Invalid browser permission response'); }
				return { ...validateBrowserViewTargetRequest({ targetId: value.targetId }), requestId: value.requestId, allowed: value.allowed };
			}, invoke: value => { const request = value as { targetId: string; requestId: string; allowed: boolean; }; return service.respondToPermission(request.targetId, request.requestId, request.allowed); }
		},
		targetRoute('clearPermissions', id => service.clearPermissions(id)),
		targetRoute('cancelDownloads', id => service.cancelDownloads(id)),
		{ channel: 'getSharing', validate: validateBrowserViewTargetRequest, invoke: request => service.getSharing((request as IBrowserViewTargetRequest).targetId) },
		{
			channel: 'getBrowserViews',
			validate: value => {
				if (value !== undefined) { throw new TypeError('Browser list does not accept parameters'); }
				return undefined;
			},
			invoke: () => service.getBrowserViews(),
		},
		{
			channel: 'getOrCreateBrowserView',
			validate: validateBrowserViewCreateRequest,
			invoke: (request) =>
				service.getOrCreateBrowserView((request as IBrowserViewCreateRequest).targetId, (request as IBrowserViewCreateRequest).options),
		},
		{
			channel: 'getState',
			validate: validateBrowserViewTargetRequest,
			invoke: (request) =>
				service.getState((request as IBrowserViewTargetRequest).targetId),
		},
		{
			channel: 'layout',
			validate: validateBrowserViewLayoutRequest,
			invoke: (request) =>
				service.layout((request as IBrowserViewLayoutRequest).targetId, (request as IBrowserViewLayoutRequest).bounds),
		},
		{
			channel: 'setVisible',
			validate: validateBrowserViewVisibilityRequest,
			invoke: (request) =>
				service.setVisible((request as IBrowserViewVisibilityRequest).targetId, (request as IBrowserViewVisibilityRequest).visible),
		},
		{
			channel: 'loadURL',
			validate: validateBrowserViewNavigateRequest,
			invoke: (request) =>
				service.loadURL((request as IBrowserViewNavigateRequest).targetId, (request as IBrowserViewNavigateRequest).url),
		},
		targetRoute('goBack', (targetId) =>
			service.goBack(targetId)),
		targetRoute('goForward', (targetId) =>
			service.goForward(targetId)),
		targetRoute('reload', (targetId) =>
			service.reload(targetId)),
		targetRoute('stop', (targetId) =>
			service.stop(targetId)),
		targetRoute('focus', targetId => service.focus(targetId)),
		targetRoute('destroyBrowserView', (targetId) =>
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
