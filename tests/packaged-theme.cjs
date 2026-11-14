// Final theme-only acceptance of the rebuilt package using official Playwright Electron.
const {_electron}=require('playwright-core');
const fs=require('node:fs/promises'),path=require('node:path');
const root=path.resolve('.'),stage=path.join(root,'build/packaged-theme',process.env.DOCONSTRUCT_THEME_RUN||'r01');
let application;
async function main(){
 await fs.mkdir(stage,{recursive:true});
 const barrier=JSON.parse(await fs.readFile(path.join(root,'build/packaging/FINAL-NEUTRAL.ready'),'utf8'));
 const env={...process.env,PATH:`${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`};
 for(const key of Object.keys(env))if(/^DOCONSTRUCT_|^PYTHON|^NODE_PATH$|^ELECTRON_OVERRIDE_DIST_PATH$|^ELECTRON_RUN_AS_NODE$/.test(key))delete env[key];
 application=await _electron.launch({executablePath:barrier.app||path.join(root,'dist/win-unpacked/DOConstruct.exe'),args:['--user-data-dir='+path.join(stage,'profile')],env,timeout:60000});
 const page=await application.firstWindow();await page.waitForSelector('.cm-editor');
 const call=(method,args={})=>page.evaluate(([m,a])=>window.doconstruct.invoke(m,a),[method,args]);
 const info=await call('app.info');if(!info.packaged)throw Error('Not packaged');
 await call('project.open',{path:path.join(root,'build/paper-acceptance/source-copy')});
 await page.waitForFunction(()=>!document.getElementById('build').disabled);
 await page.locator('#build').click();
 await page.waitForFunction(()=>document.getElementById('job-state').textContent.startsWith('完成'),null,{timeout:60000});
 await page.locator('#open-layout').click();
 await page.waitForFunction(()=>document.getElementById('active-file').textContent==='layout.py');
 const palette=await page.evaluate(()=>Object.fromEntries(['body','.titlebar','.sidebar','.cm-editor','.cm-gutters','.build-bar'].map(selector=>[selector,getComputedStyle(document.querySelector(selector)).backgroundColor])));
 for(const [selector,color]of Object.entries(palette)){const c=color.match(/\d+/g).slice(0,3).map(Number);if(c.some(x=>x!==c[0]))throw Error('Non-neutral '+selector+': '+color);}
 const frame=page.frames().find(f=>f.url().includes('preview.html'));if(!frame)throw Error('Missing preview');
 await frame.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));document.querySelector('img').scrollIntoView({block:'center'});});
 await page.screenshot({path:path.join(stage,'paper-figure-and-script.png')});
 await frame.evaluate(()=>document.querySelector('math').closest('p,div')?.scrollIntoView({block:'center'}));
 await page.screenshot({path:path.join(stage,'paper-math-and-script.png')});
 await fs.writeFile(path.join(stage,'CLOSED.json'),JSON.stringify({ok:true,info,executable:barrier.app||path.join(root,'dist/win-unpacked/DOConstruct.exe'),asar_sha256:barrier.asar_sha256||barrier.app_asar_sha256,palette,screenshots:['paper-figure-and-script.png','paper-math-and-script.png'],scope:'Theme-only screenshot check; functional package verification remains build/packaged-acceptance/r02'},null,2));
 console.log('FINAL PACKAGED THEME PASS');await application.close();
}
main().catch(async e=>{await fs.mkdir(stage,{recursive:true});await fs.writeFile(path.join(stage,'CLOSED.json'),JSON.stringify({ok:false,error:e.stack},null,2));console.error(e);try{await application?.close();}catch{}process.exitCode=1;});


