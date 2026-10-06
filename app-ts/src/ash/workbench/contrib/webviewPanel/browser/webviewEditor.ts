import { IFileService } from '../../../../platform/files/common/files.js';
import { IFilesConfigurationService } from '../../../services/filesConfiguration/common/filesConfigurationService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Range } from '../../../../editor/common/core/range.js';
import { Schemas } from '../../../../base/common/network.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import type { IResourceEditorInput, IEditorPane } from '../../../common/editor.js';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { WebviewElement } from '../../../../platform/webview/browser/webviewElement.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ITextModelResourceService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { CustomTextEditorModel } from '../../customEditor/common/customTextEditorModel.js';

export interface CustomTextEditorDocument {
	readonly uri: string;
	readonly text: string;
	readonly languageId: string;
	readonly version: number;
	readonly readOnly: boolean;
}

export interface CustomTextEditorContent {
	readonly html: string;
	/** Editable views accept version-bound changes and update their existing DOM. */
	readonly update?: unknown;
}

export interface CustomTextEditorProvider {
	readonly viewType: string;
	readonly displayName: string;
	render(document: CustomTextEditorDocument, signal: AbortSignal): Promise<CustomTextEditorContent>;
}

/** Generic text-backed webview host. Extension code owns the document's HTML. */
export class WebviewEditor extends EditorPane implements IEditorPane {
	public readonly id: string;
	private container: HTMLElement | undefined;
	private readonly inputResources = this._register(new DisposableStore());
	private readonly renderRequest = this._register(new MutableDisposable());
	private readonly webview = this._register(new MutableDisposable<WebviewElement>());
	private model: CustomTextEditorModel | undefined;
	private input: IResourceEditorInput | undefined;
	private renderedHtml: string | undefined;
	private editable = false;
	private applyingEdit = false;
	private readOnly = false;
	private refreshView: (() => void) | undefined;
	public get isEditable(): boolean { return this.editable; }
	public get workingCopy(): CustomTextEditorModel | undefined { return this.model; }

	constructor(
		private readonly provider: CustomTextEditorProvider,
		private readonly saveUntitled: (() => Promise<void | boolean>) | undefined,
		@ITextModelResourceService private readonly models: ITextModelResourceService,
		@IInstantiationService private readonly instantiation: IInstantiationService,
		@IThemeService private readonly themes: IThemeService,
		@IOpenerService private readonly opener: IOpenerService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IAccessibleViewService private readonly accessibleView: IAccessibleViewService,
		@IFileService private readonly files: IFileService,
		@IFilesConfigurationService private readonly filesConfiguration: IFilesConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
		@IStorageService storageService: IStorageService,
	) {
		super(provider.viewType, themes, storageService);
		this.id = provider.viewType;
	}

	public override create(parent: HTMLElement): void {
		this.container = h(parent.ownerDocument, 'div');
		this.container.className = 'ash-webview-editor';
		this.container.style.height = '100%';
		parent.append(this.container);
		super.create(this.container);
		this._register(toDisposable(() => this.container?.remove()));
	}

	public override async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		const reference = await this.models.acquire(input, signal);
		this.model = this.inputResources.add(this.instantiation.createInstance(CustomTextEditorModel, reference, input, this.saveUntitled));
		signal.throwIfAborted();
		this.input = input;
		const model = this.model;
		const stat = input.resource.scheme === Schemas.untitled ? undefined : await this.files.stat(input.resource);
		const updateReadonly = (): void => { this.readOnly = input.readOnly === true || !!this.filesConfiguration.isReadonly(input.resource, stat); };
		updateReadonly();
		const render = async (): Promise<void> => {
			const controller = new AbortController();
			this.renderRequest.value = toDisposable(() => controller.abort());
			const abort = (): void => controller.abort(signal.reason);
			signal.addEventListener('abort', abort, { once: true });
			try {
				const content = await this.provider.render({ uri: input.resource.toString(), text: reference.model.getText(), languageId: reference.model.getLanguageId(), version: reference.model.getVersionId(), readOnly: this.readOnly }, controller.signal);
				if (controller.signal.aborted || this.model !== model) {
					return;
				}
				const variables = Object.entries(this.themes.getColorTheme().colors).map(([id, value]) => `${colorCssVariable(id)}:${value}`).join(';');
				this.editable = content.update !== undefined;
				this.renderedHtml = `<style>:root{${variables}}</style>${content.html}`;
				if (this.webview.value) {
					if (content.update !== undefined) {
						this.webview.value.postMessage({ type: 'theme', variables });
						this.webview.value.postMessage(content.update);
					} else { this.webview.value.setHtml(this.renderedHtml); }
				} else if (this.isVisible()) {
					this.createWebview(input, this.renderedHtml);
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					throw error;
				}
			} finally {
				signal.removeEventListener('abort', abort);
			}
		};
		const schedule = this.inputResources.add(new RunOnceScheduler(() => {
			void render().catch(error => {
				if (this.model === model) {
					console.error('Custom editor rendering failed', error);
				}
			});
		}, 50));
		this.refreshView = () => schedule.schedule();
		this.inputResources.add(model.onDidChangeContent(() => { if (!this.applyingEdit) schedule.schedule(); }));
		this.inputResources.add(this.filesConfiguration.onDidChangeReadonly(() => { updateReadonly(); schedule.schedule(); }));
		this.inputResources.add(this.themes.onDidColorThemeChange(() => schedule.schedule()));
		await render();
	}

	public override setVisible(visible: boolean): void {
		super.setVisible(visible);
		// A sandbox document must enter a visible pane before its first navigation.
		if (visible && !this.webview.value && this.input && this.renderedHtml !== undefined) {
			this.createWebview(this.input, this.renderedHtml);
		}
	}

	private createWebview(input: IResourceEditorInput, html: string): void {
		this.webview.value = new WebviewElement(this.container!, { title: this.provider.displayName, initialHtml: html, forwardKeyboardEvents: true });
		const webview = this.webview.value;
		// An opaque iframe cannot bubble its keyboard events into the owning editor group.
		this.inputResources.add(webview.onDidKeyboardEvent(event => webview.element.dispatchEvent(event)));
		const updateHint = (): void => {
			const hint = this.accessibleView.getOpenAriaHint(AccessibilityVerbositySettingId.WebviewEditor);
			const label = hint ? `${this.provider.displayName}\n${hint}` : this.provider.displayName;
			webview.element.setAttribute('aria-label', label);
		};
		updateHint();
		this.inputResources.add(this.keybindings.onDidUpdateKeybindings(updateHint));
		this.inputResources.add(this.configuration.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(AccessibilityVerbositySettingId.WebviewEditor)) {
				updateHint();
			}
		}));
		this.inputResources.add(this.webview.value.onDidMessage(message => {
			if (this.editable && typeof message === 'object' && message !== null && 'type' in message) {
				this.handleEditMessage(message, webview);
				return;
			}
			if (typeof message !== 'object' || message === null || !('href' in message) || typeof message.href !== 'string') {
				return;
			}
			if (!URL.canParse(message.href, input.resource.toString())) {
				return;
			}
			const url = new URL(message.href, input.resource.toString());
			if (['http:', 'https:', 'mailto:', 'file:', 'ash-remote:'].includes(url.protocol)) {
				void this.opener.open(url.href);
			}
		}));
	}

	private handleEditMessage(message: object & { type: unknown; }, webview: WebviewElement): void {
		const model = this.model?.reference.model;
		if (!model) return;
		if (message.type === 'ready') { this.refreshView?.(); return; }
		if (message.type === 'save') {
			void this.save().catch(error => this.notifications.error(error));
			return;
		}
		if (message.type !== 'edit' && message.type !== 'undo' && message.type !== 'redo') return;
		if (!('version' in message) || !Number.isSafeInteger(message.version) || message.version !== model.getVersionId() || this.readOnly) {
			webview.postMessage({ type: 'editRejected', reason: this.readOnly ? 'readonly' : 'conflict', document: { uri: model.uri.toString(), text: model.getText(), languageId: model.getLanguageId(), version: model.getVersionId(), readOnly: this.readOnly } });
			this.refreshView?.();
			return;
		}
		if (message.type === 'edit') {
			if (!('text' in message) || typeof message.text !== 'string' || message.text.length > 16 * 1024 * 1024) {
				webview.postMessage({ type: 'editRejected', reason: 'invalid' });
				return;
			}
			const previous = model.getText();
			const next = message.text;
			let start = 0;
			while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
			let end = previous.length;
			let nextEnd = next.length;
			while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
			this.applyingEdit = true;
			try {
				if (start !== end || start !== nextEnd) {
					model.pushStackElement();
					model.pushEditOperations(null, [{ range: Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end)), text: next.slice(start, nextEnd) }], null);
					model.pushStackElement();
				}
			} finally { this.applyingEdit = false; }
			webview.postMessage({ type: 'accepted', version: model.getVersionId(), text: model.getText() });
		} else {
			if (message.type === 'undo') model.undo(); else model.redo();
			this.refreshView?.();
		}
	}

	public override clearInput(): void {
		this.renderRequest.clear();
		this.model = undefined;
		this.input = undefined;
		this.renderedHtml = undefined;
		this.editable = false;
		this.refreshView = undefined;
		this.inputResources.clear();
		this.webview.clear();
	}
	public override getControl(): WebviewElement | undefined { return this.webview.value; }

	public override layout(dimension: IDimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}

	public override focus(): void { this.webview.value?.focus(); }
	public async save(): Promise<void> { await this.model?.save(new AbortController().signal); }
	public async saveAs(resource: URI): Promise<void> { await this.model?.saveAs(resource, new AbortController().signal); }
}
