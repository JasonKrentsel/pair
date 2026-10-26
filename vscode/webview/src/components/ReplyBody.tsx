import { ChevronDown, RotateCcw, Terminal } from 'lucide-react';
import type { ChatMessage } from '../types';
import { Markdown } from './Markdown';

function jsonBlock(text:string) {
  // A longer fence preserves argument strings containing Markdown fences.
  const fence='~'.repeat(Math.max(3,...Array.from(text.matchAll(/~+/g),match=>match[0].length+1)));
  return `${fence}json\n${text}\n${fence}`;
}

export function ReplyBody({message,running,retry,canRetry}:{message:ChatMessage;running:boolean;retry?:()=>void;canRetry:boolean}) {
  const usage=message.usage;
  return <>
    {(message.reasoning || message.reasoningRedacted) && <details className="reply-details reasoning-details"><summary><ChevronDown size={13}/><span>Reasoning</span>{running && <span className="detail-meta">Streaming</span>}</summary><div className="reply-detail-content">{message.reasoning && <Markdown text={message.reasoning}/>} {message.reasoningRedacted && <p className="detail-caption">Some reasoning was withheld by the provider.</p>}</div></details>}
    {message.toolCalls?.map((call,index)=><details className="reply-details tool-details" key={`${call.id}:${index}`}><summary><Terminal size={13}/><code>{call.name || 'Tool request'}</code><span className="tool-not-run" title="Chat cannot execute tool requests">Not run</span><ChevronDown size={13}/></summary><div className="reply-detail-content"><p className="detail-caption">Requested arguments</p><Markdown text={jsonBlock(call.arguments)}/></div></details>)}
    {message.text.trim() ? <Markdown text={message.text}/> : running && !message.reasoning && !message.toolCalls?.length ? <div className="thinking-state"><span/><span/><span/><span className="sr-only">Preparing a response</span></div> : null}
    {message.error && <div className="reply-failure" role="status"><strong>Reply interrupted</strong><p>{message.error}</p>{retry && <button className="button secondary retry-button" onClick={retry} disabled={!canRetry}><RotateCcw size={13}/>Retry reply</button>}</div>}
    {message.rawResponse && <details className="reply-details"><summary><ChevronDown size={13}/>Response details</summary><div className="reply-detail-content"><p className="detail-caption">Rejected response; no revision was accepted.</p><pre tabIndex={0}><code>{message.rawResponse}</code></pre></div></details>}
    {usage && <details className="reply-details usage-details"><summary><ChevronDown size={13}/><span>{usage.cacheRead ? `Usage · ${usage.cacheRead.toLocaleString()} cached tokens` : 'Usage · cache unconfirmed'}</span></summary><div className="reply-detail-content"><dl>{([['Input',usage.input],['Output',usage.output],['Cache read',usage.cacheRead],['Cache write',usage.cacheWrite],['Reasoning',usage.reasoning]] as const).map(([label,value])=>value===undefined?null:<div key={label}><dt>{label}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl><p className="detail-caption">Token counts from Pi’s SDK. Zero may mean a cache miss or missing data. This chat reuses its own context; parent-cache sharing is unconfirmed.</p></div></details>}
  </>;
}
