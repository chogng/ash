# ash-utils-template

`ash-utils-template` 负责提示词和文本资源中的严格字符串插值：

1. `Template::parse` 解析 `{{ name }}`，并用 `{{{{`、`}}}}` 表达字面量分隔符；空占位符、嵌套占位符和未闭合分隔符会直接失败；
2. `Template::render` 可复用已解析模板，`render` 用于单次调用；缺失、重复或模板未声明的变量都会直接失败，变量值按原文插入且不会再次解析；
3. crate 只拥有字符串模板语法和校验，不负责提示词版本、变量转义或模型输入组装；修改解析或渲染规则时运行 `just test ash-utils-template` 和 `bazel test //crates/utils/template:template-unit-tests`。
