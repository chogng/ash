import { Disposable } from '../../../../base/common/lifecycle.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import type { ILifecycleService } from '../../../../platform/lifecycle/common/lifecycleService.js';
import { WorkbenchModeRegistry, type WorkbenchModeId } from '../../../common/workbenchMode.js';
import { WorkbenchConfiguration } from '../../../common/configuration.js';
import type { IWorkbenchModeService, WorkbenchModeOption } from '../common/workbenchModeService.js';

export interface WorkbenchModeServiceOptions {
	readonly currentModeId: WorkbenchModeId;
	readonly configurationService: IConfigurationService;
	readonly lifecycleService: ILifecycleService;
	readonly switchHostMode: (modeId: WorkbenchModeId) => Promise<void>;
}

/** Persists a mode choice, flushes the Workbench, and asks its host to reload the window. */
export class WorkbenchModeService extends Disposable implements IWorkbenchModeService {
	public readonly currentModeId: WorkbenchModeId;
	public readonly availableModes: readonly WorkbenchModeOption[] = Object.freeze(WorkbenchModeRegistry.definitions.map(({ id, label }) => Object.freeze({ id, label })));
	private readonly configurationService: IConfigurationService;
	private readonly lifecycleService: ILifecycleService;
	private readonly switchHostMode: (modeId: WorkbenchModeId) => Promise<void>;
	private switchOperation: Promise<void> | undefined;

	constructor(options: WorkbenchModeServiceOptions) {
		super();
		this.currentModeId = options.currentModeId;
		this.configurationService = options.configurationService;
		this.lifecycleService = options.lifecycleService;
		this.switchHostMode = options.switchHostMode;
	}

	public switchMode(modeId: WorkbenchModeId): Promise<void> {
		if (modeId === this.currentModeId) return Promise.resolve();
		return this.startSwitch(modeId, false);
	}

	public resetMode(): Promise<void> {
		return this.startSwitch(WorkbenchModeRegistry.defaultModeId, true);
	}

	private startSwitch(modeId: WorkbenchModeId, reset: boolean): Promise<void> {
		if (this.switchOperation) return this.switchOperation;
		const operation = this.performSwitch(modeId, reset);
		this.switchOperation = operation;
		void operation.then(
			() => { if (this.switchOperation === operation) this.switchOperation = undefined; },
			() => { if (this.switchOperation === operation) this.switchOperation = undefined; },
		);
		return operation;
	}

	private async performSwitch(modeId: WorkbenchModeId, reset: boolean): Promise<void> {
		if (reset) await this.configurationService.updateValue(WorkbenchConfiguration.mode, undefined);
		else await this.configurationService.updateValue(WorkbenchConfiguration.mode, modeId);
		if (modeId === this.currentModeId) return;
		await this.lifecycleService.shutdown('reload');
		await this.switchHostMode(modeId);
	}
}
