import { INotificationService } from '../../../platform/notification/common/notification.js';
import { EditorOption } from '../../../editor/common/config/editorOptions.js';
import { Disposable, DisposableMap, DisposableStore, toDisposable } from '../../../base/common/lifecycle.js';
import { localize } from '../../../nls.js';
import {
	IExtensionHostApi,
	type ExtensionClientSource,
	type ExtensionHostFleetSnapshot,
	type JsonValue,
} from '../../../platform/agentHost/common/extensionHostApi.js';
import { IExtensionService } from '../../services/extensions/common/extensionService.js';
import { IImageEditorService, type CodeImageSnapshot } from '../../services/imageEditor/common/imageEditorService.js';
import { ICodeEditorService } from '../../../editor/browser/services/codeEditorService.js';
import { resolveSemanticTokenPresentation } from '../../../editor/common/services/semanticTokensStyling.js';
import { EditorSemanticHighlightingConfiguration } from '../../../editor/common/config/editorConfigurationSchema.js';
import { IThemeService } from '../../../platform/theme/common/themeService.js';
import { IConfigurationService } from '../../../platform/configuration/common/configuration.js';
import { basename } from '../../../base/common/resources.js';

/** Adapts the public image capability to client-owned capture and sandbox services. No extension code runs here. */
export class MainThreadImageEditors extends Disposable {
	private readonly registrations = this._register(new DisposableMap<string, DisposableStore>());
	private readonly bindings = new Map<
		string,
		{ readonly identity: string; readonly source: ExtensionClientSource; readonly signal: AbortSignal }
	>();
	constructor(
		private readonly timeout: number,
		@IExtensionHostApi private readonly runtime: IExtensionHostApi,
		@IExtensionService private readonly extensions: IExtensionService,
		@IImageEditorService private readonly editors: IImageEditorService,
		@ICodeEditorService private readonly codeEditors: ICodeEditorService,
		@IThemeService private readonly theme: IThemeService,
		@IConfigurationService private readonly configuration: IConfigurationService,
		@INotificationService private readonly notifications: INotificationService,
	) {
		super();
	}

	update(snapshot: ExtensionHostFleetSnapshot): void {
		const declarations =
			this.extensions.getExtensionPointContributions<
				readonly {
					readonly id: string;
					readonly displayName: string;
					readonly default?: boolean;
					readonly accessibilityHelp: string;
				}[]
			>('imageEditors');
		const active = new Set<string>();
		for (const owner of snapshot.extensions) {
			if (owner.lifecycle !== 'ready' || owner.incarnation === undefined) continue;
			for (const registration of owner.registrations) {
				if (registration.kind !== 'dataChannel' || registration.channelId !== 'image.editor.v1') continue;
				const declaration = declarations
					.find(entry => entry.description.id === owner.id)
					?.value.find(entry => entry.id === registration.registrationId);
				if (!declaration) continue;
				const id = `${owner.id}:${registration.registrationId}`;
				active.add(id);
				const identity = JSON.stringify([
					owner.packageDigest,
					owner.incarnation,
					owner.activationGeneration,
					declaration,
				]);
				if (this.bindings.get(id)?.identity === identity) continue;
				this.registrations.deleteAndDispose(id);
				const lifetime = new DisposableStore();
				const controller = new AbortController();
				lifetime.add(toDisposable(() => controller.abort()));
				const source = {
					extensionId: owner.id,
					incarnation: owner.incarnation,
					activationGeneration: owner.activationGeneration,
				};
				this.bindings.set(id, { identity, source, signal: controller.signal });
				this.registrations.set(id, lifetime);
				lifetime.add(
					this.editors.register({
						id,
						displayName: declaration.displayName,
						default: declaration.default === true,
						accessibilityHelp: declaration.accessibilityHelp,
						signal: controller.signal,
						resolve: async (sourceKind, signal) => {
							const payload = await this.runtime.invoke(
								{
									...source,
									registrationId: registration.registrationId,
									operation: 'receiveData',
									payload: { data: { source: sourceKind } },
									deadlineUnixMillis: Date.now() + this.timeout,
								},
								signal,
							);
							const value = record(payload);
							if (typeof value.html !== 'string' || value.html.length > 256 * 1024)
								throw new TypeError('Invalid image editor view');
							if (
								!Array.isArray(value.resources) ||
								value.resources.length > 64 ||
								value.resources.some(
									uri =>
										typeof uri !== 'string' ||
										uri.length > 4096 ||
										!URL.canParse(uri) ||
										new URL(uri).protocol !== 'blob:',
								)
							)
								throw new TypeError('Invalid image view resources');
							const resources = new Set(value.resources as string[]);
							const read = async (uri: string): Promise<string> => {
								if (!resources.has(uri)) throw new TypeError('Image view resource was not registered');
								const response = await fetch(uri, { signal });
								if (!response.ok) throw new Error('Image view resource is unavailable');
								const text = await response.text();
								if (text.length > 4 * 1024 * 1024)
									throw new RangeError('Image view resource is too large');
								return text;
							};
							// A detached template is inert: no author script or resource is loaded
							// in the host document. Keep resource order and allow HTML-only views.
							const template = document.createElement('template');
							template.innerHTML = value.html;
							for (const element of template.content.querySelectorAll(
								'script[src], link[rel="stylesheet"][href]',
							)) {
								const script = element.tagName === 'SCRIPT';
								const content = await read(element.getAttribute(script ? 'src' : 'href')!);
								const inline = document.createElement(script ? 'script' : 'style');
								if (script && element.hasAttribute('type'))
									inline.setAttribute('type', element.getAttribute('type')!);
								inline.textContent = content.replaceAll(
									script ? /<\/script/gi : /<\/style/gi,
									script ? '<\\/script' : '<\\/style',
								);
								element.replaceWith(inline);
							}
							signal.throwIfAborted();
							return {
								html:
									`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; font-src data:">` +
									template.innerHTML,
								state: value.state,
							};
						},
					}),
				);
			}
		}
		for (const id of this.registrations.keys())
			if (!active.has(id)) {
				this.registrations.deleteAndDispose(id);
				this.bindings.delete(id);
			}
	}

	clear(): void {
		this.registrations.clearAndDisposeAll();
		this.bindings.clear();
	}

	async show(payload: JsonValue, signal: AbortSignal, source: ExtensionClientSource): Promise<void> {
		const value = record(payload);
		if (typeof value.viewType !== 'string' || !['screen', 'selection'].includes(value.source as string))
			throw new TypeError('Invalid image editor request');
		const id = `${source.extensionId}:${value.viewType}`;
		const binding = this.bindings.get(id);
		if (
			!binding ||
			binding.source.incarnation !== source.incarnation ||
			binding.source.activationGeneration !== source.activationGeneration
		)
			throw new Error('Image editor registration has retired');
		const code = value.source === 'selection' ? await this.selection(signal) : undefined;
		signal.throwIfAborted();
		if (this.bindings.get(id) !== binding) throw new Error('Image editor registration has retired');
		// Opening a view transfers its lifetime to the registered provider and window.
		// The initiating command can finish without imposing its RPC deadline on annotation.
		void this.editors.show({ editorId: id, code }, binding.signal).catch(error => {
			if (!binding.signal.aborted) this.notifications.error(error);
		});
	}

	private async selection(signal: AbortSignal): Promise<CodeImageSnapshot> {
		const editor = this.codeEditors.getActiveCodeEditor();
		const model = editor?.getModel();
		const selection = editor?.getSelection();
		if (!editor || !model || !selection || selection.isEmpty()) {
			throw new Error(
				localize('imageEditor.noSelection', 'Select code in an editor before creating a code image.'),
			);
		}
		const version = model.getVersionId();
		await model.tokenization.whenReady(signal);
		signal.throwIfAborted();
		if (model.isDisposed() || model.getVersionId() !== version || editor.getModel() !== model) {
			throw new Error(
				localize('imageEditor.noSelection', 'Select code in an editor before creating a code image.'),
			);
		}
		const lastLine = selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber;
		if (lastLine - selection.startLineNumber > 2000 || model.getValueInRange(selection).length > 256 * 1024)
			throw new Error(localize('imageEditor.selectionTooLarge', 'Select less code to create an image.'));
		const theme = this.theme.getColorTheme();
		const preference = this.configuration.getValue<boolean | 'configuredByTheme'>(
			EditorSemanticHighlightingConfiguration,
		);
		const semanticHighlighting =
			preference === true || (preference !== false && theme.semanticHighlighting === true);
		const font = editor.getOption(EditorOption.fontInfo);
		const element = editor.getDomNode();
		const style = element ? getComputedStyle(element) : undefined;
		const foreground = style?.getPropertyValue('--ash-editor-foreground').trim() || '#d4d4d4';
		const lines: CodeImageSnapshot['lines'][number][] = [];
		for (let line = selection.startLineNumber; line <= lastLine; line++) {
			model.tokenization.forceTokenization(line);
			const tokens = model.tokenization.renderedTokens.getLineTokens(line - 1);
			const content = model.getLineContent(line);
			const start = line === selection.startLineNumber ? selection.startColumn - 1 : 0;
			const end = line === selection.endLineNumber ? selection.endColumn - 1 : content.length;
			const result: CodeImageSnapshot['lines'][number][number][] = [];
			const append = (
				text: string,
				presentation: ReturnType<typeof resolveSemanticTokenPresentation> = {},
			): void => {
				if (!text) return;
				const flags = presentation.fontStyle ?? [];
				result.push({
					text,
					color: presentation.foreground ?? foreground,
					italic: flags.includes('italic'),
					bold: flags.includes('bold'),
					underline: flags.includes('underline'),
					strikethrough: flags.includes('strikethrough'),
				});
			};
			let offset = start;
			for (const token of tokens) {
				const tokenStart = Math.max(start, token.startColumn);
				const tokenEnd = Math.min(end, token.endColumn);
				if (tokenStart >= tokenEnd) continue;
				append(content.slice(offset, tokenStart));
				append(
					content.slice(tokenStart, tokenEnd),
					resolveSemanticTokenPresentation(token, theme, semanticHighlighting),
				);
				offset = tokenEnd;
			}
			append(content.slice(offset, end));
			lines.push(result);
		}
		return {
			title: basename(model.uri),
			firstLine: selection.startLineNumber,
			lines,
			foreground,
			background: style?.getPropertyValue('--ash-editor-background').trim() || '#1e1e1e',
			fontFamily: font.fontFamily,
			fontSize: font.fontSize,
			tabSize: model.getOptions().tabSize,
		};
	}
}

function record(value: unknown): Record<string, JsonValue> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('Expected an image editor object');
	return value as Record<string, JsonValue>;
}
