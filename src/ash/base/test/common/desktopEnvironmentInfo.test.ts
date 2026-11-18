import assert from 'node:assert/strict';
import { suite, test } from 'mocha';
import { getDesktopEnvironment } from '../../common/desktopEnvironmentInfo.js';

suite('Desktop environment info', () => {
	test('uses the first recognized XDG name and resolves desktop variants', () => {
		assert.equal(getDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'ubuntu: GNOME :XFCE', DESKTOP_SESSION: 'xubuntu' }), 'GNOME');
		assert.equal(getDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'Unity', DESKTOP_SESSION: 'gnome-fallback' }), 'GNOME');
		assert.equal(getDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'KDE' }), 'KDE4');
		assert.equal(getDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '5' }), 'KDE5');
		assert.equal(getDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'KDE', KDE_SESSION_VERSION: '6' }), 'KDE6');
	});

	test('falls back to the session name and then legacy markers', () => {
		assert.equal(getDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'other', DESKTOP_SESSION: 'mate' }), 'GNOME');
		assert.equal(getDesktopEnvironment({ DESKTOP_SESSION: 'kde' }), 'KDE3');
		assert.equal(getDesktopEnvironment({ KDE_FULL_SESSION: '', KDE_SESSION_VERSION: '4' }), 'KDE4');
		assert.equal(getDesktopEnvironment({ GNOME_DESKTOP_SESSION_ID: '', KDE_FULL_SESSION: '' }), 'GNOME');
		assert.equal(getDesktopEnvironment({ XDG_CURRENT_DESKTOP: 'unrecognized', DESKTOP_SESSION: 'other' }), 'UNKNOWN');
	});
});
