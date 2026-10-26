import {identityOf,sameDecision,type PairAdapter,type PairState,type UiMessage,type Conversation,type Change} from './types';
import './preview-theme.css';

/** Development-only fixtures. This module is excluded from the production bundle. */
const before=`export function displayName(name: string): string {\n  return name;\n}\n`;
const proposed=`export function displayName(name: string): string {\n  const value = name;\n  return value || "friend";\n}\n`;
const revised=`export function displayName(name: string): string {\n  const value = name.trim();\n  return value || "friend";\n}\n`;
const answer=`The **public contract stays the same**. This function still accepts a name and returns the text used in the greeting.\n\n- The request and reply fields are unchanged.\n- Only the display name is formatted here.\n- The test and documentation actions remain separate.\n\nFor example, trimming surrounding whitespace would keep the fallback:\n\n\`\`\`ts\nconst value = name.trim();\nreturn value || "friend";\n\`\`\`\n\nI can suggest that small revision if you want it.`;

function fixture(scenario:string):PairState {
  const changes:Change[]=[
    {label:'src/greeting/display-name.ts',kind:'Edit',before,after:proposed,added:2,removed:1,why:'Keep the greeting friendly when a caller provides an empty name. The public request and reply types stay unchanged.',annotations:[{title:'Keep formatting local',startLine:2,endLine:3,why:'The fallback belongs in `displayName()`, so callers can continue to pass the original value.'}]},
    {label:'tests/greeting/display-name.test.ts',kind:'New file',before:'',after:'import {test} from "node:test";\nimport {strict as assert} from "node:assert";\nimport {displayName} from "../../src/greeting/display-name.js";\n\ntest("an empty name uses the friendly fallback", () => {\n  assert.equal(displayName(""), "friend");\n});\n',added:7,removed:0,why:'Capture the empty-name behavior with a focused regression test. Existing response fields are unaffected.'},
    {label:'npm run check && npm run test:greeting',kind:'bash',command:'npm run check &&\n  npm run test:greeting',cwd:'/workspace/greeting-service',why:'Check the types and run the focused greeting tests before the step is complete. This command uses the existing dependencies.'},
  ];
  const state:PairState={version:'0.11.0-preview',session:{sessionId:'preview-session',root:'/workspace/greeting-service'},sessionsCount:1,connected:true,busy:false,review:{id:'preview-step',revision:1,fingerprint:'preview-v1',gate:1,title:'Give empty names a friendly greeting',why:'Keep the reply predictable for callers, with a focused implementation and test. Review each action below before running the step.',changes,pending:true,status:'Awaiting permission'},selectedIndex:0,trusted:true,canDecide:true,canApprove:true,dirtyFiles:[],alteredSnapshots:0,errorMessage:'',conversationAvailable:true,actionConversations:[],conversationBusy:false};
  if(scenario==='long') {
    state.review!.title='Keep configuration paths explicit across all application entry points';
    state.review!.changes=Array.from({length:12},(_,i)=>({...changes[i%3],label:i%3===2?changes[2].label:`src/application/configuration/providers/environment-${i+1}/resolve-explicit-provider-configuration.ts`,why:`Action ${i+1} keeps the selected provider configuration explicit.\n\nThe loader resolves the path relative to the invocation directory and preserves the existing error message when a file is missing. No additional configuration is discovered automatically.\n\n\`\`\`ts\nconst selected = resolve(cwd, options.models);\nreturn loadProviderConfiguration(selected);\n\`\`\``}));
  }
  if(scenario==='command') {state.review!.changes=[changes[2]];state.review!.title='Run the focused greeting checks';state.review!.why=changes[2].why;}
  if(scenario==='disconnected') {state.connected=false;state.canDecide=false;state.canApprove=false;state.conversationAvailable=false;state.errorMessage='Pi is disconnected. Start Pi in this folder or use /pair code.';}
  if(scenario==='running') {state.review!.pending=false;state.review!.status='Applying 2 of 3';state.review!.changes[0].status='Applied';state.review!.changes[1].status='Running';state.canDecide=false;state.canApprove=false;state.conversationAvailable=false;}
  if(scenario==='completed') {state.review!.pending=false;state.review!.status='Applied';state.review!.changes.forEach(change=>{change.status='Applied';});state.canDecide=false;state.canApprove=false;state.conversationAvailable=false;}
  if(['chat','candidate','error'].includes(scenario)) {
    const thread:Conversation={...identityOf(state.review!),id:'preview-chat-0',index:0,startLine:2,endLine:3,status:'ready',messages:[{role:'user',text:'Why is this change safe for the protocol?'},{role:'assistant',text:answer}]};
    if(scenario==='candidate') {thread.messages.push({role:'user',text:'Trim the whitespace first. Keep the fallback and protocol unchanged.'},{role:'assistant',text:'Trim the name before choosing the fallback. Only these two lines change; the surrounding function and other actions stay the same.'});thread.candidate=candidate(thread,changes[0]);}
    if(scenario==='error') {thread.status='error';thread.error='The model did not finish a usable reply. Try the message again.';}
    state.actionConversations=[thread];state.activeConversationId=thread.id;
  }
  return state;
}

function candidate(thread:Conversation,change:Change) {
  const command=change.command!==undefined;
  return {id:`candidate-${thread.id}`,summary:command?'Run only the greeting tests while keeping the same test file.':'Trim surrounding whitespace and preserve the friendly fallback.',added:1,removed:1,original:structuredClone(change),preview:{...change,...(command?{command:'npm run test:greeting -- --test-name-pattern="greeting"'}:{after:revised}),why:'Trim surrounding whitespace and preserve the friendly fallback.'}};
}

export interface PreviewControls {
  readonly state:PairState; messages:UiMessage[]; readonly forks:number; readonly requests:number;
  patch(value:Partial<PairState>):void; reset(scenario?:string):void;
}
declare global {interface Window {__PAIR_PREVIEW__?:PreviewControls}}

export function createPreview():PairAdapter {
  const query=new URLSearchParams(location.search),scenario=query.get('scenario')||'pending';
  document.documentElement.dataset.previewTheme=query.get('theme')==='light'?'light':'dark';
  document.title=`Pair preview · ${scenario}`;
  let current=fixture(scenario),local:unknown,sequence=0,requests=0;
  const messages:UiMessage[]=[],listeners=new Set<(state:PairState)=>void>(),forks=new Set<string>(),timers=new Set<ReturnType<typeof setTimeout>>();
  const localKey=`pair-ui-preview:${scenario}`;
  try{local=JSON.parse(sessionStorage.getItem(localKey)||'null')||undefined;}catch{}
  const publish=()=>{current=structuredClone(current);for(const listener of listeners)listener(current);};
  const later=(fn:()=>void,delay:number)=>{const timer=setTimeout(()=>{timers.delete(timer);fn();},delay);timers.add(timer);};
  const failure=(id:string|undefined,text:string)=>{current.conversationError={id,text,sequence:++sequence};publish();};
  const scheduleReply=(id:string,text:string)=>{
    const wantsRevision=/\b(trim|change|revise|update|simplify|replace|use|run only)\b/i.test(text)&&!/^(why|what|how|explain|could you explain)\b/i.test(text);
    const response=wantsRevision?'I’ve prepared a small revision for this action. The public protocol and the other actions remain unchanged. Inspect the diff, then use the revision if it matches your intent.':answer;
    const chunk=(n:number)=>{
      const thread=current.actionConversations.find(item=>item.id===id);
      if(!thread||thread.status!=='running')return;
      thread.messages.at(-1)!.text=response.slice(0,Math.ceil(response.length*n/4));
      if(n===4){thread.status='ready';if(wantsRevision)thread.candidate=candidate(thread,current.review!.changes[thread.index]);}
      publish();
    };
    for(let n=1;n<=4;n++)later(()=>chunk(n),n*180);
  };
  const postMessage=(message:UiMessage)=>{
    messages.push(structuredClone(message));
    if(message.action==='webview-ready'||message.action==='conversation-ready') {publish();return;}
    if(message.action==='conversation-back'){current.activeConversationId=undefined;publish();return;}
    if(message.action==='session')return;
    if(!sameDecision(current.review,message.identity)) {failure(message.conversationId,'This step changed. Open the current action to continue.');return;}
    if(message.action==='open-action'){current.selectedIndex=Number(message.index)||0;publish();return;}
    if(message.action==='conversation-open-action'||message.action==='conversation-preview')return;
    if(['approve','deny','note'].includes(message.action)){
      if(!current.canDecide||(message.action==='approve'&&!current.canApprove))return;
      current.review!.pending=false;current.review!.status=message.action==='approve'?'Applied':'Denied';current.canApprove=false;current.canDecide=false;current.conversationAvailable=false;publish();return;
    }
    if(!current.connected||!current.trusted||!current.review?.pending)return;
    if(message.action==='chat-action'){
      const index=Number(message.index)||0;
      if(!current.review.changes[index])return;
      let thread=current.actionConversations.find(item=>(message.conversationId?item.id===message.conversationId:item.index===index)&&sameDecision(current.review,item)&&item.status!=='closed');
      if(!thread){thread={...identityOf(current.review),id:`preview-chat-${index}-${current.review.revision}`,index,status:'idle',messages:[]};current.actionConversations.push(thread);}
      current.activeConversationId=thread.id;current.selectedIndex=index;publish();return;
    }
    const thread=current.actionConversations.find(item=>item.id===message.conversationId);
    if(!thread)return;
    if(message.action==='conversation-send'){
      const text=message.text?.trim();if(!text||text.length>3000||thread.status==='running'||!sameDecision(current.review,thread))return;
      if(query.get('sendError')==='1'){failure(thread.id,'Connection interrupted. Your draft is safe; try again.');return;}
      forks.add(thread.id);requests++;thread.status='running';thread.error=undefined;thread.messages.push({role:'user',text},{role:'assistant',text:''});publish();scheduleReply(thread.id,text);return;
    }
    if(message.action==='conversation-stop'){thread.status='ready';if(!thread.messages.at(-1)?.text)thread.messages.at(-1)!.text='Reply stopped. The proposed step is unchanged.';publish();return;}
    if(message.action==='conversation-discard'){thread.candidate=undefined;publish();return;}
    if(message.action==='conversation-adopt'){
      if(!thread.candidate||thread.candidate.id!==message.candidateId||!current.canApprove)return;
      current.review.changes[thread.index]=structuredClone(thread.candidate.preview);current.review.revision++;current.review.fingerprint=`preview-v${current.review.revision}`;
      current.adoptedRevision={sessionId:current.session!.sessionId,conversationId:thread.id,identity:identityOf(current.review)};
      current.actionConversations.forEach(item=>{item.status='closed';item.candidate=undefined;});current.activeConversationId=undefined;publish();
    }
  };
  window.__PAIR_PREVIEW__={get state(){return current;},messages,get forks(){return forks.size;},get requests(){return requests;},patch(value){current={...current,...structuredClone(value)};publish();},reset(next=scenario){for(const timer of timers)clearTimeout(timer);timers.clear();current=fixture(next);messages.length=0;forks.clear();requests=0;publish();}};
  return {initialState:current,postMessage,getState:<T,>()=>local as T|undefined,setState:<T,>(value:T)=>{local=value;sessionStorage.setItem(localKey,JSON.stringify(value));},subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},ready(){postMessage({action:'webview-ready'});}};
}
