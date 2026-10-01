# Extension grammar provenance

The language declarations, configurations, and TextMate grammars are derived from
the sibling VS Code source tree at `extensions/git-base`. Grammar source revisions
remain recorded in the copied grammar files. These resources use the MIT license
reproduced in [`third_party/vscode/LICENSE.txt`](../../third_party/vscode/LICENSE.txt)
and ship without the upstream extension's executable code.

Ash adds the `gitignore` alias and standard Git exclude paths, highlights negation,
wildcards, character classes, escapes and directory separators, and limits ignore
editing configuration to its supported line-comment syntax.
Rebase `exec` entries use a line-bounded Shell region so command highlighting works
and unfinished Shell strings cannot consume subsequent rebase instructions.
