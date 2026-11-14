# AI harness 与自动化接口

主进程 AiService 使用原生 fetch，支持 Chat Completions 和 Responses。所有文件工具复用 DocumentBackend，不依赖额外 Agent SDK。精确消息见 [API.md](../API.md)。

循环是：用户任务与技能 → 模型工具调用 → 本机实际执行 → 具体结果或错误回传 → 模型继续 → 回答及执行记录。任务可停止，文件修改可按版本撤回。

| 工具 | 实际行为 |
| --- | --- |
| `inspect_project` | 当前骨架、样式、脚本路径 |
| `list_files` | 逐层读取目录，包含图片资源 |
| `read_file` | 读取 UTF-8 内容与版本 |
| `write_file` | 原子保存；原文件须先读且版本匹配 |
| `update_outline` | 修改章节清单，不删除正文 |
| `validate_project` | 检查重复章节、文件存在/可读；不作事实正确性判断 |
| `run_project_command` | 用户启用后执行 `argv` 参数数组；省略时兼容已配置命令，可指定 `cwd`、`outputs` |
| `run_shell_command` | 用户启用后运行 PowerShell `command`，可指定 `cwd` |

普通工具不启动预览构建。AI、外部 Agent 与人工写入都由文件事件更新界面；编辑器未保存内容保持冲突保护。

命令权限默认关闭。开启后，模型可直接运行命令，无须用户先在项目配置中逐条填写。命令继承当前 Windows 用户权限，工作目录不提供文件系统隔离。两个命令工具共用后端任务队列，返回实际命令、工作目录、stdout/stderr、退出状态及错误详情；文件变化不会取消命令自身。停止任务或切换项目会结束命令和子进程。使用内置 `{python}`、`{pandoc}`、`{node}` 运行时可避免依赖用户系统开发环境。

正文、骨架和样式优先通过文件工具修改，以保留版本核对、修改比较及撤回。命令执行的任意文件改动不保证可撤回。AI命令不把输出自动提升为排版预览；预览由用户点击更新。

主窗口自动化示例：

```js
const result = await window.doconstruct.invoke('ai.send', {
  message: '读取引言，调整文献组织并验证骨架，保留实验数字。',
  skillId: 'paper-and-patent-writing',
  contextPaths: ['content/introduction.md']
});
const unsubscribe = window.doconstruct.onEvent(event => {
  if (event.type === 'ai' && event.job.id === result.jobId) {
    console.log(event.job.status, event.job.toolCalls);
  }
});
```

IPC 限应用可信主窗口，文档预览 iframe 无权限。打包测试显式使用 `DOConstruct.exe`，开发测试显式传应用目录，避免误开 Electron 欢迎页。API Key 不放入项目、工具结果或日志。

协议参考：[OpenAI official function calling](https://developers.openai.com/api/docs/guides/function-calling)、[DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)。Responses 的推理项及 DeepSeek 实际返回的 reasoning_content 在同一工具循环中续传，不显示为聊天正文。

本机 HTTP 测试验证实际工具执行，不替代特定线上模型及账号连接实测。

运行中 `ai.steer` 将追加指令留在当前job队列。每次请求模型前消费队列，正在执行的工具不强杀；下一工具执行前若已有新指令，未执行调用均返回skipped以补齐协议结果，再请求模型。旧最终回复遇到新指令也不能结束任务。Chat Completions和Responses共用这套边界处理，不在工具调用/结果之间插入用户消息。输入提交在异步读取context后再次检查任务状态与项目epoch，避免已结束任务吞掉指令。界面展示pending/已送入推理，状态随聊天保存；元数据不发送给API。取消不将旧队列移入新任务。

默认100轮模型工具推理，旧版较小限额加载后提升至100。停滞保护针对连续5次完全相同的操作参数及失败结果；成功、改变操作或消费新指令会清零。达到绝对轮数上限或取消仍保留已完成的版本化修改。

会话按工作区root散列归档：`ai-history/<sha256(root)>/index.json`保存当前会话、元信息及权限，每个UUID会话单独保存完整messages和最近12轮修改快照。旧`<sha256(root)>.json`先复制到新会话再发布索引，原文件不删。索引操作与任务接收共用工作区队列；任务准备完成时再次核对root/epoch/session和权限。历史及修改API均检查当前会话归属。新任务提供近期80条聊天上下文，界面/事件最多100条一页；完整聊天不被此显示或请求窗口截断。

文件/上下文/目录/骨架/校验统一经过`permissions.cjs`及执行端授权，模型可用工具列表同样过滤。限定目录可导航父目录，但返回项过滤到授权范围；校验不读取越界文件。命令不能与只读或局部文件范围混用，避免错误宣称shell受到文件工具隔离。工作区权限运行中不允许更改；新工作区命令默认关闭，旧全局授权只用于真实旧记录迁移。测试使用独立本机HTTP和临时文件，不读取真实API凭证。

基础交互参考[ChatGPT桌面命令与快捷操作](https://learn.chatgpt.com/docs/reference/commands)及[运行中跟进指令](https://learn.chatgpt.com/docs/prompting)；本软件的“编辑/重新尝试”保留既有文件修改，不模拟聊天分支回滚。
