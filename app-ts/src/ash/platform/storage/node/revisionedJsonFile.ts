import { watch, type FSWatcher } from "node:fs";
import {
	mkdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { basename, dirname } from "node:path";
import { Emitter, type Event } from "../../../base/common/event.js";
import {
	Disposable,

	toDisposable,
} from "../../../base/common/lifecycle.js";

export interface IRevisionedJsonSnapshot<T> {
	readonly revision: number;
	readonly value: T;
}

export interface RevisionedJsonFileOptions<T> {
	readonly filePath: string;
	readonly defaultValue: () => T;
	readonly validate: (value: unknown) => T;
	readonly serialize?: (value: T) => string;
	readonly label?: string;
	readonly onError?: (error: unknown) => void;
}

/**
 * Owns one host-side JSON resource with atomic writes and live reloads.
 *
 * Callers validate domain values and expose their own IPC contract. Updates
 * use process-local compare-and-swap revisions so stale renderer snapshots
 * cannot overwrite newer UI or external file changes.
 */
export class RevisionedJsonFile<T> extends Disposable {
	private readonly filePath: string;
	private readonly temporaryFilePath: string;
	private readonly defaultValue: () => T;
	private readonly validate: (value: unknown) => T;
	private readonly serialize: (value: T) => string;
	private readonly label: string;
	private readonly onError: (error: unknown) => void;
	private readonly _onDidChange = this._register(
		new Emitter<IRevisionedJsonSnapshot<T>>(),
	);
	private value: T;
	private serialized: string;
	private revision = 0;
	private writeQueue: Promise<void> = Promise.resolve();
	private reloadTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
	private watcher: FSWatcher | undefined;
	private closing: Promise<void> | undefined;
	private closed = false;

	readonly onDidChange: Event<IRevisionedJsonSnapshot<T>> =
		this._onDidChange.event;

	private constructor(options: RevisionedJsonFileOptions<T>) {
		super();
		this.filePath = options.filePath;
		this.temporaryFilePath = `${options.filePath}.${process.pid}.tmp`;
		this.defaultValue = options.defaultValue;
		this.validate = options.validate;
		this.serialize = options.serialize ??
			((value) => `${JSON.stringify(value, null, 2)}\n`);
		this.label = options.label ?? "JSON resource";
		this.onError = options.onError ??
			((error) => console.error(`Failed to process ${this.label}`, error));
		this.value = this.validate(this.defaultValue());
		this.serialized = this.serialize(this.value);
		this._register(toDisposable(() => {
			if (this.reloadTimer !== undefined) {
				globalThis.clearTimeout(this.reloadTimer);
				this.reloadTimer = undefined;
			}
			this.watcher?.close();
			this.watcher = undefined;
		}));
	}

	static async create<T>(
		options: RevisionedJsonFileOptions<T>,
	): Promise<RevisionedJsonFile<T>> {
		const resource = new RevisionedJsonFile(options);
		await mkdir(dirname(options.filePath), { recursive: true });
		await resource.loadInitial();
		resource.startWatching();
		return resource;
	}

	read(): IRevisionedJsonSnapshot<T> {
		return this.snapshot();
	}

	update(
		expectedRevision: number,
		candidate: unknown,
	): Promise<IRevisionedJsonSnapshot<T>> {
		if (this.closed) {
			return Promise.reject(
				new ReferenceError(`${this.label} is closed`),
			);
		}
		const operation = this.writeQueue
			.catch(() => undefined)
			.then(async () => {
				if (expectedRevision !== this.revision) {
					throw new Error(
						`${this.label} revision conflict: expected ` +
							`${expectedRevision}, actual ${this.revision}`,
					);
				}
				const value = this.validate(candidate);
				const serialized = this.serialize(value);
				if (serialized === this.serialized) return this.snapshot();

				await writeFile(this.temporaryFilePath, serialized, "utf8");
				await rename(this.temporaryFilePath, this.filePath);
				this.value = value;
				this.serialized = serialized;
				this.revision += 1;
				const snapshot = this.snapshot();
				this._onDidChange.fire(snapshot);
				return snapshot;
			});
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	close(): Promise<void> {
		if (!this.closing) {
			this.closed = true;
			this.dispose();
			this.closing = this.writeQueue;
		}
		return this.closing;
	}

	private async loadInitial(): Promise<void> {
		try {
			const loaded = await this.readFile();
			if (!loaded) return;
			this.value = loaded.value;
			this.serialized = loaded.serialized;
		} catch (error) {
			this.onError(error);
		}
	}

	private startWatching(): void {
		const fileName = basename(this.filePath);
		this.watcher = watch(
			dirname(this.filePath),
			{ persistent: false },
			(_eventType, changedName) => {
				if (
					changedName !== null &&
					changedName.toString() !== fileName
				) {
					return;
				}
				if (this.reloadTimer !== undefined) {
					globalThis.clearTimeout(this.reloadTimer);
				}
				this.reloadTimer = globalThis.setTimeout(() => {
					this.reloadTimer = undefined;
					void this.reloadExternal();
				}, 75);
			},
		);
		this.watcher.on("error", this.onError);
	}

	private reloadExternal(): Promise<void> {
		const operation = this.writeQueue.then(async () => {
			if (this.closed) return;
			const loaded = await this.readFile();
			const value = loaded?.value ?? this.validate(this.defaultValue());
			const serialized = loaded?.serialized ?? this.serialize(value);
			if (serialized === this.serialized) return;
			this.value = value;
			this.serialized = serialized;
			this.revision += 1;
			this._onDidChange.fire(this.snapshot());
		});
		this.writeQueue = operation.catch((error: unknown) => {
			this.onError(error);
		});
		return this.writeQueue;
	}

	private async readFile(): Promise<
		| {
			readonly value: T;
			readonly serialized: string;
		}
		| undefined
	> {
		let contents: string;
		try {
			contents = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isFileNotFound(error)) return undefined;
			throw error;
		}
		const value = this.validate(JSON.parse(contents));
		return {
			value,
			serialized: this.serialize(value),
		};
	}

	private snapshot(): IRevisionedJsonSnapshot<T> {
		return {
			revision: this.revision,
			value: this.value,
		};
	}
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT";
}
