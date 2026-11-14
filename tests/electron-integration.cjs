// Actual desktop integration. Only native path-selection dialogs are predetermined.
const {app,BrowserWindow,dialog}=require('electron');
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path');
const run=process.env.DOCONSTRUCT_TEST_RUN||'r01';
const stage=path.resolve('build/electron-integration',run),projectRoot=path.resolve('build/integration-project-'+run);
fs.mkdirSync(stage,{recursive:true});
if(fs.existsSync(projectRoot)&&fs.readdirSync(projectRoot).length)throw Error('Preserve previous project; choose a new DOCONSTRUCT_TEST_RUN.');
fs.mkdirSync(projectRoot,{recursive:true});app.setPath('userData',path.join(stage,'profile'));
const pdfPath=path.join(projectRoot,'export','proof.pdf'),checks=[],jobs=[];
let main,started=false,unexpectedConfirmation=0,hideInitially;
dialog.showOpenDialog=async()=>({canceled:false,filePaths:[projectRoot]});
dialog.showSaveDialog=async()=>({canceled:false,filePath:pdfPath});
dialog.showMessageBox=async(_w,options)=>{unexpectedConfirmation++;fs.appendFileSync(path.join(stage,'native-confirm.log'),JSON.stringify(options)+'\n');return{response:1};};
dialog.showMessageBoxSync=(_w,options)=>{unexpectedConfirmation++;fs.appendFileSync(path.join(stage,'native-confirm.log'),JSON.stringify(options)+'\n');return 1;};
dialog.showErrorBox=(title,text)=>{fs.writeFileSync(path.join(stage,'STARTUP_ERROR.txt'),title+'\n'+text);console.error(title,text);app.exit(2);};
function assert(value,message){if(!value)throw Error(message);checks.push(message);}
async function js(code){return main.webContents.executeJavaScript(code,true);}
async function api(method,args={}){const r=await js(`window.doconstruct.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`);if(!r.ok)throw Error(method+': '+JSON.stringify(r.error));return r;}
async function wait(condition,label,timeout=30000){const start=Date.now();while(Date.now()-start<timeout){const value=await condition();if(value)return value;await new Promise(r=>setTimeout(r,60));}throw Error('Timeout: '+label);}
const waitDom=(code,label)=>wait(()=>js(code),label);
async function click(id){await js(`document.getElementById(${JSON.stringify(id)}).click()`);}
async function currentJobIds(){return js("[...new Set(window.__acceptEvents.filter(x=>x.type==='job').map(x=>x.job.id))]");}
async function newTerminal(before,predicate){
 return wait(async()=>{
  const events=await js("window.__acceptEvents.filter(x=>x.type==='job').map(x=>x.job)");
  for(const job of events){if(before.includes(job.id)||!['completed','failed','canceled','superseded'].includes(job.status)||predicate&&!predicate(job))continue;
   if(job.status!=='completed')throw Error('Actual job failed: '+JSON.stringify(job));jobs.push(job);return job;}
  const message=await js("document.getElementById('notice-text').textContent");
  if(message.includes('Error:'))throw Error(message);
 },'new terminal production job',60000);
}
async function editText(text){
 await js(`(()=>{const el=document.querySelector('.cm-content');el.focus();const range=document.createRange();range.selectNodeContents(el);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.execCommand('insertText',false,${JSON.stringify(text)});})()`);
 await waitDom("!document.getElementById('dirty-dot').hidden",'editor dirty');
}
async function screenshot(name){await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');await fsp.writeFile(path.join(stage,name),await main.webContents.capturePage().then(x=>x.toPNG()));}
async function exercise(){
 try{
  await waitDom("!!window.doconstruct&&!!document.querySelector('.cm-editor')",'actual preload/renderer ready');
  await js("window.__acceptEvents=[];window.doconstruct.onEvent(e=>window.__acceptEvents.push(e));true");
  const deps=await api('dependencies.inspect');fs.writeFileSync(path.join(stage,'DEPENDENCIES.json'),JSON.stringify(deps,null,2));
  assert(deps.items.filter(x=>['Pandoc','Python'].includes(x.name)).every(x=>x.available&&x.source==='bundled'),'Core Pandoc/Python are available from bundled resources');
  await click('new-project');
  await waitDom(`document.getElementById('project-location').textContent===${JSON.stringify(projectRoot)}&&document.getElementById('active-file').textContent.endsWith('.md')`,'real starter project and source loaded');
  const project=await api('project.get'),first=project.config.sections.find(x=>x.enabled!==false).path;
  assert(fs.existsSync(path.join(projectRoot,'doconstruct.json')),'New Project creates a real independent document folder');
  let before=await currentJobIds();await click('build');let job=await newTerminal(before);
  await waitDom("!document.getElementById('preview').hidden",'actual HTML in embedded preview');
  assert(job.stats.renderedSections===project.config.sections.length,'Initial production build converts all starter sections');
  const firstSource=await api('file.read',{path:first});
  await editText(firstSource.content+'\n\nIncremental desktop acceptance marker.\n');
  before=await currentJobIds();await click('save');
  await waitDom("document.getElementById('dirty-dot').hidden",'Markdown save completed');
  await new Promise(r=>setTimeout(r,200));
  assert((await currentJobIds()).length===before.length,'Typing and saving do not run the assembly or layout script');
  assert((await fsp.readFile(path.join(projectRoot,first),'utf8')).includes('Incremental desktop acceptance marker.'),'Editor Save writes actual Markdown source');
  before=await currentJobIds();await click('build');job=await newTerminal(before);
  assert(job.stats.renderedSections===1&&job.stats.cachedSections===project.config.sections.length-1,'Explicit Update Preview converts only the changed section');
  await click('toggle-style');
  before=await currentJobIds();await js("document.querySelector('#style-form [name=fontSizePt]').value='14';document.getElementById('style-form').requestSubmit()");job=await newTerminal(before);
  const changed=JSON.parse(await fsp.readFile(path.join(projectRoot,'doconstruct.json'),'utf8'));
  assert(changed.style.fontSizePt===14,'Font control persists the real layout setting');
  assert(job.stats.renderedSections===0&&job.stats.cachedSections===project.config.sections.length,'Style-only change reuses all source conversions');
  assert((await fsp.readFile(job.htmlPath,'utf8')).includes('14pt'),'Real HTML contains the requested body font size');
  await click('close-style');await click('open-layout');
  await waitDom("document.getElementById('language-label').textContent==='PYTHON'",'real project layout script');
  await waitDom("new Set([...document.querySelectorAll('.cm-content span')].map(x=>getComputedStyle(x).color)).size>=3",'actual Python syntax colors');
  assert(true,'Layout script is editable in real multicolor CodeMirror');
  const source=await api('file.read',{path:changed.layoutScript});
  const updated=source.content.replace('<main class="document">','<aside id="integration-layout">CUSTOM LAYOUT IS ACTIVE</aside><main class="document">');
  assert(updated!==source.content,'Default editable script has a layout insertion point');
  await editText(updated);await click('save');
  await waitDom("document.getElementById('dirty-dot').hidden",'script saved');
  before=await currentJobIds();await click('build');job=await newTerminal(before);
  assert((await fsp.readFile(job.htmlPath,'utf8')).includes('CUSTOM LAYOUT IS ACTIVE'),'Editing the Python layout script changes actual rendered HTML');
  assert(job.stats.renderedSections===0,'Layout script edit reuses parsed content');
  await waitDom("document.getElementById('job-state').textContent.startsWith('完成')",'completed script render UI');
  await screenshot('layout-script-and-html.png');
  before=await currentJobIds();await click('export-pdf');const pdfJob=await newTerminal(before,x=>x.stage==='pdf'||x.pdfPath);
  await waitDom("!document.getElementById('pdf-tab').disabled&&document.getElementById('pdf-tab').classList.contains('selected')",'actual PDF tab selected');
  const pdf=await fsp.readFile(pdfPath);assert(pdf.subarray(0,5).toString()==='%PDF-'&&pdf.length>5000,'Production Chromium exports a real PDF');
  assert(await js("!document.getElementById('preview').hasAttribute('sandbox')"),'Owned generated PDF enables the built-in PDF viewer');
  assert((await currentJobIds()).filter(id=>!before.includes(id)&&id!==pdfJob.id).length===0,'PDF export reuses successful current HTML without rerunning layout');
  await wait(async()=>main.webContents.mainFrame.framesInSubtree.some(f=>f.url.startsWith('chrome-extension://')),'Chromium PDF viewer frame',20000);
  const frames=main.webContents.mainFrame.framesInSubtree.map(f=>({url:f.url,name:f.name}));
  assert(frames.some(f=>f.url.startsWith('chrome-extension://')),'The embedded frame contains Chromium actual PDF viewer');
  fs.writeFileSync(path.join(stage,'PDF_FRAMES.json'),JSON.stringify(frames,null,2));
  const pdfFrame=main.webContents.mainFrame.framesInSubtree.find(f=>f.url.startsWith('chrome-extension://'));
  await wait(()=>pdfFrame.executeJavaScript("document.readyState==='complete'&&!!document.querySelector('pdf-viewer')"),'PDF viewer DOM ready',20000);
  const pdfDetails=await pdfFrame.executeJavaScript("({body:document.body.innerHTML.slice(0,5000),shadow:document.querySelector('pdf-viewer')?.shadowRoot?.innerHTML.slice(-12000)})");
  fs.writeFileSync(path.join(stage,'PDF_DOM.json'),JSON.stringify(pdfDetails,null,2));
  main.removeListener('show',hideInitially);main.showInactive();
  await wait(async()=>{
    const rect=await js("(()=>{const r=document.getElementById('preview').getBoundingClientRect();return{x:Math.ceil(r.x+5),y:Math.ceil(r.y+5),width:Math.floor(r.width-10),height:Math.floor(r.height-10)}})()");
    const pixels=(await main.webContents.capturePage(rect)).toBitmap();let dark=0,total=0;
    for(let i=0;i<pixels.length;i+=148){total++;if(pixels[i]+pixels[i+1]+pixels[i+2]<650)dark++;}
    return total>0&&dark/total>0.10;
  },'PDF compositor replaces its blank initial frame',15000);
  assert(true,'Actual embedded PDF pixels are painted beyond the initial blank frame');
  await screenshot('pdf-preview.png');
  assert(unexpectedConfirmation===0,'No unexpected unsaved-content/native confirmation was bypassed');
  const result={ok:true,checks,projectRoot,pdfPath,pdfBytes:pdf.length,jobs:jobs.map(j=>({id:j.id,stage:j.stage,status:j.status,stats:j.stats,htmlPath:j.htmlPath,pdfPath:j.pdfPath})),screenshots:[path.join(stage,'layout-script-and-html.png'),path.join(stage,'pdf-preview.png')]};
  fs.writeFileSync(path.join(stage,'CLOSED.json'),JSON.stringify(result,null,2));console.log('REAL ELECTRON INTEGRATION PASS',checks.length);await api('app.dirty',{dirty:false});app.quit();
 }catch(error){
  const context=await js("({notice:document.getElementById('notice-text').textContent,status:document.getElementById('job-state').textContent,events:window.__acceptEvents||[]})").catch(()=>null);
  fs.writeFileSync(path.join(stage,'CLOSED.json'),JSON.stringify({ok:false,error:error.stack,checks,projectRoot,context},null,2));console.error(error);
  if(main&&!main.isDestroyed())await screenshot('failure.png').catch(()=>{});app.exit(1);
 }
}
app.on('browser-window-created',(_event,w)=>{
 if(started)return;started=true;main=w;w.webContents.setBackgroundThrottling(false);hideInitially=()=>w.hide();w.on('show',hideInitially);
 w.webContents.on('console-message',(_e,...args)=>fs.appendFileSync(path.join(stage,'renderer-console.log'),args.join(' ')+'\n'));
 w.webContents.once('did-finish-load',()=>setTimeout(exercise,150));
});
require('../src/main.cjs');
