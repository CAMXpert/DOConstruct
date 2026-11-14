# DOConstruct 0.2 IPC/API Contract

All calls via `window.doconstruct.invoke(method,args)` Promise and `window.doconstruct.onEvent(callback)` (returns unsubscribe). Main validates method/sender; backend errors become `{ok:false,error:{code,message,details?}}`, normal methods return `{ok:true,...result}`. Data are serializable plain objects. Paths in project DTO are relative slash-separated; absolute paths appear only root/artifact fields. Script text is content, never interpolated into shell commands.

## Backend ESM module `src/backend/index.mjs`

Export `DocumentBackend` class. Constructor `{pandocPath,pythonPath,onEvent,cacheRoot?}`. Main supplies portable runtime-resolved executable paths. Main catches exceptions and wraps error.

- `openProject(root:string)` -> project DTO; reads/inits project sidecar (not source documents); native dialog owned main.
- `createProject(root:string)` -> new starter project DTO.
- `getProject()` -> project DTO.
- `readFile(path:string)` -> `{path,content,version,language}`. version is opened content revision token.
- `saveFile({path,content,version})` -> `{path,version}`; atomic, external-modification mismatch reports conflict.
- `saveConfig({config,version})` -> project DTO; validates manifest and version.
- `build({runLayoutScript?:boolean})` -> `{jobId,revision}`; async/coalesced single-worker. Default true after explicit Build. Existing successful preview remains on failure.
- `getJob(id:string)` -> job DTO.
- `cancelJob(id:string)` -> `{canceled:boolean}`.
- `runCommand({argv?:string[],cwd?:string,outputs?:string[],publishPreview?:boolean})` -> `{jobId,revision}`; argv defaults to the configured command only when omitted. Process spawning uses shell:false; the PowerShell tool explicitly launches a shell executable. Relative cwd is inside the project; this does not sandbox the command's own filesystem access. `publishPreview:false` (AI calls) suppresses preview promotion. Job results include the actual argv/cwd, stdout/stderr and exit status. File changes do not cancel a running command; project switching and explicit cancellation do.

Project DTO `{root,title,config,version,files:[{path,name,kind,language}],dependencies?:[],latestPreview?:{jobId,revision,htmlPath},revision}`. `files` includes editable layout script/CSS and all selected content; generated cache is excluded. Config `{version:1,title,sections:[{id,title,path,enabled:true}],style:{fontFamily,fontSizePt,lineHeight,pageSize,marginTopMm,marginRightMm,marginBottomMm,marginLeftMm},layoutScript,stylesheet,command?:{argv,outputs?},pythonModules?:string[]}`. Backend chooses defaults. `saveConfig` preserves supported optional fields. Import existing `sections.json`+assets or single/root Markdown generically; never hardcode thesis names. Relative source paths validated inside opened root.

Job DTO `{id,revision,status:'queued'|'running'|'completed'|'failed'|'canceled'|'superseded',stage,logs:string[],diagnostics:string[],stats:{renderedSections,cachedSections,elapsedMs},htmlPath?,pdfPath?}`. `onEvent({type:'job',job})` pushes each meaningful stage/terminal transition. Latest only publishes when revision/project still current. Main handles PDF/export and augments final payload. Command failures preserve stdout/stderr and stage.

## Renderer methods (main IPC dispatch)

- `project.open {path?}` -> project DTO via backend (dialog if omitted, cancellation `{ok:true,canceled:true}`).
- `project.new {path?}` -> project DTO (dialog if omitted).
- `project.get {}` -> project DTO or `{ok:true,project:null}` before open.
- `file.read {path}` -> readFile result.
- `file.save {path,content,version}` -> saveFile result.
- `project.configure {config,version}` -> saveConfig result.
- `build.start {runLayoutScript?:boolean}` -> job/revision.
- `build.inspect {id}` -> job DTO.
- `build.cancel {id}` -> canceled result.
- `script.run {argv?,outputs?}` -> backend configured command (explicit Run Script button); default configured project.command.
- `pdf.export {jobId?,destination?}` -> asynchronous main export job; uses selected/current successful HTML, isolated hidden Electron Chromium window, waits images/fonts then printToPDF. Native Save dialog if destination omitted; `{ok:true,canceled:true}` on cancellation. Emits job events with type job, same DTO and final pdfPath.
- `pdf.preview {jobId?}` -> same asynchronous PDF job with `previewOnly:true`, saved to an application cache without a save dialog. The PDF tab is enabled once a workspace opens and explicitly starts this job if necessary. Completed PDFs are cached by immutable HTML artifact path; export copies the valid PDF to the chosen destination without another layout/print. Source or workspace changes preserve superseded isolation; cancellation remains canceled.
- `registerOutput(absolutePath)` (backend) registers a known generated file and newly created output directories for the current workspace. These events refresh the file tree but do not invalidate document sources; source paths cannot be registered. Registration resets at project switch/dispose.
- `preview.url {jobId?,htmlPath?}` -> `{url}` for sandboxed iframe. Main only allows successful owned artifact paths (not arbitrary file URLs). HTML5/MathML preview and PDF share layout output; global pagination is necessarily recomputed for PDF.
- `artifact.open {path}` -> reveal/open existing owned output in OS, not arbitrary shell command.
- `dependencies.inspect {}` -> `{items:[{name,available,source:'bundled'|'system'|'configured',path?,version?,message?}]}` including Electron/Chromium/Pandoc/Python and project pythonModules. Core binaries resolved from resources then config then system; no CAMX paths.
- `app.info {}` -> `{name,version,platform,packaged}`.

Frontend treats errors inline (no silent stale preview success). Requests render only after explicit Update Preview/Build (or a PDF export requiring a fresh result); ordinary save/input/file switching never starts a build; dirty buffers never silently overwritten. Outline reorder/toggle/config-font edits preserve other fields; save current file before changing file or give save/discard/cancel. CodeMirror6 actual locally bundled syntax modes for Markdown, Python, JS, CSS, JSON plus common shell/Lua via legacy modes; no textarea imitation or CDN.

## 0.2 additions

- `project.new {path?,options?:{title?,kind:'blank'|'paper'|'patent'|'starter',sections?:[{title,path?}]}}` supports skeleton-first creation; old no-options starter remains compatible.
- `section.create {title,path?,content?}` creates the source and appends a skeleton entry. `project.configure` edits titles/order/enabled/path; removing an entry never removes its file.
- `project.refresh {}` reloads current on-disk inputs without building.
- `file.list {path:''}` returns `{path,entries:[{name,path,type:'file'|'directory',extension?,size?}]}` for one directory. `directory.create {path}`, `entry.rename {path,newPath}`, `entry.remove {path}` manage project resources; rename updates owned skeleton/script/style references, remove uses internal trash.
- `file.media {path}` returns `{path,mime,url}` for a supported image within the current project. Render as an image, never decode image bytes as UTF-8.
- `{type:'files-changed',project,paths:[relative],external:true,sourceChanged?:boolean}` updates clean editor buffers, skeleton and expanded trees; dirty buffers retain content and report conflict. `sourceChanged:false` denotes known generated output changes and does not mark document preview stale. This event must never call `build.start`.
- `ai.settings {}` -> `{settings:{baseUrl,apiMode:'chat-completions'|'responses',model,hasApiKey,allowProjectCommands,maxToolRounds}}`.
- `ai.configure {baseUrl?,apiMode?,model?,apiKey?,clearApiKey?,allowProjectCommands?}` stores settings; no key returned. Key omitted/blank keeps existing credential; explicit clear deletes it.
- `ai.skills {}` -> `{skills:[{id,title,description}]}` for bundled skills.
- `ai.history {}` -> `{messages:[{role,content}],activeJob?}` for the current project.
- `ai.sessions {}` -> `{sessions:[{id,title}],activeSessionId}` for the current workspace. `ai.session.create {title?}` and `ai.session.select {id}` -> `{sessionId}`. Both reject while a job in that workspace is active. A session ID from another workspace is invalid. `ai.send` accepts optional `sessionId` and rejects selection changes during preparation.
- `ai.session.rename {id,title}` -> `{sessionId,title}`. Validates a nonempty trimmed title of at most80 characters, serializes index persistence through the workspace queue and disables automatic naming for this session. Pure metadata: allowed while its task runs, retaining the session/job ID, chat, draft, scroll and change records. Foreign workspace IDs and project switches are rejected.
- `ai.history {before?,limit?:1..100}` -> `{sessionId,messages,totalMessages,firstIndex,beforeCursor,hasMore,changeTasks,activeJob?}`. `before` is the exclusive absolute message index; default latest100. Job events add `sessionId/firstIndex/totalMessages` and carry only the last100 messages. Full history remains persisted; new provider conversations use only recent80 role/content messages. UI-only steering fields are stripped.
- `ai.permissions {}` -> `{projectRoot,permissions:{readFiles,writeFiles,allowCommands,allowedPaths:string[]}}`; `ai.permissions.configure` accepts any of those fields, preserves unspecified fields, validates and saves per workspace. Empty allowedPaths denies file access, `.` grants the workspace, nested relative directories/files restrict file tools. Absolute/traversal paths are rejected. Commands require read/write and full scope; they are current-user OS execution, not a sandbox. Existing `ai.configure {allowProjectCommands}` remains compatible for clients and updates the opened workspace grant; new workspaces do not inherit another workspace's local authorization.
- `clipboard.write {text}` copies up to8MiB text from the trusted app frame, used as fallback for message/code copy buttons. Preview iframes cannot call it.
- `ai.changes {id?,path?}` returns recent task/file summaries when path is omitted; with a task id and relative path returns `{id,path,kind,before:string|null,after:string,afterVersion}`. Full bodies are fetched only when reviewing that file. Task summaries include `undone` and persist with the last twelve change tasks across app restarts; `ai.history` adds `changeTasks`. File versions still guard undo against later user changes.
- `ai.send {message,skillId?,contextPaths?:[]}` -> `{jobId}`. Push `{type:'ai',job:{id,status,projectRoot,messages,toolCalls:[{name,status,summary,command?,output?}],error?}}` with real execution results. Command output shown in the workbench is explicitly bounded to the last 16000 characters; each stdout/stderr sent to the model is bounded to 64000 characters with truncation flags. Backend process output is limited to 64 MiB.
- `ai.steer {id?,message,contextPaths?:[]}` -> `{jobId,instructionId,queued:true}`. Queues a user instruction for the same running job. DTO adds `steering:[{id,message,status:'pending'|'applied'}]`; user messages carry `steeringId/steeringStatus`. Those display fields are never sent as provider message properties. The current tool may finish; remaining old tool calls return `skipped` without execution, then the next model request includes queued instructions in accepted order. A stale final answer cannot finish a job with pending steering. `applied` means included in the next model input, not a guarantee the provider will obey. Inactive, canceled, stale-id or switched-project requests are rejected; caller preserves input. Saved-file context uses the same project path checks.
- Tool reasoning defaults to 100 requests per task (legacy smaller settings migrate to 100). Five consecutive identical failed operations trigger `AI_STALLED`; a successful tool, changed failed operation or applied steer resets the streak. The absolute request limit remains `AI_TOOL_LIMIT` and reports the current limit. Cancellation, completed edits and undo remain available.
- `ai.cancel {id?}`, `ai.undo {}` -> `{restoredCount}`. Undo refuses to overwrite later external modifications.
- `external.open {url}` opens a validated HTTP(S) URL in the system browser following a user click. Workbench navigation is blocked; preview content cannot call this IPC.

The AI harness executes project inspection, directory listing, versioned text read/write, ordered skeleton updates, and real file/config validation. After the user enables command execution, `run_project_command {argv?,cwd?,outputs?}` runs the supplied argv (or the configured command when argv is absent), and `run_shell_command {command,cwd?}` runs a Windows PowerShell script. With permission disabled neither tool is advertised and both are rejected even if requested. Commands use current OS-user privileges; cwd is not a sandbox. Prefer file tools for document edits because only those edits have tracked diff/undo snapshots. AI command results do not replace the document preview. Main owns API credentials and HTTP; renderer owns display and never uses a provider key for network requests.
