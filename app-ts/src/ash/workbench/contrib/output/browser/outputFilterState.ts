import { Emitter } from "../../../../base/common/event.js";
import { Disposable } from "../../../../base/common/lifecycle.js";
import type { IStorageService } from "../../../../platform/storage/common/storage.js";
import { StorageScope, StorageTarget } from "../../../../platform/storage/common/storage.js";
import type { IOutputEntry, OutputEntrySeverity } from "../../../services/output/common/outputService.js";

const OutputFilterStorageKey = "output.filterState";

export const OutputSeverities: readonly OutputEntrySeverity[] = Object.freeze(["trace", "debug", "information", "warning", "error", "log"]);
const SeverityRanks: Readonly<Record<OutputEntrySeverity, number>> = Object.freeze({ trace: 0, debug: 1, information: 2, log: 2, warning: 3, error: 4 });

interface StoredOutputFilterState {
	readonly text: string;
	readonly hiddenSeverities: readonly OutputEntrySeverity[];
	readonly hiddenCategories: readonly string[];
}

/** View-owned, workspace-persistent filtering for all Output channels. */
export class OutputFilterState extends Disposable {
	private readonly changeEmitter = this._register(new Emitter<void>());
	private readonly hiddenSeverities = new Set<OutputEntrySeverity>();
	private readonly hiddenCategories = new Set<string>();
	private _text = "";

	readonly onDidChange = this.changeEmitter.event;

	constructor(private readonly storageService?: IStorageService) {
		super();
		this.restore();
	}

	get text(): string { return this._text; }

	setText(text: string): void {
		if (this._text === text) return;
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

	isCategoryVisible(category: string): boolean {
		return !this.hiddenCategories.has(category);
	}

	setCategoryVisible(category: string, visible: boolean): void {
		const normalized = category.trim();
		if (!normalized) throw new TypeError("Output category must be non-empty");
		const changed = updateHiddenSet(this.hiddenCategories, normalized, visible);
		if (changed) this.persistAndFire();
	}

	reset(): void {
		if (!this._text && this.hiddenSeverities.size === 0 && this.hiddenCategories.size === 0) return;
		this._text = "";
		this.hiddenSeverities.clear();
		this.hiddenCategories.clear();
		this.persistAndFire();
	}

	matches(entry: IOutputEntry): boolean {
		if (this.hiddenSeverities.has(entry.severity) || (entry.category && this.hiddenCategories.has(entry.category))) return false;
		const haystack = `${entry.category ?? ""} ${entry.text}`.toLocaleLowerCase();
		const terms = parseFilterTerms(this._text);
		return terms.includes.every(term => haystack.includes(term)) && terms.excludes.every(term => !haystack.includes(term));
	}

	private restore(): void {
		const raw = this.storageService?.get(OutputFilterStorageKey, StorageScope.WORKSPACE);
		if (!raw) return;
		try {
			const stored = JSON.parse(raw) as Partial<StoredOutputFilterState>;
			if (typeof stored.text === "string") this._text = stored.text;
			if (Array.isArray(stored.hiddenSeverities)) {
				for (const severity of stored.hiddenSeverities) if (OutputSeverities.includes(severity)) this.hiddenSeverities.add(severity);
			}
			if (Array.isArray(stored.hiddenCategories)) {
				for (const category of stored.hiddenCategories) if (typeof category === "string" && category.trim()) this.hiddenCategories.add(category.trim());
			}
		} catch {
			this.storageService?.remove(OutputFilterStorageKey, StorageScope.WORKSPACE);
		}
	}

	private persistAndFire(): void {
		const stored: StoredOutputFilterState = { text: this._text, hiddenSeverities: [...this.hiddenSeverities], hiddenCategories: [...this.hiddenCategories] };
		this.storageService?.store(OutputFilterStorageKey, JSON.stringify(stored), StorageScope.WORKSPACE, StorageTarget.MACHINE);
		this.changeEmitter.fire();
	}
}

function updateHiddenSet<T>(set: Set<T>, value: T, visible: boolean): boolean {
	if (visible) return set.delete(value);
	if (set.has(value)) return false;
	set.add(value);
	return true;
}

function parseFilterTerms(value: string): { readonly includes: readonly string[]; readonly excludes: readonly string[] } {
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
