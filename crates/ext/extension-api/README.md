# Extension API

- 定义提示、上下文、Skill、工具、审核、MCP、生命周期和续跑贡献接口。
- 按扩展身份在原位置替换贡献，组合 registry 时共享同一份范围状态。
- Session/Thread/Turn 临时状态随 owner 退出清理；领域持久数据不存入此处。
- 工具生命周期通知来自已提交事实；续跑在提交锁之外通过领域 owner 接纳。
- 统一声明工具权限；扩展审核只提供建议，不能产生执行授权。
- 通过 `ExtensionItemStore` 保留有界的近期结果，供已授权 Thread 查询。

完整职责与接口见 [Agent 扩展](../../docs/extensions.md)，上下文预算与信任层级见 [Core Context](../../../docs/core-context.md)。
