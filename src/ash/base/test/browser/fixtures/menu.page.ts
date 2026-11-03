import { Action, ActionRunner, SubmenuAction, type IAction } from '../../../common/actions.js';
import { DisposableStore, MutableDisposable } from '../../../common/lifecycle.js';
import { Menu, HorizontalDirection, VerticalDirection } from '../../../browser/ui/menu/menu.js';
import { MenuBar } from '../../../browser/ui/menu/menubar.js';
import { getActiveElement } from '../../../browser/dom.js';
import { ContextView, ContextViewFocusRestore } from '../../../browser/ui/contextview/contextview.js';
import { Keybinding, logicalKey, resolveKeybinding } from '../../../common/keybindings.js';
import { OperatingSystem } from '../../../common/platform.js';
import { TestThemeService } from '../../../../platform/theme/test/common/testThemeService.js';
import { defaultMenuStyles, defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { lightColorTheme, darkColorTheme, highContrastDarkColorTheme, highContrastLightColorTheme } from '../../../../platform/theme/common/colorTheme.js';
import { bindTestColorTheme } from '../../../../../../test/fixtures/browser/themeFixture.js';
import { setNlsMessages } from '../../../../nls.js';
import { initializeTestLocalization } from '../../../../workbench/services/localization/test/common/localizationTestUtils.js';

const resources = new DisposableStore();
const theme = resources.add(new TestThemeService(lightColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
const scene = resources.add(new MutableDisposable<DisposableStore>());
const host = document.querySelector<HTMLElement>('#host')!;
const calls: Array<{ id: string; context: unknown; }> = [];
const providers: string[] = [];
const scrolls: Array<{ topChanged: boolean; leftChanged: boolean; }> = [];
let menu: Menu | undefined;
let bar: MenuBar | undefined;
let primary: Action | undefined;
let lastShadow: ShadowRoot | undefined;
const overlay = Object.assign(new EventTarget(), {
	visible: false,
	getTitlebarAreaRect: () => overlayRect,
});
let overlayRect = new DOMRect();
Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });

function mount(kind: 'basic' | 'nested' | 'long' | 'shadow' | 'left' | 'event' | 'menubar' | 'compact'): void {
	scene.clear();
	host.replaceChildren();
	host.style.transform = '';
	host.style.width = '320px';
	menu = undefined;
	bar = undefined;
	calls.length = providers.length = scrolls.length = 0;
	const lifetime = scene.value = new DisposableStore();
	const action = (id: string, label: string): Action => lifetime.add(new Action(id, label, '', true, context => {
		calls.push({ id, context: context instanceof Event ? { type: context.type } : context });
	}));
	if (kind === 'menubar' || kind === 'compact') {
		bar = lifetime.add(new MenuBar(host, {
			enableMnemonics: true, buttonStyles: defaultButtonStyles,
			compactMode: kind === 'compact' ? { horizontal: HorizontalDirection.Right, vertical: VerticalDirection.Below } : undefined,
		}, defaultMenuStyles));
		bar.push([
			{ label: '&File', actions: [action('save', '&Save')] },
			{ label: '&Файл', actions: [action('russian', '&Сохранить')] },
			{ label: '文件(&Z)', actions: [action('chinese', '保存(&S)')] },
		]);
		return;
	}
	primary = action('primary', '&Primary');
	const alternate = action('alternate', '&Alternate');
	Object.defineProperty(primary, 'alt', { value: alternate });
	const checked = action('choice', '&Choice');
	checked.checked = false;
	const child = action('child', '&Child');
	const first = new SubmenuAction('first', '&First', [checked, new SubmenuAction('nested', '&Nested', [child])]);
	const second = new SubmenuAction('second', '&Second', [action('other', '&Other')]);
	let container: HTMLElement = host;
	if (kind === 'shadow') {
		host.style.transform = 'translate(25px, 20px) scale(.9)';
		const element = document.createElement('div');
		element.id = 'shadow-host';
		host.append(element);
		lastShadow = element.attachShadow({ mode: 'open' });
		container = document.createElement('div');
		lastShadow.append(container);
	}
	const actions: IAction[] = kind === 'long'
		? [...Array.from({ length: 12 }, (_, index) => action(`row${index}`, `Row ${index}`)), first]
		: [primary, action('after', '&After'), first, second];
	menu = lifetime.add(new Menu(container, actions, {
		enableMnemonics: true,
		expandDirection: kind === 'left' ? { horizontal: HorizontalDirection.Left, vertical: VerticalDirection.Above } : undefined,
		context: { version: 1 },
		useEventAsContext: kind === 'event',
		actionRunner: lifetime.add(new ActionRunner()),
		getKeyBinding: item => item.id === 'primary' || item.id === 'alternate'
			? resolveKeybinding(Keybinding.single(logicalKey(item.id === 'primary' ? 'p' : 'a', { ctrlKey: true })), OperatingSystem.Windows) : undefined,
		getAriaDescription: item => `Details for ${item.id}`,
		getCheckedActionsRepresentation: () => 'radio',
		actionViewItemProvider: item => { providers.push(item.id); return undefined; },
	}, defaultMenuStyles));
	lifetime.add(menu.onScroll(event => scrolls.push({ topChanged: event.scrollTopChanged, leftChanged: event.scrollLeftChanged })));
	if (kind === 'long') menu.getContainer().style.maxHeight = '120px';
	menu.focus(true);
}

const api = {
	mount,
	overlay(x: number, width: number, height: number, visible = true): void {
		overlayRect = new DOMRect(x, 0, width, height);
		overlay.visible = visible;
		overlay.dispatchEvent(new Event('geometrychange'));
	},
	popup(left: number, top: number): void {
		document.querySelector<HTMLButtonElement>('#outside')!.focus();
		const popup = scene.value!.add(new ContextView(document.body));
		popup.show({
			anchor: { left, top, width: 0, height: 0 },
			content: menu!.getContainer(),
			presentation: 'menu',
			focusRestore: ContextViewFocusRestore.Previous,
		});
		menu!.focus(true);
	},
	theme(name: 'light' | 'dark' | 'hcDark' | 'hcLight'): void {
		theme.setColorTheme({ light: lightColorTheme, dark: darkColorTheme, hcDark: highContrastDarkColorTheme, hcLight: highContrastLightColorTheme }[name]);
	},
	locale(name: 'en' | 'zh-cn'): void { if (name === 'en') setNlsMessages('en', {}); else initializeTestLocalization('zh-CN'); },
	update(): void { primary!.label = '&Updated'; primary!.checked = true; },
	disable(): void { primary!.enabled = false; },
	context(): void { menu!.context = { version: 2 }; },
	focus(index: number): void { menu!.focus(index); },
	trigger(index: number): void { menu!.trigger(index); },
	resize(width: number): void { host.style.width = `${width}px`; bar!.update(); },
	visibility(visibility: 'visible' | 'toggle' | 'hidden'): void { bar!.update({ visibility }); },
	toggleBarFocus(): void { bar!.toggleFocus(); },
	updateCompact(): void { bar!.updateMenu({ label: '&File', actions: [{ id: 'updated', label: 'Updated item', tooltip: '', enabled: true, run() { calls.push({ id: 'updated', context: null }); } }] }); },
	state() {
		return {
			calls, providers, scrolls, offset: menu?.scrollOffset, visible: bar?.isVisible,
			active: getActiveElement(document)?.closest('[data-action-id]')?.getAttribute('data-action-id'),
			shadowStyles: lastShadow?.querySelectorAll('style').length,
		};
	},
	dispose(): void { scene.clear(); },
};
declare global { interface Window { ashMenuTest: typeof api; } }
window.ashMenuTest = api;
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
