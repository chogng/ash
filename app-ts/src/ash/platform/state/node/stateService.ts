import {
	mkdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../../../base/common/types.js";
import type { IStateService } from "./state.js";

function isFileNotFound(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

/**
 * Stores small main-process state in one JSON file and serializes writes.
 *
 * Each flush writes a temporary sibling file before replacing the destination,
 * preventing an interrupted write from leaving a partially written JSON file.
 */
export class StateService implements IStateService {
	private readonly filePath: string;
	private readonly temporaryFilePath: string;
	private items: Record<string, unknown> = Object.create(null);
	private lastSavedContents = "";
	private writeQueue: Promise<void> = Promise.resolve();
	private closing: Promise<void> | undefined;
	private closed = false;

	private constructor(filePath: string) {
		this.filePath = filePath;
		this.temporaryFilePath = `${filePath}.${process.pid}.tmp`;
	}

	/** Opens a state file, treating a missing or malformed file as empty state. */
	static async create(filePath: string): Promise<StateService> {
		const service = new StateService(filePath);
		await service.load();
		return service;
	}

	private async load(): Promise<void> {
		let contents: string;
		try {
			contents = await readFile(this.filePath, "utf8");
		} catch (error) {
			if (isFileNotFound(error)) {
				return;
			}
			throw error;
		}

		try {
			const parsed: unknown = JSON.parse(contents);
			if (isRecord(parsed)) {
				this.items = parsed;
				this.lastSavedContents = contents;
			}
		} catch (error) {
			if (!(error instanceof SyntaxError)) {
				throw error;
			}
		}
	}

	getItem(key: string): unknown {
		return this.items[key];
	}

	setItem(key: string, value: unknown): void {
		this.assertOpen();
		if (value === undefined) {
			delete this.items[key];
		} else {
			this.items[key] = value;
		}
	}

	removeItem(key: string): void {
		this.assertOpen();
		delete this.items[key];
	}

	flush(): Promise<void> {
		const contents = JSON.stringify(this.items, null, 2);
		const write = this.writeQueue
			.catch(() => undefined)
			.then(async () => {
				if (contents === this.lastSavedContents) {
					return;
				}

				await mkdir(dirname(this.filePath), { recursive: true });
				await writeFile(this.temporaryFilePath, contents, "utf8");
				await rename(this.temporaryFilePath, this.filePath);
				this.lastSavedContents = contents;
			});
		this.writeQueue = write;
		return write;
	}

	close(): Promise<void> {
		if (!this.closing) {
			this.closed = true;
			this.closing = this.flush();
		}
		return this.closing;
	}

	private assertOpen(): void {
		if (this.closed) {
			throw new Error("State service is closed");
		}
	}
}
