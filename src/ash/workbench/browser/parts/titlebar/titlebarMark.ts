import './titlebarMark.css';
import { Lxicon } from '../../../../base/common/lxicons.js';
import { getLxiconDefinition, registerLxicon } from '../../../../base/common/lxiconsUtil.js';

export const ashTitlebarMark = registerLxicon('ash-titlebar-mark', getLxiconDefinition(Lxicon.ashMark.id)!);
