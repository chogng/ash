import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Emitter } from '../../../base/common/event.js';
import { parseJsonc } from '../../../base/common/jsonc.js';
import { Disposable, toDisposable } from '../../../base/common/lifecycle.js';
import type { IpcRoute } from '../../ipc/electron-main/trustedIpcRouter.js';
import { keyboardMappingsEqual, type IKeyboardLayoutDefinition } from '../common/keyboardLayout.js';
import {
	parseUserKeyboardLayoutResource,
	USER_KEYBOARD_LAYOUT_DEFAULT_CONTENT,
	USER_KEYBOARD_LAYOUT_OPEN_RESOURCE_CHANNEL,
	USER_KEYBOARD_LAYOUT_READ_CHANNEL,
	validateUserKeyboardLayoutOpenResource,
	validateUserKeyboardLayoutRead,
} from '../common/userKeyboardLayout.js';

export interface UserKeyboardLayoutMainServiceOptions {
	readonly filePath: string;
	readonly onError?: (error: unknown) => void;
	readonly openResource?: (filePath: string) => Promise<string>;
}

/** Owns and live-reloads the active profile's `keyboard-layout.json`. */
export class UserKeyboardLayoutMainService extends Disposable {
	private readonly _onDidChangeKeyboardLayout = this._register(new Emitter<void>());
	private readonly filePath: string;
	private readonly onError: (error: unknown) => void;
	private readonly openResourceInHost: ((filePath: string) => Promise<string>) | undefined;
	private watcher: FSWatcher | undefined;
	private reloadTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
	private reloadQueue: Promise<void> = Promise.resolve();
	private layout: IKeyboardLayoutDefinition | undefined;
	private closed = false;

	public readonly onDidChangeKeyboardLayout = this._onDidChangeKeyboardLayout.event;

	private constructor(options: UserKeyboardLayoutMainServiceOptions) {
		super();
		this.filePath = options.filePath;
		this.onError = options.onError ?? ((error) => console.error('Failed to process user keyboard layout', error));
		this.openResourceInHost = options.openResource;
		this._register(toDisposable(() => {
			this.closed = true;
			if (this.reloadTimer !== undefined) {
				globalThis.clearTimeout(this.reloadTimer);
			}
			this.watcher?.close();
		}));
	}

	public static async create(options: UserKeyboardLayoutMainServiceOptions): Promise<UserKeyboardLayoutMainService> {
		const service = new UserKeyboardLayoutMainService(options);
		await mkdir(dirname(options.filePath), { recursive: true });
		await service.reload(false);
		service.startWatching();
		return service;
	}

	public get currentKeyboardLayout(): IKeyboardLayoutDefinition | undefined {
		return this.layout;
	}

	public async readKeyboardLayout(): Promise<IKeyboardLayoutDefinition | undefined> {
		return this.layout;
	}

	public async ensureResource(): Promise<string> {
		try {
			await writeFile(this.filePath, USER_KEYBOARD_LAYOUT_DEFAULT_CONTENT, { encoding: 'utf8', flag: 'wx' });
		} catch (error) {
			if (!isAlreadyExists(error)) {
				throw error;
			}
		}
		return this.filePath;
	}

	public async openResource(): Promise<void> {
		if (!this.openResourceInHost) {
			throw new Error('Opening the user keyboard layout is unavailable in this host');
		}
		const filePath = await this.ensureResource();
		const error = await this.openResourceInHost(filePath);
		if (error) {
			throw new Error(`Could not open keyboard-layout.json: ${error}`);
		}
	}

	public async close(): Promise<void> {
		this.dispose();
		await this.reloadQueue;
	}

	private startWatching(): void {
		const fileName = basename(this.filePath);
		this.watcher = watch(dirname(this.filePath), { persistent: false }, (_eventType, changedName) => {
			if (changedName !== null && changedName.toString() !== fileName) {
				return;
			}
			if (this.reloadTimer !== undefined) {
				globalThis.clearTimeout(this.reloadTimer);
			}
			this.reloadTimer = globalThis.setTimeout(() => {
				this.reloadTimer = undefined;
				this.reloadQueue = this.reloadQueue.then(() => this.reload(true));
			}, 75);
		});
		this.watcher.on('error', this.onError);
	}

	private async reload(notify: boolean): Promise<void> {
		if (this.closed) {
			return;
		}
		let next: IKeyboardLayoutDefinition | undefined;
		try {
			const contents = await readFile(this.filePath, 'utf8');
			next = parseUserKeyboardLayoutResource(parseJsonc(contents, 'keyboard-layout.json'));
		} catch (error) {
			if (!isFileNotFound(error)) {
				this.onError(error);
			}
			next = undefined;
		}
		if (keyboardLayoutDefinitionsEqual(this.layout, next)) {
			return;
		}
		this.layout = next;
		if (notify) {
			this._onDidChangeKeyboardLayout.fire();
		}
	}
}

export function userKeyboardLayoutIpcRoutes(
	service: UserKeyboardLayoutMainService,
): readonly IpcRoute<unknown, unknown>[] {
	return [
		{
			channel: USER_KEYBOARD_LAYOUT_READ_CHANNEL,
			validate: validateUserKeyboardLayoutRead,
			invoke: () => service.readKeyboardLayout(),
		},
		{
			channel: USER_KEYBOARD_LAYOUT_OPEN_RESOURCE_CHANNEL,
			validate: validateUserKeyboardLayoutOpenResource,
			invoke: () => service.openResource(),
		},
	];
}

function keyboardLayoutDefinitionsEqual(
	first: IKeyboardLayoutDefinition | undefined,
	second: IKeyboardLayoutDefinition | undefined,
): boolean {
	return first === second || Boolean(first && second &&
		first.layout.id === second.layout.id &&
		first.layout.label === second.layout.label &&
		first.layout.source === second.layout.source &&
		first.layout.operatingSystem === second.layout.operatingSystem &&
		Boolean(first.layout.isUSStandard) === Boolean(second.layout.isUSStandard) &&
		keyboardMappingsEqual(first.mapping, second.mapping));
}

function isFileNotFound(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}
