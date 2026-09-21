import { VSBuffer } from "../../../../base/common/buffer.js";
import { Emitter } from "../../../../base/common/event.js";
import { Disposable, toDisposable, type IDisposable } from "../../../../base/common/lifecycle.js";
import { type URI } from "../../../../base/common/uri.js";
import { Position } from "../../../../editor/common/core/position.js";
import { Range } from "../../../../editor/common/core/range.js";
import { LanguageDiagnosticSeverity, type LanguageDiagnostic } from "../../../../editor/common/languages/languageResults.js";
import { type LanguageDiagnosticsPublisher } from "../../../../editor/common/languages/languageResults.js";
import { type TextModel } from "../../../../editor/common/model/textModel.js";
import { type IServerEventApi } from "../../../../platform/app-server/common/appServerApi.js";
import { AppServerRemoteError } from "../../../../platform/app-server/common/appServerError.js";
import { workspaceRelativePath, workspaceResourceFromPath } from "../../../../platform/files/browser/fileService.js";
import { type ILanguageApi } from "../../../../platform/language/common/languageApi.js";
import { type IWorkspaceContextService } from "../../../../platform/workspace/common/workspace.js";
import { type IDirPermissionsService } from "../../../../platform/dirPermissions/common/dirPermissionsService.js";
import { type AppServerErrorName, type LanguageCodeActionDiagnosticDto, type LanguageDiagnosticsNotification } from "../../../../platform/app-server/common/generated/index.js";
import { type ICodeIntelligenceDocumentService } from "../../codeIntelligence/common/codeIntelligenceDocumentService.js";
import { APP_SERVER_WORKSPACE_DIAGNOSTIC_LANGUAGE_IDS, isAppServerLanguageId } from "./appServerLanguageSupport.js";
import { resolveAppServerLanguageDirAccess } from "./appServerLanguageWorkspace.js";
import { type ILanguageDiagnosticsService, type LanguageDiagnosticSnapshot } from "../common/languageDiagnosticsService.js";
import { acquireJsonLanguageDiagnostics } from '../common/jsonLanguageDiagnostics.js';

const MAX_LANGUAGE_DOCUMENT_BYTES = 10 * 1024 * 1024;
const SYNCHRONIZE_DELAY_MS = 150;
const UNSUPPORTED_DIAGNOSTIC_ERROR_NAMES: ReadonlySet<AppServerErrorName> = new Set(["LanguageRequestFailed", "LanguageServiceUnavailable", "PermissionRequired"]);

interface LanguageDocumentEntry {
	readonly resource: URI;
	readonly dirId: string;
	readonly wireWorkspaceFolderId?: string;
	readonly path: string;
	readonly languageId: string;
	readonly model: TextModel;
	modelListener: IDisposable;
	references: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	queue: Promise<void>;
	languageSynchronized: boolean;
	codeIntelligenceSynchronized: boolean;
}

interface PublishedDiagnostics {
	readonly resource: URI;
	snapshot: LanguageDiagnosticSnapshot;
}

/** Synchronizes open Code models and aggregates current diagnostics by revision. */
export class AppServerLanguageDiagnosticsService extends Disposable implements ILanguageDiagnosticsService {
	private readonly entries = new Map<string, LanguageDocumentEntry>();
	private readonly serverSnapshots = new Map<string, LanguageDiagnosticSnapshot>();
	private readonly workspaceServerKeys = new Set<string>();
	private readonly publishedDiagnostics = new Map<number, PublishedDiagnostics>();
	private readonly changeEmitter = this._register(new Emitter<URI>());
	private nextPublisherId = 1;
	private workspaceDiagnosticsQueued = false;
	private permissionRefreshQueued = false;
	private permissionRefreshGeneration = 0;
	private languageAllowed: boolean;
	private permissionQueue = Promise.resolve();
	private alive = true;
	readonly onDidChangeDiagnostics = this.changeEmitter.event;

	constructor(private readonly api: ILanguageApi, events: IServerEventApi, private readonly workspace: IWorkspaceContextService, private readonly codeIntelligenceDocuments?: ICodeIntelligenceDocumentService, private readonly dirPermissions?: IDirPermissionsService) {
		super();
		this.languageAllowed = dirPermissions === undefined;
		const subscription = events.subscribe(event => {
			if (event.method === "language/diagnostics") this.acceptDiagnostics(event.params);
			if (event.method === "config/changed") this.queuePermissionRefresh();
		});
		this._register(toDisposable(() => subscription.dispose()));
		this._register(workspace.onDidChangeWorkspace(({ workspace: nextWorkspace }) => {
			this.languageAllowed = this.dirPermissions === undefined;
			for (const entry of this.entries.values()) {
				if (entry.timer !== undefined) clearTimeout(entry.timer);
				entry.timer = undefined;
				entry.languageSynchronized = false;
				entry.codeIntelligenceSynchronized = false;
			}
			this.clearServerDiagnostics();
			if (nextWorkspace.folders.length > 0) this.queuePermissionRefresh();
		}));
		this._register(toDisposable(() => {
			this.alive = false;
			for (const entry of this.entries.values()) {
				if (entry.timer !== undefined) clearTimeout(entry.timer);
				entry.modelListener.dispose();
			}
			this.entries.clear();
			this.serverSnapshots.clear();
			this.workspaceServerKeys.clear();
			this.publishedDiagnostics.clear();
		}));
		this.queuePermissionRefresh();
	}

	acquire(resource: URI, languageId: string, model: TextModel): IDisposable {
		const jsonDiagnostics = acquireJsonLanguageDiagnostics(resource, languageId, model, () => this.createPublisher(resource));
		if (jsonDiagnostics) return jsonDiagnostics;
		if (!isAppServerLanguageId(languageId)) return toDisposable(() => undefined);
		const target = this.workspaceTarget(resource);
		if (!target || model.largeFile.tooLargeForSynchronization) return toDisposable(() => undefined);
		const key = resource.toString();
		const existing = this.entries.get(key);
		if (existing) {
			if (existing.model !== model || existing.languageId !== languageId) throw new Error("One language document resource cannot bind multiple models or languages");
			const reopening = existing.references === 0;
			if (reopening) existing.modelListener = model.onDidChangeContent(() => this.schedule(existing, false));
			existing.references += 1;
			if (reopening) this.schedule(existing, true);
			return toDisposable(() => this.release(key, existing));
		}
		const entry: LanguageDocumentEntry = {
			resource,
			dirId: target.dirId,
			...(this.workspace.getWorkspace().folders.length > 1 ? { wireWorkspaceFolderId: target.dirId } : {}),
			path: target.path,
			languageId,
			model,
			modelListener: toDisposable(() => undefined),
			references: 1,
			timer: undefined,
			queue: Promise.resolve(),
			languageSynchronized: false,
			codeIntelligenceSynchronized: false,
		};
		entry.modelListener = model.onDidChangeContent(() => this.schedule(entry, false));
		if (this.workspaceServerKeys.delete(key)) {
			this.serverSnapshots.delete(key);
			this.changeEmitter.fire(resource);
		}
		this.entries.set(key, entry);
		this.schedule(entry, true);
		return toDisposable(() => this.release(key, entry));
	}

	getDiagnostics(resource: URI): LanguageDiagnosticSnapshot | undefined {
		return this.mergeDiagnostics(resource);
	}

	getAllDiagnostics(): readonly LanguageDiagnosticSnapshot[] {
		const resources = new Map<string, URI>();
		for (const snapshot of this.serverSnapshots.values()) resources.set(snapshot.resource.toString(), snapshot.resource);
		for (const published of this.publishedDiagnostics.values()) resources.set(published.resource.toString(), published.resource);
		return Object.freeze([...resources.values()].flatMap(resource => {
			const snapshot = this.mergeDiagnostics(resource);
			return snapshot ? [snapshot] : [];
		}));
	}

	createPublisher(resource: URI): LanguageDiagnosticsPublisher {
		const id = this.nextPublisherId++;
		let disposed = false;
		return toDisposablePublisher(
			(revision, diagnostics) => {
				if (disposed) throw new ReferenceError("Language diagnostics publisher is already disposed");
				if (!Number.isSafeInteger(revision) || revision < 1) throw new RangeError("Language diagnostics revision must be a positive safe integer");
				const snapshot = Object.freeze({ resource, revision, diagnostics: Object.freeze([...diagnostics]) });
				const current = this.publishedDiagnostics.get(id)?.snapshot;
				if (current?.revision === revision && equalDiagnostics(current.diagnostics, snapshot.diagnostics)) return;
				this.publishedDiagnostics.set(id, { resource, snapshot });
				this.changeEmitter.fire(resource);
			},
			() => {
				if (disposed) return;
				disposed = true;
				if (this.publishedDiagnostics.delete(id)) this.changeEmitter.fire(resource);
			},
		);
	}

	private schedule(entry: LanguageDocumentEntry, immediate: boolean): void {
		const target = this.workspaceTarget(entry.resource);
		if (!this.languageAllowed || entry.references === 0 || this.entries.get(entry.resource.toString()) !== entry || target?.dirId !== entry.dirId || target.path !== entry.path) return;
		if (entry.timer !== undefined) clearTimeout(entry.timer);
		if (immediate) {
			entry.timer = undefined;
			this.enqueueSynchronization(entry);
			return;
		}
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			this.enqueueSynchronization(entry);
		}, SYNCHRONIZE_DELAY_MS);
	}

	private enqueueSynchronization(entry: LanguageDocumentEntry): void {
		if (!this.languageAllowed) return;
		const snapshot = entry.model.createVersionedSnapshot();
		const text = snapshot.getText();
		if (VSBuffer.fromString(text).byteLength > MAX_LANGUAGE_DOCUMENT_BYTES) return;
		entry.queue = entry.queue.catch(() => undefined).then(async () => {
			if (!this.languageAllowed || entry.references === 0 || this.entries.get(entry.resource.toString()) !== entry) return;
			const document = { ...(entry.wireWorkspaceFolderId ? { dirId: entry.wireWorkspaceFolderId } : {}), path: entry.path, languageId: entry.languageId, revision: snapshot.version, text };
			let codeIntelligenceSynchronized = false;
			await Promise.all([
				this.api.synchronize({ document }),
				this.canSynchronizeCodeIntelligence(entry)
					? this.codeIntelligenceDocuments?.synchronize(document).then(() => { codeIntelligenceSynchronized = true; }).catch(reportCodeIntelligenceSynchronizationError)
					: undefined,
			]);
			if (!this.languageAllowed || entry.references === 0 || this.entries.get(entry.resource.toString()) !== entry) return;
			entry.languageSynchronized = true;
			entry.codeIntelligenceSynchronized ||= codeIntelligenceSynchronized;
			try {
				const report = await this.api.documentDiagnostics({ document });
				if (report.kind === "full") this.acceptDiagnostics({ ...(entry.wireWorkspaceFolderId ? { dirId: entry.wireWorkspaceFolderId } : {}), path: entry.path, revision: report.revision, diagnostics: report.diagnostics });
			} catch (error) {
				if (!isUnsupportedDiagnosticPull(error)) throw error;
			}
			this.queueWorkspaceDiagnostics();
		}).catch(reportLanguageSynchronizationError);
	}

	private queueWorkspaceDiagnostics(): void {
		if (!this.languageAllowed || this.workspaceDiagnosticsQueued || !this.hasWorkspaceFolder()) return;
		this.workspaceDiagnosticsQueued = true;
		queueMicrotask(() => {
			this.workspaceDiagnosticsQueued = false;
			if (this.alive) void this.refreshWorkspaceDiagnostics();
		});
	}

	private async refreshWorkspaceDiagnostics(): Promise<void> {
		if (!this.languageAllowed || !this.hasWorkspaceFolder()) return;
		const next = new Map<string, LanguageDiagnosticSnapshot>();
		let supported = false;
		for (const folder of this.workspace.getWorkspace().folders) {
			for (const languageId of APP_SERVER_WORKSPACE_DIAGNOSTIC_LANGUAGE_IDS) {
				if (!this.alive || !this.languageAllowed || !this.hasWorkspaceFolder()) return;
				try {
					const report = await this.api.directoryDiagnostics({ ...(this.workspace.getWorkspace().folders.length > 1 ? { dirId: folder.id } : {}), languageId });
					if (!report.supported) continue;
					supported = true;
					for (const snapshot of report.snapshots) {
						const resource = workspaceResourceFromPath(folder.uri, snapshot.path);
						if (!resource) continue;
						const key = resource.toString();
						const diagnostics = snapshot.diagnostics.flatMap(diagnostic => projectWorkspaceDiagnostic(diagnostic));
						const combined = deduplicateDiagnostics([...(next.get(key)?.diagnostics ?? []), ...diagnostics]);
						next.set(key, Object.freeze({ resource, revision: 0, diagnostics: Object.freeze(combined) }));
					}
				} catch (error) {
					if (!isUnsupportedDiagnosticPull(error)) reportLanguageSynchronizationError(error);
				}
			}
		}
		if (!this.alive) return;
		if (!supported) return;
		const changed = new Map<string, URI>();
		for (const key of this.workspaceServerKeys) {
			const resource = this.serverSnapshots.get(key)?.resource;
			if (resource) changed.set(key, resource);
			this.serverSnapshots.delete(key);
		}
		this.workspaceServerKeys.clear();
		for (const [key, snapshot] of next) {
			if (this.entries.has(key)) continue;
			this.serverSnapshots.set(key, snapshot);
			this.workspaceServerKeys.add(key);
			changed.set(key, snapshot.resource);
		}
		for (const resource of changed.values()) this.changeEmitter.fire(resource);
	}

	private clearServerDiagnostics(): void {
		const changed = [...this.serverSnapshots.values()].map(snapshot => snapshot.resource);
		this.serverSnapshots.clear();
		this.workspaceServerKeys.clear();
		for (const resource of changed) this.changeEmitter.fire(resource);
	}

	private queuePermissionRefresh(): void {
		if (!this.alive) return;
		this.permissionRefreshGeneration += 1;
		if (this.permissionRefreshQueued) return;
		this.permissionRefreshQueued = true;
		queueMicrotask(() => {
			this.permissionRefreshQueued = false;
			const generation = this.permissionRefreshGeneration;
			this.permissionQueue = this.permissionQueue.catch(() => undefined).then(() => this.refreshDirAccess(generation)).catch(reportDirAccessRefreshError);
		});
	}

	private async refreshDirAccess(generation: number): Promise<void> {
		const access = await resolveAppServerLanguageDirAccess(this.workspace, this.dirPermissions);
		if (!this.alive || generation !== this.permissionRefreshGeneration || this.workspace.getWorkspace().id !== access.workspaceId) return;
		const changed = this.languageAllowed !== access.allowed;
		this.languageAllowed = access.allowed;
		if (!access.allowed) {
			for (const entry of this.entries.values()) {
				if (entry.timer !== undefined) clearTimeout(entry.timer);
				entry.timer = undefined;
				entry.languageSynchronized = false;
				entry.codeIntelligenceSynchronized = false;
			}
			if (changed) this.clearServerDiagnostics();
			return;
		}
		if (changed) for (const entry of this.entries.values()) this.schedule(entry, true);
		this.queueWorkspaceDiagnostics();
	}

	private hasWorkspaceFolder(): boolean {
		return this.workspace.getWorkspace().folders.length > 0;
	}

	private release(key: string, entry: LanguageDocumentEntry): void {
		if (this.entries.get(key) !== entry || entry.references === 0) return;
		entry.references -= 1;
		if (entry.references > 0) return;
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		entry.modelListener.dispose();
		if (this.serverSnapshots.delete(key)) this.changeEmitter.fire(entry.resource);
		entry.queue = entry.queue.catch(() => undefined).then(async () => {
			if (entry.references > 0) return;
			const closeLanguage = entry.languageSynchronized ? this.api.close({ ...(entry.wireWorkspaceFolderId ? { dirId: entry.wireWorkspaceFolderId } : {}), path: entry.path }) : Promise.resolve();
			const closeCodeIntelligence = entry.codeIntelligenceSynchronized && this.canSynchronizeCodeIntelligence(entry) ? this.codeIntelligenceDocuments?.close(entry.path).catch(reportCodeIntelligenceSynchronizationError) : undefined;
			entry.languageSynchronized = false;
			entry.codeIntelligenceSynchronized = false;
			await Promise.all([closeLanguage, closeCodeIntelligence]);
			if (entry.references === 0 && this.entries.get(key) === entry) this.entries.delete(key);
			this.queueWorkspaceDiagnostics();
		}).catch(reportLanguageSynchronizationError);
	}

	private acceptDiagnostics(notification: LanguageDiagnosticsNotification): void {
		const folders = this.workspace.getWorkspace().folders;
		const folder = notification.dirId
			? folders.find(folder => folder.id === notification.dirId)
			: folders.length === 1 ? folders[0] : undefined;
		if (!folder) return;
		const resource = workspaceResourceFromPath(folder.uri, notification.path);
		if (!resource) return;
		const key = resource.toString();
		const entry = this.entries.get(key);
		if (!entry || notification.revision > entry.model.version) return;
		const current = this.serverSnapshots.get(key);
		if (current && current.revision > notification.revision) return;
		const diagnostics = notification.diagnostics.flatMap(diagnostic => projectDiagnostic(diagnostic, entry.model));
		if (current?.revision === notification.revision && equalDiagnostics(current.diagnostics, diagnostics)) return;
		this.serverSnapshots.set(key, Object.freeze({ resource, revision: notification.revision, diagnostics: Object.freeze(diagnostics) }));
		this.workspaceServerKeys.delete(key);
		this.changeEmitter.fire(resource);
	}

	private mergeDiagnostics(resource: URI): LanguageDiagnosticSnapshot | undefined {
		const key = resource.toString();
		const candidates = [...this.publishedDiagnostics.values()].filter(candidate => candidate.resource.toString() === key).map(candidate => candidate.snapshot);
		const server = this.serverSnapshots.get(key);
		if (server) candidates.push(server);
		if (candidates.length === 0) return undefined;
		const revision = Math.max(...candidates.map(candidate => candidate.revision));
		const diagnostics = deduplicateDiagnostics(candidates.filter(candidate => candidate.revision === revision).flatMap(candidate => candidate.diagnostics));
		return Object.freeze({ resource, revision, diagnostics: Object.freeze(diagnostics) });
	}

	private workspaceTarget(resource: URI): { readonly dirId: string; readonly path: string } | undefined {
		let match: { readonly dirId: string; readonly path: string; readonly rootLength: number } | undefined;
		for (const folder of this.workspace.getWorkspace().folders) {
			try {
				const path = workspaceRelativePath(folder.uri, resource);
				if (!match || folder.uri.path.length > match.rootLength) match = { dirId: folder.id, path, rootLength: folder.uri.path.length };
			} catch {
				// Resource belongs to a different Workspace folder.
			}
		}
		return match && { dirId: match.dirId, path: match.path };
	}

	private canSynchronizeCodeIntelligence(entry: LanguageDocumentEntry): boolean {
		return this.workspace.getWorkspace().folders[0]?.id === entry.dirId;
	}
}

function reportCodeIntelligenceSynchronizationError(error: unknown): void {
	console.error("Code-intelligence document synchronization failed", error);
}

function reportDirAccessRefreshError(error: unknown): void {
	console.error("Directory access refresh for language services failed", error);
}

function isUnsupportedDiagnosticPull(error: unknown): boolean {
	return error instanceof AppServerRemoteError && UNSUPPORTED_DIAGNOSTIC_ERROR_NAMES.has(error.errorName);
}

function toDisposablePublisher(update: LanguageDiagnosticsPublisher["update"], dispose: () => void): LanguageDiagnosticsPublisher {
	return { update, dispose, [Symbol.dispose]: dispose };
}

function equalDiagnostics(left: readonly LanguageDiagnostic[], right: readonly LanguageDiagnostic[]): boolean {
	return left.length === right.length && left.every((diagnostic, index) => diagnosticKey(diagnostic) === diagnosticKey(right[index]!));
}

function deduplicateDiagnostics(diagnostics: readonly LanguageDiagnostic[]): readonly LanguageDiagnostic[] {
	const seen = new Set<string>();
	return diagnostics.filter(diagnostic => {
		const key = diagnosticKey(diagnostic);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function diagnosticKey(diagnostic: LanguageDiagnostic): string {
	const range = diagnostic.range;
	return `${range.getStartPosition().lineNumber}:${range.getStartPosition().column}:${range.getEndPosition().lineNumber}:${range.getEndPosition().column}:${diagnostic.severity}:${diagnostic.message}:${diagnostic.source ?? ""}:${diagnostic.code ?? ""}`;
}

function projectDiagnostic(diagnostic: LanguageCodeActionDiagnosticDto, model: TextModel): readonly LanguageDiagnostic[] {
	const message = diagnostic.message.trim();
	if (!message) return [];
	const source = diagnostic.source?.trim() || undefined;
	const code = typeof diagnostic.code === "string" ? diagnostic.code.trim() || undefined : typeof diagnostic.code === "number" && Number.isFinite(diagnostic.code) ? diagnostic.code : undefined;
	try {
		const range = Range.fromPositions(new Position((diagnostic.range.start.lineIndex) + 1, (diagnostic.range.start.columnIndex) + 1), new Position((diagnostic.range.end.lineIndex) + 1, (diagnostic.range.end.columnIndex) + 1));
		model.offsetAt(range.getStartPosition());
		model.offsetAt(range.getEndPosition());
		return [Object.freeze({
			range,
			severity: diagnostic.severity as LanguageDiagnosticSeverity,
			message,
			...(code === undefined ? {} : { code }),
			...(source === undefined ? {} : { source }),
		})];
	} catch {
		return [];
	}
}

function projectWorkspaceDiagnostic(diagnostic: LanguageCodeActionDiagnosticDto): readonly LanguageDiagnostic[] {
	const message = diagnostic.message.trim();
	if (!message) return [];
	const source = diagnostic.source?.trim() || undefined;
	const code = typeof diagnostic.code === "string" ? diagnostic.code.trim() || undefined : typeof diagnostic.code === "number" && Number.isFinite(diagnostic.code) ? diagnostic.code : undefined;
	try {
		const range = Range.fromPositions(new Position((diagnostic.range.start.lineIndex) + 1, (diagnostic.range.start.columnIndex) + 1), new Position((diagnostic.range.end.lineIndex) + 1, (diagnostic.range.end.columnIndex) + 1));
		return [Object.freeze({ range, severity: diagnostic.severity as LanguageDiagnosticSeverity, message, ...(code === undefined ? {} : { code }), ...(source === undefined ? {} : { source }) })];
	} catch {
		return [];
	}
}

function reportLanguageSynchronizationError(error: unknown): void {
	console.error("App Server language document synchronization failed", error);
}
