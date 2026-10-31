import { addDisposableListener, getWindow, h, scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { Emitter } from '../../../../base/common/event.js';
import { TabList } from '../../../../base/browser/ui/tablist/tabList.js';
import { Color } from '../../../../base/common/color.js';
import { observeResize } from '../../../../base/browser/observer.js';
import {
	Disposable,
	DisposableMap,
	DisposableStore,
	MutableDisposable,
	toDisposable,
} from '../../../../base/common/lifecycle.js';
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
export function getThemeColorReferences(
	theme: IColorTheme,
	entry: ColorContribution,
): ThemeColorReferences | undefined {
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

type PreviewWindow = 'workbench' | 'sessions';
type PreviewScene = 'interface' | 'code' | 'diff' | 'scm';

/** One retained document owns its channel and reported state until the editor closes. */
class ThemePreviewFrame extends Disposable {
	public readonly domNode: HTMLIFrameElement;
	public readonly connection = this._register(new MutableDisposable<DisposableStore>());
	public port: MessagePort | undefined;
	public sentSource: string | undefined;
	public sentConfiguration: string | undefined;
	public started = false;
	public content = '';
	public colors: readonly PreviewColor[] = [];

	constructor(
		document: Document,
		public readonly token: string,
		public readonly url: string,
	) {
		super();
		this.domNode = h(document, 'iframe', {
			className: 'ash-theme-editor-preview',
			attributes: {
				title: localize('themeEditor.interactivePreview', 'Interactive theme preview'),
				sandbox: 'allow-scripts allow-same-origin',
			},
		});
		this._register(
			toDisposable(() => {
				this.domNode.src = 'about:blank';
				this.domNode.remove();
			}),
		);
	}
}

/** Lazily owns isolated window scenes and synchronizes their theme and presentation preferences. */
export class ThemePreview extends Disposable {
	private readonly frames = this._register(new DisposableMap<string, ThemePreviewFrame>());
	private active: ThemePreviewFrame | undefined;
	private window: PreviewWindow = 'workbench';
	private readonly scenes = new Map<PreviewWindow, PreviewScene>();
	public get selection(): { readonly window: PreviewWindow; readonly scene: PreviewScene; } {
		return { window: this.window, scene: this.scenes.get(this.window) ?? 'interface' };
	}
	public get scope(): string {
		return `${this.selection.window}:${this.selection.scene}`;
	}
	private readonly selectionChanged = this._register(new Emitter<void>());
	public readonly onDidChangeSelection = this.selectionChanged.event;
	private readonly ownerWindow: Window;
	public get element(): HTMLIFrameElement | undefined {
		return this.active?.domNode;
	}
	private source: string | undefined;
	private lastTheme: IColorTheme | undefined;
	private lastAuthoredColors: string | undefined;
	private readonly pendingUpdate = this._register(
		new MutableDisposable<ReturnType<typeof scheduleAtNextAnimationFrame>>(),
	);
	private readonly colorsChanged = this._register(new Emitter<void>());
	readonly onDidChangeColors = this.colorsChanged.event;
	get colors(): readonly PreviewColor[] {
		// Keep discovered token definitions available in All colors after changing windows.
		const colors = new Map<string, PreviewColor>();
		for (const [, frame] of this.frames) for (const color of frame.colors) colors.set(color.id, color);
		for (const color of this.active?.colors ?? []) colors.set(color.id, color);
		return [...colors.values()];
	}

	constructor(
		container: HTMLElement,
		onAccessibleView: (help: boolean) => void,
		private readonly configuration: IConfigurationService,
		toolbarContainer: HTMLElement,
		createActions: (container: HTMLElement) => void,
	) {
		super();
		this.ownerWindow = getWindow(container);
		// Renderer chunks can live in nested assets directories; the page is rooted at the bundle.
		const root = import.meta.env.DEV
			? new URL(import.meta.url).origin + '/'
			: import.meta.url.slice(0, import.meta.url.lastIndexOf('/assets/') + 1);
		const viewport = h(container.ownerDocument, 'div', { className: 'ash-theme-editor-preview-viewport' });
		container.append(viewport);
		let geometry: { width: number; height: number; scale: number; } | undefined;
		const resize = (frame: ThemePreviewFrame): void => {
			if (!geometry) return;
			const { width, height, scale } = geometry;
			frame.domNode.style.width = `${width / scale}px`;
			frame.domNode.style.height = `${height / scale}px`;
			frame.domNode.style.transform = `scale(${scale})`;
		};
		const toolbar = h(container.ownerDocument, 'div', { className: 'ash-theme-editor-preview-toolbar' });
		const tabsHost = h(container.ownerDocument, 'div', { className: 'ash-theme-editor-preview-tabs' });
		const scenesHost = h(container.ownerDocument, 'div', { className: 'ash-theme-editor-preview-scenes' });
		const actions = h(container.ownerDocument, 'div', { className: 'ash-theme-editor-preview-actions' });
		toolbar.append(tabsHost, actions);
		toolbarContainer.append(toolbar);
		createActions(actions);
		const tabs = this._register(
			new TabList<PreviewWindow>(tabsHost, {
				presentation: 'inset',
				ariaLabel: localize('themeEditor.previewWindow', 'Preview window'),
				onActivate: value => selectPreview(value, this.scenes.get(value) ?? 'interface'),
			}),
		);
		const sceneTabs = this._register(
			new TabList<PreviewScene>(scenesHost, {
				presentation: 'inset',
				ariaLabel: localize('themeEditor.previewScene', 'Preview scene'),
				onActivate: value => selectPreview(this.window, value),
			}),
		);
		toolbarContainer.append(scenesHost);
		let selected: string | undefined;
		let loading: ThemePreviewFrame | undefined;
		const loadSelected = (): void => {
			const frame = this.active;
			if (!frame || frame.started || loading || !geometry) return;
			// A cold document imports the shared product graph. Serializing startup
			// avoids exhausting the browser's resource requests during rapid switches.
			// Wait for the canvas dimensions so Parts do not seed their layout from
			// the iframe's default 300 × 150 viewport and retain a minimum-size panel.
			loading = frame;
			frame.started = true;
			frame.domNode.src = frame.url;
		};
		const selectPreview = (value: PreviewWindow, scene: PreviewScene): void => {
			const key = `${value}:${scene}`;
			if (selected === key) return;
			selected = key;
			this.window = value;
			this.scenes.set(value, scene);
			if (this.active) {
				this.active.domNode.classList.add('hidden');
				this.active.domNode.inert = true;
			}
			let frame = this.frames.get(key);
			if (!frame) {
				const token = crypto.randomUUID();
				const page = value === 'sessions' ? 'sessionsThemePreview' : 'themePreview';
				const url = new URL(`browser/theme-preview/${page}.html`, root);
				url.searchParams.set('locale', getNLSLanguage());
				url.searchParams.set('channel', token);
				url.searchParams.set('sample', scene);
				frame = this.frames.set(key, new ThemePreviewFrame(container.ownerDocument, token, url.href));
				resize(frame);
				viewport.append(frame.domNode);
			}
			this.active = frame;
			frame.domNode.classList.remove('hidden');
			frame.domNode.inert = false;
			loadSelected();
			this.sendTheme();
			tabs.setTabs(
				[
					{
						id: 'workbench',
						value: 'workbench',
						label: localize('themeEditor.ideWindow', 'IDE'),
						tabId: 'theme-preview-workbench',
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
			sceneTabs.setTabs(
				[
					{
						id: 'interface',
						value: 'interface',
						tabId: 'theme-scene-interface',
						label: localize('themeEditor.interfaceScene', 'Interface'),
					},
					{
						id: 'code',
						value: 'code',
						tabId: 'theme-scene-code',
						label: localize('themeEditor.codeScene', 'Code'),
					},
					{
						id: 'diff',
						value: 'diff',
						tabId: 'theme-scene-diff',
						label: localize('themeEditor.diffPreview', 'Diff'),
					},
					...(value === 'workbench' ? [{
						id: 'scm',
						value: 'scm' as const,
						tabId: 'theme-scene-scm',
						label: localize('themeEditor.scmScene', 'SCM History'),
					}] : []),
				],
				scene,
			);
			this.selectionChanged.fire();
		};
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
					geometry = { width, height, scale };
					for (const [, frame] of this.frames) resize(frame);
					loadSelected();
				});
			}),
		);
		const origin = new URL(root).origin;
		const localFile = new URL(root).protocol === 'file:';
		this._register(
			addDisposableListener(getWindow(container), 'message', (event: MessageEvent<unknown>) => {
				// Electron serializes file document senders as an opaque origin even
				// when URL.origin reports file://. The source and token still bind this frame.
				if (localFile ? event.origin !== 'null' && event.origin !== 'file://' : event.origin !== origin) return;
				const data = event.data;
				if (!data || typeof data !== 'object' || !('kind' in data)) return;
				if (data.kind !== 'ash-theme-preview-ready' || !('token' in data)) return;
				const frame = [...this.frames].find(
					([, frame]) => frame.domNode.contentWindow === event.source && frame.token === data.token,
				)?.[1];
				if (!frame || frame.port) return;
				const lifetime = new DisposableStore();
				frame.connection.value = lifetime;
				const channel = new MessageChannel();
				frame.port = channel.port1;
				lifetime.add(
					toDisposable(() => {
						channel.port1.close();
						frame.port = undefined;
					}),
				);
				lifetime.add(
					addDisposableListener(channel.port1, 'message', (message: MessageEvent<unknown>) => {
						const value = message.data;
						if (!value || typeof value !== 'object' || !('kind' in value)) return;
						if (
							value.kind === 'ash-theme-preview-content' &&
							'text' in value &&
							typeof value.text === 'string' &&
							value.text.length <= 1_048_576
						) {
							frame.content = value.text;
						} else if (
							value.kind === 'ash-theme-preview-colors' &&
							'colors' in value &&
							Array.isArray(value.colors) &&
							value.colors.length <= 5000
						) {
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
								if (
									entry.value !== null &&
									(typeof entry.value !== 'string' ||
										!/^#[\da-f]{6}(?:[\da-f]{2})?$/iu.test(entry.value))
								)
									return;
								const references = entry.references;
								if (
									references !== undefined &&
									(!references ||
										typeof references !== 'object' ||
										!['linked', 'derived'].includes(references.kind) ||
										!Array.isArray(references.tokens) ||
										references.tokens.length < 1 ||
										references.tokens.length > 100 ||
										references.tokens.some(
											(id: unknown) =>
												typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9.]*$/u.test(id),
										))
								)
									return;
								colors.push({
									id: entry.id,
									description: entry.description,
									value: entry.value ? Color.fromHex(entry.value) : undefined,
									references,
								});
							}
							const merged = new Map(value.replace ? [] : frame.colors.map(entry => [entry.id, entry]));
							for (const entry of colors) merged.set(entry.id, entry);
							frame.colors = [...merged.values()];
							if (frame === this.active) this.colorsChanged.fire();
						} else if (
							value.kind === 'ash-theme-preview-accessibility' &&
							'help' in value &&
							typeof value.help === 'boolean'
						) {
							if (frame === this.active) onAccessibleView(value.help);
						}
					}),
				);
				channel.port1.start();
				// A capability port handles the auxiliary host's different JavaScript realm.
				frame.domNode.contentWindow?.postMessage(
					{ kind: 'ash-theme-preview-connect', token: frame.token },
					localFile || origin === 'null' ? '*' : origin,
					[channel.port2],
				);
				this.sendTheme();
				if (loading === frame) {
					loading = undefined;
					loadSelected();
				}
			}),
		);
		this._register(
			toDisposable(() => {
				this.active = undefined;
				viewport.remove();
			}),
		);
		selectPreview('workbench', 'interface');
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
		return this.active?.content ?? '';
	}

	private scheduleUpdate(): void {
		if (!this.pendingUpdate.value) {
			this.pendingUpdate.value = scheduleAtNextAnimationFrame(this.ownerWindow, () => {
				this.pendingUpdate.clear();
				this.sendTheme();
			});
		}
	}

	private sendTheme(): void {
		if (!this.source) return;
		const configuration = Object.fromEntries(
			themePreviewConfigurationKeys
				.map(key => [key, this.configuration.getValue(key)])
				.filter(([, value]) => value !== undefined),
		);
		const serialized = JSON.stringify(configuration);
		// Keep every visited preview current. Hidden documents may defer their
		// animation frame; the host merges updates and applies the newest on reveal.
		for (const [, frame] of this.frames) {
			if (!frame.port) continue;
			const themeChanged = this.source !== frame.sentSource;
			const configurationChanged = serialized !== frame.sentConfiguration;
			if (!themeChanged && !configurationChanged) continue;
			frame.port.postMessage({
				kind: 'ash-theme-preview-theme',
				...(themeChanged ? { source: this.source } : {}),
				...(configurationChanged ? { configuration } : {}),
			});
			frame.sentSource = this.source;
			frame.sentConfiguration = serialized;
		}
	}
}
