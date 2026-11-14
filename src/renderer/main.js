import { basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { powerShell } from '@codemirror/legacy-modes/mode/powershell';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { setupWorkbench } from './workbench.js';
import { fileIcon } from './file-icons.js';

const $ = id => document.getElementById(id);
const bridge = window.doconstruct;
const state = { project:null, file:null, baseline:null, dirty:false, configDirty:false,
  activeJob:null, htmlJob:null, pdfPath:null, pdfHtmlPath:null, pdfStarting:false, htmlUrl:null, pdfUrl:null, previewMode:'html',
  jobs:new Map(), waiters:new Map(), activeSection:null, transition:false, loadSequence:0, session:0, previewStale:false,
  tree:new Map(), expanded:new Set(['']), selectedEntry:null, treeLoading:false, externalProject:null, aiJob:null };
let reportedDirty=false;
const terminal = new Set(['completed','failed','canceled','superseded']);
const labels = { queued:'已排隊',running:'正在執行',completed:'完成',failed:'失敗',canceled:'已取消',superseded:'已由較新修訂取代' };

let noticeTimer;
function notice(message, success=false) {
  clearTimeout(noticeTimer);
  $('notice-text').textContent = message;
  $('notice').classList.toggle('success',success);
  $('notice').hidden = !message;
  if(message&&success)noticeTimer=setTimeout(()=>{$('notice').hidden=true;},3000);
}
function describe(error) { return error?.message || String(error); }
async function api(method, args={}) {
  if (!bridge) throw new Error('請使用 DOConstruct 桌面程式啟動工作台。');
  const result=await bridge.invoke(method,args);
  if (result?.ok===false) {
    const e=new Error(result.error?.message || result.message || '操作未完成');
    e.code=result.error?.code; e.details=result.error?.details;
    throw e;
  }
  return result;
}
function run(action) { return Promise.resolve().then(action).catch(error=>notice(describe(error))); }
function node(tag, cls, text) { const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e; }
function actionButton(label, title, action, cls='') { const b=node('button',cls,label);b.type='button';b.title=title;b.addEventListener('click',e=>{e.stopPropagation();run(action);});return b; }
function working() { return state.activeJob && !terminal.has(state.activeJob.status); }
function refreshControls() {
  const open=!!state.project, busy=working() || state.transition || state.pdfStarting;
  for (const id of ['save','build','export-pdf','toggle-style','toggle-layout','command-settings','add-section','open-layout','new-file','new-folder','rename-entry','remove-entry','refresh-files']) $(id).disabled=!open || state.transition || (['build','export-pdf'].includes(id)&&busy);
  $('open-project').disabled=state.transition;$('new-project').disabled=state.transition;
  $('cancel-job').hidden=!working();
  $('dirty-dot').hidden=!state.dirty;
  $('outline-dirty').hidden=!state.configDirty;
  $('open-artifact').disabled=!(state.previewMode==='pdf'?state.pdfPath:state.htmlJob?.htmlPath);
  $('pdf-tab').disabled=!open||!!busy;
  document.title=`${state.dirty||state.configDirty?'● ':''}${state.project?.title?state.project.title+' — ':''}DOConstruct`;
  const dirty=state.dirty||state.configDirty;
  if(bridge&&dirty!==reportedDirty){reportedDirty=dirty;bridge.invoke('app.dirty',{dirty}).catch(()=>{});}
}
function language(path='') {
  const ext=path.split('.').pop().toLowerCase();
  if (['md','markdown','mdown'].includes(ext)) return ['Markdown',markdown()];
  if (['py','pyw'].includes(ext)) return ['Python',python()];
  if (['js','cjs','mjs','jsx','ts','tsx'].includes(ext)) return [ext.toUpperCase(),javascript({typescript:['ts','tsx'].includes(ext),jsx:['jsx','tsx'].includes(ext)})];
  if (ext==='css')return ['CSS',css()];if(ext==='json')return ['JSON',json()];
  if (['html','htm','xml'].includes(ext))return [ext.toUpperCase(),html()];
  if (['sh','bash','zsh'].includes(ext))return ['Shell',StreamLanguage.define(shell)];
  if (ext==='ps1')return ['PowerShell',StreamLanguage.define(powerShell)];
  if (ext==='lua')return ['Lua',StreamLanguage.define(lua)];
  return ['Text',[]];
}
const codeTheme=EditorView.theme({
  '&':{fontSize:'13px',color:'#dddddd',backgroundColor:'#1e1e1e'},
  '.cm-scroller':{overflow:'auto'}, '.cm-content':{padding:'12px 0',caretColor:'#eeeeee'},
  '.cm-line':{padding:'0 14px'}, '.cm-gutters':{backgroundColor:'#1e1e1e',borderRight:'1px solid #333333',color:'#858585'},
  '.cm-activeLineGutter, .cm-activeLine':{backgroundColor:'#292929'},
  '.cm-cursor, .cm-dropCursor':{borderLeftColor:'#eeeeee'},
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':{backgroundColor:'#484848'},
  '.cm-selectionMatch, .cm-matchingBracket':{backgroundColor:'#404040'},
  '.cm-searchMatch':{backgroundColor:'#5a5a5a',outline:'1px solid #888888'},
  '.cm-searchMatch.cm-searchMatch-selected':{backgroundColor:'#707070'},
  '.cm-panels, .cm-tooltip':{backgroundColor:'#252525',color:'#dddddd',border:'1px solid #444444'},
  '.cm-tooltip-autocomplete ul li[aria-selected]':{backgroundColor:'#444444',color:'#ffffff'},
  '.cm-foldPlaceholder':{backgroundColor:'transparent',border:'none',color:'#aaaaaa'}
},{dark:true});
// Reuse mature language tags while keeping the workbench neutral and strings blue.
const tokenColors={'#98c379':'#8bbcf0','#56b6c2':'#a1c6f3','#abb2bf':'#dddddd','#7d8799':'#929292'};
const codeHighlight=syntaxHighlighting(HighlightStyle.define(oneDarkHighlightStyle.specs.map(spec=>({...spec,color:tokenColors[spec.color]||spec.color}))));
const wrapMode=new Compartment();
let wrapEnabled=localStorage.getItem('doconstruct.wrap')!=='false';
const editor=new EditorView({ parent:$('editor'),state:makeEditorState('',null) });
function makeEditorState(text,path) {
  const [name,mode]=language(path||'');
  return EditorState.create({doc:text,extensions:[basicSetup,codeHighlight,codeTheme,mode,wrapMode.of(wrapEnabled?EditorView.lineWrapping:[]),
    EditorState.readOnly.of(!path),EditorView.editable.of(!!path),
    keymap.of([{key:'Mod-s',run:()=>{run(()=>saveAll());return true;}},indentWithTab]),
    EditorView.updateListener.of(update=>{
      if(update.docChanged) {state.dirty=!!state.file && !!state.baseline && !update.state.doc.eq(state.baseline);if(state.dirty&&state.htmlUrl){state.previewStale=true;$('preview-state').textContent='內容已修改 · 顯示上次成功結果';}refreshControls();}
      if(update.docChanged||update.selectionSet){const pos=update.state.selection.main.head,line=update.state.doc.lineAt(pos);$('cursor').textContent=`行 ${line.number}，列 ${pos-line.from+1}`;$('document-size').textContent=`${update.state.doc.length.toLocaleString()} 字`;}
    })]});
}
function setEditor(file) {
  $('editor').hidden=false;document.querySelector('.media-view')?.remove();$('external-conflict').hidden=true;
  state.file=file;state.dirty=false;
  editor.setState(makeEditorState(file?.content||'',file?.binary?null:file?.path));
  state.baseline=editor.state.doc;
  $('active-file').textContent=file?.path||'尚未開啟文件';$('active-file').title=file?.path||'';
  $('language-label').textContent=language(file?.path)[0].toUpperCase();
  $('document-size').textContent=`${editor.state.doc.length.toLocaleString()} 字`;
  refreshControls();renderFiles();renderOutline();
}
function decide(text,title='保存修改？',buttons={save:'保存',discard:'不保存',cancel:'取消'}) {
  const d=$('decision-dialog');$('decision-title').textContent=title;$('decision-text').textContent=text;
  for(const [value,label]of Object.entries(buttons))d.querySelector(`[value="${value}"]`).textContent=label;
  d.returnValue='cancel';
  return new Promise(resolve=>{d.addEventListener('close',()=>resolve(d.returnValue),{once:true});d.showModal();});
}
async function guardDirty(includeConfig=true) {
  if(!state.dirty&&(!includeConfig||!state.configDirty))return true;
  const answer=await decide('目前的文件或骨架有尚未保存的修改。離開前要保存嗎？');
  if(answer==='cancel')return false;
  if(answer==='save')await saveAll();
  if(answer==='discard'){
    const file=state.file;
    if(includeConfig){const fresh=await api('project.get');if(fresh.root)state.project=fresh;state.configDirty=false;}
    if(state.dirty&&file)setEditor({...file,content:file.content});
    state.dirty=false;renderOutline();refreshControls();
  }
  return true;
}
async function openFile(path) {
  if(state.file?.path===path){editor.focus();return;}
  if(!await guardDirty(false))return;
  const sequence=++state.loadSequence;
  if(/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(path))return openMedia(path,sequence);
  if(!/\.(md|markdown|mdown|txt|json|css|py|pyw|js|cjs|mjs|jsx|ts|tsx|html?|xml|sh|bash|zsh|ps1|lua|bib|csl|ya?ml|toml|csv|tsv|tex|log|ini|cfg|r|sql)$/i.test(path))return openBinaryInfo(path);
  let file;
  try {file=await api('file.read',{path});}
  catch(error) {
    if(!['ENOENT','NOT_FOUND','FILE_NOT_FOUND'].includes(error.code))throw error;
    const answer=await decide(`「${path}」尚不存在。要建立這個內容文件嗎？`,'建立文件？',{save:'建立',discard:'不建立',cancel:'取消'});
    if(answer!=='save')return;
    await api('file.save',{path,content:'# 新章節\n\n',version:null});file=await api('file.read',{path});
    const refreshed=await api('project.get');if(refreshed.root)state.project={...refreshed,config:state.project.config};
  }
  if(sequence!==state.loadSequence)return;
  setEditor(file);editor.focus();
}
function clearPreview() {
  state.htmlJob=null;state.pdfPath=null;state.pdfHtmlPath=null;state.pdfStarting=false;state.htmlUrl=null;state.pdfUrl=null;state.previewMode='html';state.previewStale=false;
  $('preview').hidden=true;$('preview').removeAttribute('src');$('preview-placeholder').hidden=false;$('preview-state').textContent='尚無預覽';setPreviewMode('html');
}
async function loadProject(project) {
  const incoming=project.project||project;
  if(state.project&&state.project.root===incoming.root&&state.project.revision===incoming.revision&&state.project.version===incoming.version)return;
  state.project=incoming;state.configDirty=false;state.activeSection=null;state.activeJob=null;state.loadSequence++;state.session++;
  state.tree.clear();state.expanded=new Set(['']);state.selectedEntry=null;state.externalProject=null;state.aiJob=null;
  for(const waiter of state.waiters.values())waiter.reject(new Error('文檔已切換。'));
  state.jobs.clear();state.waiters.clear();setEditor(null);clearPreview();
  $('project-title').textContent=state.project.title||'未命名文檔';$('project-location').textContent=state.project.root||'';
  $('project-location').title=state.project.root||'';renderOutline();renderFiles();fillStyleForm();refreshControls();notice('');
  const first=state.project.config?.sections?.find(s=>s.enabled!==false)?.path||state.project.files?.[0]?.path;
  if(first)await openFile(first);
  if(state.project.latestPreview?.htmlPath){state.htmlJob=state.project.latestPreview;await showArtifact('html',state.htmlJob);}
  if(!$('ai-panel').hidden)await loadAiHistory();
}
async function changeProject(method,args={}) {
  if(!await guardDirty())return;
  state.transition=true;refreshControls();
  try {const result=await api(method,args);if(!result.canceled)await loadProject(result);}
  finally {state.transition=false;refreshControls();}
}
function saveAll() {
  if(state.savePromise)return state.savePromise;
  const task=persistAll().finally(()=>{if(state.savePromise===task)state.savePromise=null;});
  state.savePromise=task;return task;
}
async function persistAll() {
  if(!state.project)return;
  const session=state.session,savedPath=state.file?.path;
  if(state.file&&state.dirty) {
    const file=state.file,savedDocument=editor.state.doc,content=savedDocument.toString();
    const result=await api('file.save',{path:file.path,content,version:file.version});
    if(session!==state.session)return;
    if(state.file===file){file.version=result.version;file.content=content;state.baseline=savedDocument;state.dirty=!editor.state.doc.eq(savedDocument);}
  }
  if(state.configDirty) {
    const savedConfig=structuredClone(state.project.config);
    const result=await api('project.configure',{config:savedConfig,version:state.project.version});
    if(session!==state.session)return;
    const changed=JSON.stringify(state.project.config)!==JSON.stringify(savedConfig),pendingConfig=state.project.config;
    state.project=result.project||result;if(changed)state.project.config=pendingConfig;state.configDirty=changed;
  } else {
    const project=await api('project.get');if(session!==state.session)return;
    if(project.root){const pendingConfig=state.project.config;state.project=project;if(state.configDirty)state.project.config=pendingConfig;}
  }
  $('project-title').textContent=state.project.title||state.project.config.title;renderFiles();renderOutline();refreshControls();notice('已保存。',true);
  if(/\.(?:py|pyw|js|cjs|mjs|ps1|sh|lua)$/i.test(savedPath||''))notice('腳本已保存。點擊「更新預覽」或「運行命令」執行。',true);
}
function mutateConfig(change) {
  change(state.project.config);state.configDirty=true;if(state.htmlUrl){state.previewStale=true;$('preview-state').textContent='骨架或樣式已修改 · 顯示上次成功結果';}renderOutline();refreshControls();
}
function renderOutline() {
  const list=$('outline-list');list.replaceChildren();list.classList.toggle('empty-tree',!state.project);
  if(!state.project){list.textContent='開啟文檔文件夾，開始組織內容。';return;}
  const sections=state.project.config.sections||[];
  if(!sections.length){const empty=node('div','empty-outline','骨架可以從空白開始。先新增章節，再逐步填入內容。');empty.append(actionButton('＋ 新增第一章','建立章節與內容文件',()=>editSection()));list.append(empty);}
  sections.forEach((section,index)=>{
    const row=node('div','outline-row'+(state.file?.path===section.path?' active':''));
    const enabled=node('input');enabled.type='checkbox';enabled.checked=section.enabled!==false;enabled.title='納入文檔';enabled.addEventListener('change',()=>mutateConfig(c=>{c.sections[index].enabled=enabled.checked;}));row.append(enabled);
    const body=node('div','outline-body');body.append(actionButton(section.title||section.path,'編輯內容',()=>openFile(section.path),'file-button'),node('small','file-path',section.path));row.append(body);
    const actions=node('div','outline-actions');
    const move=delta=>mutateConfig(c=>{const dest=index+delta;if(dest>=0&&dest<c.sections.length)[c.sections[index],c.sections[dest]]=[c.sections[dest],c.sections[index]];});
    actions.append(actionButton('↑','上移章節',()=>move(-1)),actionButton('↓','下移章節',()=>move(1)),actionButton('✎','編輯骨架',()=>editSection(index)),actionButton('−','從骨架移除，不刪正文文件',async()=>{
      const answer=await decide(`從骨架移除「${section.title||section.path}」？原始文件會保留。`,'移除章節？',{save:'移除',discard:'保留',cancel:'取消'});
      if(answer==='save')mutateConfig(c=>{c.sections.splice(index,1);});
    }));row.append(actions);list.append(row);
  });
}
function renderFiles() {
  const list=$('file-list');list.replaceChildren();if(!state.project)return;
  if(!state.tree.has('')){if(!state.treeLoading)run(refreshFileTree);return;}
  function branch(parent,folder){for(const f of state.tree.get(folder)||[]){
    const row=node('div','file-row'+(state.selectedEntry?.path===f.path?' selected':''));row.dataset.path=f.path;
    const directory=f.type==='directory';
    const open=async()=>{state.selectedEntry=f;if(directory){if(state.expanded.has(f.path))state.expanded.delete(f.path);else{state.expanded.add(f.path);await loadDirectory(f.path);}}else await openFile(f.path);renderFiles();};
    row.append(actionButton(directory?(state.expanded.has(f.path)?'▾':'▸'):'',directory?'展開 / 收起':'文件',open,'file-arrow'),fileIcon(f),actionButton(f.name,f.path,open,'file-name'));
    row.addEventListener('contextmenu',event=>{event.preventDefault();state.selectedEntry=f;renderFiles();openEntryDialog('rename');});parent.append(row);
    if(directory&&state.expanded.has(f.path)){const children=node('div','file-children');parent.append(children);branch(children,f.path);}
  }}branch(list,'');
}
function editSection(index=null) {
  state.activeSection=index;const form=$('section-form'),s=index===null?{}:state.project.config.sections[index];
  form.elements.title.value=s.title||'';form.elements.path.value=s.path||`content/chapter-${String((state.project.config.sections?.length||0)+1).padStart(2,'0')}.md`;
  $('section-dialog-title').textContent=index===null?'添加章節':'編輯章節';$('section-dialog').showModal();
}
$('section-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
  const form=event.target,title=form.elements.title.value.trim(),path=form.elements.path.value.trim().replaceAll('\\','/');
  if(!title||!path)throw new Error('請填寫章節標題與文件路徑。');
  if(path.startsWith('/')||/^[a-z]:/i.test(path)||path.split('/').includes('..'))throw new Error('請使用文件夾內的相對路徑。');
  if(state.activeSection===null){await saveAll();const result=await api('section.create',{title,path});state.project=result.project||result;state.configDirty=false;state.tree.clear();renderFiles();renderOutline();await openFile(path);}
  else mutateConfig(config=>{const item={id:config.sections[state.activeSection].id,title,path,enabled:config.sections[state.activeSection].enabled!==false};config.sections[state.activeSection]=item;});
  $('section-dialog').close();
});});
function fillStyleForm() {
  if(!state.project)return;const form=$('style-form'),style=state.project.config.style||{};
  form.elements.title.value=state.project.config.title||state.project.title||'';
  const defaults={fontFamily:'Times New Roman',fontSizePt:11,lineHeight:1.5,pageSize:'A4',marginTopMm:25,marginRightMm:25,marginBottomMm:25,marginLeftMm:25};
  for(const [key,value]of Object.entries(defaults))form.elements[key].value=style[key]??value;
}
$('style-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
  const form=event.target;if(!form.reportValidity())return;
  mutateConfig(config=>{config.title=form.elements.title.value.trim()||'未命名文檔';config.style={...config.style};for(const key of ['fontFamily','pageSize'])config.style[key]=form.elements[key].value;for(const key of ['fontSizePt','lineHeight','marginTopMm','marginRightMm','marginBottomMm','marginLeftMm'])config.style[key]=Number(form.elements[key].value);});
  await saveAll();await startBuild(false);
});});
async function startBuild(save=true,wait=false) {
  if(save)await saveAll();if(!state.project)throw new Error('請先開啟文檔文件夾。');
  notice('');const result=await api('build.start',{runLayoutScript:true});
  const job=state.jobs.get(result.jobId)||{id:result.jobId,revision:result.revision,status:'queued',stage:'queued',logs:[],diagnostics:[],stats:{}};
  state.activeJob=job;renderJob(job);if(terminal.has(job.status))await handleCompletion(job);
  if(wait)return waitForJob(job.id);return result;
}
function waitForJob(id) {
  const current=state.jobs.get(id);if(current&&terminal.has(current.status))return current.status==='completed'?Promise.resolve(current):Promise.reject(new Error(current.diagnostics?.join('\n')||labels[current.status]));
  return new Promise((resolve,reject)=>state.waiters.set(id,{resolve,reject}));
}
function renderJob(job) {
  $('job-state').textContent=`${labels[job.status]||job.status} · ${job.stage||'排版'}`;
  const stats=job.stats||{};
  $('cache-stats').textContent=stats.renderedSections!==undefined?`重轉 ${stats.renderedSections} 章 · 快取 ${stats.cachedSections??0} 章${stats.elapsedMs!==undefined?' · '+(stats.elapsedMs/1000).toFixed(2)+' s':''}`:'';
  const lines=[...(job.logs||[]),...(job.diagnostics||[]).map(s=>'⚠ '+s)];$('logs').textContent=lines.join('\n');$('logs').scrollTop=$('logs').scrollHeight;
  refreshControls();
}
async function handleCompletion(job) {
  if(job.status==='completed') {
    if(job.pdfPath){state.pdfPath=job.pdfPath;await showArtifact('pdf',job);notice(job.previewOnly?'PDF 成品已生成。':'PDF 已匯出。',true);}
    else if(job.htmlPath){state.htmlJob=job;state.previewStale=state.dirty||state.configDirty;await showArtifact('html',job);if(state.previewStale)$('preview-state').textContent='已排版保存內容 · 當前仍有未保存修改';notice('排版完成。',true);}
  } else if(job.status==='failed') {
    notice(`${job.diagnostics?.join('\n')||job.logs?.slice(-3).join('\n')||'排版未完成。'}\n已保留上一次成功預覽。`);
    $('preview-state').textContent='本次失敗 · 顯示上次成功結果';$('log-panel').hidden=false;
  } else if(job.status==='canceled')$('preview-state').textContent='已取消 · 保留上次成功預覽';
}
async function receiveEvent(event) {
  if(event?.type==='command'){
    const actions={new:openNewProject,open:()=>changeProject('project.open'),save:()=>saveAll(),pdf:exportPdf,build:()=>startBuild(),cancel:()=>state.activeJob&&api('build.cancel',{id:state.activeJob.id}),dependencies:inspectDependencies};
    return actions[event.command]?.();
  }
  if(event?.type==='project'&&event.project)return loadProject(event.project);
  if(event?.type==='files-changed')return syncExternalChanges(event);
  if(event?.type==='ai'&&event.job)return renderAiJob(event.job);
  if(event?.type==='error')return notice(event.message||'操作未完成。');
  if(event?.type!=='job'||!event.job)return;const job=event.job;state.jobs.set(job.id,job);
  if(state.jobs.size>80)state.jobs.delete(state.jobs.keys().next().value);
  if(state.activeJob?.id===job.id){state.activeJob=job;renderJob(job);if(terminal.has(job.status))await handleCompletion(job);}
  const waiter=state.waiters.get(job.id);
  if(waiter&&terminal.has(job.status)){state.waiters.delete(job.id);job.status==='completed'?waiter.resolve(job):waiter.reject(new Error(job.diagnostics?.join('\n')||labels[job.status]));}
}
async function showArtifact(mode,job) {
  const path=mode==='pdf'?job.pdfPath:job.htmlPath;
  const result=await api('preview.url',{htmlPath:path});
  if(mode==='pdf'){state.pdfUrl=result.url;state.pdfHtmlPath=job.htmlPath;}else state.htmlUrl=result.url;
  setPreviewMode(mode);$('preview-state').textContent=mode==='pdf'?'實際 PDF 成品':`成功預覽 · 修訂 ${job.revision??''}`;
}
function setPreviewMode(mode) {
  state.previewMode=mode;const url=mode==='pdf'?state.pdfUrl:state.htmlUrl;
  $('html-tab').classList.toggle('selected',mode==='html');$('pdf-tab').classList.toggle('selected',mode==='pdf');
  if(url){if(mode==='pdf')$('preview').removeAttribute('sandbox');else $('preview').setAttribute('sandbox','allow-same-origin');$('preview').src=url;$('preview').hidden=false;$('preview-placeholder').hidden=true;}
  refreshControls();
}
async function requestPdf(previewOnly=false) {
  if(state.pdfStarting||working()||!state.project)return;
  state.pdfStarting=true;refreshControls();
  const session=state.session,needsBuild=!state.htmlJob||state.previewStale||state.dirty||state.configDirty;let htmlJob;
  try{
    await saveAll();htmlJob=needsBuild?await startBuild(false,true):state.htmlJob;
    if(session!==state.session)return;
    if(previewOnly&&state.pdfUrl&&state.pdfHtmlPath===htmlJob.htmlPath){setPreviewMode('pdf');return;}
    const result=await api(previewOnly?'pdf.preview':'pdf.export',{jobId:htmlJob.id||htmlJob.jobId});if(result.canceled||session!==state.session)return;
    const job=state.jobs.get(result.jobId)||{id:result.jobId,revision:result.revision,status:'queued',stage:'PDF',logs:[],diagnostics:[],stats:{}};
    state.activeJob=job;renderJob(job);if(terminal.has(job.status))await handleCompletion(job);
  }catch(error){if(session===state.session)throw error;}
  finally{if(session===state.session){state.pdfStarting=false;refreshControls();}}
}
function exportPdf(){return requestPdf(false);}
async function inspectDependencies() {
  $('dependency-dialog').showModal();$('dependency-list').textContent='正在檢查…';
  let result;try{result=await api('dependencies.inspect');}catch(error){$('dependency-list').textContent=describe(error);return;}const list=$('dependency-list');list.replaceChildren();
  for(const item of result.items||[]){const row=node('div','dependency-item');row.append(node('span',item.available?'available':'missing',item.available?'●':'○'),node('strong','',item.name));const details=node('div','dependency-details');details.append(node('strong','',`${item.available?'可用':'未找到'} · ${{bundled:'隨附',system:'系統',configured:'專案設定'}[item.source]||item.source||''}${item.version?' · '+item.version:''}`));if(item.path)details.append(node('div','',item.path));if(item.message)details.append(node('div','',item.message));row.append(details);list.append(row);}
}
function openCommandSettings() {
  const form=$('command-form');form.elements.argv.value=JSON.stringify(state.project.config.command?.argv||[],null,2);form.elements.outputs.value=(state.project.config.command?.outputs||[]).join('\n');$('command-dialog').showModal();
}
async function saveCommandSettings() {
  const form=$('command-form');let argv;try{argv=JSON.parse(form.elements.argv.value||'[]');}catch{throw new Error('命令參數必須是有效的 JSON 陣列。');}
  if(!Array.isArray(argv)||argv.some(x=>typeof x!=='string'))throw new Error('命令參數必須是字串陣列。');
  mutateConfig(c=>{if(argv.length)c.command={argv,outputs:form.elements.outputs.value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)};else delete c.command;});await saveAll();
}
$('command-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{await saveCommandSettings();$('command-dialog').close();});});
$('run-command').addEventListener('click',()=>run(async()=>{
  await saveCommandSettings();const result=await api('script.run');$('command-dialog').close();const job=state.jobs.get(result.jobId)||{id:result.jobId,status:'queued',stage:'script',logs:[],diagnostics:[],stats:{}};state.activeJob=job;renderJob(job);if(terminal.has(job.status))await handleCompletion(job);
}));
$('open-project').onclick=()=>run(()=>changeProject('project.open'));$('new-project').onclick=openNewProject;
$('save').onclick=()=>run(()=>saveAll());$('build').onclick=()=>run(()=>startBuild());$('export-pdf').onclick=()=>run(exportPdf);
$('cancel-job').onclick=()=>run(async()=>{if(state.activeJob)await api('build.cancel',{id:state.activeJob.id});});
$('add-section').onclick=()=>editSection();$('open-layout').onclick=()=>run(()=>openFile(state.project.config.layoutScript));
$('open-stylesheet').onclick=()=>run(()=>openFile(state.project.config.stylesheet));
$('dependencies').onclick=()=>run(inspectDependencies);$('command-settings').onclick=openCommandSettings;
$('editor-find').onclick=()=>openSearchPanel(editor);$('dismiss-notice').onclick=()=>notice('');
$('toggle-style').onclick=()=>{$('style-panel').hidden=!$('style-panel').hidden;fillStyleForm();};$('close-style').onclick=()=>{$('style-panel').hidden=true;};
$('outline-tab').onclick=()=>{ $('outline-tab').classList.add('selected');$('files-tab').classList.remove('selected');$('outline-panel').hidden=false;$('files-panel').hidden=true;};
$('files-tab').onclick=()=>{ $('outline-tab').classList.remove('selected');$('files-tab').classList.add('selected');$('outline-panel').hidden=true;$('files-panel').hidden=false;};
$('html-tab').onclick=()=>setPreviewMode('html');$('pdf-tab').onclick=()=>run(()=>requestPdf(true));
$('open-artifact').onclick=()=>run(()=>api('artifact.open',{path:state.previewMode==='pdf'?state.pdfPath:state.htmlJob.htmlPath}));
$('toggle-log').onclick=()=>{$('log-panel').hidden=!$('log-panel').hidden;};
for(const b of document.querySelectorAll('[data-close-dialog]'))b.onclick=()=>b.closest('dialog').close();
const workbench=setupWorkbench({$,state,editor,wrapMode,EditorView,language,codeTheme,codeHighlight,api,run,node,notice,describe,terminal,labels,openFile,setEditor,saveAll,guardDirty,changeProject,renderFiles,renderOutline,refreshControls,fillStyleForm,mutateConfig,decide,getWrap:()=>wrapEnabled,setWrap:value=>{wrapEnabled=value;}});
function openNewProject(){return workbench.openNewProject();}
function loadDirectory(folder){return workbench.loadDirectory(folder);}
function refreshFileTree(){return workbench.refreshFileTree();}
function openEntryDialog(kind){return workbench.openEntryDialog(kind);}
function openMedia(path,sequence){return workbench.openMedia(path,sequence);}
function openBinaryInfo(path){return workbench.openBinaryInfo(path);}
function syncExternalChanges(event){return workbench.syncExternalChanges(event);}
function loadAiHistory(){return workbench.loadAiHistory();}
function renderAiJob(job){return workbench.renderAiJob(job);}
document.addEventListener('keydown',event=>{
  if(event.defaultPrevented)return;
  if(event.key==='F5'){event.preventDefault();if(state.project)run(()=>startBuild());}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='s'){event.preventDefault();if(state.project)run(()=>saveAll());}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='e'){event.preventDefault();if(state.project)run(exportPdf);}
});
// The main process owns the native close prompt using app.dirty state.
if(bridge){bridge.onEvent(event=>run(()=>receiveEvent(event)));run(async()=>{const info=await api('app.info');$('version').textContent=info.version||'0.1.0';const p=await api('project.get');if(p.root||p.project)await loadProject(p);});}
else notice('此頁面需要 DOConstruct 桌面程式提供本機文件與排版功能。');
refreshControls();
