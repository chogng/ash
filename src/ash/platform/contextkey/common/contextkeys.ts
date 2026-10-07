import { isLinux, isMacintosh, isNative, isWeb, isWindows } from '../../../base/common/platform.js';
import { RawContextKey } from './contextkey.js';

/** Stable platform facts available to commands, menus, and keybindings. */
export const IsWindowsContext = new RawContextKey<boolean>('isWindows', isWindows);
export const IsMacContext = new RawContextKey<boolean>('isMac', isMacintosh);
export const IsLinuxContext = new RawContextKey<boolean>('isLinux', isLinux);
export const IsWebContext = new RawContextKey<boolean>('isWeb', isWeb);
export const IsNativeContext = new RawContextKey<boolean>('isNative', isNative);
