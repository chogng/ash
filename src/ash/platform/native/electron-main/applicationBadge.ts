import { APPLICATION_BADGE_CHANNEL, type IApplicationBadge } from '../common/native.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';

export function applicationBadgeIpcRoute(setBadge: (badge: IApplicationBadge) => void): IpcRoute<unknown, unknown> {
	return {
		channel: APPLICATION_BADGE_CHANNEL,
		validate(value) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid application badge');
			const { count, description, iconDataURL } = value as Partial<IApplicationBadge>;
			if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 2_147_483_647
				|| typeof description !== 'string' || description.length > 256) {
				throw new TypeError('Invalid application badge');
			}
			if (iconDataURL !== undefined) {
				const prefix = 'data:image/png;base64,';
				if (!count || typeof iconDataURL !== 'string' || iconDataURL.length > 16_384
					|| !iconDataURL.startsWith(prefix) || !/^[A-Za-z0-9+/]+={0,2}$/.test(iconDataURL.slice(prefix.length))) {
					throw new TypeError('Invalid application badge icon');
				}
				const png = Buffer.from(iconDataURL.slice(prefix.length), 'base64');
				if (png.length < 33 || png.subarray(0, 16).toString('hex') !== '89504e470d0a1a0a0000000d49484452'
					|| png.readUInt32BE(16) !== 32 || png.readUInt32BE(20) !== 32) {
					throw new TypeError('Invalid application badge icon dimensions');
				}
			}
			return { count, description, iconDataURL };
		},
		invoke: value => setBadge(value as IApplicationBadge),
	};
}
