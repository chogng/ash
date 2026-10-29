import { addDisposableListener, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { Color } from '../../../../base/common/color.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { getNLSLanguage, localize } from '../../../../nls.js';
import type { IColorTheme } from '../../../../platform/theme/common/themeService.js';
import type { ColorContribution, ColorValue } from '../../../../platform/theme/common/colorRegistry.js';
import { serializeUserColorThemeDraft } from '../../../services/themes/common/colorThemeData.js';
import type { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { WorkbenchConfiguration } from '../../../common/configuration.js';

/** Presentation preferences shared with the host, never its paths, accounts or backend settings. */
export const themePreviewConfigurationKeys = [
	...Object.values(WorkbenchConfiguration),
	'editor.fontFamily',
	'editor.fontSize',
	'editor.lineHeight',
	'editor.fontLigatures',
	'editor.minimap.enabled',
	'editor.lineNumbers',
	'editor.wordWrap',
	'workbench.editor.showTabs',
	'workbench.editor.tabSizing',
	'breadcrumbs.enabled',
	'window.commandCenter',
	'window.density',
	'sessions.layoutStyle',
	'sessions.activityBar.location',
	'sessions.activityBar.compact',
] as const;

interface PreviewColor {
	readonly id: string;
	readonly description: string;
	readonly value: Color | undefined;
	readonly references: ThemeColorReferences | undefined;
}

export interface ThemeColorReferences {
	readonly kind: 'linked' | 'derived';
	readonly tokens: readonly string[];
}

/** Describe registry defaults without resolving colors or inferring links from equal values. */
export function getThemeColorReferences(theme: IColorTheme, entry: ColorContribution): ThemeColorReferences | undefined {
	// Included themes also define overrides; their values must not be presented as default links.
	if (theme.defines(entry.id)) return undefined;
	const value = entry.defaults[theme.colorScheme];
	const tokens = new Set<string>();
	const collect = (value: ColorValue): void => {
		if (typeof value === 'string') {
			if (!value.startsWith('#')) tokens.add(value);
		} else if (value && 'op' in value) {
			collect(value.value);
			if (value.op === 'mix') collect(value.other);
			if (value.op === 'opaque') collect(value.background);
		}
	};
	collect(value);
	return tokens.size ? { kind: typeof value === 'string' ? 'linked' : 'derived', tokens: [...tokens] } : undefined;
}

/** Owns the preview document and sends theme data and presentation preferences to its isolated host. */
export class ThemePreview extends Disposable {
	public readonly element: HTMLIFrameElement;
	private source: string | undefined;
	private lastTheme: IColorTheme | undefined;
	private lastAuthoredColors: string | undefined;
	private sentSource: string | undefined;
	private sentConfiguration: string | undefined;
	private port: MessagePort | undefined;
	private readonly pendingUpdate = this._register(new MutableDisposable<ReturnType<typeof scheduleAtNextAnimationFrame>>());
	private readonly connection = this._register(new MutableDisposable<DisposableStore>());
	private content = '';
	private readonly colorsChanged = this._register(new Emitter<void>());
	readonly onDidChangeColors = this.colorsChanged.event;
	private previewColors: readonly PreviewColor[] = [];
	get colors(): readonly PreviewColor[] {
		return this.previewColors;
	}

	constructor(
		container: HTMLElement,
		onAccessibleView: (help: boolean) => void,
		private readonly configuration: IConfigurationService,
	) {
		super();
		// Renderer chunks can live in nested assets directories; the page is rooted at the bundle.
		const root = import.meta.env.DEV ? new URL(import.meta.url).origin + '/' : import.meta.url.slice(0, import.meta.url.lastIndexOf('/assets/') + 1);
		let token: string;
		const tabsHost = h(container.ownerDocument, 'div', { className: 'ash-theme-editor-preview-tabs' });
		container.append(tabsHost);
		const tabs = this._register(
			new TabList<'workbench' | 'diff' | 'sessions'>(tabsHost, {
				presentation: 'inset',
				ariaLabel: localize('themeEditor.previewWindow', 'Preview window'),
				onActivate: value => selectWindow(value),
			}),
		);
		let selected: 'workbench' | 'diff' | 'sessions' | undefined;
		const selectWindow = (value: 'workbench' | 'diff' | 'sessions'): void => {
			if (selected === value) return;
			selected = value;
			this.connection.clear();
			this.sentSource = undefined;
			this.sentConfiguration = undefined;
			this.content = '';
			this.previewColors = [];
			this.colorsChanged.fire();
			token = crypto.randomUUID();
			const page = value === 'sessions' ? 'sessionsThemePreview' : 'themePreview';
			const url = new URL(`browser/theme-preview/${page}.html`, root);
			url.searchParams.set('locale', getNLSLanguage());
			url.searchParams.set('channel', token);
			if (value === 'diff') url.searchParams.set('sample', 'diff');
			this.element.src = url.href;
			tabs.setTabs(
				[
					{
						id: 'workbench',
						value: 'workbench',
						label: localize('themeEditor.workbenchWindow', 'Workbench'),
						tabId: 'theme-preview-workbench',
					},
					{
						id: 'diff',
						value: 'diff',
						label: localize('themeEditor.diffPreview', 'Diff'),
						tabId: 'theme-preview-diff',
					},
					{
						id: 'sessions',
						value: 'sessions',
						label: localize('themeEditor.sessionsWindow', 'Agent Window'),
						tabId: 'theme-preview-sessions',
					},
				],
				value,
			);
		};
		this.element = h(container.ownerDocument, 'iframe', {
			className: 'ash-theme-editor-preview',
			attributes: {
				title: localize('themeEditor.interactivePreview', 'Interactive theme preview'),
				sandbox: 'allow-scripts allow-same-origin',
			},
		});
		const viewport = h(container.ownerDocument, 'div', { className: 'ash-theme-editor-preview-viewport' });
		container.append(viewport);
		viewport.append(this.element);
		// Preserve desktop layout density when the inspector leaves a narrow preview canvas.
		// Only the frame is scaled; its document still lays out in desktop CSS pixels.
		const resizeFrame = this._register(new MutableDisposable<ReturnType<typeof scheduleAtNextAnimationFrame>>());
		this._register(
			observeResize(viewport, entries => {
				const { width, height } = entries[0]!.contentRect;
				if (width <= 0 || height <= 0) return;
				const scale = Math.min(1, width / 1040, height / 680);
				// Changing an iframe's size during observer delivery invalidates its
				// document root after that document has already delivered its resize.
				resizeFrame.value = scheduleAtNextAnimationFrame(getWindow(container), () => {
					this.element.style.width = `${width / scale}px`;
					this.element.style.height = `${height / scale}px`;
					this.element.style.transform = `scale(${scale})`;
				});
			}),
		);
		const origin = new URL(root).origin;
		const localFile = new URL(root).protocol === 'file:';
		this._register(
			addDisposableListener(getWindow(container), 'message', (event: MessageEvent<unknown>) => {
				// Electron serializes file document senders as an opaque origin even
				// when URL.origin reports file://. The source and token still bind this frame.
				if (event.source !== this.element.contentWindow || (localFile ? event.origin !== 'null' && event.origin !== 'file://' : event.origin !== origin)) return;
				const data = event.data;
				if (!data || typeof data !== 'object' || !('kind' in data)) return;
				if (data.kind !== 'ash-theme-preview-ready' || !('token' in data) || data.token !== token) return;
				this.connection.clear();
				this.sentSource = undefined;
				this.sentConfiguration = undefined;
				const lifetime = new DisposableStore();
				this.connection.value = lifetime;
				const channel = new MessageChannel();
				this.port = channel.port1;
				lifetime.add(
					toDisposable(() => {
						channel.port1.close();
						this.port = undefined;
					}),
				);
				lifetime.add(
					addDisposableListener(channel.port1, 'message', (message: MessageEvent<unknown>) => {
						const value = message.data;
						if (!value || typeof value !== 'object' || !('kind' in value)) return;
						if (value.kind === 'ash-theme-preview-content' && 'text' in value && typeof value.text === 'string' && value.text.length <= 1_048_576) {
							this.content = value.text;
						} else if (value.kind === 'ash-theme-preview-colors' && 'colors' in value && Array.isArray(value.colors) && value.colors.length <= 5000) {
							if (!('replace' in value) || typeof value.replace !== 'boolean') return;
							const colors: PreviewColor[] = [];
							for (const entry of value.colors) {
								if (
									!entry ||
									typeof entry !== 'object' ||
									typeof entry.id !== 'string' ||
									!/^[a-zA-Z][a-zA-Z0-9.]*$/u.test(entry.id) ||
									typeof entry.description !== 'string' ||
									entry.description.length > 4096
								)
									return;
								if (entry.value !== null && (typeof entry.value !== 'string' || !/^#[\da-f]{6}(?:[\da-f]{2})?$/iu.test(entry.value))) return;
								const references = entry.references;
								if (
									references !== undefined &&
									(!references ||
										typeof references !== 'object' ||
										!['linked', 'derived'].includes(references.kind) ||
										!Array.isArray(references.tokens) ||
										references.tokens.length < 1 ||
										references.tokens.length > 100 ||
										references.tokens.some((id: unknown) => typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9.]*$/u.test(id)))
								)
									return;
								colors.push({
									id: entry.id,
									description: entry.description,
									value: entry.value ? Color.fromHex(entry.value) : undefined,
									references,
								});
							}
							const merged = new Map(value.replace ? [] : this.previewColors.map(entry => [entry.id, entry]));
							for (const entry of colors) merged.set(entry.id, entry);
							this.previewColors = [...merged.values()];
							this.colorsChanged.fire();
						} else if (value.kind === 'ash-theme-preview-accessibility' && 'help' in value && typeof value.help === 'boolean') {
							onAccessibleView(value.help);
						}
					}),
				);
				channel.port1.start();
				// A capability port handles the auxiliary host's different JavaScript realm.
				this.element.contentWindow?.postMessage({ kind: 'ash-theme-preview-connect', token }, localFile || origin === 'null' ? '*' : origin, [channel.port2]);
				this.sendTheme();
			}),
		);
		this._register(
			toDisposable(() => {
				this.element.src = 'about:blank';
				viewport.remove();
			}),
		);
		selectWindow('workbench');
		this._register(
			configuration.onDidChangeConfiguration(event => {
				if (themePreviewConfigurationKeys.some(key => event.affectsConfiguration(key))) this.scheduleUpdate();
			}),
		);
	}

	public update(theme: IColorTheme, authoredColors: Readonly<Record<string, string>>): void {
		const authored = JSON.stringify(authoredColors);
		if (theme === this.lastTheme && authored === this.lastAuthoredColors) return;
		this.lastTheme = theme;
		this.lastAuthoredColors = authored;
		const resolved = JSON.parse(serializeUserColorThemeDraft(theme, theme.label));
		// The other product's tokens need not be registered in the editing window.
		this.source = JSON.stringify({ ...resolved, colors: { ...resolved.colors, ...authoredColors } });
		this.scheduleUpdate();
	}

	public getAccessibleContent(): string {
		return this.content;
	}

	private scheduleUpdate(): void {
		if (!this.pendingUpdate.value) {
			this.pendingUpdate.value = scheduleAtNextAnimationFrame(getWindow(this.element), () => {
				this.pendingUpdate.clear();
				this.sendTheme();
			});
		}
	}

	private sendTheme(): void {
		if (!this.source || !this.port) return;
		const configuration = Object.fromEntries(themePreviewConfigurationKeys.map(key => [key, this.configuration.getValue(key)]).filter(([, value]) => value !== undefined));
		const serialized = JSON.stringify(configuration);
		const themeChanged = this.source !== this.sentSource;
		const configurationChanged = serialized !== this.sentConfiguration;
		if (!themeChanged && !configurationChanged) return;
		this.port.postMessage({
			kind: 'ash-theme-preview-theme',
			...(themeChanged ? { source: this.source } : {}),
			...(configurationChanged ? { configuration } : {}),
		});
		this.sentSource = this.source;
		this.sentConfiguration = serialized;
	}
}
