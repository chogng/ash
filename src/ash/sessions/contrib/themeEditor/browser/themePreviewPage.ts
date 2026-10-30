import type { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import {
	Extensions,
	type IConfigurationRegistry,
} from '../../../../platform/configuration/common/configurationRegistry.js';
import { themePreviewConfigurationKeys } from '../../../../workbench/contrib/themeEditor/browser/themePreview.js';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { InMemoryFileSystemProvider } from '../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { BrowserContextMenuService } from '../../../../platform/contextview/browser/contextMenuService.js';
import { LogService } from '../../../../platform/log/common/logServiceImpl.js';
import { ConsoleLogSink } from '../../../../platform/log/common/consoleLogSink.js';
import {
	createThemePreviewHost,
	connectThemePreview,
	openThemePreviewEditors,
} from '../../../../workbench/contrib/themeEditor/browser/themePreviewHost.js';
import { BrowserHostColorSchemeService } from '../../../../workbench/services/themes/browser/browserHostColorSchemeService.js';
import { createSessionsWorkbench } from '../../../browser/workbenchFactory.js';
import { TitlebarPart } from '../../../browser/parts/titlebarPart.js';
import {
	IWorkingCopyBackupService,
	InMemoryWorkingCopyBackupService,
} from '../../../../workbench/services/workingCopy/common/workingCopyBackupService.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IWorkbenchEnvironmentService } from '../../../../workbench/services/environment/common/environmentService.js';
import { BrowserWorkbenchEnvironmentService } from '../../../../workbench/services/environment/browser/environmentService.js';

const host = await createThemePreviewHost();
await import('../../../sessions.web.main.js');
const { resources, root, api, serviceCollection, workspaceRoot, workspaceFiles, storage } = host;
serviceCollection.set(
	IWorkbenchEnvironmentService,
	new SyncDescriptor(BrowserWorkbenchEnvironmentService, [window.location, 'https://{{uuid}}.invalid']),
);
serviceCollection.set(IWorkingCopyBackupService, resources.add(new InMemoryWorkingCopyBackupService('theme-preview')));

// The production Sessions workbench owns every Part, page and local draft. This
// embedder supplies only isolated host capabilities, so navigation needs no copy
// of the Agent Window DOM and cannot reach the user's files or app server.
let services: IInstantiationService;
const workbench = resources.add(
	await createSessionsWorkbench({
		container: root,
		serviceCollection,
		api,
		extensionHost: api.extensionHost,
		profile: {
			id: 'theme-preview',
			label: 'Ash',
			titlebarActionId: 'ash.themePreview',
			workbenchRelativePath: '../workbench/workbench.html',
		},
		workspace: () => ({
			id: 'theme-preview',
			folders: [{ id: 'theme-preview', name: 'theme-preview', uri: workspaceRoot, index: 0 }],
		}),
		workspaceSelection: () => ({ type: 'current' }),
		browserFileSystemProvider: workspaceFiles,
		initialConfiguration: { contents: {}, keys: [], overrides: [] },
		createStorageService: async () => storage,
		createUserDataFileSystemProvider: async () => new InMemoryFileSystemProvider(),
		createLogService: () => new LogService({ sinks: [new ConsoleLogSink()] }),
		createLifecycleService: host.createLifecycleService,
		createContextMenuService: services => services.createInstance(BrowserContextMenuService),
		createHostColorSchemeService: () => new BrowserHostColorSchemeService(window),
		createTitlebarPart: (container, services) =>
			services.createInstance(TitlebarPart, container, 'application-menu'),
		createFileDialogService: scope => {
			services = scope;
			host.restrictOpeners(scope);
			const descriptor = host.fileDialogDescriptor(() => scope);
			return scope.createInstance(descriptor.ctor, ...descriptor.staticArguments);
		},
		returnToWorkbench: () => { },
		contributionIds: ['workbench.contrib.sessionsLayout'],
	}),
);
await workbench.whenRestored;
const scene = new URLSearchParams(location.search).get('sample');
if (scene === 'code' || scene === 'diff') await openThemePreviewEditors(host, services!, scene);
const readOnlyKeys = new Set(
	Registry.as<IConfigurationRegistry>(Extensions.Configuration)
		.getRegisteredConfigurations()
		.filter(entry => entry.agentsWindow?.readOnly)
		.map(entry => entry.key),
);
const publishContent = connectThemePreview(
	resources,
	workbench.themeService,
	workbench.configurationService,
	() =>
		root.innerText +
		'\n' +
		services!
			.get(ICodeEditorService)
			.listCodeEditors()
			.map(editor => `${editor.getModel()?.uri.path ?? ''}\n${editor.getModel()?.getValue() ?? ''}`)
			.join('\n'),
	themePreviewConfigurationKeys.filter(key => !readOnlyKeys.has(key)),
);
resources.add(addDisposableListener(root, 'click', publishContent));
resources.add(addDisposableListener(root, 'input', publishContent));
