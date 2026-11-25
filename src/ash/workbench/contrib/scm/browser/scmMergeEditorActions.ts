import { Disposable, DisposableMap, toDisposable } from '../../../../base/common/lifecycle.js';
import type { IExtUri } from '../../../../base/common/resources.js';
import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../platform/contextkey/browser/contextKeyService.js';
import { RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import type { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { TextFileEditor } from '../../files/browser/editors/textFileEditor.js';
import { ISCMService, type ISCMRepository } from '../common/scm.js';
import { createScmMergeEditorInput } from './scmMergeEditorInput.js';

const activeGitFileHasConflict = new RawContextKey<boolean>('activeGitFileHasConflict', false);

function getActiveConflict(editors: IEditorService, scm: ISCMService, extUri: IExtUri) {
	const active = editors.activeEditor;
	if (!active || !(editors.activeEditorPane instanceof TextFileEditor)) return undefined;
	let owner: ISCMRepository | undefined;
	for (const repository of scm.repositories) {
		const { providerId, mergeProvider, rootUri } = repository.provider;
		if (providerId !== 'git' || !mergeProvider || !rootUri || !extUri.isEqualOrParent(active.resource, rootUri, true)) continue;
		if (!owner || rootUri.path.length > owner.provider.rootUri!.path.length) owner = repository;
	}
	const conflict = owner?.provider.groups.find(group => group.id === 'merge')?.resources.find(resource => extUri.isEqualIgnoringFragment(resource.sourceUri, active.resource));
	return owner && conflict ? { repositoryId: owner.id, path: conflict.path, resource: conflict.sourceUri } : undefined;
}

export class ScmMergeEditorContext extends Disposable {
	constructor(
		@IEditorService editors: IEditorService,
		@ISCMService scm: ISCMService,
		@IUriIdentityService identity: IUriIdentityService,
		@IContextKeyService contexts: IContextKeyService,
	) {
		super();
		const available = activeGitFileHasConflict.bindTo(contexts);
		this._register(toDisposable(() => available.reset()));
		const listeners = this._register(new DisposableMap<string>());
		const update = () => available.set(getActiveConflict(editors, scm, identity.extUri) !== undefined);
		const listen = (repository: ISCMRepository) => {
			if (repository.provider.providerId === 'git' && repository.provider.mergeProvider) {
				listeners.set(repository.id, repository.provider.onDidChangeResources(update));
			}
		};
		for (const repository of scm.repositories) listen(repository);
		this._register(scm.onDidAddRepository(repository => { listen(repository); update(); }));
		this._register(scm.onDidRemoveRepository(repository => { listeners.deleteAndDispose(repository.id); update(); }));
		this._register(editors.onDidActiveEditorChange(update));
		update();
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'workbench.scm.action.openMergeEditor',
			category: 'Git',
			title: localize2({ bundle: 'ash', key: 'mergeEditor.open' }, 'Resolve in Merge Editor'),
			precondition: activeGitFileHasConflict.isEqualTo(true),
			f1: true,
		});
	}

	public override async run(accessor: ServicesAccessor): Promise<void> {
		const editors = accessor.get(IEditorService);
		const conflict = getActiveConflict(editors, accessor.get(ISCMService), accessor.get(IUriIdentityService).extUri);
		if (conflict) {
			await editors.openEditor(createScmMergeEditorInput(conflict.repositoryId, conflict.path, conflict.resource), { pinned: true });
		}
	}
});
