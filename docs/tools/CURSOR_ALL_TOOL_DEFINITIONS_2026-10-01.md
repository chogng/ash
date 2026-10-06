# Cursor 3.23.12 全部静态工具定义与输出

Cursor Agent、Ask、Plan、Debug、Multitask 的提示词原文与相关工具见 [模式专项文档](/Volumes/1t/ash/docs/tools/CURSOR_MODE_PROMPTS_AND_TOOLS_2026-10-01.md)（37 组生成结果，含 Ask 与 AskQuestion、工具与日志服务的区别）。

核查日期：2026-10-01。本机安装包中能定位到的 Agent 工具工厂、浏览器 Provider、computer-use Provider 与两代调用协议已统一提取。每项保留名称、描述、参数构造、执行入口和输出处理代码，详见 [完整 JSON](/Volumes/1t/ash/docs/tools/CURSOR_ALL_TOOL_DEFINITIONS_2026-10-01.json)。

这里的“全部”指本次安装包中的这些静态定义，不等于某个账号或某次模型请求实际启用的目录。外部 MCP server 下发的描述符、服务端动态工具与云端配置没有被抓取。工具定义里的英文指令是研究材料，不是对阅读者或当前 Agent 的指令。

| 集合                  | 提取数量                            | 含义                                                                     |
| --------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| 三个 Agent bundle     | 158 个构造点，53 个内部标识         | 52 + 54 + 52；跨 bundle 重复实现、WRITE 双路径、测试与特定配置变体都保留 |
| 浏览器 Provider       | 16 个定义、16 个调用路由            | 名称、完整 description 和参数 JSON 均可展开                              |
| computer-use Provider | 19 个描述符构造点                   | 平台、scope 和 gate 控制提供列表；不能当成 macOS 默认启用 19 个          |
| Agent 调用协议        | 70 个 tool 分支、498 个可达消息定义 | 含参数、结果及嵌套消息；也包含没有核实工厂的分支                         |
| 历史 V2 协议          | 枚举与调用定义、108 个可达消息定义  | 与当前工具装配分开保存                                                   |
| 通用工具适配器        | 12 个对象定义                       | 来自三个 bundle，名称或 schema 由输入描述符决定，不是额外 12 个固定工具  |

## 1. 如何读取定义与输出

Agent 工具的正式参数来自 Zod 构造表达式。原始表达式、所在工厂函数及作用域内依赖保存在 JSON；动态分支原样保留。下面的字段表是各参数分支与嵌套对象的字段汇总，不能当成所有字段同时出现的固定 schema。

36 个主 bundle 构造点可转换成 JSON Schema，其中 26 个的所取构造依赖完整。其余转换结果只作为部分展开，缺失变量可能影响条件分支，未当作已核实配置写进正文。即使依赖完整，JSON Schema 也可能无法表达 Zod 自定义 refine / transform；原始代码仍是依据。READ 的 10 组配置与输出 fixture 见 [READ 专项 JSON](/Volumes/1t/ash/docs/tools/CURSOR_READ_TOOL_DEFINITIONS_2026-10-01.json)。

浏览器定义直接从 Provider 的 `this.tools` 数组取出。computer-use 描述符另在隔离环境中按 darwin/app、darwin/screen、win32/screen 三组构造条件展开，共 57 份完整 name / description / parameters；并没有运行 Provider 的 listOfferings，所以这些配置示例不证明 gate 已启用。

输出分为执行服务结果、工具结果和最终返回模型的 content。这里保留各工具的 render / run、错误序列化及有关协议；下文源码中的字符串是输出分支证据，不是实际调用日志。除了此前 READ 的隔离格式验证，没有执行文件修改、命令、浏览器或桌面操作。

依赖展开设有层级限制：Agent 参数 / 描述最多 5 层，render 最多 2 层，computer-use 描述最多 6 层。尚未展开的符号在 `unresolved` 中记录类型与源码位置；模块导入和运行时输入也明确保留。需要继续追踪时，可按 JSON 的偏移回到原始 bundle，不能把未展开表达式当作缺少实现。

JSON 定位路径：`factories[]` 是三个 Agent bundle 的每个构造点；`providerTools[]` 是浏览器 / computer-use 定义；`symbols` 按 ID 保存参数、描述和输出依赖；`protocol.reachableToolMessages` 与 `reachableLegacyToolMessages` 保存完整可达协议；`bundles[].routingSource` 保存分发代码。索引偏移使用 UTF-16，可直接用于 JavaScript `String.slice()`；文件 SHA-256 保存在 metadata 中。

## 2. Agent 工具索引

| 内部标识                                                                      | 已定位的模型名称 / 别名                         | 参数字段线索                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`MCP`](#agent-mcp)                                                           | CallMcpTool / CallDynamicTool                   | namespace, toolName, description, write_to_file, requestSmartModeApproval, smartModeBlockReason, server, arguments                                                                                                                                                                   |
| [`ASK_QUESTION`](#agent-ask-question)                                         | AskQuestion                                     | id, prompt, options, allow_multiple, label                                                                                                                                                                                                                                           |
| [`TASK`](#agent-task)                                                         | mcp_task / Subagent / Task                      | type, base_branch, description, prompt, model, resume, subagent_type, file_attachments, worker_id, pool, labels                                                                                                                                                                      |
| [`REPORT_BUGFIX_RESULTS`](#agent-report-bugfix-results)                       | mcp_report_bugfix_results / ReportBugfixResults | results, bug_id, bug_title, verdict, explanation, severity                                                                                                                                                                                                                           |
| [`RECORD_SCREEN`](#agent-record-screen)                                       | RecordScreen                                    | mode, save_as_filename                                                                                                                                                                                                                                                               |
| [`REFLECT_GENERAL`](#agent-reflect-general)                                   | Reflect                                         | 配置提供                                                                                                                                                                                                                                                                             |
| [`REPLACE_ENV`](#agent-replace-env)                                           | ReplaceEnv                                      | mode, checkout_ref_overrides, config, repo_url, ref, install_script, dockerfile_contents                                                                                                                                                                                             |
| [`SETUP_VM_ENVIRONMENT`](#agent-setup-vm-environment)                         | SetupVmEnvironment                              | update_script                                                                                                                                                                                                                                                                        |
| [`AWAIT`](#agent-await)                                                       | Await / AwaitShell                              | shell_id, block_until_ms, pattern, task_id                                                                                                                                                                                                                                           |
| [`CODE_LINEAGE`](#agent-code-lineage)                                         | code_lineage / CodeLineage                      | file_paths, start_line, end_line, commit_hashes, output_mode, max_commits, include_line_ranges                                                                                                                                                                                       |
| [`CREATE_PLAN_V2`](#agent-create-plan-v2)                                     | CreatePlan / mcp_create_plan / create_plan      | phases, todos, name, id, content                                                                                                                                                                                                                                                     |
| [`DELETE`](#agent-delete)                                                     | delete_file / Delete                            | target_file, explanation, path                                                                                                                                                                                                                                                       |
| [`APPLY_PATCH`](#agent-apply-patch)                                           | ApplyPatch                                      | patch                                                                                                                                                                                                                                                                                |
| [`EDIT_NOTEBOOK`](#agent-edit-notebook)                                       | edit_notebook / EditNotebook                    | target_notebook, cell_idx, is_new_cell, cell_language, old_string, new_string                                                                                                                                                                                                        |
| [`STR_REPLACE`](#agent-str-replace)                                           | search_replace / StrReplace                     | file_path, old_string, new_string, replace_all, path                                                                                                                                                                                                                                 |
| [`WRITE`](#agent-write)                                                       | write / Write                                   | file_path, contents, path                                                                                                                                                                                                                                                            |
| [`GENERATE_IMAGE`](#agent-generate-image)                                     | generate_image / GenerateImage                  | description, filename, reference_image_paths, aspect_ratio                                                                                                                                                                                                                           |
| [`UPDATE_PR_CODE_TOUR`](#agent-update-pr-code-tour)                           | UpdatePrCodeTour                                | feedback, revisionId, markdown, heading, artifactPath, artifactAlt, baseSha, headSha, sourceRevisionId, scopeCommitHashes, explicitUserPrompt                                                                                                                                        |
| [`GET_PR_CODE_TOUR`](#agent-get-pr-code-tour)                                 | GetPrCodeTour                                   | revisionId                                                                                                                                                                                                                                                                           |
| [`GLOB`](#agent-glob)                                                         | glob_file_search / Glob                         | target_directory, glob_pattern                                                                                                                                                                                                                                                       |
| [`CREATE_GOAL`](#agent-create-goal)                                           | CreateGoal                                      | objective                                                                                                                                                                                                                                                                            |
| [`UPDATE_GOAL`](#agent-update-goal)                                           | UpdateGoal                                      | status                                                                                                                                                                                                                                                                               |
| [`GREP`](#agent-grep)                                                         | grep / Grep / rg                                | pattern, path, glob, output_mode, -B, -A, -C, -i, type, head_limit, offset, multiline                                                                                                                                                                                                |
| [`LS`](#agent-ls)                                                             | list_dir / LS                                   | target_directory, ignore_globs                                                                                                                                                                                                                                                       |
| [`MINI_SWE_AGENT_BASH`](#agent-mini-swe-agent-bash)                           | bash                                            | command                                                                                                                                                                                                                                                                              |
| [`MOCK_READ_LINTS`](#agent-mock-read-lints)                                   | read_lints / ReadLints                          | paths                                                                                                                                                                                                                                                                                |
| [`READ`](#agent-read)                                                         | ViewImage / read_file / ReadFile / Read         | path, target_file, offset, limit, line_range                                                                                                                                                                                                                                         |
| [`READ_LINTS`](#agent-read-lints)                                             | read_lints / ReadLints                          | paths                                                                                                                                                                                                                                                                                |
| [`RECORD_CI_INVESTIGATION_FINDINGS`](#agent-record-ci-investigation-findings) | record_ci_investigation_findings                | findings, overall, checkName, detailsUrl, tldr, rootCause, failingSignal, suggestedNextStep, diffRelation, diffRelationEvidence, flakeAssessment, flakeEvidence, rerunAvailable, rerunEvidence, recommendedAction, recommendedActionEvidence, confidence, summary, themes, checkKeys |
| [`SEARCH_CONVERSATIONS`](#agent-search-conversations)                         | SearchConversations                             | query, limit                                                                                                                                                                                                                                                                         |
| [`SEMANTIC_SEARCH`](#agent-semantic-search)                                   | codebase_search / SemanticSearch                | explanation, query, target_directories, search_only_prs                                                                                                                                                                                                                              |
| [`SHELL`](#agent-shell)                                                       | run_terminal_cmd / Shell                        | command, working_directory, block_until_ms, description, timeout, is_background, pattern, reason, debounce_ms, explanation                                                                                                                                                           |
| [`SWITCH_MODE`](#agent-switch-mode)                                           | SwitchMode                                      | target_mode_id, explanation                                                                                                                                                                                                                                                          |
| [`TODO_WRITE`](#agent-todo-write)                                             | todo_write / TodoWrite                          | merge, todos, content, status, id                                                                                                                                                                                                                                                    |
| [`WEB_FETCH`](#agent-web-fetch)                                               | WebFetch / mcp_web_fetch                        | url, requestSmartModeApproval, smartModeBlockReason                                                                                                                                                                                                                                  |
| [`WEB_SEARCH`](#agent-web-search)                                             | web_search / WebSearch                          | search_term, explanation                                                                                                                                                                                                                                                             |
| [`GET_MCP_TOOLS`](#agent-get-mcp-tools)                                       | GetMcpTools / GetDynamicTools                   | namespace, toolName, pattern, server                                                                                                                                                                                                                                                 |
| [`CREATE_TASK`](#agent-create-task)                                           | create-agent                                    | title, description, prompt, responding_to_message_ids, fork, attachments                                                                                                                                                                                                             |
| [`SEND_MESSAGE`](#agent-send-message)                                         | SendMessage                                     | message                                                                                                                                                                                                                                                                              |
| [`SEND_TO_TASK`](#agent-send-to-task)                                         | send-message-to-agent                           | agent_id, prompt, responding_to_message_ids, attachments                                                                                                                                                                                                                             |
| [`PI_READ`](#agent-pi-read)                                                   | pi_read                                         | path, offset, limit                                                                                                                                                                                                                                                                  |
| [`PI_BASH`](#agent-pi-bash)                                                   | pi_bash                                         | command, timeout                                                                                                                                                                                                                                                                     |
| [`PI_EDIT`](#agent-pi-edit)                                                   | pi_edit                                         | path, edits, oldText, newText                                                                                                                                                                                                                                                        |
| [`PI_WRITE`](#agent-pi-write)                                                 | pi_write                                        | path, content                                                                                                                                                                                                                                                                        |
| [`PI_GREP`](#agent-pi-grep)                                                   | pi_grep                                         | pattern, path, glob, ignoreCase, literal, context, limit                                                                                                                                                                                                                             |
| [`PI_FIND`](#agent-pi-find)                                                   | pi_find                                         | pattern, path, limit                                                                                                                                                                                                                                                                 |
| [`PI_LS`](#agent-pi-ls)                                                       | pi_ls                                           | path, limit                                                                                                                                                                                                                                                                          |
| [`CONNECT_SCM`](#agent-connect-scm)                                           | ConnectScm                                      | github_repo                                                                                                                                                                                                                                                                          |
| [`SET_ACTIVE_BRANCH`](#agent-set-active-branch)                               | SetActiveBranch                                 | path, branchName                                                                                                                                                                                                                                                                     |
| [`ADOPT`](#agent-adopt)                                                       | Adopt                                           | source_agent_id                                                                                                                                                                                                                                                                      |
| [`SEND_TO_USER`](#agent-send-to-user)                                         | SendToUser                                      | message                                                                                                                                                                                                                                                                              |
| [`SEND_FINAL_SUMMARY`](#agent-send-final-summary)                             | sendFinalSummary                                | final_summary                                                                                                                                                                                                                                                                        |
| [`COMMUNICATE_UPDATE`](#agent-communicate-update)                             | UpdateCurrentStep                               | current_step                                                                                                                                                                                                                                                                         |

`MOCK_READ_LINTS` 是测试用途；`MINI_SWE_AGENT_BASH` 与 `PI_*` 是特定配置的工具变体。`SEND_FINAL_SUMMARY` 和 `COMMUNICATE_UPDATE` 在 Agent Host 中另有定义，本次已补入。内部标识、模型名称和跨 bundle 的重复构造不能相加当作默认工具数。

<a id="agent-mcp"></a>

### MCP

模型名称 / 静态别名：`CallMcpTool` / `CallDynamicTool`。证据：`cursor-agent-exec`，工厂 `XY`，UTF-16 偏移 `5974314`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: r,
  descriptionGenerator: e=>{
    if(D){
      const t=ML(e.allTools,"GET_MCP_TOOLS");
      return O?`Invoke one tool from a dynamic namespace, e.g. an MCP server. IMPORTANT: Always call ${t} for this namespace/tool before calling to ensure correct parameters. Set mcpDetails only for tools from external MCP namespaces; omit it for first-party tools in the cursor namespace.\n\nExample:\n{\n  "namespace": "my-namespace",\n  "toolName": "search",\n  "mcpDetails": { "description": "Search the public docs for the example API" },\n  "arguments": { "query": "example", "limit": 10 }\n}${ie}`:`Call an MCP tool by server identifier and tool name with arbitrary JSON arguments. IMPORTANT: Always call ${t} for this server/tool before calling to ensure correct parameters.\n\nExample:\n{\n  "server": "my-mcp-server",\n  "toolName": "search",\n  ${oe}"arguments": { "query": "example", "limit": 10 }\n}${ie}`}
    return`Call an MCP tool by server identifier and tool name with arbitrary JSON arguments. IMPORTANT: Always read the tool's schema/descriptor BEFORE calling to ensure correct parameters.\n\nExample:\n{\n  "server": "my-mcp-server",\n  "toolName": "search",\n  ${oe}"arguments": { "query": "example", "limit": 10 }\n}`}
  ,
  parameters: re
}

```

</details>

<details>
<summary>参数字段与约束（10 条表达式）</summary>

| 字段（含嵌套与变体）       | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`                | `ar.Yj().describe("Dynamic namespace hosting the tool, e.g. an MCP server.")`                                                                                                                                                                                                                                                                                                                                              |
| `toolName`                 | `ar.Yj().describe("Name of the tool to invoke.")`                                                                                                                                                                                                                                                                                                                                                                          |
| `description`              | `H`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `write_to_file`            | `ar.zM().optional().describe("When true, the tool's result is written to a file under agent-tools/ in the workspace instead of being returned inline, regardless of its size; the result then reports the file path, size, and line count. Use it when you expect a large result that you want to read selectively or pass on to another tool by path. System reminders attached to the call are still returned inline.")` |
| `description`              | `H.optional()`                                                                                                                                                                                                                                                                                                                                                                                                             |
| `requestSmartModeApproval` | `ar.zM().optional().describe("Set to true when immediately retrying the exact same MCP call after Auto-review blocks it and you decide the user should approve it through the native approval card.")`                                                                                                                                                                                                                     |
| `smartModeBlockReason`     | `ar.Yj().optional().describe("Provide the exact block reason returned by Auto-review in the prior rejection. Required when requestSmartModeApproval is true so the approval card shows the original classifier reason without re-running the classifier.")`                                                                                                                                                                |
| `server`                   | `ar.Yj().describe("Identifier of the MCP server hosting the tool.")`                                                                                                                                                                                                                                                                                                                                                       |
| `toolName`                 | `ar.Yj().describe("Name of the MCP tool to invoke.")`                                                                                                                                                                                                                                                                                                                                                                      |
| `arguments`                | `j`                                                                                                                                                                                                                                                                                                                                                                                                                        |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(re=O?z.extend({
  mcpDetails:Q.optional().describe("MCP-specific call metadata. Set this only when invoking a tool from an external MCP namespace; omit it for first-party tools in the cursor namespace."),...ee,arguments:j}
):z.extend({
  ...K.shape,...Y?V.shape:{
    }
  ,...ee,arguments:j}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
tQ
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  if(e instanceof yY)return SY(new X_.nz({
    result:new X_.QN({
      result:{
        case:"error",value:new X_.jZ({
          error:e.clientVisibleErrorMessage,readToolDefReminder:e.modelVisibleErrorMessage,systemReminders:ZY(e.systemReminders)}
        )}
      }
    )}
  ));
  if(e instanceof pY)return SY(new X_.nz({
    result:new X_.QN({
      result:{
        case:"error",value:new X_.jZ({
          error:e.clientVisibleErrorMessage,readToolDefReminder:e.readServerDefReminder}
        )}
      }
    )}
  ));
  if(e instanceof mY)return SY(new X_.nz({
    result:new X_.QN({
      result:{
        case:"error",value:new X_.jZ({
          error:e.clientVisibleErrorMessage,readToolDefReminder:e.readToolDefReminder}
        )}
      }
    )}
  ));
  if(e instanceof uY)return SY(new X_.nz({
    result:new X_.QN({
      result:{
        case:"permissionDenied",value:new r_.HQ({
          error:e.error,isReadonly:e.isReadonly}
        )}
      }
    )}
  ));
  if(e instanceof p$)return SY(new X_.nz({
    result:new X_.QN({
      result:{
        case:"rejected",value:new r_.xo({
          reason:e.message}
        )}
      }
    )}
  ));
  if(e instanceof u$)return SY(new X_.nz({
    result:new X_.QN({
      result:{
        case:"error",value:new X_.jZ({
          error:e.clientVisibleErrorMessage,readToolDefReminder:e.modelVisibleErrorMessage,systemReminders:ZY(e.systemReminders)}
        )}
      }
    )}
  ));
  const t=e instanceof Error?e.message:String(e);
  return SY(new X_.nz({
    result:new X_.QN({
      result:{
        case:"error",value:new X_.jZ({
          error:"Tool execution error",readToolDefReminder:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:MCP:5974314]`。

<a id="agent-ask-question"></a>

### ASK_QUESTION

模型名称 / 静态别名：`AskQuestion`。证据：`cursor-agent-exec`，工厂 `tne`，UTF-16 偏移 `6860061`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: n,
  descriptionGenerator: e=>o,
  parameters: s
}

```

</details>

<details>
<summary>参数字段与约束（6 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `ar.Yj().describe("Unique identifier for this question")`                                                                                                                                         |
| `prompt`             | `ar.Yj().describe("The question text to display to the user, without the options.")`                                                                                                              |
| `options`            | `ar.YO(ar.Ik({id:ar.Yj().describe("Unique identifier for this option"),label:ar.Yj().describe("Display text for this option")})).min(2).describe("Array of answer options (minimum 2 required)")` |
| `allow_multiple`     | `ar.zM().optional().describe("If true, user can select multiple options. Defaults to false.")`                                                                                                    |
| `id`                 | `ar.Yj().describe("Unique identifier for this option")`                                                                                                                                           |
| `label`              | `ar.Yj().describe("Display text for this option")`                                                                                                                                                |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(s=function(){
  const e={
    title:ar.Yj().optional().describe("Optional title for the questions form"),questions:Nre(ar.YO(Yre).min(1).describe("Array of questions to present to the user (minimum 1 required)"),{
      field:"questions"}
    )}
  ;
  return ar.Ik(e)}
())
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(Zre(t,n))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return Vre(new nd.OU({
    result:new nd.tz({
      result:{
        case:"error",value:new nd.Ww({
          errorMessage:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:ASK_QUESTION:6860061]`。

<a id="agent-task"></a>

### TASK

模型名称 / 静态别名：`mcp_task` / `Subagent` / `Task`。证据：`cursor-agent-exec`，工厂 `Oae`，UTF-16 偏移 `7133188`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: ne,
  descriptionGenerator: (e,t)=>ie(e,se(t)).fullDescription,
  parameters: X
}

```

</details>

<details>
<summary>参数字段与约束（14 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `type`               | `ar.eu("new_cloud_vm")`                                                                                                                                                                                                                                                                                                                                |
| `base_branch`        | `ar.vk(Tae,ar.Yj().optional().describe("Branch the subagent's own generated branch starts from. Defaults to the current branch. Uses the remote version, so uncommitted or unpushed work is not visible."))`                                                                                                                                           |
| `description`        | `e`                                                                                                                                                                                                                                                                                                                                                    |
| `prompt`             | `p`                                                                                                                                                                                                                                                                                                                                                    |
| `model`              | `m`                                                                                                                                                                                                                                                                                                                                                    |
| `resume`             | `g`                                                                                                                                                                                                                                                                                                                                                    |
| `subagent_type`      | `r`                                                                                                                                                                                                                                                                                                                                                    |
| `file_attachments`   | `C`                                                                                                                                                                                                                                                                                                                                                    |
| `type`               | `ar.eu("same_machine")`                                                                                                                                                                                                                                                                                                                                |
| `type`               | `ar.eu("self_hosted_worker")`                                                                                                                                                                                                                                                                                                                          |
| `worker_id`          | `ar.Yj().min(1).describe("Worker to run on, from cursor-cloud-list-self-hosted-workers. Only your own machines can be targeted this way; use self_hosted_pool for a team pool worker. Check that tool's sharedAssignmentAllowed first: a shared worker runs this subagent alongside others, otherwise the subagent waits for the worker to free up.")` |
| `type`               | `ar.eu("self_hosted_pool")`                                                                                                                                                                                                                                                                                                                            |
| `pool`               | `ar.Yj().optional().describe("Pool to draw a worker from. Defaults to the team's default pool.")`                                                                                                                                                                                                                                                      |
| `labels`             | `ar.g1(ar.Yj()).optional().describe("Key/value labels a candidate worker must all match.")`                                                                                                                                                                                                                                                            |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
({
  schemaTowardsModel:X,schemaForParsing:Z}
=Mae(s,Q))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  const n=nae(t,{
    enableJobCompletionNotifications:K,hideAsyncSubagentTaskNotifications:A,enableAgentChatLinks:M,cloudCoordinatorTaskVariant:J}
  );
  if("success"===t.result.case&&t.result.value.backgroundReason===lT.qL.UNSPECIFIED){
    const e=gie(n,t.result.value.conversationSteps);
    if(void 0!==e)return e}
  return Go(n,"error"===t.result.case)}

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return oae(new U.U4S({
    result:new U.$$B({
      result:{
        case:"error",value:new U.IkE({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:TASK:7133188]`。

<a id="agent-report-bugfix-results"></a>

### REPORT_BUGFIX_RESULTS

模型名称 / 静态别名：`mcp_report_bugfix_results` / `ReportBugfixResults`。证据：`cursor-agent-exec`，工厂 `Fce`，UTF-16 偏移 `7198827`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: function(e){
    switch(e){
      case"dsv3-1018":return"mcp_report_bugfix_results";
      case"cursor-0226":case"dsv3-1205":case"latest":case"gpt5-codex":case"codex-cloud":case"haiku":return"ReportBugfixResults";
      default:throw new Error(`Unhandled version: ${e}`)}
    }
  (t),
  descriptionGenerator: e=>'Report the results of the bugfix analysis. Call this tool ONCE when you have finished analyzing and fixing all bugs.\n\nYou MUST call this tool to report your findings. After calling this tool, output the string "Done" exactly and nothing else.\n\nFor each bug in the list, provide:\n- bug_id: The exact bug ID from the bug list\n- bug_title: The exact bug title from the bug list\n- verdict: One of "fixed", "false_positive", "could_not_fix", or "resolved_by_other_fix"\n- explanation: A single concise sentence explaining the resolution\n- severity: The severity of the bug as provided in the bug list (if provided)',
  parameters: qce
}

```

</details>

<details>
<summary>参数字段与约束（6 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `results`            | `ar.YO(ar.Ik({bug_id:ar.Yj().describe("The bug ID as provided in the bug list"),bug_title:ar.Yj().describe("The exact bug title as provided in the bug list"),verdict:ar.k5(["fixed","false_positive","could_not_fix","resolved_by_other_fix"]).describe("The verdict for this bug"),explanation:ar.Yj().describe("A single concise sentence explaining the resolution or why it wasn't resolved"),severity:ar.k5(["high","medium","low"]).optional().describe("The severity of the bug as provided in the bug list (high, medium, or low)")})).describe("Results for each bug, in the same order as in the bug list")` |
| `bug_id`             | `ar.Yj().describe("The bug ID as provided in the bug list")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `bug_title`          | `ar.Yj().describe("The exact bug title as provided in the bug list")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `verdict`            | `ar.k5(["fixed","false_positive","could_not_fix","resolved_by_other_fix"]).describe("The verdict for this bug")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `explanation`        | `ar.Yj().describe("A single concise sentence explaining the resolution or why it wasn't resolved")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `severity`           | `ar.k5(["high","medium","low"]).optional().describe("The severity of the bug as provided in the bug list (high, medium, or low)")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "results": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "bug_id": {
            "type": "string",
            "description": "The bug ID as provided in the bug list"
          },
          "bug_title": {
            "type": "string",
            "description": "The exact bug title as provided in the bug list"
          },
          "verdict": {
            "type": "string",
            "enum": [
              "fixed",
              "false_positive",
              "could_not_fix",
              "resolved_by_other_fix"
            ],
            "description": "The verdict for this bug"
          },
          "explanation": {
            "type": "string",
            "description": "A single concise sentence explaining the resolution or why it wasn't resolved"
          },
          "severity": {
            "type": "string",
            "enum": [
              "high",
              "medium",
              "low"
            ],
            "description": "The severity of the bug as provided in the bug list (high, medium, or low)"
          }
        },
        "required": [
          "bug_id",
          "bug_title",
          "verdict",
          "explanation"
        ],
        "additionalProperties": false
      },
      "description": "Results for each bug, in the same order as in the bug list"
    }
  },
  "required": [
    "results"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(qce=ar.Ik({
  results:ar.YO(ar.Ik({
    bug_id:ar.Yj().describe("The bug ID as provided in the bug list"),bug_title:ar.Yj().describe("The exact bug title as provided in the bug list"),verdict:ar.k5(["fixed","false_positive","could_not_fix","resolved_by_other_fix"]).describe("The verdict for this bug"),explanation:ar.Yj().describe("A single concise sentence explaining the resolution or why it wasn't resolved"),severity:ar.k5(["high","medium","low"]).optional().describe("The severity of the bug as provided in the bug list (high, medium, or low)")}
  )).describe("Results for each bug, in the same order as in the bug list")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  const n=t.result;
  switch(n?.case){
    case"success":{
      const e=n.value.results;
      let t="Bugfix results recorded successfully.\n\n";
      for(const r of e){
        t+=`- ${Mce(r.verdict)} ${Jce(r.verdict)}: **${Oce(r.severity)}${r.bugTitle}**\n`}
      return Go(t.trim())}
    case"error":return Go(n.value.error);
    case void 0:return Go("Unknown error");
    default:throw new Error(`Unhandled result case: ${String(n)}`)}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return Rce(new GI.U_({
    result:new GI.Ht({
      result:{
        case:"error",value:new GI.q3({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:REPORT_BUGFIX_RESULTS:7198827]`。

<a id="agent-record-screen"></a>

### RECORD_SCREEN

模型名称 / 静态别名：`RecordScreen`。证据：`cursor-agent-exec`，工厂 `Kce`，UTF-16 偏移 `7205986`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "RecordScreen",
  descriptionGenerator: e=>"Control screen recording on the VM. This tool is useful for demonstrating GUI-based changes or working manual tests to the user. Do not use for non-GUI based testing (i.e. tests run through shell commands).",
  parameters: Gce
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`               | `ar.k5(["START_RECORDING","SAVE_RECORDING","DISCARD_RECORDING"]).describe("Recording mode: START_RECORDING to begin, SAVE_RECORDING to stop and save, DISCARD_RECORDING to discard")`                                                                                                                                                |
| `save_as_filename`   | `ar.Yj().optional().describe("Custom filename for the saved recording. Only use when mode=SAVE_RECORDING (ignored for other modes). Use to specify a human readable name describing the contents of the screen recording. Do not include slashes or file extension (absolute path and correct extension are automatically added).")` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "mode": {
      "type": "string",
      "enum": [
        "START_RECORDING",
        "SAVE_RECORDING",
        "DISCARD_RECORDING"
      ],
      "description": "Recording mode: START_RECORDING to begin, SAVE_RECORDING to stop and save, DISCARD_RECORDING to discard"
    },
    "save_as_filename": {
      "type": "string",
      "description": "Custom filename for the saved recording. Only use when mode=SAVE_RECORDING (ignored for other modes). Use to specify a human readable name describing the contents of the screen recording. Do not include slashes or file extension (absolute path and correct extension are automatically added)."
    }
  },
  "required": [
    "mode"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Gce=ar.Ik({
  mode:ar.k5(["START_RECORDING","SAVE_RECORDING","DISCARD_RECORDING"]).describe("Recording mode: START_RECORDING to begin, SAVE_RECORDING to stop and save, DISCARD_RECORDING to discard"),save_as_filename:ar.Yj().optional().describe("Custom filename for the saved recording. Only use when mode=SAVE_RECORDING (ignored for other modes). Use to specify a human readable name describing the contents of the screen recording. Do not include slashes or file extension (absolute path and correct extension are automatically added).")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  if(!t.result.case)return Go("Unknown error",!0);
  switch(t.result.case){
    case"startSuccess":{
      let e="Screen recording started successfully";
      return t.result.value.wasPriorRecordingCancelled?e+=" (prior ongoing recording was cancelled and discarded).":e+=".",t.result.value.wasSaveAsFilenameIgnored&&(e+="\nNote: save_as_filename argument was ignored. save_as_filename should be specified when recording is saved, not started."),Go(e)}
    case"saveSuccess":{
      const e=t.result.value;
      let r=`Screen recording saved successfully: ${e.path}\n`;
      if(void 0!==e.requestedFilePathRejectedReason){
        r=`Requested save_as_filename is invalid (${(e=>{switch(e){case NE.y.SLASHES_NOT_ALLOWED:return"slashes not allowed in filename";case NE.y.UNSPECIFIED:return"unspecified reason";default:return`unknown reason: ${e}`}})(e.requestedFilePathRejectedReason)}).\n${r}`}
      return Go(r)}
    case"discardSuccess":return Go("Screen recording discarded successfully");
    case"failure":return Go(`Error: ${t.result.value.error}`,!0);
    default:{
      const e=t.result;
      throw new Error(`Unhandled result case: ${e}`)}
    }
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return jce(new ZE.q({
    result:new NE.Tj({
      result:{
        case:"failure",value:{
          error:t}
        }
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:RECORD_SCREEN:7205986]`。

<a id="agent-reflect-general"></a>

### REFLECT_GENERAL

模型名称 / 静态别名：`Reflect`。证据：`cursor-agent-exec`，工厂 `Zce`，UTF-16 偏移 `7216522`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "Reflect",
  descriptionGenerator: e=>r,
  parameters: t
}

```

</details>

<details>
<summary>参数字段与约束</summary>

参数由配置传入；请看工厂函数及 JSON 的 constructionDependencies。
</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(t=function(e){
  const t={
    }
  ;
  for(const[r,n]of Object.entries(Xce)){
    const s=e?.fieldDescriptions?.[r];
    null!==s&&(t[r]=ar.Yj().describe(s||n))}
  return ar.Ik(t)}
(e))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(function(e,t){
  const r=e=>`${e}${t??""}`;
  switch(e.result.case){
    case"success":return r("Reflection completed successfully. Now in your next step you must NOT use the `Reflect` tool as you cannot use two `Reflect` tools in a row.");
    case"error":return r(`Error: ${e.result.value.error}`);
    case void 0:return r("Unknown error");
    default:{
      const t=e.result;
      throw new Error(`Unhandled result case: ${t}`)}
    }
  }
(t,n))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return Qce(new rI.YF({
    result:new rI.V$({
      result:{
        case:"error",value:new rI.ML({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:REFLECT_GENERAL:7216522]`。

<a id="agent-replace-env"></a>

### REPLACE_ENV

模型名称 / 静态别名：`ReplaceEnv`。证据：`cursor-agent-exec`，工厂 `ile`，UTF-16 偏移 `7223117`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "ReplaceEnv",
  descriptionGenerator: e=>"Replace the current cloud-agent environment with a new pod. Choose `custom` mode to override the environment with a provided install script and optional inline Dockerfile. Choose `clean_slate` mode for the default base image with no install script and no existing environment config. Choose `default` mode to re-read the repo/saved environment config without applying an override. Use this when the current pod environment is unhealthy or needs a clean re-provisioning. On success, the cloud agent moves to the replacement environment. On failure, the original environment is kept.",
  parameters: nle
}

```

</details>

<details>
<summary>参数字段与约束（7 条表达式）</summary>

| 字段（含嵌套与变体）     | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`                   | `ar.k5(["custom","clean_slate","default"]).optional().describe("How to configure the replacement environment. Use \`custom\` (default) to provide a new install script and optional Dockerfile, \`clean_slate\` for the default base image with no install script or existing environment config, or \`default\` to re-read the repo/saved environment config without applying an override.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `checkout_ref_overrides` | `ar.YO(ar.Ik({repo_url:ar.Yj().describe("Repo to override. Any common form works (https/ssh/scp-style URL, \`host/owner/repo\`, or bare \`owner/repo\`); it is canonicalized before matching against the agent's repos."),ref:ar.Yj().describe("Branch, tag, or commit SHA to check out for this repo. A SHA results in a detached HEAD. It must already exist on the remote (commit and push first).")})).optional().describe("Optional, applies to all modes. Per-repo overrides for the git ref the replacement environment is rebuilt from, replacing whatever was pinned in the original start request. The ref determines where \`.cursor/environment.json\` is read from and the commit the new pod is built at. Only list the repos you want to override; unlisted repos keep their original ref. Commit and push your changes to the target ref first, since it is resolved from the remote. The tool call fails fast if a \`repo_url\` matches no known repo (or matches ambiguously) or if a \`ref\` is malformed; a ref that does not exist on the remote is not pre-checked and instead fails later while rebuilding the pod.")` |
| `config`                 | `ar.Ik({install_script:ar.Yj().optional().describe("Required when mode is \`custom\`. Shell script to run while preparing the replacement environment. Use a single command for simple setups or a multiline script with one command per line for more complex installs. Leave unset for \`clean_slate\` and \`default\`."),dockerfile_contents:ar.Yj().optional().describe("Optional only when mode is \`custom\`. Inline Dockerfile contents used to build the replacement pod's base image before the install script runs. Leave unset to use the default base image. Ignored for \`clean_slate\` and \`default\`.")}).optional().describe("Environment configuration for \`custom\` mode: an install script and optional inline Dockerfile. Omit for \`clean_slate\` and \`default\`.")`                                                                                                                                                                                                                                                                                                                                                  |
| `repo_url`               | `ar.Yj().describe("Repo to override. Any common form works (https/ssh/scp-style URL, \`host/owner/repo\`, or bare \`owner/repo\`); it is canonicalized before matching against the agent's repos.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ref`                    | `ar.Yj().describe("Branch, tag, or commit SHA to check out for this repo. A SHA results in a detached HEAD. It must already exist on the remote (commit and push first).")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `install_script`         | `ar.Yj().optional().describe("Required when mode is \`custom\`. Shell script to run while preparing the replacement environment. Use a single command for simple setups or a multiline script with one command per line for more complex installs. Leave unset for \`clean_slate\` and \`default\`.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `dockerfile_contents`    | `ar.Yj().optional().describe("Optional only when mode is \`custom\`. Inline Dockerfile contents used to build the replacement pod's base image before the install script runs. Leave unset to use the default base image. Ignored for \`clean_slate\` and \`default\`.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "mode": {
      "type": "string",
      "enum": [
        "custom",
        "clean_slate",
        "default"
      ],
      "description": "How to configure the replacement environment. Use `custom` (default) to provide a new install script and optional Dockerfile, `clean_slate` for the default base image with no install script or existing environment config, or `default` to re-read the repo/saved environment config without applying an override."
    },
    "checkout_ref_overrides": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "repo_url": {
            "type": "string",
            "description": "Repo to override. Any common form works (https/ssh/scp-style URL, `host/owner/repo`, or bare `owner/repo`); it is canonicalized before matching against the agent's repos."
          },
          "ref": {
            "type": "string",
            "description": "Branch, tag, or commit SHA to check out for this repo. A SHA results in a detached HEAD. It must already exist on the remote (commit and push first)."
          }
        },
        "required": [
          "repo_url",
          "ref"
        ],
        "additionalProperties": false
      },
      "description": "Optional, applies to all modes. Per-repo overrides for the git ref the replacement environment is rebuilt from, replacing whatever was pinned in the original start request. The ref determines where `.cursor/environment.json` is read from and the commit the new pod is built at. Only list the repos you want to override; unlisted repos keep their original ref. Commit and push your changes to the target ref first, since it is resolved from the remote. The tool call fails fast if a `repo_url` matches no known repo (or matches ambiguously) or if a `ref` is malformed; a ref that does not exist on the remote is not pre-checked and instead fails later while rebuilding the pod."
    },
    "config": {
      "type": "object",
      "properties": {
        "install_script": {
          "type": "string",
          "description": "Required when mode is `custom`. Shell script to run while preparing the replacement environment. Use a single command for simple setups or a multiline script with one command per line for more complex installs. Leave unset for `clean_slate` and `default`."
        },
        "dockerfile_contents": {
          "type": "string",
          "description": "Optional only when mode is `custom`. Inline Dockerfile contents used to build the replacement pod's base image before the install script runs. Leave unset to use the default base image. Ignored for `clean_slate` and `default`."
        }
      },
      "additionalProperties": false,
      "description": "Environment configuration for `custom` mode: an install script and optional inline Dockerfile. Omit for `clean_slate` and `default`."
    }
  },
  "additionalProperties": false,
  "description": "Replace the cloud-agent environment using an explicit mode: `custom`, `clean_slate`, or `default`.",
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(nle=ar.Ik({
  mode:ar.k5(["custom","clean_slate","default"]).optional().describe("How to configure the replacement environment. Use `custom` (default) to provide a new install script and optional Dockerfile, `clean_slate` for the default base image with no install script or existing environment config, or `default` to re-read the repo/saved environment config without applying an override."),checkout_ref_overrides:ar.YO(ar.Ik({
    repo_url:ar.Yj().describe("Repo to override. Any common form works (https/ssh/scp-style URL, `host/owner/repo`, or bare `owner/repo`); it is canonicalized before matching against the agent's repos."),ref:ar.Yj().describe("Branch, tag, or commit SHA to check out for this repo. A SHA results in a detached HEAD. It must already exist on the remote (commit and push first).")}
  )).optional().describe("Optional, applies to all modes. Per-repo overrides for the git ref the replacement environment is rebuilt from, replacing whatever was pinned in the original start request. The ref determines where `.cursor/environment.json` is read from and the commit the new pod is built at. Only list the repos you want to override; unlisted repos keep their original ref. Commit and push your changes to the target ref first, since it is resolved from the remote. The tool call fails fast if a `repo_url` matches no known repo (or matches ambiguously) or if a `ref` is malformed; a ref that does not exist on the remote is not pre-checked and instead fails later while rebuilding the pod."),config:ar.Ik({
    install_script:ar.Yj().optional().describe("Required when mode is `custom`. Shell script to run while preparing the replacement environment. Use a single command for simple setups or a multiline script with one command per line for more complex installs. Leave unset for `clean_slate` and `default`."),dockerfile_contents:ar.Yj().optional().describe("Optional only when mode is `custom`. Inline Dockerfile contents used to build the replacement pod's base image before the install script runs. Leave unset to use the default base image. Ignored for `clean_slate` and `default`.")}
  ).optional().describe("Environment configuration for `custom` mode: an install script and optional inline Dockerfile. Omit for `clean_slate` and `default`.")}
).superRefine((e,t)=>{
  const r=e.mode??"custom";
  "custom"!==r||void 0!==e.config?.install_script&&0!==e.config.install_script.trim().length||t.addIssue({
    code:die.eq.custom,path:["config","install_script"],message:"`install_script` must be a non-empty string in custom mode"}
  ),"custom"===r&&void 0!==e.config?.dockerfile_contents&&0===e.config.dockerfile_contents.trim().length&&t.addIssue({
    code:die.eq.custom,path:["config","dockerfile_contents"],message:"`dockerfile_contents` must be non-empty when provided in custom mode"}
  ),e.checkout_ref_overrides?.forEach((e,r)=>{
    0===e.repo_url.trim().length&&t.addIssue({
      code:die.eq.custom,path:["checkout_ref_overrides",r,"repo_url"],message:"`repo_url` must be a non-empty string"}
    ),0===e.ref.trim().length&&t.addIssue({
      code:die.eq.custom,path:["checkout_ref_overrides",r,"ref"],message:"`ref` must be a non-empty string"}
    )}
  )}
).describe("Replace the cloud-agent environment using an explicit mode: `custom`, `clean_slate`, or `default`."))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(function(e){
  switch(e.result.case){
    case"success":{
      const t=e.result.value.setupLogs.trim();
      return t.length>0?`Replaced environment successfully.\n\nSetup logs:\n${t}`:"Replaced environment successfully."}
    case"failure":{
      const t=e.result.value.setupLogs.trim(),r=e.result.value.errorMessage;
      return t.length>0?`Failed to replace environment: ${r}\n\nSetup logs:\n${t}`:`Failed to replace environment: ${r}`}
    case void 0:return"Failed to replace environment: unknown error";
    default:return e.result}
  }
(t))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:"Unknown replace env error";
  return rle(new fI.us({
    result:new fI.dV({
      result:{
        case:"failure",value:{
          errorMessage:t,setupLogs:""}
        }
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:REPLACE_ENV:7223117]`。

<a id="agent-setup-vm-environment"></a>

### SETUP_VM_ENVIRONMENT

模型名称 / 静态别名：`SetupVmEnvironment`。证据：`cursor-agent-exec`，工厂 `ule`，UTF-16 偏移 `7230666`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "SetupVmEnvironment",
  descriptionGenerator: e=>i,
  parameters: s
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `update_script`      | `ar.Yj().describe("The update script that will be run on VM startup (after pulling the latest changes from the repository) before every cloud agent session to keep the development environment up to date. This is a command string, NOT a bash script file. Treat this as reliability-critical infrastructure: if this script breaks, future cloud agent pods may fail to start. Keep it super minimal and low-risk. For many simple codebases, the update script will simply be something like \`npm install\`, \`pip install -r requirements.txt\`, \`uv sync\`, etc. For more complex cases requiring multiple steps, use a multiline script with each command on its own line (do NOT use && to chain commands - use newlines instead). This should not include system dependencies that aren't part of the codebase, and it should NOT include service startup logic, migrations, test commands, build commands, or other brittle steps. Examples that MUST NOT be in the update script include \`docker compose up\`, \`docker-compose up\`, \`pnpm dev\`, \`npm run dev\`, and \`python manage.py runserver\`. Avoid shell-profile edits and ad-hoc environment-variable setup in the update script (for example \`echo ... >> ~/.bashrc\`, \`source ~/.bashrc\`, or \`export FOO=bar\`). If persistent shell customization is truly required, do it once during setup outside the update script (for example in the agent's \`~/.bashrc\`) and document it in AGENTS.md. If unsure, prefer fewer commands. Treat this as the \"automatic startup layer\" only; AGENTS.md is the place for durable human/agent operating guidance. The update script MUST be idempotent. It MUST also be robust when users do not merge your previous code changes. Do not assume files introduced only in your unmerged PR will exist on future runs (for example a newly added \`package.json\`); choose commands that are valid for the repository's current state or guard file-dependent commands accordingly. It will be executed from the /workspace directory (the root of the repository), so you should not need to specify the full path to the commands. Example multiline format:\nnpm install\npnpm run build:deps\npip install -r requirements.txt")` |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(s=function(e){
  const t=ar.Ik({
    update_script:ar.Yj().describe("The update script that will be run on VM startup (after pulling the latest changes from the repository) before every cloud agent session to keep the development environment up to date. This is a command string, NOT a bash script file. Treat this as reliability-critical infrastructure: if this script breaks, future cloud agent pods may fail to start. Keep it super minimal and low-risk. For many simple codebases, the update script will simply be something like `npm install`, `pip install -r requirements.txt`, `uv sync`, etc. For more complex cases requiring multiple steps, use a multiline script with each command on its own line (do NOT use && to chain commands - use newlines instead). This should not include system dependencies that aren't part of the codebase, and it should NOT include service startup logic, migrations, test commands, build commands, or other brittle steps. Examples that MUST NOT be in the update script include `docker compose up`, `docker-compose up`, `pnpm dev`, `npm run dev`, and `python manage.py runserver`. Avoid shell-profile edits and ad-hoc environment-variable setup in the update script (for example `echo ... >> ~/.bashrc`, `source ~/.bashrc`, or `export FOO=bar`). If persistent shell customization is truly required, do it once during setup outside the update script (for example in the agent's `~/.bashrc`) and document it in AGENTS.md. If unsure, prefer fewer commands. Treat this as the \"automatic startup layer\" only; AGENTS.md is the place for durable human/agent operating guidance. The update script MUST be idempotent. It MUST also be robust when users do not merge your previous code changes. Do not assume files introduced only in your unmerged PR will exist on future runs (for example a newly added `package.json`); choose commands that are valid for the repository's current state or guard file-dependent commands accordingly. It will be executed from the /workspace directory (the root of the repository), so you should not need to specify the full path to the commands. Example multiline format:\nnpm install\npnpm run build:deps\npip install -r requirements.txt")}
  );
  return e?t.extend({
    dockerfile_contents:ar.Yj().optional().describe("Optional inline Dockerfile contents used to build the environment's base image. When provided, the environment is built from this Dockerfile (mapped to environment.json `build.dockerfileContents`) and the update script runs on top of it. Leave unset to use the default base image.")}
  ):t}
(n))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go("Environment setup commands suggested successfully. The user will review them.")
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>lle(new nR.MU({
  result:new nR.r$({
    result:{
      case:"success",value:new nR.JH({
        }
      )}
    }
  )}
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:SETUP_VM_ENVIRONMENT:7230666]`。

<a id="agent-await"></a>

### AWAIT

模型名称 / 静态别名：`Await` / `AwaitShell`。证据：`cursor-agent-exec`，工厂 `Nle`，UTF-16 偏移 `7245570`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: a,
  descriptionGenerator: e=>{
    const t=e.allTools.SHELL?.name,n=e.allTools.TASK?.name,o=function(e){
      const{
        version:t,enableSubagentAwaiting:r,hasShell:n,taskToolName:o,enableJobCompletionNotifications:i,promptCacheTTLMs:c}
      =e;
      if(s)return"Poll a background shell.";
      switch(t){
        case"cursor-0226":case"dsv3-1205":case"dsv3-1018":case"gpt5-codex":case"codex-cloud":case"latest":case"haiku":return i?qle({
          enableSubagentAwaiting:r,hasShell:n,toolName:a,taskToolName:o,promptCacheTTLMs:c}
        ):function(e){
          const{
            enableSubagentAwaiting:t,hasShell:r}
          =e;
          return`Poll a background ${t?"shell or subagent":"shell"} job. For work that does not have a ${t?"task id":"shell id"}, you can omit the ${t?"task_id":"shell_id"} arg to sleep for the full \`block_until_ms\` duration (prefer this over sleeping in the shell, because it renders nicely to the user).\n\nMonitor backgrounded jobs as follows:\n- Never poll a task whose tool result says it was "manually backgrounded by the user".\n- When you spawn a command directly into the background (\`block_until_ms: 0\`), check status immediately by reading the output file to confirm the command didn't fail to start.\n- Poll repeatedly to monitor by using this tool between checks (set \`block_until_ms\` to control how long to wait). If the file gets large, read from the end of the file to capture the latest content.\n- Pick your polling intervals using best guess/judgment based on any knowledge you have about the command and its expected runtime, and any output from monitoring the job. When no new output, exponential backoff is a good strategy (e.g. 2000ms, 4000ms, 8000ms, 16000ms...), using educated guess for min and max wait.${r?"\n- Shell only guidance:\n  - Waiting until a regex matches the output can be useful for e.g. known startup/status/error logs.\n  - HARD STOPPING CONSTRAINT: Don't stop polling until (a) job terminates, (b) the command reaches a healthy steady state (only for non-terminating command, e.g. dev server/watcher), or (c) command is hung - follow guidance below.\n  - Output file header has `pid` and `running_for_ms` (updated every 5000ms).\n  - When finished, footer with `exit_code` and `elapsed_ms` appears (regex only matches the body, not header/footer).\n  - If taking longer than expected and the command seems like it is hung (use judgment based on type of command), kill the process if safe to do so using the pid that appears in the header. If possible, try to fix the hang and proceed.":""}`}
        ({
          enableSubagentAwaiting:r,hasShell:n}
        );
        default:throw new Error(`Unhandled version: ${t}`)}
      }
    ({
      version:r,enableSubagentAwaiting:i&&void 0!==n,hasShell:void 0!==t,taskToolName:n,enableJobCompletionNotifications:u,promptCacheTTLMs:d}
    );
    return o}
  ,
  parameters: f
}

```

</details>

<details>
<summary>参数字段与约束（4 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式 |
| -------------------- | --------------- |
| `shell_id`           | `u`             |
| `block_until_ms`     | `l`             |
| `pattern`            | `d`             |
| `task_id`            | `u`             |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(f=function(e){
  const{
    enableSubagentAwaiting:t,defaultBlockUntilMs:r,requireBlockUntilMs:n,useTrainingShellOnlyPrompt:s,includeWaitingForSubagentSignal:o}
  =e,i=Math.round(119),a=n?`Max sleep time to block before returning (in milliseconds). Required. Set to 0 for non-blocking status check. Must not exceed 7140000 (${i} minutes).`:`Max sleep time to block before returning (in milliseconds). Defaults to ${r}ms. Set to 0 for non-blocking status check. Must not exceed 7140000 (${i} minutes).`,c=mle(ar.ai().max(CL,`block_until_ms must be at most 7140000 (${i} minutes)`)),l=n?c.describe(a):c.optional().describe(a),u=ar.vk(e=>"number"==typeof e?String(e):e,ar.Yj().optional()).describe(s?"Optional shell id to poll. If omitted, this tool sleeps for the full block_until_ms duration and then returns. Required when block_until_ms is 0.":t?"Optional shell or subagent id to poll. If omitted, this tool sleeps for the full block_until_ms duration and then returns. Required when block_until_ms is 0.":"Optional shell id to poll. If omitted, this tool sleeps for the full block_until_ms duration and then returns. Required when block_until_ms is 0."),d=ar.Yj().optional().describe(t?"Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output. Will not match terminal file headers or footers, e.g. exit_code. Accepts JavaScript regex patterns (compiled with the multiline `m` flag). Not supported for awaiting subagents: you MUST leave this argument unset.":"Block until the regex matches stdout/stderr stream (or task completes). Matches anywhere in the shell output, not just new output. Will not match terminal file headers or footers, e.g. exit_code. Accepts JavaScript regex patterns (compiled with the multiline `m` flag).");
  if(!t&&!s){
    const t=x$(ar.Ik({
      shell_id:u,block_until_ms:l,pattern:d,...o?{
        waiting_for_subagent:ar.zM().optional().describe("Set this to true if you are waiting for subagent(s) to complete. Remember you should NOT be doing this and instead end your turn or do parallel work.")}
      :{
        }
      }
    ),e.machineIds,e.machineIdParameterSchema);
    return ar.vk(e=>{
      if(null===e||"object"!=typeof e||Array.isArray(e))return e;
      const t={
        ...e}
      ;
      return void 0===t.shell_id&&void 0!==t.task_id&&(t.shell_id=t.task_id),t}
    ,t.transform(({
      shell_id:e,...t}
    )=>({
      task_id:e,...t}
    )))}
  return x$(ar.Ik({
    task_id:u,block_until_ms:l,pattern:d}
  ),e.machineIds,e.machineIdParameterSchema)}
({
  enableSubagentAwaiting:i,defaultBlockUntilMs:m,requireBlockUntilMs:h,useTrainingShellOnlyPrompt:s,includeWaitingForSubagentSignal:c,machineIds:t.machineIds,machineIdParameterSchema:t.machineIdParameterSchema}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  const n=e=>e.regexRequested?void 0!==e.regexMatch&&e.regexMatch.length>0?`Pattern matched: ${e.regexMatch??""}`.trimEnd():"Pattern did NOT match.":"",s=function(e){
    if(!e||void 0===e.case)return{
      case:void 0}
    ;
    if("success"===e.case){
      const t=e.value.awaitResult;
      return t&&void 0!==t.case?"complete"===t.case?{
        case:"complete",value:t.value}
      :"stillRunning"===t.case?{
        case:"stillRunning",value:t.value}
      :{
        case:void 0}
      :{
        case:void 0}
      }
    if("error"===e.case)return{
      case:"error",value:e.value}
    ;
    const t=e;
    return"complete"===t.case?{
      case:"complete",value:t.value}
    :"stillRunning"===t.case?{
      case:"stillRunning",value:t.value}
    :"error"===t.case?{
      case:"error",value:t.value}
    :{
      case:void 0}
    }
  (t.result);
  switch(s.case){
    case"complete":{
      const e=s.value;
      if(0===e.taskId.trim().length){
        const t=(e=>{
          const t=_le(e??BigInt(0));
          return t<=0?"Slept briefly.":`Slept for ${Math.max(1,Math.ceil(t/1e3))}s.`}
        )(e.runtimeMs);
        return Go(e.wakeReason===Ple?`${t} Sleep released early: a new user message is arriving.`:t)}
      const t=n(e),r=ble(e.taskId)?e.exitCode:void 0;
      let o;
      if(ble(e.taskId)){
        o=`Task completed in ${(e.runtimeMs??BigInt(0)).toString()}ms with exit code: ${void 0!==r?String(r):"unknown"}.`}
      else o="Task complete.";
      return t.length>0&&(o=`${o} ${t}`),Go(`${o}\noutput_file_path: ${e.outputFilePath}\noutput_length: ${e.outputLength.toString()}`)}
    case"stillRunning":{
      const e=s.value,t=n(e);
      let r=ble(e.taskId)?`Task still running after ${(e.runtimeMs??BigInt(0)).toString()}ms...`:"Task still running.";
      e.wakeReason===Ple&&(r=`${r} Wait released early: a new user message is arriving.`);
      return Go(`${t.length>0?`${r} ${t}`:r}\noutput_file_path: ${e.outputFilePath}\noutput_length: ${e.outputLength.toString()}`)}
    case"error":return Go(`Error awaiting task: ${s.value.error}`);
    case void 0:return Go("Unknown error")}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return vle(new vd.$0({
    result:new vd.mK({
      result:{
        case:"error",value:new vd.vH({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:AWAIT:7245570]`。

<a id="agent-code-lineage"></a>

### CODE_LINEAGE

模型名称 / 静态别名：`code_lineage` / `CodeLineage`。证据：`cursor-agent-exec`，工厂 `zle`，UTF-16 偏移 `7261185`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: i,
  descriptionGenerator: e=>'Trace how code was built with AI for files and commits.\n\nTreat this as git blame for AI-built changes: it reveals which conversations produced the code, why it was implemented a certain way, what alternatives were considered, and the intent behind decisions.\n\nWhen to use this tool:\n- The user asks about a file, module, or area of code and wants to understand it deeply -- use this alongside reading the file to add context about how and why it was built.\n- Questions about history, evolution, or recent changes to code (e.g. "tell me about this file", "what\'s changed here recently", "how has this evolved"). For concept-level questions without a specific file (e.g. "how has plan mode evolved?"), first find the relevant files, then use this tool on them.\n- Questions about authorship or decision-making (e.g. "who wrote this", "why is it done this way", "what tradeoffs were made").\n- Before planning changes to existing code, to understand the intent behind the current implementation and avoid undoing deliberate design decisions.\n- When used during planning, surface deliberate design decisions, past reversions, and intentional tradeoffs as constraints. Explain how the proposed changes relate to those prior decisions.\n\nOutput includes conversation context depth:\n- Conversation title / tldr / overview / summary bullets\n- Models used across the conversation and commit-linked sections\n\nQuery shape policy:\n- File-first (`file_paths`) when the user anchor is code location. Always pass repository-relative git paths (for example `backend/server/src/app.ts`), not absolute workspace paths like `/Users/.../projects/repo/backend/server/src/app.ts`.\n- Commit-first (`commit_hashes`) when the user anchor is a change event or narrative.\n- Use both when both anchors are known (high precision, less noise).\n- Use `file_paths` to compare a bounded set of files; use `commit_hashes` for stack/series narrative.\n- For `file_paths`, pass repository-relative git paths (for example, paths shown in `git diff`), not absolute local filesystem paths.\n\nOutput strategy:\n- Start with `output_mode: "summary"` + modest `max_commits`.\n- Pivot to `output_mode: "detailed"` with line ranges once a target section is identified.\n- If file query is empty but activity is expected, pivot to commit query.\n- If commit query is noisy, add file filters.\n\nTranscript fallback:\n- If transcript pointers/context are available and you need deeper decision narrative, inspect transcript snippets after this tool (read in chunks, do not read entire transcript files at once).\n\nReturns commit history with conversation-linked lineage details suitable for code archaeology and implementation-intent analysis.\n',
  parameters: Gle
}

```

</details>

<details>
<summary>参数字段与约束（7 条表达式）</summary>

| 字段（含嵌套与变体）  | 类型 / 约束原式                                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file_paths`          | `ar.YO(ar.Yj()).min(1).optional().describe("File paths to get AI attribution for. Use repository-relative git paths (for example: backend/server/src/app.ts), not absolute workspace paths.")` |
| `start_line`          | `ar.ai().int().positive().optional().describe("Optional start line (1-indexed). If not provided, gets AI attribution for entire file. Applies to all files.")`                                 |
| `end_line`            | `ar.ai().int().positive().optional().describe("Optional end line (1-indexed). If not provided, gets AI attribution to end of file. Applies to all files.")`                                    |
| `commit_hashes`       | `ar.YO(ar.Yj()).min(1).optional().describe("Commit hashes to get AI attribution for. Returns AI conversation summaries for each commit.")`                                                     |
| `output_mode`         | `ar.k5(["summary","detailed"]).optional().describe('Controls output shape and verbosity. Use "summary" for conversation-level rollups and "detailed" for per-commit/per-range output.')`       |
| `max_commits`         | `ar.ai().int().positive().max(200).optional().describe("Optional cap on commits returned after filtering/de-duplication. Must be between 1 and 200.")`                                         |
| `include_line_ranges` | `ar.zM().optional().describe("When false, omit detailed line ranges from attribution output.")`                                                                                                |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Gle=ar.Ik({
  file_paths:ar.YO(ar.Yj()).min(1).optional().describe("File paths to get AI attribution for. Use repository-relative git paths (for example: backend/server/src/app.ts), not absolute workspace paths."),start_line:ar.ai().int().positive().optional().describe("Optional start line (1-indexed). If not provided, gets AI attribution for entire file. Applies to all files."),end_line:ar.ai().int().positive().optional().describe("Optional end line (1-indexed). If not provided, gets AI attribution to end of file. Applies to all files."),commit_hashes:ar.YO(ar.Yj()).min(1).optional().describe("Commit hashes to get AI attribution for. Returns AI conversation summaries for each commit."),output_mode:ar.k5(["summary","detailed"]).optional().describe('Controls output shape and verbosity. Use "summary" for conversation-level rollups and "detailed" for per-commit/per-range output.'),max_commits:ar.ai().int().positive().max(200).optional().describe("Optional cap on commits returned after filtering/de-duplication. Must be between 1 and 200."),include_line_ranges:ar.zM().optional().describe("When false, omit detailed line ranges from attribution output.")}
).refine(e=>{
  const t=(e.file_paths?.length??0)>0,r=(e.commit_hashes?.length??0)>0;
  return t||r}
,{
  message:"Either file_paths or commit_hashes must be provided"}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  if("success"===t.result.case){
    const e=t.result.value;
    if(e.outputLocation)return Go((0,VV.cW)(e.outputLocation,{
      leadText:"AI attribution output"}
    ))}
  return Go(function(e){
    switch(e.result.case){
      case"success":return e.result.value.attributionText;
      case"error":return`Failed to get AI attribution: ${e.result.value.error}`;
      case void 0:return"An unknown error occurred."}
    }
  (t))}

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>jle(new Pu.ex({
  result:new Pu.Zc({
    result:{
      case:"error",value:new Pu.qL({
        error:"Failed to fetch AI attribution data. This may be a temporary issue - please try again later."}
      )}
    }
  )}
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:CODE_LINEAGE:7261185]`。

<a id="agent-create-plan-v2"></a>

### CREATE_PLAN_V2

模型名称 / 静态别名：`CreatePlan` / `mcp_create_plan` / `create_plan`。证据：`cursor-agent-exec`，工厂 `Ade`，UTF-16 偏移 `7308826`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: yce({
    isDsv3Family:"dsv3-1018"===r,usePascalCaseToolNames:"dsv3-1018"!==r}
  ),
  descriptionGenerator: e=>"cursor-0226"!==r||u?E(e.allTools):`Use this tool to create a concise plan for accomplishing the user's request. This tool should be called at the end of the planning phase to finalize and store the plan.\n\nThe plan you create should be properly formatted in markdown, using appropriate sections and headers. The plan should be very concise and actionable, providing the minimum amount of detail for the user to understand and action the plan. It may be helpful to identify the most important couple files you will change, and existing code you will leverage. Cite specific file paths and essential snippets of code. IMPORTANT: Do NOT use markdown tables in plan content (they cannot be rendered for the user); use bullet lists instead. The first line MUST BE A TITLE for the plan formatted as a level 1 markdown heading.\n\nWhen creating your plan, provide, optionally, a structured list of implementation todos:\n- Each todo should be a clear, specific, and actionable task that can be tracked and completed\n- Each todo needs:\n  - A clear, unique ID (e.g., "setup-auth", "implement-ui", "add-tests")\n  - A descriptive content explaining what needs to be done\n\nUPDATING THE PLAN:\n- This tool creates a NEW plan file each time it is called\n- The plan file URI will be returned in the tool result\n- To update an existing plan, read and edit the plan file directly using your file editing tools\n- Do NOT call this tool again to update an existing plan\n\nAdditional guidelines:\n- Avoid asking clarifying questions in the plan itself. Ask them before calling this tool. ${x(e.allTools)}\n- Focus on high-level meaningful decisions rather than low-level implementation details`,
  parameters: w
}

```

</details>

<details>
<summary>参数字段与约束（6 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                        |
| -------------------- | ------------------------------------------------------ |
| `phases`             | `Pde`                                                  |
| `todos`              | `Tde.optional()`                                       |
| `name`               | `ar.Yj().describe("Name of the implementation phase")` |
| `todos`              | `ar.YO(Ide).describe("Todos within this phase")`       |
| `id`                 | `ar.Yj().describe("Unique identifier for the todo")`   |
| `content`            | `ar.Yj().describe("Description of the todo task")`     |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(w=!0===i?g.superRefine((e,t)=>{
  void 0!==e.phases&&e.phases.length>0||t.addIssue({
    code:die.eq.custom,message:"In project mode, 'phases' is required.",path:["phases"]}
  )}
):y)
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  const{
    result:n,planUri:s}
  =t;
  if(s){
    return Go(qj(Pj(Cj,{
      children:[Pj("p",{
        children:["Plan file created at: ",Hle.P.isFileUrl(s)?Hle.P.urlToPath(s):s]}
      ),Tj("p",{
        children:"You can read the plan contents from this file. If at any point you can no longer find it there, the user may have moved it to the workspace .cursor/plans/ directory."}
      ),Tj("p",{
        children:"To update this plan, use your file editing tools directly on this file. The provided to-dos have been added to the file as well in the frontmatter, and should be edited there. Do NOT call create_plan again to update the plan."}
      )]}
    )))}
  switch(n?.case){
    case"success":return Go("Plan created successfully");
    case"error":return Go(`Error: ${n.value.error}`);
    case void 0:return Go("Unknown error");
    default:throw new Error(`Unhandled result case: ${String(n)}`)}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return bde(new G.Ih({
    result:new G.bK({
      result:{
        case:"error",value:new G.iY({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:CREATE_PLAN_V2:7308826]`。

<a id="agent-delete"></a>

### DELETE

模型名称 / 静态别名：`delete_file` / `Delete`。证据：`cursor-agent-exec`，工厂 `qde`，UTF-16 偏移 `7318437`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: i,
  descriptionGenerator: e=>a,
  parameters: o
}

```

</details>

<details>
<summary>参数字段与约束（3 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `target_file`        | `ar.Yj().describe("The path of the file to delete, relative to the workspace root.")`                                            |
| `explanation`        | `ar.Yj().optional().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal.")` |
| `path`               | `ar.Yj().describe("The absolute path of the file to delete")`                                                                    |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(o=function(e){
  switch(e){
    case"dsv3-1018":return Dde;
    case"cursor-0226":case"dsv3-1205":case"latest":case"gpt5-codex":case"codex-cloud":case"haiku":return Bde}
  }
(n=n??"latest"))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,{
  result:t}
,r)=>{
  switch(t.case){
    case"success":return Go(`Successfully deleted file: ${t.value.path} (${Number(t.value.fileSize)} bytes)`);
    case"fileNotFound":return Go(`File not found: ${t.value.path}`);
    case"notFile":return Go(`Path is not a file (${t.value.actualType}): ${t.value.path}`);
    case"permissionDenied":return t.value.isReadonly?Go(XL):Go(`Permission denied: ${t.value.path}`);
    case"fileBusy":return Go(`File is busy: ${t.value.path}`);
    case"error":return Go(`Error deleting file ${t.value.path}: ${t.value.error}`);
    case"rejected":return Go(t.value.reason?`File deletion rejected: ${t.value.reason}`:`File deletion rejected: ${t.value.path}`);
    case void 0:return Go("Unknown error");
    default:throw new Error(`Unhandled result case: ${t}`)}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  if(e instanceof Jde)return Ode(new bg.Y({
    result:new Zf.Pi({
      result:{
        case:"permissionDenied",value:new Zf.QG({
          path:e.path,isReadonly:e.isReadonly}
        )}
      }
    )}
  ));
  if(e instanceof p$)return Ode(new bg.Y({
    result:new Zf.Pi({
      result:{
        case:"rejected",value:new Zf.iq({
          reason:e.message}
        )}
      }
    )}
  ));
  const t=e instanceof Error?e.message:String(e);
  return Ode(new bg.Y({
    result:new Zf.Pi({
      result:{
        case:"error",value:new Zf.GU({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:DELETE:7318437]`。

<a id="agent-apply-patch"></a>

### APPLY_PATCH

模型名称 / 静态别名：`ApplyPatch`。证据：`cursor-agent-exec`，工厂 `tpe`，UTF-16 偏移 `7326875`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "ApplyPatch",
  descriptionGenerator: e=>'Use this tool to edit files.\nYour patch language is a stripped-down, file-oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high-level envelope:\n\n*** Begin Patch\n[ one file section ]\n*** End Patch\n\nWithin that envelope, you get one file operation.\nYou MUST include a header to specify the action you are taking.\nEach operation starts with one of two headers:\n\n*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).\n*** Update File: <path> - patch an existing file in place (optionally with a rename).\n\nThen one or more "hunks", each introduced by @@ (optionally followed by a hunk header).\nWithin a hunk each line starts with:\n\nFor instructions on [context_before] and [context_after]:\n- By default, show 3 lines of code immediately above and 3 lines immediately below each change. If a change is within 3 lines of a previous change, do NOT duplicate the first change\'s [context_after] lines in the second change\'s [context_before] lines.\n- If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, use the @@ operator to indicate the class or function to which the snippet belongs. For instance, we might have:\n@@ class BaseClass\n[3 lines of pre-context]\n- [old_code]\n+ [new_code]\n[3 lines of post-context]\n\n- If a code block is repeated so many times in a class or function such that even a single `@@` statement and 3 lines of context cannot uniquely identify the snippet of code, you can use multiple `@@` statements to jump to the right context. For instance:\n\n@@ class BaseClass\n@@ \tdef method():\n[3 lines of pre-context]\n- [old_code]\n+ [new_code]\n[3 lines of post-context]\n\nThe full grammar definition is below:\nPatch := Begin { FileOp } End\nBegin := "*** Begin Patch" NEWLINE\nEnd := "*** End Patch" NEWLINE\nFileOp := AddFile | UpdateFile\nAddFile := "*** Add File: " path NEWLINE { "+" line NEWLINE }\nUpdateFile := "*** Update File: " path NEWLINE { Hunk }\nHunk := "@@" [ header ] NEWLINE { HunkLine } [ "*** End of File" NEWLINE ]\nHunkLine := (" " | "-" | "+") text NEWLINE\n\nExample for Update File:\n*** Begin Patch\n*** Update File: pygorithm/searching/binary_search.py\n@@ class BaseClass\n@@     def search():\n-          pass\n+          raise NotImplementedError()\n\n@@ class Subclass\n@@     def search():\n-          pass\n+          raise NotImplementedError()\n*** End Patch\n\nExample for Add File:\n*** Begin Patch\n*** Add File: [path/to/file]\n+ [new_code]\n*** End Patch\n\nIt is important to remember:\n- You must only include one file per call\n- You must include a header with your intended action (Add/Update)\n- You must prefix new lines with ` +` even when creating a new file\n\nAll file paths must be absolute paths. Make sure to read the file before applying a patch to get the latest file content, unless you are creating a new file.\n',
  parameters: epe
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                      |
| -------------------- | ---------------------------------------------------- |
| `patch`              | `ar.Yj().describe("The patch to apply to the file")` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "patch": {
      "type": "string",
      "description": "The patch to apply to the file"
    }
  },
  "required": [
    "patch"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(epe=ar.Ik({
  patch:ar.Yj().describe("The patch to apply to the file")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
Wue
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return Uue(new Dg.T6({
    result:new Dg.Kc({
      result:{
        case:"error",value:new Dg.F({
          path:"",error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:APPLY_PATCH:7326875]`。

<a id="agent-edit-notebook"></a>

### EDIT_NOTEBOOK

模型名称 / 静态别名：`edit_notebook` / `EditNotebook`。证据：`cursor-agent-exec`，工厂 `ppe`，UTF-16 偏移 `7338899`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: function(e){
    switch(e){
      case"dsv3-1018":return"edit_notebook";
      case"cursor-0226":case"dsv3-1205":case"latest":case"gpt5-codex":case"codex-cloud":case"haiku":return"EditNotebook";
      default:throw new Error(`Unhandled version: ${e}`)}
    }
  (s),
  descriptionGenerator: e=>"cursor-0226"===s?"Use this tool to edit a jupyter notebook cell.\nCell indices are 0-based. 'old_string' and 'new_string' should be a valid cell content, i.e. WITHOUT any JSON syntax that notebook files use under the hood. If you need to create a new notebook, just set 'is_new_cell' to true and cell_idx to 0.":"Use this tool to edit a jupyter notebook cell. Use ONLY this tool to edit notebooks.\n\nThis tool supports editing existing cells and creating new cells:\n\t- If you need to edit an existing cell, set 'is_new_cell' to false and provide the 'old_string' and 'new_string'.\n\t\t-- The tool will replace ONE occurrence of 'old_string' with 'new_string' in the specified cell.\n\t- If you need to create a new cell, set 'is_new_cell' to true and provide the 'new_string' (and keep 'old_string' empty).\n\t- It's critical that you set the 'is_new_cell' flag correctly!\n\t- This tool does NOT support cell deletion, but you can delete the content of a cell by passing an empty string as the 'new_string'.\n\nOther requirements:\n\t- Cell indices are 0-based.\n\t- 'old_string' and 'new_string' should be a valid cell content, i.e. WITHOUT any JSON syntax that notebook files use under the hood.\n\t- The old_string MUST uniquely identify the specific instance you want to change. This means:\n\t\t-- Include AT LEAST 3-5 lines of context BEFORE the change point\n\t\t-- Include AT LEAST 3-5 lines of context AFTER the change point\n\t- This tool can only change ONE instance at a time. If you need to change multiple instances:\n\t\t-- Make separate calls to this tool for each instance\n\t\t-- Each call must uniquely identify its specific instance using extensive context\n\t- This tool might save markdown cells as \"raw\" cells. Don't try to change it, it's fine. We need it to properly display the diff.\n\t- If you need to create a new notebook, just set 'is_new_cell' to true and cell_idx to 0.\n\t- ALWAYS generate arguments in the following order: target_notebook, cell_idx, is_new_cell, cell_language, old_string, new_string.\n\t- Prefer editing existing cells over creating new ones!\n\t- ALWAYS provide ALL required arguments (including BOTH old_string and new_string). NEVER call this tool without providing 'new_string'.",
  parameters: dpe
}

```

</details>

<details>
<summary>参数字段与约束（6 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_notebook`    | `ar.Yj().describe("The path to the notebook file you want to edit. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is.")` |
| `cell_idx`           | `mle().describe("The index of the cell to edit (0-based)")`                                                                                                                                                 |
| `is_new_cell`        | `vie().describe("If true, a new cell will be created at the specified cell index. If false, the cell at the specified cell index will be edited.")`                                                         |
| `cell_language`      | `ar.Yj().describe("The language of the cell to edit. Should be STRICTLY one of these: 'python', 'markdown', 'javascript', 'typescript', 'r', 'sql', 'shell', 'raw' or 'other'.")`                           |
| `old_string`         | `ar.Yj().describe("The text to replace (must be unique within the cell, and must match the cell contents exactly, including all whitespace and indentation).")`                                             |
| `new_string`         | `ar.Yj().describe("The edited text to replace the old_string or the content for the new cell.")`                                                                                                            |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "target_notebook": {
      "type": "string",
      "description": "The path to the notebook file you want to edit. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is."
    },
    "cell_idx": {
      "type": "number",
      "description": "The index of the cell to edit (0-based)"
    },
    "is_new_cell": {
      "type": "boolean",
      "description": "If true, a new cell will be created at the specified cell index. If false, the cell at the specified cell index will be edited."
    },
    "cell_language": {
      "type": "string",
      "description": "The language of the cell to edit. Should be STRICTLY one of these: 'python', 'markdown', 'javascript', 'typescript', 'r', 'sql', 'shell', 'raw' or 'other'."
    },
    "old_string": {
      "type": "string",
      "description": "The text to replace (must be unique within the cell, and must match the cell contents exactly, including all whitespace and indentation)."
    },
    "new_string": {
      "type": "string",
      "description": "The edited text to replace the old_string or the content for the new cell."
    }
  },
  "required": [
    "target_notebook",
    "cell_idx",
    "is_new_cell",
    "cell_language",
    "old_string",
    "new_string"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(dpe=ar.Ik({
  target_notebook:ar.Yj().describe("The path to the notebook file you want to edit. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is."),cell_idx:mle().describe("The index of the cell to edit (0-based)"),is_new_cell:vie().describe("If true, a new cell will be created at the specified cell index. If false, the cell at the specified cell index will be edited."),cell_language:ar.Yj().describe("The language of the cell to edit. Should be STRICTLY one of these: 'python', 'markdown', 'javascript', 'typescript', 'r', 'sql', 'shell', 'raw' or 'other'."),old_string:ar.Yj().describe("The text to replace (must be unique within the cell, and must match the cell contents exactly, including all whitespace and indentation)."),new_string:ar.Yj().describe("The edited text to replace the old_string or the content for the new cell.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
a
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
Gue
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:EDIT_NOTEBOOK:7338899]`。

<a id="agent-str-replace"></a>

### STR_REPLACE

模型名称 / 静态别名：`search_replace` / `StrReplace`。证据：`cursor-agent-exec`，工厂 `xpe`，UTF-16 偏移 `7349194`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: c,
  descriptionGenerator: e=>function(e,t,r){
    switch(e){
      case"cursor-0226":return"Performs exact string replacements in files.";
      case"dsv3-1018":return"Performs exact string replacements in files.\n\nUsage:\n- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.\n- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n- To create or overwrite a file, you should prefer the write tool.";
      default:{
        const e=ML(t,"WRITE");
        return`Performs exact string replacements in files.\n\nUsage:\n- When editing text, ensure you preserve the exact indentation (tabs/spaces) as it appears before.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if old_string is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replace_all to change every instance of old_string.${r?.isComposer15?"\n- The edit will FAIL if path isn’t given as the first argument. Always provide path first.":""}\n- Use replace_all for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n- Optional parameter: replace_all (boolean, default false) — if true, replaces all occurrences of old_string in the file.\n\nIf you want to create a new file, use the ${e} tool instead.`}
      }
    }
  (s,e.allTools,o),
  parameters: l
}

```

</details>

<details>
<summary>参数字段与约束（6 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file_path`          | `ar.Yj().describe("The path to the file to modify. Always specify the target file as the first argument. You can use either a relative path in the workspace or an absolute path.")` |
| `old_string`         | `ar.Yj().describe("The text to replace")`                                                                                                                                            |
| `new_string`         | `ar.Yj().describe("The text to replace it with (must be different from old_string)")`                                                                                                |
| `replace_all`        | `ar.zM().optional().describe("Replace all occurences of old_string (default false)").default(!1)`                                                                                    |
| `path`               | `ar.Yj().describe("The absolute path to the file to modify")`                                                                                                                        |
| `replace_all`        | `ar.zM().optional().describe("Replace all occurrences of old_string (default false)")`                                                                                               |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(l="dsv3-1018"===s?kpe:Spe)
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
a
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
Gue
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:STR_REPLACE:7349194]`。

<a id="agent-write"></a>

### WRITE

模型名称 / 静态别名：`write` / `Write`。证据：`cursor-agent-exec`，工厂 `Rpe`，UTF-16 偏移 `7356599`。 同一标识有 2 条主实现构造路径，下方逐项保留。

**构造路径 1**

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: l,
  descriptionGenerator: e=>"Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the read_file tool first to read the file's contents.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.",
  parameters: Ape
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `file_path`          | `ar.Yj().describe("The path to the file to modify. Always specify the target file as the first argument. You can use either a relative path in the workspace or an absolute path.")` |
| `contents`           | `ar.Yj().describe("The contents of the file to write")`                                                                                                                              |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Ape=ar.Ik({
  file_path:ar.Yj().describe("The path to the file to modify. Always specify the target file as the first argument. You can use either a relative path in the workspace or an absolute path."),contents:ar.Yj().describe("The contents of the file to write")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
c
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
Gue
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:WRITE:7356599]`。

**构造路径 2**

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: l,
  descriptionGenerator: e=>"cursor-0226"===n?"Writes a file to the local filesystem.":s?.isComposer15?"Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- If this is an existing file, you MUST use the read_file tool first to read the file's contents.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.\n- The write will FAIL if path isn’t given as the first argument. Always provide path first.":"Writes a file to the local filesystem.\n\nUsage:\n- This tool will overwrite the existing file if there is one at the provided path.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.",
  parameters: Ppe
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                               |
| -------------------- | ------------------------------------------------------------- |
| `path`               | `ar.Yj().describe("The absolute path to the file to modify")` |
| `contents`           | `ar.Yj().describe("The contents to write to the file")`       |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Ppe=ar.Ik({
  path:ar.Yj().describe("The absolute path to the file to modify"),contents:ar.Yj().describe("The contents to write to the file")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
c
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
Gue
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:WRITE:7357279]`。

<a id="agent-generate-image"></a>

### GENERATE_IMAGE

模型名称 / 静态别名：`generate_image` / `GenerateImage`。证据：`cursor-agent-exec`，工厂 `dme`，UTF-16 偏移 `7370933`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: c,
  descriptionGenerator: e=>l,
  parameters: Vpe
}

```

</details>

<details>
<summary>参数字段与约束（4 条表达式）</summary>

| 字段（含嵌套与变体）    | 类型 / 约束原式                                                                                                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`           | `ar.Yj().describe("A detailed description of the image.")`                                                                                                                                                                                                                |
| `filename`              | `ar.Yj().optional().describe("Optional filename for the generated image (e.g., 'diagram.png'). Do not include a directory path - the tool automatically handles where to save and how to display the image. If not provided, a timestamped filename will be generated.")` |
| `reference_image_paths` | `ar.YO(ar.Yj()).optional().describe("Optional array of file paths to reference images as additional inputs.")`                                                                                                                                                            |
| `aspect_ratio`          | `ar.k5(["1:1","4:3","3:4","16:9","9:16"]).optional().describe('Optional aspect ratio for the generated image. Supported values are "1:1", "4:3", "3:4", "16:9", and "9:16".')`                                                                                            |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Vpe=ar.Ik({
  description:ar.Yj().describe("A detailed description of the image."),filename:ar.Yj().optional().describe("Optional filename for the generated image (e.g., 'diagram.png'). Do not include a directory path - the tool automatically handles where to save and how to display the image. If not provided, a timestamped filename will be generated."),reference_image_paths:ar.YO(ar.Yj()).optional().describe("Optional array of file paths to reference images as additional inputs."),aspect_ratio:ar.k5(["1:1","4:3","3:4","16:9","9:16"]).optional().describe('Optional aspect ratio for the generated image. Supported values are "1:1", "4:3", "3:4", "16:9", and "9:16".')}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,s)=>{
  let o="internal_error";
  try{
    if("success"===t.result.case){
      const{
        filePath:e,imageData:s}
      =t.result.value,i=n?.env?.artifactsFolder;
      if(i&&e.startsWith(i))return o="success",Go(`Successfully generated image. Display it in your response using:\n<img src="${e}" alt="Generated image" />`);
      if("dsv3-1018"===r||"dsv3-1205"===r||"cursor-0226"===r)return o="success",Go(`Successfully generated image at: ${e}\nAlways use this absolute path when referring to the image. Do not repeat this image as a Markdown reference; it is already displayed to the user.`);
      if(!s)return o="missing_image_data",Go("Failed to generate image: no image data returned");
      const a=s.includes(",")?s.split(",")[1]:s,c=Buffer.from(a,"base64");
      try{
        const t=await(0,di.O5)(c),r=Buffer.from(t.data).toString("base64");
        return o="success",function(e,t,r,n=!1){
          const s=[];
          return r&&s.push({
            type:"text",text:r}
          ),s.push({
            type:"image",data:e,mimeType:t}
          ),{
            content:s,isError:n}
          }
        (r,t.mimeType,`Successfully generated image at: ${e}\nAlways use this absolute path when referring to the image. Do not repeat this image as a Markdown reference; it is already displayed to the user.`)}
      catch(e){
        throw o=function(e){
          if(!(e instanceof Error))return!1;
          const t=e.message.toLowerCase();
          return t.includes("resize")||t.includes("sharp")}
        (e)?"resize_error":"internal_error",e}
      }
    return"error"===t.result.case&&t.result.value.error===XL?(o="success",Go(XL)):(o="success",Go(function(e){
      switch(e.result.case){
        case"success":return`Successfully generated image at: ${e.result.value.filePath}\nAlways use this absolute path when referring to the image. Do not repeat this image as a Markdown reference; it is already displayed to the user.`;
        case"error":return`Failed to generate image, error: ${e.result.value.error}`;
        case void 0:return"An unknown error occurred."}
      }
    (t)))}
  finally{
    !function(e,t){
      Upe.increment(e,1,{
        outcome:t}
      )}
    (e,o)}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof c$?e.clientVisibleErrorMessage:sme(e);
  return Kpe(new z.r9({
    result:new z.k4({
      result:{
        case:"error",value:new z.Ly({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:GENERATE_IMAGE:7370933]`。

<a id="agent-update-pr-code-tour"></a>

### UPDATE_PR_CODE_TOUR

模型名称 / 静态别名：`UpdatePrCodeTour`。证据：`cursor-agent-exec`，工厂 `jme`，UTF-16 偏移 `7384374`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "UpdatePrCodeTour",
  descriptionGenerator: ()=>"Edit the PR code tour for the active PR. Replace markdown, patch a section by heading, attach an image or recording artifact (recordings upload from the VM on attach; the media lands as visible, playable media in a file-anchored section), or regenerate from feedback. In-place edits key by revisionId from <pr_code_tour_context> or GetPrCodeTour; GetPrCodeTour reads the write back. Pass feedback alone to regenerate. Pass baseSha and headSha together to scope regeneration to a commit range.",
  parameters: Lme
}

```

</details>

<details>
<summary>参数字段与约束（11 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feedback`           | `ar.Yj().optional().describe("Natural-language instructions for regenerating the PR code tour, such as 'make it shorter' or 'focus on review risks'. Do not combine with markdown or artifactPath.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `revisionId`         | `ar.Yj().optional().describe("COMPLETE revision id to edit in place. Required for replace, section patch, and attach. From <pr_code_tour_context> or GetPrCodeTour.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `markdown`           | `ar.Yj().optional().describe("Replacement markdown for the whole tour, or the new section body when heading is also set.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `heading`            | `ar.Yj().optional().describe("ATX heading text or slug of the target section. With markdown: replace that section only. With artifactPath: attach the media into that file-anchored section (defaults to the last file-anchored section).")`                                                                                                                                                                                                                                                                                                                                                                                                         |
| `artifactPath`       | `ar.Yj().optional().describe("Media artifact to attach to the revision as visible, playable step media: an image (png/jpeg/gif/webp) or a recording (.mp4/.webm), given as a workspace artifact path (e.g. /opt/cursor/artifacts/demo.mp4) or an artifact URL this agent owns. Images must already be uploaded (walkthrough artifacts upload when referenced in a response or PR body). Recordings upload from the VM on attach, so a recording saved under the artifacts directory can be attached right after it is captured. Provide with revisionId. The attach fails with an actionable error rather than storing media a reader cannot see.")` |
| `artifactAlt`        | `ar.Yj().optional().describe("Optional alt text for an attached artifact; rendered as the media's caption.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `baseSha`            | `ar.Yj().optional().describe("Optional commit-subset base SHA. Provide together with headSha to generate the tour from the baseSha..headSha range instead of the full PR diff.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `headSha`            | `ar.Yj().optional().describe("Optional commit-subset head SHA. Provide together with baseSha to generate the tour from the baseSha..headSha range instead of the full PR diff.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sourceRevisionId`   | `ar.Yj().optional().describe("Revision id to seed regeneration from (see <pr_code_tour_context>). Ignored for in-place edits.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `scopeCommitHashes`  | `ar.YO(ar.Yj()).optional().describe("Commit SHAs selecting a subset of the pull request's commits. When set, the subset selection takes effect for tour regeneration; omit or pass an empty list for the full diff.")`                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `explicitUserPrompt` | `ar.Yj().optional().describe("Verbatim user prompt that takes effect for tour regeneration, kept distinct from agent-authored feedback.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "feedback": {
      "type": "string",
      "description": "Natural-language instructions for regenerating the PR code tour, such as 'make it shorter' or 'focus on review risks'. Do not combine with markdown or artifactPath."
    },
    "revisionId": {
      "type": "string",
      "description": "COMPLETE revision id to edit in place. Required for replace, section patch, and attach. From <pr_code_tour_context> or GetPrCodeTour."
    },
    "markdown": {
      "type": "string",
      "description": "Replacement markdown for the whole tour, or the new section body when heading is also set."
    },
    "heading": {
      "type": "string",
      "description": "ATX heading text or slug of the target section. With markdown: replace that section only. With artifactPath: attach the media into that file-anchored section (defaults to the last file-anchored section)."
    },
    "artifactPath": {
      "type": "string",
      "description": "Media artifact to attach to the revision as visible, playable step media: an image (png/jpeg/gif/webp) or a recording (.mp4/.webm), given as a workspace artifact path (e.g. /opt/cursor/artifacts/demo.mp4) or an artifact URL this agent owns. Images must already be uploaded (walkthrough artifacts upload when referenced in a response or PR body). Recordings upload from the VM on attach, so a recording saved under the artifacts directory can be attached right after it is captured. Provide with revisionId. The attach fails with an actionable error rather than storing media a reader cannot see."
    },
    "artifactAlt": {
      "type": "string",
      "description": "Optional alt text for an attached artifact; rendered as the media's caption."
    },
    "baseSha": {
      "type": "string",
      "description": "Optional commit-subset base SHA. Provide together with headSha to generate the tour from the baseSha..headSha range instead of the full PR diff."
    },
    "headSha": {
      "type": "string",
      "description": "Optional commit-subset head SHA. Provide together with baseSha to generate the tour from the baseSha..headSha range instead of the full PR diff."
    },
    "sourceRevisionId": {
      "type": "string",
      "description": "Revision id to seed regeneration from (see <pr_code_tour_context>). Ignored for in-place edits."
    },
    "scopeCommitHashes": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Commit SHAs selecting a subset of the pull request's commits. When set, the subset selection takes effect for tour regeneration; omit or pass an empty list for the full diff."
    },
    "explicitUserPrompt": {
      "type": "string",
      "description": "Verbatim user prompt that takes effect for tour regeneration, kept distinct from agent-authored feedback."
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Lme=ar.Ik({
  feedback:ar.Yj().optional().describe("Natural-language instructions for regenerating the PR code tour, such as 'make it shorter' or 'focus on review risks'. Do not combine with markdown or artifactPath."),revisionId:ar.Yj().optional().describe("COMPLETE revision id to edit in place. Required for replace, section patch, and attach. From <pr_code_tour_context> or GetPrCodeTour."),markdown:ar.Yj().optional().describe("Replacement markdown for the whole tour, or the new section body when heading is also set."),heading:ar.Yj().optional().describe("ATX heading text or slug of the target section. With markdown: replace that section only. With artifactPath: attach the media into that file-anchored section (defaults to the last file-anchored section)."),artifactPath:ar.Yj().optional().describe("Media artifact to attach to the revision as visible, playable step media: an image (png/jpeg/gif/webp) or a recording (.mp4/.webm), given as a workspace artifact path (e.g. /opt/cursor/artifacts/demo.mp4) or an artifact URL this agent owns. Images must already be uploaded (walkthrough artifacts upload when referenced in a response or PR body). Recordings upload from the VM on attach, so a recording saved under the artifacts directory can be attached right after it is captured. Provide with revisionId. The attach fails with an actionable error rather than storing media a reader cannot see."),artifactAlt:ar.Yj().optional().describe("Optional alt text for an attached artifact; rendered as the media's caption."),baseSha:ar.Yj().optional().describe("Optional commit-subset base SHA. Provide together with headSha to generate the tour from the baseSha..headSha range instead of the full PR diff."),headSha:ar.Yj().optional().describe("Optional commit-subset head SHA. Provide together with baseSha to generate the tour from the baseSha..headSha range instead of the full PR diff."),sourceRevisionId:ar.Yj().optional().describe("Revision id to seed regeneration from (see <pr_code_tour_context>). Ignored for in-place edits."),scopeCommitHashes:ar.YO(ar.Yj()).optional().describe("Commit SHAs selecting a subset of the pull request's commits. When set, the subset selection takes effect for tour regeneration; omit or pass an empty list for the full diff."),explicitUserPrompt:ar.Yj().optional().describe("Verbatim user prompt that takes effect for tour regeneration, kept distinct from agent-authored feedback.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(function(e){
  switch(e.result.case){
    case"success":return e.result.value.message;
    case"error":return`Error updating PR code tour: ${e.result.value.error}`;
    case void 0:return"Unknown PR code tour update result";
    default:{
      const t=e.result;
      throw new Error(`Unhandled result case: ${String(t)}`)}
    }
  }
(t))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return $me(new dJ.Pk({
    result:new dJ.Ql({
      result:{
        case:"error",value:new dJ.Z({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:UPDATE_PR_CODE_TOUR:7384374]`。

<a id="agent-get-pr-code-tour"></a>

### GET_PR_CODE_TOUR

模型名称 / 静态别名：`GetPrCodeTour`。证据：`cursor-agent-exec`，工厂 `Xme`，UTF-16 偏移 `7392337`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "GetPrCodeTour",
  descriptionGenerator: ()=>"Read the PR code tour revisions for the active PR. Without revisionId, lists revision metadata (id, status, head sha, feedback). With revisionId, returns a per-section breakdown (patchable headings, file anchors, media) followed by that revision's full markdown. Section media kinds: image and recording render inline for readers; pending_artifact is a legacy unresolved attach comment that readers cannot see — re-attach it with UpdatePrCodeTour artifactPath to make it visible. Use before UpdatePrCodeTour when you need the current tour content.",
  parameters: Wme
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revisionId`         | `ar.Yj().optional().describe("Revision id from <pr_code_tour_context> or a previous GetPrCodeTour call. Omit to list all revisions for the active PR.")` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "revisionId": {
      "type": "string",
      "description": "Revision id from <pr_code_tour_context> or a previous GetPrCodeTour call. Omit to list all revisions for the active PR."
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Wme=ar.Ik({
  revisionId:ar.Yj().optional().describe("Revision id from <pr_code_tour_context> or a previous GetPrCodeTour call. Omit to list all revisions for the active PR.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(function(e){
  switch(e.result.case){
    case"success":{
      const t=e.result.value.revisions;
      if(0===t.length)return"No PR code tour revisions found.";
      if(1===t.length&&t[0]?.markdown.length>0){
        const e=t[0];
        return[Yme(e),Qme(e.markdown),e.markdown].filter(e=>void 0!==e).join("\n\n")}
      return t.map(Yme).join("\n")}
    case"error":return`Error reading PR code tour: ${e.result.value.error}`;
    case void 0:return"Unknown PR code tour read result";
    default:{
      const t=e.result;
      throw new Error(`Unhandled result case: ${String(t)}`)}
    }
  }
(t))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return Hme(new Iw.SQ({
    result:Kme(t)}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:GET_PR_CODE_TOUR:7392337]`。

<a id="agent-glob"></a>

### GLOB

模型名称 / 静态别名：`glob_file_search` / `Glob`。证据：`cursor-agent-exec`，工厂 `uhe`，UTF-16 偏移 `7399130`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: n,
  descriptionGenerator: e=>"\nTool to search for files matching a glob pattern\n\n- Works fast with codebases of any size\n- Returns matching file paths sorted by modification time\n- Use this tool when you need to find files by name patterns\n- You have the capability to call multiple tools in a single response. It is always better to speculatively perform multiple searches that are potentially useful as a batch.\n",
  parameters: s
}

```

</details>

<details>
<summary>参数字段与约束（4 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_directory`   | `ar.Yj().optional().describe("Path to directory to search for files in. If not provided, defaults to Cursor workspace roots.")`                                                                                                                                                                                                                                                       |
| `glob_pattern`       | `ar.Yj().describe('The glob pattern to match files against.\nPatterns not starting with "**/" are automatically prepended with "**/" to enable recursive searching.\n\nExamples:\n\t- "*.js" (becomes "**/*.js") - find all .js files\n\t- "**/node_modules/**" - find all node_modules directories\n\t- "**/test/**/test_*.ts" - find all test_*.ts files in any test directory\n')` |
| `target_directory`   | `ar.Yj().optional().describe("Absolute path to directory to search for files in. If not provided, defaults to Cursor workspace root.")`                                                                                                                                                                                                                                               |
| `glob_pattern`       | `ar.Yj().describe('The glob pattern to match files against.\nPatterns not starting with "**/" are automatically prepended with "**/" to enable recursive searching.\n\nExamples:\n\t- "*.js" (becomes "**/*.js") - find all .js files\n\t- "**/node_modules/**" - find all node_modules directories\n\t- "**/test/**/test_*.ts" - find all test_*.ts files in any test directory')`   |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(s=function(e){
  switch(e){
    case"dsv3-1018":return ahe;
    case"cursor-0226":case"dsv3-1205":case"latest":case"gpt5-codex":case"codex-cloud":case"haiku":return ihe;
    default:throw new Error(`Unhandled version: ${e}`)}
  }
(t))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(function(e,t){
  if("error"===e.result.case)return s$(e.result.value.error,che,!0).output;
  if("success"!==e.result.case)return"glob_file_search didn't return the result";
  const r=e.result.value;
  let n="";
  const s=t.replace(/\/$/,""),o=r.files.map(e=>{
    if("."===s)return e.replace(/^\.\/?/,"");
    const t=`${s.replace(/\/$/,"")}/`;
    return e.startsWith(t)?e.slice(t.length):e}
  );
  if(0===o.length)n+=`Result of search in '${t}': 0 files found\n`;
  else{
    n+=`Result of search in '${t}'`,!0!==r.ripgrepTruncated&&(n+=` (total ${r.totalFiles} file${1===r.totalFiles?"":"s"})`),n+=":\n";
    const e=che;
    for(let t=0;
    t<o.length;
    t++){
      const s=o[t];
      if(n.length+s.length>e){
        const e=Math.max(0,r.totalFiles-t);
        r.ripgrepTruncated?n+=`... at least ${e} more files ... (Do a more specific search if needed)\n`:n+=`... ${e} more files ... (Do a more specific search if needed)\n`;
        break}
      n+=`- ${s}\n`}
    }
  return n}
(t,"success"===t.result.case?t.result.value.path??".":"."))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=s$(e instanceof Error?e.message:String(e),che,!0).output;
  return ohe(new Fw.FM({
    result:new Fw.g1({
      result:{
        case:"error",value:new Fw.NU({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:GLOB:7399130]`。

<a id="agent-create-goal"></a>

### CREATE_GOAL

模型名称 / 静态别名：`CreateGoal`。证据：`cursor-agent-exec`，工厂 `bhe`，UTF-16 偏移 `7403133`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "CreateGoal",
  descriptionGenerator: ()=>"Create a long-running goal. Only use this tool when explicitly requested by the user; NEVER use this tool for ordinary tasks.",
  parameters: hhe
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式         |
| -------------------- | ----------------------- |
| `objective`          | `ar.Yj().trim().min(1)` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "objective": {
      "type": "string",
      "minLength": 1
    }
  },
  "required": [
    "objective"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(hhe=ar.Ik({
  objective:ar.Yj().trim().min(1)}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  switch(t.result.case){
    case"success":return Go("Goal created");
    case"error":return Go(`Error creating goal: ${t.result.value.error}`);
    case void 0:return Go("CreateGoal returned no result");
    default:{
      const e=t.result;
      throw new Error(`Unhandled CreateGoal result: ${String(e)}`)}
    }
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>whe(new Xw.GS({
  result:new Xw.dl({
    result:{
      case:"error",value:new Xw.uQ({
        error:e instanceof Error?e.message:String(e)}
      )}
    }
  )}
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:CREATE_GOAL:7403133]`。

<a id="agent-update-goal"></a>

### UPDATE_GOAL

模型名称 / 静态别名：`UpdateGoal`。证据：`cursor-agent-exec`，工厂 `bhe`，UTF-16 偏移 `7404506`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "UpdateGoal",
  descriptionGenerator: ()=>"Update the existing goal's status. Set status to `complete` only when the objective has actually been achieved and no required work remains, unless the user explicitly requests to stop the goal. You cannot use this tool to pause a goal; that is controlled by the user. However, if the user paused and asks you to resume, you can set it to `active`.",
  parameters: fhe
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式 |
| -------------------- | --------------- |
| `status`             | `ar.k5(dhe)`    |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": [
        "active",
        "complete"
      ]
    }
  },
  "required": [
    "status"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(fhe=ar.Ik({
  status:ar.k5(dhe)}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(t,r,n)=>{
  switch(r.result.case){
    case"success":return Go(ghe(r.result.value.status,e.goalState));
    case"error":return Go(`Error updating goal: ${r.result.value.error}`);
    case void 0:return Go("UpdateGoal returned no result");
    default:{
      const e=r.result;
      throw new Error(`Unhandled UpdateGoal result: ${String(e)}`)}
    }
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>vhe(new Xw.Ll({
  result:new Xw.KD({
    result:{
      case:"error",value:new Xw.uQ({
        error:e instanceof Error?e.message:String(e)}
      )}
    }
  )}
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:UPDATE_GOAL:7404506]`。

<a id="agent-grep"></a>

### GREP

模型名称 / 静态别名：`grep` / `Grep` / `rg`。证据：`cursor-agent-exec`，工厂 `Lhe`，UTF-16 偏移 `7421899`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: c,
  descriptionGenerator: e=>l,
  parameters: u
}

```

</details>

<details>
<summary>参数字段与约束（16 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pattern`            | `ar.Yj().describe("The regular expression pattern to search for in file contents (rg --regexp)")`                                                                                                                                                                                                                                       |
| `path`               | `ar.Yj().optional().describe("File or directory to search in (rg pattern -- PATH). Defaults to Cursor workspace roots.")`                                                                                                                                                                                                               |
| `glob`               | `ar.Yj().optional().describe('Glob pattern (rg --glob GLOB -- PATH) to filter files (e.g. "*.js", "*.{ts,tsx}").')`                                                                                                                                                                                                                     |
| `output_mode`        | `ar.k5(["content","files_with_matches","count"]).describe('Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "content".').default("content").optional()` |
| `-B`                 | `mle().optional().describe('Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.')`                                                                                                                                                                                                   |
| `-A`                 | `mle().optional().describe('Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.')`                                                                                                                                                                                                    |
| `-C`                 | `mle().optional().describe('Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.')`                                                                                                                                                                                         |
| `-i`                 | `ar.vk(Nhe,ar.zM().optional().describe("Case insensitive search (rg -i) Defaults to false").default(!1))`                                                                                                                                                                                                                               |
| `type`               | `ar.Yj().optional().describe("File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than glob for standard file types.")`                                                                                                                                                                          |
| `head_limit`         | `mle(ar.ai().min(0)).optional().describe('Limit output size. For "content" mode: limits total matches shown. For "files_with_matches" and "count" modes: limits number of files.')`                                                                                                                                                     |
| `offset`             | `mle(ar.ai().min(0)).optional().describe('Skip first N entries. For "content" mode: skips first N matches. For "files_with_matches" and "count" modes: skips first N files. Use with head_limit for pagination.')`                                                                                                                      |
| `multiline`          | `ar.vk(Nhe,ar.zM().optional().describe("Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.").default(!1))`                                                                                                                                                          |
| `pattern`            | `ar.Yj().describe("The regular expression pattern to search for in file contents")`                                                                                                                                                                                                                                                     |
| `path`               | `ar.Yj().optional().describe("File or directory to search in (rg pattern -- PATH). Defaults to Cursor workspace root.")`                                                                                                                                                                                                                |
| `glob`               | `ar.Yj().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob')`                                                                                                                                                                                                                           |
| `type`               | `ar.Yj().optional().describe("File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.")`                                                                                                                                                                       |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(u="dsv3-1018"===t?Uhe:Fhe)
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,n)=>{
  const s=Go(The(t));
  if(!0===r?.boostSemanticSearch&&!a&&"success"===t.result.case){
    const r=t.result.value.pattern.split("|").length;
    if(r>=i){
      const t=n.allTools.SEMANTIC_SEARCH,o=n.allTools.GREP;
      if(t&&o)return a=!0,Bhe.info(e,"Showing semantic search reminder for Grep result",{
        pipeAlternatives:r,semanticSearchReminderMinPatterns:i}
      ),zo(s,`For how/where/what questions or searches that involve multiple possible terms, prefer \`${t.name}\` or use in parallel with \`${o.name}\`. It searches by meaning, so it can find relevant code that exact-text search misses. This can be faster than using many \`${o.name}\` calls.`)}
    }
  return s}

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=s$(e instanceof Error?e.message:String(e),Ehe,!0).output;
  return qhe(new Hv.j({
    result:new Iv.Ud({
      result:{
        case:"error",value:new Iv.ts({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:GREP:7421899]`。

<a id="agent-ls"></a>

### LS

模型名称 / 静态别名：`list_dir` / `LS`。证据：`cursor-agent-exec`，工厂 `Hhe`，UTF-16 偏移 `7427857`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: n,
  descriptionGenerator: e=>s,
  parameters: Whe
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `target_directory`   | `ar.Yj().describe("Path to directory to list contents of.")`                                                                                                                                                                                                                                                                                                                                                                         |
| `ignore_globs`       | `ar.YO(ar.Yj()).optional().describe('Optional array of glob patterns to ignore.\nAll patterns match anywhere in the target directory. Patterns not starting with "**/" are automatically prepended with "**/".\n\nExamples:\n\t- "*.js" (becomes "**/*.js") - ignore all .js files\n\t- "**/node_modules/**" - ignore all node_modules directories\n\t- "**/test/**/test_*.ts" - ignore all test_*.ts files in any test directory')` |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Whe=ar.Ik({
  target_directory:ar.Yj().describe("Path to directory to list contents of."),ignore_globs:ar.YO(ar.Yj()).optional().describe('Optional array of glob patterns to ignore.\nAll patterns match anywhere in the target directory. Patterns not starting with "**/" are automatically prepended with "**/".\n\nExamples:\n\t- "*.js" (becomes "**/*.js") - ignore all .js files\n\t- "**/node_modules/**" - ignore all node_modules directories\n\t- "**/test/**/test_*.ts" - ignore all test_*.ts files in any test directory')}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  let n;
  if(void 0===t.result.case)n="Tool call unexpectedly didn't return result. Try using terminal command to list the directory instead.";
  else switch(t.result.case){
    case"success":case"timeout":if(!t.result.value.directoryTreeRoot){
      n="Tool call unexpectedly didn't return result. Try using terminal command to list the directory instead.";
      break}
    n=function(e){
      if(e.childrenWereProcessed&&0===e.childrenDirs.length&&0===e.childrenFiles.length){
        const t=e.absPath.endsWith("/")?"":"/";
        return`${e.absPath}${t}\n... no children found ...`}
      const t=1e4,r=wz(e,t);
      let n=r.result;
      const s=[];
      if(r.atLeastOneExtensionCountRendered&&s.push("File extension counts do not include files ignored by .gitignore."),!e.childrenWereProcessed||n.length>t){
        if(n.length>t){
          n=n.slice(0,t);
          const e=n.lastIndexOf("\n");
          e>0&&(n=n.slice(0,e+1))}
        n+="    ...\n",s.push("target_directory is too large (either too many children or their names are too long). Immediate children were truncated. Try doing more specific search or use terminal tool.")}
      return 1===s.length?n+=`\nNote: ${s[0]}`:s.length>1&&(n+=`\nNote:\n - ${s.join("\n - ")}`),n}
    (t.result.value.directoryTreeRoot),"timeout"===t.result.case&&(n+="\n\nNote: The operation timed out after 5 seconds. The result is incomplete.");
    break;
    case"error":n=`Error listing directory: ${t.result.value.error}`;
    break;
    case"rejected":n=`Rejected: ${t.result.value.reason}`;
    break;
    default:t.result;
    throw new Error("Unexpected result case")}
  return Go(n)}

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  if(e instanceof zhe)return Ghe(new bb.q({
    result:new Zv.fv({
      result:{
        case:"timeout",value:new Zv.ze({
          directoryTreeRoot:e.directoryTreeRoot}
        )}
      }
    )}
  ));
  const t=e instanceof Error?e.message:String(e);
  let r=new Zv.fv({
    result:{
      case:"error",value:new Zv.uj({
        error:t}
      )}
    }
  );
  return e instanceof p$&&(r=new Zv.fv({
    result:{
      case:"rejected",value:new Zv.k2({
        reason:e.message}
      )}
    }
  )),Ghe(new bb.q({
    result:r}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:LS:7427857]`。

<a id="agent-mini-swe-agent-bash"></a>

### MINI_SWE_AGENT_BASH

模型名称 / 静态别名：`bash`。证据：`cursor-agent-exec`，工厂 `rfe`，UTF-16 偏移 `7435007`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "bash",
  descriptionGenerator: ()=>"Execute a bash command",
  parameters: Zhe
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                   |
| -------------------- | ------------------------------------------------- |
| `command`            | `ar.Yj().describe("The bash command to execute")` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "The bash command to execute"
    }
  },
  "required": [
    "command"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Zhe=ar.Ik({
  command:ar.Yj().describe("The bash command to execute")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(tfe(t))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return Vhe(new sM.$M({
    result:new hR.W4({
      result:{
        case:"spawnError",value:new hR.mJ({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:MINI_SWE_AGENT_BASH:7435007]`。

<a id="agent-mock-read-lints"></a>

### MOCK_READ_LINTS

模型名称 / 静态别名：`read_lints` / `ReadLints`。证据：`cursor-agent-exec`，工厂 `afe`，UTF-16 偏移 `7437776`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "dsv3-1018"===(t=t??"latest")?"read_lints":"ReadLints",
  descriptionGenerator: e=>"Read and display linter errors from the current workspace. You can provide paths to specific files or directories, or omit the argument to get diagnostics for all files.\n\n- If a file path is provided, returns diagnostics for that file only\n- If a directory path is provided, returns diagnostics for all files within that directory\n- If no path is provided, returns diagnostics for all files in the workspace\n- This tool can return linter errors that were already present before your edits, so avoid calling it with a very wide scope of files\n- NEVER call this tool on a file unless you've edited it or are about to edit it",
  parameters: ife
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths`              | `Nre(ar.YO(ar.Yj()),{field:"paths",primitiveItems:!0}).optional().describe("Optional. An array of paths to files or directories to read linter errors for. You can use either relative paths in the workspace or absolute paths. If provided, returns diagnostics for the specified files/directories only. If not provided, returns diagnostics for all files in the workspace.")` |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(ife=ar.Ik({
  paths:Nre(ar.YO(ar.Yj()),{
    field:"paths",primitiveItems:!0}
  ).optional().describe("Optional. An array of paths to files or directories to read linter errors for. You can use either relative paths in the workspace or absolute paths. If provided, returns diagnostics for the specified files/directories only. If not provided, returns diagnostics for all files in the workspace.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,{
  result:t}
,r)=>{
  switch(t.case){
    case"success":return Go("No linter errors found.");
    case"error":return Go(`Error: ${t.value.errorMessage}`);
    case void 0:return Go("Unknown error");
    default:throw new Error(`Unhandled result case: ${t}`)}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return ofe(new Mx.pP({
    result:new Mx.Qi({
      result:{
        case:"error",value:new Mx.Tm({
          errorMessage:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:MOCK_READ_LINTS:7437776]`。

<a id="agent-read"></a>

### READ

模型名称 / 静态别名：`ViewImage` / `read_file` / `ReadFile` / `Read`。证据：`cursor-agent-exec`，工厂 `Hfe`，UTF-16 偏移 `7455378`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: g,
  descriptionGenerator: e=>y,
  parameters: w
}

```

</details>

<details>
<summary>参数字段与约束（7 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`               | `ar.Yj().describe("The absolute path of the image to view.")`                                                                                                                                                                   |
| `target_file`        | `ar.Yj().describe("The path of the file to read. You can use either a relative path in the workspace or an absolute path. If an absolute path is provided, it will be preserved as is.")`                                       |
| `offset`             | `$fe({requireInt:!0})`                                                                                                                                                                                                          |
| `limit`              | `jfe({requireInt:!0})`                                                                                                                                                                                                          |
| `path`               | `ar.Yj().describe("The absolute path of the file to read.")`                                                                                                                                                                    |
| `line_range`         | `ar.YO(ar.ai().int()).min(2).max(2).optional().describe("Optional. A two-element array [start_line, end_line] specifying the range of lines to read (1-indexed, inclusive). Example: [100, 150] reads lines 100 through 150.")` |
| `offset`             | `$fe({requireInt:!0,includeNegativeOffset:t})`                                                                                                                                                                                  |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(w=x$(a?ar.Ik({
  path:ar.Yj().describe("The absolute path of the image to view.")}
):Wfe({
  version:r,includeEnableLineNumbers:o,includeNegativeOffset:i,useSparseReadLineNumbers:l}
),n?.machineIds,n?.machineIdParameterSchema))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,{
  result:r}
,n)=>{
  const s=new Map;
  if("success"===r?.case){
    const t=r.value.output?.case;
    if("dataBlobId"===t||"contentBlobId"===t){
      const t=r.value.output.value;
      if(!n.blobStore)throw new Error("Cannot hydrate blobs for tool Read: no blob store available");
      {
        const r=Gj(t),o=await n.blobStore.getBlob(e,t);
        if(!o)throw new Error(`Failed to hydrate blob ${r} for tool Read`);
        s.set(r,o)}
      }
    }
  if(!r)return Go("Unknown error",!0);
  const i=(e,t)=>{
    const r=Sz(e,t);
    return{
      content:[{
        type:"text",text:`Read image file: ${t}`}
      ,{
        type:"image",data:Buffer.from(e).toString("base64"),mimeType:r}
      ],isError:!1}
    }
  ;
  switch(r.case){
    case"success":if(r.value.isEmpty)return Go("File is empty.");
    if(r.value.exceededLimit)return Go(`File content (${r.value.fileSize} characters) exceeds maximum allowed characters (100000 characters).\nPlease use offset and limit parameters to read specific portions of the file, or use the 'grep' tool to search for specific content.`);
    {
      const e=r.value.output;
      if(!e)return Go("Unknown error: no output",!0);
      switch(e.case){
        case"content":case"contentBlobId":{
          let n;
          if("content"===e.case)n=e.value;
          else{
            const t=Gj(e.value),o=s.get(t);
            if(!o)throw new Error(`Content blob not hydrated for render: ${t} (path: ${r.value.path})`);
            n=Lj.deserialize(o)}
          const i=r.value.path,a=r.value.totalLines,c=r.value.readRange?.startLine??1;
          if(pfe(i)){
            const e=dfe(n),t=d(p(r.value)),s=f(h(r.value));
            let o=e;
            return t&&(o=`${o}\n\n${t}`),s&&(o=`${o}\n\n${s}`),Go(o)}
          const u=r.value.includeLineNumbers??(!o&&(t.enableLineNumbers??!1)),m=gz({
            content:n,filePath:i,startLineNumber:c,totalLineNumbersInFile:a,formattingOptions:{
              ...t,gpt5StyleLineNumbers:!l&&t.gpt5StyleLineNumbers,gpt5CodexCatN:!l&&t.gpt5CodexCatN,enableLineNumbers:u,sparseLineNumbers:l?10:t.sparseLineNumbers}
            }
          ,{
            addAmountOfOmittedLines:void 0!==r.value.readRange&&(r.value.readRange.startLine>1||r.value.readRange.endLine<a)}
          ),g=d(p(r.value)),y=f(h(r.value));
          let w=m;
          return g&&(w=`${w}\n\n${g}`),y&&(w=`${w}\n\n${y}`),Go(w)}
        case"data":return i(e.value,r.value.path);
        case"dataBlobId":{
          const t=e.value,{
            path:n}
          =r.value,o=Gj(t),a=s.get(o);
          if(!a)throw new Error(`Image blob not hydrated for render: ${o} (path: ${n})`);
          return i(a,n)}
        case void 0:return Go("Unknown error: no output case",!0);
        default:throw new Error(`Unhandled output case: ${e}`)}
      }
    case"error":return Go(`Error: ${r.value.errorMessage}`,!0);
    case void 0:return Go("Unknown error",!0);
    default:throw new Error(`Unhandled result case: ${r}`)}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return Ffe(new iE.D8({
    result:new iE.uX({
      result:{
        case:"error",value:new iE.vO({
          errorMessage:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:READ:7455378]`。

<a id="agent-read-lints"></a>

### READ_LINTS

模型名称 / 静态别名：`read_lints` / `ReadLints`。证据：`cursor-agent-exec`，工厂 `tge`，UTF-16 偏移 `7468138`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: o,
  descriptionGenerator: e=>i,
  parameters: ege
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paths`              | `Nre(ar.YO(ar.Yj()),{field:"paths",primitiveItems:!0}).optional().describe("Optional. An array of paths to files or directories to read linter errors for. You can use either relative paths in the workspace or absolute paths. If provided, returns diagnostics for the specified files/directories only. If not provided, returns diagnostics for all files in the workspace.")` |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(ege=ar.Ik({
  paths:Nre(ar.YO(ar.Yj()),{
    field:"paths",primitiveItems:!0}
  ).optional().describe("Optional. An array of paths to files or directories to read linter errors for. You can use either relative paths in the workspace or absolute paths. If provided, returns diagnostics for the specified files/directories only. If not provided, returns diagnostics for all files in the workspace.")}
).passthrough())
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,{
  result:r}
,n)=>{
  switch(r.case){
    case"success":{
      const e=r.value;
      if(0===e.totalDiagnostics)return Go("No linter errors found.");
      const n=[];
      let s=!1;
      const o="dsv3-1018"!==t,i=o?"L":"Line ";
      for(const t of e.fileDiagnostics)if(t.diagnosticsCount>0){
        n.push(`\n${t.path} (${t.diagnosticsCount} error${t.diagnosticsCount>1?"s":""}):`);
        for(const e of t.diagnostics){
          const t=e.severity===cue.h_.ERROR?"ERROR":e.severity===cue.h_.WARNING?"WARNING":e.severity===cue.h_.INFORMATION?"INFO":"HINT",r=!0===e.isStale&&o?", stale":"";
          !0===e.isStale&&(s=!0),n.push(`  [${t}] ${i}${e.range?.start?.line??0}:${e.range?.start?.column??0} - ${e.message}${e.source?` (${e.source})`:""}${r}`)}
        }
      const a=Go(`Found ${e.totalDiagnostics} linter error${e.totalDiagnostics>1?"s":""} in ${e.totalFiles} file${e.totalFiles>1?"s":""}:${n.join("\n")}`);
      return s&&"dsv3-1018"!==t?zo(a,'Lints marked "stale" were computed on an older version of the file, and may be outdated.'):a}
    case"error":return Go(`Error: ${r.value.errorMessage}`);
    case void 0:return Go("Unknown error");
    default:throw new Error(`Unhandled result case: ${r}`)}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return Qfe(new Mx.pP({
    result:Zfe(t)}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:READ_LINTS:7468138]`。

<a id="agent-record-ci-investigation-findings"></a>

### RECORD_CI_INVESTIGATION_FINDINGS

模型名称 / 静态别名：`record_ci_investigation_findings`。证据：`cursor-agent-exec`，工厂 `lge`，UTF-16 偏移 `7475208`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "record_ci_investigation_findings",
  descriptionGenerator: ()=>"Record structured CI investigation results for the Checks panel after subagent investigation completes. Call once per investigation turn with one finding per failing check and an optional overall summary. Does not modify the repo or storage; findings are read from this tool call by the UI.",
  parameters: ige
}

```

</details>

<details>
<summary>参数字段与约束（20 条表达式）</summary>

| 字段（含嵌套与变体）        | 类型 / 约束原式                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findings`                  | `ar.YO(sge).min(1).describe("One entry per failing CI check investigated. checkName and detailsUrl must match the check identity from the prompt verbatim.")` |
| `overall`                   | `oge.optional().describe("Optional cross-check summary when multiple checks were investigated in one turn.")`                                                 |
| `checkName`                 | `ar.Yj().min(1)`                                                                                                                                              |
| `detailsUrl`                | `ar.Yj().optional()`                                                                                                                                          |
| `tldr`                      | `ar.Yj().min(1)`                                                                                                                                              |
| `rootCause`                 | `ar.Yj().optional()`                                                                                                                                          |
| `failingSignal`             | `ar.Yj().optional()`                                                                                                                                          |
| `suggestedNextStep`         | `ar.Yj().optional()`                                                                                                                                          |
| `diffRelation`              | `ar.k5(["related","unrelated","unknown"]).optional()`                                                                                                         |
| `diffRelationEvidence`      | `ar.Yj().optional()`                                                                                                                                          |
| `flakeAssessment`           | `ar.k5(["likely","unlikely","unknown"]).optional()`                                                                                                           |
| `flakeEvidence`             | `ar.Yj().optional()`                                                                                                                                          |
| `rerunAvailable`            | `ar.zM().optional()`                                                                                                                                          |
| `rerunEvidence`             | `ar.Yj().optional()`                                                                                                                                          |
| `recommendedAction`         | `ar.k5(["fix","rerun","wait","ignore","ask","investigate"]).optional()`                                                                                       |
| `recommendedActionEvidence` | `ar.Yj().optional()`                                                                                                                                          |
| `confidence`                | `ar.k5(["high","medium","low"]).optional()`                                                                                                                   |
| `summary`                   | `ar.Yj().min(1)`                                                                                                                                              |
| `themes`                    | `ar.YO(ar.Yj()).optional()`                                                                                                                                   |
| `checkKeys`                 | `ar.YO(ar.Yj()).optional()`                                                                                                                                   |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "checkName": {
            "type": "string",
            "minLength": 1
          },
          "detailsUrl": {
            "type": "string"
          },
          "tldr": {
            "type": "string",
            "minLength": 1
          },
          "rootCause": {
            "type": "string"
          },
          "failingSignal": {
            "type": "string"
          },
          "suggestedNextStep": {
            "type": "string"
          },
          "diffRelation": {
            "type": "string",
            "enum": [
              "related",
              "unrelated",
              "unknown"
            ]
          },
          "diffRelationEvidence": {
            "type": "string"
          },
          "flakeAssessment": {
            "type": "string",
            "enum": [
              "likely",
              "unlikely",
              "unknown"
            ]
          },
          "flakeEvidence": {
            "type": "string"
          },
          "rerunAvailable": {
            "type": "boolean"
          },
          "rerunEvidence": {
            "type": "string"
          },
          "recommendedAction": {
            "type": "string",
            "enum": [
              "fix",
              "rerun",
              "wait",
              "ignore",
              "ask",
              "investigate"
            ]
          },
          "recommendedActionEvidence": {
            "type": "string"
          },
          "confidence": {
            "type": "string",
            "enum": [
              "high",
              "medium",
              "low"
            ]
          }
        },
        "required": [
          "checkName",
          "tldr"
        ],
        "additionalProperties": false
      },
      "minItems": 1,
      "description": "One entry per failing CI check investigated. checkName and detailsUrl must match the check identity from the prompt verbatim."
    },
    "overall": {
      "type": "object",
      "properties": {
        "summary": {
          "type": "string",
          "minLength": 1
        },
        "themes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "recommendedAction": {
          "type": "string",
          "enum": [
            "fix",
            "rerun",
            "wait",
            "ignore",
            "ask",
            "investigate"
          ]
        },
        "recommendedActionEvidence": {
          "type": "string"
        },
        "checkKeys": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      "required": [
        "summary"
      ],
      "additionalProperties": false,
      "description": "Optional cross-check summary when multiple checks were investigated in one turn."
    }
  },
  "required": [
    "findings"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(ige=ar.Ik({
  findings:ar.YO(sge).min(1).describe("One entry per failing CI check investigated. checkName and detailsUrl must match the check identity from the prompt verbatim."),overall:oge.optional().describe("Optional cross-check summary when multiple checks were investigated in one turn.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(function(e){
  switch(e.result.case){
    case"success":return e.result.value.message;
    case"error":return`Error recording CI findings: ${e.result.value.error}`;
    case void 0:return"Unknown CI investigation findings result";
    default:{
      const t=e.result;
      throw new Error(`Unhandled result case: ${String(t)}`)}
    }
  }
(t))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return cge(new kE.ge({
    result:new kE.Ro({
      result:{
        case:"error",value:new kE.Ag({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:RECORD_CI_INVESTIGATION_FINDINGS:7475208]`。

<a id="agent-search-conversations"></a>

### SEARCH_CONVERSATIONS

模型名称 / 静态别名：`SearchConversations`。证据：`cursor-agent-exec`，工厂 `gge`，UTF-16 偏移 `7479521`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "SearchConversations",
  descriptionGenerator: e=>"Search a fast local index of the user's local conversations and cached cloud agent conversations. Every unquoted keyword must match the same conversation, so queries with many keywords often return no results; run several searches with 1–2 keywords each instead. Use quotes only for a short exact phrase. Returns conversation IDs, titles, and short snippets—not full transcripts. Some cloud agent conversations may not be searchable.",
  parameters: mge
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query`              | `ar.Yj().min(1).describe("One or two keywords, or a short exact phrase in quotes, to search for in conversation titles and visible user/assistant message text. Every unquoted keyword must match the same conversation; use separate searches for additional keywords.")` |
| `limit`              | `ar.ai().int().min(1).max(100).optional().describe("Maximum number of conversation results to return (1-100). Defaults to 20.")`                                                                                                                                           |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "minLength": 1,
      "description": "One or two keywords, or a short exact phrase in quotes, to search for in conversation titles and visible user/assistant message text. Every unquoted keyword must match the same conversation; use separate searches for additional keywords."
    },
    "limit": {
      "type": "integer",
      "minimum": 1,
      "maximum": 100,
      "description": "Maximum number of conversation results to return (1-100). Defaults to 20."
    }
  },
  "required": [
    "query"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(mge=ar.Ik({
  query:ar.Yj().min(1).describe("One or two keywords, or a short exact phrase in quotes, to search for in conversation titles and visible user/assistant message text. Every unquoted keyword must match the same conversation; use separate searches for additional keywords."),limit:ar.ai().int().min(1).max(100).optional().describe("Maximum number of conversation results to return (1-100). Defaults to 20.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(function(e){
  switch(e.result.case){
    case"success":return fge(e.result.value);
    case"error":return`Conversation search failed: ${e.result.value.error}`;
    case void 0:return"Conversation search returned no result.";
    default:{
      const t=e.result;
      throw new Error(`Unhandled result case: ${t}`)}
    }
  }
(t))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof c$?e.modelVisibleErrorMessage:"Conversation search failed";
  return pge(new xC.b({
    result:new mC.pT({
      result:{
        case:"error",value:new mC.w$({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:SEARCH_CONVERSATIONS:7479521]`。

<a id="agent-semantic-search"></a>

### SEMANTIC_SEARCH

模型名称 / 静态别名：`codebase_search` / `SemanticSearch`。证据：`cursor-agent-exec`，工厂 `Fge`，UTF-16 偏移 `7497043`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: c,
  descriptionGenerator: e=>(a=e.allTools,qge(r,e.allTools)),
  parameters: u
}

```

</details>

<details>
<summary>参数字段与约束（4 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `explanation`        | `e.explanationRequired?ar.Yj().describe(Age):ar.Yj().optional().describe(Age)`                                                                                                   |
| `query`              | `ar.Yj().describe("A complete question about what you want to understand. Ask as if talking to a colleague: 'How does X work?', 'What happens when Y?', 'Where is Z handled?'")` |
| `target_directories` | `ar.YO(ar.Yj()).describe("Prefix directory paths to limit search scope (single directory only, no glob patterns)")`                                                              |
| `search_only_prs`    | `ar.zM().optional().describe("If true, only search pull requests and return no code results.")`                                                                                  |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(u="dsv3-1018"===r?Mge(s):l)
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,{
  result:t}
,r)=>{
  switch(t.case){
    case"success":return Go(t.value.results||"");
    case"error":return Go(`Error: ${t.value.errorMessage}`);
    default:return Go("Unknown error")}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return Nge(new $P.ks({
    result:new $P.h9({
      result:{
        case:"error",value:new $P.Kw({
          errorMessage:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:SEMANTIC_SEARCH:7497043]`。

<a id="agent-shell"></a>

### SHELL

模型名称 / 静态别名：`run_terminal_cmd` / `Shell`。证据：`cursor-agent-exec`，工厂 `pwe`，UTF-16 偏移 `7578710`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: m,
  descriptionGenerator: e=>function({
    version:e,enableTerminalFiles:t,sandboxEnabled:r,isReadonly:n,enableGithubTools:s,useMinimalHarness:o,compactShellDescription:i,compactShellFileGuidance:a,enableBlockUntilMs:c,requireBlockUntilMs:l,defaultBlockUntilMs:u,enableTmuxGuidance:d,tmuxSharedSessionName:p,tmuxSelfHostedMachine:m,enableJobCompletionNotifications:h,enableJobProgressNotifications:f,includeCommandSubstitutionWarning:g,allTools:y,sandboxNetworkInfo:w,enablePrCreationForgeGuidance:v}
  ){
    return"cursor-0226"===e?aye(r,e,o?{
      isReadonly:n,enableBlockUntilMs:c,enableTmuxGuidance:d,sandboxNetworkInfo:w,tmuxSharedSessionName:p,tmuxSelfHostedMachine:m,useMinimalHarness:!0,requireBlockUntilMs:l,defaultBlockUntilMs:u,enableJobProgressNotifications:f}
    :{
      isReadonly:n,enableBlockUntilMs:c,enableTmuxGuidance:d,sandboxNetworkInfo:w,tmuxSharedSessionName:p,tmuxSelfHostedMachine:m,requireBlockUntilMs:l,defaultBlockUntilMs:u,enableJobProgressNotifications:f}
    ):"dsv3-1018"===e||"dsv3-1205"===e?aye(r,e,{
      isReadonly:n,enableBlockUntilMs:c,enableTmuxGuidance:d,sandboxNetworkInfo:w,awaitToolName:y.AWAIT?.name,tmuxSharedSessionName:p,tmuxSelfHostedMachine:m,useMinimalHarness:o,requireBlockUntilMs:l,defaultBlockUntilMs:u,enableJobCompletionNotifications:h,enableJobProgressNotifications:f}
    ):qj(Tj(Vge,{
      enableTerminalFiles:t,sandboxEnabled:r,isReadonly:n,enableGithubTools:s,useMinimalHarness:o,compactShellDescription:i,compactShellFileGuidance:a,enableBlockUntilMs:c??!1,defaultBlockUntilMs:u,enableTmuxGuidance:d,tmuxSharedSessionName:p,tmuxSelfHostedMachine:m,enableJobCompletionNotifications:h,enableJobProgressNotifications:f,includeCommandSubstitutionWarning:g,allTools:y,sandboxNetworkInfo:w,enablePrCreationForgeGuidance:v}
    ))}
  ({
    version:r,enableTerminalFiles:h,sandboxEnabled:i,isReadonly:f,enableGithubTools:g,useMinimalHarness:l,compactShellDescription:t?.compactShellDescription,compactShellFileGuidance:t?.compactShellFileGuidance,enableBlockUntilMs:y,requireBlockUntilMs:w,defaultBlockUntilMs:c,enableTmuxGuidance:t?.enableTmuxGuidance,tmuxSharedSessionName:t?.tmuxSharedSessionName,tmuxSelfHostedMachine:t?.tmuxSelfHostedMachine,enableJobCompletionNotifications:t?.enableJobCompletionNotifications,enableJobProgressNotifications:t?.enableJobProgressNotifications,includeCommandSubstitutionWarning:t?.includeCommandSubstitutionWarning,allTools:e.allTools,enablePrCreationForgeGuidance:t?.enablePrCreationForgeGuidance,sandboxNetworkInfo:t?.sandboxNetworkInfo}
  ),
  parameters: d
}

```

</details>

<details>
<summary>参数字段与约束（17 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`            | `Yge`                                                                                                                                                                                                                                                                                                                                         |
| `working_directory`  | `Qge`                                                                                                                                                                                                                                                                                                                                         |
| `block_until_ms`     | `Zge(e)`                                                                                                                                                                                                                                                                                                                                      |
| `description`        | `eye`                                                                                                                                                                                                                                                                                                                                         |
| `timeout`            | `sye=!1,mle().optional().describe(sye?"Hard timeout in milliseconds. The command will be killed after this time, even if running in background (defaults to 600000ms/10 minutes).":"Timeout in milliseconds (defaults to 30000ms/30s)")`                                                                                                      |
| `is_background`      | `tye`                                                                                                                                                                                                                                                                                                                                         |
| `pattern`            | `ar.Yj().describe("Regex pattern matched against stdout/stderr output. Output redirected only to a file will not trigger it. Do not match all outputs.")`                                                                                                                                                                                     |
| `reason`             | `ar.Yj().describe("5 or less words describing why you are watching for this output. The UI (only visible to user) will prefix it as 'Monitored \`reason\`'.")`                                                                                                                                                                                |
| `debounce_ms`        | `ar.ai().optional().describe("Milliseconds that must elapse between notifications. The harness enforces a minimum of 5000ms.")`                                                                                                                                                                                                               |
| `command`            | `ar.Yj().describe("The command to execute")`                                                                                                                                                                                                                                                                                                  |
| `working_directory`  | `ar.Yj().optional().describe("The absolute path to the working directory to execute the command in (defaults to current directory)")`                                                                                                                                                                                                         |
| `description`        | `ar.Yj().optional().describe("Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'")` |
| `timeout`            | `mle().optional().describe("Timeout in milliseconds (defaults to 30000ms/30s)")`                                                                                                                                                                                                                                                              |
| `is_background`      | `ar.zM().optional().describe("Whether the command should be run in the background")`                                                                                                                                                                                                                                                          |
| `command`            | `ar.Yj().describe("The terminal command to execute")`                                                                                                                                                                                                                                                                                         |
| `is_background`      | `ar.zM().describe("Whether the command should be run in the background")`                                                                                                                                                                                                                                                                     |
| `explanation`        | `ar.Yj().optional().describe("One sentence explanation as to why this command needs to be run and how it contributes to the goal.")`                                                                                                                                                                                                          |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(d=x$(lwe(t?.parametersSchema??fye({
  version:r,sandboxEnabled:t?.sandboxEnabled??!1,isReadonly:t?.isReadonly,enableBlockUntilMs:t?.enableBlockUntilMs,requireBlockUntilMs:t?.requireBlockUntilMs,defaultBlockUntilMs:c,useMinimalHarness:l,enableJobProgressNotifications:t?.enableJobProgressNotifications}
),u),t?.machineIds,t?.machineIdParameterSchema))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,n)=>Go(Oz(t,{
  discourageAwait:void 0!==n.allTools.AWAIT,promptVersion:r,sandboxPromptEnabled:i,useMinimalHarness:l}
))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  if(e instanceof Wye)return Vhe(new sM.$M({
    result:new hR.W4({
      result:{
        case:"rejected",value:new hR.pZ({
          command:e.command,workingDirectory:e.workingDirectory,reason:e.reason}
        )}
      }
    )}
  ));
  if(e instanceof Vye)return Vhe(new sM.$M({
    result:new hR.W4({
      result:{
        case:"permissionDenied",value:new hR.jn({
          command:e.command,workingDirectory:e.workingDirectory,error:e.error,isReadonly:e.isReadonly}
        )}
      }
    )}
  ));
  if(e instanceof Hye){
    const t=e.cause,r=new hR.a({
      command:e.command,workingDirectory:e.workingDirectory}
    );
    return TL(t)?Vhe(new sM.$M({
      args:r,result:new hR.W4({
        result:{
          case:"timeout",value:new hR.eG({
            command:e.command,workingDirectory:e.workingDirectory,timeoutMs:t.fuseGuardMs}
          )}
        }
      )}
    )):Vhe(new sM.$M({
      args:r,result:new hR.W4({
        result:{
          case:"spawnError",value:new hR.mJ({
            command:e.command,workingDirectory:e.workingDirectory,error:"Aborted"}
          )}
        }
      )}
    ))}
  const t=e instanceof Error?e.message:String(e);
  return Vhe(new sM.$M({
    result:new hR.W4({
      result:{
        case:"spawnError",value:new hR.mJ({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:SHELL:7578710]`。

<a id="agent-switch-mode"></a>

### SWITCH_MODE

模型名称 / 静态别名：`SwitchMode`。证据：`cursor-agent-exec`，工厂 `vwe`，UTF-16 偏移 `7590645`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "SwitchMode",
  descriptionGenerator: e=>n,
  parameters: r
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target_mode_id`     | `ar.Yj().describe(\`The mode to switch to. Allowed values: ${t}.\`).transform(e=>e.trim().toLowerCase()).refine(t=>e.some(e=>e.toLowerCase()===t),{message:\`target_mode_id must be one of: ${e.join(", ")}\`})` |
| `explanation`        | `ar.Yj().optional().describe("Optional explanation for why the mode switch is requested. This helps the user understand why you're switching modes.")`                                                           |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(r=function(e){
  const t=e.map(e=>`'${e}'`).join(", ");
  return ar.vk(e=>{
    if(null===e||"object"!=typeof e||Array.isArray(e))return e;
    const t=e;
    if(void 0===t.target_mode_id&&"string"==typeof t.mode){
      const{
        mode:e,...r}
      =t;
      return{
        ...r,target_mode_id:e}
      }
    return t}
  ,ar.Ik({
    target_mode_id:ar.Yj().describe(`The mode to switch to. Allowed values: ${t}.`).transform(e=>e.trim().toLowerCase()).refine(t=>e.some(e=>e.toLowerCase()===t),{
      message:`target_mode_id must be one of: ${e.join(", ")}`}
    ),explanation:ar.Yj().optional().describe("Optional explanation for why the mode switch is requested. This helps the user understand why you're switching modes.")}
  ))}
(t))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(function(e){
  switch(e.result.case){
    case"success":{
      const t=e.result.value;
      return""===t.fromModeId?`Switched composer mode to ${t.toModeId}`:`Switched composer mode from ${t.fromModeId} to ${t.toModeId}`}
    case"error":return`Error switching mode: ${e.result.value.error}`;
    case"rejected":return"Mode switch was rejected by the user. Do not attempt to switch modes again.";
    case void 0:return"Unknown error";
    default:throw new Error(`Unhandled result case: ${e.result}`)}
  }
(t))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  if(e instanceof p$)return gwe(new H.Cs({
    result:new H.l$({
      result:{
        case:"rejected",value:new H.Ci({
          reason:e.message}
        )}
      }
    )}
  ));
  const t=e instanceof Error?e.message:String(e);
  return gwe(new H.Cs({
    result:new H.l$({
      result:{
        case:"error",value:new H.eU({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:SWITCH_MODE:7590645]`。

<a id="agent-todo-write"></a>

### TODO_WRITE

模型名称 / 静态别名：`todo_write` / `TodoWrite`。证据：`cursor-agent-exec`，工厂 `Awe`，UTF-16 偏移 `7602454`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: s,
  descriptionGenerator: e=>o,
  parameters: Ewe(r,{
    mergeTodosFirst:n,minTodos:2}
  )
}

```

</details>

<details>
<summary>参数字段与约束（13 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merge`              | `ar.zM().describe("Whether to merge the todos with the existing todos. If true, the todos will be merged into the existing todos based on the id field. You can leave unchanged properties undefined. If false, the new todos will replace the existing todos.")` |
| `todos`              | `ar.YO(Swe).describe("Array of todo items to write to the workspace")`                                                                                                                                                                                            |
| `todos`              | `ar.YO(xwe).describe("Array of TODO items to update or create")`                                                                                                                                                                                                  |
| `todos`              | `r`                                                                                                                                                                                                                                                               |
| `merge`              | `s`                                                                                                                                                                                                                                                               |
| `todos`              | `n`                                                                                                                                                                                                                                                               |
| `content`            | `ar.Yj().optional().describe("The description/content of the todo item")`                                                                                                                                                                                         |
| `status`             | `Kee.describe("The current status of the todo item")`                                                                                                                                                                                                             |
| `id`                 | `ar.Yj().describe("Unique identifier for the todo item")`                                                                                                                                                                                                         |
| `id`                 | `ar.Yj().describe("Unique identifier for the TODO item")`                                                                                                                                                                                                         |
| `content`            | `ar.Yj().describe("The description/content of the TODO item")`                                                                                                                                                                                                    |
| `status`             | `Kee.describe("The current status of the TODO item")`                                                                                                                                                                                                             |
| `content`            | `ar.Yj().describe("The description/content of the todo item")`                                                                                                                                                                                                    |

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,n)=>{
  const s=t.result;
  switch(s?.case){
    case"success":return function(e,t){
      let r="Successfully updated TODOs. Make sure to follow and update your TODO list as you make progress. Cancel and add new TODO tasks as needed when the user makes a correction or follow-up request.";
      e.todos.some(e=>e.status===uf.Vj.PENDING)&&e.todos.every(e=>e.status!==uf.Vj.IN_PROGRESS)&&(r+=" No TODOs are marked in-progress, make sure to mark them before starting the next.");
      const n=e.todos.filter(e=>e.status===uf.Vj.COMPLETED||e.status===uf.Vj.CANCELLED).length>20;
      if("dsv3-1018"===t){
        if(e.wasMerge??!0){
          r+="\n\nHere are the latest contents of your todo list:";
          const t=e.todos.map(e=>({
            id:e.id,content:e.content,status:Xee(e.status)}
          ));
          r+=`\n${JSON.stringify(t)}`}
        }
      else r+=`\n\nHere are the latest contents of your todo list:\n${e.todos.map(e=>`- **${Xee(e.status).toUpperCase()}**: ${e.content} (id: ${e.id})`).join("\n")}`;
      const s=Go(r);
      return n?zo(s,"You have many finished todos. Consider cleaning up old ones."):s}
    (s.value,r);
    case"error":return Go(s.value.error);
    case void 0:return Go("Unknown error");
    default:throw new Error(`Unhandled result case: ${String(s)}`)}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return tte(new uf.bk({
    result:new uf.w9({
      result:{
        case:"error",value:new uf.fr({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:TODO_WRITE:7602454]`。

<a id="agent-web-fetch"></a>

### WEB_FETCH

模型名称 / 静态别名：`WebFetch` / `mcp_web_fetch`。证据：`cursor-agent-exec`，工厂 `Ywe`，UTF-16 偏移 `7612203`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: function(e){
    switch(e){
      case"cursor-0226":case"latest":case"gpt5-codex":case"codex-cloud":case"haiku":return"WebFetch";
      case"dsv3-1205":case"dsv3-1018":return"mcp_web_fetch";
      default:throw new Error(`Unhandled version: ${e}`)}
    }
  (t),
  descriptionGenerator: e=>{
    const n=function(e,t,r=!1){
      if(r)return"Fetch content from a URL and return it as readable markdown. Prefer this over shell for web content because shell egress is more restricted.";
      if("cursor-0226"===e)return"Fetch content from a specified URL and return its contents in a readable markdown format. Use this tool when you need to retrieve and analyze web content.";
      const n=function(e){
        const t=e.SHELL?.name,r=t?`- For static assets and non-webpage URLs, use the \`${t}\` tool instead.`:"";
        return`Fetch content from a specified URL and return its contents in a readable markdown format. Use this tool when you need to retrieve and analyze webpage content.\n\n- The URL must be a fully-formed, valid URL.\n- This tool is read-only and will not work for requests intended to have side effects.\n- This fetch tries to return live results but may return previously cached content.\n- Authentication is not supported, and an error will be returned if the URL requires authentication.\n- If the URL is returning a non-200 status code, e.g. 404, the tool will not return the content and will instead return an error message.\n- This fetch runs from an isolated server. Hosts like localhost or private IPs will not work.\n- This tool does not support fetching binary content, e.g. media or PDFs.${r?`\n${r}`:""}\n`}
      (t);
      return"dsv3-1018"===e||"dsv3-1205"===e?`${n}\n\nPrefer this tool over any mcp_cursor-* tools when fetching URL content.`:n}
    (t,e.allTools,r?.useMinimalHarness??!1);
    return void 0!==r?.descriptionSuffix?`${n}\n\n${r.descriptionSuffix}`:n}
  ,
  parameters: i
}

```

</details>

<details>
<summary>参数字段与约束（3 条表达式）</summary>

| 字段（含嵌套与变体）       | 类型 / 约束原式                                                                                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                      | `ar.Yj().describe("The URL to fetch. The content will be converted to a readable markdown format.")`                                                                                                                                                        |
| `requestSmartModeApproval` | `ar.zM().optional().describe("Set to true when immediately retrying the exact same fetch after Auto-review blocks it and you decide the user should approve it through the native approval card.")`                                                         |
| `smartModeBlockReason`     | `ar.Yj().optional().describe("Provide the exact block reason returned by Auto-review in the prior rejection. Required when requestSmartModeApproval is true so the approval card shows the original classifier reason without re-running the classifier.")` |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(i=r?.agentType!==wW.BACKGROUND&&!0===r?.smartModeClassifierMode?$we.extend(jwe.shape):$we)
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  switch(t.result.case){
    case"success":{
      const e=t.result.value;
      if(e.outputLocation)return Go(`# Content from ${e.url}\n\n`+(0,VV.cW)(e.outputLocation));
      const r=Uwe(e.markdown,Nwe);
      return Go(`# Content from ${e.url}\n\n${r}`)}
    case"error":{
      const e=t.result.value.url,r=t.result.value.error;
      return Go(e?`Error fetching URL ${e}: ${r}`:`Error: ${r}`)}
    case"rejected":return Go(t.result.value.reason?`Web fetch rejected: ${t.result.value.reason}`:"The web fetch was rejected by the user.");
    case void 0:return Go("Unknown error");
    default:{
      const e=t.result;
      throw new Error(`Unhandled result case: ${e}`)}
    }
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  if(e instanceof p$)return Lwe(new K.fd({
    result:new K.wA({
      result:{
        case:"rejected",value:new K.hO({
          reason:e.message}
        )}
      }
    )}
  ));
  const t=(()=>{
    if(e instanceof c$)return e.clientVisibleErrorMessage;
    if(e instanceof Error){
      const t=e.message??"",r=/http_(\d{3})/i.exec(t)??/\bstatus(?:\s*code)?\s*[:=]?\s*(\d{3})\b/i.exec(t)??/\bHTTP\/\d(?:\.\d)?\s+(\d{3})\b/i.exec(t);
      if(r?.[1])return`Error fetching URL, status code: ${Number(r[1])}`}
    return"An error occurred while fetching the URL"}
  )();
  return Lwe(new K.fd({
    result:new K.wA({
      result:{
        case:"error",value:new K.vS({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:WEB_FETCH:7612203]`。

<a id="agent-web-search"></a>

### WEB_SEARCH

模型名称 / 静态别名：`web_search` / `WebSearch`。证据：`cursor-agent-exec`，工厂 `cve`，UTF-16 偏移 `7625730`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: function(e){
    switch(e){
      case"dsv3-1018":return"web_search";
      case"cursor-0226":case"dsv3-1205":case"latest":case"gpt5-codex":case"codex-cloud":case"haiku":return"WebSearch";
      default:throw new Error(`Unhandled version: ${e}`)}
    }
  (t),
  descriptionGenerator: ()=>{
    const e=ave(t,r?.useMinimalHarness??!1,r?.conversationStartedDate);
    return void 0!==r?.descriptionSuffix?`${e}\n\n${r.descriptionSuffix}`:e}
  ,
  parameters: n
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_term`        | `ar.Yj().describe("The search term to look up on the web. Be specific and include relevant keywords for better results. For technical queries, include version numbers or dates if relevant.")` |
| `explanation`        | `ar.Yj().optional().describe("One sentence explanation as to why this tool is being used, and how it contributes to the goal.")`                                                                |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(n=function(e){
  if("exa"===e)return sve;
  throw new Error(`Unhandled web search tool variant: ${e}`)}
(r?.variant??"exa"))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(function(e){
  switch(e.result.case){
    case"success":return e.result.value.references.map(e=>{
      const t=void 0!==e.url&&""!==e.url?`\nURL: ${e.url}`:"";
      return`Title: ${e.title}${t}\nContent: ${e.chunk}\n---\n`}
    ).join("\n");
    case"error":return`Error: ${e.result.value.error}`;
    case"rejected":return e.result.value.reason?`Web search rejected: ${e.result.value.reason}`:"The web search was rejected by the user.";
    case void 0:return"Unknown error";
    default:{
      const t=e.result;
      throw new Error(`Unhandled result case: ${t}`)}
    }
  }
(t))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  if(e instanceof p$)return eve(new V.pn({
    result:new V.gT({
      result:{
        case:"rejected",value:new V.P_({
          reason:e.message}
        )}
      }
    )}
  ));
  const t=e instanceof c$?e.clientVisibleErrorMessage:"An error occurred while searching the web";
  return eve(new V.pn({
    result:new V.gT({
      result:{
        case:"error",value:new V.xE({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:WEB_SEARCH:7625730]`。

<a id="agent-get-mcp-tools"></a>

### GET_MCP_TOOLS

模型名称 / 静态别名：`GetMcpTools` / `GetDynamicTools`。证据：`cursor-agent-exec`，工厂 `ebe`，UTF-16 偏移 `7651317`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: o,
  descriptionGenerator: e=>{
    const r=t?.callMcpToolName??ML(e.allTools,"MCP"),n=function(e){
      const t=e.map(e=>`"${e}"`);
      return t.length<=2?t.join(" or "):`${t.slice(0,-1).join(", ")}, or ${t[t.length-1]}`}
    (t?.unusableStatuses??["needsAuth","error","loading"]),o=a?["",s?`MCP authentication: If an MCP-backed namespace has namespaceStatus "needsAuth", or its tool call fails with an authentication/authorization error, authenticate it by calling ${Ove} through ${r} with empty arguments. Then inspect that namespace again and retry if appropriate.`:`MCP authentication: If a relevant server has serverStatus "needsAuth", or if an MCP tool call fails with an authentication/authorization error, authenticate it by calling ${Ove} (via ${r}, with empty arguments), then inspect that server again and retry the original request if appropriate. Do not call ${Ove} just because it is listed, and do not repeatedly call it if authentication did not fix the failure.`]:["",t?.nonInteractiveAuthGuidance??(s?'MCP authentication: If an MCP-backed namespace has namespaceStatus "needsAuth", its tools are unavailable until that MCP integration is authenticated in the Cursor desktop IDE.':'MCP authentication: If a server has serverStatus "needsAuth", its tools are not usable in this environment. Ask the user to authenticate that MCP server in the Cursor desktop IDE, then retry.')],i=l?"their names are listed with that namespace in <user_info>, or in the most recent <user_info_catalog_update> block on a later user turn":c?.getToolNames().join(", "),u=void 0===c||c.isEmpty()?[]:["",`First-party Cursor tools: the reserved namespace "${eL.jnL}" lists built-in Cursor tools available on demand (${i}). Discover their schemas here, then invoke them via ${r}; they run natively with their own approvals and rendering.`];
    return s?["Discover and inspect tools available through dynamic namespaces, e.g. MCP servers.","",'1. {"namespace":"<id>"}: returns full input schemas and full descriptions for every tool in that namespace.','2. {"namespace":"<id>","toolName":"<name>"}: returns the full schema and full description for one tool.','3. {"pattern":"<regex>"}: searches namespace and tool names across all namespaces using RE2 syntax.','4. {"namespace":"<id>","pattern":"<regex>"}: searches tool names within that namespace.',"5. No arguments: returns the full catalog. Prefer a namespace or pattern when possible.","",`Pattern-search and catalog results shorten long descriptions to 200 characters, ending with "${YX}". Namespace and single-tool lookups always return the complete description, so fetch the tool directly when you need the full text.`,`The response includes namespaceStatus for MCP-backed namespaces; do not treat namespaces in ${n} states as usable.`,`Always call this tool to discover a tool's schema before calling it with ${r}.`,...u,...o].join("\n"):["Discover and inspect MCP tools. There are 5 ways to call this tool. Prefer fetching by server or pattern over listing the full catalog.","",'1. {"server":"<id>"}: returns full input schemas and full descriptions for every tool on that server. Preferred when you know the server.','2. {"server":"<id>","toolName":"<name>"}: returns the full schema and full description for one tool.','3. {"pattern":"<regex>"}: searches tool and server names across all servers using RE2 syntax.','4. {"server":"<id>","pattern":"<regex>"}: searches tool names on that server using RE2 syntax.',"5. No arguments: returns a catalog of all servers with tool names and short descriptions. Use only as a last resort.","",`Pattern-search and catalog results shorten long descriptions to 200 characters, ending with "${YX}". Server and single-tool lookups always return the complete description, so fetch the tool directly when you need the full text.`,`The response includes each server's serverStatus; do not treat servers in ${n} states as usable.`,`Always call this tool to discover a tool's schema before calling it with ${r}.`,...u,...o].join("\n")}
  ,
  parameters: v
}

```

</details>

<details>
<summary>参数字段与约束（6 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式 |
| -------------------- | --------------- |
| `namespace`          | `p`             |
| `toolName`           | `h`             |
| `pattern`            | `g`             |
| `server`             | `d`             |
| `toolName`           | `m`             |
| `pattern`            | `f`             |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(v=s?w:y)
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
Yve
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return Wve(Hve("unknown-tool-call-id",{
    }
  ),Vve(t))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:GET_MCP_TOOLS:7651317]`。

<a id="agent-create-task"></a>

### CREATE_TASK

模型名称 / 静态别名：`create-agent`。证据：`cursor-agent-exec`，工厂 `bbe`，UTF-16 偏移 `7673710`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "create-agent",
  descriptionGenerator: ()=>"Create an asynchronous agent with the provided prompt. Use `title` to provide a short user-facing name for the new agent. Returns agent_id of the created agent. Agent results will be reported asynchronously as user messages surrounded by "+NX+". ",
  parameters: n
}

```

</details>

<details>
<summary>参数字段与约束（6 条表达式）</summary>

| 字段（含嵌套与变体）        | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title`                     | `ar.Yj().min(1,"title is required").describe("A short, user-friendly title for the agent to create. This appears in the UI as the agent's name. Make it concrete and distinct, consider recent titles to avoid reuse, and vary the first word across agent titles.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `description`               | `ar.Yj().min(1,"description is required").describe("A brief description of this agent's scope of work. 10 words or less.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `prompt`                    | `ar.Yj().min(1,"prompt is required").describe("The prompt for the new asynchronous agent. DO NOT tell the agent that you are a meta-agent. Your prompt should be presented as just a normal user prompt.")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `responding_to_message_ids` | `ar.YO(ar.Yj()).min(1,"responding_to_message_ids must contain at least one message id").describe("Array of user message IDs this tool call is responding to. Usually this is the latest user message ID, but include older IDs for delayed actions or when a later message clarifies an earlier one. List multiple IDs when replying to multiple user messages.")`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `fork`                      | `ar.Yj().min(1,"fork must be a non-empty agent_id").optional().describe("Optional agent_id of a direct child agent to fork from. Use when you wish to start a new agent with the history of an existing agent. Common cases: parallel work that does not depend on the child's in-flight output, status check or question for a running child without interrupting its work, or multiple independent follow-ups from a completed child (e.g. splitting independent TODOs). Explicitly instruct new agent to fully shift its focus to the new task rather than continuing work on the prior task. Do not stop the work of the agent you are forking from (if you are doing this, resume that agent with \`interrupt=true\` instead). New agent must be given its own unique title.")` |
| `attachments`               | `dbe("new agent")`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "title": {
      "type": "string",
      "minLength": 1,
      "description": "A short, user-friendly title for the agent to create. This appears in the UI as the agent's name. Make it concrete and distinct, consider recent titles to avoid reuse, and vary the first word across agent titles."
    },
    "description": {
      "type": "string",
      "minLength": 1,
      "description": "A brief description of this agent's scope of work. 10 words or less."
    },
    "prompt": {
      "type": "string",
      "minLength": 1,
      "description": "The prompt for the new asynchronous agent. DO NOT tell the agent that you are a meta-agent. Your prompt should be presented as just a normal user prompt."
    },
    "responding_to_message_ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "description": "Array of user message IDs this tool call is responding to. Usually this is the latest user message ID, but include older IDs for delayed actions or when a later message clarifies an earlier one. List multiple IDs when replying to multiple user messages."
    },
    "fork": {
      "type": "string",
      "minLength": 1,
      "description": "Optional agent_id of a direct child agent to fork from. Use when you wish to start a new agent with the history of an existing agent. Common cases: parallel work that does not depend on the child's in-flight output, status check or question for a running child without interrupting its work, or multiple independent follow-ups from a completed child (e.g. splitting independent TODOs). Explicitly instruct new agent to fully shift its focus to the new task rather than continuing work on the prior task. Do not stop the work of the agent you are forking from (if you are doing this, resume that agent with `interrupt=true` instead). New agent must be given its own unique title."
    },
    "attachments": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional array of file paths to image/video files to attach to your prompt to the new agent. Use for forwarding relevant user-provided attachments to subagents. DO NOT use for non-user-provided files."
    }
  },
  "required": [
    "title",
    "description",
    "prompt",
    "responding_to_message_ids"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(n=ar.Ik({
  title:ar.Yj().min(1,"title is required").describe("A short, user-friendly title for the agent to create. This appears in the UI as the agent's name. Make it concrete and distinct, consider recent titles to avoid reuse, and vary the first word across agent titles."),description:ar.Yj().min(1,"description is required").describe("A brief description of this agent's scope of work. 10 words or less."),prompt:ar.Yj().min(1,"prompt is required").describe("The prompt for the new asynchronous agent. DO NOT tell the agent that you are a meta-agent. Your prompt should be presented as just a normal user prompt."),responding_to_message_ids:ar.YO(ar.Yj()).min(1,"responding_to_message_ids must contain at least one message id").describe("Array of user message IDs this tool call is responding to. Usually this is the latest user message ID, but include older IDs for delayed actions or when a later message clarifies an earlier one. List multiple IDs when replying to multiple user messages."),fork:ar.Yj().min(1,"fork must be a non-empty agent_id").optional().describe("Optional agent_id of a direct child agent to fork from. Use when you wish to start a new agent with the history of an existing agent. Common cases: parallel work that does not depend on the child's in-flight output, status check or question for a running child without interrupting its work, or multiple independent follow-ups from a completed child (e.g. splitting independent TODOs). Explicitly instruct new agent to fully shift its focus to the new task rather than continuing work on the prior task. Do not stop the work of the agent you are forking from (if you are doing this, resume that agent with `interrupt=true` instead). New agent must be given its own unique title."),attachments:dbe("new agent")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t)=>mbe({
  taskResult:t,action:"create"}
)
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>pbe(new U.U4S({
  result:new U.$$B({
    result:{
      case:"error",value:new U.IkE({
        error:e instanceof Error?e.message:String(e)}
      )}
    }
  )}
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:CREATE_TASK:7673710]`。

<a id="agent-send-message"></a>

### SEND_MESSAGE

模型名称 / 静态别名：`SendMessage`。证据：`cursor-agent-exec`，工厂 `qbe`，UTF-16 偏移 `7678906`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "SendMessage",
  descriptionGenerator: ()=>"Send a message to the user. This is the only channel the user sees; ordinary assistant text is hidden thinking. Send only when there is something the user needs — a result, a blocker, a question. Many turns (e.g. an irrelevant notification) end without any message. When you do send the turn's final message, make it the last thing you do.",
  parameters: Obe
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message`            | `ar.Yj().trim().min(1,"Message must be non-empty").max(1e5,"Message must be at most 100000 characters").superRefine((e,t)=>{const r=e.replace(Mbe," ");for(const[,e=""]of r.matchAll(Jbe)){if(!e.startsWith("bc-")\|\|void 0!==Pbe(e))continue;const r=e.split(/[#/?]/,1)[0]??e;return void t.addIssue({code:die.eq.custom,message:Ebe(r)?\`\\`${e}\\` is not an agent link. Use \\`${r}\\`, \\`${r}#changes\\`, or \\`${r}#desktop\\`.\`:\`\\`${e}\\` is not an agent ID. A new agent's ID exists only in its CreateAgent result: link it after that result arrives, or name it without a link.\`})}}).describe("User-visible message to send.")` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "minLength": 1,
      "maxLength": 100000,
      "description": "User-visible message to send."
    }
  },
  "required": [
    "message"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Obe=ar.Ik({
  message:ar.Yj().trim().min(1,"Message must be non-empty").max(1e5,"Message must be at most 100000 characters").superRefine((e,t)=>{
    const r=e.replace(Mbe," ");
    for(const[,e=""]of r.matchAll(Jbe)){
      if(!e.startsWith("bc-")||void 0!==Pbe(e))continue;
      const r=e.split(/[#/?]/,1)[0]??e;
      return void t.addIssue({
        code:die.eq.custom,message:Ebe(r)?`\`${e}\` is not an agent link. Use \`${r}\`, \`${r}#changes\`, or \`${r}#desktop\`.`:`\`${e}\` is not an agent ID. A new agent's ID exists only in its CreateAgent result: link it after that result arrives, or name it without a link.`}
      )}
    }
  ).describe("User-visible message to send.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  switch(t.result.case){
    case"error":return Go(`Failed to send the message to the user: ${t.result.value.error}`,!0);
    case"success":case void 0:return Go("Message sent to user.");
    default:{
      const e=t.result;
      throw new Error(`Unhandled result case: ${String(e)}`)}
    }
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>Bbe(new TA.wl({
  result:new TA.HU({
    result:{
      case:"error",value:new TA._M({
        error:e instanceof Error?e.message:"Unknown error"}
      )}
    }
  )}
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:SEND_MESSAGE:7678906]`。

<a id="agent-send-to-task"></a>

### SEND_TO_TASK

模型名称 / 静态别名：`send-message-to-agent`。证据：`cursor-agent-exec`，工厂 `Nbe`，UTF-16 偏移 `7681189`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "send-message-to-agent",
  descriptionGenerator: ()=>"Send a prompt to an existing asynchronous agent after it has completed. If the agent is still running, the request fails; wait for its completion before sending a follow-up.",
  parameters: n
}

```

</details>

<details>
<summary>参数字段与约束（4 条表达式）</summary>

| 字段（含嵌套与变体）        | 类型 / 约束原式                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agent_id`                  | `ar.Yj().min(1,"agent_id is required").describe("The agent_id returned by create-agent for the agent you want to message.")`                                                                                                                                                                                                                                       |
| `prompt`                    | `ar.Yj().min(1,"prompt is required").describe("The follow-up prompt to send to the agent")`                                                                                                                                                                                                                                                                        |
| `responding_to_message_ids` | `ar.YO(ar.Yj()).min(1,"responding_to_message_ids must contain at least one message id").describe("Array of user message IDs this tool call is responding to. Usually this is the latest user message ID, but include older IDs for delayed actions or when a later message clarifies an earlier one. List multiple IDs when replying to multiple user messages.")` |
| `attachments`               | `dbe("agent")`                                                                                                                                                                                                                                                                                                                                                     |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "agent_id": {
      "type": "string",
      "minLength": 1,
      "description": "The agent_id returned by create-agent for the agent you want to message."
    },
    "prompt": {
      "type": "string",
      "minLength": 1,
      "description": "The follow-up prompt to send to the agent"
    },
    "responding_to_message_ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "description": "Array of user message IDs this tool call is responding to. Usually this is the latest user message ID, but include older IDs for delayed actions or when a later message clarifies an earlier one. List multiple IDs when replying to multiple user messages."
    },
    "attachments": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "description": "Optional array of file paths to image/video files to attach to your prompt to the agent. Use for forwarding relevant user-provided attachments to subagents. DO NOT use for non-user-provided files."
    }
  },
  "required": [
    "agent_id",
    "prompt",
    "responding_to_message_ids"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(n=ar.Ik({
  agent_id:ar.Yj().min(1,"agent_id is required").describe("The agent_id returned by create-agent for the agent you want to message."),prompt:ar.Yj().min(1,"prompt is required").describe("The follow-up prompt to send to the agent"),responding_to_message_ids:ar.YO(ar.Yj()).min(1,"responding_to_message_ids must contain at least one message id").describe("Array of user message IDs this tool call is responding to. Usually this is the latest user message ID, but include older IDs for delayed actions or when a later message clarifies an earlier one. List multiple IDs when replying to multiple user messages."),attachments:dbe("agent")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t)=>mbe({
  taskResult:t,action:"send"}
)
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>pbe(new U.U4S({
  result:new U.$$B({
    result:{
      case:"error",value:new U.IkE({
        error:e instanceof Error?e.message:String(e)}
      )}
    }
  )}
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:SEND_TO_TASK:7681189]`。

<a id="agent-pi-read"></a>

### PI_READ

模型名称 / 静态别名：`pi_read`。证据：`cursor-agent-exec`，工厂 `g_e`，UTF-16 偏移 `7688222`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "pi_read",
  descriptionGenerator: ()=>"Read the contents of a file using pi-compatible semantics.",
  parameters: Zbe
}

```

</details>

<details>
<summary>参数字段与约束（3 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                |
| -------------------- | ------------------------------------------------------------------------------ |
| `path`               | `ar.Yj().describe("Path to the file to read (relative or absolute)")`          |
| `offset`             | `ar.ai().optional().describe("Line number to start reading from (1-indexed)")` |
| `limit`              | `ar.ai().optional().describe("Maximum number of lines to read")`               |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to the file to read (relative or absolute)"
    },
    "offset": {
      "type": "number",
      "description": "Line number to start reading from (1-indexed)"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of lines to read"
    }
  },
  "required": [
    "path"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Zbe=ar.Ik({
  path:ar.Yj().describe("Path to the file to read (relative or absolute)"),offset:ar.ai().optional().describe("Line number to start reading from (1-indexed)"),limit:ar.ai().optional().describe("Maximum number of lines to read")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
a_e
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>f_e("piReadToolCall",new kk.oT({
  result:{
    result:{
      case:"error",value:new kk.oS({
        error:h_e(e)}
      )}
    }
  }
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:PI_READ:7688222]`。

<a id="agent-pi-bash"></a>

### PI_BASH

模型名称 / 静态别名：`pi_bash`。证据：`cursor-agent-exec`，工厂 `y_e`，UTF-16 偏移 `7689458`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "pi_bash",
  descriptionGenerator: ()=>"Execute a bash command using pi-compatible output and timeout semantics.",
  parameters: e_e
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                    |
| -------------------- | ---------------------------------------------------------------------------------- |
| `command`            | `ar.Yj().describe("Bash command to execute")`                                      |
| `timeout`            | `ar.ai().optional().describe("Timeout in seconds (optional, no default timeout)")` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "command": {
      "type": "string",
      "description": "Bash command to execute"
    },
    "timeout": {
      "type": "number",
      "description": "Timeout in seconds (optional, no default timeout)"
    }
  },
  "required": [
    "command"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(e_e=ar.Ik({
  command:ar.Yj().describe("Bash command to execute"),timeout:ar.ai().optional().describe("Timeout in seconds (optional, no default timeout)")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
c_e
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>f_e("piBashToolCall",new aS.WJ({
  result:{
    result:{
      case:"error",value:new aS.eC({
        error:h_e(e)}
      )}
    }
  }
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:PI_BASH:7689458]`。

<a id="agent-pi-edit"></a>

### PI_EDIT

模型名称 / 静态别名：`pi_edit`。证据：`cursor-agent-exec`，工厂 `w_e`，UTF-16 偏移 `7690556`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "pi_edit",
  descriptionGenerator: ()=>"Edit a single file using pi-compatible exact text replacements.",
  parameters: t_e
}

```

</details>

<details>
<summary>参数字段与约束（4 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`               | `ar.Yj().describe("Path to the file to edit (relative or absolute)")`                                                                                                       |
| `edits`              | `ar.YO(Xbe).describe("One or more targeted replacements.")`                                                                                                                 |
| `oldText`            | `ar.Yj().describe("Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.")` |
| `newText`            | `ar.Yj().describe("Replacement text for this targeted edit.")`                                                                                                              |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to the file to edit (relative or absolute)"
    },
    "edits": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "oldText": {
            "type": "string",
            "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."
          },
          "newText": {
            "type": "string",
            "description": "Replacement text for this targeted edit."
          }
        },
        "required": [
          "oldText",
          "newText"
        ],
        "additionalProperties": false
      },
      "description": "One or more targeted replacements."
    }
  },
  "required": [
    "path",
    "edits"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(t_e=ar.Ik({
  path:ar.Yj().describe("Path to the file to edit (relative or absolute)"),edits:ar.YO(Xbe).describe("One or more targeted replacements.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
l_e
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>f_e("piEditToolCall",new kS.EN({
  result:{
    result:{
      case:"error",value:new kS.uX({
        error:h_e(e)}
      )}
    }
  }
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:PI_EDIT:7690556]`。

<a id="agent-pi-write"></a>

### PI_WRITE

模型名称 / 静态别名：`pi_write`。证据：`cursor-agent-exec`，工厂 `v_e`，UTF-16 偏移 `7691789`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "pi_write",
  descriptionGenerator: ()=>"Write content to a file using pi-compatible semantics.",
  parameters: r_e
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                        |
| -------------------- | ---------------------------------------------------------------------- |
| `path`               | `ar.Yj().describe("Path to the file to write (relative or absolute)")` |
| `content`            | `ar.Yj().describe("Content to write to the file")`                     |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Path to the file to write (relative or absolute)"
    },
    "content": {
      "type": "string",
      "description": "Content to write to the file"
    }
  },
  "required": [
    "path",
    "content"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(r_e=ar.Ik({
  path:ar.Yj().describe("Path to the file to write (relative or absolute)"),content:ar.Yj().describe("Content to write to the file")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
u_e
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>f_e("piWriteToolCall",new Dk.xP({
  result:{
    result:{
      case:"error",value:new Dk.jE({
        error:h_e(e)}
      )}
    }
  }
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:PI_WRITE:7691789]`。

<a id="agent-pi-grep"></a>

### PI_GREP

模型名称 / 静态别名：`pi_grep`。证据：`cursor-agent-exec`，工厂 `b_e`，UTF-16 偏移 `7693004`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "pi_grep",
  descriptionGenerator: ()=>"Search file contents for a pattern using pi-compatible grep semantics.",
  parameters: n_e
}

```

</details>

<details>
<summary>参数字段与约束（7 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `pattern`            | `ar.Yj().describe("Search pattern (regex or literal string)")`                                     |
| `path`               | `ar.Yj().optional().describe("Directory or file to search (default: current directory)")`          |
| `glob`               | `ar.Yj().optional().describe("Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'")`       |
| `ignoreCase`         | `ar.zM().optional().describe("Case-insensitive search (default: false)")`                          |
| `literal`            | `ar.zM().optional().describe("Treat pattern as literal string instead of regex (default: false)")` |
| `context`            | `ar.ai().optional().describe("Number of lines to show before and after each match (default: 0)")`  |
| `limit`              | `ar.ai().optional().describe("Maximum number of matches to return (default: 100)")`                |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Search pattern (regex or literal string)"
    },
    "path": {
      "type": "string",
      "description": "Directory or file to search (default: current directory)"
    },
    "glob": {
      "type": "string",
      "description": "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'"
    },
    "ignoreCase": {
      "type": "boolean",
      "description": "Case-insensitive search (default: false)"
    },
    "literal": {
      "type": "boolean",
      "description": "Treat pattern as literal string instead of regex (default: false)"
    },
    "context": {
      "type": "number",
      "description": "Number of lines to show before and after each match (default: 0)"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of matches to return (default: 100)"
    }
  },
  "required": [
    "pattern"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(n_e=ar.Ik({
  pattern:ar.Yj().describe("Search pattern (regex or literal string)"),path:ar.Yj().optional().describe("Directory or file to search (default: current directory)"),glob:ar.Yj().optional().describe("Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'"),ignoreCase:ar.zM().optional().describe("Case-insensitive search (default: false)"),literal:ar.zM().optional().describe("Treat pattern as literal string instead of regex (default: false)"),context:ar.ai().optional().describe("Number of lines to show before and after each match (default: 0)"),limit:ar.ai().optional().describe("Maximum number of matches to return (default: 100)")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
d_e
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>f_e("piGrepToolCall",new QS.Os({
  result:{
    result:{
      case:"error",value:new QS.AM({
        error:h_e(e)}
      )}
    }
  }
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:PI_GREP:7693004]`。

<a id="agent-pi-find"></a>

### PI_FIND

模型名称 / 静态别名：`pi_find`。证据：`cursor-agent-exec`，工厂 `__e`，UTF-16 偏移 `7694136`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "pi_find",
  descriptionGenerator: ()=>"Search for files by glob pattern using pi-compatible find semantics.",
  parameters: s_e
}

```

</details>

<details>
<summary>参数字段与约束（3 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `pattern`            | `ar.Yj().describe("Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'")` |
| `path`               | `ar.Yj().optional().describe("Directory to search in (default: current directory)")`               |
| `limit`              | `ar.ai().optional().describe("Maximum number of results (default: 1000)")`                         |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "pattern": {
      "type": "string",
      "description": "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"
    },
    "path": {
      "type": "string",
      "description": "Directory to search in (default: current directory)"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of results (default: 1000)"
    }
  },
  "required": [
    "pattern"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(s_e=ar.Ik({
  pattern:ar.Yj().describe("Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"),path:ar.Yj().optional().describe("Directory to search in (default: current directory)"),limit:ar.ai().optional().describe("Maximum number of results (default: 1000)")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
p_e
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>f_e("piFindToolCall",new NS.h1({
  result:{
    result:{
      case:"error",value:new NS.xD({
        error:h_e(e)}
      )}
    }
  }
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:PI_FIND:7694136]`。

<a id="agent-pi-ls"></a>

### PI_LS

模型名称 / 静态别名：`pi_ls`。证据：`cursor-agent-exec`，工厂 `S_e`，UTF-16 偏移 `7695266`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "pi_ls",
  descriptionGenerator: ()=>"List directory contents using pi-compatible flat listing semantics.",
  parameters: o_e
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                     |
| -------------------- | ----------------------------------------------------------------------------------- |
| `path`               | `ar.Yj().optional().describe("Directory to list (default: current directory)")`     |
| `limit`              | `ar.ai().optional().describe("Maximum number of entries to return (default: 500)")` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Directory to list (default: current directory)"
    },
    "limit": {
      "type": "number",
      "description": "Maximum number of entries to return (default: 500)"
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(o_e=ar.Ik({
  path:ar.Yj().optional().describe("Directory to list (default: current directory)"),limit:ar.ai().optional().describe("Maximum number of entries to return (default: 500)")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
m_e
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>f_e("piLsToolCall",new uk.Tf({
  result:{
    result:{
      case:"error",value:new uk.XJ({
        error:h_e(e)}
      )}
    }
  }
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:PI_LS:7695266]`。

<a id="agent-connect-scm"></a>

### CONNECT_SCM

模型名称 / 静态别名：`ConnectScm`。证据：`cursor-agent-exec`，工厂 `P_e`，UTF-16 偏移 `7698274`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "ConnectScm",
  descriptionGenerator: e=>`Offer the user a Connect GitHub prompt when source-control access would unblock the task, such as reviewing pull requests, opening pull requests, or acting on a repository. The user may connect, skip, or the attempt may fail. Offer this on your own initiative at most once per conversation; after a skip or failure, don't re-offer it unless the user explicitly asks to use ${C_e(e.allTools)}. Otherwise report what happened and continue without GitHub.`,
  parameters: I_e
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github_repo`        | `ar.Yj().regex(/^[^\s/]+\/[^\s/]+$/,"Expected repository in 'owner/name' form").optional().describe("Optional repository in 'owner/name' form that the user wants connected. Provide it when the user named a specific repo so the connect flow can also prompt to install the app there.")` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "github_repo": {
      "type": "string",
      "pattern": "^[^\\s/]+\\/[^\\s/]+$",
      "description": "Optional repository in 'owner/name' form that the user wants connected. Provide it when the user named a specific repo so the connect flow can also prompt to install the app there."
    }
  },
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(I_e=ar.Ik({
  github_repo:ar.Yj().regex(/^[^\s/]+\/[^\s/]+$/,"Expected repository in 'owner/name' form").optional().describe("Optional repository in 'owner/name' form that the user wants connected. Provide it when the user named a specific repo so the connect flow can also prompt to install the app there.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>Go(function(e,t){
  switch(e.result.case){
    case"success":return"Successfully connected the user's GitHub account. Source-control-dependent features (such as PR review) are now available.";
    case"error":{
      const r=e.result.value.error,n=r.includes("Connecting GitHub timed out")||r.includes("Connecting GitHub was canceled");
      return`GitHub could not be connected: ${r}. Report the failure and continue without GitHub for this conversation.${n?` The user may still be completing authorization in their browser; if they later say they finished connecting, call ${t} again to re-check (it completes instantly when the connection exists).`:` If the user says they have connected GitHub since, call ${t} again to re-check (it completes instantly when the connection exists).`}`}
    case"rejected":return`The user chose to skip connecting GitHub. Don't offer again on your own; only call ${t} again if the user explicitly asks. Continue without GitHub for now.`;
    case void 0:return"Unknown error while connecting GitHub";
    default:{
      const t=e.result;
      throw new Error(`Unhandled result case: ${String(t)}`)}
    }
  }
(t,C_e(r.allTools)))
```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  if(e instanceof p$)return E_e(new j.iO({
    result:new j.TK({
      result:{
        case:"rejected",value:new j.Uf({
          reason:e.message}
        )}
      }
    )}
  ));
  const t=e instanceof c$?e.clientVisibleErrorMessage:e instanceof Error?e.message:String(e);
  return E_e(new j.iO({
    result:new j.TK({
      result:{
        case:"error",value:new j.sr({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:CONNECT_SCM:7698274]`。

<a id="agent-set-active-branch"></a>

### SET_ACTIVE_BRANCH

模型名称 / 静态别名：`SetActiveBranch`。证据：`cursor-agent-exec`，工厂 `O_e`，UTF-16 偏移 `7702951`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "SetActiveBranch",
  descriptionGenerator: e=>"Set active git branch metadata for the current conversation and client UI. This directly controls which merge-base diff and related pull requests are shown to the user. Call this tool immediately when you are making changes on an existing feature branch, and call it immediately after committing changes to a new branch.",
  parameters: M_e
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                        |
| -------------------- | ---------------------------------------------------------------------- |
| `path`               | `ar.Yj().describe("Absolute repository path for this branch update.")` |
| `branchName`         | `ar.Yj().describe("New active branch name.")`                          |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "Absolute repository path for this branch update."
    },
    "branchName": {
      "type": "string",
      "description": "New active branch name."
    }
  },
  "required": [
    "path",
    "branchName"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(M_e=ar.Ik({
  path:ar.Yj().describe("Absolute repository path for this branch update."),branchName:ar.Yj().describe("New active branch name.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  switch(t.result.case){
    case"success":return Go("Active branch updated.");
    case"error":return Go(`Error: ${t.result.value.error}`);
    case void 0:return Go("Unknown error");
    default:{
      const e=t.result;
      throw new Error(`Unhandled result case: ${String(e)}`)}
    }
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:String(e);
  return J_e(new U.bct({
    result:new U.kxJ({
      result:{
        case:"error",value:new U.ZKF({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:SET_ACTIVE_BRANCH:7702951]`。

<a id="agent-adopt"></a>

### ADOPT

模型名称 / 静态别名：`Adopt`。证据：`cursor-agent-exec`，工厂 `匿名函数`，UTF-16 偏移 `7706249`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "Adopt",
  descriptionGenerator: ()=>"Reparent an eligible local or cloud agent under this Project agent. The source agent keeps its ID, conversation, and environment-owned Agent Store. Local agents may move only into local Projects; top-level local agents import their Store into the Project Store. This tool accepts only the source agent ID because the current Project agent is the trusted target.",
  parameters: q_e
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                   |
| -------------------- | --------------------------------------------------------------------------------- |
| `source_agent_id`    | `ar.Yj().min(1).describe("ID of the existing agent to adopt into this Project.")` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "source_agent_id": {
      "type": "string",
      "minLength": 1,
      "description": "ID of the existing agent to adopt into this Project."
    }
  },
  "required": [
    "source_agent_id"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(q_e=ar.Ik({
  source_agent_id:ar.Yj().min(1).describe("ID of the existing agent to adopt into this Project.")}
).strict())
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  switch(t.result.case){
    case"success":return Go(`Adopted agent ${t.sourceAgentId} under ${t.targetAgentId} in Project ${t.projectRootId} (${F_e[t.result.value]}).`);
    case"error":return Go(`Could not adopt the agent: ${t.result.value}`,!0);
    case void 0:return Go("Could not adopt the agent.",!0);
    default:return t.result}
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>N_e(new du.P({
  result:new du.qG({
    result:{
      case:"error",value:e instanceof Error?e.message:String(e)}
    }
  )}
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:ADOPT:7706249]`。

<a id="agent-send-to-user"></a>

### SEND_TO_USER

模型名称 / 静态别名：`SendToUser`。证据：`cursor-agent-exec`，工厂 `nSe`，UTF-16 偏移 `7724874`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "SendToUser",
  descriptionGenerator: ()=>"Display a message directly to the user. Use this for progress updates, partial results, or content the user must see exactly as written before the task finishes.",
  parameters: Lbe
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                               |
| -------------------- | ----------------------------------------------------------------------------- |
| `message`            | `ar.Yj().describe("The content to display to the user, exactly as written.")` |

</details>

<details>
<summary>JSON Schema（不包含所有自定义校验与转换）</summary>

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "The content to display to the user, exactly as written."
    }
  },
  "required": [
    "message"
  ],
  "additionalProperties": false,
  "$schema": "http://json-schema.org/draft-07/schema#"
}
```

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(Lbe=ar.Ik({
  message:ar.Yj().describe("The content to display to the user, exactly as written.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  switch(t.result.case){
    case"error":return Go(`Error: ${t.result.value.error}`);
    case"success":case void 0:return Go("ok");
    default:{
      const e=t.result;
      throw new Error(`Unhandled result case: ${String(e)}`)}
    }
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>$be(new zA.fC({
  result:new zA.Gg({
    result:{
      case:"error",value:new zA.zB({
        error:e instanceof Error?e.message:"Unknown error"}
      )}
    }
  )}
))
```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-exec:SEND_TO_USER:7724874]`。

<a id="agent-send-final-summary"></a>

### SEND_FINAL_SUMMARY

模型名称 / 静态别名：`sendFinalSummary`。证据：`cursor-agent-host`，工厂 `eP`，UTF-16 偏移 `7256881`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "sendFinalSummary",
  descriptionGenerator: e=>{
    return`\nSend a final summary of the work you have performed. Call this tool ONCE as your FINAL tool call before your final response. If your final response will be ~3 sentences or fewer, you may skip this tool call.\n\nGood summaries are concise, low-fluff, results-oriented, and 'show, don't tell'.\nIdeal vibe: a to-the-point Slack message to your startup's CTO.\nKeep them in the loop, but don't go too low-level. Impress them. Be honest if you have come up short.\n\nNote: users can click on the final summary to view your full response and the details of your work (i.e. your diff, tool calls, etc.). Stay high level. Do not get into the weeds or the nitty gritty details.\n\nThe user is busy and has a lot on their plate, so they are not concerned with these low-level minutiae.\n\nBRIEFLY explain the result of your work to the user, like a (non-clickbaity) push-notification style update. They can click to learn more.\n\n## Response format\n\nResponses have two main components\n- Brief, descriptive blocks of text (1-3 sentences)\n- Illustrative examples of completed work and/or evidence for your claims in the text\n\nThe user may not read the whole thing, so lead with what is important.\n\nIllustrative examples are helpful for letting users quickly grok what is important.\n\nUse up to 2 or 3 in your final summary (1 or 2 for small / simple tasks). They should be inline and preceded by a relevant block of text and a brief caption-like introduction explaining the example.\n\n## Illustrative Example Syntax\nYou may use the following syntax to add illustrative examples to your response\n\n- tool call references: if a prior tool result ends with \`<tool_call_id>abcdefg</tool_call_id>\`, you may use \`abcdefg\` in the reference syntaxes below. Use the short ID from the tag exactly; do not invent IDs.\n\n- edit diff display: display the diff from prior ${function(e){return e.APPLY_PATCH?.name??e.STR_REPLACE?.name}(t=e.allTools)??"file-edit"} tool call(s). Prefer the compact reference syntax when the relevant tool result included a \`<tool_call_id>\` tag:\n<diff edit_tool_call_id=abcdefg />\n\nIf no suitable tool-call ID tag is available, include a manual markdown diff. Before the diff, name the relative path to the file that was edited, surrounded by single-backticks.\n\`\`\`diff\n- deleted line 1\n- deleted line 2\n+ added line 1\n+ added line 2\n  unchanged line\n\`\`\`\n\n- completed shell command: display the ${t.SHELL?.name??"terminal"} command and the result (or an excerpt of the result). Prefer the compact reference syntax when the relevant tool result included a \`<tool_call_id>\` tag:\n<shell shell_tool_call_id=abcdefg />\n\nIf no suitable tool-call ID tag is available, include a manual markdown shell excerpt.\n\`\`\`sh\n$ command you ran\n[...] # include if there was additional output before the key output portion, and you have opted to exclude that output\n# key output of the command, faithfully reproduced line-by-line\n[...] # include if there was additional output after the key output portion, and you have opted to exclude that output\n\`\`\`\n\n- existing code in repo: render with markdown according to citation instructions.\n\`\`\`startLine:endLine:filepath\n// existing code\n\`\`\`\n\n- code (not actually added to repo): render with markdown.\n\`\`\`language\n// existing code...\n\`\`\`\n- shell commands (not actually run with shell tool): render with markdown and leading "$ ".\n\`\`\`sh\n$ command\n\`\`\`\n\n## General Response Syntax & Style\n- NEVER use emojis unless user asks for them specifically\n- NEVER use markdown headers (i.e. "#", "##", "###", etc.)\n- You may use other markdown syntax as desired to assist with clarity and readability.\n- BE CONCISE. Not too much detail. The user can always click if they want to learn more.\n- Use illustrative examples when helpful\n`.trim();
    var t}
  ,
  parameters: ZR
}

```

</details>

<details>
<summary>参数字段与约束（1 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `final_summary`      | `Ie.Yj().trim().min(1).describe("Brief final summary of the work you have performed. When helpful, include illustrative examples of completed work.")` |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(ZR=Ie.Ik({
  final_summary:Ie.Yj().trim().min(1).describe("Brief final summary of the work you have performed. When helpful, include illustrative examples of completed work.")}
))
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  switch(t.result.case){
    case"success":return(0,a.hU)("Final summary recorded.");
    case"error":return(0,a.hU)(`Error: ${t.result.value.error}`);
    case void 0:return(0,a.hU)("Unknown error");
    default:{
      const e=t.result;
      throw new Error(`Unhandled result case: ${String(e)}`)}
    }
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:"Unknown error";
  return XR(new VR.V2({
    result:new VR.sA({
      result:{
        case:"error",value:new VR.lX({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-host:SEND_FINAL_SUMMARY:7256881]`。

<a id="agent-communicate-update"></a>

### COMMUNICATE_UPDATE

模型名称 / 静态别名：`UpdateCurrentStep`。证据：`cursor-agent-host`，工厂 `mP`，UTF-16 偏移 `7265779`。

<details>
<summary>名称、完整描述生成表达式与参数入口</summary>

```javascript
{

  name: "UpdateCurrentStep",
  descriptionGenerator: ()=>["Record a concise (6 words or less), user-friendly update of the major step or phase you are working on for the parent timeline.","Update when the subtask changes.",...r?["Set `final_summary` and `completed_subtitle` ONCE per response as your last action before the final response."]:[],"ALWAYS use in parallel with at least one other tool.","ALWAYS start the update with a descriptive verb."].join(" "),
  parameters: n
}

```

</details>

<details>
<summary>参数字段与约束（2 条表达式）</summary>

| 字段（含嵌套与变体） | 类型 / 约束原式                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `current_step`       | `aP`                                                                                                                                    |
| `current_step`       | `iP.describe("Major step or phase you are on. Update when the subtask changes. Keep the text concise, high-level, and user-friendly.")` |

</details>

<details>
<summary>参数入口的原始构造代码</summary>

```javascript
(n=r?cP.extend({
  final_summary:lP,completed_subtitle:dP}
).superRefine((e,t)=>{
  !function(e,t,r){
    r.some(t=>{
      return void 0!==(r=e[t])&&r.trim().length>0;
      var r}
    )||t.addIssue({
      code:FT.eq.custom,message:`At least one of ${r.join(", ")} must be provided.`}
    )}
  (e,t,["current_step","final_summary","completed_subtitle"])}
):uP)
```

</details>

<details>
<summary>返回模型的输出代码（完整 render）</summary>

```javascript
async(e,t,r)=>{
  switch(t.result.case){
    case"success":return(0,a.hU)("Progress update recorded.");
    case"error":return(0,a.hU)(`Error: ${t.result.value.error}`);
    case void 0:return(0,a.hU)("Unknown error");
    default:{
      const e=t.result;
      throw new Error(`Unhandled result case: ${String(e)}`)}
    }
  }

```

</details>

<details>
<summary>错误序列化代码</summary>

```javascript
e=>{
  const t=e instanceof Error?e.message:"Unknown error";
  return pP(new tP.fd({
    result:new tP.CH({
      result:{
        case:"error",value:new tP.H6({
          error:t}
        )}
      }
    )}
  ))}

```

</details>

完整执行函数、工厂上下文及依赖：JSON `factories[id = cursor-agent-host:COMMUNICATE_UPDATE:7265779]`。

## 3. 浏览器 Provider：16 个完整定义

每项 parameters 是原数组中的 JSON Schema；输出路由是同一安装包中对应的 switch 分支。实际行为还会调用编辑器浏览器 API，源码不是执行样例。

### browser_navigate

```json
{
  "name": "browser_navigate",
  "description": "Navigate to a URL. By default reuses an existing tab; set newTab: true to open in a new tab.",
  "parameters": {
    "type": "object",
    "properties": {
      "url": {
        "type": "string",
        "description": "The URL to navigate to"
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "position": {
        "type": "string",
        "enum": [
          "active",
          "side"
        ],
        "description": "Only set when the user explicitly asks to reveal, show, focus, or open the browser visibly. Set to \"active\" for visible/revealed browser UI, or \"side\" if the user mentions \"side\", \"beside\", \"side panel\", or \"side by side\". Omit this parameter for background automation so focus is preserved."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after navigation completes. Defaults to false."
      },
      "newTab": {
        "type": "boolean",
        "description": "When true, creates a new tab before navigating instead of reusing an existing tab. Defaults to false."
      }
    },
    "required": [
      "url"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_navigate":{const t=e;r=await Et.navigate(t,o);break}
```

</details>

### browser_snapshot

```json
{
  "name": "browser_snapshot",
  "description": "Capture accessibility snapshot of the current page, this is better than screenshot",
  "parameters": {
    "type": "object",
    "properties": {
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "interactive": {
        "type": "boolean",
        "description": "When true, only include interactive elements in the snapshot. Defaults to false."
      },
      "maxDepth": {
        "type": "number",
        "description": "Maximum depth for snapshot output. Defaults to 20."
      },
      "compact": {
        "type": "boolean",
        "description": "When true, outputs a more compact snapshot format. Defaults to false."
      },
      "selector": {
        "type": "string",
        "description": "Optional CSS selector to scope the snapshot to a subtree."
      },
      "includeDiff": {
        "type": "boolean",
        "description": "When true, include a diff vs the previous snapshot for this tab. Defaults to false."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after snapshot completes. Defaults to false."
      }
    },
    "required": []
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_snapshot":r=await Et.snapshot(e,o);break;
```

</details>

### browser_click

```json
{
  "name": "browser_click",
  "description": "Click an element by ref from browser_snapshot. Use this instead of CDP Input.* methods.",
  "parameters": {
    "type": "object",
    "properties": {
      "ref": {
        "type": "string",
        "description": "Element ref from browser_snapshot."
      },
      "element": {
        "type": "string",
        "description": "Human-readable description of the element."
      },
      "offsetX": {
        "type": "number",
        "description": "Optional x offset from the element center."
      },
      "offsetY": {
        "type": "number",
        "description": "Optional y offset from the element center."
      },
      "doubleClick": {
        "type": "boolean",
        "description": "When true, double-click the element."
      },
      "button": {
        "type": "string",
        "enum": [
          "left",
          "right",
          "middle"
        ],
        "description": "Mouse button. Defaults to left."
      },
      "modifiers": {
        "type": "array",
        "items": {
          "type": "string",
          "enum": [
            "Control",
            "Shift",
            "Alt",
            "Meta",
            "ControlOrMeta"
          ]
        },
        "description": "Optional modifier keys."
      },
      "holdDurationMs": {
        "type": "number",
        "description": "Optional mouse hold duration before release."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after the click completes. Defaults to false."
      }
    },
    "required": [
      "ref"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_click":r=await Et.click(e,o);break;
```

</details>

### browser_mouse_click_xy

```json
{
  "name": "browser_mouse_click_xy",
  "description": "Click at viewport coordinates. Prefer browser_click with refs when possible.",
  "parameters": {
    "type": "object",
    "properties": {
      "x": {
        "type": "number",
        "description": "Viewport x coordinate."
      },
      "y": {
        "type": "number",
        "description": "Viewport y coordinate."
      },
      "button": {
        "type": "string",
        "enum": [
          "left",
          "right",
          "middle"
        ],
        "description": "Mouse button. Defaults to left."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after the click completes. Defaults to false."
      }
    },
    "required": [
      "x",
      "y"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_mouse_click_xy":r=await Et.mouseClickXY(e,o);break;
```

</details>

### browser_type

```json
{
  "name": "browser_type",
  "description": "Type text into an input, textarea, or contenteditable element by ref.",
  "parameters": {
    "type": "object",
    "properties": {
      "ref": {
        "type": "string",
        "description": "Element ref from browser_snapshot."
      },
      "text": {
        "type": "string",
        "description": "Text to type."
      },
      "element": {
        "type": "string",
        "description": "Human-readable description of the element."
      },
      "clear": {
        "type": "boolean",
        "description": "When true, clear existing text first."
      },
      "submit": {
        "type": "boolean",
        "description": "When true, press Enter after typing."
      },
      "slowly": {
        "type": "boolean",
        "description": "When true, type character by character."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after typing completes. Defaults to false."
      }
    },
    "required": [
      "ref",
      "text"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_type":r=await Et.type(e,o);break;
```

</details>

### browser_fill

```json
{
  "name": "browser_fill",
  "description": "Set the value of an input, textarea, or contenteditable element by ref.",
  "parameters": {
    "type": "object",
    "properties": {
      "ref": {
        "type": "string",
        "description": "Element ref from browser_snapshot."
      },
      "value": {
        "type": "string",
        "description": "Value to set."
      },
      "element": {
        "type": "string",
        "description": "Human-readable description of the element."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after filling completes. Defaults to false."
      }
    },
    "required": [
      "ref",
      "value"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_fill":r=await Et.fill(e,o);break;
```

</details>

### browser_select_option

```json
{
  "name": "browser_select_option",
  "description": "Select one or more options in a select element by ref.",
  "parameters": {
    "type": "object",
    "properties": {
      "ref": {
        "type": "string",
        "description": "Element ref from browser_snapshot."
      },
      "values": {
        "type": "array",
        "items": {
          "type": "string"
        },
        "description": "Option values or labels to select."
      },
      "element": {
        "type": "string",
        "description": "Human-readable description of the element."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after selection completes. Defaults to false."
      }
    },
    "required": [
      "ref",
      "values"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_select_option":r=await Et.selectOption(e,o);break;
```

</details>

### browser_press_key

```json
{
  "name": "browser_press_key",
  "description": "Press a key in the browser page using DOM keyboard events.",
  "parameters": {
    "type": "object",
    "properties": {
      "key": {
        "type": "string",
        "description": "Key to press, for example Enter, Escape, Tab, ArrowDown, or a single character."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after the key press completes. Defaults to false."
      }
    },
    "required": [
      "key"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_press_key":r=await Et.pressKey(e,o);break;
```

</details>

### browser_scroll

```json
{
  "name": "browser_scroll",
  "description": "Scroll the page, a scrollable container, or an element into view. Use this instead of CDP Input.* wheel events.",
  "parameters": {
    "type": "object",
    "properties": {
      "ref": {
        "type": "string",
        "description": "Optional element ref from browser_snapshot."
      },
      "direction": {
        "type": "string",
        "enum": [
          "up",
          "down",
          "left",
          "right"
        ],
        "description": "Scroll direction."
      },
      "amount": {
        "type": "number",
        "description": "Scroll amount in pixels. Defaults to 300."
      },
      "deltaX": {
        "type": "number",
        "description": "Explicit horizontal scroll delta."
      },
      "deltaY": {
        "type": "number",
        "description": "Explicit vertical scroll delta."
      },
      "scrollIntoView": {
        "type": "boolean",
        "description": "When true, scroll the ref into view."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after scrolling completes. Defaults to false."
      }
    },
    "required": []
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_scroll":r=await Et.scroll(e,o);break;
```

</details>

### browser_drag

```json
{
  "name": "browser_drag",
  "description": "Drag an element by ref to another ref or viewport coordinates.",
  "parameters": {
    "type": "object",
    "properties": {
      "sourceRef": {
        "type": "string",
        "description": "Source element ref from browser_snapshot."
      },
      "targetRef": {
        "type": "string",
        "description": "Optional target element ref from browser_snapshot."
      },
      "targetX": {
        "type": "number",
        "description": "Optional target viewport x coordinate."
      },
      "targetY": {
        "type": "number",
        "description": "Optional target viewport y coordinate."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after drag completes. Defaults to false."
      }
    },
    "required": [
      "sourceRef"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_drag":r=await Et.drag(e,o);break;
```

</details>

### browser_get_bounding_box

```json
{
  "name": "browser_get_bounding_box",
  "description": "Get the viewport bounding box for an element ref.",
  "parameters": {
    "type": "object",
    "properties": {
      "ref": {
        "type": "string",
        "description": "Element ref from browser_snapshot."
      },
      "element": {
        "type": "string",
        "description": "Human-readable description of the element."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      }
    },
    "required": [
      "ref"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_get_bounding_box":r=await Et.getBoundingBox(e,o);break;
```

</details>

### browser_highlight

```json
{
  "name": "browser_highlight",
  "description": "Highlight an element by ref in the browser page for visual grounding.",
  "parameters": {
    "type": "object",
    "properties": {
      "ref": {
        "type": "string",
        "description": "Element ref from browser_snapshot."
      },
      "element": {
        "type": "string",
        "description": "Human-readable description of the element."
      },
      "durationMs": {
        "type": "number",
        "description": "Highlight duration in milliseconds. Defaults to 2000."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      }
    },
    "required": [
      "ref"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_highlight":r=await Et.highlight(e,o);break;
```

</details>

### browser_tabs

```json
{
  "name": "browser_tabs",
  "description": "List, create, close, or select a browser tab",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "list",
          "new",
          "close",
          "select"
        ],
        "description": "Operation to perform"
      },
      "index": {
        "type": "number",
        "description": "Tab index. Required for \"select\". Optional for \"close\" (defaults to current tab)."
      },
      "position": {
        "type": "string",
        "enum": [
          "active",
          "side"
        ],
        "description": "Only set for action \"new\" when the user explicitly asks to reveal, show, focus, or open the browser visibly. Set to \"active\" for visible/revealed browser UI, or \"side\" if the user mentions \"side\", \"beside\", \"side panel\", or \"side by side\". Omit this parameter for background automation so focus is preserved."
      }
    },
    "required": [
      "action"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_tabs":{const t=e;r=await Et.tabs(t,o);break}
```

</details>

### browser_cdp

```json
{
  "name": "browser_cdp",
  "description": "Send a Chrome DevTools Protocol command to the target browser tab. Do not use CDP Input.* methods; use dedicated browser tools for clicks, text input, key presses, scrolling, and drag-and-drop. Browser-wide, storage, cookie, permission, download, target-management, and system-level commands are denied.",
  "parameters": {
    "type": "object",
    "properties": {
      "method": {
        "type": "string",
        "description": "CDP method name, for example Runtime.evaluate, DOM.getDocument, Profiler.start, or Performance.getMetrics."
      },
      "params": {
        "type": "object",
        "description": "CDP params object. Omit or pass {} when the command takes no params."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      },
      "take_screenshot_afterwards": {
        "type": "boolean",
        "description": "When true, takes a screenshot after the CDP command completes. Defaults to false."
      }
    },
    "required": [
      "method"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_cdp":{r=await Et.cdp(e,o);const t=function(t){return t?.conversationId??t?.composerId}(n),s=function(t){for(const e of t.content)if("metadata"===e.type)return e.viewId}(r);void 0!==t&&void 0!==s&&this.cdpTurnTracker.record(t,{viewId:s,ownerAgentId:o.ownerAgentId});break}
```

</details>

### browser_take_screenshot

```json
{
  "name": "browser_take_screenshot",
  "description": "Take a screenshot of the current page. You can't perform actions based on the screenshot, use browser_snapshot for actions.",
  "parameters": {
    "type": "object",
    "properties": {
      "type": {
        "type": "string",
        "description": "Image format for the screenshot. Default is png."
      },
      "filename": {
        "type": "string",
        "description": "File name to save the screenshot to. Defaults to page-{timestamp}.{png|jpeg} if not specified."
      },
      "element": {
        "type": "string",
        "description": "Description of the element, if taking a screenshot of an element"
      },
      "ref": {
        "type": "string",
        "description": "CSS selector for the element, if taking a screenshot of an element"
      },
      "fullPage": {
        "type": "boolean",
        "description": "When true, takes a screenshot of the full scrollable page, instead of the currently visible viewport. Cannot be used with element screenshots."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      }
    },
    "required": []
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_take_screenshot":r=await Et.takeScreenshot(e,o);break;
```

</details>

### browser_lock

```json
{
  "name": "browser_lock",
  "description": "Lock or unlock the browser to control whether the user can interact while you work. Set action to \"lock\" or \"unlock\". When locked, the user can still click \"Take Control\" to unlock if needed.",
  "parameters": {
    "type": "object",
    "properties": {
      "action": {
        "type": "string",
        "enum": [
          "lock",
          "unlock"
        ],
        "description": "Whether to lock or unlock the browser for user interaction."
      },
      "viewId": {
        "type": "string",
        "description": "Target browser tab ID. If omitted, uses the last interacted tab."
      }
    },
    "required": [
      "action"
    ]
  }
}
```

<details>
<summary>调用与输出处理代码</summary>

```javascript
case"browser_lock":r=await Et.lock(e,o);break;
```

</details>

## 4. Computer-use Provider：19 个描述符

下方展示 macOS app scope 条件下构造的定义；JSON 同时保留 macOS screen 与 Windows screen 条件。`computer_zoom` 的提供受 Windows 判断控制；`computer_apps`、`computer_resolve_app`、`computer_app_state`、`computer_set_value`、`computer_app_action` 来自 app scope 分支；`computer_batch` 和 `computer_attempt` 还有 gate。某个条件下能展开一个描述符，不等于 Provider 会在该条件下提供它。

通用输出整理函数 `Nl` 会返回文本，并在服务结果带 screenshot 时加入 image 块；app 目标由 `Ul` 整理文本 / structuredContent，部分操作返回图片。每个工具的 run 下方都保留，判断输出时需要同时看这些共享函数。

### computer_batch

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_batch",
  "description": "Run up to 6 actions as one call with one screenshot at the end (8 when every step is computer_key or computer_type), for a sequence already planned from the current screenshot: pick a tool, then a color, then draw; type a value, then press Return. Each step names a tool and its usual args; coordinates and zoom_ids describe the screen as it is now. The batch stops at the first refused step, at an expect_change step that changed nothing visible, or when the foreground window or its title changes; the result reports each step's change and target and names the steps that did not run. Do not batch past a step that opens a window, menu or dialog the next step needs to see. Delete, Backspace, Alt+F4, Ctrl+W, Ctrl+Q, Ctrl+X and Win+L need allow_destructive.",
  "parameters": {
    "type": "object",
    "properties": {
      "steps": {
        "type": "array",
        "minItems": 1,
        "maxItems": 8,
        "items": {
          "type": "object",
          "properties": {
            "tool": {
              "type": "string",
              "enum": [
                "computer_click",
                "computer_drag",
                "computer_key",
                "computer_type",
                "computer_scroll",
                "computer_move"
              ]
            },
            "args": {
              "type": "object",
              "description": "That tool's arguments, as for a lone call."
            },
            "expect_change": {
              "type": "boolean",
              "description": "Stop the batch if this step changes nothing visible."
            }
          },
          "required": [
            "tool",
            "args"
          ]
        }
      },
      "allow_destructive": {
        "type": "boolean",
        "description": "Allow keys that delete, cut, close or lock."
      }
    },
    "required": [
      "steps"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(n,t,{
  steps:a,allow_destructive:s}
)=>{
  if(void 0===t.batch)throw new Error("The batch needs the Windows computer-use sidecar. Run the steps as separate calls.");
  const o=a.map((n,t)=>function(e,n,t){
    const a=e.get(n.tool);
    if(void 0===a)throw Ll("invalid_arguments",`Invalid arguments for computer_batch: steps[${t}] names ${n.tool}, which is not a tool of this toolset.`);
    const s=`Invalid arguments for computer_batch: steps[${t}] (${n.tool})`;
    if(Pl){
      const e=Object.keys(n.args).filter(e=>!a.advertised.has(e));
      if(e.length>0){
        const t=e=>e.map(e=>`"${e}"`).join(", ");
        throw Ll("invalid_arguments",`${s}: unknown argument${1===e.length?"":"s"} ${t(e)}; the arguments of ${n.tool} are ${t([...a.advertised])}.`)}
      }
    const o=e=>Ll("invalid_arguments",`${s}: ${Gl(e)}`),r=(e,t)=>({
      name:e,arguments:t,expectChange:n.expect_change??!1}
    ),i=e=>void 0===e?{
      }
    :{
      zoom_id:e}
    ;
    switch(n.tool){
      case"computer_click":{
        const e=Yc.safeParse(n.args);
        if(!e.success)throw o(e.error);
        const{
          x:t,y:a,button:s,count:A,zoom_id:c}
        =e.data;
        return r("computer_use_click",{
          x:t,y:a,button:s??"left",count:A??1,...i(c)}
        )}
      case"computer_move":{
        const e=Jc.safeParse(n.args);
        if(!e.success)throw o(e.error);
        const{
          x:t,y:a,zoom_id:s}
        =e.data;
        return r("computer_use_mouse_move",{
          x:t,y:a,...i(s)}
        )}
      case"computer_drag":{
        const e=Hc.safeParse(n.args);
        if(!e.success)throw o(e.error);
        return r("computer_use_drag",{
          button:e.data.button??"left",path:Wc(e.data),...i(e.data.zoom_id)}
        )}
      case"computer_type":{
        const e=Kc.safeParse(n.args);
        if(!e.success)throw o(e.error);
        return r("computer_use_typing",{
          value:e.data.text}
        )}
      case"computer_key":{
        const e=$c.safeParse(n.args);
        if(!e.success)throw o(e.error);
        return r("computer_use_press_key",{
          key:e.data.key}
        )}
      case"computer_scroll":{
        const e=Xc.safeParse(n.args);
        if(!e.success)throw o(e.error);
        const{
          x:t,y:a,direction:s,amount:A,zoom_id:c}
        =e.data;
        return r("computer_use_scroll",{
          x:t,y:a,direction:s??"down",amount:A??mc,...i(c)}
        )}
      default:{
        const e=n.tool;
        throw new Error(`Unhandled batch step tool ${String(e)}`)}
      }
    }
  (e,n,t));
  return Nl(await t.batch(n,{
    steps:o,allowDestructive:s??!1}
  ),"Ran the batch.")}

```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
tl
```

</details>

### computer_screenshot

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_screenshot",
  "description": "Take a screenshot of the primary display, or of one app's window with an app target. Coordinates are pixels in the fixed undefined screenshot canvas, origin (0, 0) at the top-left. Take one before your first coordinate-based action and whenever the screen may have changed. An app-target screenshot is the image. When a live snapshot is still fresh it reuses that snapshot_id and does not walk. If snapshot_id is present, do not call computer_app_state. Otherwise the image returns without a tree; call computer_app_state when you need element ids.",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n,{
  target:t}
)=>"app"===t?.scope?Ul(e,n,"computer_use_screenshot",t,{
  }
,"Captured a screenshot."):Nl(await n.screenshot(e),"Captured a screenshot.")
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
ln({target:Mc})
```

</details>

### computer_click

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_click",
  "description": "Click at a screen coordinate. Coordinates are pixels in the fixed undefined screenshot canvas, origin (0, 0) at the top-left. Locate the target in a fresh screenshot first. Returns a screenshot taken after the click. With an app target the result is text only; observe again before the next action.",
  "parameters": {
    "type": "object",
    "properties": {
      "x": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1279,
        "description": "X pixel coordinate in the 1280×800 screenshot canvas."
      },
      "y": {
        "type": "integer",
        "minimum": 0,
        "maximum": 799,
        "description": "Y pixel coordinate in the 1280×800 screenshot canvas."
      },
      "button": {
        "type": "string",
        "enum": [
          "left",
          "right",
          "middle"
        ],
        "description": "Mouse button. Defaults to left."
      },
      "count": {
        "type": "integer",
        "minimum": 1,
        "maximum": 3,
        "description": "Click count; 2 double-clicks. Defaults to 1."
      }
    },
    "required": [
      "x",
      "y"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n,{
  target:t,zoom_id:a,...s}
)=>"app"===t?.scope?Ul(e,n,"computer_use_click",t,s,"Clicked."):async function(e,n){
  const t=await Nl(e,"Clicked."),a=Ol(n,e),s=t.content[0];
  return void 0!==a&&"text"===s?.type&&(s.text=`${s.text} ${a}`),t}
(await n.click(e,{
  coordinate:{
    x:s.x,y:s.y}
  ,button:s.button??"left",count:s.count??1,...Rl(a)}
),{
  y:s.y,zoom_id:a}
)
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Yc
```

</details>

### computer_move

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_move",
  "description": "Move the mouse cursor to a screen coordinate without clicking. Coordinates are pixels in the fixed undefined screenshot canvas, origin (0, 0) at the top-left. Useful for revealing hover UI. Returns a screenshot taken after the move. With an app target the result is text only; observe again before the next action.",
  "parameters": {
    "type": "object",
    "properties": {
      "x": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1279,
        "description": "X pixel coordinate in the 1280×800 screenshot canvas."
      },
      "y": {
        "type": "integer",
        "minimum": 0,
        "maximum": 799,
        "description": "Y pixel coordinate in the 1280×800 screenshot canvas."
      }
    },
    "required": [
      "x",
      "y"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n,{
  target:t,zoom_id:a,...s}
)=>{
  if("app"===t?.scope)return Ul(e,n,"computer_use_mouse_move",t,s,"Moved the cursor.");
  const o=Rl(a);
  return Nl(void 0===o?await n.move(e,{
    x:s.x,y:s.y}
  ):await n.move(e,{
    x:s.x,y:s.y}
  ,o),"Moved the cursor.")}

```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Jc
```

</details>

### computer_drag

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_drag",
  "description": "Press the mouse button at one coordinate, drag to another, and release. Coordinates are pixels in the fixed undefined screenshot canvas, origin (0, 0) at the top-left. Locate both points in a fresh screenshot first. Returns a screenshot taken after the drag. With an app target the result is text only; observe again before the next action.",
  "parameters": {
    "type": "object",
    "properties": {
      "from": {
        "type": "object",
        "properties": {
          "x": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1279
          },
          "y": {
            "type": "integer",
            "minimum": 0,
            "maximum": 799
          }
        },
        "required": [
          "x",
          "y"
        ],
        "description": "Drag start point in latest-screenshot pixels."
      },
      "to": {
        "type": "object",
        "properties": {
          "x": {
            "type": "integer",
            "minimum": 0,
            "maximum": 1279
          },
          "y": {
            "type": "integer",
            "minimum": 0,
            "maximum": 799
          }
        },
        "required": [
          "x",
          "y"
        ],
        "description": "Drag end point in latest-screenshot pixels."
      },
      "button": {
        "type": "string",
        "enum": [
          "left",
          "right",
          "middle"
        ],
        "description": "Mouse button to hold. Defaults to left."
      }
    },
    "required": [
      "from",
      "to"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n,t)=>{
  const a=Wc(t);
  return"app"===t.target?.scope?Ul(e,n,"computer_use_drag",t.target,{
    ...jc(t),path:a}
  ,"Dragged."):Nl(await n.drag(e,{
    button:t.button??"left",path:a,...Rl(t.zoom_id)}
  ),"Dragged.")}

```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Hc
```

</details>

### computer_type

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_type",
  "description": "Type into a macOS app. Prefer computer_set_value or computer_type with element_id. Without element_id, inserts into the click-selected field via AX, or the focused field. A missed click target is refused. If nothing is focused, click a field first. Does not raise or move the real cursor. Screen-scope typing is refused. The result is text only.",
  "parameters": {
    "type": "object",
    "properties": {
      "text": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "Text to type."
      },
      "element_id": {
        "type": "integer",
        "minimum": 1,
        "description": "An element id in brackets from computer_app_state."
      },
      "snapshot_id": {
        "type": "string",
        "minLength": 1,
        "description": "The snapshot_id from computer_app_state, or from a screenshot that reused a live handle. It stays valid across actions until you read a new tree, the window or app changes, or an edit opens a sheet or replaces the tree. Do not call computer_app_state after a screenshot that reused snapshot_id; read computer_app_state when a screenshot omitted the tree or an action reports the snapshot stale."
      }
    },
    "required": [
      "text"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n,{
  target:t,text:a,...s}
,o)=>(function(e,n){
  if(n.companionDefault&&zA&&"app"!==e.target?.scope)throw Ll("invalid_arguments",'Invalid arguments for computer_type: target: Screen-scope typing is refused. Pass {"scope":"app","pid":…,"target_id":…}. Prefer computer_set_value or computer_type with element_id when the field is marked settable. Without element_id, click a text field first if nothing text-like is focused.')}
({
  target:t}
,o),"app"===t?.scope?Ul(e,n,"computer_use_typing",t,{
  ...s,value:a}
,"Typed."):Nl(await n.typeText(e,a),"Typed."))
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Kc
```

</details>

### computer_key

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_key",
  "description": "Press a key or shortcut, such as \"Return\", \"Escape\", \"Tab\", or a chord like \"cmd+l\" on macOS and \"ctrl+l\" on Windows. Combine modifiers with \"+\" (cmd, ctrl, alt, shift). Returns a screenshot taken after the key press. With an app target the result is text only; observe again before the next action.",
  "parameters": {
    "type": "object",
    "properties": {
      "key": {
        "type": "string",
        "maxLength": 100,
        "description": "Key or shortcut, e.g. \"Return\", \"Tab\", or \"cmd+shift+s\"."
      }
    },
    "required": [
      "key"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n,{
  target:t,...a}
)=>"app"===t?.scope?Ul(e,n,"computer_use_press_key",t,a,"Pressed the key."):Nl(await n.pressKey(e,a.key),"Pressed the key.")
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
$c
```

</details>

### computer_scroll

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_scroll",
  "description": "Scroll at a screen coordinate. Coordinates are pixels in the fixed undefined screenshot canvas, origin (0, 0) at the top-left. Returns a screenshot taken after scrolling. With an app target the result is text only; observe again before the next action.",
  "parameters": {
    "type": "object",
    "properties": {
      "x": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1279,
        "description": "X pixel coordinate in the 1280×800 screenshot canvas."
      },
      "y": {
        "type": "integer",
        "minimum": 0,
        "maximum": 799,
        "description": "Y pixel coordinate in the 1280×800 screenshot canvas."
      },
      "direction": {
        "type": "string",
        "enum": [
          "up",
          "down",
          "left",
          "right"
        ],
        "description": "Scroll direction. Defaults to down."
      },
      "amount": {
        "type": "integer",
        "minimum": 1,
        "maximum": 20,
        "description": "Scroll amount in wheel ticks. Defaults to 3."
      }
    },
    "required": [
      "x",
      "y"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n,{
  target:t,zoom_id:a,...s}
)=>"app"===t?.scope?Ul(e,n,"computer_use_scroll",t,{
  ...s,direction:s.direction??"down"}
,"Scrolled."):Nl(await n.scroll(e,{
  coordinate:{
    x:s.x,y:s.y}
  ,direction:s.direction??"down",amount:s.amount??mc,...Rl(a)}
),"Scrolled.")
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Xc
```

</details>

### computer_wait

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_wait",
  "description": "Wait for a page load or animation to settle. Returns text only; it does not capture the display. Observe afterward with computer_screenshot (app target) or computer_app_state.",
  "parameters": {
    "type": "object",
    "properties": {
      "ms": {
        "type": "integer",
        "minimum": 0,
        "maximum": 30000,
        "description": "Milliseconds to wait. Defaults to 1000."
      }
    }
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(n,t,a,s)=>{
  const o=a.ms??1e3;
  if(await s.delay(o),e)return{
    content:[{
      type:"text",text:`Waited ${o}ms. Observe with computer_screenshot (app target) or computer_app_state.`}
    ]}
  ;
  await s.preflight(n);
  const r=uc&&void 0!==t.screenshotAfterWait?await t.screenshotAfterWait(n):await t.screenshot(n);
  return{
    content:[{
      type:"text",text:`Waited ${o}ms.`}
    ,...(await Nl(r,"Captured a screenshot.")).content]}
  }

```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Zc
```

</details>

### computer_attempt

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_attempt",
  "description": "Carry out a list of small UI steps in a macOS app without reading the tree yourself. Prefer it when you know the next few UI steps; for a single action on an element you already know, call the element tool directly. Decompose the task first: each step is ONE control or ONE visible state change (press one button, open one sidebar item, type \"text\" into one field, confirm one field), with an expect naming what the screen shows once it is done. Never make a step that only focuses or clicks a field: typing into a field focuses it, so put the text in the typing step (type \"x\" into the search field). Each expect must name a control or value that appears in the tree (\"a button named X appears\", not \"search results are visible\" or \"the field is focused\"). Do not pass a multi-step task as one step (not \"enter 1+2+3+4\"; pass press 1 / press Add / press 2 ... as separate steps, each with its expected display); the decider inside is fast and accurate at picking one control and checking one outcome, and does not plan sequences. For each step a deterministic loop reads computer_app_state, asks the decider for the next action, acts, and checks the outcome, up to max_steps actions (default 8); it stops the step as done when the screen shows its result and expect holds, or as failed when its target is absent, disabled, or blocked. Steps run in order and stop at the first that fails. Text to enter goes in quotes inside the step. Returns OK or ERR with one status line per step (done, failed, not run), then changed: (what the call changed on screen), now: (a compact view of the final screen: its controls and values, windows, sheets, and menus), a short trace, and the final snapshot_id. Plan your next steps from that view, and read values from now: before calling computer_app_state, which you need only for element ids or more detail. A failed step with 0 actions was not tried and changed nothing; one that acted may have landed, so check now: before redoing it. On ERR do only the failed step with the element tools, then send the remaining steps back to computer_attempt. Text only, no image.",
  "parameters": {
    "type": "object",
    "properties": {
      "target": {
        "type": "object",
        "properties": {
          "scope": {
            "type": "string",
            "const": "app"
          },
          "pid": {
            "type": "integer",
            "minimum": 1,
            "description": "pid from computer_apps or computer_resolve_app."
          },
          "target_id": {
            "type": "string",
            "minLength": 1,
            "description": "target_id from computer_apps or computer_resolve_app."
          }
        },
        "required": [
          "scope",
          "pid",
          "target_id"
        ],
        "description": "The app to act on."
      },
      "step": {
        "type": "string",
        "description": "A single small step: one control or one visible state change, in plain words, with any text to type in quotes (e.g. press the Add key; type \"house music\" into the search field). Pass this or steps."
      },
      "expect": {
        "type": "string",
        "description": "What the screen shows once this step is done, e.g. the display shows 1+. Give it on every step; the loop does not mark a step done until it holds."
      },
      "steps": {
        "type": "array",
        "minItems": 1,
        "maxItems": 24,
        "description": "The decomposed task: one {step, expect} per control or state change, in order. Pass this or step.",
        "items": {
          "type": "object",
          "properties": {
            "step": {
              "type": "string",
              "description": "One control or one visible state change."
            },
            "expect": {
              "type": "string",
              "description": "What the screen shows once this step is done."
            }
          },
          "required": [
            "step"
          ]
        }
      },
      "max_steps": {
        "type": "integer",
        "minimum": 1,
        "maximum": 12,
        "description": "Actions to try per step before giving up. Default 8; a well-decomposed step needs one."
      }
    },
    "required": [
      "target"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n,{
  target:t,...a}
,s)=>{
  const o=s.attempt;
  if(void 0===o||void 0===n.callCompanion)throw new Error("computer_attempt needs the macOS computer-use helper and a signed-in Cursor account.");
  const r=n.callCompanion.bind(n),{
    text:i,isError:A,summary:c}
  =await KA({
    decider:{
      decide:n=>o.decide(n,e.signal)}
    ,call:(n,a)=>r(e,n,{
      pid:t.pid,target_id:t.target_id,...a}
    ),args:{
      steps:a.steps??[{
        step:a.step??"",...void 0===a.expect?{
          }
        :{
          expect:a.expect}
        }
      ],max_steps:a.max_steps}
    }
  );
  return{
    content:[{
      type:"text",text:i}
    ],...A?{
      isError:A}
    :{
      }
    ,structuredContent:{
      code:"attempt",attempt:c}
    }
  }

```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Kl
```

</details>

### computer_check_permissions

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_check_permissions",
  "description": "Passively report whether the Accessibility and Screen Recording permissions the computer-use helper needs are granted. On Windows both are always granted. Call computer_check_permissions first and wait for its result before any other Computer Use tool; do not call Computer Use tools in parallel, they act on one machine and run one at a time.",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n)=>Nl(await n.checkPermissions(e),"Reported permission state.")
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Qc
```

</details>

### computer_start_control

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_start_control",
  "description": "Escalation only: take over the display and move the real cursor. App targets need no session. Do not call this to type or fill a form.",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n)=>(await n.startControl(e),{
  content:[{
    type:"text",text:"Remote control is ready."}
  ]}
)
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Qc
```

</details>

### computer_release_control

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_release_control",
  "description": "Release remote control after the final screen-scope action.",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n)=>(await n.releaseControl(e),{
  content:[{
    type:"text",text:"Released remote control."}
  ]}
)
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Qc
```

</details>

### computer_zoom

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_zoom",
  "description": "Return a region of the latest screenshot as a separate image at native resolution (up to 4×), so small or dense UI becomes legible. (x1, y1) is the top-left corner and (x2, y2) the bottom-right, inclusive; 20% padding is added; the region may be up to 914 canvas px on its long edge at any aspect, and one under 120×60 is widened to it. The result quotes a zoom_id and the image size: pass that zoom_id with x and y in zoom-image pixels to computer_click, computer_move, computer_scroll, or computer_drag. Actions still return a full-canvas screenshot, and a zoom_id describes the screen as it was when taken.",
  "parameters": {
    "type": "object",
    "properties": {
      "x1": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1279
      },
      "y1": {
        "type": "integer",
        "minimum": 0,
        "maximum": 799
      },
      "x2": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1279
      },
      "y2": {
        "type": "integer",
        "minimum": 0,
        "maximum": 799
      }
    },
    "required": [
      "x1",
      "y1",
      "x2",
      "y2"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
async(e,n,t)=>{
  if(void 0===n.zoom)throw new Error("Zoom needs the Windows computer-use sidecar. Read the screenshot instead.");
  const{
    region:a,widenedFrom:s}
  =function(e,n){
    const t=Math.floor(e.x1),a=Math.floor(e.x2),s=Math.floor(e.y1),o=Math.floor(e.y2),r=a-t+1,i=o-s+1;
    if(r>=Nn.width&&i>=Nn.height)return{
      region:e}
    ;
    const[A,c]=wn({
      start:t,end:a,minimum:Nn.width,extent:n.width}
    ),[l,d]=wn({
      start:s,end:o,minimum:Nn.height,extent:n.height}
    );
    return{
      region:{
        x1:A,y1:l,x2:c,y2:d}
      ,widenedFrom:{
        width:r,height:i}
      }
    }
  (t,XA),o=await n.zoom(e,a),r=await async function(e,n){
    const t=[{
      type:"text",text:e.message.trim().length>0?e.message:n}
    ];
    if(void 0!==e.screenshot){
      const n=await sA(e.screenshot);
      t.push({
        type:"image",data:n.data,mimeType:n.mimeType}
      )}
    return{
      content:t}
    }
  (o,"Zoomed."),i=r.content[0];
  return void 0===s||o.isError||"text"!==i?.type||(i.text=`${i.text} The requested ${s.width}×${s.height} canvas px region was widened to the ${Nn.width}×${Nn.height} minimum around it, so the target has its surroundings in view.`),r}

```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Pc
```

</details>

### computer_apps

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_apps",
  "description": "List running macOS apps, frontmost first, with the pid and target_id an app target needs. Regular applications only: Spotlight, Notification Center, and menu extras are unsupported. No permission or screen control is required.",
  "parameters": {
    "type": "object",
    "properties": {}
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
(e,n)=>Ul(e,n,"computer_use_apps_list",void 0,{
  }
,"Listed apps.")
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Qc
```

</details>

### computer_resolve_app

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_resolve_app",
  "description": "Resolve one macOS app by exactly one selector, launching it without activating it if it is not running, and return the pid and target_id for its app target.",
  "parameters": {
    "type": "object",
    "properties": {
      "pid": {
        "type": "integer",
        "minimum": 1
      },
      "bundle_id": {
        "type": "string",
        "description": "Bundle identifier, e.g. \"com.apple.calculator\"."
      },
      "app_path": {
        "type": "string",
        "description": "Path to the .app bundle."
      },
      "app_name": {
        "type": "string",
        "description": "Localized app name, e.g. \"Calculator\"."
      }
    },
    "oneOf": [
      {
        "required": [
          "pid"
        ]
      },
      {
        "required": [
          "bundle_id"
        ]
      },
      {
        "required": [
          "app_path"
        ]
      },
      {
        "required": [
          "app_name"
        ]
      }
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
(e,n,t)=>Ul(e,n,"computer_use_select_app",void 0,t,"Resolved the app.")
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
sl
```

</details>

### computer_app_state

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_app_state",
  "description": "Read the app's accessibility tree as text (no image): one element per line, \"[id] ROLE name=… value=… settable actions=…\", indented by depth; settable means computer_set_value can replace the value. The last line is the snapshot_id that element actions must quote. Call this when you need the tree (first observe, or a screenshot that omitted snapshot_id). Skip it when a screenshot reused a live snapshot_id. Call again when an action reports the snapshot stale. A line ending in \"(+N descendants omitted)\" was cut to fit: pass that element_id with the current snapshot_id to expand it, and the new ids join the same snapshot.",
  "parameters": {
    "type": "object",
    "properties": {
      "target": {
        "type": "object",
        "properties": {
          "scope": {
            "type": "string",
            "const": "app"
          },
          "pid": {
            "type": "integer",
            "minimum": 1,
            "description": "pid from computer_apps or computer_resolve_app."
          },
          "target_id": {
            "type": "string",
            "minLength": 1,
            "description": "target_id from computer_apps or computer_resolve_app."
          }
        },
        "required": [
          "scope",
          "pid",
          "target_id"
        ],
        "description": "The app to act on."
      },
      "element_id": {
        "type": "integer",
        "minimum": 1,
        "description": "An element id in brackets from computer_app_state."
      },
      "snapshot_id": {
        "type": "string",
        "minLength": 1,
        "description": "The snapshot_id from computer_app_state, or from a screenshot that reused a live handle. It stays valid across actions until you read a new tree, the window or app changes, or an edit opens a sheet or replaces the tree. Do not call computer_app_state after a screenshot that reused snapshot_id; read computer_app_state when a screenshot omitted the tree or an action reports the snapshot stale."
      }
    },
    "required": [
      "target"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
(e,n,{
  target:t,...a}
)=>Ul(e,n,"computer_use_app_state",t,a,"Read the app state.")
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
ol
```

</details>

### computer_set_value

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_set_value",
  "description": "Replace the value of a settable element by id through accessibility, without keystrokes. Returns text only; the snapshot_id stays valid while the tree is unchanged, so fill the other elements from the same computer_screenshot or computer_app_state result. If the edit opens a sheet or replaces rows, the result says the snapshot is stale — take a screenshot or read computer_app_state before using element ids.",
  "parameters": {
    "type": "object",
    "properties": {
      "target": {
        "type": "object",
        "properties": {
          "scope": {
            "type": "string",
            "const": "app"
          },
          "pid": {
            "type": "integer",
            "minimum": 1,
            "description": "pid from computer_apps or computer_resolve_app."
          },
          "target_id": {
            "type": "string",
            "minLength": 1,
            "description": "target_id from computer_apps or computer_resolve_app."
          }
        },
        "required": [
          "scope",
          "pid",
          "target_id"
        ],
        "description": "The app to act on."
      },
      "element_id": {
        "type": "integer",
        "minimum": 1,
        "description": "An element id in brackets from computer_app_state."
      },
      "snapshot_id": {
        "type": "string",
        "minLength": 1,
        "description": "The snapshot_id from computer_app_state, or from a screenshot that reused a live handle. It stays valid across actions until you read a new tree, the window or app changes, or an edit opens a sheet or replaces the tree. Do not call computer_app_state after a screenshot that reused snapshot_id; read computer_app_state when a screenshot omitted the tree or an action reports the snapshot stale."
      },
      "value": {
        "type": "string",
        "description": "The new value."
      }
    },
    "required": [
      "target",
      "element_id",
      "snapshot_id",
      "value"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
(e,n,{
  target:t,...a}
)=>Ul(e,n,"computer_use_set_value",t,a,"Set the value.")
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
il
```

</details>

### computer_app_action

<details>
<summary>完整定义：macOS app scope 构造条件</summary>

```json
{
  "name": "computer_app_action",
  "description": "Perform an accessibility action on an element by id: \"press\" for buttons, links, menu items, checkboxes, and tabs (implied, so not listed), or an entry from the element's actions= list such as \"show-menu\" or \"scroll-to-visible\". Prefer this over coordinate clicks when the element is in the tree. Returns text only; the snapshot_id stays valid until the tree changes, so act on more elements from the same computer_screenshot or computer_app_state result.",
  "parameters": {
    "type": "object",
    "properties": {
      "target": {
        "type": "object",
        "properties": {
          "scope": {
            "type": "string",
            "const": "app"
          },
          "pid": {
            "type": "integer",
            "minimum": 1,
            "description": "pid from computer_apps or computer_resolve_app."
          },
          "target_id": {
            "type": "string",
            "minLength": 1,
            "description": "target_id from computer_apps or computer_resolve_app."
          }
        },
        "required": [
          "scope",
          "pid",
          "target_id"
        ],
        "description": "The app to act on."
      },
      "element_id": {
        "type": "integer",
        "minimum": 1,
        "description": "An element id in brackets from computer_app_state."
      },
      "snapshot_id": {
        "type": "string",
        "minLength": 1,
        "description": "The snapshot_id from computer_app_state, or from a screenshot that reused a live handle. It stays valid across actions until you read a new tree, the window or app changes, or an edit opens a sheet or replaces the tree. Do not call computer_app_state after a screenshot that reused snapshot_id; read computer_app_state when a screenshot omitted the tree or an action reports the snapshot stale."
      },
      "action": {
        "type": "string",
        "description": "\"press\", or an action name from the element's actions= list."
      }
    },
    "required": [
      "target",
      "element_id",
      "snapshot_id",
      "action"
    ]
  }
}
```

</details>

<details>
<summary>执行与输出代码（run）</summary>

```javascript
(e,n,{
  target:t,...a}
)=>Ul(e,n,"computer_use_perform_secondary_action",t,a,"Performed the action.")
```

</details>

<details>
<summary>额外输入校验入口</summary>

```javascript
Al
```

</details>

### Computer-use 共用的输出与注册代码

<details>
<summary>Nl 原始实现</summary>

```javascript
async function Nl(e,n){
  const t=[{
    type:"text",text:e.message.trim().length>0?e.message:n}
  ];
  if(void 0!==e.screenshot){
    const n=await async function(e){
      if(Gi&&void 0!==$i&&$i.png===e.data)return $i.webp;
      const n=await eA(e,"screenshot");
      if(n.width!==xi.width||n.height!==xi.height)throw new Error(`Computer-use screenshot must be ${xi.width}×${xi.height}, received ${n.width}×${n.height}`);
      const t=await aA(n.data,xi,"screenshot");
      return Gi&&($i={
        png:e.data,webp:t}
      ),t}
    (e.screenshot);
    t.push({
      type:"image",data:n.data,mimeType:n.mimeType}
    )}
  const a=function(e){
    if(!tc||void 0===e.inset)return;
    const n=e.structuredContent?.inset?.caption;
    if(void 0===n||0===n.trim().length)return;
    return{
      image:e.inset,caption:n}
    }
  (e);
  if(void 0!==a){
    const e=await sA(a.image);
    t.push({
      type:"text",text:a.caption}
    ,{
      type:"image",data:e.data,mimeType:e.mimeType}
    )}
  return{
    content:t}
  }

```

</details>

<details>
<summary>Ul 原始实现</summary>

```javascript
async function Ul(e,n,t,a,s,o){
  if(void 0===n.callCompanion)throw new Error("App targets need the macOS computer-use helper. Use the screen target.");
  return async function(e,n){
    const t=await Nl(e,n),a=e.structuredContent,s=[];
    for(const e of a?.system?.apps??[])s.push(`APP pid=${e.pid} target_id=${JSON.stringify(e.targetID)} active=${e.isActive}`+(void 0===e.localizedName?"":` app=${JSON.stringify(e.localizedName)}`)+(void 0===e.bundleIdentifier?"":` bundle=${JSON.stringify(e.bundleIdentifier)}`));
    return void 0!==a?.coordinateToken&&s.push(`coordinate_token=${a.coordinateToken}`),void 0!==a?.snapshotID&&s.push(`snapshot_id=${a.snapshotID}`),s.length>0&&t.content.push({
      type:"text",text:s.join("\n")}
    ),t}
  (await n.callCompanion(e,t,{
    ...a&&{
      pid:a.pid,target_id:a.target_id}
    ,...s}
  ),o)}

```

</details>

<details>
<summary>xl 原始实现</summary>

```javascript
function xl(e){
  const n=new Set(Object.keys(JSON.parse(e.descriptor.parameters).properties??{
    }
  ));
  return{
    descriptor:e.descriptor,advertised:n,validateAndRun:(t,a,s,o)=>{
      if(Pl){
        const t=function(e,n,t){
          const a=Object.keys(t).filter(e=>!n.has(e));
          if(0===a.length)return;
          const s=e=>e.map(e=>`"${e}"`).join(", ");
          return Ll("invalid_arguments",`Invalid arguments for ${e.name}: unknown argument${1===a.length?"":"s"} ${s(a)}; `+(0===n.size?`${e.name} takes no arguments.`:`the arguments of ${e.name} are ${s([...n])}.`))}
        (e.descriptor,n,s);
        if(void 0!==t)throw t}
      const r=e.schema.safeParse(s);
      if(!r.success)throw Ll("invalid_arguments",`Invalid arguments for ${e.descriptor.name}: ${Gl(r.error)}`);
      return e.run(t,a,r.data,o)}
    }
  }

```

</details>

<details>
<summary>Jl 原始实现</summary>

```javascript
function Jl({
  companionScope:e,batch:n,attempt:t}
){
  const a=function(e){
    const n=e?" With an app target the result is text only; observe again before the next action.":"",t=e?kl:{
      }
    ,a=e?_l:{
      }
    ,s=e?{
      ...vl,...Ql}
    :{
      }
    ;
    return[xl({
      descriptor:{
        name:"computer_screenshot",description:"Take a screenshot of the primary display"+(e?", or of one app's window with an app target.":".")+(dc?"":` ${kc} Take one before your first coordinate-based action and whenever the screen may have changed.`)+(e?" An app-target screenshot is the image. When a live snapshot is still fresh it reuses that snapshot_id and does not walk. If snapshot_id is present, do not call computer_app_state. Otherwise the image returns without a tree; call computer_app_state when you need element ids.":""),parameters:JSON.stringify({
          type:"object",properties:{
            ...t}
          }
        )}
      ,schema:ln({
        target:Mc}
      ),run:async(e,n,{
        target:t}
      )=>"app"===t?.scope?Ul(e,n,"computer_use_screenshot",t,{
        }
      ,"Captured a screenshot."):Nl(await n.screenshot(e),"Captured a screenshot.")}
    ),...ec?[Hl()]:[],xl({
      descriptor:{
        name:"computer_click",description:_c({
          lead:"Click at a screen coordinate.",detail:fc("Locate the target in a fresh screenshot first."),returns:"the click"}
        )+n,parameters:JSON.stringify({
          type:"object",properties:{
            ...t,...dl,button:{
              type:"string",enum:["left","right","middle"],description:"Mouse button. Defaults to left."}
            ,count:{
              type:"integer",minimum:1,maximum:3,description:"Click count; 2 double-clicks. Defaults to 1."}
            ,...a,...Cl}
          ,required:["x","y"]}
        )}
      ,schema:Yc,run:async(e,n,{
        target:t,zoom_id:a,...s}
      )=>"app"===t?.scope?Ul(e,n,"computer_use_click",t,s,"Clicked."):async function(e,n){
        const t=await Nl(e,"Clicked."),a=Ol(n,e),s=t.content[0];
        return void 0!==a&&"text"===s?.type&&(s.text=`${s.text} ${a}`),t}
      (await n.click(e,{
        coordinate:{
          x:s.x,y:s.y}
        ,button:s.button??"left",count:s.count??1,...Rl(a)}
      ),{
        y:s.y,zoom_id:a}
      )}
    ),xl({
      descriptor:{
        name:"computer_move",description:_c({
          lead:"Move the mouse cursor to a screen coordinate without clicking.",detail:"Useful for revealing hover UI.",returns:"the move"}
        )+n,parameters:JSON.stringify({
          type:"object",properties:{
            ...t,...dl,...a,...Cl}
          ,required:["x","y"]}
        )}
      ,schema:Jc,run:async(e,n,{
        target:t,zoom_id:a,...s}
      )=>{
        if("app"===t?.scope)return Ul(e,n,"computer_use_mouse_move",t,s,"Moved the cursor.");
        const o=Rl(a);
        return Nl(void 0===o?await n.move(e,{
          x:s.x,y:s.y}
        ):await n.move(e,{
          x:s.x,y:s.y}
        ,o),"Moved the cursor.")}
      }
    ),xl({
      descriptor:{
        name:"computer_drag",description:_c({
          lead:"Press the mouse button at one coordinate, drag to another, and release.",detail:rc?pl:fc("Locate both points in a fresh screenshot first."),returns:"the drag"}
        )+n,parameters:JSON.stringify({
          type:"object",properties:{
            ...t,from:gl("start"),to:gl("end"),...El,button:{
              type:"string",enum:["left","right","middle"],description:rc?"Defaults to left.":"Mouse button to hold. Defaults to left."}
            ,...a,...yl}
          ,...rc?{
            }
          :{
            required:["from","to"]}
          }
        )}
      ,schema:Hc,run:async(e,n,t)=>{
        const a=Wc(t);
        return"app"===t.target?.scope?Ul(e,n,"computer_use_drag",t.target,{
          ...jc(t),path:a}
        ,"Dragged."):Nl(await n.drag(e,{
          button:t.button??"left",path:a,...Rl(t.zoom_id)}
        ),"Dragged.")}
      }
    ),xl({
      descriptor:{
        name:"computer_type",description:e?"Type into a macOS app. Prefer computer_set_value or computer_type with element_id. Without element_id, inserts into the click-selected field via AX, or the focused field. A missed click target is refused. If nothing is focused, click a field first. Does not raise or move the real cursor. Screen-scope typing is refused. The result is text only.":dc?"Type text into the focused element using the keyboard. Click the target first so it has focus. A newline in the text presses Enter (it submits or navigates) and a tab presses Tab (next field or cell), so do not send a separate Return or Tab key press for them.":"Type text into the focused element using the keyboard. Click the target first so it has focus. Returns a screenshot taken after typing.",parameters:JSON.stringify({
          type:"object",properties:{
            ...t,text:{
              type:"string",minLength:1,maxLength:4e3,description:"Text to type."}
            ,...s,...a}
          ,required:["text"]}
        )}
      ,schema:Kc,run:async(e,n,{
        target:t,text:a,...s}
      ,o)=>(function(e,n){
        if(n.companionDefault&&zA&&"app"!==e.target?.scope)throw Ll("invalid_arguments",'Invalid arguments for computer_type: target: Screen-scope typing is refused. Pass {"scope":"app","pid":…,"target_id":…}. Prefer computer_set_value or computer_type with element_id when the field is marked settable. Without element_id, click a text field first if nothing text-like is focused.')}
      ({
        target:t}
      ,o),"app"===t?.scope?Ul(e,n,"computer_use_typing",t,{
        ...s,value:a}
      ,"Typed."):Nl(await n.typeText(e,a),"Typed."))}
    ),xl({
      descriptor:{
        name:"computer_key",description:(Ac?gc:'Press a key or shortcut, such as "Return", "Escape", "Tab", or a chord like "cmd+l" on macOS and "ctrl+l" on Windows. Combine modifiers with "+" (cmd, ctrl, alt, shift). Returns a screenshot taken after the key press.')+n,parameters:JSON.stringify({
          type:"object",properties:{
            ...t,key:{
              type:"string",maxLength:100,description:Ac?"Key or chord.":'Key or shortcut, e.g. "Return", "Tab", or "cmd+shift+s".'}
            }
          ,required:["key"]}
        )}
      ,schema:$c,run:async(e,n,{
        target:t,...a}
      )=>"app"===t?.scope?Ul(e,n,"computer_use_press_key",t,a,"Pressed the key."):Nl(await n.pressKey(e,a.key),"Pressed the key.")}
    ),xl({
      descriptor:{
        name:"computer_scroll",description:_c({
          lead:"Scroll at a screen coordinate.",returns:"scrolling"}
        )+n,parameters:JSON.stringify({
          type:"object",properties:{
            ...t,...dl,direction:{
              type:"string",enum:["up","down","left","right"],description:"Scroll direction. Defaults to down."}
            ,amount:{
              type:"integer",minimum:1,maximum:20,description:`Scroll amount in wheel ticks. Defaults to ${mc}.`}
            ,...a,...Cl}
          ,required:["x","y"]}
        )}
      ,schema:Xc,run:async(e,n,{
        target:t,zoom_id:a,...s}
      )=>"app"===t?.scope?Ul(e,n,"computer_use_scroll",t,{
        ...s,direction:s.direction??"down"}
      ,"Scrolled."):Nl(await n.scroll(e,{
        coordinate:{
          x:s.x,y:s.y}
        ,direction:s.direction??"down",amount:s.amount??mc,...Rl(a)}
      ),"Scrolled.")}
    ),xl({
      descriptor:{
        name:"computer_wait",description:e?"Wait for a page load or animation to settle. Returns text only; it does not capture the display. Observe afterward with computer_screenshot (app target) or computer_app_state.":uc?"Wait for the screen to settle (page load, animation). Returns a screenshot only if the screen changed; otherwise text that your last one still stands. Prefer over repeated screenshots.":"Wait for the screen to settle, such as during a page load or animation, then return a fresh screenshot. Prefer this over repeated screenshots in a tight loop.",parameters:JSON.stringify({
          type:"object",properties:{
            ms:{
              ...Ic,maximum:3e4,description:"Milliseconds to wait. Defaults to 1000."}
            }
          }
        )}
      ,schema:Zc,run:async(n,t,a,s)=>{
        const o=a.ms??1e3;
        if(await s.delay(o),e)return{
          content:[{
            type:"text",text:`Waited ${o}ms. Observe with computer_screenshot (app target) or computer_app_state.`}
          ]}
        ;
        await s.preflight(n);
        const r=uc&&void 0!==t.screenshotAfterWait?await t.screenshotAfterWait(n):await t.screenshot(n);
        return{
          content:[{
            type:"text",text:`Waited ${o}ms.`}
          ,...(await Nl(r,"Captured a screenshot.")).content]}
        }
      }
    ),...lc?[Vl()]:[],...cc?ql(e):[],...e?Wl():[]]}
  (e);
  return[...a,...n&&ac?[Yl(new Map(a.map(e=>[e.descriptor.name,e])))]:[],...t&&e?[xl({
    descriptor:{
      name:oc,description:`Carry out a list of small UI steps in a macOS app without reading the tree yourself. Prefer it when you know the next few UI steps; for a single action on an element you already know, call the element tool directly. Decompose the task first: each step is ONE control or ONE visible state change (press one button, open one sidebar item, type "text" into one field, confirm one field), with an expect naming what the screen shows once it is done. Never make a step that only focuses or clicks a field: typing into a field focuses it, so put the text in the typing step (type "x" into the search field). Each expect must name a control or value that appears in the tree ("a button named X appears", not "search results are visible" or "the field is focused"). Do not pass a multi-step task as one step (not "enter 1+2+3+4"; pass press 1 / press Add / press 2 ... as separate steps, each with its expected display); the decider inside is fast and accurate at picking one control and checking one outcome, and does not plan sequences. For each step a deterministic loop reads computer_app_state, asks the decider for the next action, acts, and checks the outcome, up to max_steps actions (default ${bA}); it stops the step as done when the screen shows its result and expect holds, or as failed when its target is absent, disabled, or blocked. Steps run in order and stop at the first that fails. Text to enter goes in quotes inside the step. Returns OK or ERR with one status line per step (done, failed, not run), then changed: (what the call changed on screen), now: (a compact view of the final screen: its controls and values, windows, sheets, and menus), a short trace, and the final snapshot_id. Plan your next steps from that view, and read values from now: before calling computer_app_state, which you need only for element ids or more detail. A failed step with 0 actions was not tried and changed nothing; one that acted may have landed, so check now: before redoing it. On ERR do only the failed step with the element tools, then send the remaining steps back to computer_attempt. Text only, no image.`,parameters:JSON.stringify({
        type:"object",properties:{
          ...fl,step:{
            type:"string",description:'A single small step: one control or one visible state change, in plain words, with any text to type in quotes (e.g. press the Add key; type "house music" into the search field). Pass this or steps.'}
          ,expect:{
            type:"string",description:"What the screen shows once this step is done, e.g. the display shows 1+. Give it on every step; the loop does not mark a step done until it holds."}
          ,steps:{
            type:"array",minItems:1,maxItems:24,description:"The decomposed task: one {step, expect} per control or state change, in order. Pass this or step.",items:{
              type:"object",properties:{
                step:{
                  type:"string",description:"One control or one visible state change."}
                ,expect:{
                  type:"string",description:"What the screen shows once this step is done."}
                }
              ,required:["step"]}
            }
          ,max_steps:{
            type:"integer",minimum:1,maximum:12,description:`Actions to try per step before giving up. Default ${bA}; a well-decomposed step needs one.`}
          }
        ,required:["target"]}
      )}
    ,schema:Kl,run:async(e,n,{
      target:t,...a}
    ,s)=>{
      const o=s.attempt;
      if(void 0===o||void 0===n.callCompanion)throw new Error("computer_attempt needs the macOS computer-use helper and a signed-in Cursor account.");
      const r=n.callCompanion.bind(n),{
        text:i,isError:A,summary:c}
      =await KA({
        decider:{
          decide:n=>o.decide(n,e.signal)}
        ,call:(n,a)=>r(e,n,{
          pid:t.pid,target_id:t.target_id,...a}
        ),args:{
          steps:a.steps??[{
            step:a.step??"",...void 0===a.expect?{
              }
            :{
              expect:a.expect}
            }
          ],max_steps:a.max_steps}
        }
      );
      return{
        content:[{
          type:"text",text:i}
        ],...A?{
          isError:A}
        :{
          }
        ,structuredContent:{
          code:"attempt",attempt:c}
        }
      }
    }
  )]:[]]}

```

</details>

<details>
<summary>$l 原始实现</summary>

```javascript
function $l(e){
  return Jl({
    companionScope:zA&&(e?.companionDefault??!0),batch:e?.batch??!1,attempt:e?.attempt??!1}
  ).map(e=>e.descriptor)}

```

</details>

## 5. Agent 调用协议：全部 70 个分支

以下仅表示协议可以携带这些调用，不等于已启用，也不等于每项都有本地执行实现。完整 args、result、success、error 及嵌套消息在 JSON 的 498 个可达消息中。协议引用 Google protobuf `Struct` 的两处保留为外部标准类型，没有伪造本地定义。

| 分支                                         | 调用消息                                | 参数类型                            | 结果类型                              |
| -------------------------------------------- | --------------------------------------- | ----------------------------------- | ------------------------------------- |
| `shell_tool_call`                            | `ShellToolCall`                         | `ShellArgs`                         | `ShellResult`                         |
| `delete_tool_call`                           | `DeleteToolCall`                        | `DeleteArgs`                        | `DeleteResult`                        |
| `glob_tool_call`                             | `GlobToolCall`                          | `GlobToolArgs`                      | `GlobToolResult`                      |
| `grep_tool_call`                             | `GrepToolCall`                          | `GrepArgs`                          | `GrepResult`                          |
| `read_tool_call`                             | `ReadToolCall`                          | `ReadToolArgs`                      | `ReadToolResult`                      |
| `update_todos_tool_call`                     | `UpdateTodosToolCall`                   | `UpdateTodosArgs`                   | `UpdateTodosResult`                   |
| `read_todos_tool_call`                       | `ReadTodosToolCall`                     | `ReadTodosArgs`                     | `ReadTodosResult`                     |
| `edit_tool_call`                             | `EditToolCall`                          | `EditArgs`                          | `EditResult`                          |
| `ls_tool_call`                               | `LsToolCall`                            | `LsArgs`                            | `LsResult`                            |
| `read_lints_tool_call`                       | `ReadLintsToolCall`                     | `ReadLintsToolArgs`                 | `ReadLintsToolResult`                 |
| `mcp_tool_call`                              | `McpToolCall`                           | `McpArgs`                           | `McpToolResult`                       |
| `sem_search_tool_call`                       | `SemSearchToolCall`                     | `SemSearchToolArgs`                 | `SemSearchToolResult`                 |
| `create_plan_tool_call`                      | `CreatePlanToolCall`                    | `CreatePlanArgs`                    | `CreatePlanResult`                    |
| `web_search_tool_call`                       | `WebSearchToolCall`                     | `WebSearchArgs`                     | `WebSearchResult`                     |
| `task_tool_call`                             | `TaskToolCall`                          | `TaskArgs`                          | `TaskResult`                          |
| `list_mcp_resources_tool_call`               | `ListMcpResourcesToolCall`              | `ListMcpResourcesExecArgs`          | `ListMcpResourcesExecResult`          |
| `read_mcp_resource_tool_call`                | `ReadMcpResourceToolCall`               | `ReadMcpResourceExecArgs`           | `ReadMcpResourceExecResult`           |
| `apply_agent_diff_tool_call`                 | `ApplyAgentDiffToolCall`                | `ApplyAgentDiffArgs`                | `ApplyAgentDiffResult`                |
| `ask_question_tool_call`                     | `AskQuestionToolCall`                   | `AskQuestionArgs`                   | `AskQuestionResult`                   |
| `fetch_tool_call`                            | `FetchToolCall`                         | `FetchArgs`                         | `FetchResult`                         |
| `switch_mode_tool_call`                      | `SwitchModeToolCall`                    | `SwitchModeArgs`                    | `SwitchModeResult`                    |
| `generate_image_tool_call`                   | `GenerateImageToolCall`                 | `GenerateImageArgs`                 | `GenerateImageResult`                 |
| `record_screen_tool_call`                    | `RecordScreenToolCall`                  | `RecordScreenArgs`                  | `RecordScreenResult`                  |
| `computer_use_tool_call`                     | `ComputerUseToolCall`                   | `ComputerUseArgs`                   | `ComputerUseResult`                   |
| `write_shell_stdin_tool_call`                | `WriteShellStdinToolCall`               | `WriteShellStdinArgs`               | `WriteShellStdinResult`               |
| `reflect_tool_call`                          | `ReflectToolCall`                       | `ReflectArgs`                       | `ReflectResult`                       |
| `setup_vm_environment_tool_call`             | `SetupVmEnvironmentToolCall`            | `SetupVmEnvironmentArgs`            | `SetupVmEnvironmentResult`            |
| `truncated_tool_call`                        | `TruncatedToolCall`                     | `TruncatedToolCallArgs`             | `TruncatedToolCallResult`             |
| `start_grind_execution_tool_call`            | `StartGrindExecutionToolCall`           | `StartGrindExecutionArgs`           | `StartGrindExecutionResult`           |
| `start_grind_planning_tool_call`             | `StartGrindPlanningToolCall`            | `StartGrindPlanningArgs`            | `StartGrindPlanningResult`            |
| `web_fetch_tool_call`                        | `WebFetchToolCall`                      | `WebFetchArgs`                      | `WebFetchResult`                      |
| `report_bugfix_results_tool_call`            | `ReportBugfixResultsToolCall`           | `ReportBugfixResultsArgs`           | `ReportBugfixResultsResult`           |
| `ai_attribution_tool_call`                   | `AiAttributionToolCall`                 | `AiAttributionArgs`                 | `AiAttributionResult`                 |
| `pr_management_tool_call`                    | `PrManagementToolCall`                  | `PrManagementArgs`                  | `PrManagementResult`                  |
| `mcp_auth_tool_call`                         | `McpAuthToolCall`                       | `McpAuthArgs`                       | `McpAuthResult`                       |
| `await_tool_call`                            | `AwaitToolCall`                         | `AwaitArgs`                         | `AwaitResult`                         |
| `blame_by_file_path_tool_call`               | `BlameByFilePathToolCall`               | `BlameByFilePathArgs`               | `BlameByFilePathResult`               |
| `get_mcp_tools_tool_call`                    | `GetMcpToolsToolCall`                   | `GetMcpToolsArgs`                   | `GetMcpToolsAgentResult`              |
| `report_bug_tool_call`                       | `ReportBugToolCall`                     | `ReportBugArgs`                     | `ReportBugResult`                     |
| `set_active_branch_tool_call`                | `SetActiveBranchToolCall`               | `SetActiveBranchArgs`               | `SetActiveBranchResult`               |
| `communicate_update_tool_call`               | `CommunicateUpdateToolCall`             | `CommunicateUpdateArgs`             | `CommunicateUpdateResult`             |
| `send_final_summary_tool_call`               | `SendFinalSummaryToolCall`              | `SendFinalSummaryArgs`              | `SendFinalSummaryResult`              |
| `update_pr_code_tour_tool_call`              | `UpdatePrCodeTourToolCall`              | `UpdatePrCodeTourArgs`              | `UpdatePrCodeTourResult`              |
| `replace_env_tool_call`                      | `ReplaceEnvToolCall`                    | `ReplaceEnvArgs`                    | `ReplaceEnvResult`                    |
| `edit_pr_labels_tool_call`                   | `EditPrLabelsToolCall`                  | `EditPrLabelsArgs`                  | `EditPrLabelsResult`                  |
| `record_ci_investigation_findings_tool_call` | `RecordCiInvestigationFindingsToolCall` | `RecordCiInvestigationFindingsArgs` | `RecordCiInvestigationFindingsResult` |
| `send_message_tool_call`                     | `SendMessageToolCall`                   | `SendMessageArgs`                   | `SendMessageResult`                   |
| `fetch_cloud_agent_data_tool_call`           | `FetchCloudAgentDataToolCall`           | `FetchCloudAgentDataArgs`           | `FetchCloudAgentDataResult`           |
| `send_to_user_tool_call`                     | `SendToUserToolCall`                    | `SendToUserArgs`                    | `SendToUserResult`                    |
| `pi_read_tool_call`                          | `PiReadToolCall`                        | `PiReadToolArgs`                    | `PiReadToolResult`                    |
| `pi_bash_tool_call`                          | `PiBashToolCall`                        | `PiBashToolArgs`                    | `PiBashToolResult`                    |
| `pi_edit_tool_call`                          | `PiEditToolCall`                        | `PiEditToolArgs`                    | `PiEditToolResult`                    |
| `pi_write_tool_call`                         | `PiWriteToolCall`                       | `PiWriteToolArgs`                   | `PiWriteToolResult`                   |
| `pi_grep_tool_call`                          | `PiGrepToolCall`                        | `PiGrepToolArgs`                    | `PiGrepToolResult`                    |
| `pi_find_tool_call`                          | `PiFindToolCall`                        | `PiFindToolArgs`                    | `PiFindToolResult`                    |
| `pi_ls_tool_call`                            | `PiLsToolCall`                          | `PiLsToolArgs`                      | `PiLsToolResult`                      |
| `connect_scm_tool_call`                      | `ConnectScmToolCall`                    | `ConnectScmArgs`                    | `ConnectScmResult`                    |
| `search_conversations_tool_call`             | `SearchConversationsToolCall`           | `ConversationSearchArgs`            | `ConversationSearchResult`            |
| `create_goal_tool_call`                      | `CreateGoalToolCall`                    | `CreateGoalArgs`                    | `CreateGoalResult`                    |
| `update_goal_tool_call`                      | `UpdateGoalToolCall`                    | `UpdateGoalArgs`                    | `UpdateGoalResult`                    |
| `adopt_tool_call`                            | `AdoptToolCall`                         | `AdoptArgs`                         | `AdoptResult`                         |
| `get_agent_status_tool_call`                 | `GetAgentStatusToolCall`                | `GetAgentStatusArgs`                | `GetAgentStatusResult`                |
| `send_to_agent_tool_call`                    | `SendToAgentToolCall`                   | `SendToAgentArgs`                   | `SendToAgentResult`                   |
| `read_agent_transcript_tool_call`            | `ReadAgentTranscriptToolCall`           | `ReadAgentTranscriptArgs`           | `ReadAgentTranscriptResult`           |
| `create_agent_tool_call`                     | `CreateAgentToolCall`                   | `CreateAgentArgs`                   | `CreateAgentResult`                   |
| `stop_agent_tool_call`                       | `StopAgentToolCall`                     | `StopAgentArgs`                     | `StopAgentResult`                     |
| `get_pr_code_tour_tool_call`                 | `GetPrCodeTourToolCall`                 | `GetPrCodeTourArgs`                 | `GetPrCodeTourResult`                 |
| `write_canvas_tool_call`                     | `WriteCanvasToolCall`                   | `WriteCanvasArgs`                   | `WriteCanvasResult`                   |
| `read_canvas_tool_call`                      | `ReadCanvasToolCall`                    | `ReadCanvasArgs`                    | `ReadCanvasResult`                    |
| `generate_video_tool_call`                   | `GenerateVideoToolCall`                 | `GenerateVideoArgs`                 | `GenerateVideoResult`                 |

## 6. 历史协议、通用适配器与验证

旧 `ClientSideToolV2` 枚举、`ClientSideToolV2Call` 的全部字段和 108 个可达消息已保留。通用适配器则从传入工具描述符生成名称、参数和执行定义；这些构造对象保存在 `genericBuilders[]`，不能仅凭对象中出现 name / parameters 就把它当成新的固定工具。`cursor-mcp` 的 Provider 注册与调用代码保存在 bundles 项中；外部 server 实际返回的 catalog 需要运行时读取。

本次扫描了安装包 extensions 下的 JavaScript，`descriptionGenerator` 或 `registerMcpProvider` 命中的六个 bundle 均纳入 AST 提取；生成协议另从 cursor-resolver 读取。核对了 158 个工厂点、53 个内部键、16 个浏览器描述符及匹配路由、19 个 computer-use 描述符，以及 Agent 的全部 70 个分支。文件哈希、原始切片、JSON 结构与 Markdown 链接另做校验。未进行真实工具调用、账号 gate 探测或模型请求抓包。
