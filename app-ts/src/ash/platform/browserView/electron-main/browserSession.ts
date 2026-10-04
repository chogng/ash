import type { Session, Event as ElectronEvent } from 'electron/main';
import { BrowserViewStorageScope } from '../common/browserView.js';

/** Storage and permission policy have the Electron session's lifetime, independent of any page. */
export class BrowserSession {
	private static readonly sessions = new WeakMap<Session, BrowserSession>();

	private constructor(
		public readonly id: string,
		public readonly storageScope: BrowserViewStorageScope,
		public readonly electronSession: Session,
	) {
		electronSession.setPermissionCheckHandler(() => false);
		electronSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		electronSession.setDevicePermissionHandler(() => false);
		// Electron owns this listener. It captures no window or page and must outlive the last tab.
		electronSession.on('will-download', (event: ElectronEvent) => event.preventDefault());
	}

	public static getOrCreate(id: string, scope: BrowserViewStorageScope, electronSession: Session): BrowserSession {
		const existing = this.sessions.get(electronSession);
		if (existing) {
			if (existing.id !== id || existing.storageScope !== scope) {
				throw new Error('BrowserSessionIdentityConflict');
			}
			return existing;
		}
		const browserSession = new BrowserSession(id, scope, electronSession);
		this.sessions.set(electronSession, browserSession);
		return browserSession;
	}
}
