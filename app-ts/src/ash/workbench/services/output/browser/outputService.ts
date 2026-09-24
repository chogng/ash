import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import type { IStorageService } from "../../../../platform/storage/common/storage.js";
import { StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import type { IOutputChannel, IOutputChannelDescriptor, IOutputChannelRevealOptions, IOutputChannelRevealRequest, IOutputEntryInput, IOutputService, OutputChannelKind } from "../common/outputService.js";
import { InMemoryOutputChannelModel } from "./outputChannelModel.js";

const ActiveChannelStorageKey = "output.activeChannel";
const DefaultRevealOptions: IOutputChannelRevealOptions = Object.freeze({ focus: "take" });

export interface OutputServiceOptions {
	readonly storageService?: IStorageService;
}

/** Default Output registry with caller-owned channels and workspace selection. */
export class OutputService extends Disposable implements IOutputService {
	private readonly channelsById = new Map<string, OutputChannel>();
	private readonly changeChannelsEmitter = this._register(new Emitter<void>());
	private readonly changeActiveChannelEmitter = this._register(new Emitter<IOutputChannel | undefined>());
	private readonly requestShowChannelEmitter = this._register(new Emitter<IOutputChannelRevealRequest>());
	private readonly storageService: IStorageService | undefined;
	private preferredChannelId: string | undefined;
	private activeChannelId: string | undefined;

	readonly onDidChangeChannels = this.changeChannelsEmitter.event;
	readonly onDidChangeActiveChannel = this.changeActiveChannelEmitter.event;
	readonly onDidRequestShowChannel = this.requestShowChannelEmitter.event;

	constructor(options: OutputServiceOptions = {}) {
		super();
		this.storageService = options.storageService;
		this.preferredChannelId = options.storageService?.get(ActiveChannelStorageKey, StorageScope.WORKSPACE);
		this._register(toDisposable(() => {
			this.channelsById.clear();
			this.activeChannelId = undefined;
		}));
	}

	get channels(): readonly IOutputChannel[] {
		return Object.freeze([...this.channelsById.values()]);
	}

	get activeChannel(): IOutputChannel | undefined {
		return this.activeChannelId ? this.channelsById.get(this.activeChannelId) : undefined;
	}

	createChannel(descriptor: IOutputChannelDescriptor): IOutputChannel {
		this.assertAvailable();
		const normalized = normalizeDescriptor(descriptor);
		if (this.channelsById.has(normalized.id)) throw new Error(`Output channel is already registered: ${normalized.id}`);
		const model = new InMemoryOutputChannelModel();
		const channel = new OutputChannel(normalized, model, () => this.unregisterChannel(normalized.id), options => this.showChannel(normalized.id, options));
		this.channelsById.set(normalized.id, channel);
		const shouldRestorePreferred = this.preferredChannelId === normalized.id;
		const shouldSelectFirst = this.activeChannel === undefined;
		if (shouldRestorePreferred || shouldSelectFirst) this.setActiveChannel(normalized.id);
		this.changeChannelsEmitter.fire();
		return channel;
	}

	getChannel(id: string): IOutputChannel | undefined {
		return this.channelsById.get(validateChannelId(id));
	}

	selectChannel(id: string): void {
		this.assertAvailable();
		const channelId = validateChannelId(id);
		if (!this.channelsById.has(channelId)) throw new RangeError(`Unknown Output channel: ${channelId}`);
		this.preferredChannelId = channelId;
		this.storageService?.store(ActiveChannelStorageKey, channelId, StorageScope.WORKSPACE, StorageTarget.USER);
		this.setActiveChannel(channelId);
	}

	showChannel(id: string, options: IOutputChannelRevealOptions = DefaultRevealOptions): void {
		if (options.focus !== "take" && options.focus !== "preserve") throw new TypeError(`Unsupported Output reveal focus: ${String(options.focus)}`);
		this.selectChannel(id);
		const channel = this.activeChannel;
		if (channel) this.requestShowChannelEmitter.fire(Object.freeze({ channel, focus: options.focus }));
	}

	private unregisterChannel(id: string): void {
		if (!this.channelsById.delete(id)) return;
		if (this.activeChannelId === id) {
			this.activeChannelId = undefined;
			const fallback = this.channelsById.values().next().value as OutputChannel | undefined;
			if (fallback) this.setActiveChannel(fallback.id);
			else this.changeActiveChannelEmitter.fire(undefined);
		}
		this.changeChannelsEmitter.fire();
	}

	private setActiveChannel(id: string): void {
		const channel = this.channelsById.get(id);
		if (!channel || this.activeChannelId === id) return;
		this.activeChannelId = id;
		this.changeActiveChannelEmitter.fire(channel);
	}

	private assertAvailable(): void {
		if (this.isDisposed) throw new ReferenceError("OutputService is already disposed");
	}
}

class OutputChannel extends Disposable implements IOutputChannel {
	readonly onDidChange;

	constructor(readonly descriptor: IOutputChannelDescriptor, private readonly model: InMemoryOutputChannelModel, unregister: () => void, private readonly reveal: (options?: IOutputChannelRevealOptions) => void) {
		super();
		this.onDidChange = model.onDidChange;
		this._register(model);
		this._register(toDisposable(() => {
			unregister();
		}));
	}

	get id(): string { return this.descriptor.id; }
	get label(): string { return this.descriptor.label; }
	get kind(): OutputChannelKind { return this.descriptor.kind ?? "output"; }
	get entries() { return this.model.entries; }

	append(entry: IOutputEntryInput): void { this.assertAvailable(); this.model.append(entry); }
	appendLine(entry: IOutputEntryInput): void { this.assertAvailable(); this.model.appendLine(entry); }
	replace(entries: IOutputEntryInput | readonly IOutputEntryInput[]): void { this.assertAvailable(); this.model.replace(entries); }
	clear(): void { this.assertAvailable(); this.model.clear(); }
	getText(): string { this.assertAvailable(); return this.model.getText(); }
	show(options?: IOutputChannelRevealOptions): void { this.assertAvailable(); this.reveal(options); }

	private assertAvailable(): void {
		if (this.isDisposed) throw new ReferenceError(`Output channel is already disposed: ${this.id}`);
	}
}

function normalizeDescriptor(descriptor: IOutputChannelDescriptor): IOutputChannelDescriptor {
	const id = validateChannelId(descriptor.id);
	const label = validateIdentity(descriptor.label, "Output channel label");
	const kind = descriptor.kind ?? "output";
	if (kind !== "output" && kind !== "log") throw new TypeError(`Unsupported Output channel kind: ${String(kind)}`);
	const source = descriptor.source ?? "core";
	if (source !== "core" && source !== "extension" && source !== "user") throw new TypeError(`Unsupported Output channel source: ${String(source)}`);
	const extensionId = descriptor.extensionId === undefined ? undefined : validateIdentity(descriptor.extensionId, "Output extension id");
	const languageId = descriptor.languageId === undefined ? undefined : validateIdentity(descriptor.languageId, "Output language id");
	if (source === "extension" && !extensionId) throw new TypeError("Extension Output channels require an extension id");
	return Object.freeze({ id, label, kind, source, ...(extensionId ? { extensionId } : {}), ...(languageId ? { languageId } : {}) });
}

function validateIdentity(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized || normalized.includes("\0")) throw new TypeError(`${label} must be non-empty and cannot contain null bytes`);
	if (normalized !== value) throw new TypeError(`${label} cannot contain leading or trailing whitespace`);
	return value;
}

function validateChannelId(value: string): string {
	const id = validateIdentity(value, "Output channel id");
	if (/\s/.test(id)) throw new TypeError("Output channel id cannot contain whitespace");
	return id;
}
