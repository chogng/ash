import { onUnexpectedError } from '../../base/common/errors.js';
import { IConfigurationService } from '../../platform/configuration/common/configuration.js';
import type { INativeHostApi } from '../../platform/native/common/nativeHost.js';
import { WINDOW_ZOOM_LEVEL_SETTING } from '../../platform/window/common/window.js';
import { IOpenerService } from '../../platform/opener/common/opener.js';
import { Disposable, toDisposable } from '../../base/common/lifecycle.js';
import { URI } from '../../base/common/uri.js';
import { extUriBiasedIgnorePathCase } from '../../base/common/resources.js';
import { Range } from '../../editor/common/core/range.js';
import { WINDOW_OPEN_FILES_CHANNEL, WINDOW_OPEN_FILES_RESPONSE_CHANNEL, validateWindowFilesRequest, type IWindowFilesRequest } from '../../platform/window/common/window.js';
import { IEditorService } from '../services/editor/common/editorService.js';
import { IEditorGroupsService } from '../services/editor/common/editorGroupsService.js';
import { INativeHostService } from '../common/services.js';
import { IIntegrityService } from '../services/integrity/common/integrity.js';
import { ITitleService } from '../services/title/browser/titleService.js';
import { INotificationService } from '../../platform/notification/common/notification.js';
import { ILogService } from '../../platform/log/common/log.js';
import { localize } from '../../nls.js';

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
		@INotificationService private readonly notifications: INotificationService,
		@ILogService private readonly log: ILogService,
	) {
		super();
	}

	public async initialize(): Promise<void> {
		this.assertNotDisposed();
		const subscription = this.ipc.subscribe<unknown>(WINDOW_OPEN_FILES_CHANNEL, value => {
			const request = validateWindowFilesRequest(value);
			const operation = this.opening.then(() => this.openFiles(request));
			this.opening = operation.catch(error => console.error('Failed to acknowledge a file open request', error));
		});
		this._register(toDisposable(() => subscription.dispose()));
		this._register(this.groups.onDidChangeGroups(() => this.completeClosedFiles()));
		await this.ipc.invoke<void>(WINDOW_OPEN_FILES_RESPONSE_CHANNEL, { kind: 'ready' });
		// The shell and launch-file handshake remain available while installation files are scanned.
		void this.updateTitleProperties().catch(error => {
			if (this.isDisposed) { return; }
			this.log.error('integrity', 'Desktop environment detection failed', error);
			this.notifications.warning(localize('integrity.failed', 'Ash could not verify its desktop environment. See the logs for details.'));
		});
	}

	private async updateTitleProperties(): Promise<void> {
		const isAdmin = await this.host.isAdmin();
		if (this.isDisposed) { return; }
		this.title.updateProperties({ isAdmin });
		const result = await this.integrity.isPure();
		if (this.isDisposed) { return; }
		this.title.updateProperties({ isPure: result.isPure });
		if (result.isPure === false) {
			this.notifications.warning(localize('integrity.modified', 'Ash installation files have changed or are missing. Reinstall Ash to restore the published files.'));
		}
	}

	private async openFiles(request: IWindowFilesRequest): Promise<void> {
		this.assertNotDisposed();
		try {
			for (const file of request.files) {
				const selection = file.line === undefined ? undefined : new Range(file.line, file.column ?? 1, file.line, file.column ?? 1);
				await this.editors.openEditor({ resource: URI.parse(file.uri) }, { pinned: true, selection, ignoreError: true });
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
		const externalLinks = this.host.onDidRequestOpenExternalUri(target => {
			void this.opener.open(target, { openExternal: true, allowContributedOpeners: true }).catch(onUnexpectedError);
		});
		this._register(toDisposable(() => externalLinks.dispose()));
		const zoomSubscription = this.host.onDidChangeZoomLevel(level => {
			if (this.applyingConfiguredZoom) return;
			this.pendingZoomLevel = Math.round(level);
			this.zoomWrite = this.zoomWrite.catch(onUnexpectedError).then(async () => {
				const next = this.pendingZoomLevel;
				if (next === undefined) return;
				if (next !== this.configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING)) {
					await this.configuration.updateValue(WINDOW_ZOOM_LEVEL_SETTING, next);
				}
				if (this.pendingZoomLevel === next) this.pendingZoomLevel = undefined;
			});
			void this.zoomWrite.catch(onUnexpectedError);
		});
		this._register(toDisposable(() => zoomSubscription.dispose()));
		this._register(configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(WINDOW_ZOOM_LEVEL_SETTING) && this.pendingZoomLevel === undefined) void this.applyConfiguredZoom().catch(onUnexpectedError);
		}));
		void this.applyConfiguredZoom().catch(onUnexpectedError);
	}

	private async applyConfiguredZoom(): Promise<void> {
		const level = this.configuration.getValue<number>(WINDOW_ZOOM_LEVEL_SETTING);
		if (await this.host.getZoomLevel() !== level) {
			this.applyingConfiguredZoom = true;
			try { await this.host.setZoomLevel(level); }
			finally { this.applyingConfiguredZoom = false; }
		}
	}
}
