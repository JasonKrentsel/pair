import { ChevronDown, RotateCcw, Terminal } from 'lucide-react';
import type { ChatMessage } from '../types';
import { Markdown } from './Markdown';

export function ReplyBody({message,running,retry,canRetry}:{message:ChatMessage;running:boolean;retry?:()=>void;canRetry:boolean}) {
  const usage=message.usage;
  return <>
    {(message.reasoning || message.reasoningRedacted) && <details className="reply-details reasoning-details"><summary><ChevronDown size={13}/><span>Reasoning</span>{running && <span className="detail-meta">Streaming</span>}</summary><div className="reply-detail-content">{message.reasoning && <Markdown text={message.reasoning}/>}<p className="detail-caption">{message.reasoningRedacted?'Some reasoning was withheld by the provider.':'Reasoning supplied by the model.'}</p></div></details>}
    {message.toolCalls?.map((call,index)=><details className="reply-details tool-details" key={`${call.id}:${index}`}><summary><Terminal size={13}/><code>{call.name || 'Tool call'}</code><span className="tool-not-run">Not run</span><ChevronDown size={13}/></summary><div className="reply-detail-content"><p className="detail-caption">The model requested this tool. Action Chat cannot execute tools.</p><pre tabIndex={0}><code>{call.arguments}</code></pre></div></details>)}
    {message.text.trim() ? <Markdown text={message.text}/> : running && !message.reasoning && !message.toolCalls?.length ? <div className="thinking-state"><span/><span/><span/><span className="sr-only">Preparing a response</span></div> : null}
    {message.error && <div className="reply-failure" role="status"><strong>Reply interrupted</strong><p>{message.error}</p>{retry && <button className="button secondary retry-button" onClick={retry} disabled={!canRetry}><RotateCcw size={13}/>Retry reply</button>}</div>}
    {message.rawResponse && <details className="reply-details"><summary><ChevronDown size={13}/>Response details</summary><div className="reply-detail-content"><p className="detail-caption">Unaccepted model output. This is diagnostic text, not an actionable revision.</p><pre tabIndex={0}><code>{message.rawResponse}</code></pre></div></details>}
    {usage && <details className="reply-details usage-details"><summary><ChevronDown size={13}/><span>{usage.cacheRead ? `${usage.cacheRead.toLocaleString()} cached tokens` : 'Usage · cache unconfirmed'}</span></summary><div className="reply-detail-content"><dl>{([['Input',usage.input],['Output',usage.output],['Cache read',usage.cacheRead],['Cache write',usage.cacheWrite],['Reasoning',usage.reasoning]] as const).map(([label,value])=>value===undefined?null:<div key={label}><dt>{label}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl><p className="detail-caption">Reported through Pi’s model SDK. Zero cache tokens can mean a miss or missing provider data. The child reuses its own context; parent-cache sharing is not guaranteed.</p></div></details>}
  </>;
}
