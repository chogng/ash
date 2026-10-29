import './media/themePreview.css';
import { addDisposableListener, scheduleAtNextAnimationFrame, stopEvent } from '../../../../base/browser/dom.js';
import { installBaseUiStyles } from '../../../../base/browser/ui/styles.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { Color } from '../../../../base/common/color.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, setNlsMessages } from '../../../../nls.js';
import { createDisconnectedRendererApi } from '../../../browser/rendererApi.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IFileService, FileKind } from '../../../../platform/files/common/files.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { FileDialogService } from '../../../services/dialogs/browser/fileDialogService.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IClipboardService, type IClipboardResources } from '../../../../platform/clipboard/common/clipboardService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { BrowserLifecycleService } from '../../../services/lifecycle/browser/lifecycleService.js';
import { BrowserStorageService } from '../../../services/storage/browser/storageService.js';
import type { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { productLanguagePackCatalogs } from '../../../services/localization/common/localizationCatalogs.js';
import { parseUserColorTheme } from '../../../services/themes/common/colorThemeData.js';
import { getThemeColorReferences, themePreviewConfigurationKeys } from './themePreview.js';
import { Colors } from '../../../../platform/theme/common/colorRegistry.js';

/** Both product previews borrow the same memory-only host; no platform bridge is installed. */
export async function createThemePreviewHost() {
	const locale = new URLSearchParams(location.search).get('locale') ?? 'en';
	const catalog = productLanguagePackCatalogs.find(item => item.locale === locale);
	if (catalog) setNlsMessages(locale, catalog.bundles);
	document.documentElement.lang = locale;
	document.title = localize('themeEditor.interactivePreview', 'Interactive theme preview');
	installBaseUiStyles();
	const resources = new DisposableStore();
	const pageLifetime = resources.add(new MutableDisposable());
	pageLifetime.value = addDisposableListener(window, 'pagehide', () => resources.dispose(), { once: true });
	const createLifecycleService = (services: IInstantiationService): BrowserLifecycleService => {
		const lifecycle = services.createInstance(BrowserLifecycleService, { ownerWindow: window, onError: console.error });
		// Flush layout and draft state while Parts are alive, then release the
		// document. A direct pagehide disposal races the host's shutdown joiners.
		pageLifetime.value = lifecycle.onDidShutdown(() => queueMicrotask(() => resources.dispose()));
		return lifecycle;
	};
	const root = document.getElementById('app')!;
	const workspaceFiles = resources.add(new InMemoryFileSystemProvider());
	const workspaceRoot = URI.file('/theme-preview');
	const samples = [
		{
			name: 'palette.ts', text: `// A small workspace for exploring interface and syntax colors.
// Changes here stay in the theme preview.

export interface Palette {
  readonly name: string;
  readonly accent: string;
  readonly surface: string;
  readonly foreground: string;
  readonly opacity: number;
}

const palette: Palette = {
  name: "Ocean",
  accent: "#0078d4",
  surface: "#152334",
  foreground: "#d8e4ef",
  opacity: 0.85,
};

export interface ThemeToken {
  readonly id: string;
  readonly value: string;
  readonly inherited: boolean;
}

// Named colors keep each part of the interface consistent.
const colors = ["#0078d4", "#328e99", "#107c10"];
const spacing = [4, 8, 12, 16, 24, 32];

export function formatColor(value: Palette): string {
  return value.accent;
}

export function createTokens(value: Palette): ThemeToken[] {
  return [
    { id: "editor.background", value: value.surface, inherited: false },
    { id: "editor.foreground", value: value.foreground, inherited: false },
    { id: "focusBorder", value: value.accent, inherited: true },
  ];
}

export function describeTheme(value: Palette): string {
  const tokens = createTokens(value);
  return tokens.map(token => token.id + ": " + token.value).join("\\n");
}

for (const color of colors) {
  console.log(color);
}

console.log(describeTheme(palette));
` },
		{ name: 'settings.json', text: '{\n  "editor.fontSize": 14,\n  "editor.lineNumbers": "on",\n  "editor.minimap.enabled": true,\n  "workbench.colorTheme": "Ash"\n}\n' },
	];
	await workspaceFiles.createDirectory(workspaceRoot);
	for (const sample of samples) {
		await workspaceFiles.writeFile(URI.joinPath(workspaceRoot, sample.name), new TextEncoder().encode(sample.text), { create: true, overwrite: false });
	}
	await workspaceFiles.createDirectory(URI.joinPath(workspaceRoot, 'src'));
	await workspaceFiles.writeFile(URI.joinPath(workspaceRoot, 'src', 'index.ts'), new TextEncoder().encode('import { createTokens } from "../palette";\n\nconsole.log(createTokens);\n'), { create: true, overwrite: false });

	const state = new Map<string, string>();
	const storage = resources.add(new BrowserStorageService({
		ownerWindow: window, workspaceId: 'theme-preview', flushInterval: 0,
		backend: {
			get length() { return state.size; },
			key: index => [...state.keys()][index] ?? null,
			getItem: key => state.get(key) ?? null,
			setItem: (key, value) => { state.set(key, value); },
			removeItem: key => { state.delete(key); },
			clear: () => state.clear(),
		},
	}));
	const disconnected = createDisconnectedRendererApi();
	const api = {
		...disconnected,
		// The fixed preview has no accounts or account-managed settings.
		github: { ...disconnected.github, listAccounts: async () => [] },
	};
	let clipboardText = '';
	let findText = '';
	let clipboardResources: IClipboardResources = { resources: [], operation: 'copy' };
	const clipboard: IClipboardService = {
		triggerPaste: () => undefined,
		read: async () => [{ type: 'text/plain', data: new TextEncoder().encode(clipboardText) }],
		readText: async () => clipboardText,
		readImage: async () => new Uint8Array(),
		writeText: async value => { clipboardText = value; },
		readFindText: async () => findText,
		writeFindText: async value => { findText = value; },
		readResources: async () => clipboardResources,
		writeResources: async (resources, operation) => { clipboardResources = { resources: [...resources], operation }; },
		hasResources: async () => clipboardResources.resources.length > 0,
	};
	const serviceCollection = new ServiceCollection([IClipboardService, clipboard], [IHostService, {
		hasFocus: true, onDidChangeFocus: Event.None,
		openWindow: async () => { }, restart: async () => { }, reload: async () => { }, getScreenshot: async () => undefined,
	} satisfies IHostService]);
	const fileDialogDescriptor = (services: () => IInstantiationService): SyncDescriptor<FileDialogService> => new SyncDescriptor(FileDialogService, [{
		kind: 'server',
		client: {
			list: async (path: string) => {
				const uri = URI.file(path);
				const children = await workspaceFiles.readDirectory(uri);
				return { path, parent: path === '/' ? null : URI.joinPath(uri, '..').path, directories: children.filter(entry => entry.kind === FileKind.Directory).map(entry => ({ name: entry.name, path: entry.resource.path })) };
			},
			authorize: async () => () => { },
		},
		quickInput: () => services().get(IQuickInputService),
		fileService: () => services().get(IFileService),
		workspaceRoot: () => workspaceRoot,
	}, () => services().get(IDialogService)]);
	const restrictOpeners = (services: IInstantiationService): void => {
		const opener = services.get(IOpenerService);
		opener.setDefaultExternalOpener({ openExternal: async () => false });
		resources.add(opener.registerValidator({
			shouldOpen: async target => {
				const uri = typeof target === 'string' ? URI.parse(target) : target;
				return uri.scheme === 'file' || uri.scheme === 'untitled';
			},
		}));
	};
	return { resources, root, workspaceFiles, workspaceRoot, samples, storage, api, clipboard, serviceCollection, fileDialogDescriptor, restrictOpeners, createLifecycleService };
}

/** The owning preview document applies themes and exposes only presentation data to its editor. */
export function connectThemePreview(
	resources: DisposableStore,
	themeService: IWorkbenchThemeService,
	configuration: IConfigurationService,
	readContent: () => string,
	configurationKeys: readonly string[] = themePreviewConfigurationKeys,
): () => void {
	const theme = resources.add(new MutableDisposable<ReturnType<IWorkbenchThemeService['previewColorTheme']>>());
	const registeredKeys = new Set(configuration.keys().default);
	let port: MessagePort | undefined;
	const channelToken = new URLSearchParams(location.search).get('channel');
	const localFile = location.protocol === 'file:';
	const contentFrame = resources.add(new MutableDisposable<ReturnType<typeof scheduleAtNextAnimationFrame>>());
	let lastContent: string | undefined;
	const sendContent = (): void => {
		if (!port || resources.isDisposed) return;
		const text = readContent();
		if (text === lastContent) return;
		lastContent = text;
		port.postMessage({ kind: 'ash-theme-preview-content', text });
	};
	const publishContent = (): void => {
		if (!contentFrame.value && !resources.isDisposed) {
			contentFrame.value = scheduleAtNextAnimationFrame(window, () => {
				contentFrame.clear();
				sendContent();
			});
		}
	};
	let lastSource: string | undefined;
	let lastTheme: ReturnType<IWorkbenchThemeService['getColorTheme']> | undefined;
	const reportedColors = new Map<string, string>();
	async function updateTheme(data: { source?: string; configuration?: Record<string, unknown>; }): Promise<void> {
		if (data.configuration) {
			for (const key of configurationKeys) {
				if (registeredKeys.has(key) && Object.hasOwn(data.configuration, key)) {
					if (resources.isDisposed) return;
					const value = data.configuration[key];
					if (JSON.stringify(configuration.getValue(key)) !== JSON.stringify(value)) await configuration.updateValue(key, value);
				}
			}
			publishContent();
		}
		if (resources.isDisposed) return;
		if (data.source !== undefined && data.source !== lastSource) {
			const parsed = parseUserColorTheme(data.source, 'theme-preview');
			if (theme.value) theme.value.update(parsed);
			else theme.value = themeService.previewColorTheme(parsed);
			lastSource = data.source;
		}
		document.body.dataset.ready = 'true';
		const activeTheme = themeService.getColorTheme();
		if (activeTheme === lastTheme) return;
		// Presentation changes do not recolor the workbench. A color edit only
		// returns tokens whose effective value or dependency actually changed.
		const replace = lastTheme === undefined;
		lastTheme = activeTheme;
		const colors = Colors.getColors().flatMap(entry => {
			const value = activeTheme.getColor(entry.id);
			const color = {
				id: entry.id, description: entry.description,
				value: value ? Color.Format.CSS.formatHexA(value, true) : null,
				references: getThemeColorReferences(activeTheme, entry),
			};
			const serialized = JSON.stringify(color);
			if (reportedColors.get(entry.id) === serialized) return [];
			reportedColors.set(entry.id, serialized);
			return [color];
		});
		if (replace || colors.length) port?.postMessage({ kind: 'ash-theme-preview-colors', replace, colors });
	}
	const updateFrame = resources.add(new MutableDisposable<ReturnType<typeof scheduleAtNextAnimationFrame>>());
	let pending: { source?: string; configuration?: Record<string, unknown>; } | undefined;
	let updating = false;
	const scheduleUpdate = (): void => {
		if (updating || updateFrame.value || resources.isDisposed) return;
		updateFrame.value = scheduleAtNextAnimationFrame(window, () => {
			updateFrame.clear();
			const data = pending;
			pending = undefined;
			if (!data) return;
			updating = true;
			void updateTheme(data).catch(error => console.error('Theme preview rejected invalid data', error)).finally(() => {
				updating = false;
				if (pending) scheduleUpdate();
			});
		});
	};
	resources.add(addDisposableListener(window, 'message', (event: MessageEvent<unknown>) => {
		const data = event.data;
		// Auxiliary editors borrow the main window's realm and clear window.opener.
		// The one-use channel token and origin bind the port to the creating editor;
		// event.source is not the iframe's parent in that host.
		const matchingOrigin = localFile ? event.origin === 'null' || event.origin === 'file://' : event.origin === location.origin;
		if (port || !channelToken || !matchingOrigin || !data || typeof data !== 'object' || !('kind' in data) || data.kind !== 'ash-theme-preview-connect' || !('token' in data) || data.token !== channelToken || event.ports.length !== 1) return;
		const connection = port = event.ports[0]!;
		resources.add(toDisposable(() => connection.close()));
		resources.add(addDisposableListener(connection, 'message', (message: MessageEvent<unknown>) => {
			const data = message.data;
			if (!data || typeof data !== 'object' || !('kind' in data) || data.kind !== 'ash-theme-preview-theme') return;
			if ('source' in data && (typeof data.source !== 'string' || data.source.length > 1_048_576)) return;
			if ('configuration' in data && (!data.configuration || typeof data.configuration !== 'object' || Array.isArray(data.configuration))) return;
			// Keep the newest pending state while an async configuration write is
			// running. Replaying every intermediate picker value creates a backlog.
			pending = {
				...pending,
				...('source' in data ? { source: data.source as string } : {}),
				...('configuration' in data ? { configuration: data.configuration as Record<string, unknown> } : {}),
			};
			scheduleUpdate();
		}));
		connection.start();
		publishContent();
	}));
	resources.add(addDisposableListener(window, 'keydown', event => {
		if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'F1' || event.key === 'F2')) {
			stopEvent(event);
			sendContent();
			port?.postMessage({ kind: 'ash-theme-preview-accessibility', help: event.key === 'F1' });
		}
	}, { capture: true }));
	window.parent.postMessage({ kind: 'ash-theme-preview-ready', token: channelToken }, localFile || location.origin === 'null' ? '*' : location.origin);
	return publishContent;
}
