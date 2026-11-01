import { Event, Emitter } from '../../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../../base/common/uri.js';
import { IAccessibleViewService } from '../../../../../../platform/accessibility/browser/accessibleView.js';
import { BrowserClipboardService } from '../../../../../../platform/clipboard/browser/clipboardService.js';
import { IClipboardService } from '../../../../../../platform/clipboard/common/clipboardService.js';
import { IConfigurationService } from '../../../../../../platform/configuration/common/configuration.js';
import { InMemoryConfigurationService } from '../../../../../../platform/configuration/common/inMemoryConfigurationService.js';
import { ContextKeyService, IContextKeyService } from '../../../../../../platform/contextkey/browser/contextKeyService.js';
import { IContextMenuService } from '../../../../../../platform/contextview/browser/contextView.js';
import { InstantiationService } from '../../../../../../platform/instantiation/common/instantiationService.js';
import { IQuickInputService } from '../../../../../../platform/quickinput/common/quickInput.js';
import { TestQuickInputService } from '../../../../../../platform/quickinput/test/browser/testQuickInputService.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../../../platform/theme/common/colorTheme.js';
import { IThemeService } from '../../../../../../platform/theme/common/themeService.js';
import { TestThemeService } from '../../../../../../platform/theme/test/common/testThemeService.js';
import { EditorPanes } from '../../../../../browser/editor.js';
import { type EditorPane } from '../../../../../browser/parts/editor/editorPane.js';
import { binaryDiffEditorDescriptor } from '../../../../../browser/parts/editor/binaryDiffEditor.js';
import { StatusbarService } from '../../../../../browser/parts/statusbar/statusbarPart.js';
import type { IResourceEditorInput } from '../../../../../common/editor.js';
import { createBinaryDiffEditorInput } from '../../../../../common/editor/diffEditorInput.js';
import { IEditorService } from '../../../../../services/editor/common/editorService.js';
import { IStatusbarService, StatusbarAlignment } from '../../../../../services/statusbar/browser/statusbar.js';
import { registerTestComponentServices } from '../../../../../test/common/testEditorServices.js';
import { bindTestColorTheme } from '../../../../../../../../test/fixtures/browser/themeFixture.js';
import { ImagePreviewEditor } from '../../../browser/imagePreviewEditor.js';
import { MediaPreviewStatusBarContribution } from '../../../browser/mediaPreviewStatusBar.js';
import { ImagePreviewConfiguration } from '../../../common/mediaPreview.js';
import '../../../browser/mediaPreview.contribution.js';

const resources = new DisposableStore();
const services = resources.add(new InstantiationService());
const configuration = resources.add(new InMemoryConfigurationService());
services.registerInstance(IConfigurationService, configuration);
const themes = resources.add(new TestThemeService(darkColorTheme));
services.registerInstance(IThemeService, themes);
registerTestComponentServices(services, document);
resources.add(bindTestColorTheme(themes, document.body));
services.registerInstance(IClipboardService, resources.add(new BrowserClipboardService(navigator.clipboard)));
services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
services.registerInstance(IAccessibleViewService, {
	show: () => false, getOpenAriaHint: () => undefined, disableHint: async () => { }, showAccessibleViewHelp: () => { },
	dispose: () => { }, [Symbol.dispose]: () => { },
});
services.registerInstance(IContextMenuService, {
	contextMenuStyle: 'custom', onDidShowContextMenu: Event.None, onDidHideContextMenu: Event.None,
	showContextMenu: delegate => { document.querySelector('#menu')!.textContent = delegate.getActions?.().map(action => action.label).join(', ') ?? ''; },
	hideContextMenu: () => { },
});
services.registerInstance(IQuickInputService, resources.add(new TestQuickInputService({ container: document.body })));
const statusbar = resources.add(new StatusbarService());
services.registerInstance(IStatusbarService, statusbar);
resources.add(statusbar.onDidChangeEntries(() => {
	document.querySelector('#status')!.textContent = statusbar.getEntries(StatusbarAlignment.Right).map(item => item.entry.text).join(' ');
}));
let current: EditorPane | undefined;
let activeInput: IResourceEditorInput | undefined;
const active = resources.add(new Emitter<void>());
services.registerInstance(IEditorService, {
	onDidActiveEditorChange: active.event, onDidVisibleEditorsChange: active.event,
	get activeEditor() { return activeInput; }, get activeEditorPane() { return current; },
	get visibleEditors() { return activeInput ? [activeInput] : []; }, get visibleEditorPanes() { return current ? [current] : []; },
	openEditor: async input => open(input), focusActiveEditor: () => current?.focus(),
	save: async () => ({ success: true, editors: [] }), saveAll: async () => ({ success: true, editors: [] }),
});
resources.add(services.createInstance(MediaPreviewStatusBarContribution));
resources.add(EditorPanes.registerEditorPane(binaryDiffEditorDescriptor()));
const container = document.querySelector<HTMLElement>('#editor')!;

async function open(input: IResourceEditorInput): Promise<void> {
	current?.clearInput();
	current?.dispose();
	const descriptor = EditorPanes.getEditorPane(input)!;
	current = await descriptor.create({ instantiationService: services, input });
	activeInput = input;
	current.create(container);
	current.setVisible(true);
	active.fire();
	await current.setInput(input, new AbortController().signal);
	current.layout({ width: container.clientWidth, height: container.clientHeight });
}

async function source(format: string, width = 800, height = 600): Promise<IResourceEditorInput> {
	let bytes: Uint8Array;
	if (format === 'svg') {
		bytes = new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="red"/></svg>`);
	} else if (format === 'gif') {
		bytes = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), char => char.charCodeAt(0));
	} else {
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const context = canvas.getContext('2d')!;
		context.fillStyle = 'red';
		context.fillRect(0, 0, width, height);
		const mime = format === 'jpg' ? 'image/jpeg' : `image/${format}`;
		const blob = await new Promise<Blob>(resolve => canvas.toBlob(value => resolve(value!), mime));
		bytes = new Uint8Array(await blob.arrayBuffer());
	}
	return { resource: URI.file(`/images/product.${format}`), initialBytes: bytes, readOnly: true };
}

window.imagePreviewFixture = {
	configure: (key: keyof typeof ImagePreviewConfiguration, value: unknown) => configuration.updateValue(ImagePreviewConfiguration[key], value),
	open: async (format: string, width?: number, height?: number) => open(await source(format, width, height)),
	openDiff: async () => {
		const original = await source('png');
		const modified = { ...await source('png', 320, 240), resource: URI.file('/images/modified.png') };
		await open(createBinaryDiffEditorInput(original, modified));
	},
	state: () => current instanceof ImagePreviewEditor ? current.imageViewer.getViewState() : undefined,
	theme: (name: string) => themes.setColorTheme(({ dark: darkColorTheme, light: lightColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme })[name] ?? darkColorTheme),
	close: () => { current?.clearInput(); current?.dispose(); current = undefined; activeInput = undefined; active.fire(); },
};
document.body.dataset.ready = 'true';
window.addEventListener('pagehide', () => { current?.dispose(); resources.dispose(); }, { once: true });

declare global {
	interface Window {
		imagePreviewFixture: {
			configure(key: keyof typeof ImagePreviewConfiguration, value: unknown): Promise<void>;
			open(format: string, width?: number, height?: number): Promise<void>;
			openDiff(): Promise<void>;
			state(): { scale: number | 'fit'; scrollLeft: number; scrollTop: number } | undefined;
			theme(name: string): void;
			close(): void;
		};
	}
}
