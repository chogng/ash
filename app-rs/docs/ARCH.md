actionlist > vertical actionbar > actionviewitem : icon | title | description/keybinding
   
toolbar > actionbar > actionviewitem
actionbar 接 action, actionviewitem 渲染 action 为按钮, actionrunner 执行 action

menu > action-menu-item : menu-item-check | action-label | keybinding
                         // 左侧勾选图标    // 菜单文本     // 快捷键

radiogroup > radio > button
mode switcher > radiogroup
editor tabs > radiogroup

item dirs preview > contextview > session name/status + actionlist
session rename > contextview > inputbox

button | buttonwithdropdown // 复合按钮

- 具体样式交给当前文件负责，而不是基座，基座只提供能力
