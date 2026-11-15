import { languagePackCatalog as chineseCatalog } from '../../../../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import '../../../../base/browser/ui/styles.css';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Event } from '../../../../base/common/event.js';
import { localize, setNlsMessages } from '../../../../nls.js';
import { MenuService } from '../../../../platform/actions/common/menuService.js';
import { IMenuService, MenusRegistry } from '../../../../platform/actions/common/actions.js';
import { ContextKeyService, IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService, IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { BrowserContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { BrowserContextViewService } from '../../../../platform/contextview/browser/contextViewService.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { darkColorTheme, lightColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { CommandService } from '../../../../workbench/services/commands/common/commandService.js';
import { TestNotificationService } from '../../../../workbench/services/notification/test/common/testNotificationService.js';
import { bindTestColorTheme } from '../../../../../../test/fixtures/browser/themeFixture.js';
import { ArtifactToolbar } from '../../../contrib/artifact/browser/widget/artifactToolbar.js';
import { ArtifactContextMenu } from '../../../contrib/artifact/browser/widget/artifactContextMenu.js';
import { ArtifactKindContext } from '../../../common/contextkeys.js';
import { Menus } from '../../../browser/menus.js';
import { ArtifactEditorActions } from '../../../contrib/artifact/browser/artifactEditorActions.js';
import { ArtifactCanvasMode, ArtifactCanvasTool } from '../../../contrib/artifact/common/config/artifactCanvasEditorConfiguration.js';

declare global {
	interface Window {
		ashArtifactEditorToolbarFixture: {
			setBusy(busy: boolean): void;
			setCodeMode(enabled: boolean): void;
			setKind(kind: 'design' | 'docs'): void;
			hideMenu(): void;
			dispose(): void;
		};
	}
}

const query = new URLSearchParams(location.search);
if (query.get('locale') === 'zh-CN') {
	setNlsMessages('zh-CN', chineseCatalog.bundles);
}
const resources = new DisposableStore();
const themes = { light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme };
const theme = resources.add(new TestThemeService(themes[query.get('theme') as keyof typeof themes] ?? lightColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
const services = resources.add(new InstantiationService());
services.registerInstance(IContextKeyService, resources.add(new ContextKeyService()));
services.registerInstance(ICommandService, resources.add(new CommandService(services)));
services.registerInstance(IMenuService, services.createInstance(MenuService));
services.registerInstance(IContextViewService, resources.add(new BrowserContextViewService(document.body)));
services.registerInstance(INotificationService, resources.add(new TestNotificationService()));
services.registerInstance(IKeybindingService, {
	inChordMode: false, onDidUpdateKeybindings: Event.None,
	getKeybindings: () => [], enableKeybindingHoldMode: () => undefined, registerSchemaContribution: () => Disposable.None,
	resolveKeybinding() { throw new Error('No keybinding in this fixture'); },
	resolveUserBinding: () => undefined, lookupKeybindings: () => [], lookupKeybinding: () => undefined,
});
services.registerInstance(IContextMenuService, resources.add(services.createInstance(BrowserContextMenuService)));
let tool = ArtifactCanvasTool.Select;
let mode = ArtifactCanvasMode.Design;
let busy = false;
const update = (): void => {
	const actions = editorActions.update(tool, mode, busy);
	if (actions) { tools.setActions(actions.tools); modes.setActions(actions.modes); }
	document.querySelector('output')!.textContent = `${tool}/${mode}`;
};
const editorActions = new ArtifactEditorActions(
	(selected: ArtifactCanvasTool) => { tool = selected; update(); },
	(selected: ArtifactCanvasMode) => { mode = selected; update(); },
	() => { },
);
const widget = resources.add(services.createInstance(ArtifactToolbar, document, query.has('document') ? {} : { appearance: 'canvas' }));
const kind = ArtifactKindContext.bindTo(services.get(IContextKeyService));
kind.set('design');
const origin = { name: 'originating-artifact' };
widget.setWorkspaceContext(origin);
const contextMenu = resources.add(services.createInstance(ArtifactContextMenu, {
	getActions: () => [],
	getActionsContext: () => origin,
}));
if (query.has('contributions')) {
	const command = { id: 'fixture.artifact.inspect', title: 'Inspect artifact' };
	resources.add(CommandsRegistry.register(command.id, (_accessor, ...targets: unknown[]) => {
		if (targets.length !== 1 || targets[0] !== origin) throw new Error('Action received another artifact');
		document.querySelector('output')!.textContent = origin.name;
	}));
	resources.add(MenusRegistry.appendMenuItems([Menus.ArtifactToolbar, Menus.ArtifactContext].map(id => ({
		id, item: { command, group: 'navigation', when: ArtifactKindContext.isEqualTo('design') },
	}))));
	const surface = document.createElement('div');
	surface.textContent = 'Artifact surface';
	surface.tabIndex = 0;
	document.querySelector('main')!.append(surface);
	resources.add(addDisposableListener(surface, 'contextmenu', event => {
		event.preventDefault();
		contextMenu.show({ x: event.clientX, y: event.clientY, targetWindow: window }, () => surface.focus());
	}));
	resources.add(addDisposableListener(surface, 'keydown', event => {
		if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
			event.preventDefault();
			contextMenu.show(surface, () => surface.focus());
		}
	}));
}
const tools = widget.createActionGroup(localize('sessions.artifacts.canvasTools', 'Canvas tools'));
const modes = widget.createActionGroup(localize('sessions.artifacts.canvasEditorModes', 'Editor modes'));
document.querySelector('main')!.append(widget.domNode);
update();
window.ashArtifactEditorToolbarFixture = {
	setBusy(value) { busy = value; update(); },
	setCodeMode(value) { mode = value ? ArtifactCanvasMode.Code : ArtifactCanvasMode.Design; update(); },
	setKind(value) { kind.set(value); },
	hideMenu() { contextMenu.hide(); },
	dispose() { resources.dispose(); },
};
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
document.body.dataset.ready = 'true';
