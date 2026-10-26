'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {createRequire}=require('node:module');
const {decisionIdentity}=require('../client.cjs');
async function fixture() {
 const root=path.resolve('action-review-fixture');
 const session={version:1,root,sessionId:'conversation-session',port:1,token:'a'.repeat(64),pid:process.pid};
 let review={id:'review-1',revision:1,fingerprint:'snapshot-1',gate:2,pending:true,status:'Awaiting permission',title:'Use a shared loader',why:'Keep validation consistent.',changes:[{kind:'Edit',label:'src/config.ts',before:'old',after:'function load() {\n  const value = read();\n  return validate(value);\n}\n',why:'Share validation.'}]};
 let conversations=[],html='',htmlWrites=0,handler,provider,nextGet;
 const commands=new Map(),requests=[],posted=[],executed=[],opened=new Map(),warnings=[];
 const disposable=()=>({dispose(){}}),event=()=>disposable();
 const uri=parts=>({...parts,toString(){return `${this.scheme}://${this.authority||''}${this.path||this.fsPath||''}?${this.query||''}`;}});
 const vscode={
  StatusBarAlignment:{Left:1},ViewColumn:{Active:1},Uri:{from:uri,file:fsPath=>uri({scheme:'file',fsPath}),parse(){throw Error('Not needed');}},
  commands:{registerCommand(name,fn){commands.set(name,fn);return disposable();},executeCommand:async(...args)=>{executed.push(args);}},
  workspace:{workspaceFolders:[{uri:{scheme:'file',fsPath:root}}],textDocuments:[],isTrusted:true,
   getConfiguration(){return {get:(key,fallback)=>key==='openReviewAutomatically'?false:fallback};},
   registerTextDocumentContentProvider(scheme,value){provider=value;return disposable();},onDidChangeWorkspaceFolders:event,onDidGrantWorkspaceTrust:event,onDidChangeTextDocument:event,onDidSaveTextDocument:event,onDidCloseTextDocument:event,
   async openTextDocument(value){if(value.scheme==='file')throw Error('New file');let document=opened.get(value.toString());if(!document){const content=provider.provideTextDocumentContent(value);document={uri:value,languageId:'typescript',getText:()=>content,isDirty:false};opened.set(value.toString(),document);}return document;}
  },
  languages:{getLanguages:async()=>['typescript','powershell','shellscript'],setTextDocumentLanguage:async(document,language)=>{document.languageId=language;return document;}},
  window:{createStatusBarItem(){return {show(){},hide(){},dispose(){}};},registerUriHandler:disposable,
   registerWebviewViewProvider(id,view){vscode.view=view;return disposable();},showWarningMessage:async message=>warnings.push(message),
   createWebviewPanel(){return {webview:{html:'',onDidReceiveMessage:event,postMessage:async()=>true},onDidDispose:event,reveal(){},dispose(){}};},
   showTextDocument:async document=>{vscode.window.activeTextEditor={document,selection:{isEmpty:true}};},visibleTextEditors:[]}
 };
 const filename=path.resolve(__dirname,'../extension.cjs'),nativeRequire=createRequire(filename);
 const client={...nativeRequire('./client.cjs'),discoverSessions:async()=>[session],request:async(target,method,route,body)=>{
  if(method==='GET'){const result={data:{version:1,root,sessionId:session.sessionId,review:structuredClone(review),progress:[],conversationAvailable:true,actionConversations:structuredClone(conversations)}};if(nextGet){const hold=nextGet;nextGet=undefined;hold.started();await hold.promise;}return result;}
  requests.push({route,body});assert.equal(route,'/conversation');
  if(body.action==='open') {
   const existing=conversations.find(c=>c.index===body.index&&c.revision===body.revision&&c.scope?.startLine===body.startLine);
   const conversation=existing||{id:'conversation-'+(conversations.length+1),...decisionIdentity(review),index:body.index,status:'idle',scope:body.startLine?{startLine:body.startLine,endLine:body.endLine,excerpt:review.changes[body.index].after.split('\n').slice(body.startLine-1,body.endLine).join('\n')}:undefined,messages:[]};
   if(!existing)conversations.push(conversation);return {data:{conversationId:conversation.id}};
  }
  const conversation=conversations.find(c=>c.id===body.conversationId);
  if(body.action==='send'){conversation.messages.push({role:'user',text:body.text});conversation.status='running';return {data:{accepted:true,conversationId:conversation.id}};}
  if(body.action==='adopt'){review={...review,revision:review.revision+1,fingerprint:'revised-snapshot',gate:review.gate+1,changes:review.changes.map((change,index)=>index===conversation.index?conversation.candidate.preview:change)};conversation.status='closed';delete conversation.candidate;return {data:{adopted:true,review}};}
  if(body.action==='stop')conversation.status='idle';
  if(body.action==='discard')delete conversation.candidate;
  return {data:{accepted:true}};
 }};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:name=>name==='vscode'?vscode:name==='./client.cjs'?client:nativeRequire(name),setInterval:()=>1,clearInterval(){},URLSearchParams,structuredClone,Date},{filename});
 const context={subscriptions:[]},api=module.exports.activate(context);await api.refresh();
 vscode.view.resolveWebviewView({webview:{options:{},get html(){return html;},set html(value){html=value;htmlWrites++;},onDidReceiveMessage(fn){handler=fn;return disposable();},postMessage:async message=>{posted.push(message);return true;}},onDidDispose:event});
 return {api,commands,requests,posted,executed,opened,vscode,warnings,get html(){return html;},get htmlWrites(){return htmlWrites;},get review(){return review;},get conversations(){return conversations;},
  async send(message){handler(message);for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));},
  candidate(){const c=conversations.at(-1);c.status='ready';c.candidate={id:'candidate-1',summary:'Remove unnecessary local state.',original:structuredClone(review.changes[c.index]),preview:{...review.changes[c.index],after:'function load() {\n  return validate(read());\n}\n'}};return c;},
  holdNextPoll(){let release,started;const promise=new Promise(resolve=>{release=resolve;}),begin=new Promise(resolve=>{started=resolve;});nextGet={promise,started};return {release,started:begin};},
  setReview(next){review=next;},close(){for(const item of context.subscriptions)item.dispose();}};
}

test('opening Chat sends only a metadata request; sending keeps approval pending and streams in place',async t=>{
 const f=await fixture();t.after(f.close);
 await f.commands.get('pair.chatAction')(0);
 const conversation=f.api.getConversationState().conversation,writes=f.htmlWrites;
 assert.equal(f.requests.length,1);assert.equal(f.requests[0].body.action,'open');assert.equal(f.requests[0].body.index,0);assert.equal(f.requests[0].body.mode,undefined);assert.equal(conversation.messages.length,0);assert.match(f.html,/Back to step/);
 const message={action:'conversation-send',conversationId:conversation.id,identity:decisionIdentity(f.review),mode:'chat',text:'Why share validation?',requestId:'ask-1'};
 await f.send(message);
 assert.equal(f.requests.at(-1).body.action,'send');assert.equal(f.requests.at(-1).body.mode,'chat');assert.equal(f.requests.at(-1).body.gate,2);assert.equal(f.review.pending,true);
 assert.equal(f.htmlWrites,writes);assert.equal(f.posted.at(-1).running,true);
 f.conversations[0].messages.push({role:'assistant',text:'Both callers reject invalid values.'});f.conversations[0].status='idle';await f.api.refresh();
 assert.equal(f.htmlWrites,writes);assert.match(f.posted.at(-1).messages.at(-1).html,/Both callers/);
 await f.send({action:'conversation-back',conversationId:conversation.id});
 assert.equal(f.api.getConversationState().activeConversationId,undefined);assert.equal(f.review.pending,true);assert.equal(f.requests.some(r=>r.route==='/decision'),false);
});

test('candidate preview compares the current proposal and revision; use revision never approves',async t=>{
 const f=await fixture();t.after(f.close);await f.commands.get('pair.chatAction')({index:0});
 const c=f.candidate();await f.api.refresh();
 const message={conversationId:c.id,identity:decisionIdentity(f.review),candidateId:c.candidate.id};
 await f.send({...message,action:'conversation-preview'});
 const diff=f.executed.findLast(args=>args[0]==='vscode.diff');assert.ok(diff);assert.match(diff[3],/Current proposal ↔ Suggested revision/);
 assert.equal(f.opened.get(diff[1].toString()).getText(),c.candidate.original.after);assert.equal(f.opened.get(diff[2].toString()).getText(),c.candidate.preview.after);
 assert.equal(f.opened.get(diff[2].toString()).languageId,'typescript');
 await f.send({...message,action:'conversation-adopt'});
 assert.equal(f.requests.at(-1).body.action,'adopt');assert.equal(f.review.revision,2);assert.equal(f.review.pending,true);assert.equal(f.api.getConversationState().activeConversationId,undefined);
 const confirmation=f.posted.findLast(patch=>patch.type==='action-conversation'&&patch.id===c.id);
 assert.equal(confirmation.status,'Revision added to step · Awaiting approval');assert.equal(confirmation.warning,'');assert.equal(confirmation.canSend,false);
 assert.match(f.html,/data-action="approve"/);assert.doesNotMatch(f.html,/id="conversation-state"/);
 assert.match(f.executed.findLast(args=>args[0]==='vscode.diff')[3],/Before ↔ Proposed/);
 assert.equal(f.requests.some(r=>r.route==='/decision'),false);
});

test('stale identities, modified buffers and wrong candidate IDs cannot adopt',async t=>{
 const f=await fixture();t.after(f.close);await f.commands.get('pair.chatAction')({index:0});const c=f.candidate();await f.api.refresh();
 const base={action:'conversation-adopt',conversationId:c.id,identity:decisionIdentity(f.review),candidateId:c.candidate.id};
 await f.send({...base,candidateId:'old-candidate'});assert.match(f.posted.at(-1).text,/revision changed/);
 f.vscode.workspace.textDocuments.push({uri:{scheme:'file',fsPath:path.join(f.api.getState().root,'src/config.ts')},isDirty:true});
 await f.send(base);assert.match(f.posted.at(-1).text,/Save affected files/);f.vscode.workspace.textDocuments.length=0;
 f.setReview({...f.review,gate:3});await f.api.refresh();await f.send(base);assert.match(f.posted.at(-1).text,/step changed or finished/);
 assert.equal(f.requests.filter(r=>r.body.action==='adopt').length,0);
});

test('selected lines are mapped from the proposed snapshot and before-side lines are refused',async t=>{
 const f=await fixture();t.after(f.close);await f.commands.get('pair.openChange')(0);
 const diff=f.executed.findLast(args=>args[0]==='vscode.diff');
 const selection={isEmpty:false,start:{line:1,character:0},end:{line:3,character:0}};
 f.vscode.window.activeTextEditor={document:f.opened.get(diff[1].toString()),selection};
 await assert.rejects(f.commands.get('pair.chatSelection')(),/Proposed side/);
 f.vscode.window.activeTextEditor={document:f.opened.get(diff[2].toString()),selection};
 await f.commands.get('pair.chatSelection')();
 assert.equal(f.requests.at(-1).body.startLine,2);assert.equal(f.requests.at(-1).body.endLine,3);assert.match(f.html,/Lines 2–3/);
 const original=f.vscode.window.activeTextEditor.document;f.vscode.window.activeTextEditor.document={...original,getText:()=>original.getText()+' changed'};
 await assert.rejects(f.commands.get('pair.chatSelection')(),/snapshot was modified/);
});

test('Chat resumes its selected-line scope instead of creating a blank whole-action thread',async t=>{
 const f=await fixture();t.after(f.close);
 await f.commands.get('pair.chatAction')({index:0,startLine:2,endLine:3});
 const conversation=f.api.getConversationState().conversation;
 await f.send({action:'conversation-back',conversationId:conversation.id});
 assert.match(f.html,/data-conversation-id="conversation-1"/);
 await f.send({action:'chat-action',index:0,conversationId:conversation.id,identity:decisionIdentity(f.review)});
 assert.equal(f.conversations.length,1);assert.equal(f.api.getConversationState().activeConversationId,conversation.id);
 assert.equal(f.requests.at(-1).body.startLine,2);assert.equal(f.requests.at(-1).body.endLine,3);assert.doesNotMatch(f.html,/name="mode"|Request revision/);
});

test('two actions editing the same file use distinct native snapshots and keep line targeting exact',async t=>{
 const f=await fixture();t.after(f.close);
 const first=f.review.changes[0],second={...first,before:first.after,after:'function load() {\n  return fallback();\n}'};
 f.setReview({...f.review,changes:[first,second]});await f.api.refresh();
 await f.commands.get('pair.openChange')(0);const one=f.executed.findLast(args=>args[0]==='vscode.diff');
 await f.commands.get('pair.openChange')(1);const two=f.executed.findLast(args=>args[0]==='vscode.diff');
 assert.notEqual(one[2].toString(),two[2].toString());
 assert.equal(f.opened.get(one[2].toString()).getText(),first.after);assert.equal(f.opened.get(two[2].toString()).getText(),second.after);
 f.vscode.window.activeTextEditor={document:f.opened.get(two[2].toString()),selection:{isEmpty:false,start:{line:1,character:0},end:{line:2,character:0}}};
 await f.commands.get('pair.chatSelection')();assert.equal(f.requests.at(-1).body.index,1);
});


test('opening a conversation refreshes beyond a poll that started before the action',async t=>{
 const f=await fixture();t.after(f.close);
 const hold=f.holdNextPoll(),poll=f.api.refresh();await hold.started;
 const opening=f.commands.get('pair.chatAction')(0).then(value=>({value}),error=>({error}));
 for(let i=0;i<10&&!f.requests.some(item=>item.body.action==='open');i++)await new Promise(resolve=>setImmediate(resolve));
 assert.ok(f.requests.some(item=>item.body.action==='open'));
 hold.release();await poll;
 const result=await opening;
 assert.equal(result.error,undefined,'the post-open refresh must not reuse an earlier snapshot without the newly created conversation');
 assert.equal(f.api.getConversationState().activeConversationId,f.conversations[0].id);
});
