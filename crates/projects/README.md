# `ash-projects`

1. `ProjectCoordinator` 通过版本化命令维护 Project 的长期元数据、多根目录表以及 Session 弱关联。
2. Project 根只保存已规范化的 Environment、Dir 和显示信息，不创建 Grant，也不改变活动 Session 或 Thread。
3. `ProjectStore` 负责完整记录与命令回执的原子持久化；目录解析、授权和工作协调由 App Server 负责。
