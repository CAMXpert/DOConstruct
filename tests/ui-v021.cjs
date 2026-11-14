// Source Electron entry explicitly loads production main; dedicated userData and local fake model only.
const { app, dialog, shell } = require('electron');
const openedUrls=[];shell.openExternal=async url=>{openedUrls.push(url);};
const fs = require('node:fs/promises'), path = require('node:path'), http = require('node:http');
const stage = path.resolve('build/ui-v021', process.env.DOCONSTRUCT_UI_RUN || String(Date.now()));
const project = path.join(stage, 'review-project');
require('node:fs').mkdirSync(project, { recursive: true });
app.setPath('userData', path.join(stage, 'profile'));
dialog.showMessageBoxSync = () => 1; dialog.showMessageBox = async () => ({ response: 1 });
dialog.showErrorBox = (title, text) => { console.error(title, text); app.exit(2); };
let main, server, release, requests = 0;
const checks = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => main.webContents.executeJavaScript(code, true);
async function api(method, args = {}) { const result = await js(`window.doconstruct.invoke(${JSON.stringify(method)},${JSON.stringify(args)})`); if (!result.ok) throw Error(method + ': ' + JSON.stringify(result.error)); return result; }
async function until(code, label) { const end = Date.now() + 15000; while (Date.now() < end) { if (await js(code)) return; await pause(30); } throw Error('Timeout: ' + label); }
function assert(value, label) { if (!value) throw Error(label); checks.push(label); }
const click = id => js(`document.getElementById(${JSON.stringify(id)}).click()`);
async function capture(name) { await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(60); await fs.writeFile(path.join(stage, name), (await main.webContents.capturePage()).toPNG()); }
const call = (name, args = {}, suffix = '') => ({ id: name + suffix, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const after = '# AI 修改\n\n這是 AI 真正寫入的內容。\n', created = '# 新章節\n\n新增來源內容。\n';
const codeAfter='const message = "normal syntax colors";\nconsole.log(message);\n';
const markdown = '# 修改完成\n\n**這是粗體回覆**，可查看文件差異。\n\n| 文件 | 動作 |\n|---|---|\n| notes.md | 修改 |\n| content/new.md | 新建 |\n\n- 已保存正文\n- 已更新骨架\n\n```python\nprint("hello <world>")\n```\n\n[參考](https://example.com)\n\n<script>globalThis.pwned=1</script>\n\n<img src=x onerror="globalThis.pwned=1">\n\n[危險](javascript:alert(1))\n\n![remote](https://example.com/tracker.png)';
async function exercise() { try {
  await until("!!window.doconstruct&&!!document.querySelector('.cm-editor')", 'production renderer');
  await js('window.__events=[];window.doconstruct.onEvent(e=>window.__events.push(e));true');
  await api('project.new', { path: project, options: { kind: 'blank', title: '修改可見性驗證' } });
  await until(`document.getElementById('project-location').textContent===${JSON.stringify(project)}`, 'project');
  await api('file.save', { path: 'notes.md', content: '# 修改前\n\n原始正文。\n', version: null });
  await api('directory.create', { path: 'resources' });
  for (const [file, content] of [['code.js','const x=1;'],['settings.json','{}'],['paper.pdf','PDF fixture'],['figure.svg','<svg xmlns="http://www.w3.org/2000/svg"/>'],['plain.txt','text']]) await api('file.save', { path: file, content, version: null });
  await click('files-tab'); await click('refresh-files');
  await until("document.querySelectorAll('.file-icon').length>=8", 'icons');
  const icons = await js(`Array.from(document.querySelectorAll('.file-icon')).map(e=>({label:e.getAttribute('aria-label'),kind:e.getAttribute('class'),color:getComputedStyle(e).color,title:e.querySelector('title')?.textContent}))`);
  for (const type of ['directory','markdown','image','python','javascript','css','json','pdf','file']) assert(icons.some(i => i.kind.includes('file-icon-' + type) && i.label && i.title), 'Accessible colored ' + type + ' file icon');
  assert(new Set(icons.map(i => i.color)).size >= 6, 'File types have distinct icon colors and glyphs');
  await click('toggle-ai');
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests++;
    let message;
    if (requests === 1) message = { role: 'assistant', content: '先檢查專案，接著修改正文與骨架。', reasoning_content: 'PRIVATE REASONING NEVER DISPLAY', tool_calls: [call('inspect_project'), call('read_file', { path: 'notes.md' }),call('read_file', { path:'code.js' },'-code'), ...Array.from({ length: 22 }, (_, i) => call('list_files', {}, i))] };
    else if (requests === 2) message = { role: 'assistant', content: null, tool_calls: [call('write_file', { path: 'notes.md', content: after }), call('write_file', { path: 'content/new.md', content: created }),call('write_file',{path:'code.js',content:codeAfter},'-code')] };
    else if (requests === 3) message = { role: 'assistant', content: null, tool_calls: [call('update_outline', { sections: [{ id: 'new', title: '新增章節', path: 'content/new.md' }] }), call('validate_project')] };
    else { assert(body.messages.some(m => m.reasoning_content === 'PRIVATE REASONING NEVER DISPLAY'), 'Provider reasoning retained privately for tool continuation'); await new Promise(resolve => { release = resolve; }); message = { role: 'assistant', content: markdown }; }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await api('ai.configure', { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: 'local-ui-verification' });
  await js("document.getElementById('ai-input').value='請修改正文、新建章節並更新骨架。';document.getElementById('ai-form').requestSubmit()");
  await until("window.__events.some(e=>e.type==='ai'&&e.job.changes?.length===4)", 'real writes');
  await until("document.querySelectorAll('.ai-tool-step').length===30", 'tool results');
  await js("document.getElementById('ai-execution').open=true");
  const wide = main.getBounds(); main.setBounds({ ...wide, width: 1060, height: 700 }); await pause(100);
  const geometry = await js(`(()=>{const m=document.getElementById('ai-messages'),t=document.getElementById('ai-tools'),p=document.getElementById('ai-panel');return {chat:m.clientHeight,tools:t.clientHeight,overflow:t.scrollHeight>t.clientHeight,panelRight:p.getBoundingClientRect().right,inputBottom:document.getElementById('ai-form').getBoundingClientRect().bottom,panelBottom:p.getBoundingClientRect().bottom};})()`);
  assert(geometry.chat >= 110 && geometry.tools <= 90 && geometry.overflow, 'Expanded execution history stays bounded and independently scrolls with chat height protected');
  assert(geometry.panelRight <= 1061 && geometry.inputBottom <= geometry.panelBottom + 1, 'Narrow 1060 by 700 window retains input and chat inside the AI panel: '+JSON.stringify(geometry));
  const messageScroll = await js("document.getElementById('ai-messages').scrollTop");
  await js("document.getElementById('ai-tools').scrollTop=1000");
  assert((await js("document.getElementById('ai-messages').scrollTop")) === messageScroll, 'Execution scrolling does not move chat');
  await capture('narrow-execution.png'); main.setBounds(wide); await pause(80); await capture('roles-and-execution.png');
  await click('ai-changes'); await until("document.getElementById('ai-change-view').textContent.includes('真正寫入')", 'live review');
  assert(await js("document.getElementById('ai-change-view').textContent.includes('原始正文')"), 'While task runs, comparison shows original and AI-written document');
  assert((await api('ai.changes')).tasks[0].status === 'running', 'Current task changes are reviewable before completion');
  await js("document.querySelector('#ai-change-files [data-path=\"content/new.md\"]').click()");
  await until("document.getElementById('ai-change-view').textContent.includes('新增來源內容')", 'new-file comparison');
  assert((await api('ai.changes',{id:(await api('ai.changes')).tasks[0].id,path:'content/new.md'})).before===null, 'Created files show absent preimage and complete new content');
  await js("document.querySelector('#ai-change-files [data-path=\"doconstruct.json\"]').click()");
  await until("document.getElementById('ai-change-view').textContent.includes('content/new.md')", 'outline comparison');
  const outlineDetail=await api('ai.changes',{id:(await api('ai.changes')).tasks[0].id,path:'doconstruct.json'});
  assert(JSON.parse(outlineDetail.before).sections.length===0&&JSON.parse(outlineDetail.after).sections[0].path==='content/new.md','Skeleton configuration shows exact before and after snapshots');
  await capture('live-file-changes.png');
  await js("document.querySelector('#ai-change-files [data-path=\"code.js\"]').click()");
  await until("document.getElementById('ai-change-view').textContent.includes('normal syntax colors')",'syntax diff');
  await capture('syntax-colored-diff.png');
  assert(await js("document.querySelectorAll('#ai-change-view .change-diff-added').length>0&&document.querySelectorAll('#ai-change-view .change-diff-removed').length>0&&document.querySelectorAll('#ai-change-view .cm-lineNumbers').length===2"),'Line diff marks actual added/deleted lines and retains original/new line numbers');
  const syntaxDiff=await js(`(()=>{const before=document.querySelector('#ai-change-view .change-diff-removed'),after=document.querySelector('#ai-change-view .change-diff-added');return {before:getComputedStyle(before).backgroundColor,after:getComputedStyle(after).backgroundColor,colors:[...new Set(Array.from(document.querySelectorAll('#ai-change-view .change-diff-added span')).map(e=>getComputedStyle(e).color))],plus:document.querySelector('.change-diff-added-marker')?.textContent,minus:document.querySelector('.change-diff-removed-marker')?.textContent,readOnly:Array.from(document.querySelectorAll('#ai-change-view .cm-content')).every(e=>e.contentEditable==='false')};})()`);
  assert(syntaxDiff.before!==syntaxDiff.after&&syntaxDiff.before.includes('248, 81, 73')&&syntaxDiff.after.includes('46, 160, 67')&&syntaxDiff.plus==='+'&&syntaxDiff.minus==='-','Deleted lines have red backgrounds and minus markers; added lines have green backgrounds and plus markers');
  assert(syntaxDiff.colors.length>=2&&syntaxDiff.readOnly,'Changed code retains normal language syntax colors inside a read-only diff');
  await click('ai-change-full');await until("document.getElementById('ai-change-full').getAttribute('aria-pressed')==='true'",'full comparison');
  assert(await js("document.getElementById('ai-change-view').textContent.includes('const x=1')&&document.getElementById('ai-change-view').textContent.includes('normal syntax colors')"),'Full before/after remains available with syntax highlighting');
  await js("document.getElementById('ai-changes-dialog').close()");
  release(); await until("document.getElementById('ai-status').textContent==='完成'", 'completion');
  assert(await js("!!document.querySelector('.ai-markdown h1')&&!!document.querySelector('.ai-markdown strong')&&!!document.querySelector('.ai-markdown table')&&!!document.querySelector('.ai-markdown ul')&&!!document.querySelector('.ai-markdown pre code')"), 'Assistant replies render real Markdown headings, bold, tables, lists and fenced code');
  assert(await js("!window.pwned&&!document.querySelector('.ai-markdown script,.ai-markdown img')&&Array.from(document.querySelectorAll('.ai-markdown a')).every(a=>/^https?:/.test(a.getAttribute('href')))"), 'AI Markdown cannot execute scripts, load remote images or navigate to local/script URLs');
  const url = main.webContents.getURL(); await js("document.querySelector('.ai-markdown a').click()");await pause(40); assert(main.webContents.getURL() === url&&openedUrls[0]==='https://example.com/','Markdown link opens through system browser IPC and preserves the workbench');
  for(const blocked of ['javascript:alert(1)','file:///C:/secret.txt','data:text/html,test','https://user:pass@example.com']){
    const result=await js(`window.doconstruct.invoke('external.open',{url:${JSON.stringify(blocked)}})`);assert(!result.ok,'System link boundary rejects '+blocked.split(':')[0]);
  }
  assert(await js("!!document.querySelector('.ai-message.user .ai-avatar')&&!!document.querySelector('.ai-message.assistant .ai-avatar')&&getComputedStyle(document.querySelector('.ai-message.user')).marginLeft!==getComputedStyle(document.querySelector('.ai-message.assistant')).marginLeft"), 'User and assistant have explicit role labels, avatars, spacing and alignment');
  assert(await js("!document.getElementById('ai-panel').textContent.includes('PRIVATE REASONING')&&!JSON.stringify(window.__events).includes('PRIVATE REASONING')"), 'Private provider reasoning never appears in chat or events');
  assert((await fs.readFile(path.join(project, 'notes.md'), 'utf8')) === after, 'Production filesystem contains the exact AI write');
  assert(await js("window.__events.filter(e=>e.type==='job').length===0"), 'AI writes do not trigger automatic layout or preview builds');
  await js("document.getElementById('ai-execution').open=false;document.querySelector('.ai-message.assistant:last-child').scrollIntoView({block:'start'})"); await capture('markdown-chat-and-icons.png');
  await click('ai-undo'); await until("document.getElementById('notice-text').textContent.includes('已撤回 4')", 'undo');
  await click('ai-changes'); await until("document.getElementById('ai-change-note').textContent.includes('已撤回')", 'undo review');
  assert((await api('ai.changes')).tasks[0].undone, 'Undo preserves the review record and labels it undone');
  await capture('undone-file-changes.png');
  const history = await api('ai.history');
  assert(!JSON.stringify(history).includes(after) && !JSON.stringify(history).includes('PRIVATE REASONING'), 'History and event summaries avoid copying entire document snapshots');
  await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: true, checks, project, userData: app.getPath('userData'), sourceEntry: __filename, geometry, requests }, null, 2));
  console.log('UI V021 PASS', checks.length, stage); await api('app.dirty', { dirty: false }); server.close(); app.quit();
} catch (error) {
  await capture('failure.png').catch(() => {});
  await fs.writeFile(path.join(stage, 'CLOSED.json'), JSON.stringify({ ok: false, error: error.stack, checks, context: await js("({notice:document.getElementById('notice-text').textContent,html:document.getElementById('ai-panel').innerHTML})").catch(() => null) }, null, 2));
  console.error(error); server?.close(); app.exit(1);
} }
app.on('browser-window-created', (_event, window) => { if (main) return; main = window; main.webContents.setBackgroundThrottling(false); main.webContents.once('did-finish-load', () => setTimeout(exercise, 100)); });
require('../src/main.cjs');
