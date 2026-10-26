import type {PairAdapter,PairState,UiMessage} from './types';

declare global {interface Window {acquireVsCodeApi?:()=>{postMessage(message:UiMessage):void;getState():unknown;setState(value:unknown):void}}}

export function vscodeAdapter():PairAdapter {
  const api=window.acquireVsCodeApi!();
  const element=document.getElementById('pair-bootstrap');
  if(!element?.textContent) throw new Error('Pair did not receive its initial state. Reopen the view.');
  let current=JSON.parse(element.textContent) as PairState,sequence=0;
  const listeners=new Set<(state:PairState)=>void>();
  window.addEventListener('message',event=>{
    const message=event.data;
    if(message?.type==='pair-state' && message.state && typeof message.state.connected==='boolean') current={...message.state,conversationError:message.state.session?.sessionId===current.session?.sessionId?current.conversationError:undefined};
    else if(message?.type==='action-conversation-error') current={...current,conversationError:{id:message.id,text:String(message.text||'The message was not sent. Try again.'),sequence:++sequence}};
    else return;
    for(const listener of listeners) listener(current);
  });
  return {initialState:current,postMessage(message){
    if(message.action==='conversation-send' && current.conversationError && (!current.conversationError.id || current.conversationError.id===message.conversationId)) {
      current={...current,conversationError:undefined};
      for(const listener of listeners) listener(current);
    }
    api.postMessage(message);
  },getState:<T,>()=>api.getState() as T|undefined,setState:<T,>(state:T)=>api.setState(state),subscribe(listener){listeners.add(listener);return()=>{listeners.delete(listener);};},ready(){api.postMessage({action:'webview-ready'});}};
}
