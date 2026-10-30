import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { setHoverDelegate } from '../../../../../base/browser/ui/hover/hoverDelegate.js';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { InMemoryConfigurationService } from '../../../../configuration/common/inMemoryConfigurationService.js';
import { BrowserContextViewService } from '../../../../contextview/browser/contextViewService.js';
import { HoverService } from '../../../browser/hoverService.js';
import { HoverConfiguration } from '../../../common/hoverService.js';
import { bindTestColorTheme } from '../../../../../../../test/fixtures/browser/themeFixture.js';
import { TestThemeService } from '../../../../theme/test/common/testThemeService.js';
import { darkColorTheme } from '../../../../theme/common/colorTheme.js';

const resources = new DisposableStore();
window.addEventListener('pagehide', () => resources.dispose(), { once: true });
const configuration = resources.add(new InMemoryConfigurationService());
await configuration.updateValue(HoverConfiguration.delay, 100);
const views = resources.add(new BrowserContextViewService(document.body));
const service = resources.add(new HoverService(configuration, views, {
	contextMenuStyle: 'custom',
	onDidShowContextMenu: Event.None,
	onDidHideContextMenu: Event.None,
	showContextMenu() { },
	hideContextMenu() { },
}));
resources.add(setHoverDelegate(service));
const theme = resources.add(new TestThemeService(darkColorTheme));
resources.add(bindTestColorTheme(theme, document.body));
const card = document.createElement('div');
card.append('Card details');
resources.add(new ActionBar(card, {
	actions: [{ id: 'copy', label: 'Copy', tooltip: 'Copy details', enabled: true, run() { document.querySelector('output')!.textContent = 'Copied'; } }],
}));
resources.add(service.setupHover({ target: document.querySelector<HTMLButtonElement>('#details')!, content: card }));
for (const [label, tooltip] of [['First action', 'First hint'], ['Other action', 'Other hint']]) {
	resources.add(new ActionBar(document.querySelector<HTMLElement>('#controls')!, {
		actions: [{ id: label, label, tooltip, enabled: true, run() { } }],
	}));
}
