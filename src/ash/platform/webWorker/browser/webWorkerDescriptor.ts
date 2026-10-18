import type { URI } from '../../../base/common/uri.js';
import type { WebWorkerChannel } from '../../../base/common/worker/webWorker.js';

/** Module locations are resolved only when the owning caller first needs its Worker. */
export class WebWorkerDescriptor {
	readonly esmModuleLocation: URI | (() => URI) | undefined;
	readonly esmModuleLocationBundler: URL | (() => URL) | undefined;
	readonly label: string;
	/** Ash message protocols retain their version and independent cancellation IDs. */
	readonly channel: WebWorkerChannel | undefined;
	/** Keep Vite's statically analyzable Worker entry at its domain owner. */
	readonly createWorker: (() => Worker | Promise<Worker>) | undefined;

	constructor(args: {
		esmModuleLocation?: URI | (() => URI);
		esmModuleLocationBundler?: URL | (() => URL);
		label: string;
		channel?: WebWorkerChannel;
		createWorker?: () => Worker | Promise<Worker>;
	}) {
		this.esmModuleLocation = args.esmModuleLocation;
		this.esmModuleLocationBundler = args.esmModuleLocationBundler;
		this.label = args.label;
		this.channel = args.channel;
		this.createWorker = args.createWorker;
	}
}
