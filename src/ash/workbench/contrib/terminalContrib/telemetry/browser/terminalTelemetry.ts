import { Disposable, DisposableStore, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ITelemetryService } from '../../../../../platform/telemetry/common/telemetry.js';
import { TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { TerminalLocation } from '../../../../../platform/terminal/common/terminal.js';
import type { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILifecycleService } from '../../../../services/lifecycle/common/lifecycle.js';
import { ITerminalService, type ITerminalInstance } from '../../../terminal/browser/terminal.js';
import { TerminalProfileConfigurationTelemetry } from './terminalProfileConfigurationTelemetry.js';

/** Window-owned observation uses the host telemetry service, including its disabled implementation. */
export class TerminalTelemetryContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'terminalTelemetry';
	private readonly pending = new Map<ITerminalInstance, DisposableStore>();

	constructor(
		@ITerminalService terminals: ITerminalService,
		@ILifecycleService lifecycle: ILifecycleService,
		@IInstantiationService instantiation: IInstantiationService,
		@ITelemetryService private readonly telemetry: ITelemetryService,
	) {
		super();
		this._register(instantiation.createInstance(TerminalProfileConfigurationTelemetry));
		this._register(terminals.onDidCreateInstance(instance => this.observe(instance)));
		this._register(terminals.onDidDisposeInstance(instance => this.report(instance)));
		this._register(
			lifecycle.onWillShutdown(() => {
				for (const instance of [...this.pending.keys()]) this.report(instance);
			}),
		);
		for (const instance of terminals.instances) this.observe(instance);
	}

	private observe(instance: ITerminalInstance): void {
		if (this.pending.has(instance)) return;
		const lifetime = new DisposableStore();
		this.pending.set(instance, lifetime);
		const timer = setTimeout(() => this.report(instance), 10000);
		lifetime.add(toDisposable(() => clearTimeout(timer)));
		lifetime.add(instance.onDidExit(() => this.report(instance)));
	}

	private report(instance: ITerminalInstance): void {
		const lifetime = this.pending.get(instance);
		if (!lifetime || this.isDisposed) return;
		this.pending.delete(instance);
		lifetime.dispose();
		const commandDetection = instance.capabilities?.get(TerminalCapability.CommandDetection);
		this.telemetry.publicLog('terminal/createInstance', {
			location: instance.target === TerminalLocation.Editor ? 'editor' : 'view',
			shellType: instance.shellType ?? 'unknown',
			isCustomPtyImplementation: !!instance.shellLaunchConfig?.customPtyImplementation,
			shellIntegrationQuality: commandDetection?.hasRichCommandDetection ? 2 : commandDetection ? 1 : 0,
		});
	}

	protected override disposeCore(): void {
		for (const lifetime of this.pending.values()) lifetime.dispose();
		this.pending.clear();
		super.disposeCore();
	}
}
