# Third-party notices

Ash Desktop directly distributes the following third-party components.
Release packaging must include this file and the referenced license and notice
texts.

| Component | Version | License used by Ash | License text |
| --- | --- | --- | --- |
| OpenAI Codex socket-security helpers | commit `dafb6781ee` | Apache-2.0 | [`LICENSE-APACHE`](../ash-rs/uds/LICENSE-APACHE), [`NOTICE`](../ash-rs/uds/NOTICE) |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.16 | Apache-2.0, selected from `MPL-2.0 OR Apache-2.0` | [`licenses/DOMPurify.txt`](licenses/DOMPurify.txt) |
| [Marked](https://github.com/markedjs/marked) | 18.0.14 | MIT and bundled Markdown notice | [`licenses/Marked.txt`](licenses/Marked.txt) |
| [Visual Studio Code](https://github.com/microsoft/vscode) editor source | commit `004a1fbb1658e61048b29d76e2ce380adfa18680` | MIT | [`third_party/vscode/LICENSE.txt`](../third_party/vscode/LICENSE.txt) |
| [Seti UI](https://github.com/jesseweed/seti-ui) | commit `2d6c5e68b4ded73c92dac291845ee44e1182d511` | MIT | [`src/ash/platform/theme/browser/media/seti/ThirdPartyNotices.txt`](src/ash/platform/theme/browser/media/seti/ThirdPartyNotices.txt) |
| [Typst](https://github.com/typst/typst) | 0.15.1 | Apache-2.0; includes separately attributed third-party material | [`Typst.txt`](../ash-rs/utils/typst/licenses/Typst.txt), [`Typst-NOTICE.txt`](../ash-rs/utils/typst/licenses/Typst-NOTICE.txt) |
| [typst-assets bundled fonts](https://github.com/typst/typst-assets) | 0.15.1 | Apache-2.0 plus the font and asset licenses enumerated upstream | [`Typst.txt`](../ash-rs/utils/typst/licenses/Typst.txt), [`Typst-Assets-NOTICE.txt`](../ash-rs/utils/typst/licenses/Typst-Assets-NOTICE.txt) |

The component-owned paths above are the canonical repository sources. Release packaging must copy their contents into the application license staging directory alongside this notice instead of maintaining duplicate source-controlled copies.

Transitive dependencies and third-party material distributed by Electron or
native runtimes remain governed by their own accompanying notices. Before a
release, the packaging pipeline must retain those upstream notices and verify
that this direct-dependency list still matches `app-ts/package.json` and the
Rust components linked into the shipped `ash` executable.
