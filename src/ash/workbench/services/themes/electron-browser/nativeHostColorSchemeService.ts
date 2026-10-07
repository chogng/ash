import { Emitter } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import type { IColorScheme } from '../../../../platform/window/common/window.js';
import { INativeHostService } from '../../../common/services.js';
import type { IHostColorSchemeService } from '../common/hostColorSchemeService.js';

/** The initial scheme is read before Workbench creation; subsequent changes arrive from Main. */
export class NativeHostColorSchemeService extends Disposable implements IHostColorSchemeService {
	private revision = 0;
	private readonly changed = this._register(new Emitter<void>());
	public readonly onDidChangeColorScheme = this.changed.event;
	constructor(private scheme: IColorScheme, @INativeHostService private readonly host: INativeHostApi) {
		super();
		const subscription = this.host.onDidChangeColorScheme(scheme => {
			this.revision++;
			if (scheme.dark === this.dark && scheme.highContrast === this.highContrast) { return; }
			this.scheme = scheme;
			this.changed.fire();
		});
		this._register(toDisposable(() => subscription.dispose()));
	}
	public async initialize(): Promise<void> {
		// A system event received during the read is newer than its reply.
		const revision = this.revision;
		const scheme = await this.host.getOSColorScheme();
		if (this.isDisposed || revision !== this.revision || scheme.dark === this.dark && scheme.highContrast === this.highContrast) { return; }
		this.scheme = scheme;
		this.changed.fire();
	}
	public get dark(): boolean { return this.scheme.dark; }
	public get highContrast(): boolean { return this.scheme.highContrast; }
}
