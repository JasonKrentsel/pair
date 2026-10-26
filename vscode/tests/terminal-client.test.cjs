const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
test('terminal browser handles raw deltas and gates keyboard input to the active run',()=>{
 const sent=[],writes=[],elements=new Map();let receive,instance;
 const element=id=>{if(!elements.has(id))elements.set(id,{textContent:'',setAttribute(){}});return elements.get(id);};
 class Terminal{constructor(options){this.options=options;this.cols=100;this.rows=25;this.buffer={active:{viewportY:0,baseY:0}};instance=this;}loadAddon(){}open(){}onScroll(fn){this.scroll=fn;}onData(fn){this.input=fn;}write(s,fn){writes.push(s);fn();}reset(){writes.push('RESET');}scrollToBottom(){}scrollToLine(){}focus(){this.focused=true;}}
 const context={acquireVsCodeApi:()=>({postMessage:m=>sent.push(m)}),hljs:{highlightElement(){}},getComputedStyle:()=>({getPropertyValue:()=>''}),Terminal,FitAddon:{FitAddon:class{fit(){}}},ResizeObserver:class{observe(){}},document:{body:{},getElementById:element},window:{addEventListener:(_event,fn)=>receive=fn},commandIdentity:{reviewId:'r',index:0},initialOutput:{status:'Not run',text:'Preview'},setTimeout,clearTimeout};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../media/terminal-client.js'),'utf8'),context);
 assert.equal(element('output-note').textContent,'Command preview · nothing has executed');
 instance.input('before approval');assert.ok(!sent.some(m=>m.kind==='input'));
 const msg=data=>receive({data});
 msg({type:'terminal-state',terminal:{runId:'run'}});instance.input('hello\r');assert.equal(sent.at(-1).kind,'input');assert.equal(sent.at(-1).text,'hello\r');
 msg({type:'command-output',reviewId:'r',progress:[{index:0,status:'Running',text:'one',raw:'\x1b[32mone'}]});
 msg({type:'command-output',reviewId:'r',progress:[{index:0,status:'Running',text:'one two',raw:'\x1b[32mone two'}]});assert.equal(writes.at(-1),' two');
 assert.equal(element('output-note').textContent,'Live output from the approved command');
 const count=writes.length;msg({type:'command-output',reviewId:'other',progress:[{index:0,status:'Running',raw:'wrong'}]});assert.equal(writes.length,count);
 msg({type:'command-output',reviewId:'r',progress:[{index:0,status:'Completed',text:'one two'}]});
 assert.equal(element('output-note').textContent,'Recorded output from the approved command');
 msg({type:'command-output',reviewId:'r',progress:[{index:0,status:'Failed',text:'one two',truncated:true}]});
 assert.match(element('output-note').textContent,/^Recorded output.*bounded tail/);
 assert.equal(element('output-status').textContent,'Output · Failed');
 msg({type:'terminal-state',terminal:null});const before=sent.length;instance.input('late');assert.equal(sent.length,before);assert.equal(instance.options.disableStdin,true);
});
