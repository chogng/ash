import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import {
	TerminalCapability,
	type IShellEnvDetectionCapability,
	type TerminalShellIntegrationEnvironment,
} from './capabilities.js';

type Values = Map<string, string | undefined>;

/** Publishes complete committed transactions; a bad fragment cannot regain trust at the end. */
export class ShellEnvDetectionCapability extends Disposable implements IShellEnvDetectionCapability {
	readonly type = TerminalCapability.ShellEnvDetection;
	private values: Values | undefined;
	private trusted = false;
	private pending: { values: Values; trusted: boolean } | undefined;
	private readonly changed = this._register(new Emitter<TerminalShellIntegrationEnvironment>());
	readonly onDidChangeEnv = this.changed.event;
	get env(): TerminalShellIntegrationEnvironment {
		return {
			value: this.values === undefined ? undefined : Object.freeze(Object.fromEntries(this.values)),
			isTrusted: this.trusted,
		};
	}

	setEnvironment(values: { [key: string]: string | undefined } | undefined, isTrusted: boolean): void {
		this.pending = undefined;
		this.commit(
			values === undefined ? undefined : new Map(Object.entries(values)),
			values !== undefined && isTrusted,
		);
	}

	startEnvironmentSingleVar(clear: boolean, isTrusted: boolean): void {
		this.pending = {
			values: clear ? new Map() : new Map(this.values),
			trusted: isTrusted && (clear || this.values === undefined || this.trusted),
		};
	}

	setEnvironmentSingleVar(key: string, value: string | undefined, isTrusted: boolean): void {
		if (!this.pending) {
			return;
		}
		this.pending.values.set(key, value);
		this.pending.trusted &&= isTrusted;
	}

	deleteEnvironmentSingleVar(key: string, value: string | undefined, isTrusted: boolean): void {
		if (!this.pending || value === undefined) {
			return;
		}
		this.pending.values.delete(key);
		this.pending.trusted &&= isTrusted;
	}

	endEnvironmentSingleVar(isTrusted: boolean): void {
		const pending = this.pending;
		this.pending = undefined;
		if (pending) {
			this.commit(pending.values, pending.trusted && isTrusted);
		}
	}

	private commit(values: Values | undefined, trusted: boolean): void {
		const equal =
			values === undefined
				? this.values === undefined
				: this.values !== undefined &&
					values.size === this.values.size &&
					[...values].every(([key, value]) => this.values!.has(key) && this.values!.get(key) === value);
		if (equal && trusted === this.trusted) {
			return;
		}
		this.values = values;
		this.trusted = trusted;
		this.changed.fire(this.env);
	}

	protected override disposeCore(): void {
		this.pending = undefined;
		this.values = undefined;
		super.disposeCore();
	}
}
