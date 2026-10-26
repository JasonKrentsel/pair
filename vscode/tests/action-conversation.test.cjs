'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {renderActionConversation,actionConversationUpdate,conversationMarkdown,currentConversation} = require('../action-conversation.cjs');
const base = () => {
 const review={id:'review-1',revision:1,fingerprint:'snapshot-1',gate:2,pending:true,changes:[{kind:'Edit',label:'src/config.ts',before:'old',after:'new'}]};
 const conversation={id:'conversation-1',reviewId:review.id,revision:1,fingerprint:review.fingerprint,gate:2,index:0,status:'idle',messages:[],scope:{startLine:3,endLine:8,excerpt:'function load() {}'}};
 return {review,conversation,index:0,connected:true,trusted:true};
};
function browser(options=base(),saved={}) {
 const html=renderActionConversation(options);
 const source=html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1];
 const initial=html.match(/<script id="conversation-state"[^>]+>([\s\S]*?)<\/script>/)[1];
 const elements=new Map(),events={},posted=[];
 let savedState=saved,id=0;
 function element(name) {
  const e={name,dataset:{},children:[],value:'',textContent:'',innerHTML:'',hidden:false,disabled:false,scrollTop:0,scrollHeight:900,clientHeight:300,handlers:{},
   addEventListener(type,fn){this.handlers[type]=fn;},querySelectorAll(){return [];},focus(){this.focused=true;},
   appendChild(child){child.parent=this;this.children.push(child);},remove(){this.parent.children.splice(this.parent.children.indexOf(this),1);},requestSubmit(){this.handlers.submit({preventDefault(){}});}};
  elements.set(name,e);return e;
 }
 for(const name of ['conversation-state','transcript','messages','message','composer','send','stop','warning','conversation-status','candidate','latest','chat-help','empty'])element(name);
 elements.get('conversation-state').textContent=initial;
 let checkedMode=options.mode || 'ask';
 const radios=['ask','adjust'].map(value=>{const radio=Object.assign(element(value),{value});Object.defineProperty(radio,'checked',{get:()=>checkedMode===value,set:checked=>{if(checked)checkedMode=value;}});return radio;});
 const document={getElementById:id=>elements.get(id),createElement:()=>element('article'+ ++id),addEventListener(type,fn){events[type]=fn;},
  querySelector:selector=>selector.includes(':checked')?radios.find(r=>r.checked):radios.find(r=>selector.includes('"'+r.value+'"')),querySelectorAll:()=>radios};
 const api={getState:()=>savedState,setState:value=>savedState=value,postMessage:value=>posted.push(value)};
 const window={addEventListener(type,fn){events['window:'+type]=fn;}};
 let requestCounter=0;
 vm.runInNewContext(source,{acquireVsCodeApi:()=>api,document,window,crypto:{randomUUID:()=>String(++requestCounter)},Date,Math});
 return {html,e:name=>elements.get(name),posted,events,radios,get saved(){return savedState;},
  patch(update){events['window:message']({data:update});},submit(){elements.get('composer').requestSubmit();},
  click(action){events.click({target:{closest:()=>({dataset:{action}})}});}};
}

test('focused conversation safely renders Markdown, code and source context',()=>{
 const html=conversationMarkdown('**Reason**\n```ts\nconst x = "</script><img onerror=x>";\n```');
 assert.match(html,/<strong>Reason<\/strong>/);assert.match(html,/class="language-typescript"/);assert.doesNotMatch(html,/<img|<\/script>/);
 const options=base();options.conversation.messages=[{role:'assistant',text:'</script><iframe src=x>'}];
 options.conversation.scope.excerpt='<script>alert(1)</script>';
 const page=renderActionConversation(options);
 assert.doesNotMatch(page,/<iframe|<script>alert/);assert.match(page,/Lines 3–8/);assert.match(page,/for="message">Message/);assert.match(page,/The chat starts when you send your first message/);
 assert.match(page,/font:var\(--vscode-font-size\)/);assert.match(page,/\.composer-area\{flex:none/);
 assert.doesNotMatch(page,/data-action="approve"|Review Desk|Checkpoint/);
});

test('revisions can be inspected and adopted only under the current pending identity',()=>{
 const options=base();options.conversation.candidate={id:'candidate-1',summary:'Use the existing **loader**.',added:3,removed:2};
 const update=actionConversationUpdate(options);
 assert.equal(update.canSend,true);assert.match(update.candidateHtml,/Use revision/);assert.match(update.candidateHtml,/step still needs approval/);
 for(const changed of [{gate:3},{revision:2},{fingerprint:'other'},{pending:false}]) {
  const stale={...options,review:{...options.review,...changed}};
  assert.equal(currentConversation(stale),false);
  const patch=actionConversationUpdate(stale);assert.equal(patch.canSend,false);assert.match(patch.candidateHtml,/conversation-adopt" disabled/);
 }
 assert.equal(actionConversationUpdate({...options,connected:false}).canSend,false);
 assert.equal(actionConversationUpdate({...options,trusted:false}).canSend,false);
});

test('only an exact adoption receipt confirms that a revised step still awaits approval',()=>{
 const options=base();options.conversation.status='closed';
 options.review={...options.review,revision:2,gate:3,fingerprint:'revised'};
 options.adoptedRevision={conversationId:options.conversation.id,identity:{reviewId:options.review.id,revision:2,gate:3,fingerprint:'revised'}};
 const patch=actionConversationUpdate(options);
 assert.equal(patch.status,'Revision added to step · Awaiting approval');assert.equal(patch.warning,'');assert.equal(patch.canSend,false);
 for(const other of [
  {...options,adoptedRevision:undefined},
  {...options,adoptedRevision:{...options.adoptedRevision,conversationId:'another-chat'}},
  ...[{revision:3},{fingerprint:'another-snapshot'},{gate:4},{pending:false}].map(change=>({...options,review:{...options.review,...change}})),
 ]) {
  const stale=actionConversationUpdate(other);
  assert.equal(stale.status,'Earlier conversation');assert.match(stale.warning,/step changed or finished/);assert.equal(stale.canSend,false);
 }
});

test('stream patches preserve drafts, unchanged messages, manual scroll and other webview state',()=>{
 const options=base();options.conversation.messages=[{id:'user1',role:'user',text:'Why this loader?'},{id:'answer1',role:'assistant',text:'It shares validation.'}];
 const b=browser(options,{key:'review-1:1',scroll:140,conversationDrafts:{'conversation-1':{draft:'Keep this draft',following:false,scroll:100}}});
 const node=b.e('messages').children[0];
 b.e('transcript').scrollTop=180;b.e('transcript').handlers.scroll();
 const patch=actionConversationUpdate({...options,conversation:{...options.conversation,status:'running',messages:[...options.conversation.messages.slice(0,1),{id:'answer1',role:'assistant',text:'It shares validation.\n```js\nreturn load();\n```'}]}});
 b.patch(patch);
 assert.equal(b.e('message').value,'Keep this draft');assert.equal(b.e('messages').children[0],node);assert.equal(b.e('transcript').scrollTop,180);
 assert.equal(b.saved.key,'review-1:1');assert.equal(b.saved.scroll,140);assert.equal(b.e('stop').hidden,false);
 assert.equal(b.e('latest').hidden,false);
 const text=b.e('messages').children[1].innerHTML;b.patch({...patch,id:'other'});assert.equal(b.e('messages').children[1].innerHTML,text);
});

test('failed sends retain the draft and retry id; acknowledgement never erases new typing',()=>{
 const options=base(),b=browser(options);
 b.e('message').value='Explain this function';b.submit();
 const first=b.posted.at(-1);assert.equal(first.action,'conversation-send');assert.equal(first.mode,'chat');
 assert.equal(b.e('send').disabled,true);
 b.patch({type:'action-conversation-error',id:options.conversation.id,text:'Connection interrupted'});
 assert.equal(b.e('message').value,'Explain this function');assert.equal(b.e('send').disabled,false);
 b.submit();assert.equal(b.posted.at(-1).requestId,first.requestId);
 b.e('message').value='Also explain the fallback';
 b.patch(actionConversationUpdate({...options,conversation:{...options.conversation,status:'running',messages:[{role:'user',text:first.text}]}}));
 assert.equal(b.e('message').value,'Also explain the fallback');
 assert.equal(b.saved.conversationDrafts[options.conversation.id].draft,'Also explain the fallback');
 b.click('conversation-back');assert.equal(b.posted.at(-1).action,'conversation-back');
 assert.equal(b.posted.some(message=>message.action==='approve'),false);
});

test('Enter submits while Shift+Enter and IME composition remain normal editing',()=>{
 const b=browser(base());b.e('message').value='Keep the protocol; simplify the implementation.';
 const key=(extras={})=>b.e('message').handlers.keydown({key:'Enter',preventDefault(){},...extras});
 key({shiftKey:true});key({isComposing:true});assert.equal(b.posted.filter(p=>p.action==='conversation-send').length,0);
 key();assert.equal(b.posted.at(-1).mode,'chat');assert.equal(b.posted.at(-1).identity.gate,2);
});

test('chat restores drafts while obsolete mode preferences are ignored',()=>{
 const saved={conversationDrafts:{'conversation-1':{mode:'adjust',draft:'Simplify the body',following:true}}};
 const resumed=browser(base(),saved);
 assert.equal(resumed.e('message').value,'Simplify the body');assert.equal(resumed.e('send').textContent,'Send');
 assert.doesNotMatch(resumed.html,/name="mode"|Request revision|Message purpose/);
 resumed.submit();assert.equal(resumed.posted.at(-1).mode,'chat');
 assert.equal(resumed.saved.conversationDrafts['conversation-1'].mode,undefined);
});

test('backend top-level line scope appears with exact selected code and a consistent message limit',()=>{
 const options=base();delete options.conversation.scope;
 options.conversation.startLine=2;options.conversation.endLine=3;
 options.review.changes[0].after='function load() {\n  const value = read();\n  return validate(value);\n}';
 const html=renderActionConversation(options);assert.match(html,/Lines 2–3/);assert.match(html,/Selected code/);assert.match(html,/const value = read/);assert.match(html,/maxlength="3000"/);
 const b=browser(options);b.e('message').value='x'.repeat(3001);b.submit();assert.equal(b.posted.filter(message=>message.action==='conversation-send').length,0);
});

test('empty running assistant response has a useful waiting label that becomes streamed text',()=>{
 const options=base();options.conversation.status='running';options.conversation.messages=[{role:'user',text:'Why share this loader?'},{role:'assistant',text:''}];
 const b=browser(options),node=b.e('messages').children[1];
 assert.match(node.innerHTML,/Preparing a response…/);
 b.e('message').value='Keep this draft';
 options.conversation.messages[1].text='The loader shares validation.';b.patch(actionConversationUpdate(options));
 assert.equal(b.e('messages').children[1],node);assert.doesNotMatch(node.innerHTML,/Preparing a response/);assert.match(node.innerHTML,/shares validation/);
 assert.equal(b.e('message').value,'Keep this draft');
 options.conversation.status='idle';options.conversation.messages[1].text='';
 assert.doesNotMatch(actionConversationUpdate(options).messages[1].html,/Preparing a response/);
});

test('one composer handles questions and changes with contextual examples',()=>{
 const options=base();options.review.changes=[{kind:'powershell',command:'Get-Content README.md'}];
 assert.equal(browser(options).e('message').placeholder,'Ask about this command or suggest a change…');
 assert.equal(browser(base()).e('message').placeholder,'Ask about this code or suggest a change…');
 const b=browser(base());assert.equal(b.posted.filter(message=>message.action==='conversation-send').length,0);
 assert.equal(b.e('send').disabled,true);b.e('message').value='  ';b.e('message').handlers.input();assert.equal(b.e('send').disabled,true);
 b.e('message').value='Why this approach?';b.e('message').handlers.input();assert.equal(b.e('send').disabled,false);assert.equal(b.posted.filter(message=>message.action==='conversation-send').length,0);
 assert.equal(b.e('conversation-status').textContent,'Ready to chat');assert.equal(b.e('send').textContent,'Send');assert.equal(b.e('message').focused,true);
 b.e('message').focused=false;b.patch(actionConversationUpdate(base()));assert.equal(b.e('message').focused,false,'polling must not take focus back');
});

test('initial busy-to-ready transition focuses once unless the human has navigated away',()=>{
 const options=base(),ready=actionConversationUpdate(options),b=browser({...options,busy:true});
 assert.equal(b.e('message').focused,undefined);b.patch(ready);assert.equal(b.e('message').focused,true);
 b.e('message').focused=false;b.patch(ready);assert.equal(b.e('message').focused,false);
 for(const event of ['pointerdown','keydown','window:blur']){
   const moved=browser({...options,busy:true});moved.events[event]({});moved.patch(ready);
   assert.equal(moved.e('message').focused,undefined,event+' must cancel deferred focus');
 }
 const running=browser({...options,conversation:{...options.conversation,status:'running'}});running.patch(ready);
 assert.equal(running.e('message').focused,undefined,'finishing a response is not a new input intent');
 const disconnected=browser({...options,connected:false});disconnected.patch(ready);
 assert.equal(disconnected.e('message').focused,undefined,'reconnecting must not steal focus');
});
