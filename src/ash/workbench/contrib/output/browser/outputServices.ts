import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import type { ITextModel } from '../../../../editor/common/model.js';
import { OutputLinkProvider } from './outputLinkProvider.js';
import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable } from "../../../../base/common/lifecycle.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import { OUTPUT_MODE_ID, LOG_MODE_ID, OutputSeverities, type IOutputViewFilters, type IOutputEntry, type OutputEntrySeverity, type IOutputChannel, type IOutputChannelDescriptor, type IOutputChannelRevealOptions, type IOutputChannelRevealRequest, type IOutputEntryInput, IOutputService, type OutputChannelKind } from "../../../services/output/common/output.js";
import { InMemoryOutputChannelModel } from "../common/outputChannelModel.js";

const ActiveChannelStorageKey = "output.activeChannel";
const DefaultRevealOptions: IOutputChannelRevealOptions = Object.freeze({ focus: "take" });

/** Default Output registry with caller-owned channels and workspace selection. */
export class OutputService extends Disposable implements IOutputService {
	private readonly channelsById = new Map<string, OutputChannel>();
	private readonly changeChannelsEmitter = this._register(new Emitter<void>());
	private readonly changeActiveChannelEmitter = this._register(new Emitter<IOutputChannel | undefined>());
	private readonly requestShowChannelEmitter = this._register(new Emitter<IOutputChannelRevealRequest>());
	public readonly filters: IOutputViewFilters;
	private preferredChannelId: string | undefined;
	private activeChannelId: string | undefined;

	readonly onDidChangeChannels = this.changeChannelsEmitter.event;
	readonly onDidChangeActiveChannel = this.changeActiveChannelEmitter.event;
	readonly onDidRequestShowChannel = this.requestShowChannelEmitter.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ITextModelService textModelService: ITextModelService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageService languageService: ILanguageService,
	) {
		super();
		this._register(languageService.registerLanguage({ id: OUTPUT_MODE_ID, mimetypes: ['text/x-code-output'] }));
		this._register(languageService.registerLanguage({ id: LOG_MODE_ID, mimetypes: ['text/x-code-log-output'] }));
		this.preferredChannelId = storageService.get(ActiveChannelStorageKey, StorageScope.WORKSPACE);
		this.filters = this._register(new OutputFilterState(storageService));
		this._register(instantiationService.createInstance(OutputLinkProvider));
		this._register(textModelService.registerTextModelContentProvider('output', {
			provideTextContent: async resource => {
				const channel = this.channelsById.get(resource.path.slice(1));
				return channel?.uri.toString() === resource.toString() ? channel.loadModel() : null;
			},
		}));
		this._register(toDisposable(() => {
			for (const channel of [...this.channelsById.values()]) channel.dispose();
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
		const uri = URI.from({ scheme: 'output', path: `/${normalized.id}` });
		const model = this.instantiationService.createInstance(InMemoryOutputChannelModel, uri, normalized.languageId ?? (normalized.kind === 'log' ? LOG_MODE_ID : OUTPUT_MODE_ID));
		const channel = new OutputChannel(uri, normalized, model, () => this.unregisterChannel(normalized.id), options => this.showChannel(normalized.id, options));
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
		this.storageService.store(ActiveChannelStorageKey, channelId, StorageScope.WORKSPACE, StorageTarget.USER);
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

	constructor(readonly uri: URI, readonly descriptor: IOutputChannelDescriptor, private readonly model: InMemoryOutputChannelModel, unregister: () => void, private readonly reveal: (options?: IOutputChannelRevealOptions) => void) {
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

	loadModel(): Promise<ITextModel> { this.assertAvailable(); return this.model.loadModel(); }
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

const OutputFilterStorageKey = "output.filterState";
const CurrentTextSyntaxVersion = 2;

const SeverityRanks: Readonly<Record<OutputEntrySeverity, number>> = Object.freeze({ trace: 0, debug: 1, information: 2, log: 2, warning: 3, error: 4 });

interface StoredOutputFilterState {
	readonly syntaxVersion: 1 | 2;
	readonly text: string;
	readonly hiddenSeverities: readonly OutputEntrySeverity[];
	readonly hiddenCategories: readonly string[];
}

/** Service-owned, workspace-persistent filtering for all Output channels. */
class OutputFilterState extends Disposable implements IOutputViewFilters {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private readonly hiddenSeverities = new Set<OutputEntrySeverity>();
	private readonly hiddenCategories = new Set<string>();
	private _text = "";
	private textSyntaxVersion: 1 | 2 = CurrentTextSyntaxVersion;
	private preserveStoredState = false;

	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly storageService: IStorageService) {
		super();
		this.restore();
	}

	get text(): string { return this._text; }

	get textFilterNotice(): IOutputViewFilters['textFilterNotice'] {
		if (this.preserveStoredState) { return 'unsupported'; }
		return this.textSyntaxVersion === 1 && this._text.length > 0 ? 'restored' : undefined;
	}

	setText(text: string): void {
		if (this._text === text && this.textSyntaxVersion === CurrentTextSyntaxVersion) {
			if (this.preserveNewerStoredState()) { this.changeEmitter.fire(); }
			return;
		}
		// Only restoration can enter the older grammar. Explicit input always leaves it,
		// including resubmitting the same text, whose meaning may now be different.
		this.textSyntaxVersion = CurrentTextSyntaxVersion;
		this._text = text;
		this.persistAndFire();
	}

	isSeverityVisible(severity: OutputEntrySeverity): boolean {
		return !this.hiddenSeverities.has(severity);
	}

	setSeverityVisible(severity: OutputEntrySeverity, visible: boolean): void {
		if (!OutputSeverities.includes(severity)) throw new TypeError(`Unsupported Output severity: ${severity}`);
		const changed = updateHiddenSet(this.hiddenSeverities, severity, visible);
		if (changed) this.persistAndFire();
	}

	setMinimumSeverity(minimum: OutputEntrySeverity): void {
		if (!OutputSeverities.includes(minimum)) throw new TypeError(`Unsupported Output severity: ${minimum}`);
		const rank = SeverityRanks[minimum];
		let changed = false;
		for (const severity of OutputSeverities) changed = updateHiddenSet(this.hiddenSeverities, severity, SeverityRanks[severity] >= rank) || changed;
		if (changed) this.persistAndFire();
	}

	isCategoryVisible(category: string, channelId: string): boolean {
		return !this.hiddenCategories.has(category) && !this.hiddenCategories.has(channelCategoryKey(category, channelId));
	}

	setCategoryVisible(category: string, visible: boolean, channelId: string): void {
		const normalized = category.trim();
		if (!normalized || normalized.includes('\0')) throw new TypeError("Output category must be non-empty and cannot contain null bytes");
		const key = channelCategoryKey(normalized, validateChannelId(channelId));
		// An old category has no channel identity. Only explicit input can move
		// that choice; restoration and unrelated filters keep its global effect.
		const migrated = this.hiddenCategories.delete(normalized);
		const changed = updateHiddenSet(this.hiddenCategories, key, visible);
		if (changed || migrated) this.persistAndFire();
	}

	reset(): void {
		if (!this._text && this.hiddenSeverities.size === 0 && this.hiddenCategories.size === 0 && this.textSyntaxVersion === CurrentTextSyntaxVersion) {
			if (this.preserveNewerStoredState()) { this.changeEmitter.fire(); }
			return;
		}
		this.textSyntaxVersion = CurrentTextSyntaxVersion;
		this._text = "";
		this.hiddenSeverities.clear();
		this.hiddenCategories.clear();
		this.persistAndFire();
	}

	matches(entry: IOutputEntry, channelId: string): boolean {
		if (this.hiddenSeverities.has(entry.severity) || (entry.category && !this.isCategoryVisible(entry.category, channelId))) return false;
		const restored = this.textSyntaxVersion === 1;
		const haystack = (restored ? `${entry.category ?? ""} ${entry.text}` : entry.text).toLocaleLowerCase();
		const terms = restored ? parseRestoredFilterTerms(this._text) : parseFilterTerms(this._text);
		const included = restored ? terms.includes.every(term => haystack.includes(term)) : terms.includes.length === 0 || terms.includes.some(term => haystack.includes(term));
		return included && terms.excludes.every(term => !haystack.includes(term));
	}

	private restore(): void {
		const raw = this.storageService.get(OutputFilterStorageKey, StorageScope.WORKSPACE);
		if (!raw) return;
		try {
			const stored = JSON.parse(raw) as Partial<StoredOutputFilterState>;
			if (hasUnknownTextSyntaxVersion(stored)) {
				// A newer client owns this schema. Leave it intact and use unsaved,
				// current-version filters in this window instead of guessing its meaning.
				this.preserveStoredState = true;
				return;
			}
			if (typeof stored.text === "string") {
				this._text = stored.text;
				this.textSyntaxVersion = stored.syntaxVersion === CurrentTextSyntaxVersion || stored.text.length === 0 ? CurrentTextSyntaxVersion : 1;
			}
			if (Array.isArray(stored.hiddenSeverities)) {
				for (const severity of stored.hiddenSeverities) if (OutputSeverities.includes(severity)) this.hiddenSeverities.add(severity);
			}
			if (Array.isArray(stored.hiddenCategories)) {
				for (const category of stored.hiddenCategories) if (typeof category === "string" && category.trim()) this.hiddenCategories.add(category.trim());
			}
		} catch {
			this.storageService.remove(OutputFilterStorageKey, StorageScope.WORKSPACE);
		}
	}

	private preserveNewerStoredState(): boolean {
		if (this.preserveStoredState) { return false; }
		// Another window can publish a newer schema after this owner restored.
		// Check before writes and no-op input so the protection notice stays accurate.
		const raw = this.storageService.get(OutputFilterStorageKey, StorageScope.WORKSPACE);
		try { this.preserveStoredState = raw !== undefined && hasUnknownTextSyntaxVersion(JSON.parse(raw)); }
		catch { /* Malformed JSON has no usable schema; this owner can replace it. */ }
		return this.preserveStoredState;
	}

	private persistAndFire(): void {
		this.preserveNewerStoredState();
		if (!this.preserveStoredState) {
			const stored: StoredOutputFilterState = { syntaxVersion: this.textSyntaxVersion, text: this._text, hiddenSeverities: [...this.hiddenSeverities], hiddenCategories: [...this.hiddenCategories] };
			this.storageService.store(OutputFilterStorageKey, JSON.stringify(stored), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}
		this.changeEmitter.fire();
	}
}

function channelCategoryKey(category: string, channelId: string): string {
	// Entries and channel IDs cannot contain null bytes. A tagged JSON tuple
	// keeps their identities distinct and survives older readers of string arrays.
	return '\0' + JSON.stringify([channelId, category]);
}

function updateHiddenSet<T>(set: Set<T>, value: T, visible: boolean): boolean {
	if (visible) return set.delete(value);
	if (set.has(value)) return false;
	set.add(value);
	return true;
}

function hasUnknownTextSyntaxVersion(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) { return false; }
	const version = (value as Record<string, unknown>).syntaxVersion;
	return version !== undefined && version !== 1 && version !== CurrentTextSyntaxVersion;
}

function parseFilterTerms(value: string): { readonly includes: readonly string[]; readonly excludes: readonly string[]; } {
	const includes: string[] = [];
	const excludes: string[] = [];
	// Quotes protect commas but remain literal matching characters; backslashes
	// do not introduce a separate escaping grammar.
	for (const pattern of value.match(/(?:[^,"]+|"[^"]*(?:"|$))+/g) ?? []) {
		const raw = pattern.trim();
		const excluded = raw.startsWith('!');
		const term = (excluded ? raw.slice(1).trim() : raw).toLocaleLowerCase();
		if (term) { (excluded ? excludes : includes).push(term); }
	}
	return { includes, excludes };
}

/** Restoration-only adapter; no explicit input can select this grammar. */
function parseRestoredFilterTerms(value: string): { readonly includes: readonly string[]; readonly excludes: readonly string[]; } {
	const includes: string[] = [];
	const excludes: string[] = [];
	for (const match of value.matchAll(/(?:"([^"]+)"|(\S+))/g)) {
		const raw = (match[1] ?? match[2] ?? "").trim();
		if (!raw) continue;
		const excluded = raw.startsWith("!") || raw.startsWith("-");
		const term = (excluded ? raw.slice(1) : raw).toLocaleLowerCase();
		if (!term) continue;
		(excluded ? excludes : includes).push(term);
	}
	return { includes, excludes };
}
