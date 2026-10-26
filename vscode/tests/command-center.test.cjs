const test=require('node:test'),assert=require('node:assert/strict');
const {renderCommandCenter,createCommandCenter}=require('../command-center.cjs');
const review=()=>({id:'r',title:'Check configuration',why:'Verify before editing.',pending:true,changes:[{kind:'bash',command:'npm run check',why:'Check the types.'}]});
test('center command layout dedicates remaining editor height to output with no execution controls',()=>{
 const html=renderCommandCenter(review(),0,'C:/project',undefined,true);
 assert.match(html,/Command output/);assert.match(html,/flex:1;min-height:0;max-height:none/);
 assert.match(html,/Open command source/);assert.match(html,/This command has not run/);
 assert.doesNotMatch(html,/data-action="approve"/);
 const hostile=review();hostile.changes[0].command='</code><img src=x onerror=alert(1)>';
 assert.ok(!renderCommandCenter(hostile,0,'C:/project',undefined,true).includes('<img'));
});
test('center streams update in place, reveal once, preserve source anchors and isolate sessions',async()=>{
 let state={sessionId:'s',root:'C:/project',review:review(),progress:[],connected:true},htmlWrites=0,reveals=0,created=0,closed,source;
 const messages=[],handlers=[],context={subscriptions:[]};
 const panel={webview:{set html(value){htmlWrites++;},postMessage(message){messages.push(message);return Promise.resolve(true);},onDidReceiveMessage(fn){handlers.push(fn);}},reveal(){reveals++;},onDidDispose(fn){closed=fn;},dispose(){closed();}};
 const controller=createCommandCenter({ViewColumn:{Active:1},window:{createWebviewPanel(){created++;return panel;}}},context,{getState:()=>state,openNative:async(...args)=>source=args,showError:err=>{throw err;}});
 controller.open(state.review,0);assert.equal(created,1);assert.equal(htmlWrites,1);
 state.review.pending=false;state.progress=[{reviewId:'r',index:0,status:'Running',text:'one',truncated:false}];controller.sync();
 const writes=htmlWrites,focus=reveals;
 state.progress[0].text='one\ntwo';controller.sync();controller.sync();
 assert.equal(htmlWrites,writes);assert.equal(reveals,focus);
 assert.equal(messages.filter(m=>m.type==='command-output').length,1);
 await controller.openSource();assert.equal(source[0].changes[0].command,'npm run check');assert.equal(source[1],0);
 state={...state,sessionId:'other',progress:[]};controller.sync();
 assert.match(messages.at(-1).text,/Earlier step/);
 await assert.rejects(controller.openSource(),/another Pi session/);
 assert.equal(messages.filter(m=>m.type==='command-output').length,1);
 state={...state,sessionId:'s',progress:[{reviewId:'r',index:0,status:'Running',text:'later',truncated:false}]};closed();controller.sync();
 assert.equal(created,1,'closed viewer must not reopen every poll');
});

test('interactive input resumes server sequence, chunks paste and rejects stale runs',async()=>{
 const state={sessionId:'s',root:'C:/project',review:review(),progress:[],connected:true,terminal:{reviewId:'r',index:0,runId:'run-1',inputSequence:4}};
 let receive;const sent=[],errors=[];
 const panel={webview:{html:'',postMessage(m){if(m.type==='terminal-error')errors.push(m.text);return Promise.resolve(true);},onDidReceiveMessage(fn){receive=fn;}},reveal(){},onDidDispose(){},dispose(){}};
 const controller=createCommandCenter({ViewColumn:{Active:1},workspace:{isTrusted:true},window:{createWebviewPanel:()=>panel}},{subscriptions:[]},{getState:()=>state,sendTerminal:async m=>sent.push(m),showError:()=>{},openNative:async()=>{}});
 controller.open(state.review,0);
 receive({action:'terminal',kind:'input',runId:'run-1',text:'x'.repeat(5000)});
 await new Promise(r=>setTimeout(r,10));assert.equal(sent.length,2);assert.equal(sent[0].sequence,5);assert.equal(sent[1].sequence,6);assert.equal(sent[0].text.length,4096);
 receive({action:'terminal',kind:'input',runId:'old',text:'wrong'});await new Promise(r=>setTimeout(r,10));assert.equal(sent.length,2);assert.match(errors[0],/no longer active/);
});
test('terminal asset page keeps raw output inert in its initialization script',()=>{
 const assets=Object.fromEntries(['vendor/xterm.js','vendor/xterm.css','vendor/addon-fit.js','vendor/highlight.js','vendor/powershell.js','terminal-client.js'].map(name=>[name,'https://local.invalid/'+name]));assets.csp='https://local.invalid';
 const html=renderCommandCenter(review(),0,'C:/project',{status:'Running',text:'</script><img src=x>',raw:'</script><img src=x>',truncated:false},true,assets);
 assert.ok(!html.includes('</script><img'));assert.match(html,/id="command-code"/);assert.match(html,/vendor\/xterm.js/);
});
