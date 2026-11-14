# DOConstruct

DOConstruct 是一个本地文档编辑与排版桌面工作台：把 Markdown 正文、有序章节骨架、排版脚本和 CSS 分开维护，在同一个窗口中编辑、构建、预览并导出 PDF。它适用于论文、专利、报告和其他分章节文档，也可以作为可修改的文档构建工具使用。

DOConstruct is a local desktop workbench for Markdown documents, editable layouts, incremental HTML previews, PDF output, and optional AI-assisted editing.

**当前开源版本：0.2.5。** 本仓库公开并冻结现有版本，供使用、学习和自行修改，不承诺后续功能开发、例行升级或兼容性维护。后续商业开发将放在独立的 **DOConstruct Pro** 仓库中；Pro 的功能范围和发布日期尚未承诺。本仓库的 MIT 许可继续适用于已公开的代码。

## 现有功能

- **章节骨架与真实文件**：新建空白、论文、专利或示例项目；添加、排序、启用或停用章节。正文保存在 Markdown 文件中，删除骨架引用不会删除正文文件。
- **编辑与资源管理**：使用 CodeMirror 编辑 Markdown、Python、JavaScript、PowerShell、Lua、CSS 和 JSON 等文本，支持语法高亮、行号、查找替换及撤销；文件树可管理图片和其他项目资源。
- **显式更新的增量预览**：点击“更新预览”或按 F5 才执行文档构建。普通章节修改复用未变章节的 Pandoc 转换结果；字体、CSS 和普通骨架重排也可复用正文缓存。跨章节脚注、引用等全局语义会切换为全稿解析。
- **可编辑排版与 PDF**：通过界面调整字体、字号、行距、纸张和页边距，也可修改 Python 排版脚本及 CSS。Pandoc 生成 HTML5/MathML，Electron 内置 Chromium 从同一 HTML/CSS 生成 PDF，支持软件内查看和另存成品。
- **文件冲突与构建反馈**：未保存内容有提示，保存前核对外部修改；构建显示实际阶段、日志和缓存统计，失败时保留上次成功预览并显示错误。后台任务可取消。
- **可选 AI 助手**：连接用户自己的 Chat Completions 或 Responses 兼容 API，使用项目文件读写、骨架调整及校验工具；支持每工作区多会话、会话改名、运行中追加指令、修改比较和受版本保护的撤回。

PDF 分页仍由 Chromium 完整计算；“增量”指 Markdown 转换和中间结果复用。当前内置成品输出是 PDF。其他出版流程可通过用户配置的外部脚本接入，所需工具由该脚本另行提供。

## 使用方式

当前发行目标为 **Windows x64**，安装器最低系统版本设为 Windows 10 build 19041。完整打包产物包含 Electron/Chromium、编辑器、Pandoc 和嵌入式 Python；使用默认项目不需要另装 Node.js、Python、Pandoc 或 Word。安装程序及免安装目录的生成方式见下文。

1. 选择“新建”创建文档项目，或“打开文件夹”载入已有项目。
2. 调整左侧章节骨架，在编辑器中修改正文，按需添加图片、排版脚本和样式。
3. 点击“更新预览”（F5），查看 HTML 预览与构建日志。输入、保存和切换文件不会自动运行排版脚本。
4. 点击“PDF 成品”在软件内生成或查看 PDF，使用“导出 PDF”保存到所选位置。已有有效成品会被复用，源稿变化时按需重新构建。

AI 功能需自行填写 API 端点、模型和凭证，选中的上下文与工具读取内容会发送给该端点。普通编辑、预览和 PDF 构建不需要 AI 账户。文件读写范围及命令权限按工作区设置；AI 命令执行默认关闭。启用命令后，进程具有当前系统用户的权限，项目工作目录并非文件系统沙箱。文件工具支持修改比较和撤回，任意命令产生的改动不保证可撤回。

详细操作见 [用户指南](docs/USER_GUIDE.md)，AI 配置与权限见 [AI Harness](docs/AI_HARNESS.md)。

## 文档项目结构

默认示例项目使用以下结构；章节文件和脚本路径由配置指定，可以调整：

```text
doconstruct.json         # 标题、有序章节、字体版式、脚本与可选命令
sections/*.md            # Markdown 正文
layout.py                # 接收 JSON 输入，向标准输出写完整 HTML
layout.css               # 文档样式和打印规则
.doconstruct/            # 生成产物、缓存和项目内部回收区
```

可以打开普通 Markdown 文件夹，也支持导入 `sections.json` 与 `assets/<directory>/body[]` 的既有布局。导入会建立项目配置，正文保留为原文件。示例见 [examples](examples/README.md)，默认可编辑模板位于 [templates/default](templates/default)。

默认排版脚本仅使用 Python 标准库。额外 Python 模块可在项目的 `pythonModules` 中声明，通过“依赖”面板检查；应用不会自动安装它们。`DOCONSTRUCT_PYTHON` 和 `DOCONSTRUCT_PANDOC` 可指定自备的可执行文件，依赖面板会显示实际来源。

## 从源码运行

在 Windows x64 上准备：

- Node.js **22.12.0 或更新版本**及 npm；建议使用当前 LTS 版本。
- Python **3.11 或更新版本**，用于校验和准备随包运行时。
- 首次安装 npm 依赖或下载运行时时需要网络；所需文档字体须在系统中可用。

在仓库根目录执行：

```powershell
npm ci
python scripts/bootstrap-runtime.py
python scripts/bootstrap-runtime.py --check
npm run build:ui
npm start
```

`bootstrap-runtime.py` 根据 [运行时清单](resources/vendor/MANIFEST.json) 准备固定版本的 Windows x64 Pandoc 和嵌入式 Python，校验官方压缩包及解压文件的 SHA-256。已有文件完整时直接复用；`--check` 只做本地校验与运行探测。源码仓库不包含这些运行时二进制，准备脚本会下载缺失内容。

`npm run build:ui` 使用 esbuild 将界面代码打包到 `static/app.js`；修改界面源码后需重新执行。`npm start` 启动 Electron，不会自动重新打包界面。

## 测试

安装依赖并准备运行时后执行：

```powershell
npm test
```

该脚本实际执行 `node --test tests/*.test.*`，覆盖项目读写、增量构建、命令执行、文件监听、AI 工具/权限/会话和修改比较等。只检查文档后端时可运行：

```powershell
node --test tests/backend.test.mjs
```

部分后端用例依赖已准备的 Pandoc/Python；缺少依赖时可能跳过相关用例。AI 测试使用本地协议服务，不需要真实 API 凭证。自动化测试不代替桌面界面操作与实际 PDF 的视觉检查。

## Windows 打包

完成运行时准备和 `npm run build:ui` 后，当前 Inno Setup 安装包流程为：

```powershell
npx electron-builder --config electron-builder.yml --win --dir --x64
powershell -NoProfile -File scripts/prepare-inno.ps1
.\.tools\innosetup\ISCC.exe scripts\installer.iss
```

第一步生成 `dist/win-unpacked/`，免安装使用时须复制完整目录。第二步下载并校验项目内的便携 Inno Setup 编译器，不全局安装。第三步按当前 `scripts/installer.iss` 生成 `dist/DOConstruct-Setup-0.2.5-x64.exe`，不会自动安装应用。

`package.json` 还保留了 electron-builder 的 NSIS/portable 打包入口：

```powershell
npm run dist
```

它会先打包界面，再生成 NSIS 安装程序和 portable 可执行文件；与上述 Inno Setup 流程二选一，输出均在 `dist/`。两种安装器可能使用相同的安装包文件名，应分开保存各次构建产物。配置见 [electron-builder.yml](electron-builder.yml) 和 [scripts/installer.iss](scripts/installer.iss)。

## 代码与文档导航

| 入口 | 内容 |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 进程职责、构建队列、缓存和文件生命周期 |
| [API.md](API.md) | 前后端 IPC、项目配置及任务契约 |
| [src/backend](src/backend/README.md) | 项目读写、Markdown 转换与构建执行 |
| `src/main.cjs` / `src/preload.cjs` | 桌面窗口、IPC 和 PDF 输出 |
| `src/renderer/` / `static/` | 编辑器、工作台及界面资源 |
| `src/ai/` | AI 工具循环、会话与权限 |
| `tests/` / `scripts/` | 自动化测试、运行时准备和安装包构建 |

## 许可

本项目代码采用 [MIT License](LICENSE)。Electron/Chromium、CodeMirror、Pandoc、CPython 及其他第三方组件保留各自许可；MIT 不替代这些组件的许可条件。随包组件来源、版本和再分发说明见 [THIRD_PARTY.md](resources/THIRD_PARTY.md) 及 [resources/licenses](resources/licenses)。
