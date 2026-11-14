import { renderAiMarkdown } from './ai-markdown.mjs';
import { createChangeDiff } from './change-diff.js';

// UI tools share the existing project/file API; none of these actions starts layout.
export function setupWorkbench({ $,state,editor,wrapMode,EditorView,language,codeTheme,codeHighlight,api,run,node,notice,describe,terminal,labels,openFile,setEditor,saveAll,guardDirty,changeProject,renderFiles,renderOutline,refreshControls,fillStyleForm,mutateConfig,decide,getWrap,setWrap }) {
  function openNewProject(){const form=$('new-form');if(!form.elements.title.value)form.elements.title.value='未命名文檔';$('new-dialog').showModal();}
  $('new-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{const form=event.target;if(!form.reportValidity())return;const options={title:form.elements.title.value.trim(),kind:form.elements.kind.value};$('new-dialog').close();await changeProject('project.new',{options});});});
  function updateWrapButton(){$('wrap-toggle').setAttribute('aria-pressed',String(getWrap()));$('wrap-toggle').textContent=getWrap()?'自動換行':'不換行';}
  $('wrap-toggle').onclick=()=>{setWrap(!getWrap());localStorage.setItem('doconstruct.wrap',String(getWrap()));editor.dispatch({effects:wrapMode.reconfigure(getWrap()?EditorView.lineWrapping:[])});updateWrapButton();};updateWrapButton();
  function openLayoutSettings(){const form=$('layout-form');form.elements.layoutScript.value=state.project.config.layoutScript||'';form.elements.stylesheet.value=state.project.config.stylesheet||'';$('layout-dialog').showModal();}
  $('toggle-layout').onclick=openLayoutSettings;
  for(const [id,key]of [['layout-edit-script','layoutScript'],['layout-edit-css','stylesheet'],['layout-edit-config',null]])$(id).onclick=()=>run(async()=>{const path=key?state.project.config[key]:'doconstruct.json';if(!path)throw new Error('請先設定這個排版文件的路徑。');$('layout-dialog').close();await openFile(path);});
  $('layout-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{mutateConfig(c=>{c.layoutScript=event.target.elements.layoutScript.value.trim();c.stylesheet=event.target.elements.stylesheet.value.trim();});await saveAll();$('layout-dialog').close();notice('排版設定已保存。點擊「更新預覽」套用。',true);});});

  async function loadDirectory(folder){const root=state.project?.root;if(!root)return;const result=await api('file.list',{path:folder});if(root!==state.project?.root)return;state.tree.set(folder,result.entries||[]);}
  async function refreshFileTree(){if(!state.project)return;state.treeLoading=true;try{for(const folder of [...state.expanded]){try{await loadDirectory(folder);}catch(error){if(folder==='')throw error;state.expanded.delete(folder);state.tree.delete(folder);}}}finally{state.treeLoading=false;}renderFiles();}
  function entryParent(){const entry=state.selectedEntry;if(!entry)return '';return entry.type==='directory'?entry.path:entry.path.split('/').slice(0,-1).join('/');}
  let entryAction='file';
  function openEntryDialog(kind){if(!state.project)return;if(kind==='rename'&&!state.selectedEntry){notice('請先在文件樹選擇一個項目。');return;}entryAction=kind;const parent=entryParent();$('entry-dialog-title').textContent={file:'新建文件',folder:'新建文件夾',rename:'重命名或移動'}[kind];$('entry-form').elements.path.value=kind==='rename'?state.selectedEntry.path:(parent?parent+'/':'')+(kind==='folder'?'新文件夾':'新文件.md');$('entry-dialog').showModal();}
  $('new-file').onclick=()=>openEntryDialog('file');$('new-folder').onclick=()=>openEntryDialog('folder');$('rename-entry').onclick=()=>openEntryDialog('rename');$('refresh-files').onclick=()=>run(refreshFileTree);
  $('entry-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{const path=event.target.elements.path.value.trim();if(!path)throw new Error('請填寫專案內的相對路徑。');await saveAll();let result;if(entryAction==='file')await api('file.save',{path,content:'',version:null});else if(entryAction==='folder')await api('directory.create',{path});else{const previous=state.selectedEntry.path;result=await api('entry.rename',{path:previous,newPath:path});if(state.file?.path===previous||state.file?.path.startsWith(previous+'/')){const nextPath=path+state.file.path.slice(previous.length);setEditor(null);await openFile(nextPath);}state.selectedEntry=null;state.expanded=new Set(['']);}if(result?.root||result?.project?.root)state.project=result.project||result;$('entry-dialog').close();state.tree.clear();await refreshFileTree();if(entryAction==='file')await openFile(path);notice('文件操作已完成；文檔預覽未自動更新。',true);});});
  $('remove-entry').onclick=()=>run(async()=>{if(!state.selectedEntry)throw new Error('請先在文件樹選擇一個項目。');const item=state.selectedEntry;const answer=await decide(`將「${item.path}」移至專案回收區？相關骨架項目也會移除。`,'移至回收區？',{save:'移至回收區',discard:'保留',cancel:'取消'});if(answer!=='save')return;if(!await guardDirty())return;const result=await api('entry.remove',{path:item.path});state.project=result.project||result;state.configDirty=false;if(state.file?.path===item.path||state.file?.path.startsWith(item.path+'/'))setEditor(null);state.selectedEntry=null;state.tree.clear();state.expanded=new Set(['']);renderOutline();await refreshFileTree();notice('已移至回收區，原始內容未永久刪除。',true);});
  async function openMedia(path,sequence){const media=await api('file.media',{path});if(sequence!==state.loadSequence)return;setEditor({path,content:'',binary:true});$('language-label').textContent='IMAGE';$('editor').hidden=true;const panel=node('div','media-view'),img=node('img');img.src=media.url;img.alt=path;panel.append(img);$('editor').after(panel);}
  function openBinaryInfo(path){setEditor({path,content:'',binary:true});$('language-label').textContent='FILE';$('editor').hidden=true;const panel=node('div','media-view');panel.append(node('p','media-info',path+'\n此類型不是可編輯文字；保留原始二進位內容。'));$('editor').after(panel);}

  async function syncExternalChanges(event){
    if(event.error){notice(event.error.message||String(event.error));return;}
    const incoming=event.project?.project||event.project;
    if(!incoming||incoming.root!==state.project?.root)return;
    if(state.savePromise)await state.savePromise;
    if(incoming.root!==state.project?.root)return;
    const old=state.project,paths=event.paths||[],configConflict=state.configDirty&&incoming.version!==old.version;
    if(configConflict)state.externalProject=incoming;
    else{state.project={...incoming,config:state.configDirty?old.config:incoming.config};$('project-title').textContent=state.project.title;renderOutline();fillStyleForm();}
    if(state.htmlUrl&&event.sourceChanged!==false){state.previewStale=true;$('preview-state').textContent='文件已變更 · 點擊更新預覽';}
    if(state.file&&!state.file.binary&&(paths.includes(state.file.path)||paths.includes('doconstruct.json'))){
      const activeFile=state.file;
      try{const fresh=await api('file.read',{path:activeFile.path});if(state.file===activeFile&&fresh.version!==activeFile.version){if(state.dirty){state.externalProject=incoming;$('conflict-text').textContent='當前文件已被外部或 AI 修改；已保留你尚未保存的編輯。';$('external-conflict').hidden=false;}else{const selection=editor.state.selection.main.head;setEditor(fresh);editor.dispatch({selection:{anchor:Math.min(selection,editor.state.doc.length)}});}}}
      catch(error){if(state.file===activeFile){if(state.dirty){state.externalProject=incoming;$('conflict-text').textContent='當前文件已移動或刪除；你的未保存編輯仍保留。';$('external-conflict').hidden=false;}else setEditor(null);}}
    }
    if(configConflict){$('conflict-text').textContent='骨架已被外部或 AI 修改；已保留你的未保存骨架。';$('external-conflict').hidden=false;}
    await refreshFileTree();refreshControls();
  }
  $('reload-external').onclick=()=>run(async()=>{const incoming=state.externalProject||await api('project.refresh'),path=state.file?.path;state.project=incoming.project||incoming;state.configDirty=false;state.externalProject=null;state.dirty=false;if(path){try{setEditor(await api('file.read',{path}));}catch{setEditor(null);}}$('external-conflict').hidden=true;renderOutline();await refreshFileTree();refreshControls();});
  $('keep-local').onclick=()=>{$('external-conflict').hidden=true;notice('已保留本機編輯；外部版本仍受保護。保存衝突時請先合併或另存新文件。');};

  const preferred={sidebar:Number(localStorage.getItem('doconstruct.sidebar-width'))||246,preview:Number(localStorage.getItem('doconstruct.preview-width'))||innerWidth*.4,ai:Number(localStorage.getItem('doconstruct.ai-width'))||340};
  function fitPanels(){const width=$('workbench').clientWidth,aiOpen=!$('ai-panel').hidden;const ai=aiOpen?Math.min(preferred.ai,Math.max(250,width*.36)):0;const sidebar=Math.min(preferred.sidebar,Math.max(160,width-ai-360-18));const preview=Math.min(preferred.preview,Math.max(160,width-ai-sidebar-190-18));document.documentElement.style.setProperty('--sidebar-width',sidebar+'px');document.documentElement.style.setProperty('--preview-width',preview+'px');if(aiOpen)document.documentElement.style.setProperty('--ai-width',ai+'px');}
  window.addEventListener('resize',fitPanels);
  function installSplitter(id,variable,readSize,adjust,maximum){
    const handle=$(id),saved=Number(localStorage.getItem('doconstruct.'+variable));
    function set(value){const v=Math.round(Math.min(maximum(),Math.max(id==='log-splitter'?65:id==='ai-splitter'?250:160,value)));document.documentElement.style.setProperty('--'+variable,v+'px');handle.setAttribute('aria-valuenow',String(v));localStorage.setItem('doconstruct.'+variable,String(v));if(variable==='sidebar-width')preferred.sidebar=v;if(variable==='preview-width')preferred.preview=v;if(variable==='ai-width')preferred.ai=v;fitPanels();}
    if(saved)set(saved);
    handle.addEventListener('pointerdown',event=>{if(event.button!==0)return;event.preventDefault();const start=readSize(),coordinate=id==='log-splitter'?event.clientY:event.clientX;handle.setPointerCapture(event.pointerId);document.body.classList.add('resizing');handle.classList.add('dragging');const move=e=>set(start+adjust*((id==='log-splitter'?e.clientY:e.clientX)-coordinate));const end=()=>{document.body.classList.remove('resizing');handle.classList.remove('dragging');handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',end);};handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',end);});
    handle.addEventListener('keydown',event=>{const relevant=id==='log-splitter'?['ArrowUp','ArrowDown']:['ArrowLeft','ArrowRight'];if(!relevant.includes(event.key))return;event.preventDefault();set(readSize()+adjust*(event.key===relevant[0]?-20:20));});
  }
  installSplitter('sidebar-splitter','sidebar-width',()=>document.querySelector('.sidebar').offsetWidth,1,()=>Math.min(500,innerWidth*.4));
  installSplitter('preview-splitter','preview-width',()=>document.querySelector('.preview-pane').offsetWidth,-1,()=>Math.max(180,$('workbench').clientWidth-document.querySelector('.sidebar').offsetWidth-190-(!$('ai-panel').hidden?$('ai-panel').offsetWidth+6:0)));
  installSplitter('ai-splitter','ai-width',()=>$('ai-panel').offsetWidth,-1,()=>Math.min(650,innerWidth*.5));
  installSplitter('log-splitter','log-height',()=>$('log-panel').offsetHeight,-1,()=>innerHeight*.65);

  let aiTasks=[], messageSignature='', aiSubmitting=false,aiSessionChanging=false,aiRenameSubmitting=false,aiRenameTarget=null,aiRoot=null,aiSessionId=null,aiLoadSequence=0,aiSettingsRoot=null;
  let aiMessages=[],aiFirstIndex=0,aiTotalMessages=0,aiHasMore=false,aiFollowingLatest=true,aiLoadingOlder=false;
  function aiBusy(){return state.aiJob&&!terminal.has(state.aiJob.status);}
  function updateAiInput(){
    const busy=aiBusy();$('ai-send').disabled=aiSubmitting||aiSessionChanging;$('ai-send').textContent=busy?'追加指令':'發送';
    $('ai-send').title=busy?'保留目前任務，在下一個執行邊界套用追加指令':'';
    $('ai-input').placeholder=busy?'追加要求或調整方向；會在下一個執行邊界套用。':'例如：先建立論文骨架，再幫我補寫研究動機。';
    $('ai-session').disabled=$('ai-new-session').disabled=!!busy||aiSubmitting||aiSessionChanging||!state.project;
    $('ai-rename-session').disabled=aiRenameSubmitting||aiSessionChanging||!state.project||!aiSessionId;
    for(const button of $('ai-messages').querySelectorAll('[data-ai-action="retry"]'))button.disabled=!!busy||aiSubmitting||aiSessionChanging;
  }
  function updateChangeButton(){$('ai-changes').textContent=`查看修改${aiTasks.length?' · '+aiTasks.length:''}`;}
  function clearAiSession(){
    $('ai-session-rename-dialog').close();aiRenameTarget=null;
    $('ai-changes-dialog').close();reviewSequence++;destroyReview();reviewRoot=null;aiTasks=[];state.aiJob=null;messageSignature='';
    aiMessages=[];aiFirstIndex=0;aiTotalMessages=0;aiHasMore=false;aiFollowingLatest=true;aiLoadingOlder=false;
    $('ai-messages').replaceChildren();$('ai-tools').replaceChildren();$('ai-tool-count').textContent='執行記錄 · 0';
    $('ai-status').textContent='就緒';$('ai-cancel').hidden=true;updateChangeButton();updateAiHistoryControls();updateAiInput();
  }
  function updateAiHistoryControls(){
    $('ai-load-earlier').hidden=!aiHasMore;$('ai-load-earlier').disabled=aiLoadingOlder||aiSessionChanging;
    $('ai-load-earlier').textContent=aiLoadingOlder?'載入中…':'載入較早訊息';
    const unseen=Math.max(0,aiTotalMessages-aiFirstIndex-aiMessages.length);
    $('ai-latest').hidden=aiFollowingLatest;$('ai-latest').textContent=unseen?`查看最新 · ${unseen} 則新訊息`:'回到最新';
    $('ai-history-state').textContent=aiTotalMessages?`${aiFirstIndex+1}–${aiFirstIndex+aiMessages.length} / ${aiTotalMessages}`:'';
  }
  async function refreshAiSessions(root=state.project?.root){
    const sequence=aiLoadSequence,result=await api('ai.sessions');if(root!==state.project?.root||sequence!==aiLoadSequence)return null;
    const select=$('ai-session'),scroll=select.scrollTop;select.replaceChildren();
    for(const session of result.sessions||[]){const option=node('option','',session.title||'新會話');option.value=session.id;select.append(option);}
    select.value=result.activeSessionId;select.scrollTop=scroll;return result;
  }
  function applyAiHistory(result){
    aiTasks=result.changeTasks||[];updateChangeButton();aiFollowingLatest=true;
    aiFirstIndex=result.firstIndex??0;aiTotalMessages=result.totalMessages??result.messages?.length??0;aiHasMore=!!result.hasMore;
    state.aiJob=result.activeJob||null;
    renderAiMessages(result.messages||[],'latest');
    if(result.activeJob)renderAiJob(result.activeJob);else{$('ai-status').textContent='就緒';$('ai-cancel').hidden=true;$('ai-tools').replaceChildren();$('ai-tool-count').textContent='執行記錄 · 0';updateAiInput();}
  }
  async function loadAiHistory(){
    const root=state.project?.root;if(!root)return;
    const sequence=++aiLoadSequence;aiSessionChanging=true;aiLoadingOlder=false;updateAiInput();
    try{
      if(aiRoot!==root){aiRoot=root;aiSessionId=null;clearAiSession();}
      const sessions=await refreshAiSessions(root);if(!sessions||sequence!==aiLoadSequence)return;
      if(aiSessionId!==sessions.activeSessionId){clearAiSession();aiSessionId=sessions.activeSessionId;}
      const result=await api('ai.history',{limit:100});
      if(root!==state.project?.root||sequence!==aiLoadSequence||result.sessionId!==aiSessionId)return;
      applyAiHistory(result);
    }finally{if(sequence===aiLoadSequence){aiSessionChanging=false;updateAiInput();updateAiHistoryControls();}}
  }
  async function changeAiSession(create){
    if(aiBusy()||aiSubmitting){$('ai-session').value=aiSessionId;throw new Error('請先停止目前 AI 任務，再新建或切換會話。');}
    const root=state.project?.root,id=$('ai-session').value;if(!root)return;
    aiSessionChanging=true;updateAiInput();
    try{
      await api(create?'ai.session.create':'ai.session.select',create?{}:{id});
      if(root!==state.project?.root)return;
      clearAiSession();aiSessionId=null;await loadAiHistory();
    }catch(error){$('ai-session').value=aiSessionId;throw error;}
    finally{aiSessionChanging=false;updateAiInput();}
  }
  $('ai-new-session').onclick=()=>run(()=>changeAiSession(true));
  $('ai-session').onchange=()=>run(()=>changeAiSession(false));
  $('ai-rename-session').onclick=()=>run(async()=>{
    const root=state.project?.root,id=aiSessionId;if(!root||!id||aiRenameSubmitting||$('ai-session-rename-dialog').open)return;
    const result=await api('ai.sessions');
    if(root!==state.project?.root||id!==aiSessionId||result.activeSessionId!==id)return;
    const session=result.sessions.find(s=>s.id===id);if(!session)throw new Error('目前會話已不存在，請重新開啟會話列表。');
    aiRenameTarget={root,id};const input=$('ai-session-rename-form').elements.title;input.value=session.title;
    $('ai-session-rename-dialog').showModal();input.focus();input.select();
  });
  $('ai-session-rename-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
    const form=event.target,target=aiRenameTarget;if(aiRenameSubmitting||!form.reportValidity())return;
    if(!target||target.root!==state.project?.root||target.id!==aiSessionId)throw new Error('工作區或會話已切換，未修改名稱。');
    aiRenameSubmitting=true;form.querySelector('[type="submit"]').disabled=true;updateAiInput();
    try{
      await api('ai.session.rename',{id:target.id,title:form.elements.title.value});
      if(target.root!==state.project?.root||target.id!==aiSessionId)return;
      await refreshAiSessions(target.root);
      if(target.root!==state.project?.root||target.id!==aiSessionId)return;
      $('ai-session-rename-dialog').close();aiRenameTarget=null;notice('會話名稱已保存。',true);
    }finally{aiRenameSubmitting=false;form.querySelector('[type="submit"]').disabled=false;updateAiInput();}
  });});
  $('ai-load-earlier').onclick=()=>run(async()=>{
    if(aiLoadingOlder||!aiHasMore)return;
    const root=aiRoot,sessionId=aiSessionId,sequence=aiLoadSequence,before=aiFirstIndex;
    aiLoadingOlder=true;aiFollowingLatest=false;updateAiHistoryControls();
    try{
      const result=await api('ai.history',{before,limit:100});
      if(root!==state.project?.root||sessionId!==aiSessionId||result.sessionId!==sessionId||sequence!==aiLoadSequence||before!==aiFirstIndex)return;
      aiFirstIndex=result.firstIndex;aiTotalMessages=Math.max(aiTotalMessages,result.totalMessages);aiHasMore=!!result.hasMore;
      renderAiMessages([...(result.messages||[]),...aiMessages],'prepend');
    }finally{if(root===aiRoot&&sessionId===aiSessionId&&sequence===aiLoadSequence){aiLoadingOlder=false;updateAiHistoryControls();}}
  });
  $('ai-latest').onclick=()=>run(loadAiHistory);
  $('ai-messages').addEventListener('scroll',()=>{
    const list=$('ai-messages');if(aiFollowingLatest&&list.scrollTop+list.clientHeight<list.scrollHeight-40){aiFollowingLatest=false;updateAiHistoryControls();}
  });
  async function openAi(){const show=$('ai-panel').hidden;$('ai-panel').hidden=!show;$('ai-splitter').hidden=!show;$('toggle-ai').setAttribute('aria-expanded',String(show));if(!show)return;fitPanels();const result=await api('ai.skills');$('ai-skill').replaceChildren(node('option','','一般文檔協作'));$('ai-skill').firstChild.value='';for(const skill of result.skills||[]){const option=node('option','',skill.title);option.value=skill.id;option.title=skill.description||'';$('ai-skill').append(option);}if(state.project)await loadAiHistory();}
  function messageRole(message){
    if(message.role!=='user')return 'AI 助手 · 回覆';if(!message.steeringId)return '你 · 任務要求';
    const instruction=state.aiJob?.steering?.find(s=>s.id===message.steeringId),status=instruction?.status||message.steeringStatus;
    return `你 · 追加指令${status==='applied'?' · 已送入推理':status==='pending'?(instruction&&aiBusy()?' · 等待套用':' · 未套用'):''}`;
  }
  function messageAction(action,label){const button=node('button','quiet',label);button.type='button';button.dataset.aiAction=action;return button;}
  function updateMessageActions(){
    for(const row of $('ai-messages').children){
      const eligible=row.dataset.role==='assistant'&&Number(row.dataset.messageIndex)===aiTotalMessages-1;
      let retry=row.querySelector('[data-ai-action="retry"]');
      if(eligible&&!retry){retry=messageAction('retry','重新嘗試');row.querySelector('.ai-message-actions').append(retry);}
      else if(!eligible&&retry){retry.remove();retry=null;}
      if(retry)retry.disabled=!!aiBusy()||aiSubmitting||aiSessionChanging;
    }
  }
  function renderAiMessages(messages,mode='latest'){
    aiMessages=messages;updateAiHistoryControls();
    const signature=JSON.stringify([aiSessionId,aiFirstIndex,messages,state.aiJob?.steering]);if(signature===messageSignature)return;messageSignature=signature;
    const list=$('ai-messages'),scroll=list.scrollTop,height=list.scrollHeight,existing=new Map([...list.children].map(row=>[row.dataset.messageIndex,row]));
    const fragment=document.createDocumentFragment();
    for(const [index,message]of messages.entries()){
      if(!['user','assistant'].includes(message.role)||!message.content)continue;
      const key=String(aiFirstIndex+index),previous=existing.get(key);let row=previous;
      if(!row||row.messageContent!==message.content||row.dataset.role!==message.role){
        const user=message.role==='user';row=node('article','ai-message '+message.role);const header=node('header','ai-message-header');
        header.append(node('span','ai-avatar',user?'你':'AI'),node('span','ai-role',messageRole(message)));
        const content=node('div',user?'ai-message-content':'ai-message-content ai-markdown');if(user)content.textContent=message.content;else content.innerHTML=renderAiMarkdown(message.content);
        if(!user)for(const pre of content.querySelectorAll('pre')){const copy=messageAction('copy-code','複製程式碼');copy.classList.add('ai-code-copy');pre.prepend(copy);}
        const actions=node('div','ai-message-actions');actions.append(messageAction('copy','複製'));if(user)actions.append(messageAction('edit','編輯'));
        row.append(header,content,actions);row.dataset.messageIndex=key;row.messageContent=message.content;row.dataset.role=message.role;
      }else row.querySelector('.ai-role').textContent=messageRole(message);
      fragment.append(row);
    }
    list.replaceChildren(fragment);updateMessageActions();list.scrollTop=mode==='prepend'?scroll+list.scrollHeight-height:mode==='latest'?list.scrollHeight:scroll;
  }
  async function copyAiText(text){try{await navigator.clipboard.writeText(text);}catch{await api('clipboard.write',{text});}}
  $('ai-messages').addEventListener('click',event=>{
    const action=event.target.closest('[data-ai-action]');
    if(action){event.preventDefault();run(async()=>{
      const row=action.closest('.ai-message');
      if(action.dataset.aiAction==='copy'){await copyAiText(row.messageContent);notice('已複製訊息原文。',true);}
      else if(action.dataset.aiAction==='copy-code'){await copyAiText(action.closest('pre').querySelector('code')?.textContent||'');notice('已複製程式碼。',true);}
      else if(action.dataset.aiAction==='edit'){$('ai-input').value=row.messageContent;$('ai-input').focus();notice('已放回輸入框；編輯後發送，不會回滾文件或刪除原訊息。',true);}
      else if(action.dataset.aiAction==='retry'){
        if(aiBusy()||aiSubmitting||aiSessionChanging)throw new Error('請先停止目前 AI 任務，再重新嘗試。');
        if(Number(row.dataset.messageIndex)!==aiTotalMessages-1)return;
        const recent=aiMessages.slice(0,Number(row.dataset.messageIndex)-aiFirstIndex).findLast(message=>message.role==='user');
        if(!recent)throw new Error('請載入較早訊息，或在輸入框填寫要重試的要求。');
        $('ai-input').value=recent.content;$('ai-form').requestSubmit();
      }
    });return;}
    const link=event.target.closest('a');if(link){event.preventDefault();run(()=>api('external.open',{url:link.getAttribute('href')}));}
  });
  function renderAiJob(job){
    if(job.projectRoot&&job.projectRoot!==state.project?.root)return;
    if(aiRoot!==state.project?.root){aiRoot=state.project?.root;aiSessionId=null;clearAiSession();}
    if(job.sessionId&&aiSessionId&&job.sessionId!==aiSessionId)return;
    if(job.sessionId&&!aiSessionId)aiSessionId=job.sessionId;
    state.aiJob=job;const busy=!terminal.has(job.status);
    const pending=(job.steering||[]).filter(s=>s.status==='pending').length,applied=(job.steering||[]).filter(s=>s.status==='applied').length;
    $('ai-status').textContent=job.error||(pending?(busy?`已接收 ${pending} 條追加指令 · 等待目前操作結束`:`${pending} 條追加指令未套用`):applied?`${labels[job.status]||job.status} · ${applied} 條追加指令已送入推理`:labels[job.status]||job.status);
    $('ai-cancel').hidden=!busy;updateAiInput();aiTotalMessages=job.totalMessages??job.messages?.length??0;
    if(aiFollowingLatest){aiFirstIndex=job.firstIndex??0;aiHasMore=aiFirstIndex>0;renderAiMessages(job.messages||[]);}
    else{
      for(const [index,message]of aiMessages.entries())if(message.steeringId){const row=$('ai-messages').querySelector(`[data-message-index="${aiFirstIndex+index}"]`);if(row)row.querySelector('.ai-role').textContent=messageRole(message);}
      updateAiHistoryControls();updateMessageActions();
    }
    const tools=$('ai-tools'),scroll=tools.scrollTop,atEnd=scroll+tools.clientHeight>=tools.scrollHeight-24;tools.replaceChildren();
    for(const tool of job.toolCalls||[]){const step=node('div','ai-tool-step');step.append(node('strong','',`${tool.status==='skipped'?'已跳過':labels[tool.status]||tool.status} · ${tool.name}`));if(tool.summary)step.append(node('div','',tool.summary));if(tool.command||tool.output){const detail=node('details','ai-command-output'),pre=node('pre','');detail.append(node('summary','','命令與輸出'));pre.textContent=[tool.command,tool.output].filter(Boolean).join('\n\n');pre.style.whiteSpace='pre-wrap';pre.style.overflowWrap='anywhere';detail.append(pre);step.append(detail);}tools.append(step);}
    if(atEnd)tools.scrollTop=tools.scrollHeight;else tools.scrollTop=scroll;
    $('ai-tool-count').textContent=`執行記錄 · ${(job.toolCalls||[]).length}`;
    if(job.changes?.length){const item={id:job.id,status:job.status,changes:job.changes},index=aiTasks.findIndex(t=>t.id===job.id);if(index<0)aiTasks.push({...item,undone:false});else aiTasks[index]={...aiTasks[index],...item};aiTasks=aiTasks.slice(-12);updateChangeButton();}
    if($('ai-changes-dialog').open)refreshChangeTasks(job.id);
    if(job.status==='failed'&&job.error)notice('AI：'+job.error);
  }
  let reviewRoot=null,reviewSequence=0,reviewMode='diff',reviewView=null,reviewDetail=null,reviewKey='';
  function destroyReview(){reviewView?.destroy();reviewView=null;reviewDetail=null;reviewKey='';}
  function updateReview(){
    $('ai-change-diff').setAttribute('aria-pressed',String(reviewMode==='diff'));$('ai-change-full').setAttribute('aria-pressed',String(reviewMode==='full'));
    if(!reviewDetail)return;
    const options={...reviewDetail,mode:reviewMode,extensions:[codeHighlight,codeTheme,language(reviewDetail.path)[1]]};
    if(reviewView)reviewView.update(options);else reviewView=createChangeDiff($('ai-change-view'),options);
  }
  $('ai-change-diff').onclick=()=>{reviewMode='diff';updateReview();};$('ai-change-full').onclick=()=>{reviewMode='full';updateReview();};
  $('ai-changes-dialog').addEventListener('close',()=>{reviewSequence++;destroyReview();});
  function refreshChangeTasks(preferred){
    const select=$('ai-change-task'),selected=select.value||preferred;select.replaceChildren();
    for(const [index,task]of [...aiTasks].reverse().entries()){const option=node('option','',`任務 ${aiTasks.length-index} · ${task.undone?'已撤回':labels[task.status]||task.status} · ${task.changes.length} 個文件`);option.value=task.id;select.append(option);}
    if(aiTasks.some(t=>t.id===selected))select.value=selected;
    renderChangeFiles();
  }
  function renderChangeFiles(){
    const task=aiTasks.find(t=>t.id===$('ai-change-task').value),list=$('ai-change-files'),previous=list.querySelector('.selected')?.dataset.path;list.replaceChildren();
    $('ai-change-empty').hidden=!!task;
    if(!task){destroyReview();$('ai-change-note').textContent='';$('ai-change-path').textContent='';return;}
    $('ai-change-note').textContent=task.undone?'此任務已撤回；以下保留原本 AI 寫入時的快照。':'比較 AI 修改前後的快照；後續手動編輯不會改寫此記錄。';
    for(const change of task.changes){const button=node('button','ai-change-file',`${change.kind==='created'?'＋ 新建':'✎ 修改'} · ${change.path}`);button.type='button';button.dataset.path=change.path;button.title=`${change.beforeBytes} → ${change.afterBytes} 字節`;button.onclick=()=>run(()=>showChange(task.id,change.path));list.append(button);}
    const path=task.changes.some(c=>c.path===previous)?previous:list.querySelector('[data-path]')?.dataset.path;if(path)run(()=>showChange(task.id,path));
  }
  async function showChange(id,path){
    for(const button of $('ai-change-files').children)button.classList.toggle('selected',button.dataset.path===path);
    const summary=aiTasks.find(t=>t.id===id)?.changes.find(c=>c.path===path),key=id+'\0'+path+'\0'+summary?.afterVersion;
    if(key===reviewKey&&reviewView)return;
    const sequence=++reviewSequence,root=reviewRoot;
    const detail=await api('ai.changes',{id,path});if(sequence!==reviewSequence||root!==state.project?.root||!$('ai-changes-dialog').open)return;
    $('ai-change-path').textContent=path;
    reviewDetail=detail;reviewKey=id+'\0'+path+'\0'+detail.afterVersion;updateReview();
  }
  $('ai-changes').onclick=()=>run(async()=>{const root=state.project?.root,sessionId=aiSessionId;if(!root)throw new Error('請先開啟專案。');const result=await api('ai.changes');if(root!==state.project?.root||sessionId!==aiSessionId)return;aiTasks=result.tasks;updateChangeButton();reviewRoot=root;reviewMode='diff';$('ai-changes-dialog').showModal();updateReview();refreshChangeTasks(state.aiJob?.id);});
  $('ai-change-task').onchange=renderChangeFiles;
  $('toggle-ai').onclick=()=>run(openAi);$('close-ai').onclick=()=>run(openAi);
  $('ai-settings-button').onclick=()=>run(async()=>{
    const root=state.project?.root||null;
    const [result,scope]=await Promise.all([api('ai.settings'),root?api('ai.permissions'):Promise.resolve(null)]);
    if(root!==(state.project?.root||null))throw new Error('工作區已切換，請重新開啟 AI 設定。');
    aiSettingsRoot=root;const settings=result.settings||result,permissions=scope?.permissions,form=$('ai-settings-form');
    form.elements.baseUrl.value=settings.baseUrl||'';form.elements.model.value=settings.model||'';form.elements.apiMode.value=settings.apiMode||'chat-completions';form.elements.apiKey.value='';form.elements.clearApiKey.checked=false;
    form.elements.readFiles.checked=permissions?.readFiles??true;form.elements.writeFiles.checked=permissions?.writeFiles??true;form.elements.allowedPaths.value=(permissions?.allowedPaths||['.']).join('\n');
    form.elements.allowProjectCommands.checked=permissions?.allowCommands??false;form.elements.allowProjectCommands.disabled=!root;
    $('ai-permissions').disabled=!root;$('ai-permissions-root').textContent=root||'尚未開啟工作區。開啟後可分別設定文件範圍與讀寫權限。';
    $('ai-command-permission-note').textContent=root?'命令權限只作用於目前工作區。啟用命令需同時允許讀寫，且範圍包含「.」整個工作區；本機命令無法由文件範圍隔離。':'請先開啟工作區，再設定該工作區的命令權限。新工作區預設不允許命令。';
    $('ai-key-state').textContent=settings.hasApiKey?'已加密保存 API Key，留空即可保留。':'尚未保存 API Key。';$('ai-settings-dialog').showModal();
  });
  $('ai-settings-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
    const form=event.target;if(!form.reportValidity())return;
    if(aiSettingsRoot!==(state.project?.root||null))throw new Error('工作區已切換，請關閉設定後重新開啟。');
    const allowCommands=form.elements.allowProjectCommands.checked;
    const args={baseUrl:form.elements.baseUrl.value.trim(),model:form.elements.model.value.trim(),apiMode:form.elements.apiMode.value,clearApiKey:form.elements.clearApiKey.checked};
    if(form.elements.apiKey.value)args.apiKey=form.elements.apiKey.value;
    if(aiSettingsRoot)await api('ai.permissions.configure',{readFiles:form.elements.readFiles.checked,writeFiles:form.elements.writeFiles.checked,allowCommands,allowedPaths:form.elements.allowedPaths.value.split(/\r?\n/).map(p=>p.trim()).filter(Boolean)});
    if(aiSettingsRoot!==(state.project?.root||null))throw new Error('工作區已切換，連接設定尚未保存。');
    await api('ai.configure',args);form.elements.apiKey.value='';$('ai-settings-dialog').close();notice('AI 連接與目前工作區權限已保存。',true);
  });});
  $('ai-form').addEventListener('submit',event=>{event.preventDefault();run(async()=>{
    if(aiSubmitting||aiSessionChanging)return;if(!state.project)throw new Error('請先建立或開啟文檔專案。');
    const input=$('ai-input').value,message=input.trim();if(!message)return;
    const root=state.project.root,sessionId=aiSessionId,active=aiBusy()?state.aiJob:null,contextPaths=$('ai-context').checked&&state.file&&!state.file.binary?[state.file.path]:[];
    aiSubmitting=true;updateAiInput();
    try{
      if(!active)await saveAll();
      if(state.project?.root!==root||sessionId!==aiSessionId)throw new Error('專案或會話已切換；指令尚未發送，已保留輸入。');
      aiFollowingLatest=true;
      const result=await api(active?'ai.steer':'ai.send',active?{id:active.id,message,contextPaths}:{message,sessionId,skillId:$('ai-skill').value||undefined,contextPaths});
      if(state.project?.root!==root||sessionId!==aiSessionId)return;
      if(!active&&state.aiJob?.id!==result.jobId)state.aiJob={id:result.jobId,status:'queued',projectRoot:root};
      if($('ai-input').value===input)$('ai-input').value='';
      if(active)notice(state.aiJob?.steering?.find(s=>s.id===result.instructionId)?.status==='applied'?'追加指令已送入目前任務的後續推理。':'追加指令已接收；將在下一個執行邊界套用。',true);
      else await refreshAiSessions(root);
    }catch(error){
      if(error.code==='AI_NOT_RUNNING')throw new Error('原任務已結束；已保留輸入，請再發送以開始新任務。');
      if(error.code==='AI_JOB_CHANGED')throw new Error('目前 AI 任務已變更；已保留輸入，請確認後再發送。');
      throw error;
    }finally{aiSubmitting=false;updateAiInput();}
  });});
  $('ai-input').title='Enter 發送／追加指令；Shift+Enter 換行。';
  $('ai-input').addEventListener('keydown',event=>{
    if(event.key!=='Enter'||event.shiftKey||event.isComposing||event.keyCode===229)return;
    event.preventDefault();if(!$('ai-send').disabled)$('ai-form').requestSubmit();
  });
  $('ai-cancel').onclick=()=>run(()=>api('ai.cancel',{id:state.aiJob?.id}));
  $('ai-undo').onclick=()=>run(async()=>{const result=await api('ai.undo');await syncExternalChanges({project:await api('project.refresh'),paths:state.file?[state.file.path,'doconstruct.json']:['doconstruct.json']});await loadAiHistory();notice(`已撤回 ${result.restoredCount||0} 項 AI 修改；預覽未自動更新。`,true);});
  return {openNewProject,loadDirectory,refreshFileTree,openEntryDialog,openMedia,openBinaryInfo,syncExternalChanges,loadAiHistory,renderAiJob};
}
