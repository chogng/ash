import { toOriginKey, type IPermissionCategoryState } from '../common/browserPermissions.js';
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
import type { IBrowserViewWindowConfiguration, IBrowserElementSelectionOptions, IBrowserElementCommentsUpdate, IBrowserViewCaptureScreenshotOptions, IBrowserViewFindInPageOptions } from '../common/browserView.js';
import { browserZoomFactors, type IBrowserDeviceProfile } from '../common/browserView.js';

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
			if (command === 'respondToPasswordSave' || command === 'respondToPasswordFill') {
				if (!Array.isArray(arg) || arg.length !== 3 || typeof arg[1] !== 'string' || !/^[a-f0-9-]{36}$/u.test(arg[1])) { throw new TypeError('Invalid password response'); }
				const { targetId } = validateBrowserViewTargetRequest({ targetId: arg[0] });
				if (command === 'respondToPasswordSave' && typeof arg[2] === 'boolean') { return await service.respondToPasswordSave(targetId, arg[1], arg[2]) as T; }
				if (command === 'respondToPasswordFill' && (arg[2] === null || typeof arg[2] === 'string' && /^browser\.passwords\.[a-f0-9]{64}\.[a-f0-9]{64}$/u.test(arg[2]))) { return await service.respondToPasswordFill(targetId, arg[1], arg[2]) as T; }
				throw new TypeError('Invalid password response');
			}
			if (command === 'respondToAuthentication') {
				if (!Array.isArray(arg) || arg.length !== 3 || typeof arg[1] !== 'string' || !/^[a-f0-9-]{36}$/u.test(arg[1])) { throw new TypeError('Invalid browser authentication response'); }
				const { targetId } = validateBrowserViewTargetRequest({ targetId: arg[0] });
				const credentials = arg[2];
				if (credentials !== null && (!isRecord(credentials) || Object.keys(credentials).some(key => !['username', 'password', 'remember'].includes(key))
					|| typeof credentials.username !== 'string' || credentials.username.length > 4096 || /[\x00-\x1f\x7f]/u.test(credentials.username)
					|| typeof credentials.password !== 'string' || credentials.password.length > 4096 || /[\x00\r\n]/u.test(credentials.password)
					|| typeof credentials.remember !== 'boolean')) { throw new TypeError('Invalid browser authentication response'); }
				return await service.respondToAuthentication(targetId, arg[1], credentials as { username: string; password: string; remember: boolean; } | null) as T;
			}
			if (command === 'setContentVisibility') {
				if (!Array.isArray(arg) || arg.length !== 2) { throw new TypeError('Invalid browser rendering rule'); }
				const { targetId } = validateBrowserViewTargetRequest({ targetId: arg[0] });
				const rule = arg[1] ?? undefined;
				if (rule !== undefined && (!isRecord(rule) || Object.keys(rule).some(key => !['origin', 'selector'].includes(key))
					|| typeof rule.origin !== 'string' || rule.origin.length > 2048
					|| !(rule.origin.startsWith('https://') && toOriginKey(rule.origin) === rule.origin)
					|| typeof rule.selector !== 'string' || !rule.selector || rule.selector.length > 1024)) {
					throw new TypeError('Invalid browser rendering rule');
				}
				return await service.setContentVisibility(targetId, rule as import('../common/browserView.js').IBrowserContentVisibilityRule | undefined) as T;
			}
			if (command === 'setPermissions') {
				if (!Array.isArray(arg) || arg.length !== 3 || typeof arg[1] !== 'string' || arg[1].length > 8192 || toOriginKey(arg[1]) !== arg[1] || !arg[1] || !Array.isArray(arg[2]) || arg[2].length > 7 || arg[2].some(value => !isRecord(value) || Object.keys(value).some(key => !['category', 'state'].includes(key)) || !['location', 'camera', 'microphone', 'notifications', 'sensors', 'clipboard', 'devices'].includes(value.category as string) || !['allow', 'deny', null].includes(value.state as string | null))) { throw new TypeError('Invalid browser site permissions'); }
				const { targetId } = validateBrowserViewTargetRequest({ targetId: arg[0] });
				return await service.setPermissions(targetId, arg[1], arg[2] as IPermissionCategoryState[]) as T;
			}
			if (command === 'reload') {
				if (!Array.isArray(arg) || arg.length < 1 || arg.length > 2 || (arg[1] != null && typeof arg[1] !== 'boolean')) { throw new TypeError('Invalid browser reload arguments'); }
				const { targetId } = validateBrowserViewTargetRequest({ targetId: arg[0] });
				return await service.reload(targetId, arg[1] ?? undefined) as T;
			}
			if (command === 'respondToFileRequest') {
				if (!Array.isArray(arg) || arg.length !== 3 || typeof arg[1] !== 'string' || !/^[a-f0-9-]{36}$/.test(arg[1]) || (arg[2] !== null && (typeof arg[2] !== 'string' || arg[2].length > 24 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(arg[2])))) { throw new TypeError('Invalid browser file response'); }
				const { targetId } = validateBrowserViewTargetRequest({ targetId: arg[0] });
				return await service.respondToFileRequest(targetId, arg[1], arg[2]) as T;
			}
			if (['toggleDevTools', 'clearStorage', 'setBrowserZoomIndex', 'setDeviceEmulation'].includes(command)) {
				const arity = command === 'toggleDevTools' || command === 'clearStorage' ? 1 : 2;
				if (!Array.isArray(arg) || arg.length !== arity) { throw new TypeError('Invalid browser presentation arguments'); }
				const { targetId } = validateBrowserViewTargetRequest({ targetId: arg[0] });
				if (command === 'toggleDevTools') { return await service.toggleDevTools(targetId) as T; }
				if (command === 'clearStorage') { return await service.clearStorage(targetId) as T; }
				if (command === 'setBrowserZoomIndex') {
					if (!Number.isInteger(arg[1]) || arg[1] < 0 || arg[1] >= browserZoomFactors.length) { throw new TypeError('Invalid browser zoom index'); }
					return await service.setBrowserZoomIndex(targetId, arg[1]) as T;
				}
				const device = arg[1] ?? undefined;
				if (device !== undefined && (!isRecord(device)
					|| Object.keys(device).some(key => !['width', 'height', 'mobile', 'deviceScaleFactor', 'userAgent'].includes(key))
					|| ['width', 'height'].some(key => device[key] !== undefined && (!Number.isInteger(device[key]) || (device[key] as number) < 1 || (device[key] as number) > 8192))
					|| (device.deviceScaleFactor !== undefined && (typeof device.deviceScaleFactor !== 'number' || !Number.isFinite(device.deviceScaleFactor) || device.deviceScaleFactor <= 0 || device.deviceScaleFactor > 5))
					|| (device.mobile !== undefined && typeof device.mobile !== 'boolean')
					|| (device.userAgent !== undefined && (typeof device.userAgent !== 'string' || device.userAgent.length > 2048 || /[\r\n]/u.test(device.userAgent))))) { throw new TypeError('Invalid browser device profile'); }
				return await service.setDeviceEmulation(targetId, device as IBrowserDeviceProfile | undefined) as T;
			}
			const preloadResult = callPreloadService(service, command, arg);
			if (preloadResult) { return await preloadResult as T; }
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

/** This IPC boundary validates the renderer's page commands; preload messages have a separate frame boundary. */
function callPreloadService(service: IBrowserViewService, command: string, value: unknown): Promise<unknown> | undefined {
	const arity: Record<string, readonly [number, number]> = {
		updateWindowConfiguration: [2, 2],
		getConsoleLogs: [1, 1], getSelectedText: [1, 1],
		findInPage: [2, 3],
		stopFindInPage: [1, 2],
		toggleElementSelection: [1, 3],
		setElementComments: [2, 2],
		toggleAreaSelection: [1, 2],
		captureScreenshot: [1, 2],
	};
	const count = Object.hasOwn(arity, command) ? arity[command] : undefined;
	if (!count) {
		return undefined;
	}
	const invalid = (): never => {
		throw new TypeError('Invalid browser preload command: ' + command);
	};
	if (!Array.isArray(value) || value.length < count[0] || value.length > count[1]) {
		invalid();
	}
	const args = value as unknown[];
	if (command === 'updateWindowConfiguration') {
		const configuration = args[1];
		if (
			!Number.isSafeInteger(args[0]) ||
			!isRecord(configuration) ||
			!isRecord(configuration.theme) ||
			!isRecord(configuration.localizedStrings) ||
			Object.values(configuration.theme).some((value) => typeof value !== 'string' || value.length > 256) ||
			Object.values(configuration.localizedStrings).some((value) => typeof value !== 'string' || value.length > 2048) ||
			[
				'addComment',
				'addCommentPlaceholder',
				'commentOnSelectedElement',
				'elementComment',
				'elementCommentWithBody',
				'emptyElementComment',
				'removeComment',
				'removeElementComment',
				'cancel',
				'selectionHelp',
			].some((key) => typeof (configuration.localizedStrings as Record<string, unknown>)[key] !== 'string')
		) {
			invalid();
		}
		return service.updateWindowConfiguration(args[0] as number, configuration as unknown as IBrowserViewWindowConfiguration);
	}
	const { targetId } = validateBrowserViewTargetRequest({ targetId: args[0] });
	const options = args[2] ?? undefined;
	if (command === 'getConsoleLogs') { return service.getConsoleLogs(targetId); }
	if (command === 'getSelectedText') {
		return service.getSelectedText(targetId);
	}
	if (command === 'findInPage') {
		if (
			typeof args[1] !== 'string' ||
			!args[1] ||
			args[1].length > 65536 ||
			(options !== undefined &&
				(!isRecord(options) ||
					Object.keys(options).some((key) => !['forward', 'matchCase', 'recompute'].includes(key)) ||
					Object.values(options).some((value) => typeof value !== 'boolean')))
		) {
			invalid();
		}
		return service.findInPage(targetId, args[1] as string, options as IBrowserViewFindInPageOptions | undefined);
	}
	if (command === 'stopFindInPage' || command === 'toggleAreaSelection' || command === 'toggleElementSelection') {
		if (args[1] != null && typeof args[1] !== 'boolean') {
			invalid();
		}
		if (command === 'stopFindInPage') {
			return service.stopFindInPage(targetId, (args[1] ?? undefined) as boolean | undefined);
		}
		if (command === 'toggleAreaSelection') {
			return service.toggleAreaSelection(targetId, args[1] as boolean | undefined);
		}
		if (
			options !== undefined &&
			(!isRecord(options) ||
				Object.keys(options).some((key) => !['highlightFocusedElement', 'continuous', 'mode'].includes(key)) ||
				['highlightFocusedElement', 'continuous'].some(
					(key) => options[key] !== undefined && typeof options[key] !== 'boolean',
				) ||
				(options.mode !== undefined && options.mode !== 'select' && options.mode !== 'comment'))
		) {
			invalid();
		}
		return service.toggleElementSelection(
			targetId,
			(args[1] ?? undefined) as boolean | undefined,
			options as IBrowserElementSelectionOptions | undefined,
		);
	}
	if (command === 'setElementComments') {
		const update = args[1];
		if (
			!isRecord(update) ||
			Object.keys(update).some((key) => !['comments', 'pendingCommentIdsToDiscard'].includes(key)) ||
			(update.comments !== undefined &&
				(!Array.isArray(update.comments) ||
					update.comments.length > 100 ||
					update.comments.some(
						(item) =>
							!isRecord(item) ||
							typeof item.elementId !== 'string' ||
							item.elementId.length > 140 ||
							typeof item.body !== 'string' ||
							item.body.length > 2048,
					))) ||
			(update.pendingCommentIdsToDiscard !== undefined &&
				(!Array.isArray(update.pendingCommentIdsToDiscard) ||
					update.pendingCommentIdsToDiscard.length > 100 ||
					update.pendingCommentIdsToDiscard.some((id) => typeof id !== 'string' || id.length > 140)))
		) {
			invalid();
		}
		return service.setElementComments(targetId, update as IBrowserElementCommentsUpdate);
	}
	const capture: unknown = args[1] ?? {};
	if (!isRecord(capture)) {
		return invalid();
	}
	if (
		!isRecord(capture) ||
		Object.keys(capture).some((key) => !['screenRect', 'format', 'quality', 'awaitNextPaint', 'fullPage'].includes(key)) ||
		(capture.format !== undefined && capture.format !== 'png' && capture.format !== 'jpeg') ||
		(capture.quality !== undefined &&
			(typeof capture.quality !== 'number' ||
				!Number.isInteger(capture.quality) ||
				capture.quality < 0 ||
				capture.quality > 100)) ||
		(capture.fullPage !== undefined && typeof capture.fullPage !== 'boolean') ||
		(capture.awaitNextPaint !== undefined && typeof capture.awaitNextPaint !== 'boolean')
	) {
		invalid();
	}
	if (capture.screenRect !== undefined) {
		const rect = capture.screenRect;
		if (
			!isRecord(rect) ||
			['x', 'y', 'width', 'height'].some(
				(key) => typeof rect[key] !== 'number' || !Number.isFinite(rect[key]) || rect[key] < 0 || rect[key] > 8192,
			) ||
			!rect.width ||
			!rect.height ||
			(rect.width as number) * (rect.height as number) > 16_777_216
		) {
			invalid();
		}
	}
	return service.captureScreenshot(targetId, capture as IBrowserViewCaptureScreenshotOptions);
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
