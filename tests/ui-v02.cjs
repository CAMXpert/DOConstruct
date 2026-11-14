// Real Electron UI + production IPC/backend; only native folder choice and the model HTTP endpoint are predetermined.
const {app,BrowserWindow,dialog}=require('electron');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),http=require('node:http');
const id=process.env.DOCONSTRUCT_UI_RUN||String(Date.now()),stage=path.resolve('build/ui-v02',id),project=path.join(stage,'測試 專案');
fs.mkdirSync(project,{recursive:true});app.setPath('userData',path.join(stage,'profile'));
let main,server,modelRequests=0;const checks=[],events=[];
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[project]});
dialog.showMessageBoxSync=()=>1;dialog.showMessageBox=async()=>({response:1});
dialog.showErrorBox=(title,text)=>{console.error(title,text);app.exit(2);};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function assert(v,label){if(!v)throw Error(label);checks.push(label);}
async function js(s){return main.webContents.executeJavaScript(s,true);}
async function api(m,a={}){const r=await js(`window.doconstruct.invoke(${JSON.stringify(m)},${JSON.stringify(a)})`);if(!r.ok)throw Error(m+':'+JSON.stringify(r.error));return r;}
async function until(code,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await js(code))return;await sleep(40);}throw Error('Timeout '+label);}
const click=id=>js(`document.getElementById(${JSON.stringify(id)}).click()`);
async function edit(text){await js(`(()=>{let el=document.querySelector('.cm-content');el.focus();let r=document.createRange();r.selectNodeContents(el);let s=getSelection();s.removeAllRanges();s.addRange(r);document.execCommand('insertText',false,${JSON.stringify(text)});})()`);}
async function field(form,name,value){await js(`document.getElementById(${JSON.stringify(form)}).elements[${JSON.stringify(name)}].value=${JSON.stringify(value)}`);}
async function submit(id){await js(`document.getElementById(${JSON.stringify(id)}).requestSubmit()`);}
async function screenshot(name){await fsp.writeFile(path.join(stage,name),(await main.webContents.capturePage()).toPNG());}
async function exercise(){try{
 await until("!!window.doconstruct&&!!document.querySelector('.cm-editor')",'renderer');
 await js("window.__events=[];window.doconstruct.onEvent(e=>window.__events.push(e));true");
 await click('new-project');await field('new-form','title','從骨架開始');await field('new-form','kind','blank');await submit('new-form');
 await until(`document.getElementById('project-location').textContent===${JSON.stringify(project)}`,'blank project');
 assert((await api('project.get')).config.sections.length===0,'Wizard creates a genuinely empty skeleton without a finished article');
 await click('add-section');await field('section-form','title','研究動機');await field('section-form','path','content/motivation.md');await submit('section-form');
 await until("document.getElementById('active-file').textContent==='content/motivation.md'",'first section file');
 assert(fs.existsSync(path.join(project,'content/motivation.md')),'Adding a section creates its real source immediately');
 await fsp.writeFile(path.join(project,'notes.md'),'# 既有內容，不能被新骨架覆寫\n');await click('add-section');await field('section-form','title','既有內容');await field('section-form','path','notes.md');await submit('section-form');await until("document.getElementById('active-file').textContent==='notes.md'",'existing source section');assert((await fsp.readFile(path.join(project,'notes.md'),'utf8')).includes('不能被新骨架覆寫'),'Adding an existing file to the skeleton preserves its content');await js("document.querySelector('#outline-list .file-button').click()");await until("document.getElementById('active-file').textContent==='content/motivation.md'",'back to first');
 await edit('# 研究動機\n\n'+('這是很長但應當自動換行的段落。'.repeat(80)));await click('save');await until("document.getElementById('dirty-dot').hidden",'save');
 assert(await js("document.querySelector('.cm-content').classList.contains('cm-lineWrapping')"),'Long Markdown paragraphs soft-wrap by default');
 assert(await js("document.querySelector('.cm-scroller').scrollWidth<=document.querySelector('.cm-scroller').clientWidth+3"),'Long Markdown needs no horizontal editor scrolling');
 const jobs=await js("window.__events.filter(e=>e.type==='job').length");
 await fsp.writeFile(path.join(project,'content/motivation.md'),'# 外部修改\n\nExternal update is automatically visible.\n');
 await until("document.querySelector('.cm-content').textContent.includes('External update')",'external refresh');
 assert(await js("window.__events.filter(e=>e.type==='job').length")===jobs,'External changes refresh the editor without running layout');
 await edit('# 尚未保存的本機內容\n');await fsp.writeFile(path.join(project,'content/motivation.md'),'# AI or external change\n');
 await until("!document.getElementById('external-conflict').hidden",'dirty conflict');
 assert(await js("document.querySelector('.cm-content').textContent.includes('尚未保存')"),'External changes do not overwrite dirty edits');
 await click('reload-external');await until("document.querySelector('.cm-content').textContent.includes('AI or external change')",'reload explicit');
 let width=await js("document.querySelector('.sidebar').offsetWidth");await js("document.getElementById('sidebar-splitter').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
 assert(await js("document.querySelector('.sidebar').offsetWidth")>width,'Sidebar separator resizes by keyboard');
 assert(await js("!!localStorage.getItem('doconstruct.sidebar-width')"),'Panel size persists locally');
 await click('toggle-log');let height=await js("document.getElementById('log-panel').offsetHeight");await js("document.getElementById('log-splitter').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))");assert(await js("document.getElementById('log-panel').offsetHeight")>height,'Log panel height is resizable');await click('toggle-log');
 await click('toggle-layout');await click('layout-edit-script');await until("document.getElementById('active-file').textContent==='layout.py'",'layout shortcut');
 assert(await js("document.getElementById('language-label').textContent==='PYTHON'"),'Layout workspace opens the actual colored Python source');
 await click('files-tab');await click('new-folder');await field('entry-form','path','figures');await submit('entry-form');await until("!!document.querySelector('.file-row[data-path=figures]')",'folder tree');
 await fsp.writeFile(path.join(project,'figures/test.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="100" height="70"><rect width="100" height="70" fill="gray"/></svg>');
 await js("document.querySelector('.file-row[data-path=figures] .file-name').click()");await until("!!document.querySelector('.file-row[data-path=\"figures/test.svg\"]')",'lazy image');
 await js("document.querySelector('.file-row[data-path=\"figures/test.svg\"] .file-name').click()");await until("!!document.querySelector('.media-view img')&&document.querySelector('.media-view img').naturalWidth===100",'image viewer');
 assert(true,'Lazy file tree includes actual image files and displays them safely');
 await js("document.querySelector('.file-row[data-path=content] .file-name').click()");await until("!!document.querySelector('.file-row[data-path=\"content/motivation.md\"]')",'content tree');await js("document.querySelector('.file-row[data-path=\"content/motivation.md\"] .file-name').click()");await until("document.getElementById('active-file').textContent==='content/motivation.md'",'current text before AI');
 await click('toggle-ai');await until("document.getElementById('ai-skill').options.length>1",'bundled skill');
 assert(true,'Bundled writing skill is selectable in the assistant');
 server=http.createServer(async(req,res)=>{try{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);fs.appendFileSync(path.join(stage,'model-requests.jsonl'),JSON.stringify({...body,messages:body.messages.map(m=>({...m,content:typeof m.content==='string'?m.content.slice(0,100):m.content}))})+'\n');modelRequests++;let message;
 const call=(name,args)=>({id:'call-'+modelRequests,type:'function',function:{name,arguments:JSON.stringify(args)}});
 if(modelRequests===1)message={role:'assistant',content:null,tool_calls:[call('read_file',{path:'content/motivation.md'})]};
 else if(modelRequests===2)message={role:'assistant',content:null,tool_calls:[call('write_file',{path:'content/motivation.md',content:'# AI 已修改\n\nReal harness update from a local test model.\n'})]};
 else if(modelRequests===3)message={role:'assistant',content:null,tool_calls:[call('validate_project',{})]};
 else message={role:'assistant',content:'已讀取、修改並檢查文件。預覽等待你按更新。'};
 res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));
 }catch(e){res.writeHead(500);res.end(JSON.stringify({error:{message:e.message}}));}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await click('ai-settings-button');await field('ai-settings-form','baseUrl','http://127.0.0.1:'+server.address().port+'/v1');await field('ai-settings-form','model','mock-tool-model');await field('ai-settings-form','apiKey','not-a-real-test-key');await submit('ai-settings-form');await until("!document.getElementById('ai-settings-dialog').open",'saved API');
 const settings=await api('ai.settings');assert(settings.settings.hasApiKey&&!JSON.stringify(settings).includes('not-a-real-test-key'),'API Key is stored without returning its plaintext');
 await js("document.getElementById('ai-skill').value='paper-and-patent-writing';document.getElementById('ai-input').value='請修改研究動機並檢查。';document.getElementById('ai-context').checked=false");
 await submit('ai-form');await until("document.getElementById('ai-status').textContent==='完成'",'AI harness',30000);
 assert((await fsp.readFile(path.join(project,'content/motivation.md'),'utf8')).includes('Real harness update'),'Chat drives real read/write/validation tool calls through production harness');
 assert(modelRequests===4,'Actual model loop feeds tool results back until a final answer');
 assert(await js("window.__events.filter(e=>e.type==='job').length")===jobs,'AI document edits do not trigger preview builds');
 await until("document.querySelector('.cm-content').textContent.includes('Real harness update')",'automatic AI contents');assert(true,'AI updates the clean active editor without manual refresh');
 const wide=main.getBounds();main.setBounds({...wide,width:1060});await sleep(100);assert(await js("document.getElementById('ai-panel').getBoundingClientRect().right<=innerWidth+1"),'AI and resizable docks stay inside a narrow window');main.setBounds(wide);await sleep(80);
 await screenshot('ai-workbench.png');await click('build');await until("!document.getElementById('preview').hidden&&!!document.getElementById('preview').getAttribute('src')&&document.getElementById('job-state').textContent.startsWith('完成')",'manual build',30000);assert(await js("!!document.getElementById('preview').getAttribute('src')"),'Manual Update Preview still produces the real HTML');
 await screenshot('completed-preview.png');await click('ai-settings-button');await field('ai-settings-form','apiMode','responses');await submit('ai-settings-form');await until("!document.getElementById('ai-settings-dialog').open",'Responses setting');assert((await api('ai.settings')).settings.apiMode==='responses','API protocol choice is saved through the real settings API');await click('ai-settings-button');await field('ai-settings-form','apiMode','chat-completions');await submit('ai-settings-form');await until("!document.getElementById('ai-settings-dialog').open",'restore Chat setting');const persistedWidth=await js("document.querySelector('.sidebar').offsetWidth");main.reload();await until("!!document.querySelector('.cm-editor')&&document.getElementById('project-location').textContent.includes('測試 專案')",'window reload');assert(Math.abs((await js("document.querySelector('.sidebar').offsetWidth"))-persistedWidth)<2,'Dock size survives reloading the application window');await fsp.writeFile(path.join(stage,'CLOSED.json'),JSON.stringify({ok:true,checks,project,modelRequests},null,2));console.log('UI V02 PASS',checks.length);server.close();await api('app.dirty',{dirty:false});app.quit();
 }catch(error){await screenshot('failure.png').catch(()=>{});const context=await js("({notice:document.getElementById('notice-text').textContent,status:document.getElementById('ai-status').textContent,events:window.__events})").catch(()=>null);await fsp.writeFile(path.join(stage,'CLOSED.json'),JSON.stringify({ok:false,error:error.stack,checks,context},null,2));console.error(error);server?.close();app.exit(1);}}
app.on('browser-window-created',(_e,w)=>{if(main)return;main=w;w.webContents.setBackgroundThrottling(false);w.webContents.on('console-message',(_e,...args)=>fs.appendFileSync(path.join(stage,'console.log'),args.join(' ')+'\n'));w.webContents.once('did-finish-load',()=>setTimeout(exercise,150));});
require('../src/main.cjs');
