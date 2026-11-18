import type { IProcessEnvironment } from './platform.js';

type DesktopEnvironment = 'UNKNOWN' | 'CINNAMON' | 'DEEPIN' | 'GNOME' | 'KDE3' | 'KDE4' | 'KDE5' | 'KDE6'
	| 'PANTHEON' | 'UNITY' | 'XFCE' | 'UKUI' | 'LXQT';

const xdgDesktops = new Map<string, DesktopEnvironment>([
	['Deepin', 'DEEPIN'],
	['GNOME', 'GNOME'],
	['X-Cinnamon', 'CINNAMON'],
	['Pantheon', 'PANTHEON'],
	['XFCE', 'XFCE'],
	['UKUI', 'UKUI'],
	['LXQt', 'LXQT'],
]);

const legacySessions = new Map<string, DesktopEnvironment>([
	['deepin', 'DEEPIN'],
	['gnome', 'GNOME'],
	['mate', 'GNOME'],
	['kde4', 'KDE4'],
	['kde-plasma', 'KDE4'],
	['xfce', 'XFCE'],
	['xubuntu', 'XFCE'],
	['ukui', 'UKUI'],
]);

/** Identifies the Linux desktop from the host's session variables. */
export function getDesktopEnvironment(env: Readonly<IProcessEnvironment>): DesktopEnvironment {
	for (const name of env.XDG_CURRENT_DESKTOP?.split(':') ?? []) {
		const desktop = name.trim();
		if (desktop === 'Unity') {
			return env.DESKTOP_SESSION?.includes('gnome-fallback') ? 'GNOME' : 'UNITY';
		}
		if (desktop === 'KDE') {
			switch (env.KDE_SESSION_VERSION) {
				case '5': return 'KDE5';
				case '6': return 'KDE6';
				default: return 'KDE4';
			}
		}
		const recognized = xdgDesktops.get(desktop);
		if (recognized) {
			return recognized;
		}
	}

	const legacy = legacySessions.get(env.DESKTOP_SESSION ?? '');
	if (legacy) {
		return legacy;
	}
	if (env.DESKTOP_SESSION === 'kde') {
		return 'KDE_SESSION_VERSION' in env ? 'KDE4' : 'KDE3';
	}
	if ('GNOME_DESKTOP_SESSION_ID' in env) {
		return 'GNOME';
	}
	if ('KDE_FULL_SESSION' in env) {
		return 'KDE_SESSION_VERSION' in env ? 'KDE4' : 'KDE3';
	}
	return 'UNKNOWN';
}
