import { Disposable } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { CancellationError } from '../../../../base/common/errors.js';
import {
	IUpdateService,
	type UpdateCheckResult,
	type UpdateReadyResult,
} from '../../../../platform/update/common/updateService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IHostService } from '../../host/browser/host.js';

export interface IUpdate {
	version: string;
}

/** The embedder owns deployment discovery; null means this page is already current. */
export interface IUpdateProvider {
	checkForUpdate(): Promise<IUpdate | null>;
}

/** Reads the running page's identity once, then probes the deployment without using a cached response. */
export function createWebUpdateProvider(document: Document): IUpdateProvider | undefined {
	const metadata = document.querySelector<HTMLMetaElement>('meta[name="ash-web-build"]');
	if (!metadata) return undefined; // Development and third-party embedders opt in separately.
	const currentVersion = metadata.content;
	const manifest = metadata.getAttribute('data-version-url');
	if (!/^[a-f0-9]{64}$/u.test(currentVersion) || !manifest) throw new TypeError('Invalid Web build metadata');
	const target = new URL(manifest, document.baseURI);
	if (target.origin !== document.location.origin) throw new TypeError('Web build metadata must use the page origin');
	const ownerWindow = document.defaultView!;
	return {
		async checkForUpdate(): Promise<IUpdate | null> {
			const response = await ownerWindow.fetch(target, {
				cache: 'no-store',
				credentials: 'same-origin',
				redirect: 'error',
				headers: { Accept: 'application/json' },
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok) throw new Error(`Web version request failed (${response.status})`);
			const result: unknown = await response.json();
			if (
				typeof result !== 'object' ||
				result === null ||
				!('version' in result) ||
				typeof result.version !== 'string' ||
				!/^[a-f0-9]{64}$/u.test(result.version)
			) {
				throw new TypeError('Invalid Web deployment version');
			}
			return result.version === currentVersion ? null : { version: result.version };
		},
	};
}

/** Uses the shared update contract without downloading a desktop package. */
export class BrowserUpdateService extends Disposable implements IUpdateService {
	readonly state = 'idle';
	readonly onDidChangeState = Event.None;
	private checking: Promise<UpdateCheckResult> | undefined;
	private available: IUpdate | undefined;

	constructor(
		@IBrowserWorkbenchEnvironmentService private readonly environment: IBrowserWorkbenchEnvironmentService,
		@IHostService private readonly host: IHostService,
	) {
		super();
	}

	public checkForUpdates(): Promise<UpdateCheckResult> {
		this.assertNotDisposed();
		if (this.checking) return this.checking;
		const provider = this.environment.options.updateProvider;
		if (!provider) return Promise.reject(new Error('The Web host has no update provider'));
		// Manual and startup checks share a request and cannot overwrite each other's result.
		const checking = Promise.resolve()
			.then(() => provider.checkForUpdate())
			.then(update => {
				if (this.isDisposed) throw new CancellationError();
				if (
					update !== null &&
					(typeof update !== 'object' || typeof update.version !== 'string' || !update.version.trim())
				) {
					throw new TypeError('Web update provider returned an invalid version');
				}
				this.available = update === null ? undefined : { version: update.version };
				return update === null
					? { status: 'current' as const }
					: { status: 'available' as const, version: update.version };
			})
			.finally(() => {
				this.checking = undefined;
			});
		this.checking = checking;
		return checking;
	}

	public checkAutomatically(): Promise<UpdateCheckResult | undefined> {
		return this.environment.options.updateProvider ? this.checkForUpdates() : Promise.resolve(undefined);
	}

	public async downloadUpdate(): Promise<UpdateReadyResult> {
		this.assertNotDisposed();
		// A deployed Web build is ready without a local package download.
		if (!this.available) throw new Error('No Web update is available');
		return { version: this.available.version };
	}

	public async installUpdate(): Promise<void> {
		this.assertNotDisposed();
		// The host preserves dirty editors and respects shutdown vetoes before reloading.
		await this.host.restart();
	}
}
