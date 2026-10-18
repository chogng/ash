import { triggerDownload } from '../../../../../base/browser/fileAccess.js';
import { canceled, isCancellationError } from '../../../../../base/common/errors.js';
import { isRecord } from '../../../../../base/common/types.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2 } from '../../../../../platform/actions/common/actions.js';
import { IAgentSessionService } from '../../../../../platform/agentHost/common/agentService.js';
import { IAppServerApi } from '../../../../../platform/agentHost/common/appServerApi.js';
import type { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ILoggerService, type ILogFileService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { IChatSessionNavigationService } from '../../../../services/chat/common/chatSessionNavigationService.js';
import { IOutputService } from '../../../../services/output/common/output.js';
import { ITraceService } from '../../../../services/trace/common/traceService.js';
import { diagnosticPayload } from '../../../../services/trace/common/agentTrace.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';

const MaxFiles = 1000;
const MaxFileBytes = 16 * 1024 * 1024;
const MaxBundleBytes = 64 * 1024 * 1024;
const MaxManifestBytes = 1024 * 1024;
// Generated entry names are at most 27 UTF-8 bytes; this covers 1,000 ZIP headers and directory records.
const MaxDataBytes = MaxBundleBytes - MaxManifestBytes - 128 * 1024;
const MaxTracePages = 64;

interface BundleFile {
	readonly path: string;
	readonly bytes: Uint8Array<ArrayBuffer>;
}

interface CollectionIssue {
	readonly source: string;
	readonly reason: 'unavailable' | 'readFailed' | 'truncated' | 'fileLimit' | 'byteLimit' | 'pageLimit' | 'notRecorded' | 'collectionLimit';
	readonly detail?: string;
}

/** Both window hosts supply their active conversation through the existing navigation owner. */
export class ExportAgentHostDebugLogsAction extends Action2 {
	static readonly ID = 'workbench.action.chat.exportAgentHostDebugLogs';
	private pending: Promise<void> | undefined;

	constructor() {
		super({
			id: ExportAgentHostDebugLogsAction.ID,
			title: localize2('exportAgentHostDebugLogs', 'Export Agent Host Debug Logs…'),
			category: localize2('debugLogs.developer', 'Developer'),
			f1: true,
			precondition: ChatContextKeys.enabled.isEqualTo(true),
		});
	}

	override run(accessor: ServicesAccessor): Promise<void> {
		if (this.pending) return this.pending;
		const operation = this.export(accessor);
		this.pending = operation;
		void operation.finally(() => { this.pending = undefined; }).catch(() => { });
		return operation;
	}

	private async export(accessor: ServicesAccessor): Promise<void> {
		const navigation = accessor.get(IChatSessionNavigationService);
		const active = navigation.getActiveConversation();
		// Freeze identity before opening progress; switching chats cannot retarget an export.
		const conversation = active ? { sessionId: active.sessionId, threadId: active.threadId } : undefined;
		const loggers = accessor.get(ILoggerService);
		const output = accessor.get(IOutputService);
		const traces = accessor.get(ITraceService);
		const sessions = accessor.get(IAgentSessionService);
		const appServer = accessor.get(IAppServerApi);
		const progressService = accessor.get(IProgressService);
		const notifications = accessor.get(INotificationService);
		const ownerDocument = accessor.get(ILayoutService).mainContainer.ownerDocument;
		const generation = appServer.connectionGeneration;
		const cancellation = new AbortController();
		let connectionChanged = false;
		const connectionListener = appServer.onConnectionState(() => { connectionChanged = true; });
		const assertCurrent = (): void => {
			if (cancellation.signal.aborted) throw canceled();
		};
		const assertBackend = (): void => {
			assertCurrent();
			if (connectionChanged || generation !== appServer.connectionGeneration) {
				throw new Error(localize('debugLogs.connectionChanged', 'The App Server connection changed during export.'));
			}
		};
		try {
			await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: localize('debugLogs.collecting', 'Collecting Agent Host debug logs…'),
				cancellable: true,
			}, async progress => {
				const files: BundleFile[] = [];
				const issues: CollectionIssue[] = [];
				const sources: { path: string; source: string; }[] = [];
				const payloads: { captureId: string | null; payloadId: string; kind: string; path?: string; status: 'saved' | 'omitted' | 'failed'; }[] = [];
				const seenPayloads = new Set<string>();
				let processLogsStatus: 'collected' | 'partial' | 'unavailable' = 'unavailable';
				let recordingStatus: string | undefined;
				let captureId: string | null | undefined;
				const selectedThreads = new Set(conversation ? [conversation.threadId] : []);
				const childThreads = new Map<string, Set<string>>();
				const encoder = new TextEncoder();
				let totalBytes = 0;
				const add = (path: string, source: string, content: string | Uint8Array): boolean => {
					assertCurrent();
					// Reserve one entry and a separate byte budget for the coverage manifest.
					if (files.length >= MaxFiles - 1) { issues.push({ source, reason: 'fileLimit' }); return false; }
					const bytes = typeof content === 'string' ? encoder.encode(content) : Uint8Array.from(content);
					if (bytes.length > MaxFileBytes || totalBytes + bytes.length > MaxDataBytes) {
						issues.push({ source, reason: 'byteLimit' });
						return false;
					}
					files.push({ path, bytes });
					sources.push({ path, source });
					totalBytes += bytes.length;
					return true;
				};
				const attempt = async (source: string, read: () => Promise<void>): Promise<void> => {
					assertCurrent();
					try { await read(); }
					catch (error) {
						assertCurrent();
						issues.push({ source, reason: 'readFailed', detail: (error instanceof Error ? error.message : String(error)).slice(0, 2048) });
					}
					assertCurrent();
				};
				if (conversation) {
					await attempt('sessionHostLogs', async () => {
						assertBackend();
						const logs = await sessions.collectDebugLogs({ sessionId: conversation.sessionId }, cancellation.signal);
						assertBackend();
						processLogsStatus = logs.files.length ? 'collected' : 'unavailable';
						if (!logs.files.length) issues.push({ source: 'sessionHostLogs', reason: 'unavailable' });
						if (logs.omittedFiles) { issues.push({ source: 'sessionHostLogs', reason: 'collectionLimit' }); processLogsStatus = 'partial'; }
						for (const [index, file] of logs.files.entries()) {
							if (!add(`host/${index + 1}.log`, `sessionHost:${file.name}`, file.bytes)) processLogsStatus = 'partial';
							if (file.truncated) { issues.push({ source: `sessionHost:${file.name}`, reason: 'truncated' }); processLogsStatus = 'partial'; }
						}
					});
				}
				for (const info of [...loggers.getRegisteredLoggers()].slice(0, MaxFiles)) {
					const logger = loggers.getLogger(info.id);
					if (logger) await attempt(`flush:${info.id}`, () => logger.flush());
				}
				if (loggers.files) {
					await attempt('hostLogs', () => collectHostLogs(loggers.files!, add, issues, attempt));
				} else {
					issues.push({ source: 'hostLogs', reason: 'unavailable' });
				}
				// Output owns retained extension/provider log channels. Do not clear or subscribe to them.
				const logChannels = output.channels.filter(channel => channel.kind === 'log' && !channel.id.startsWith('saved-log.'));
				if (logChannels.length > MaxFiles) issues.push({ source: 'outputLogs', reason: 'fileLimit' });
				for (const channel of logChannels.slice(0, MaxFiles)) {
					add(`output/${files.length + 1}.log`, channel.id, channel.getText());
				}
				if (conversation) {
					progress.report({ message: localize('debugLogs.sessionEvidence', 'Collecting session execution evidence…') });
					await attempt('sessionTrace', async () => {
						let after: Readonly<Record<string, number>> = {};
						for (let pageNumber = 1; pageNumber <= MaxTracePages; pageNumber++) {
							assertBackend();
							const page = await traces.readTrace(conversation.sessionId, after);
							assertBackend();
							for (const thread of page.trace.threads) {
								for (const record of thread.events) {
									const origin = record.event.origin;
									if (record.event.type === 'threadCreated' && isRecord(origin) && origin.type === 'agentSpawn' && typeof origin.parentThreadId === 'string') {
										let children = childThreads.get(origin.parentThreadId);
										if (!children) childThreads.set(origin.parentThreadId, children = new Set());
										children.add(thread.threadId);
									}
								}
							}
							if (!add(`session/trace-${pageNumber}.json`, 'sessionTrace', JSON.stringify(page))) break;
							if (!page.hasMore) break;
							after = page.cursors;
							if (pageNumber === MaxTracePages) issues.push({ source: 'sessionTrace', reason: 'pageLimit' });
						}
					});
					// Peer chats have independent model bodies. Include only this chat and its recorded subagents.
					const descendants = [conversation.threadId];
					for (let index = 0; index < descendants.length; index++) {
						for (const child of childThreads.get(descendants[index]) ?? []) {
							if (!selectedThreads.has(child)) { selectedThreads.add(child); descendants.push(child); }
						}
					}
					await attempt('sessionDiagnostics', async () => {
						let after = 0;
						for (let pageNumber = 1; pageNumber <= MaxTracePages; pageNumber++) {
							assertBackend();
							const page = await traces.readTraceDiagnostics(conversation.sessionId, after);
							assertBackend();
							if (captureId !== undefined && captureId !== page.diagnostics.captureId) {
								throw new Error(localize('debugLogs.captureChanged', 'The session evidence capture changed during export.'));
							}
							captureId = page.diagnostics.captureId;
							recordingStatus = page.diagnostics.recordingStatus;
							if (!add(`session/diagnostics-${pageNumber}.json`, 'sessionDiagnostics', JSON.stringify(page))) break;
							if (page.diagnostics.droppedRecords || page.diagnostics.pendingRecords || recordingStatus === 'incomplete') {
								issues.push({ source: 'sessionDiagnostics', reason: 'truncated' });
							}
							for (const record of page.diagnostics.events) {
								if (!selectedThreads.has(record.threadId)) continue;
								const reference = diagnosticPayload(record);
								if (!reference) continue;
								const key = `${captureId}:${reference.payloadId}`;
								if (seenPayloads.has(key)) continue;
								if (payloads.length >= MaxFiles) { issues.push({ source: 'sessionPayloadIndex', reason: 'fileLimit' }); break; }
								seenPayloads.add(key);
								const entry: typeof payloads[number] = { captureId, payloadId: reference.payloadId, kind: reference.kind, status: 'omitted' };
								payloads.push(entry);
								if (reference.status !== 'saved') { issues.push({ source: key, reason: 'notRecorded' }); continue; }
								if (!captureId) { issues.push({ source: key, reason: 'unavailable' }); continue; }
								if (files.length >= MaxFiles - 1 || totalBytes + reference.byteLength > MaxDataBytes) {
									issues.push({ source: 'sessionPayloads', reason: files.length >= MaxFiles - 1 ? 'fileLimit' : 'byteLimit' });
									break;
								}
								entry.status = 'failed';
								const payloadCapture = captureId;
								await attempt(key, async () => {
									assertBackend();
									const payload = await traces.readTracePayload(conversation.sessionId, payloadCapture, reference.payloadId);
									assertBackend();
									const path = `session/payloads/${payloads.length}.json`;
									if (add(path, key, JSON.stringify(payload))) { entry.path = path; entry.status = 'saved'; }
									else entry.status = 'omitted';
								});
							}
							if (!page.hasMore) break;
							after = page.cursor;
							if (pageNumber === MaxTracePages) issues.push({ source: 'sessionDiagnostics', reason: 'pageLimit' });
						}
					});
				}
				const manifest = {
					formatVersion: 2, createdAt: new Date().toISOString(), conversation: conversation ?? null,
					connectionGeneration: generation,
					limits: { maxFiles: MaxFiles, maxFileBytes: MaxFileBytes, maxBundleBytes: MaxBundleBytes, maxTracePages: MaxTracePages },
					coverage: {
						hostLogs: 'local-main-current-window-and-local-app-server',
						providerLogs: 'retained-output-log-channels-only',
						sessionEvidence: conversation ? 'session-trace-and-diagnostic-pages' : 'no-active-conversation',
						sessionHostProcessLogs: conversation ? processLogsStatus : 'no-active-conversation',
						requestPayloads: { recordingStatus: recordingStatus ?? 'unavailable', captureId: captureId ?? null, threadIds: [...selectedThreads], references: payloads },
					},
					sources, issues,
				};
				const manifestBytes = encoder.encode(JSON.stringify(manifest, undefined, 2));
				if (manifestBytes.length > MaxManifestBytes) throw new Error(localize('debugLogs.manifestSize', 'The debug log coverage manifest exceeds its size limit.'));
				files.push({ path: 'manifest.json', bytes: manifestBytes });
				assertCurrent();
				const archive = createZip(files);
				assertCurrent();
				triggerDownload(new Blob([archive], { type: 'application/zip' }), 'ash-agent-host-debug-logs.zip', ownerDocument);
				if (issues.length) {
					notifications.warning(localize('debugLogs.partial', 'Debug logs exported with {0} collection issues. See manifest.json for missing or truncated evidence.', issues.length));
				} else {
					notifications.info(localize('debugLogs.exported', 'Agent Host debug logs exported.'));
				}
			}, () => cancellation.abort());
		} catch (error) {
			if (!isCancellationError(error)) notifications.error(localize('debugLogs.failed', 'Could not export Agent Host debug logs: {0}', error instanceof Error ? error.message : String(error)));
		} finally {
			connectionListener.dispose();
		}
	}
}

async function collectHostLogs(
	logs: ILogFileService,
	add: (path: string, source: string, text: string) => boolean,
	issues: CollectionIssue[],
	attempt: (source: string, read: () => Promise<void>) => Promise<void>,
): Promise<void> {
	const sources = await logs.list();
	const currentWindow = sources.find(source => source.currentWindow);
	const live = sources.filter(source => source.live && (source.currentWindow || source.source === 'main' || source.source === 'app-server'));
	const selected = sources.filter(source => live.some(current =>
		current.id === source.id || (current.source === source.source && current.id.split('/')[0] === source.id.split('/')[0])));
	if (!currentWindow) issues.push({ source: 'currentWindowLog', reason: 'unavailable' });
	if (!sources.some(source => source.live && source.source === 'main')) issues.push({ source: 'mainLog', reason: 'unavailable' });
	if (!sources.some(source => source.source === 'app-server')) issues.push({ source: 'localAppServerLog', reason: 'unavailable' });
	if (selected.length > MaxFiles) issues.push({ source: 'hostLogs', reason: 'fileLimit' });
	for (const [index, source] of selected.slice(0, MaxFiles).entries()) {
		await attempt(source.id, async () => {
			const result = await logs.read(source.id);
			add(`logs/${index + 1}.log`, source.id, result.text);
			if (result.gap) issues.push({ source: source.id, reason: 'truncated' });
		});
	}
}

/** Bounded UTF-8 entries use ZIP's STORE method; no Node archive library enters the renderer. */
function createZip(files: readonly BundleFile[]): Uint8Array<ArrayBuffer> {
	const encoder = new TextEncoder();
	const names = files.map(file => encoder.encode(file.path));
	const length = files.reduce((size, file, index) => size + 30 + names[index].length + file.bytes.length + 46 + names[index].length, 22);
	const bytes = new Uint8Array(length);
	const view = new DataView(bytes.buffer);
	const crcTable = new Uint32Array(256);
	for (let index = 0; index < 256; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
		crcTable[index] = value;
	}
	const entries: { offset: number; crc: number; }[] = [];
	let offset = 0;
	for (const [index, file] of files.entries()) {
		let crc = 0xffffffff;
		for (const byte of file.bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
		crc = (crc ^ 0xffffffff) >>> 0;
		entries.push({ offset, crc });
		view.setUint32(offset, 0x04034b50, true);
		view.setUint16(offset + 4, 20, true);
		view.setUint16(offset + 6, 0x800, true);
		view.setUint16(offset + 12, 0x21, true); // 1980-01-01, ZIP's earliest date.
		view.setUint32(offset + 14, crc, true);
		view.setUint32(offset + 18, file.bytes.length, true);
		view.setUint32(offset + 22, file.bytes.length, true);
		view.setUint16(offset + 26, names[index].length, true);
		bytes.set(names[index], offset + 30);
		bytes.set(file.bytes, offset + 30 + names[index].length);
		offset += 30 + names[index].length + file.bytes.length;
	}
	const directoryOffset = offset;
	for (const [index, file] of files.entries()) {
		view.setUint32(offset, 0x02014b50, true);
		view.setUint16(offset + 4, 20, true);
		view.setUint16(offset + 6, 20, true);
		view.setUint16(offset + 8, 0x800, true);
		view.setUint16(offset + 14, 0x21, true);
		view.setUint32(offset + 16, entries[index].crc, true);
		view.setUint32(offset + 20, file.bytes.length, true);
		view.setUint32(offset + 24, file.bytes.length, true);
		view.setUint16(offset + 28, names[index].length, true);
		view.setUint32(offset + 42, entries[index].offset, true);
		bytes.set(names[index], offset + 46);
		offset += 46 + names[index].length;
	}
	view.setUint32(offset, 0x06054b50, true);
	view.setUint16(offset + 8, files.length, true);
	view.setUint16(offset + 10, files.length, true);
	view.setUint32(offset + 12, offset - directoryOffset, true);
	view.setUint32(offset + 16, directoryOffset, true);
	return bytes;
}
