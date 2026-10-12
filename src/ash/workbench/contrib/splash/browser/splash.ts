import { createServiceIdentifier } from '../../../../platform/instantiation/common/instantiation.js';
import { Color } from '../../../../base/common/color.js';
import { ColorScheme, isDarkColorScheme } from '../../../../platform/theme/common/theme.js';
import { Colors } from '../../../../platform/theme/common/colorRegistry.js';
import { editorBackground } from '../../../../platform/theme/common/colors/editorColors.js';
import { foreground } from '../../../../platform/theme/common/colors/baseColors.js';
import { validatePartsSplash, type IPartsSplash } from '../../../../platform/theme/common/themeService.js';

export const ISplashStorageService = createServiceIdentifier<ISplashStorageService>('ISplashStorageService');

export interface ISplashStorageService {
	saveWindowSplash(splash: IPartsSplash): Promise<void>;
}

export function browserSplashStorageKey(ownerWindow: Window): string {
	const query = new URLSearchParams(ownerWindow.location.search);
	return `ash.partsSplash:${ownerWindow.location.pathname}:${query.get('folder') ?? ''}:${query.get('workspace') ?? ''}:${query.get('remoteAuthority') ?? ''}`;
}

export function readBrowserPartsSplash(ownerWindow: Window): IPartsSplash {
	try {
		const raw = ownerWindow.localStorage.getItem(browserSplashStorageKey(ownerWindow));
		if (raw) return validatePartsSplash(JSON.parse(raw));
	} catch {
		// An unavailable or outdated rendering cache must never block startup.
	}
	const dark = ownerWindow.matchMedia('(prefers-color-scheme: dark)').matches;
	const contrast = ownerWindow.matchMedia('(forced-colors: active)').matches;
	const scheme = contrast ? (dark ? ColorScheme.HighContrastDark : ColorScheme.HighContrastLight) : (dark ? ColorScheme.Dark : ColorScheme.Light);
	const colors = Colors.resolve(scheme);
	return {
		baseTheme: scheme,
		colorInfo: {
			background: Color.Format.CSS.formatHex(colors.find(color => color.id === editorBackground)!.value!),
			foreground: Color.Format.CSS.formatHex(colors.find(color => color.id === foreground)!.value!),
		},
	};
}

export function showPartsSplash(ownerDocument: Document, splash: IPartsSplash): void {
	removePartsSplash(ownerDocument);
	const styles = ownerDocument.createElement('style');
	styles.className = 'ash-initial-shell-colors';
	styles.textContent = `html, body { background-color: ${splash.colorInfo.background}; color: ${splash.colorInfo.foreground}; color-scheme: ${isDarkColorScheme(splash.baseTheme) ? 'dark' : 'light'}; }`;
	ownerDocument.head.append(styles);
	const element = ownerDocument.createElement('div');
	element.id = 'ash-parts-splash';
	element.setAttribute('aria-hidden', 'true');
	element.inert = true;
	Object.assign(element.style, {
		position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '10000',
		backgroundColor: splash.colorInfo.background,
	});
	ownerDocument.body.append(element);
	ownerDocument.defaultView?.performance.mark('ash.splash.shown');
}

export function removePartsSplash(ownerDocument: Document): void {
	ownerDocument.getElementById('ash-parts-splash')?.remove();
	ownerDocument.querySelector('.ash-initial-shell-colors')?.remove();
}
