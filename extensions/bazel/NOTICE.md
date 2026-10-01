# Third-party notices

The Starlark grammar, language configurations, and bazelrc grammar come from
[bazel-contrib/vscode-bazel](https://github.com/bazel-contrib/vscode-bazel/tree/c91b47dc73cde7a80e32e1846c6f33298c0a35fa)
revision `c91b47dc73cde7a80e32e1846c6f33298c0a35fa`.

The Bazel Authors distribute the extension assets under Apache-2.0, reproduced in
[third-party/bazel.LICENSE.txt](third-party/bazel.LICENSE.txt). The Starlark grammar
is derived from MagicStack's MagicPython and retains its MIT attribution in
[third-party/starlark.LICENSE.txt](third-party/starlark.LICENSE.txt).

Ash converts `syntaxes/bazelrc.tmLanguage.yaml` to JSON, and adds indentation-based
folding and Enter indentation for Starlark blocks to the language configuration.
The TextMate grammars are otherwise unchanged. These declarative resources ship
without the upstream extension's executable code.
