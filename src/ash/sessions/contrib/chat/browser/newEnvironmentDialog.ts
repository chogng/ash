import { parseSessionEnvironment } from '../../../services/sessions/common/sessionEnvironment.js';
import './media/newEnvironmentDialog.css';
import { addDisposableListener } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultDialogStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import type { SessionExecutionTarget } from '../../../services/sessions/common/session.js';

interface EnvironmentHost {
	readonly label: string;
	readonly group: 'local' | 'remote';
	readonly needsWorkspace?: boolean;
	readonly resolve: (workspace: string) => Promise<{ readonly providerId: string; readonly source?: SessionExecutionTarget; } | undefined>;
}

interface EnvironmentFolder {
	readonly target: SessionExecutionTarget;
	worktree?: SessionExecutionTarget;
}

interface EnvironmentDialogOptions {
	readonly hosts: readonly EnvironmentHost[];
	readonly selected: number;
	readonly initial?: SessionExecutionTarget;
	readonly browse: (source: SessionExecutionTarget | undefined) => Promise<readonly SessionExecutionTarget[]>;
	readonly recent: (source: SessionExecutionTarget | undefined) => Promise<readonly SessionExecutionTarget[]>;
	readonly worktrees: (providerId: string, target: SessionExecutionTarget) => Promise<readonly { readonly label: string; readonly target: SessionExecutionTarget; }[]>;
	readonly create: (name: string, providerId: string, folders: readonly SessionExecutionTarget[], variables: string) => Promise<void>;
}

export class NewEnvironmentDialog extends Disposable {
	private readonly dialog: Dialog;
	private readonly title = localize('sessions.environment.newEnvironment', 'New Environment');

	constructor(container: HTMLElement, options: EnvironmentDialogOptions) {
		super();
		const doc = container.ownerDocument;
		const folders: EnvironmentFolder[] = options.initial ? [{ target: options.initial }] : [];
		let variables = '';
		let busy = false;
		let host: Awaited<ReturnType<EnvironmentHost['resolve']>>;
		const main = doc.createElement('div');
		const editor = doc.createElement('div');
		const footer = doc.createElement('div');
		const error = doc.createElement('div');
		error.setAttribute('role', 'alert');
		main.className = editor.className = 'ash-environment-fields';
		footer.className = 'ash-environment-actions';
		editor.hidden = true;

		const field = (parent: HTMLElement, text: string, input: HTMLElement) => {
			const label = doc.createElement('label');
			label.className = 'ash-environment-field';
			label.append(text, input);
			parent.append(label);
		};
		const button = (parent: HTMLElement, label: string, run: () => void, primary = false) => this._register(new Button(parent, {
			...defaultButtonStyles, label, presentation: primary ? 'primary' : 'secondary', onClick: run,
		}));
		const run = async (action: () => Promise<void>) => {
			if (busy) return;
			busy = true;
			error.textContent = '';
			footer.setAttribute('aria-busy', 'true');
			select.disabled = true;
			connectionWorkspace.disabled = true;
			try { await action(); }
			catch (failure) {
				if (!this.isDisposed) error.textContent = failure instanceof Error ? failure.message : String(failure);
			} finally {
				busy = false;
				footer.removeAttribute('aria-busy');
				select.disabled = false;
				connectionWorkspace.disabled = false;
			}
		};

		const name = doc.createElement('input');
		name.value = options.initial?.root.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
		field(main, localize('sessions.environment.name', 'Name'), name);
		const select = doc.createElement('select');
		const localHosts = doc.createElement('optgroup');
		localHosts.label = localize('sessions.environment.localGroup', 'Local');
		const remoteHosts = doc.createElement('optgroup');
		remoteHosts.label = localize('sessions.environment.remote', 'Remote');
		options.hosts.forEach(({ label, group }, index) => (group === 'local' ? localHosts : remoteHosts).append(new Option(label, String(index))));
		select.append(localHosts, remoteHosts);
		const cloud = new Option(localize('sessions.environment.cloudUnavailable', 'Cloud (unavailable)'), '');
		cloud.disabled = true;
		select.add(cloud);
		select.value = String(options.selected);
		field(main, localize('sessions.environment.runIn', 'Run in'), select);
		const connectionWorkspace = doc.createElement('input');
		connectionWorkspace.placeholder = '/home/user/project';
		field(main, localize('sessions.environment.workspacePath', 'Absolute workspace path'), connectionWorkspace);
		const connectionField = connectionWorkspace.parentElement!;
		connectionField.hidden = !options.hosts[options.selected]?.needsWorkspace;
		const resolveHost = async () => {
			const target = options.hosts[Number(select.value)];
			if (!target) throw new Error(localize('sessions.environment.unavailable', 'Host unavailable'));
			const workspace = connectionWorkspace.value.trim();
			if (target.needsWorkspace && (!workspace.startsWith('/') || workspace.includes('\0'))) {
				connectionWorkspace.focus();
				throw new Error(localize('sessions.workspace.absolutePath', 'Enter an absolute folder path.'));
			}
			host ??= await target.resolve(workspace);
			if (!host && !this.isDisposed) throw new Error(localize('sessions.environment.connectionUnavailable', 'The connected host is unavailable for this conversation.'));
			return host;
		};
		const list = doc.createElement('div');
		list.className = 'ash-environment-fields';
		const folderHeader = doc.createElement('div');
		folderHeader.className = 'ash-environment-row';
		folderHeader.append(localize('sessions.environment.folders', 'Folders'));
		const recent = doc.createElement('div');
		recent.className = 'ash-environment-recent';
		recent.hidden = true;
		const filter = doc.createElement('input');
		filter.type = 'search';
		filter.placeholder = localize('sessions.workspace.searchFolders', 'Search folders');
		filter.setAttribute('aria-label', filter.placeholder);
		const recentList = doc.createElement('div');
		recent.append(filter, recentList);
		let candidates: readonly SessionExecutionTarget[] = [];
		this._register(addDisposableListener(connectionWorkspace, 'input', () => { host = undefined; folders.length = 0; renderFolders(); }));
		const remotePath = doc.createElement('input');
		const remotePathRow = doc.createElement('div');
		remotePathRow.className = 'ash-environment-row';
		remotePathRow.hidden = true;
		field(remotePathRow, localize('sessions.environment.workspacePath', 'Absolute workspace path'), remotePath);
		button(remotePathRow, localize('sessions.environment.addFolder', '+ Add'), () => {
			const source = host?.source;
			const root = remotePath.value.trim();
			if (!source || source.type === 'local') return;
			if (!root.startsWith('/') || root.includes('\0')) {
				error.textContent = localize('sessions.workspace.absolutePath', 'Enter an absolute folder path.');
				remotePath.focus();
				return;
			}
			add([{ ...source, root }]);
			remotePathRow.hidden = true;
			addButton.focus();
		});
		const add = (targets: readonly SessionExecutionTarget[]) => {
			for (const target of targets) {
				if (!folders.some(folder => folder.target.root === target.root)) folders.push({ target });
			}
			renderFolders();
		};
		const addButton = button(folderHeader, localize('sessions.environment.addFolder', '+ Add'), () => void run(async () => {
			const current = await resolveHost();
			if (!current || this.isDisposed) return;
			candidates = (await options.recent(current.source)).filter(target => !folders.some(folder => folder.target.root === target.root));
			if (this.isDisposed) return;
			filter.value = '';
			renderRecent();
			recent.hidden = false;
			addButton.domNode.setAttribute('aria-expanded', 'true');
			filter.focus();
		}));
		addButton.domNode.setAttribute('aria-expanded', 'false');
		const closeRecent = () => {
			recent.hidden = true;
			addButton.domNode.setAttribute('aria-expanded', 'false');
		};
		const chooseFolder = () => void run(async () => {
			closeRecent();
			if (host?.source && host.source.type !== 'local') {
				remotePathRow.hidden = false;
				remotePath.value = host.source.root;
				remotePath.focus();
				return;
			}
			const targets = await options.browse(host?.source);
			if (this.isDisposed) return;
			add(targets);
			addButton.focus();
		});
		const renderRecent = () => {
			recentList.replaceChildren();
			const query = filter.value.trim().toLowerCase();
			const addChoice = (label: string, action: () => void, title?: string) => {
				const choice = doc.createElement('button');
				choice.type = 'button';
				choice.textContent = label;
				if (title) choice.title = title;
				choice.onclick = action;
				recentList.append(choice);
			};
			for (const target of candidates.filter(target => target.root.toLowerCase().includes(query))) {
				addChoice(target.root.split(/[\\/]/).filter(Boolean).at(-1) ?? target.root, () => {
					closeRecent();
					add([target]);
					addButton.focus();
				}, target.root);
			}
			addChoice(localize('sessions.environment.chooseFolder', 'Choose…'), chooseFolder);
		};
		this._register(addDisposableListener(filter, 'input', renderRecent));
		this._register(addDisposableListener(recent, 'keydown', event => {
			if (event.key !== 'Escape') return;
			event.preventDefault();
			event.stopPropagation();
			closeRecent();
			addButton.focus();
		}));
		main.append(folderHeader, recent, remotePathRow, list);
		const renderFolders = () => {
			list.replaceChildren();
			for (const folder of folders) {
				const row = doc.createElement('div');
				row.className = 'ash-environment-row ash-environment-folder';
				const path = doc.createElement('span');
				path.textContent = folder.target.root.split(/[\\/]/).filter(Boolean).at(-1) ?? folder.target.root;
				path.title = folder.target.root;
				row.append(path);
				const worktree = doc.createElement('select');
				worktree.setAttribute('aria-label', localize('sessions.environment.folderWorktree', 'Worktree for {0}', folder.target.root));
				worktree.add(new Option(folder.worktree?.root ?? localize('sessions.environment.originalFolder', 'Original folder'), 'original'));
				worktree.add(new Option(localize('sessions.environment.chooseWorktree', 'Choose Worktree…'), 'choose'));
				row.append(worktree);
				const remove = doc.createElement('button');
				remove.type = 'button';
				remove.textContent = localize('sessions.environment.removeFolder', 'Remove');
				remove.setAttribute('aria-label', localize('sessions.environment.removeNamedFolder', 'Remove {0}', folder.target.root));
				remove.onclick = () => {
					folders.splice(folders.indexOf(folder), 1);
					renderFolders();
					addButton.focus();
				};
				row.append(remove);
				worktree.onchange = () => void run(async () => {
					const current = await resolveHost();
					if (!current || this.isDisposed || !row.isConnected) return;
					const choices = await options.worktrees(current.providerId, folder.target);
					if (this.isDisposed || !row.isConnected) return;
					worktree.replaceChildren(new Option(localize('sessions.environment.originalFolder', 'Original folder'), 'original'));
					choices.forEach(({ label, target }, index) => worktree.add(new Option(label, String(index), false, target.root === folder.worktree?.root)));
					if (!choices.length) error.textContent = localize('sessions.environment.noWorktrees', 'No worktrees are available for this folder.');
					worktree.onchange = () => { folder.worktree = choices[Number(worktree.value)]?.target; };
				});
				list.append(row);
			}
		};
		renderFolders();
		this._register(addDisposableListener(select, 'change', () => {
			host = undefined;
			connectionWorkspace.value = '';
			connectionField.hidden = !options.hosts[Number(select.value)]?.needsWorkspace;
			folders.length = 0;
			closeRecent();
			remotePathRow.hidden = true;
			renderFolders();
		}));

		const variableTitle = localize('sessions.environment.variables', 'Environment variables');
		const textarea = doc.createElement('textarea');
		textarea.rows = 9;
		textarea.spellcheck = false;
		textarea.placeholder = 'NODE_ENV=production';
		field(editor, variableTitle, textarea);
		const hint = doc.createElement('p');
		hint.textContent = localize('sessions.environment.variablesHint', 'Enter variables in .env format. They are available to commands in sessions started in this environment.');
		editor.append(hint);
		const switchPage = (editing: boolean) => {
			main.hidden = editing;
			editor.hidden = !editing;
			mainActions.hidden = editing;
			editorActions.hidden = !editing;
			error.textContent = '';
			this.dialog.updateMessage(editing ? variableTitle : this.title);
			if (editing) { textarea.value = variables; textarea.focus(); }
			else variableButton.focus();
		};
		const variableButton = button(main, variableTitle, () => switchPage(true));
		const mainActions = doc.createElement('div');
		const editorActions = doc.createElement('div');
		mainActions.className = editorActions.className = 'ash-environment-actions';
		editorActions.hidden = true;
		footer.append(mainActions, editorActions);
		const close = () => this.dispose();
		button(mainActions, localize('sessions.environment.cancel', 'Cancel'), close);
		button(mainActions, localize('sessions.environment.create', 'Create environment'), () => void run(async () => {
			if (!name.value.trim()) { name.focus(); throw new Error(localize('sessions.environment.nameRequired', 'Enter an environment name.')); }
			const current = await resolveHost();
			if (!current || this.isDisposed) return;
			await options.create(name.value.trim(), current.providerId, folders.map(folder => folder.worktree ?? folder.target), variables);
			close();
		}), true);
		button(editorActions, localize('sessions.environment.back', 'Back'), () => switchPage(false));
		button(editorActions, localize('sessions.environment.done', 'Done'), () => {
			const parsed = parseSessionEnvironment(textarea.value);
			if ('invalidLine' in parsed) {
				error.textContent = localize('sessions.environment.invalidVariable', 'Invalid .env entry on line {0}.', parsed.invalidLine);
				textarea.focus();
				return;
			}
			variables = textarea.value;
			switchPage(false);
			variableButton.label = variables.trim()
				? localize('sessions.environment.variablesConfigured', 'Environment variables · Configured')
				: variableTitle;
		}, true);
		this.dialog = this._register(new Dialog(container, this.title, [], {
			buttonStyles: defaultButtonStyles, checkboxStyles: defaultCheckboxStyles, inputBoxStyles: defaultInputBoxStyles,
			dialogStyles: defaultDialogStyles, disableDefaultAction: true, extraClasses: ['ash-new-environment-dialog'],
			renderBody: body => body.append(main, editor, error),
			renderFooter: element => element.append(footer),
		}));
	}

	async show(): Promise<void> { await this.dialog.show(); }
}
