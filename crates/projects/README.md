# `ash-projects`

1. `ProjectCoordinator` 通过版本化命令维护 Project 的长期元数据、多根目录表、文件／文件夹资料引用以及 Session 弱关联。
2. Project 根只保存已规范化的 Environment、Dir 和显示信息，不创建 Grant，也不改变活动 Session 或 Thread。
3. `ProjectStore` 负责完整记录与命令回执的原子持久化；目录解析、授权和工作协调由 App Server 负责。
4. 归档后的 Project 可恢复；删除留下不可恢复的版本化墓碑，并清除目录、资料和 Session 引用。目录与读取 API 不返回已删除项目，重复删除命令仍返回原回执。删除不移除源文件或关联 Session。

资料引用只保存名称、文件／文件夹类型和规范化绝对路径，支持任意文件格式，不复制源文件、不授予访问权限。旧记录缺失 materials 时按空列表读取；更新详情省略 materials 时保留原引用，显式空列表清空引用。
