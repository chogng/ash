import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'mocha';
import { JSDOM } from 'jsdom';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ServiceContainer } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchConfiguration } from '../../../../common/configuration.js';
import { WorkbenchFileIconThemesRegistry } from '../../../themes/common/themeExtensionPoints.js';
import { WorkbenchConfigurationService } from '../../../configuration/browser/configurationService.js';
import { FileIconThemeData } from '../../browser/fileIconThemeData.js';
import { WorkbenchThemeService } from '../../browser/workbenchThemeService.js';

const directory = '../extensions/theme-seti/icons/';

test('packaged Seti resolves filenames, extensions and light variants and can be disabled', async () => {
	const document = JSON.parse(await readFile(directory + 'vs-seti-icon-theme.json', 'utf8'));
	const theme = await FileIconThemeData.load('vs-seti', 'Seti', document, path => readFile(directory + path));
	using registration = WorkbenchFileIconThemesRegistry.registerThemes();
	registration.replace([theme]);
	const browser = new JSDOM('<!doctype html><body></body>');
	try {
		Object.defineProperty(browser.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
		using configuration = new WorkbenchConfigurationService();
		using services = new ServiceContainer();
		services.registerInstance(IConfigurationService, configuration);
		using themes = services.createInstance(WorkbenchThemeService, browser.window.document.body);
		themes.initialize();
		const render = (name: string): HTMLElement => {
			const icon = browser.window.document.createElement('span');
			themes.renderFileIcon(URI.file('C:/project/' + name), icon);
			return icon;
		};
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-dark');
		const ts = render('main.ts');
		assert.notEqual(render('README.md').textContent, '');
		assert.notEqual(ts.textContent, render('source.unknown-extension').textContent);
		assert.notEqual(render('source.rs').textContent, render('source.unknown-extension').textContent);
		assert.notEqual(ts.style.color, render('main.test.ts').style.color);
		assert.match(browser.window.document.head.textContent!, /data:application\/octet-stream;base64,/);
		await configuration.updateValue(WorkbenchConfiguration.colorTheme, 'ash-light');
		assert.notEqual(render('main.ts').style.color, ts.style.color);
		await configuration.updateValue(WorkbenchConfiguration.iconTheme, null);
		themes.renderFileIcon(URI.file('C:/project/main.ts'), ts);
		assert.deepEqual([ts.textContent, ts.style.fontFamily, ts.style.color], ['', '', '']);
		assert.equal(browser.window.document.head.textContent, '');
		await configuration.updateValue(WorkbenchConfiguration.iconTheme, 'vs-seti');
		assert.notEqual(render('main.ts').textContent, '');
		themes.dispose();
		assert.equal(browser.window.document.head.querySelector('style'), null);
	} finally { browser.window.close(); }
});

test('icon documents reject escaping assets and missing definitions before activation', async () => {
	let reads = 0;
	const read = async (): Promise<Uint8Array> => { reads++; return new Uint8Array(); };
	await assert.rejects(FileIconThemeData.load('bad', 'Bad', { fonts: [{ id: 'font', src: [{ path: '../outside.woff', format: 'woff' }] }], iconDefinitions: {} }, read), /inside/);
	assert.equal(reads, 0);
	await assert.rejects(FileIconThemeData.load('bad', 'Bad', { iconDefinitions: {}, file: 'absent' }, read), /Unknown file icon/);
});
