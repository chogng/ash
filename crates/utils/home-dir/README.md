# `ash-utils-home-dir`

- 统一解析运行当前进程的机器上的 Ash 用户数据根：`ASH_HOME` 或用户目录下的 `.ash`。
- 校验绝对目录路径，解析已有目录的符号链接；缺失的末级目录可以保留，由数据所属模块创建。
- 为 CLI、App Server、daemon、Remote 和图形产品隔离路径解析能力与依赖。
- 不创建目录，不读取用户指令、配置、凭据或数据库，不管理安装资源和后台进程。

Rust 调用方使用 `ash_utils_home_dir::find_ash_home()`；显式资源根使用 `ash_utils_home_dir::resolve_path()`。返回值为
`io::Result<PathBuf>`，空值、相对路径、普通文件、悬空链接和不可访问的祖先均报错。
未设置 `ASH_HOME` 且无法确定用户目录时直接报错，不使用当前工作目录。

Electron 在 `platform/home/node/home.ts` 使用相同规则。两个实现的测试覆盖显式与默认路径、
新目录、目录别名、无效输入和旧变量冲突。根路径在进程启动边界解析，再显式传给子进程。
本机界面资源留在本机 home；远端服务解析远端机器自己的 home，SSH 不转发本机 `ASH_HOME`。

## 迁移

- 原来使用默认 `~/.ash` 的本机用户无需移动数据。
- `ASH_PROFILE_ROOT` 已退场。把启动环境中的变量名改为 `ASH_HOME`，保持原绝对路径，
  然后删除旧变量。两个变量同时存在也报错，不设置隐含优先级。
- Remote 不再自动选择平台专属 `remote-server` 目录。发现旧目录而没有显式 `ASH_HOME` 时，
  启动报错并给出旧路径。可以在远端启动环境中把该路径设置为 `ASH_HOME`，继续使用原数据。
- 若要把旧 Remote 数据搬到默认 `~/.ash`，先停止使用两个目录的全部 Ash 服务，再迁移。
  目标已有数据时须先备份并按各数据所属模块处理冲突；不能合并数据库、凭据或插件状态文件。
  完成后移除旧目录，正常运行只读取选定的 home。

`profile_root` 仍可作为现有领域接口的参数名，含义是已选定的数据根；不增加隐含的
`profiles/default` 目录。安装包位置由 `install-context` 管理，socket 位置与身份校验由 daemon
及 `uds` 管理。统一 home 不改变 Remote broker 当前按目录建立进程的行为。

## 验证

```text
just test ash-utils-home-dir
just check ash-utils-home-dir
just rust-warnings ash-utils-home-dir
```
