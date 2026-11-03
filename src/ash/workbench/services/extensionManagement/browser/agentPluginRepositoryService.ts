import { canceled } from '../../../../base/common/errors.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { FileKind, type IFileService } from '../../../../platform/files/common/files.js';
import type { ILocalGitService } from '../../../../platform/git/common/localGitService.js';
import type { ILogService } from '../../../../platform/log/common/log.js';
import { getRemoteWorkspacePath, isRemoteResource } from '../../../../platform/remote/common/remote.js';
import type { IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';
import type { PluginInstallation } from '../../../../platform/extensionManagement/common/pluginManagementService.js';

/** Stages only package files and passes the captured checkout identity to the package authority. */
export async function installAgentPluginFromRepository(
	request: {
		readonly folder: IWorkspaceFolder;
		readonly url: string;
		readonly reference: string | undefined;
		readonly packagePath: string;
		readonly signal: AbortSignal;
	},
	git: ILocalGitService,
	files: IFileService,
	log: ILogService,
	install: (packageName: string, operationId: string) => Promise<PluginInstallation>,
): Promise<PluginInstallation> {
	const { folder, url, reference, packagePath, signal } = request;
	// Validate the user-entered package path before joining it to any host resource.
	const parts = packagePath === '' || packagePath === '.' ? [] : packagePath.split('/');
	if (parts.some(part => !/^[a-zA-Z0-9._-]+$/.test(part) || part === '.' || part === '..' || part.toLowerCase() === '.git')) {
		throw new Error(localize({ bundle: 'ash.extensions', key: 'invalidGitPackagePath' }, 'Enter a package path within the repository, using forward slashes.'));
	}
	const operationId = crypto.randomUUID();
	const checkoutName = `ash-plugin-checkout-${operationId}`;
	const packageName = `ash-plugin-package-${operationId}`;
	const checkout = URI.joinPath(folder.uri, checkoutName);
	const staging = URI.joinPath(folder.uri, packageName);
	const targetPath = isRemoteResource(checkout) ? getRemoteWorkspacePath(checkout) : checkout.fsPath;
	if (signal.aborted) { throw canceled(); }
	const cancel = () => { void git.cancel(operationId).catch(() => undefined); };
	signal.addEventListener('abort', cancel, { once: true });
	try {
		await git.clone(operationId, url, targetPath, reference);
	} finally {
		signal.removeEventListener('abort', cancel);
	}
	if (signal.aborted) { throw canceled(); }
	let source = checkout;
	for (const part of parts) {
		source = URI.joinPath(source, part);
		if ((await files.stat(source)).kind !== FileKind.Directory) {
			throw new Error(localize({ bundle: 'ash.extensions', key: 'unsafeGitPackageEntry' }, 'The package contains a symbolic link or unsupported file: {0}', part));
		}
	}
	await files.createDirectory(staging);
	try {
		// Git configuration, credentials and hooks are checkout metadata, never package bytes.
		await copyGitPackage(files, source, staging, signal);
		if (signal.aborted) { throw canceled(); }
		const installed = await install(packageName, operationId);
		await removeGitStaging(files, log, checkout);
		return installed;
	} finally {
		await removeGitStaging(files, log, staging);
	}
}

async function copyGitPackage(files: IFileService, source: URI, destination: URI, signal: AbortSignal): Promise<void> {
	for (const entry of await files.readDirectory(source)) {
		if (signal.aborted) { throw canceled(); }
		if (entry.name.toLowerCase() === '.git') { continue; }
		const target = URI.joinPath(destination, entry.name);
		if (entry.kind === FileKind.Directory) {
			await files.createDirectory(target);
			await copyGitPackage(files, entry.resource, target, signal);
		} else if (entry.kind === FileKind.File) {
			await files.copy(entry.resource, target);
		} else {
			throw new Error(localize({ bundle: 'ash.extensions', key: 'unsafeGitPackageEntry' }, 'The package contains a symbolic link or unsupported file: {0}', entry.name));
		}
	}
}

async function removeGitStaging(files: IFileService, log: ILogService, resource: URI): Promise<void> {
	try {
		await files.delete(resource, 'ignore', 'recursive');
	} catch (error) {
		// Cleanup failure cannot turn an already committed installation into an apparent failure.
		log.warn('extensions', 'Unable to remove Git installation staging', error);
	}
}
