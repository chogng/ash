import { Emitter } from '../../../../../base/common/event.js';
import { Disposable, toDisposable, type IDisposable } from '../../../../../base/common/lifecycle.js';
import type { ITerminalExternalLinkProvider } from '../../../terminal/browser/terminal.js';
import type { ITerminalLinkProviderService } from './links.js';
import { CancellationError } from '../../../../../base/common/errors.js';

export class TerminalLinkProviderService extends Disposable implements ITerminalLinkProviderService {
	private readonly providers = new Set<ITerminalExternalLinkProvider>();
	private readonly added = this._register(new Emitter<ITerminalExternalLinkProvider>());
	private readonly removed = this._register(new Emitter<ITerminalExternalLinkProvider>());
	readonly onDidAddLinkProvider = this.added.event;
	readonly onDidRemoveLinkProvider = this.removed.event;
	get linkProviders(): ReadonlySet<ITerminalExternalLinkProvider> { return this.providers; }

	registerLinkProvider(provider: ITerminalExternalLinkProvider): IDisposable {
		if (this.isDisposed) throw new CancellationError();
		if (this.providers.has(provider)) throw new Error('Terminal link provider is already registered');
		this.providers.add(provider);
		this.added.fire(provider);
		return toDisposable(() => {
			if (this.providers.delete(provider)) this.removed.fire(provider);
		});
	}

	protected override disposeCore(): void {
		this.providers.clear();
		super.disposeCore();
	}
}
