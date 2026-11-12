import { getErrorMessage, isCancellationError, onUnexpectedError } from '../../base/common/errors.js';
import { getWindowId, getWindows, mainWindow } from '../../base/browser/window.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import type { INativeHostApi } from '../../platform/native/common/nativeHost.js';
import { WINDOW_ZOOM_LEVEL_SETTING, WINDOW_ZOOM_PER_WINDOW_SETTING } from '../../platform/window/common/window.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../base/common/resources.js';
import { Range } from '../../editor/common/core/range.js';
import { EditorOpenSource } from '../../platform/editor/common/editor.js';
import { parseOpenSessionLinkUri } from '../../platform/agentHost/common/openSessionLink.js';
import { OPEN_IDE_SESSION_CHANNEL } from '../../platform/window/common/window.js';
import { WINDOW_OPEN_FILES_CHANNEL, WINDOW_OPEN_FILES_RESPONSE_CHANNEL, validateWindowFilesRequest, type IWindowFilesRequest } from '../../platform/window/common/window.js';
import { IEditorService } from '../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../services/editor/common/editorGroupsService.js';
import { INativeHostService } from '../common/services.js';
import { IIntegrityService } from '../services/integrity/common/integrity.js';
import { ITitleService } from '../services/title/browser/titleService.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { ILogService } from '../../platform/log/common/log.js';
import { localize } from '../../nls.js';
import { NativeWindowClientArea } from '../../platform/window/electron-browser/window.js';

/** The renderer owns file completion because it owns every editor group, including moved tabs. */
export class ElectronWindow extends Disposable {
	private readonly waiting = new Map<number, IWindowFilesRequest>();
	private opening: Promise<void> = Promise.resolve();

	constructor(
		private readonly ipc: Pick<typeof import('../../platform/ipc/electron-browser/rendererIpc.js'), 'invoke' | 'subscribe'>,
		@IEditorService private readonly editors: IEditorService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@INativeHostService private readonly host: INativeHostApi,
		@IIntegrityService private readonly integrity: IIntegrityService,
		@ITitleService private readonly title: ITitleService,
		@IOpenerService private readonly opener: IOpenerService,
		@INotificationService private readonly notifications: INotificationService,
		@ILogService private readonly log: ILogService,
	) {
		super();
	}

	public async initialize(whenRestored: Promise<void>): Promise<void> {
		this.assertNotDisposed();
		const subscription = this.ipc.subscribe<unknown>(WINDOW_OPEN_FILES_CHANNEL, value => {
			const request = validateWindowFilesRequest(value);
			const operation = this.opening.then(() => this.openFiles(request));
			this.opening = operation.catch(error => console.error('Failed to acknowledge a file open request', error));
		});
		this._register(toDisposable(() => subscription.dispose()));
		let openingConversation = Promise.resolve();
		const conversations = this.ipc.subscribe<unknown>(OPEN_IDE_SESSION_CHANNEL, value => {
			openingConversation = openingConversation.then(async () => {
				await whenRestored;
				if (this.isDisposed) return;
				if (typeof value !== 'string') throw new TypeError('Invalid IDE conversation');
				const resource = URI.parse(value, true);
				parseOpenSessionLinkUri(resource);
				if (!await this.opener.open(resource)) {
					throw new Error(localize('chat.sessionLink.missing', 'This conversation is unavailable on this connection.'));
				}
			}).catch(error => {
				if (!this.isDisposed && !isCancellationError(error)) this.notifications.error(getErrorMessage(error));
			});
		});
		this._register(toDisposable(() => conversations.dispose()));
		this._register(this.groups.onDidChangeGroups(() => this.completeClosedFiles()));
		await this.ipc.invoke<void>(WINDOW_OPEN_FILES_RESPONSE_CHANNEL, { kind: 'ready' });
		// Do not compete with editor restoration for disk reads on a cold start.
		void whenRestored.then(() => {
			if (this.isDisposed) return;
			void this.updateTitleProperties().catch(error => {
				if (this.isDisposed) { return; }
				this.log.error('integrity', 'Desktop environment detection failed', error);
				this.notifications.warn(localize('integrity.failed', 'Ash could not verify its desktop environment. See the logs for details.'));
			});
		}, () => undefined);
	}

	private async updateTitleProperties(): Promise<void> {
		const isAdmin = await this.host.isAdmin();
		if (this.isDisposed) { return; }
		this.title.updateProperties({ isAdmin });
		const result = await this.integrity.isPure();
		if (this.isDisposed) { return; }
		this.title.updateProperties({ isPure: result.isPure });
		if (result.isPure === false) {
			this.notifications.warn(localize('integrity.modified', 'Ash installation files have changed or are missing. Reinstall Ash to restore the published files.'));
		}
	}

	private async openFiles(request: IWindowFilesRequest): Promise<void> {
		this.assertNotDisposed();
		try {
			for (const file of request.files) {
				const selection = file.line === undefined ? undefined : new Range(file.line, file.column ?? 1, file.line, file.column ?? 1);
				// Explicit launch files and Explorer opens share the target recovery path.
				await this.editors.openEditor({ resource: URI.parse(file.uri) }, { pinned: true, selection, ignoreError: true, source: EditorOpenSource.USER });
			}
			if (request.wait) {
				this.waiting.set(request.id, request);
			}
			await this.ipc.invoke<void>(WINDOW_OPEN_FILES_RESPONSE_CHANNEL, { kind: 'opened', id: request.id });
			this.completeClosedFiles();
		} catch (error) {
			await this.ipc.invoke<void>(WINDOW_OPEN_FILES_RESPONSE_CHANNEL, { kind: 'failed', id: request.id, message: error instanceof Error ? error.message : String(error) });
		}
	}

	private completeClosedFiles(): void {
		const open = new Set(this.groups.groups.flatMap(group => group.inputs.map(input => extUriBiasedIgnorePathCase.getComparisonKey(input.resource))));
		for (const [id, request] of this.waiting) {
			if (request.files.every(file => !open.has(extUriBiasedIgnorePathCase.getComparisonKey(URI.parse(file.uri))))) {
				this.waiting.delete(id);
				void this.ipc.invoke<void>(WINDOW_OPEN_FILES_RESPONSE_CHANNEL, { kind: 'closed', id }).catch(error => console.error('Failed to acknowledge closed launch files', error));
			}
		}
	}
}

/** Keeps one desktop window's zoom level in sync with its profile setting. */
export class NativeWindow extends Disposable {
	private pendingZoomLevel: number | undefined;
	private zoomWrite: Promise<void> = Promise.resolve();
	private applyingConfiguredZoom = false;

	constructor(
		@INativeHostService private readonly host: INativeHostApi,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IOpenerService private readonly opener: IOpenerService,
	) {
		super();
		const externalLinks = this.host.onDidRequestOpenExternalUri((target, sourceWindowName) => {
			const sourceWindowId = sourceWindowName === undefined ? getWindowId(mainWindow) : getWindows().find(entry => entry.window.name === sourceWindowName)?.id;
			void this.opener.open(target, { openExternal: true, allowContributedOpeners: true, ...(sourceWindowId === undefined ? {} : { sourceWindowId }) }).catch(onUnexpectedError);
		});
		this._register(toDisposable(() => externalLinks.dispose()));
		const updateZoom = (level: number): void => {
			if (this.applyingConfiguredZoom || this.configuration.getValue<boolean>(WINDOW_ZOOM_PER_WINDOW_SETTING) !== false) return;
			this.pendingZoomLevel = Math.round(level);
			this.zoomWrite = this.zoomWrite.catch(onUnexpectedError).then(async () => {
				const next = this.pendingZoomLevel;
				if (this.isDisposed || next === undefined) return;
				if (next !== this.configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING)) {
					await this.configuration.updateValue(WINDOW_ZOOM_LEVEL_SETTING, next);
					await this.applyConfiguredZoom();
				}
				if (this.pendingZoomLevel === next) this.pendingZoomLevel = undefined;
			});
			void this.zoomWrite.catch(onUnexpectedError);
		};
		const zoomSubscription = this.host.onDidChangeZoomLevel(updateZoom);
		this._register(toDisposable(() => zoomSubscription.dispose()));
		const auxiliaryZoom = this.host.onDidChangeAuxiliaryWindowState(({ state }) => {
			if (state.zoomLevel !== this.configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING)) updateZoom(state.zoomLevel);
		});
		this._register(toDisposable(() => auxiliaryZoom.dispose()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if ((event.affectsConfiguration(WINDOW_ZOOM_LEVEL_SETTING) || event.affectsConfiguration(WINDOW_ZOOM_PER_WINDOW_SETTING)) && this.pendingZoomLevel === undefined) void this.applyConfiguredZoom().catch(onUnexpectedError);
		}));
		void this.applyConfiguredZoom().catch(onUnexpectedError);
	}

	/** Constrains the whole Workbench to the native drawable area, including fractional CSS pixels. */
	public initialize(container: HTMLElement): Promise<void> {
		this.assertNotDisposed();
		return this._register(new NativeWindowClientArea(container, this.host)).ready;
	}

	private async applyConfiguredZoom(): Promise<void> {
		if (this.isDisposed) return;
		const level = this.configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING);
		const allWindows = this.configuration.getValue<boolean>(WINDOW_ZOOM_PER_WINDOW_SETTING) === false;
		const current = await this.host.getZoomLevel();
		if (this.isDisposed) return;
		if (allWindows || current !== level) {
			this.applyingConfiguredZoom = true;
			try { await this.host.setZoomLevel(level, undefined, allWindows); }
			finally { this.applyingConfiguredZoom = false; }
		}
	}
}
