// Official Playwright Electron driver; the actual packaged app and business IPC stay unchanged.
const { _electron }=require('playwright-core');
const fs=require('node:fs/promises'),sync=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve('.'),run=process.env.DOCONSTRUCT_PACKAGED_RUN||'r01';
const stage=path.join(root,'build/packaged-acceptance',run),relocated=path.join(stage,'獨立 分發','DOConstruct');
const sourceProject=path.join(root,'build/paper-acceptance/source-copy'),pdfPath=path.join(stage,'paper-layout.pdf');
const checks=[],jobs=[];let application,page;
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function check(value,message){if(!value)throw Error(message);checks.push(message);}
async function call(method,args={}){const result=await page.evaluate(([m,a])=>window.doconstruct.invoke(m,a),[method,args]);if(!result.ok)throw Error(method+': '+JSON.stringify(result.error));return result;}
async function waitJob(id){const limit=Date.now()+180000;for(;;){const j=await call('build.inspect',{id});if(['completed','failed','canceled','superseded'].includes(j.status)){check(j.status==='completed','Actual task '+j.stage+' completed');jobs.push(j);return j;}if(Date.now()>limit)throw Error('Task timeout: '+id);await page.waitForTimeout(100);}}
async function waitUiComplete(){await page.waitForFunction(()=>document.getElementById('job-state').textContent.startsWith('完成'),null,{timeout:180000});}
async function main(){
 await fs.mkdir(stage,{recursive:true});const barrier=JSON.parse(await fs.readFile(path.resolve(root,process.env.DOCONSTRUCT_PACKAGE_READY||'build/packaging/FINAL-DIR.ready'),'utf8'));
 check(barrier.ok,'Final package ready barrier is closed');
 if(sync.existsSync(relocated))throw Error('Use a fresh DOCONSTRUCT_PACKAGED_RUN to preserve earlier distribution evidence.');
 await fs.cp(path.dirname(barrier.app),relocated,{recursive:true});
 check(sha(await fs.readFile(path.join(relocated,'resources/app.asar')))===barrier.asar_sha256.toLowerCase(),'Relocated app.asar is the final approved package');
 const env={...process.env,PATH:`${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`};
 for(const k of Object.keys(env))if(/^DOCONSTRUCT_|^PYTHON|^NODE_PATH$|^ELECTRON_OVERRIDE_DIST_PATH$|^ELECTRON_RUN_AS_NODE$/.test(k))delete env[k];
 const executablePath=path.join(relocated,'DOConstruct.exe');
 application=await _electron.launch({executablePath,args:['--user-data-dir='+path.join(stage,'profile')],cwd:relocated,env,timeout:60000});
 application.process().stdout?.on('data',x=>sync.appendFileSync(path.join(stage,'app.out.log'),x));
 application.process().stderr?.on('data',x=>sync.appendFileSync(path.join(stage,'app.err.log'),x));
 page=await application.firstWindow({timeout:60000});await page.waitForSelector('.cm-editor');
 await page.evaluate(()=>{window.__packagedEvents=[];window.doconstruct.onEvent(e=>window.__packagedEvents.push(e));});
 const info=await call('app.info');check(info.packaged===true,'Running the real packaged app, not the source Electron harness');
 check(info.version===JSON.parse(await fs.readFile(path.join(root,'package.json'),'utf8')).version,'Packaged application reports its own version');
 const skills=await call('ai.skills');check(skills.skills.some(s=>s.id==='paper-and-patent-writing'),'Actual package carries its writing skill');
 const runtime=await call('dependencies.inspect');await fs.writeFile(path.join(stage,'DEPENDENCIES.json'),JSON.stringify(runtime,null,2));
 check(runtime.items.filter(x=>['Pandoc','Python'].includes(x.name)).length===2,'Dependency panel includes both layout executables');
 check(runtime.items.filter(x=>['Pandoc','Python'].includes(x.name)).every(x=>x.available&&x.source==='bundled'&&x.path.startsWith(relocated)),'Both layout executables are bundled under the relocated Unicode/space directory');
 check(runtime.items.filter(x=>['DOConstruct / Electron','Chromium / PDF','CodeMirror'].includes(x.name)).every(x=>x.available&&x.source==='bundled'),'Editor and Chromium/PDF engine are bundled');
 await fs.writeFile(path.join(stage,'ENVIRONMENT.json'),JSON.stringify({executablePath,PATH:env.PATH,cleared:Object.keys(process.env).filter(k=>/^DOCONSTRUCT_|^PYTHON|^NODE_PATH$|^ELECTRON_OVERRIDE_DIST_PATH$/.test(k)),physicalMachinesTested:1},null,2));
 const opened=await call('project.open',{path:sourceProject});
 await page.waitForFunction(p=>document.getElementById('project-location').textContent===p,sourceProject);
 await page.locator('#build').click();
 await page.waitForFunction(()=>window.__packagedEvents.some(e=>e.type==='job'&&['completed','failed'].includes(e.job.status)),null,{timeout:180000});
 const completed=await page.evaluate(()=>window.__packagedEvents.filter(e=>e.type==='job'&&['completed','failed'].includes(e.job.status)).at(-1).job);
 const built=await waitJob(completed.id);await waitUiComplete();
 const html=await fs.readFile(built.htmlPath,'utf8');
 check((html.match(/<img\b/gi)||[]).length===49,'Real current manuscript contains all 49 figures');
 check(html.includes('<math')&&html.includes('<table'),'Paper preview retains native MathML and tables');
 check(html.includes('Cambria')&&html.includes('--body-size:11pt'),'Saved font changes appear in the actual paper HTML');
 check(html.replace(/\s+/g,' ').includes('DOConstruct acceptance copy: this sentence verifies a changed chapter.'),'Saved chapter modification appears in actual paper output');
 const iframe=page.frameLocator('#preview');
 await page.waitForFunction(()=>!document.getElementById('preview').hidden);
 const contentFrame=page.frames().find(f=>f.url().includes('preview.html'));if(!contentFrame)throw Error('No actual HTML preview frame');
 const figures=await contentFrame.evaluate(async()=>{await document.fonts.ready;await Promise.all(Array.from(document.images,image=>image.complete?Promise.resolve():new Promise(r=>{image.onload=r;image.onerror=r;})));return Array.from(document.images).map(image=>({src:image.getAttribute('src'),loaded:!!image.naturalWidth,width:image.naturalWidth,height:image.naturalHeight}));});
 check(figures.length===49&&figures.every(x=>x.loaded),'All 49 real manuscript figures are decoded in the desktop preview');
 await fs.writeFile(path.join(stage,'FIGURES.json'),JSON.stringify(figures,null,2));
 await page.screenshot({path:path.join(stage,'paper-abstract.png')});
 await contentFrame.evaluate(()=>{const h=Array.from(document.querySelectorAll('h1,h2,h3')).find(x=>x.textContent.includes('J27:'));h?.scrollIntoView({block:'start'});});
 await page.screenshot({path:path.join(stage,'paper-case.png')});
 await application.evaluate(({dialog},destination)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:destination});return true;},pdfPath);
 const before=await page.evaluate(()=>[...new Set(window.__packagedEvents.filter(e=>e.type==='job').map(e=>e.job.id))]);
 await page.locator('#export-pdf').click();
 await page.waitForFunction(()=>window.__packagedEvents.some(e=>e.type==='job'&&e.job.stage==='pdf'&&['completed','failed'].includes(e.job.status)),null,{timeout:180000});
 const pdfEvent=await page.evaluate(()=>window.__packagedEvents.filter(e=>e.type==='job'&&e.job.stage==='pdf'&&['completed','failed'].includes(e.job.status)).at(-1).job);
 const pdfJob=await waitJob(pdfEvent.id);check((await fs.readFile(pdfPath)).subarray(0,5).toString()==='%PDF-','Actual packaged Chromium produced the real manuscript PDF');
 await page.waitForFunction(()=>document.getElementById('pdf-tab').classList.contains('selected'));
 const after=await page.evaluate(()=>[...new Set(window.__packagedEvents.filter(e=>e.type==='job').map(e=>e.job.id))]);
 check(after.filter(id=>!before.includes(id)&&id!==pdfJob.id).length===0,'PDF export reuses the current successful HTML without rerunning the layout script');
 await page.waitForFunction(()=>document.getElementById('preview').src.endsWith('.pdf'));
 await page.waitForTimeout(1600);await page.screenshot({path:path.join(stage,'paper-pdf.png')});
 await page.locator('#dependencies').click();await page.waitForFunction(()=>document.getElementById('dependency-list').textContent.includes('Pandoc'));
 await page.screenshot({path:path.join(stage,'bundled-dependencies.png')});await page.locator('#dependency-dialog [data-close-dialog]').click();
 const metadata={ok:true,checks,info,relocated,project:sourceProject,pdfPath,pdfBytes:(await fs.stat(pdfPath)).size,jobs:jobs.map(j=>({id:j.id,stage:j.stage,stats:j.stats,htmlPath:j.htmlPath,pdfPath:j.pdfPath})),screenshots:['paper-abstract.png','paper-case.png','paper-pdf.png','bundled-dependencies.png'].map(n=>path.join(stage,n)),scope:'One Windows host; relocated official package launched with a system-only PATH and no configured layout executable environment.'};
 await fs.writeFile(path.join(stage,'CLOSED.json'),JSON.stringify(metadata,null,2));console.log('PACKAGED PAPER PASS',checks.length);await application.close();
}
main().catch(async error=>{await fs.mkdir(stage,{recursive:true});let context=null;try{context=await page?.evaluate(()=>({notice:document.getElementById('notice-text')?.textContent,events:window.__packagedEvents}));await page?.screenshot({path:path.join(stage,'failure.png')});}catch{}await fs.writeFile(path.join(stage,'CLOSED.json'),JSON.stringify({ok:false,error:error.stack,checks,context},null,2));console.error(error);try{await application?.close();}catch{}process.exitCode=1;});
