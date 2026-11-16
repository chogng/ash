import { AppServerProtocolClient } from '../../../src/ash/platform/agentHost/browser/appServerProtocolClient.js';
import { WEB_APP_SERVER_CONNECT_EVENT, WEB_APP_SERVER_CONNECTED_EVENT, WEB_APP_SERVER_FRAME_EVENT, type AppServerTransport } from '../../../src/ash/platform/agentHost/common/appServerTransport.js';
import { createTestInitializeResult } from '../../../src/ash/platform/agentHost/test/common/testAppServerProtocol.js';
import { AppServerPdfService } from '../../../src/ash/platform/pdf/browser/appServerPdfService.js';
import { IPdfService } from '../../../src/ash/platform/pdf/common/pdfService.js';
import { IFileService } from '../../../src/ash/platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../src/ash/platform/files/common/inMemoryFilesystemProvider.js';
import { URI } from '../../../src/ash/base/common/uri.js';
import { InstantiationService } from '../../../src/ash/platform/instantiation/common/instantiationService.js';
import { createTestFileService, registerTestComponentServices } from '../../../src/ash/workbench/test/common/testEditorServices.js';
import { EditorPanes } from '../../../src/ash/workbench/browser/editor.js';
import type { EditorPane } from '../../../src/ash/workbench/browser/parts/editor/editorPane.js';
import { setNlsMessages } from '../../../src/ash/nls.js';
import { languagePackCatalog as chineseCatalog } from '../../../.build/desktop/localization/localizationCatalog.zh-CN.js';
import { bindTestColorTheme } from '../../fixtures/browser/themeFixture.js';
import { IThemeService } from '../../../src/ash/platform/theme/common/themeService.js';
import { TestThemeService } from '../../../src/ash/platform/theme/test/common/testThemeService.js';
import { IWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/common/workingCopyService.js';
import { BrowserWorkingCopyService } from '../../../src/ash/workbench/services/workingCopy/browser/browserWorkingCopyService.js';
import { IConfigurationService } from '../../../src/ash/platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../src/ash/workbench/services/configuration/test/common/testServices.js';
import { IPdfEditorService, PdfEditorService } from '../../../src/ash/sessions/contrib/files/browser/pdfEditorService.js';
import { highContrastDarkColorTheme } from '../../../src/ash/platform/theme/common/colorTheme.js';
import '../../../src/ash/sessions/contrib/files/browser/pdfPreview.contribution.js';
import '../../../src/ash/base/browser/ui/button/button.css';

class Transport implements AppServerTransport {
	private readonly listeners = new Map<string, Set<(value: unknown) => void>>();
	public on(event: string, listener: (value: unknown) => void): void {
		const listeners = this.listeners.get(event) ?? new Set(); listeners.add(listener); this.listeners.set(event, listeners);
	}
	public off(event: string, listener: (value: unknown) => void): void { this.listeners.get(event)?.delete(listener); }
	public send(event: string, payload?: unknown): void {
		if (event === WEB_APP_SERVER_CONNECT_EVENT) { this.emit(WEB_APP_SERVER_CONNECTED_EVENT, { protocolVersion: 1, workspaceId: 'pdf', workspaceRoot: '/fixture' }); return; }
		if (event !== WEB_APP_SERVER_FRAME_EVENT) { return; }
		const request = JSON.parse((payload as { frame: string; }).frame) as { id?: number; method: string; params: unknown; };
		if (request.id === undefined) { return; }
		if (request.method === 'initialize') {
			const result = createTestInitializeResult(); result.capabilities.contracts.pdf = { version: 1 };
			this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
			return;
		}
		void fetch('/__aspdf_rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) })
			.then(response => response.json()).then(reply => this.emit(WEB_APP_SERVER_FRAME_EVENT, { frame: JSON.stringify({ jsonrpc: '2.0', ...reply }) }));
	}
	private emit(event: string, value: unknown): void { for (const listener of this.listeners.get(event) ?? []) { listener(value); } }
}

const locale = new URL(location.href).searchParams.get('locale') ?? 'en';
setNlsMessages(locale, locale === 'zh-CN' ? chineseCatalog.bundles : {});
const services = new InstantiationService();
const memory = new InMemoryFileSystemProvider();
const files = createTestFileService(memory);
services.registerInstance(IFileService, files); registerTestComponentServices(services);
services.registerInstance(IConfigurationService, new TestConfigurationService());
services.registerSingleton(IWorkingCopyService, () => services.createInstance(BrowserWorkingCopyService));
services.registerSingleton(IPdfEditorService, () => services.createInstance(PdfEditorService));
const theme = bindTestColorTheme(services.get(IThemeService), document.body);
const client = new AppServerProtocolClient(new Transport());
await client.connect();
services.registerInstance(IPdfService, new AppServerPdfService(client));
const resource = URI.file('/fixture/review.pdf');
await memory.createDirectory(URI.file('/fixture'));
const original = new Uint8Array(await (await fetch('/__aspdf_bytes')).arrayBuffer());
await memory.writeFile(resource, original, { create: true, overwrite: false });
let pane: EditorPane | undefined;
let split: EditorPane | undefined;
window.aspdfTest = {
	async open(readOnly = false) {
		pane?.dispose();
		const input = { resource, readOnly };
		const descriptor = EditorPanes.getEditorPane(input)!;
		pane = await descriptor.create({ input, instantiationService: services });
		pane.create(document.getElementById('viewer')!); pane.setVisible(true);
		await pane.setInput(input, new AbortController().signal);
	},
	dirty() { return pane?.workingCopy?.isDirty ?? false; },
	async externalWrite() { await memory.writeFile(resource, new Uint8Array([...original, ...new TextEncoder().encode('\n% external change\n')]), { create: false, overwrite: true }); },
	async hasExternalBytes() { return new TextDecoder().decode((await memory.readFile(resource)).bytes).includes('% external change'); },
	async revert() { await pane?.workingCopy?.revert(new AbortController().signal); },
	async split() {
		const container = document.createElement('main'); container.id = 'split'; container.style.height = '800px'; document.body.append(container);
		const input = { resource };
		split = await EditorPanes.getEditorPane(input)!.create({ input, instantiationService: services });
		split.create(container); split.setVisible(true); await split.setInput(input, new AbortController().signal);
	},
	closeFirst() { pane?.dispose(); pane = split; split = undefined; },
	async saved() { const bytes = (await memory.readFile(resource)).bytes; return { changed: String(bytes) !== String(original), pdf: new TextDecoder().decode(bytes.slice(0, 8)).startsWith('%PDF-') }; },
	highContrast() { (services.get(IThemeService) as TestThemeService).setColorTheme(highContrastDarkColorTheme); },
	dispose() { pane?.dispose(); split?.dispose(); client.dispose(); theme.dispose(); services.dispose(); files.dispose(); memory.dispose(); },
};
declare global {
	interface Window { aspdfTest: { open(readOnly?: boolean): Promise<void>; dirty(): boolean; saved(): Promise<{ changed: boolean; pdf: boolean; }>; externalWrite(): Promise<void>; hasExternalBytes(): Promise<boolean>; revert(): Promise<void>; split(): Promise<void>; closeFirst(): void; highContrast(): void; dispose(): void; }; }
}
