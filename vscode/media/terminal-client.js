/* Runs only inside the local command webview. No shell execution occurs here. */
const api=acquireVsCodeApi();
const source=document.getElementById('command-code');
hljs.highlightElement(source);
const styles=getComputedStyle(document.body);
const color=(name,fallback)=>styles.getPropertyValue('--vscode-'+name).trim()||fallback;
const term=new Terminal({convertEol:true,disableStdin:true,cursorBlink:false,cursorInactiveStyle:'none',scrollback:3000,fontFamily:color('editor-font-family','Consolas, monospace'),fontSize:parseFloat(color('editor-font-size','14')),theme:{background:color('editor-background','#1e1e1e'),foreground:color('editor-foreground','#ddd'),cursor:color('editorCursor-foreground','#ddd'),selectionBackground:color('editor-selectionBackground','#264f78')},linkHandler:{activate(){}},allowProposedApi:false});
const fit=new FitAddon.FitAddon();term.loadAddon(fit);term.open(document.getElementById('terminal'));fit.fit();
let previous='',pending,writing=false,follow=true,interactive=null;
const followButton=document.getElementById('follow'),stateLabel=document.getElementById('output-status'),notice=document.getElementById('output-note');
function setFollow(value){follow=value;followButton.textContent=value?'Following':'Follow output';followButton.setAttribute('aria-pressed',String(value));}
followButton.onclick=()=>{setFollow(!follow);if(follow)term.scrollToBottom();};
term.onScroll(()=>{if(!writing && term.buffer.active.viewportY<term.buffer.active.baseY)setFollow(false);});
function pump(){
  if(writing||!pending)return;
  const p=pending;pending=undefined;
  stateLabel.textContent='Output · '+p.status;
  notice.textContent=p.truncated?'Showing a bounded output tail · earlier output is in the tool result':p.status==='Not run'?'Command preview · nothing has executed':'Live output from the approved command';
  const next=p.raw??p.text??'',append=next.startsWith(previous),offset=term.buffer.active.viewportY;
  writing=true;
  if(!append)term.reset();
  term.write(append?next.slice(previous.length):next,()=>{previous=next;writing=false;if(follow)term.scrollToBottom();else term.scrollToLine(offset);pump();});
}
function update(p){pending=p;pump();}
function setTerminal(value){
  const changed=interactive?.runId!==value?.runId;interactive=value;
  term.options.disableStdin=!value;term.options.cursorBlink=!!value;
  document.getElementById('stop').disabled=!value;
  document.getElementById('input-status').textContent=value?'Interactive · click output to type · Ctrl+C interrupts':'Output view · keyboard input is available for approved interactive commands';
  if(value&&changed){resize();term.focus();}
}
function resize(){fit.fit();if(interactive)api.postMessage({action:'terminal',runId:interactive.runId,kind:'resize',cols:Math.max(20,Math.min(400,term.cols)),rows:Math.max(5,Math.min(150,term.rows))});}
let resizing;
new ResizeObserver(()=>{clearTimeout(resizing);resizing=setTimeout(resize,80);}).observe(document.getElementById('terminal'));
term.onData(text=>{if(interactive)api.postMessage({action:'terminal',runId:interactive.runId,kind:'input',text});});
document.getElementById('stop').onclick=()=>{if(interactive)api.postMessage({action:'terminal',runId:interactive.runId,kind:'stop'});};
document.getElementById('source').onclick=()=>api.postMessage({action:'source'});
window.addEventListener('message',event=>{
  const m=event.data;
  if(m?.type==='command-output' && m.reviewId===commandIdentity.reviewId){for(const p of m.progress)if(p.index===commandIdentity.index)update(p);}
  if(m?.type==='terminal-state')setTerminal(m.terminal);
  if(m?.type==='connection')document.getElementById('connection').textContent=m.text;
  if(m?.type==='terminal-error')document.getElementById('input-status').textContent=m.text;
});
update(initialOutput);api.postMessage({action:'ready'});
