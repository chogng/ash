import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';

export type PermissionDecision = 'allow' | 'deny';
export interface IPermissionCategoryState {
	readonly category: PermissionCategory;
	readonly state: PermissionDecision | null;
}
export interface ISerializedBrowserPermissionsSnapshot {
	readonly origins: Readonly<Record<string, Partial<Record<PermissionCategory, PermissionDecision>>>>;
}

export const enum PermissionCategory {
	Location = 'location',
	Camera = 'camera',
	Microphone = 'microphone',
	Notifications = 'notifications',
	Sensors = 'sensors',
	Clipboard = 'clipboard',
	Devices = 'devices',
}

/** Opaque and malformed documents cannot own reusable site permissions. */
export function toOriginKey(url: string | undefined | null): string {
	if (!url) {
		return '';
	}
	try {
		const origin = new URL(url).origin;
		return origin === 'null' ? '' : origin;
	} catch {
		return '';
	}
}

export function electronPermissionToCategories(permission: string, mediaKinds?: ReadonlyArray<'video' | 'audio'>): PermissionCategory[] {
	switch (permission) {
		case 'geolocation':
		case 'geolocation-approximate':
			return [PermissionCategory.Location];
		case 'notifications':
			return [PermissionCategory.Notifications];
		case 'sensors':
			return [PermissionCategory.Sensors];
		case 'clipboard-read':
		case 'clipboard-sanitized-write':
			return [PermissionCategory.Clipboard];
		case 'usb':
		case 'serial':
		case 'hid':
			return [PermissionCategory.Devices];
		case 'media':
			return [...new Set((mediaKinds ?? ['video', 'audio']).map(kind => (kind === 'video' ? PermissionCategory.Camera : PermissionCategory.Microphone)))];
		default:
			return [];
	}
}

/** One store owns requesting-origin decisions for a single embedding origin. */
export class BrowserPermissionStore extends Disposable {
	private readonly decisions = new Map<string, Map<PermissionCategory, PermissionDecision>>();
	private readonly changes = this._register(new Emitter<void>());
	readonly onDidChange = this.changes.event;

	getDecision(origin: string, category: PermissionCategory): PermissionDecision | undefined {
		return this.decisions.get(toOriginKey(origin))?.get(category);
	}

	set(origin: string, category: PermissionCategory, decision: PermissionDecision | null): void {
		const key = toOriginKey(origin);
		if (!key || this.getDecision(key, category) === (decision ?? undefined)) {
			return;
		}
		let grants = this.decisions.get(key);
		if (decision === null) {
			grants?.delete(category);
			if (!grants?.size) {
				this.decisions.delete(key);
			}
		} else {
			if (!grants) {
				grants = new Map();
				this.decisions.set(key, grants);
			}
			grants.set(category, decision);
		}
		this.changes.fire();
	}

	serialize(): ISerializedBrowserPermissionsSnapshot {
		return {
			origins: Object.fromEntries([...this.decisions].map(([origin, values]) => [origin, Object.fromEntries(values)])),
		};
	}
	clear(): void {
		if (!this.decisions.size) {
			return;
		}
		this.decisions.clear();
		this.changes.fire();
	}
}
