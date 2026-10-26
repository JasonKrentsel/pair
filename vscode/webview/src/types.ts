export interface DecisionIdentity { reviewId: string; revision: number; fingerprint: string; gate?: number }
export interface Annotation { title: string; startLine: number; endLine?: number; why: string }
export interface Change {
  label: string; kind: string; before?: string; after?: string; command?: string; cwd?: string;
  interactive?: boolean; added?: number; removed?: number; why?: string; status?: string; annotations?: Annotation[];
}
export interface Review { id: string; revision: number; fingerprint: string; gate?: number; title: string; why?: string; changes: Change[]; pending: boolean; status: string }
export interface Candidate { id: string; summary: string; added?: number; removed?: number; original: Change; preview: Change }
export type ActionReplyPart =
  | {type:'text';id:string;text:string}
  | {type:'reasoning';id:string;text:string;redacted?:boolean}
  | {type:'tool';id:string;name:string;arguments:string;status:'running'|'completed'|'failed'|'not-run';result?:string;error?:string};
export interface ChatMessage {
  id?:string; requestId?:string; role:'user'|'assistant'; text:string; error?:string; stopped?:boolean;
  reasoning?:string; reasoningRedacted?:boolean; rawResponse?:string;
  parts?:ActionReplyPart[];
  toolCalls?:Omit<Extract<ActionReplyPart,{type:'tool'}>,'type'>[];
  usage?:{input?:number;output?:number;cacheRead?:number;cacheWrite?:number;reasoning?:number};
}
export interface Conversation extends DecisionIdentity {
  id: string; index: number; identity?: DecisionIdentity; startLine?: number; endLine?: number;
  scope?: {startLine?:number;endLine?:number;excerpt?:string};
  status: 'idle'|'running'|'ready'|'error'|'closed'|'stale';
  messages: ChatMessage[]; candidate?: Candidate; error?: string;
}
export interface PairState {
  version: string; session?: {sessionId:string;root:string}; sessionsCount: number;
  connected: boolean; busy: boolean; review?: Review; selectedIndex: number; trusted: boolean;
  canDecide: boolean; canApprove: boolean; dirtyFiles: string[]; alteredSnapshots: number; errorMessage: string;
  conversationAvailable: boolean; actionConversations: Conversation[]; activeConversationId?: string; conversationBusy: boolean;
  adoptedRevision?: {sessionId:string;conversationId:string;identity:DecisionIdentity};
  conversationError?: {id?:string;text:string;sequence:number};
}
export interface UiMessage {action:string;identity?:DecisionIdentity;index?:number;conversationId?:string;candidateId?:string;mode?:'chat';text?:string;requestId?:string;[key:string]:unknown}
export interface PairTransport {postMessage(message:UiMessage):void;getState<T=Record<string,unknown>>():T|undefined;setState<T>(state:T):void}
export interface PairAdapter extends PairTransport {initialState:PairState;subscribe(listener:(state:PairState)=>void):()=>void;ready():void}
export const identityOf = (review:Review):DecisionIdentity => ({reviewId:review.id,revision:review.revision,fingerprint:review.fingerprint,gate:review.gate});
export const sameDecision = (review:Review|undefined,identity:DecisionIdentity|undefined):boolean => !!review && !!identity && review.id===identity.reviewId && review.revision===identity.revision && review.fingerprint===identity.fingerprint && (review.gate??1)===(identity.gate??1);
