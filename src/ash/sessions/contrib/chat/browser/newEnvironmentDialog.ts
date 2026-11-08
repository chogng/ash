import { parseSessionEnvironment } from '../../../services/sessions/common/sessionEnvironment.js';
import './media/newEnvironmentDialog.css';
import { addDisposableListener, h } from '../../../../base/browser/dom.js';
import { observeResize } from '../../../../base/browser/observer.js';
import { Button, type ButtonPresentation } from '../../../../base/browser/ui/button/button.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { appendIcon } from '../../../../base/browser/ui/lxicons/lxicon.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { localize } from '../../../../nls.js';
import { ActionListItemKind, type IActionListItem } from '../../../../platform/actionWidget/browser/actionList.js';
import type { IActionWidgetService } from '../../../../platform/actionWidget/browser/actionWidget.js';
import { ActionWidgetDropdown } from '../../../../platform/actionWidget/browser/actionWidgetDropdown.js';
import { defaultButtonStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { createWorkbenchDialogOptions } from '../../../../workbench/browser/parts/dialogs/dialog.js';
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
	readonly initialFolders: readonly SessionExecutionTarget[];
	readonly browse: (source: SessionExecutionTarget | undefined) => Promise<readonly SessionExecutionTarget[]>;
	readonly recent: (source: SessionExecutionTarget | undefined) => Promise<readonly SessionExecutionTarget[]>;
	readonly worktrees: (providerId: string, target: SessionExecutionTarget) => Promise<readonly { readonly label: string; readonly target: SessionExecutionTarget; }[]>;
	readonly create: (name: string, providerId: string, folders: readonly EnvironmentFolder[], variables: string) => Promise<void>;
}

export class NewEnvironmentDialog extends Disposable {
	private readonly dialog: Dialog;
	readonly appendHost: (host: EnvironmentHost) => void;
	private readonly title = localize('sessions.environment.newEnvironment', 'New Environment');

	constructor(container: HTMLElement, options: EnvironmentDialogOptions, menus: IActionWidgetService) {
		super();
		const doc = container.ownerDocument;
		const folders: EnvironmentFolder[] = options.initialFolders.map(target => ({ target }));
		let variables = '';
		let busy = false;
		let host: Awaited<ReturnType<EnvironmentHost['resolve']>>;
		const main = doc.createElement('div');
		const editor = doc.createElement('div');
		const footer = doc.createElement('div');
		const error = doc.createElement('div');
		error.setAttribute('role', 'alert');
		main.className = editor.className = 'ash-environment-fields';
		editor.hidden = true;

		const field = (parent: HTMLElement, text: string, input: HTMLElement) => {
			const label = doc.createElement('label');
			label.className = 'ash-environment-field';
			label.append(text, input);
			parent.append(label);
		};
		const button = (parent: HTMLElement, label: string, run: () => void, presentation: ButtonPresentation = 'secondary') => this._register(new Button(parent, {
			...defaultButtonStyles, label, presentation, onClick: run,
		}));
		const menuField = <T>(parent: HTMLElement, lifetime: DisposableStore, ariaLabel: string, label: string,
			load: () => readonly IActionListItem<T>[], select: (value: T) => void, popupWidth?: 'trigger',
		) => {
			const dropdown: ActionWidgetDropdown = lifetime.add(new ActionWidgetDropdown(parent, {
				label, ariaLabel,
				buttonOptions: { presentation: 'secondary', size: 'standard' },
				labelRenderer: element => {
					appendIcon(Lxicon.chevronDown, element);
					return null;
				},
				onOpen: () => dropdown.showItems({ load, select, restoreFocusOnSelect: true }),
				onShow: popupWidth === 'trigger' ? menu => {
					const trigger = dropdown.element;
					const syncWidth = () => {
						const width = `${trigger.getBoundingClientRect().width}px`;
						menu.style.minInlineSize = width;
						menu.style.maxInlineSize = width;
					};
					syncWidth();
					return observeResize(trigger, syncWidth, { box: 'border-box' });
				} : undefined,
				tabLeavesPopup: true,
				listOptions: { ariaLabel, menuIconPlacement: 'trailing' },
			}, menus));
			dropdown.element.classList.add('ash-environment-menu-field');
			dropdown.element.setAttribute('aria-description', label);
			return dropdown;
		};
		const updateMenuLabel = (dropdown: ActionWidgetDropdown, label: string) => {
			dropdown.setLabel(label);
			dropdown.element.setAttribute('aria-description', label);
		};
		const run = async (action: () => Promise<void>) => {
			if (busy) return;
			busy = true;
			error.textContent = '';
			footer.setAttribute('aria-busy', 'true');
			hostMenu.setEnabled(false);
			connectionWorkspace.disabled = true;
			try { await action(); }
			catch (failure) {
				if (!this.isDisposed) error.textContent = failure instanceof Error ? failure.message : String(failure);
			} finally {
				busy = false;
				footer.removeAttribute('aria-busy');
				hostMenu.setEnabled(hosts.length > 0);
				connectionWorkspace.disabled = false;
			}
		};

		const name = doc.createElement('input');
		name.value = folders[0]?.target.root.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
		field(main, localize('sessions.environment.name', 'Name'), name);
		const hosts = [...options.hosts];
		let selectedHost = options.selected;
		const runIn = localize('sessions.environment.runIn', 'Run in');
		const hostUnavailable = localize('sessions.environment.unavailable', 'Host unavailable');
		const hostGroups = [
			{ id: 'local', label: localize('sessions.environment.localGroup', 'Local') },
			{ id: 'remote', label: localize('sessions.environment.remote', 'Remote') },
		];
		const cloudLabel = localize('sessions.environment.cloudUnavailable', 'Cloud (unavailable)');
		const hostField = h(doc, 'div', { className: 'ash-environment-field' }, h(doc, 'span', runIn));
		main.append(hostField);
		const hostMenu = menuField<number>(hostField, this._store, runIn, hosts[selectedHost]?.label ?? hostUnavailable, () => {
			const items: IActionListItem<number>[] = [];
			for (const group of hostGroups) {
				items.push({ kind: ActionListItemKind.Header, label: group.label });
				hosts.forEach((candidate, index) => {
					if (candidate.group === group.id) {
						items.push({ kind: ActionListItemKind.Action, label: candidate.label, item: index, checked: index === selectedHost });
					}
				});
			}
			items.push({ kind: ActionListItemKind.Separator, label: '' }, { kind: ActionListItemKind.Action, label: cloudLabel, disabled: true });
			return items;
		}, index => {
			if (index === selectedHost) return;
			selectedHost = index;
			const target = hosts[index];
			updateMenuLabel(hostMenu, target.label);
			host = undefined;
			connectionWorkspace.value = '';
			connectionField.hidden = !target.needsWorkspace;
			folders.length = 0;
			closeRecent();
			remotePathRow.hidden = true;
			renderFolders();
		}, 'trigger');
		this.appendHost = host => {
			hosts.push(host);
			if (hosts.length === 1) {
				updateMenuLabel(hostMenu, host.label);
				connectionField.hidden = !host.needsWorkspace;
			}
			hostMenu.setEnabled(!busy);
		};
		hostMenu.setEnabled(hosts.length > 0);
		const connectionWorkspace = doc.createElement('input');
		connectionWorkspace.placeholder = '/home/user/project';
		field(main, localize('sessions.environment.workspacePath', 'Absolute workspace path'), connectionWorkspace);
		const connectionField = connectionWorkspace.parentElement!;
		connectionField.hidden = !hosts[selectedHost]?.needsWorkspace;
		const resolveHost = async () => {
			const target = hosts[selectedHost];
			if (!target) throw new Error(hostUnavailable);
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
		list.className = 'ash-environment-folders';
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
		}), 'quiet');
		addButton.domNode.setAttribute('aria-expanded', 'false');
		const closeRecent = () => {
			recent.hidden = true;
			addButton.domNode.setAttribute('aria-expanded', 'false');
		};
		const chooseFolder = () => void run(async () => {
			closeRecent();
			if (host?.source && host.source.type !== 'local') {
				remotePathRow.hidden = false;
				remotePath.defaultValue = host.source.root;
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
				choice.className = 'ash-button ash-button-quiet ash-button-small';
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
		main.append(h(doc, 'div', { className: 'ash-environment-folder-section' }, folderHeader, recent, remotePathRow, list));
		const folderMenus = this._register(new DisposableStore());
		const originalFolder = localize('sessions.environment.originalFolder', 'Original folder');
		const chooseWorktree = localize('sessions.environment.chooseWorktree', 'Choose Worktree…');
		const renderFolders = () => {
			folderMenus.clear();
			list.replaceChildren();
			for (const folder of folders) {
				const row = doc.createElement('div');
				row.className = 'ash-environment-row ash-environment-folder';
				appendIcon(Lxicon.folder, row);
				const path = h(doc, 'span', { className: 'ash-environment-folder-name' });
				path.textContent = folder.target.root.split(/[\\/]/).filter(Boolean).at(-1) ?? folder.target.root;
				path.title = folder.target.root;
				row.append(path);
				let choices: Awaited<ReturnType<EnvironmentDialogOptions['worktrees']>> = [];
				const worktreeLabel = () => choices.find(({ target }) => target.root === folder.worktree?.root)?.label ?? folder.worktree?.root ?? originalFolder;
				const worktree = menuField<SessionExecutionTarget | 'original' | 'choose'>(row, folderMenus,
					localize('sessions.environment.folderWorktree', 'Worktree for {0}', folder.target.root), worktreeLabel(), () => [
						{ kind: ActionListItemKind.Action, label: originalFolder, item: 'original', checked: !folder.worktree },
						...choices.map(({ label, target }) => ({ kind: ActionListItemKind.Action, label, item: target, checked: target.root === folder.worktree?.root } as const)),
						...(!choices.length ? [{ kind: ActionListItemKind.Action, label: chooseWorktree, item: 'choose' } as const] : []),
					], value => {
						if (value !== 'choose') {
							folder.worktree = value === 'original' ? undefined : value;
							updateMenuLabel(worktree, worktreeLabel());
							return;
						}
						void run(async () => {
							const current = await resolveHost();
							if (!current || this.isDisposed || !row.isConnected) return;
							const available = await options.worktrees(current.providerId, folder.target);
							if (this.isDisposed || !row.isConnected) return;
							choices = available;
							updateMenuLabel(worktree, worktreeLabel());
							if (!choices.length) error.textContent = localize('sessions.environment.noWorktrees', 'No worktrees are available for this folder.');
						});
					});
				const remove = doc.createElement('button');
				remove.type = 'button';
				remove.className = 'ash-button ash-button-quiet ash-button-small';
				remove.textContent = localize('sessions.environment.removeFolder', 'Remove');
				remove.setAttribute('aria-label', localize('sessions.environment.removeNamedFolder', 'Remove {0}', folder.target.root));
				remove.onclick = () => {
					folders.splice(folders.indexOf(folder), 1);
					renderFolders();
					addButton.focus();
				};
				row.append(remove);
				list.append(row);
			}
		};
		renderFolders();

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
		const variableButton = h(doc, 'button', {
			className: 'ash-button ash-button-quiet ash-environment-variables',
			attributes: { type: 'button', 'aria-label': variableTitle },
		});
		const variableLabels = h(doc, 'span');
		const noVariables = localize('sessions.environment.noVariables', 'None for this environment');
		const variableStatus = h(doc, 'span', { className: 'ash-environment-variables-status' }, noVariables);
		variableLabels.append(h(doc, 'span', variableTitle), variableStatus);
		variableButton.append(variableLabels);
		appendIcon(Lxicon.chevronRight, variableButton);
		main.append(variableButton);
		this._register(addDisposableListener(variableButton, 'click', () => switchPage(true)));
		const mainActions = doc.createElement('div');
		const editorActions = doc.createElement('div');
		mainActions.className = editorActions.className = 'ash-sessions-form-actions';
		editorActions.hidden = true;
		footer.append(mainActions, editorActions);
		const close = () => this.dispose();
		button(mainActions, localize('sessions.environment.cancel', 'Cancel'), () => void this.dialog.requestClose());
		button(mainActions, localize('sessions.environment.create', 'Create environment'), () => void run(async () => {
			if (!name.value.trim()) { name.focus(); throw new Error(localize('sessions.environment.nameRequired', 'Enter an environment name.')); }
			const current = await resolveHost();
			if (!current || this.isDisposed) return;
			await options.create(name.value.trim(), current.providerId, folders, variables);
			close();
		}), 'primary');
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
			const label = variables.trim() ? localize('sessions.environment.variablesConfigured', 'Configured') : noVariables;
			variableStatus.textContent = label;
			variableButton.setAttribute('aria-description', label);
		}, 'primary');
		variableButton.setAttribute('aria-description', noVariables);
		const draft = () => JSON.stringify({
			name: name.value,
			selectedHost,
			workspace: connectionWorkspace.value,
			folders,
			variables: editor.hidden ? variables : textarea.value,
			pendingFolder: !remotePathRow.hidden && remotePath.value !== remotePath.defaultValue ? remotePath.value : undefined,
		});
		const initialDraft = draft();
		const dialogOptions = createWorkbenchDialogOptions({
			extraClasses: ['ash-new-environment-dialog'],
			layout: 'form',
			modal: false,
			closeOnBackdropClick: true,
			disableDefaultAction: true,
			canClose: () => !busy,
			shouldConfirmDiscard: () => draft() !== initialDraft,
			renderBody: body => body.append(main, editor, error),
			renderFooter: element => element.append(footer),
		});
		this.dialog = this._register(new Dialog(container, this.title, [], dialogOptions));
	}

	async show(): Promise<void> { await this.dialog.show(); }
}
