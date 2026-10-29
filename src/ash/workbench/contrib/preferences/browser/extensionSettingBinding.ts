import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IServerEventApi } from '../../../../platform/agentHost/common/appServerApi.js';
import type { IRegisteredConfiguration } from '../../../../platform/configuration/common/configurationRegistry.js';
import type { SettingValueBinding } from '../../../services/preferences/common/preferences.js';
import { ILogService } from '../../../../platform/log/common/log.js';

/** UI read model for a setting whose extension owns persistence and validation. */
export class ExtensionSettingBinding extends Disposable implements SettingValueBinding<unknown> {
	private readonly changed = this._register(new Emitter<void>());
	readonly onDidChange = this.changed.event;
	private value: unknown;
	private generation = 0;
	readonly id: string;
	readonly defaultValue: unknown;
	constructor(
		private readonly configuration: IRegisteredConfiguration,
		@ICommandService private readonly commands: ICommandService,
		@IServerEventApi events: IServerEventApi,
		@ILogService private readonly log: ILogService,
	) {
		super();
		this.id = configuration.key;
		this.value = this.defaultValue = configuration.defaultValue;
		const refresh = (): void => {
			void this.read().catch(error => {
				if (!this.isDisposed) this.log.error('extensions', 'Cannot read extension setting', error);
			});
		};
		const listener = events.subscribe(event => {
			if (event.method === 'config/changed') refresh();
		});
		this._register(toDisposable(() => listener.dispose()));
		this._register(CommandsRegistry.onDidChangeCommands(refresh));
		refresh();
	}
	getValue(): unknown {
		return this.value;
	}
	private async read(): Promise<void> {
		const binding = this.configuration.extensionBinding!;
		const generation = ++this.generation;
		if (!CommandsRegistry.hasCommand(binding.readCommand)) return;
		const result: unknown = await this.commands.executeCommand(binding.readCommand);
		if (this.isDisposed || generation !== this.generation) return;
		if (!result || typeof result !== 'object' || !(binding.property in result))
			throw new TypeError('Extension setting read result is invalid');
		this.value = this.configuration.parse((result as Record<string, unknown>)[binding.property]);
		this.changed.fire();
	}
	async updateValue(value: unknown): Promise<void> {
		const binding = this.configuration.extensionBinding!;
		await this.commands.executeCommand(binding.writeCommand, this.configuration.parse(value));
		await this.read();
	}
	async resetValue(): Promise<void> {
		await this.updateValue(this.defaultValue);
	}
}
