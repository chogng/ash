import type { IResourceEditorInput } from '../../../common/editor.js';
import { h, type IDimension } from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { AccessibilityVerbositySettingId, IAccessibleViewService } from '../../../../platform/accessibility/browser/accessibleView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import type { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { colorCssVariable } from '../../../../platform/theme/common/colorUtils.js';
import { WebviewElement } from '../../../../platform/webview/browser/webviewElement.js';
import { EditorPaneVisibility, type IEditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ITextModelResourceService } from '../../../services/textmodelResolver/common/textModelResourceService.js';
import { CustomTextEditorModel } from '../../customEditor/common/customTextEditorModel.js';

export interface CustomTextEditorProvider {
	readonly viewType: string;
	readonly displayName: string;
	render(document: { readonly uri: string; readonly text: string; readonly languageId: string; }, signal: AbortSignal): Promise<string>;
}

/** Generic text-backed webview host. Extension code owns the document's HTML. */
export class WebviewEditor extends Disposable implements IEditorPane {
	public readonly id: string;
	private container: HTMLElement | undefined;
	private readonly inputResources = this._register(new DisposableStore());
	private readonly renderRequest = this._register(new MutableDisposable());
	private readonly webview = this._register(new MutableDisposable<WebviewElement>());
	private model: CustomTextEditorModel | undefined;
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
	) {
		super();
		this.id = provider.viewType;
	}

	public create(parent: HTMLElement): void {
		this.container = h(parent.ownerDocument, 'div');
		this.container.className = 'ash-webview-editor';
		this.container.style.height = '100%';
		parent.append(this.container);
		this._register(toDisposable(() => this.container?.remove()));
	}

	public async setInput(input: IResourceEditorInput, signal: AbortSignal): Promise<void> {
		this.clearInput();
		const reference = await this.models.acquire(input, signal);
		this.model = this.inputResources.add(this.instantiation.createInstance(CustomTextEditorModel, reference, input, this.saveUntitled));
		signal.throwIfAborted();
		this.webview.value = new WebviewElement(this.container!, { title: this.provider.displayName, forwardKeyboardEvents: true });
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
		const model = this.model;
		const render = async (): Promise<void> => {
			const controller = new AbortController();
			this.renderRequest.value = toDisposable(() => controller.abort());
			const abort = (): void => controller.abort(signal.reason);
			signal.addEventListener('abort', abort, { once: true });
			try {
				const html = await this.provider.render({ uri: input.resource.toString(), text: reference.model.getText(), languageId: reference.model.getLanguageId() }, controller.signal);
				if (controller.signal.aborted || this.model !== model) {
					return;
				}
				const variables = Object.entries(this.themes.getColorTheme().colors).map(([id, value]) => `${colorCssVariable(id)}:${value}`).join(';');
				this.webview.value!.setHtml(`<style>:root{${variables}}</style>${html}`);
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
		this.inputResources.add(model.onDidChangeContent(() => schedule.schedule()));
		this.inputResources.add(this.themes.onDidColorThemeChange(() => schedule.schedule()));
		this.inputResources.add(this.webview.value.onDidMessage(message => {
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
		await render();
	}

	public clearInput(): void {
		this.renderRequest.clear();
		this.model = undefined;
		this.inputResources.clear();
		this.webview.clear();
	}
	public getControl(): WebviewElement | undefined { return this.webview.value; }

	public layout(dimension: IDimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}

	public setVisible(visibility: EditorPaneVisibility): void {
		if (this.container) {
			this.container.hidden = visibility === EditorPaneVisibility.Hidden;
		}
	}

	public focus(): void { this.webview.value?.focus(); }
	public async save(): Promise<void> { await this.model?.save(new AbortController().signal); }
	public async saveAs(resource: URI): Promise<void> { await this.model?.saveAs(resource, new AbortController().signal); }
}
