import { ChevronDown, CircleCheck, CircleX, Terminal } from 'lucide-react';
import type { ActionReplyPart, ChatMessage } from '../types';
import { Markdown } from './Markdown';

function jsonBlock(text:string) {
  const fence='~'.repeat(Math.max(3,...Array.from(text.matchAll(/~+/g),match=>match[0].length+1)));
  return `${fence}json\n${text}\n${fence}`;
}

function Reasoning({text,redacted,running}:{text:string;redacted?:boolean;running:boolean}) {
  if(!text&&!redacted)return null;
  return <details className="reply-details reasoning-details">
    <summary><ChevronDown size={14}/><span>Reasoning</span>{running&&<span className="detail-meta">Streaming</span>}</summary>
    <div className="reply-detail-content">{text&&<Markdown text={text}/>} {redacted&&<p className="detail-caption">Some reasoning was withheld by the provider.</p>}</div>
  </details>;
}

function ToolActivity({call}:{call:Extract<ActionReplyPart,{type:'tool'}>}) {
  const label={running:'Running',completed:'Completed',failed:'Failed','not-run':'Not run'}[call.status];
  return <details className={`reply-details tool-details tool-${call.status}`}>
    <summary><Terminal size={14}/><code>{call.name||'Tool request'}</code><span className="tool-state">{call.status==='running'?<span className="working-dot"/>:call.status==='completed'?<CircleCheck size={13}/>:call.status==='failed'?<CircleX size={13}/>:null}{label}</span><ChevronDown size={14}/></summary>
    <div className="reply-detail-content tool-content">
      <div className="tool-section"><h3>Input</h3><Markdown text={jsonBlock(call.arguments)}/></div>
      {call.result!==undefined&&<div className="tool-section"><h3>Result</h3><pre tabIndex={0} aria-label={`${call.name} result`}><code>{call.result||'No matches or output.'}</code></pre></div>}
      {call.error&&<p className="tool-error">{call.error}</p>}
    </div>
  </details>;
}

export function ReplyContent({message,running}:{message:ChatMessage;running:boolean}) {
  if(message.parts?.length)return <div className="reply-parts">{message.parts.map((part,index)=>
    part.type==='text'?<Markdown key={part.id} text={part.text}/>:
    part.type==='reasoning'?<Reasoning key={part.id} text={part.text} redacted={part.redacted} running={running&&index===message.parts!.length-1}/>:
    <ToolActivity key={part.id} call={part}/>)}</div>;
  return <>
    <Reasoning text={message.reasoning||''} redacted={message.reasoningRedacted} running={running}/>
    {message.toolCalls?.map((call,index)=><ToolActivity key={`${call.id}:${index}`} call={{...call,type:'tool'}}/>)}
    {message.text.trim()?<Markdown text={message.text}/>:running&&!message.reasoning&&!message.toolCalls?.length?<div className="thinking-state"><span/><span/><span/><span className="sr-only">Preparing a response</span></div>:null}
  </>;
}

export function ReplyUsage({usage}:{usage:NonNullable<ChatMessage['usage']>}) {
  return <details className="reply-details usage-details"><summary><ChevronDown size={13}/><span>{usage.cacheRead?`Usage · ${usage.cacheRead.toLocaleString()} cached tokens`:'Usage · cache unconfirmed'}</span></summary><div className="reply-detail-content"><dl>{([['Input',usage.input],['Output',usage.output],['Cache read',usage.cacheRead],['Cache write',usage.cacheWrite],['Reasoning',usage.reasoning]] as const).map(([label,value])=>value===undefined?null:<div key={label}><dt>{label}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl><p className="detail-caption">Totals for this reply’s model requests. Zero may mean a cache miss or missing provider data. Follow-ups reuse this chat’s context; parent-cache sharing is unconfirmed.</p></div></details>;
}
