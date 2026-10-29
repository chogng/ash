import { Schemas } from '../../../../base/common/network.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { h } from '../../../../base/browser/dom.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { BrowserContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { LogService } from '../../../../platform/log/common/logServiceImpl.js';
import { ConsoleLogSink } from '../../../../platform/log/common/consoleLogSink.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { startWorkbench } from '../../../browser/workbench.js';
import { BrowserTitleService, createBrowserTitlebarPart } from '../../../browser/parts/titlebar/titlebarPart.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { createDiffEditorInput } from '../../../common/editor/diffEditorInput.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { InMemoryWorkingCopyBackupService } from '../../../services/workingCopy/common/workingCopyBackupService.js';
import { BrowserURLService } from '../../../services/url/browser/urlService.js';
import { TERMINAL_VIEW_ID } from '../../terminal/common/terminal.js';
import { ViewPane, type IViewPaneOptions } from '../../../browser/parts/views/viewPane.js';
import { createThemePreviewHost, connectThemePreview } from './themePreviewHost.js';
import { IChatSessionNavigationService } from '../../../services/chat/common/chatSessionNavigationService.js';

const host = await createThemePreviewHost();
const { resources, root, workspaceFiles, workspaceRoot, samples, storage, api, clipboard, serviceCollection } = host;
const diffPreview = new URLSearchParams(location.search).get('sample') === 'diff';
// Code preview owns no conversations or media. Shared Chat contributions can
// observe that empty scope without borrowing the enclosing product's history.
const chatUnavailable = () => new Error(localize('themeEditor.previewChatUnavailable', 'Chat is unavailable in this preview.'));
serviceCollection.set(IChatSessionNavigationService, {
	revision: 0,
	getConversations: () => [], getActiveConversation: () => undefined,
	captureActiveDraft: async () => undefined,
	appendToActiveDraft: () => { throw chatUnavailable(); },
	openConversation: async () => { throw chatUnavailable(); },
	startVoiceConversation: async () => { throw chatUnavailable(); },
});
// Registration stays behind localization and within this isolated document.
await import('./themePreview.contribution.js');

// Keep the real panel's layout and theme, without constructing terminal services,
// profile discovery, a PTY, xterm, or a command interpreter for a color sample.
class TerminalPreviewPane extends ViewPane {
	constructor(container: HTMLElement, options: IViewPaneOptions) {
		super(container, options);
		this.setHeaderVisible(false);
		const doc = container.ownerDocument;
		this.contentElement.classList.add('ash-theme-preview-terminal');
		const sample = h(doc, 'div', { attributes: { role: 'region', 'aria-label': localize('themeEditor.previewOnly', 'Preview only'), tabindex: '0' } });
		sample.append(h(doc, 'p', {}, localize('themeEditor.previewTerminalIntro', 'Terminal color preview. Commands are not executed.')));
		for (const bright of [false, true]) {
			const line = h(doc, 'p');
			for (const [index, name] of ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'].entries()) {
				const id = `terminal.ansi${bright ? 'Bright' : ''}${name}`;
				const swatch = h(doc, 'span', { attributes: { 'data-color': id, 'aria-label': id, title: id } }, `${(bright ? 90 : 30) + index} Aa `);
				swatch.style.color = `var(--ash-${id.replaceAll('.', '-')})`;
				line.append(swatch);
			}
			sample.append(line);
		}
		const prompt = h(doc, 'p', {}, '$ ');
		prompt.append(h(doc, 'span', { className: 'ash-theme-preview-terminal-selection' }, localize('themeEditor.previewOnly', 'Preview only')), ' ', h(doc, 'span', { className: 'ash-theme-preview-terminal-cursor', attributes: { 'aria-hidden': 'true' } }, '▌'));
		sample.append(prompt);
		this.contentElement.append(sample);
	}
}

let services!: IInstantiationService;
serviceCollection.set(IFileDialogService, host.fileDialogDescriptor(() => services));
const workbench = resources.add(
	await startWorkbench({
		productName: 'Ash',
		container: root,
		api,
		serviceCollection,
		viewConstructors: new Map([[TERMINAL_VIEW_ID, new SyncDescriptor(TerminalPreviewPane)]]),
		extensionHost: api.extensionHost,
		workspace: { id: 'theme-preview', folders: [{ id: 'theme-preview', name: 'theme-preview', uri: workspaceRoot, index: 0 }] },
		workspaceFileSystemProvider: workspaceFiles,
		defaultLayout: { parts: { sidebar: !diffPreview, panel: !diffPreview, auxiliarybar: false, agentSidebar: false } },
		// Keep the production Parts and editor rendering without starting
		// backend observers, history, account, update or extension contributions.
		contributionIds: [
			'workbench.contrib.layoutActionsContext',
			'workbench.contrib.modernUI',
			'workbench.contrib.sash',
			'workbench.contrib.dynamicEditorConfigurations',
			'workbench.contrib.editorStatus',
			'workbench.contrib.folding',
			'editorAccessibilityHelpContribution',
			'workbench.contrib.accessibilityStatus',
			'workbench.contrib.unfocusedViewDimming',
		],
		initialConfiguration: {
			contents: { workbench: { startupEditor: 'none' } },
			keys: ['workbench.startupEditor'],
			overrides: [],
		},
		// Webviews are not part of the sample. The disconnected host supplies no remote resources.
		environmentService: { webviewExternalEndpoint: 'https://{{uuid}}.invalid', argvResource: URI.from({ scheme: Schemas.vscodeUserData, path: '/user/argv.json' }) },
		clipboardService: clipboard,
		createStorageService: async () => storage,
		createUserDataFileSystemProvider: async () => new InMemoryFileSystemProvider(),
		createWorkingCopyBackupService: (_services, workspaceId) => new InMemoryWorkingCopyBackupService(workspaceId),
		createLogService: () => new LogService({ sinks: [new ConsoleLogSink()] }),
		createLifecycleService: host.createLifecycleService,
		createContextMenuService: scope => scope.createInstance(BrowserContextMenuService),
		createTitleService: (container, productName, groups, scope) => scope.createInstance(BrowserTitleService, container, productName, createBrowserTitlebarPart, groups),
		createURLService: scope => {
			host.restrictOpeners(scope);
			return scope.createInstance(BrowserURLService, undefined);
		},
		createWindow: scope => { services = scope; return Disposable.None; },
	}),
);
await workbench.whenRestored;
const editorService = services.get(IEditorService);
if (diffPreview) {
	// Use the production comparison over memory files so every diff token is
	// rendered by its real owner, including line and word-level decorations.
	const original = URI.joinPath(workspaceRoot, 'palette.before.ts');
	const modified = URI.joinPath(workspaceRoot, 'palette.after.ts');
	const before = `export const palette = {
  name: "Ocean",
  accent: "#0078d4",
  opacity: 0.85,
};

export function formatColor(value: string): string {
  return value.toUpperCase();
}

export function legacyColor(): string {
  return "gray";
}

export const spacing = [4, 8, 12, 16];
`;
	const after = `export const palette = {
  name: "Forest",
  accent: "#107c10",
  opacity: 0.95,
};

export function formatColor(value: string): string {
  return value.toLowerCase();
}

export const spacing = [4, 8, 12, 16];

export function withOpacity(color: string): string {
  return color + "cc";
}
`;
	for (const [resource, text] of [[original, before], [modified, after]] as const) {
		await workspaceFiles.writeFile(resource, new TextEncoder().encode(text), { create: true, overwrite: false });
	}
	await editorService.openEditor(createDiffEditorInput({ resource: original }, { resource: modified }, localize('themeEditor.diffSample', 'Color changes')), { pinned: true, preserveFocus: true });
} else {
	for (const sample of [...samples].reverse()) {
		await editorService.openEditor({ resource: URI.joinPath(workspaceRoot, sample.name) }, { pinned: true, preserveFocus: true });
	}
}

const publishContent = connectThemePreview(resources, services.get(IWorkbenchThemeService), services.get(IConfigurationService), () => {
	const editors = services.get(ICodeEditorService).listCodeEditors();
	const output = root.querySelector('.ash-theme-preview-terminal')?.textContent ?? '';
	return editors.map(editor => `${editor.getModel()?.uri.path ?? ''}\n${editor.getModel()?.getValue() ?? ''}`).join('\n') + '\n' + output;
});
resources.add(editorService.onDidActiveEditorChange(publishContent));
const editorListeners = resources.add(new DisposableStore());
const bindEditors = (): void => {
	editorListeners.clear();
	for (const editor of services.get(ICodeEditorService).listCodeEditors()) editorListeners.add(editor.onDidChangeModelContent(publishContent));
};
resources.add(editorService.onDidVisibleEditorsChange(bindEditors));
bindEditors();
