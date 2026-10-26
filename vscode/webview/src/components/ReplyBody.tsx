import { ChevronDown, RotateCcw } from 'lucide-react';
import type { ChatMessage } from '../types';
import { ReplyContent, ReplyUsage } from './ReplyContent';

export function ReplyBody({message,running,retry,canRetry}:{message:ChatMessage;running:boolean;retry?:()=>void;canRetry:boolean}) {
  return <>
    <ReplyContent message={message} running={running}/>
    {message.error&&<div className="reply-failure" role="status"><strong>Reply interrupted</strong><p>{message.error}</p>{retry&&<button className="button secondary retry-button" onClick={retry} disabled={!canRetry}><RotateCcw size={13}/>Retry reply</button>}</div>}
    {message.rawResponse&&<details className="reply-details"><summary><ChevronDown size={13}/>Response details</summary><div className="reply-detail-content"><p className="detail-caption">Rejected response; no revision was accepted.</p><pre tabIndex={0}><code>{message.rawResponse}</code></pre></div></details>}
    {message.usage&&<ReplyUsage usage={message.usage}/>}
  </>;
}
