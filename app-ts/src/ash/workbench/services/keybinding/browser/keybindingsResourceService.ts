import { Emitter } from "../../../../base/common/event.js";
import {
	Disposable,
	toDisposable,
} from "../../../../base/common/lifecycle.js";
import {
	type IKeybindingEntry,
	type IKeybindingsResourceApi,
	type IKeybindingsResourceService,
	type IKeybindingsResourceSnapshot,
	validateKeybindingsResource,
	validateKeybindingsResourceSnapshot,
} from "../../../../platform/keybinding/common/keybindingsResource.js";

export interface WorkbenchKeybindingsResourceServiceOptions {
	readonly api?: IKeybindingsResourceApi;
	readonly onError?: (error: unknown) => void;
}

/**
 * Window projection of the active host-authoritative `keybindings.json`.
 */
export class WorkbenchKeybindingsResourceService
	extends Disposable
	implements IKeybindingsResourceService {
	private readonly api: IKeybindingsResourceApi | undefined;
	private readonly onError: (error: unknown) => void;
	private readonly _onDidChangeKeybindings = this._register(
		new Emitter<readonly IKeybindingEntry[]>(),
	);
	private revision = 0;
	private bindings: readonly IKeybindingEntry[] = [];
	private hasAuthoritativeSnapshot: boolean;
	private initialLoad: Promise<void> | undefined;

	readonly onDidChangeKeybindings =
		this._onDidChangeKeybindings.event;

	constructor(options: WorkbenchKeybindingsResourceServiceOptions = {}) {
		super();
		this.api = options.api;
		this.onError = options.onError ??
			((error) => console.error("Failed to apply keybindings resource", error));
		this.hasAuthoritativeSnapshot = this.api === undefined;

		if (this.api) {
			const subscription = this.api.onDidChange((candidate) => {
				try {
					this.acceptSnapshot(validateKeybindingsResourceSnapshot(candidate));
				} catch (error) {
					this.onError(error);
				}
			});
			this._register(toDisposable(() => subscription.dispose()));
		}
	}

	getKeybindings(): readonly IKeybindingEntry[] {
		return this.bindings;
	}

	async updateKeybindings(
		candidate: readonly IKeybindingEntry[],
	): Promise<void> {
		const bindings = validateKeybindingsResource(candidate);
		if (this.api && !this.hasAuthoritativeSnapshot) {
			await this.reload();
		}
		if (!this.api) {
			this.acceptSnapshot({
				revision: this.revision + 1,
				bindings,
			});
			return;
		}
		const result = await this.api.update({
			expectedRevision: this.revision,
			bindings,
		});
		this.acceptSnapshot(validateKeybindingsResourceSnapshot(result));
	}

	async reload(): Promise<void> {
		if (!this.api) return;
		if (!this.initialLoad) {
			this.initialLoad = this.api.read()
				.then((candidate) => {
					this.acceptSnapshot(
						validateKeybindingsResourceSnapshot(candidate),
					);
				})
				.finally(() => {
					this.initialLoad = undefined;
				});
		}
		await this.initialLoad;
	}

	private acceptSnapshot(snapshot: IKeybindingsResourceSnapshot): void {
		if (!this.hasAuthoritativeSnapshot) {
			this.hasAuthoritativeSnapshot = true;
			this.applySnapshot(snapshot);
			return;
		}
		if (snapshot.revision < this.revision) return;
		const serialized = JSON.stringify(snapshot.bindings);
		if (
			snapshot.revision === this.revision &&
			serialized === JSON.stringify(this.bindings)
		) {
			return;
		}
		if (snapshot.revision === this.revision) {
			throw new Error(
				"Keybindings resource changed without advancing its revision",
			);
		}
		this.applySnapshot(snapshot);
	}

	private applySnapshot(snapshot: IKeybindingsResourceSnapshot): void {
		if (JSON.stringify(snapshot.bindings) === JSON.stringify(this.bindings)) {
			this.revision = snapshot.revision;
			this.bindings = snapshot.bindings;
			return;
		}
		this.revision = snapshot.revision;
		this.bindings = snapshot.bindings;
		this._onDidChangeKeybindings.fire(this.bindings);
	}
}
