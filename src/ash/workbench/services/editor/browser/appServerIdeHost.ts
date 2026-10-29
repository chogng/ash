import { throwIfCancelled } from '../../../../base/common/cancellation.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, extUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { TaskQueue } from '../../../../base/common/async.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Range } from '../../../../editor/common/core/range.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { AppServerProtocolClient } from '../../../../platform/agentHost/browser/appServerProtocolClient.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INativeHostService } from '../../../common/services.js';
import type { INativeHostApi } from '../../../../platform/native/common/nativeHost.js';
import { createDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import { IWorkingCopyService } from '../../workingCopy/common/workingCopyService.js';
import { IEditorGroupsService } from '../common/editorGroupsService.js';
import { IEditorService } from '../common/editorService.js';
import { APP_SERVER_METHODS, APP_SERVER_SERVER_REQUESTS, type IdeContext } from '../../../../../../.build/protocol/typescript/index.js';

/** Publishes this live window; editor models, selections, tabs and undo retain their existing owners. */
export class AppServerIdeHost extends Disposable {
	private readonly lifetime = new AbortController();
	private readonly registration = new TaskQueue();
	// Separate the window lifetime from backend registration generations and frozen Turn targets.
	private readonly windowKey = generateUuid().replaceAll('-', '');
	private registered = false;

	constructor(
		private readonly client: AppServerProtocolClient,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
		@IEditorGroupsService private readonly groups: IEditorGroupsService,
		@IEditorService private readonly editors: IEditorService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@IWorkingCopyService private readonly workingCopies: IWorkingCopyService,
		@INativeHostService private readonly windowHost: INativeHostApi,
	) {
		super();
		this._register(
			toDisposable(() => {
				this.lifetime.abort();
				// Retire discovery after an in-flight registration, even if the connection stays open.
				void this.registration
					.schedule(async () => {
						if (client.state === 'ready') await client.request(APP_SERVER_METHODS['ide/request'], { type: 'unregister' });
					})
					.catch(error => {
						if (client.state === 'ready') onUnexpectedError(error);
					});
			}),
		);
		this._register(
			client.registerRequestHandler(APP_SERVER_SERVER_REQUESTS['ide/hostRequest'], async (params, context) => {
				const signal = AbortSignal.any([context.signal, this.lifetime.signal]);
				throwIfCancelled(signal);
				switch (params.type) {
					case 'openConversation':
						// The window service waits for Sessions to load the exact durable identity.
						// It carries no prompt, draft or permission changes into the receiving window.
						await this.windowHost.openAgentsWindow({
							conversation: { sessionId: params.sessionId, threadId: params.threadId },
						});
						break;
					case 'context':
						return { type: 'context', context: this.capture(params.roots) };
					case 'openFile': {
						const resource = this.displayResource(params.path);
						await this.editors.openEditor(
							{ resource },
							{
								ignoreError: true,
								...(params.line ? { selection: new Range(params.line, 1, params.line, 1) } : {}),
							},
						);
						break;
					}
					case 'openReview': {
						const original = this.displayResource(params.original);
						const modified = this.displayResource(params.modified);
						await this.editors.openEditor(createDiffEditorInput({ resource: original }, { resource: modified }), { ignoreError: true });
						break;
					}
				}
				throwIfCancelled(signal);
				return { type: 'opened' };
			}),
		);
		this._register(
			client.onStateChange(state => {
				this.registered = false;
				if (state === 'ready') this.publish();
			}),
		);
		this._register(workspace.onDidChangeWorkspace(() => this.publish()));
		this._register(editors.onDidActiveEditorChange(() => this.publish()));
		if (client.state === 'ready') this.publish();
	}

	/** Terminal launch waits for this window's registration; the desktop owns environment setup. */
	async readTerminalWindowKey(): Promise<string | undefined> {
		await this.registration.schedule(async () => {});
		return this.registered && !this.lifetime.signal.aborted ? this.windowKey : undefined;
	}

	private publish(): void {
		const generation = this.client.generation;
		void this.registration
			.schedule(async () => {
				if (this.lifetime.signal.aborted || this.client.state !== 'ready' || this.client.generation !== generation) return;
				this.registered = false;
				const workspace = this.workspace.getWorkspace();
				const roots = workspace.folders.filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
				// Remote windows require an execution-environment contract before they can attach.
				if (workspace.remoteAuthority || roots.length === 0) {
					this.registered = false;
					await this.client.request(APP_SERVER_METHODS['ide/request'], { type: 'unregister' });
				} else {
					const project = workspace.name ?? workspace.folders.map(folder => folder.name).join(', ');
					const active = this.editors.activeEditor;
					const label = active?.resource.scheme === 'file' ? basename(active.resource) : active?.label;
					const title = (label ? `${project} · ${label}` : project).replace(/\p{Cc}/gu, ' ').slice(0, 256);
					await this.client.request(APP_SERVER_METHODS['ide/request'], {
						type: 'register',
						title,
						roots,
						windowKey: this.windowKey,
					});
					this.registered = true;
				}
			})
			.catch(error => {
				if (!this.lifetime.signal.aborted && this.client.state === 'ready') onUnexpectedError(error);
			});
	}

	private displayResource(path: string): URI {
		const resource = URI.file(path);
		if (!this.workspace.getWorkspaceFolder(resource)) throw new Error('IDE display target is outside this workspace');
		return resource;
	}

	private capture(paths: readonly string[]): IdeContext {
		const roots = paths.map(path => URI.file(path));
		const allowed = (resource: URI): boolean => resource.scheme === 'file' && !!this.workspace.getWorkspaceFolder(resource) && roots.some(root => extUri.isEqualOrParent(resource, root));
		const active = this.codeEditors.getActiveCodeEditor();
		const model = active?.getModel();
		let activeFile: IdeContext['activeFile'] = null;
		if (model && allowed(model.uri)) {
			let remaining = 40_000;
			const selections = (active?.getSelections() ?? []).slice(0, 32).map(range => {
				const selected = model.getValueInRange(range);
				let text = '';
				// Count Unicode scalars so a truncated emoji remains valid JSON for Rust.
				for (const character of selected) {
					if (remaining === 0) break;
					text += character;
					remaining--;
				}
				return {
					startLine: range.startLineNumber,
					startColumn: range.startColumn,
					endLine: range.endLineNumber,
					endColumn: range.endColumn,
					text,
					truncated: text.length < selected.length,
				};
			});
			activeFile = { path: model.uri.fsPath, version: model.getVersionId(), selections };
		}
		const openTabs = [
			...new Set(
				this.groups.groups
					.flatMap(group => group.inputs)
					.map(input => input.resource)
					.filter(allowed)
					.map(resource => resource.fsPath),
			),
		].slice(0, 100);
		const dirtyFiles = [
			...new Set(
				this.workingCopies
					.getAll()
					.filter(copy => copy.isDirty && allowed(copy.resource))
					.map(copy => copy.resource.fsPath),
			),
		].slice(0, 100);
		return { activeFile, openTabs, dirtyFiles };
	}
}
