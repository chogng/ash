import { StringSHA1 } from '../../../base/common/hash.js';
import { posix, win32 } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { URI } from '../../../base/common/uri.js';
import { ConfigurationScope, Extensions, type IConfigurationRegistry } from '../../configuration/common/configurationRegistry.js';
import { Registry } from '../../registry/common/platform.js';

export const projectMaterialFilesLocation = 'sessions.projects.localFilesLocation';
export const projectMaterialFilesChannel = 'projectMaterialFiles';
export const projectMaterialFilesScheme = 'ash-project-file';

Registry.as<IConfigurationRegistry>(Extensions.Configuration).registerConfiguration({
	key: projectMaterialFilesLocation,
	defaultValue: '',
	scope: ConfigurationScope.APPLICATION_MACHINE,
	parse(value: unknown): string {
		if (typeof value === 'string' && (value === '' || (!value.includes('\0') && (isWindows ? win32 : posix).isAbsolute(value)))) return value;
		throw new TypeError('Expected an absolute local folder path');
	},
});

export function projectMaterialFilesRoot(profile: URI, configured: string | undefined): URI {
	return configured ? URI.file(configured) : URI.joinPath(profile, 'Project Files');
}

export function projectMaterialFilesKey(...identity: string[]): string {
	const hash = new StringSHA1();
	hash.update(JSON.stringify(identity));
	return hash.digest();
}
