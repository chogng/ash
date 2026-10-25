# 扩展适用窗口核对

本表记录 2026-10-25 对全部 58 个产品扩展清单的核对：43 个 IDE、1 个 Agent Window、14 个通用。运行时的唯一声明来自各包 `package.json` 的 `ashUiTargets`，本表不参与推荐计算。测试用的旧清单保留缺省字段，以验证兼容行为。

按实际产品入口与消费者判断；Agent Window 中能够查看某种源码，不等于应向其推荐全部源码语言工具。Skill/MCP 在 IDE Chat 与 Agent Window 共用 Agent 能力，不能仅按技术类型标为 Agent Window 专用。窗口声明不替代平台、运行时、授权和其他功能前置条件。

| 扩展                                                                                | 适用窗口     | 核对依据                                                                                               |
| ----------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------ |
| [academy](../extensions/academy/package.json)                                       | 通用         | 两端的文档创建和 Docs 编辑入口共用 Academy 客户端。                                                    |
| [bat](../extensions/bat/package.json)                                               | IDE          | 提供 bat 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                            |
| [bazel](../extensions/bazel/package.json)                                           | IDE          | 提供 starlark, bazelrc 的语法、语言配置或编辑片段；主要入口是源码编辑器。                              |
| [clojure](../extensions/clojure/package.json)                                       | IDE          | 提供 clojure 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                        |
| [coffeescript](../extensions/coffeescript/package.json)                             | IDE          | 提供 coffeescript 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                   |
| [cpp](../extensions/cpp/package.json)                                               | IDE          | 提供 c, cpp 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                         |
| [csharp](../extensions/csharp/package.json)                                         | IDE          | 提供 csharp 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                         |
| [css](../extensions/css/package.json)                                               | IDE          | 提供 css, less, scss 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                |
| [dart](../extensions/dart/package.json)                                             | IDE          | 提供 dart 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                           |
| [debug-javascript](../extensions/debug-javascript/package.json)                     | IDE          | IDE JavaScript 调试适配器、断点与调试配置。                                                            |
| [debug-lldb](../extensions/debug-lldb/package.json)                                 | IDE          | IDE LLDB 调试适配器及调试配置。                                                                        |
| [debug-server-ready](../extensions/debug-server-ready/package.json)                 | IDE          | IDE 调试会话的 server-ready 行为；没有独立的 Agent Window 消费者。                                     |
| [dev-containers](../extensions/dev-containers/package.json)                         | Agent Window | 实际产品入口是 Agents: New Session in Dev Container；代码目录的 clients=code 指 TUI，不等于 IDE 窗口。 |
| [diff](../extensions/diff/package.json)                                             | IDE          | 提供 diff 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                           |
| [docker](../extensions/docker/package.json)                                         | IDE          | 提供 dockerfile 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                     |
| [dotenv](../extensions/dotenv/package.json)                                         | IDE          | 提供 dotenv 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                         |
| [git](../extensions/git/package.json)                                               | 通用         | IDE 源码管理与 Agent Window 的变更同步、提交及打开工作区差异调用同一扩展命令。                         |
| [git-base](../extensions/git-base/package.json)                                     | IDE          | 提供 git-commit, git-rebase, ignore 的语法、语言配置或编辑片段；主要入口是源码编辑器。                 |
| [github](../extensions/github/package.json)                                         | 通用         | IDE 的 Issue/PR 界面和 Agent Window 的 GitHub 列表、PR 创建均消费同一 API Provider。                   |
| [github-authentication](../extensions/github-authentication/package.json)           | 通用         | 两种窗口的账户选择与 GitHub API 使用 profile 级认证 Provider。                                         |
| [go](../extensions/go/package.json)                                                 | IDE          | 提供 go 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                             |
| [groovy](../extensions/groovy/package.json)                                         | IDE          | 提供 groovy 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                         |
| [html](../extensions/html/package.json)                                             | IDE          | 提供 html 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                           |
| [ini](../extensions/ini/package.json)                                               | IDE          | 提供 ini, properties 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                |
| [java](../extensions/java/package.json)                                             | IDE          | 提供 java 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                           |
| [javascript](../extensions/javascript/package.json)                                 | IDE          | 提供 javascriptreact, javascript, jsx-tags 的语法、语言配置或编辑片段；主要入口是源码编辑器。          |
| [json](../extensions/json/package.json)                                             | IDE          | 提供 json, jsonc, jsonl, snippets 的语法、语言配置或编辑片段；主要入口是源码编辑器。                   |
| [julia](../extensions/julia/package.json)                                           | IDE          | 提供 julia 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                          |
| [keymap-sublime](../extensions/keymap-sublime/package.json)                         | IDE          | 源码编辑器的多光标和行编辑键位。                                                                       |
| [language-pack-zh-cn](../extensions/language-pack-zh-cn/package.json)               | 通用         | 本地化目录同时包含 IDE 和 Sessions/Agent Window 的界面消息。                                           |
| [log](../extensions/log/package.json)                                               | IDE          | 提供 log 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                            |
| [lua](../extensions/lua/package.json)                                               | IDE          | 提供 lua 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                            |
| [make](../extensions/make/package.json)                                             | IDE          | 提供 makefile 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                       |
| [markdown-basics](../extensions/markdown-basics/package.json)                       | IDE          | 提供 markdown 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                       |
| [markdown-language-features](../extensions/markdown-language-features/package.json) | 通用         | Markdown 预览、文件链接及文档编辑可从两个窗口的资源编辑器打开。                                        |
| [markdown-math](../extensions/markdown-math/package.json)                           | 通用         | 聊天消息与 Markdown 预览共用 math.render.v2 公式渲染能力。                                             |
| [media-preview](../extensions/media-preview/package.json)                           | 通用         | 两端的资源编辑器均使用图片、音频和视频预览贡献。                                                       |
| [pdf-viewer](../extensions/pdf-viewer/package.json)                                 | 通用         | 两端的 PDF 资源打开与 PDF 编辑器请求共用同一客户端。                                                   |
| [perl](../extensions/perl/package.json)                                             | IDE          | 提供 perl 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                           |
| [php](../extensions/php/package.json)                                               | IDE          | 提供 php 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                            |
| [powershell](../extensions/powershell/package.json)                                 | IDE          | 提供 powershell 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                     |
| [python](../extensions/python/package.json)                                         | IDE          | 提供 python 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                         |
| [r](../extensions/r/package.json)                                                   | IDE          | 提供 r 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                              |
| [reference-manager](../extensions/reference-manager/package.json)                   | 通用         | 两端的资源库入口与 Academy 引用交互使用同一客户端。                                                    |
| [remote-ssh](../extensions/remote-ssh/package.json)                                 | 通用         | SSH 连接解析 Provider 面向保存的远程目标，不依赖源码编辑器；两端共用 Remote 连接机制。                 |
| [remote-workspace](../extensions/remote-workspace/package.json)                     | IDE          | SSH 配置文件的语法、语言配置与片段；区别于共享的 SSH 连接 Provider。                                   |
| [ruby](../extensions/ruby/package.json)                                             | IDE          | 提供 ruby 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                           |
| [rust](../extensions/rust/package.json)                                             | IDE          | Rust 源码语言贡献及 rust-analyzer 路由，服务 IDE 编辑工作流。                                          |
| [shellscript](../extensions/shellscript/package.json)                               | IDE          | 提供 shellscript 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                    |
| [snapshot](../extensions/snapshot/package.json)                                     | 通用         | IDE Chat 和 Agent Window 附件使用同一截图/图像编辑 Provider，亦支持独立截图。                          |
| [sql](../extensions/sql/package.json)                                               | IDE          | 提供 sql 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                            |
| [swift](../extensions/swift/package.json)                                           | IDE          | 提供 swift 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                          |
| [theme-defaults](../extensions/theme-defaults/package.json)                         | 通用         | 颜色主题作用于整个 Workbench，两种窗口都消费主题设置。                                                 |
| [theme-seti](../extensions/theme-seti/package.json)                                 | 通用         | 文件图标主题用于两端的资源和文件标签。                                                                 |
| [toml](../extensions/toml/package.json)                                             | IDE          | 提供 toml 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                           |
| [typescript-basics](../extensions/typescript-basics/package.json)                   | IDE          | 提供 typescript, typescriptreact, jsonc, json 的语法、语言配置或编辑片段；主要入口是源码编辑器。       |
| [xml](../extensions/xml/package.json)                                               | IDE          | 提供 xml, xsl, dtd 的语法、语言配置或编辑片段；主要入口是源码编辑器。                                  |
| [yaml](../extensions/yaml/package.json)                                             | IDE          | 提供 dockercompose, yaml 的语法、语言配置或编辑片段；主要入口是源码编辑器。                            |
