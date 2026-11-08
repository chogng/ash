import { FuseState, FuseV1Options, FuseVersion, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { join } from 'node:path';

/** Apply release policy to Packager's private Electron copy before final signing. */
export async function disableElectronNodeInspector({ buildPath, platform }: { readonly buildPath: string; readonly platform: string; }, resetAdHocDarwinSignature = false): Promise<void> {
	const electron = join(buildPath, platform === 'darwin' ? 'Electron.app' : 'electron.exe');
	await flipFuses(electron, {
		version: FuseVersion.V1,
		resetAdHocDarwinSignature,
		[FuseV1Options.EnableNodeCliInspectArguments]: false,
	});
	const fuses = await getCurrentFuseWire(electron);
	if (fuses[FuseV1Options.EnableNodeCliInspectArguments] !== FuseState.DISABLE) {
		throw new Error('Packaged Electron must disable the Node CLI inspector');
	}
}
