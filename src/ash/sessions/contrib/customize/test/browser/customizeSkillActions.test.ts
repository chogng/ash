import assert from 'node:assert/strict';
import { test } from 'mocha';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { FileUserDataProvider } from '../../../../../platform/userData/common/fileUserDataProvider.js';
import { URI } from '../../../../../base/common/uri.js';
import { IDialogService, type IInputDialogResult } from '../../../../../platform/dialogs/common/dialogs.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { InstantiationService } from '../../../../../platform/instantiation/common/instantiationService.js';
import { IPathService } from '../../../../../platform/path/common/pathService.js';
import { IChatSessionNavigationService } from '../../../../../workbench/services/chat/common/chatSessionNavigationService.js';
import { IEditorService } from '../../../../../workbench/services/editor/common/editorService.js';
import {
	ISessionPrimaryProviderServices,
	type SessionProviderServices,
} from '../../../../browser/agentHost/sessionProviderScopeService.js';
import { ISessionsService } from '../../../../services/sessions/browser/sessionsService.js';
import { CustomizeSkillActions } from '../../browser/customizeSkillActions.js';

const home = URI.file('/fixture-home');
const target = URI.from({ scheme: Schemas.vscodeUserData, path: '/user/skills/meeting-notes/SKILL.md' });
const instructions =
	'---\nname: meeting-notes\ndescription: Summarize meeting notes.\n---\n\nKeep decisions and action items.\n';

ensureNoDisposablesAreLeakedInTestSuite();

function fixture() {
	const resources = new DisposableStore();
	const files = resources.add(new FileService());
	const provider = resources.add(new InMemoryFileSystemProvider());
	resources.add(files.registerProvider('file', provider));
	resources.add(
		files.registerProvider(Schemas.vscodeUserData, resources.add(new FileUserDataProvider(provider, home))),
	);
	const state = {
		input: {
			confirmed: true,
			values: ['meeting-notes', 'Summarize meeting notes.', 'Keep decisions and action items.'],
		} as IInputDialogResult,
		roots: [] as string[],
		opened: [] as string[],
		drafts: [] as string[],
		sessions: [] as string[],
		registrationError: undefined as Error | undefined,
	};
	const services = resources.add(new InstantiationService());
	services.registerInstance(IFileService, files);
	services.registerInstance(IDialogService, {
		input: async () => state.input,
		prompt: async () => ({}),
	} as unknown as IDialogService);
	services.registerInstance(IPathService, {
		userHome: async () => home,
		getHostPath: async (resource: URI) => resource.path,
	} as IPathService);
	services.registerInstance(ISessionPrimaryProviderServices, {
		host: { userDataHome: home },
		prompts: {
			registerSkillSource: async (root: string) => {
				if (state.registrationError) throw state.registrationError;
				state.roots.push(root);
			},
		},
	} as unknown as SessionProviderServices);
	services.registerInstance(IEditorService, {
		openEditor: async (input: { resource: URI }) => {
			state.opened.push(input.resource.toString());
		},
	} as unknown as IEditorService);
	services.registerInstance(ISessionsService, {
		openNewSession: (title: string) => {
			state.sessions.push(title);
		},
	} as unknown as ISessionsService);
	services.registerInstance(IChatSessionNavigationService, {
		appendToActiveDraft: (text: string) => {
			assert.equal(state.sessions.length, 1);
			state.drafts.push(text);
		},
	} as IChatSessionNavigationService);
	const actions = resources.add(
		services.createInstance(CustomizeSkillActions, {
			createElement() {
				throw new Error('Unexpected file picker');
			},
		} as unknown as Document),
	);
	return { resources, files, state, actions };
}

test('Create skill publishes valid instructions, registers their source, and opens the file', async () => {
	const { resources, files, state, actions } = fixture();
	using lifetime = resources;
	assert.equal(await actions.create(), true);
	assert.equal(
		(await files.readFile(target)).content,
		'---\nname: "meeting-notes"\ndescription: "Summarize meeting notes."\n---\n\nKeep decisions and action items.\n',
	);
	assert.deepEqual(state.roots, ['/fixture-home/skills']);
	assert.deepEqual(state.opened, [target.toString()]);
	await assert.rejects(actions.create());
	assert.match((await files.readFile(target)).content, /Keep decisions and action items/);
});

test('Upload skill retains package resources and exact manifest bytes', async () => {
	const { resources, files, state, actions } = fixture();
	using lifetime = resources;
	const manifest = new File([instructions], 'SKILL.md');
	Object.defineProperty(manifest, 'webkitRelativePath', { value: 'meeting-notes/SKILL.md' });
	const reference = new File([new Uint8Array([0, 255, 4])], 'notes.bin');
	Object.defineProperty(reference, 'webkitRelativePath', { value: 'meeting-notes/references/notes.bin' });
	assert.equal(await actions.uploadFiles([manifest, reference]), true);
	assert.equal((await files.readFile(target)).content, instructions);
	assert.deepEqual(
		(await files.readFileBytes(URI.joinPath(target, '../references/notes.bin'))).bytes,
		new Uint8Array([0, 255, 4]),
	);
	assert.deepEqual(state.roots, ['/fixture-home/skills']);
	assert.deepEqual(state.opened, []);
});

test('Cancelled and invalid skill forms never publish files or register sources', async () => {
	const { resources, files, state, actions } = fixture();
	using lifetime = resources;
	state.input = { confirmed: false };
	assert.equal(await actions.create(), false);
	assert.equal(await actions.upload(), false);
	state.input = { confirmed: true, values: ['../unsafe', 'Description', 'Instructions'] };
	await assert.rejects(actions.create(), /valid name/);
	await assert.rejects(files.stat(target));
	assert.deepEqual(state.roots, []);
});

test('Failed source registration cleans staged files and leaves the destination unpublished', async () => {
	const { resources, files, state, actions } = fixture();
	using lifetime = resources;
	state.registrationError = new Error('Configuration changed in another window');
	await assert.rejects(actions.create(), /Configuration changed/);
	await assert.rejects(files.stat(target));
	assert.deepEqual(
		(await files.readDirectory(home)).map(entry => entry.name),
		['skills'],
	);
	assert.deepEqual(state.opened, []);
});

test('Create with Ash opens a separate unsent draft with the skill creator selector', () => {
	const { resources, state, actions } = fixture();
	using lifetime = resources;
	actions.createWithAsh();
	assert.deepEqual(state.sessions, ['Create a skill']);
	assert.equal(state.drafts.length, 1);
	assert.match(state.drafts[0], /^\$skill-creator\nHelp me create a reusable skill\./);
});
