import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpRight, Check, ChevronDown, CircleCheck, CircleDot, Code2, FileCode2, FileText, GitCompareArrows, Layers3, MessageCircle, MoreHorizontal, ShieldCheck, Square, Terminal, Unplug } from 'lucide-react';
import * as Collapsible from '@radix-ui/react-collapsible';
import type { PairState, PairTransport } from './types';
import { Markdown } from './components/Markdown';
import { actionLabel, identityOf, permissionBlocker, reviewStatus, sameIdentity, type LocalState } from './ui-state';
import './styles.css';

type Props = { state: PairState; transport: PairTransport };
type Conversation = NonNullable<PairState['actionConversations']>[number];
type Change = NonNullable<PairState['review']>['changes'][number];

function ActionIcon({ change, size = 16 }: { change: Change; size?: number }) {
  return typeof change.command === 'string' ? <Terminal size={size} /> : /\.md$/i.test(change.label) ? <FileText size={size} /> : <FileCode2 size={size} />;
}

function Delta({ added = 0, removed = 0 }: { added?: number; removed?: number }) {
  return <span className="delta" aria-label={`${added} added, ${removed} removed`}><span className="added">+{added}</span><span className="removed">−{removed}</span></span>;
}

function Notice({ children, tone = 'warning' }: { children: React.ReactNode; tone?: string }) {
  return <div className={`notice ${tone}`} role={tone === 'warning' ? 'alert' : 'status'}>{children}</div>;
}

export default function App({ state, transport }: Props) {
  const conversation = state.actionConversations?.find(item => item.id === state.activeConversationId);
  return <div className="pair-app" data-view={conversation ? 'chat' : 'step'}>
    {conversation ? <Chat key={`${state.session?.sessionId}:${conversation.id}`} state={state} transport={transport} conversation={conversation} />
      : <Review state={state} transport={transport} />}
  </div>;
}

function Review({ state, transport }: Props) {
  const { review, selectedIndex = 0 } = state;
  const status = reviewStatus(state);
  const reviewKey = `${state.session?.sessionId || ''}:${review?.id || 'empty'}:${review?.revision || 0}`;
  const saved = transport.getState<LocalState>()?.review;
  const main = useRef<HTMLElement>(null);
  const [details, setDetails] = useState<Record<number, boolean>>(() => saved?.key === reviewKey && saved.selection === selectedIndex ? saved.details : { [selectedIndex]: true });
  const keyRef = useRef(reviewKey);
  const selectionRef = useRef(selectedIndex);
  const mounted = useRef(false);

  useEffect(() => {
    const prior = transport.getState<LocalState>()?.review;
    if (!mounted.current || keyRef.current !== reviewKey) {
      mounted.current = true;
      if (main.current) main.current.scrollTop = prior?.key === reviewKey ? prior.scroll : 0;
      setDetails(prior?.key === reviewKey && prior.selection === selectedIndex ? prior.details : { [selectedIndex]: true });
    } else if (selectionRef.current !== selectedIndex) {
      setDetails({ [selectedIndex]: true });
    }
    keyRef.current = reviewKey;
    selectionRef.current = selectedIndex;
  }, [reviewKey, selectedIndex, transport]);

  const persist = (nextDetails = details) => transport.setState<LocalState>({ ...transport.getState<LocalState>(), review: { key: reviewKey, selection: selectedIndex, scroll: main.current?.scrollTop || 0, details: nextDetails } });
  const send = (action: string, index?: number, conversationId?: string) => {
    persist();
    transport.postMessage({ action, identity: identityOf(review), index, conversationId });
  };
  const toggle = (index: number, open: boolean) => {
    const next = { ...details, [index]: open };
    setDetails(next); persist(next);
  };
  const changes = review?.changes || [];
  const commands = changes.filter(change => typeof change.command === 'string').length;
  const files = new Set(changes.filter(change => typeof change.command !== 'string').map(change => change.label.replace(/\\/g, '/'))).size;
  const blocker = permissionBlocker(state);
  const project = state.session?.root.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || 'Pair';
  const running = status.tone === 'running';

  return <>
    <header className="project-header">
      <div className="brand-mark" aria-hidden="true"><Layers3 size={16} /></div>
      <div className="project-name" title={state.session?.root || 'Pair for Pi'}>{project}</div>
      <span className={`connection-indicator ${state.connected ? 'online' : ''}`} role="img" title={state.connected ? 'Connected to Pi' : 'Disconnected'} aria-label={state.connected ? 'Connected to Pi' : 'Disconnected'} />
      <button className="icon-button" aria-label={state.session ? 'Select Pi session' : 'Connect to Pi'} title={state.session ? 'Select Pi session' : 'Connect to Pi'} onClick={() => send('session')}><MoreHorizontal size={18} /></button>
    </header>
    <main ref={main} className="review-scroll" data-testid="step-scroll" onScroll={() => persist()}>
      {review ? <>
        <section className="step-intro">
          <div className="eyebrow-row"><span className={`status-label ${status.tone}`}><span className="status-dot" />{status.label}</span><span className="revision-label">Step · {changes.length} {changes.length === 1 ? 'action' : 'actions'}</span></div>
          <h1>{review.title}</h1>
          {review.why && <Markdown text={review.why} className="step-rationale" />}
          <div className="step-composition">
            {files > 0 && <span><FileCode2 size={13} />{files} {files === 1 ? 'file' : 'files'}</span>}
            {commands > 0 && <span><Terminal size={13} />{commands} {commands === 1 ? 'command' : 'commands'}</span>}
            <span className="ordered-label">In execution order</span>
          </div>
        </section>
        <ol className="action-list" aria-label="Actions in execution order">
          {changes.map((change, index) => {
            const command = typeof change.command === 'string';
            const selected = index === selectedIndex;
            const label = actionLabel(change);
            const fileParts = (change.label || '').replace(/\\/g, '/').split('/');
            const directory = fileParts.slice(0, -1).join('/');
            const why = change.why && (changes.length > 1 || change.why.trim() !== review.why?.trim());
            const hasDetails = !!why || !!change.annotations?.length;
            const conversation = state.actionConversations?.filter(item => item.index === index && sameIdentity(review, item) && !['closed', 'stale'].includes(item.status)).at(-1);
            return <li key={`${review.id}:${index}`} className={`action-card ${selected ? 'selected' : ''}`}>
              <button className="action-open" onClick={() => send('open-action', index)} aria-current={selected ? 'step' : undefined} aria-label={command ? `Open command ${index + 1}: ${label}` : `Open diff for ${change.label}`} title={command ? 'Open command and output' : `Open diff for ${change.label}`}>
                <span className={`action-symbol ${command ? 'command' : ''}`}><ActionIcon change={change} /></span>
                <span className="action-name-group"><span className="action-caption"><span>{String(index + 1).padStart(2, '0')}</span><span>{command ? 'Command' : change.kind || 'Edit file'}</span>{change.interactive && <span className="interactive-tag">Interactive</span>}</span><span className={`action-name ${command ? 'command-name' : ''}`}>{label}</span>{!command && directory && <span className="action-directory">{directory}/</span>}</span>
                <ArrowUpRight size={15} className="open-arrow" />
              </button>
              <div className="action-detail-row">
                {!command ? <Delta added={change.added} removed={change.removed} /> : <span className="shell-label">{change.kind || 'Shell'}</span>}
                {change.status ? <span className="action-result"><CircleCheck size={12} />{change.status}</span> : selected && <span className="selected-label"><CircleDot size={11} />In editor</span>}
              </div>
              {(hasDetails || review.pending && state.conversationAvailable) && <Collapsible.Root open={!!details[index]} onOpenChange={open => toggle(index, open)}>
                <div className="action-toolbar">
                  {hasDetails ? <Collapsible.Trigger className="quiet-button disclosure"><ChevronDown size={14} />Why this action</Collapsible.Trigger> : <span />}
                  {review.pending && state.conversationAvailable && <button className="chat-action" onClick={() => send('chat-action', index, conversation?.id)} aria-label={`${conversation ? 'Continue chat about' : 'Chat about'} ${label}`}><MessageCircle size={13} />Chat{conversation?.messages.length ? <span className="chat-count">{Math.ceil(conversation.messages.length / 2)}</span> : null}</button>}
                </div>
                {hasDetails && <Collapsible.Content className="action-explanation"><div className="explanation-inner">{why && <Markdown text={change.why} />}{change.annotations?.map((note, noteIndex) => <div className="section-note" key={noteIndex}><div className="section-note-heading"><strong>{note.title}</strong><span>Lines {note.startLine}{note.endLine && note.endLine !== note.startLine ? `–${note.endLine}` : ''}</span></div><Markdown text={note.why} /></div>)}</div></Collapsible.Content>}
              </Collapsible.Root>}
            </li>;
          })}
        </ol>
      </> : <section className="empty-step"><div className="empty-symbol">{state.connected ? <Layers3 size={27} /> : <Unplug size={27} />}</div><div className="eyebrow">{state.connected ? 'All set' : 'Pair for Pi'}</div><h1>{status.title}</h1><p>{state.connected ? 'Proposed edits and commands will appear here, ready for you to review.' : 'Open the same project in Pi and VS Code, then enable Pair in Pi.'}</p>{!state.connected && <button className="button secondary" onClick={() => send('session')}>Connect to Pi<ArrowUpRight size={14} /></button>}</section>}
    </main>
    <footer className={`decision-footer ${review?.pending ? '' : 'quiet-footer'}`}>
      {blocker && <Notice>{blocker}</Notice>}
      {review?.pending ? <><div className="approval-scope"><ShieldCheck size={14} /><span>{changes.length === 1 ? 'Approve this action once' : `Approve all ${changes.length} actions in order`}</span></div><button className="button primary approve-button" onClick={() => send('approve')} disabled={!state.canApprove || state.busy}><Check size={17} />{state.busy ? 'Sending decision…' : 'Approve step'}</button><div className="decision-secondary"><button className="button secondary" onClick={() => send('note')} disabled={!state.canDecide || state.busy}><MessageCircle size={14} />Deny with note</button><button className="quiet-button deny-button" onClick={() => send('deny')} disabled={!state.canDecide || state.busy}>Deny</button></div></>
        : <div className="footer-message">{review?.status === 'Applied' ? <CircleCheck size={15} /> : running ? <span className="working-dot" /> : <ShieldCheck size={15} />}<span>{running ? 'Follow progress in the center editor.' : review?.status === 'Applied' ? 'Complete. Diffs and output are still available.' : review ? 'This step is no longer awaiting approval.' : state.connected ? 'Nothing runs without your approval.' : 'Your next step will appear here.'}</span></div>}
    </footer>
  </>;
}

function Chat({ state, transport, conversation }: Props & { conversation: Conversation }) {
  const { review } = state;
  const change = review?.changes[conversation.index];
  const command = typeof change?.command === 'string';
  const label = actionLabel(change);
  const source = change?.after ?? change?.command ?? '';
  const scope = conversation.scope || conversation;
  const selectedLines = Number.isInteger(scope.startLine);
  const current = !!review?.pending && sameIdentity(review, conversation);
  const locked = !current || ['closed', 'stale'].includes(conversation.status);
  const adopted = state.adoptedRevision?.conversationId === conversation.id && state.adoptedRevision.sessionId === state.session?.sessionId && sameIdentity(review, state.adoptedRevision.identity) && review?.pending;
  const running = conversation.status === 'running';
  const ready = state.connected && state.trusted && !state.busy && !state.conversationBusy && !locked;
  const candidate = conversation.candidate;
  const identity = identityOf(conversation);
  const initialDraft = transport.getState<LocalState>()?.conversationDrafts?.[conversation.id];
  const [draft, setDraft] = useState(initialDraft?.draft || '');
  const [following, setFollowing] = useState(initialDraft?.following !== false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState('');
  const [scopeOpen, setScopeOpen] = useState(false);
  const transcript = useRef<HTMLElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const pending = useRef<{ text: string; id: string; original: string; count: number } | undefined>(undefined);
  const focusPending = useRef(current && state.connected && state.trusted && !running);
  const followingRef = useRef(following);
  const draftRef = useRef(draft);
  const scrollRef = useRef(initialDraft?.scroll || 0);
  const mounted = useRef(false);
  const messages = conversation.messages || [];
  const excerpt = selectedLines && current ? source.split(/\r\n|\r|\n/).slice((scope.startLine || 1) - 1, scope.endLine || scope.startLine).join('\n') : '';
  const warning = !state.connected ? 'Reconnect to Pi to continue this chat.' : !state.trusted ? 'Trust this workspace before sending a message or using a revision.' : adopted ? '' : locked ? 'This step changed or finished. Return to the step to review its current version.' : sendError || conversation.error || '';
  const statusText = adopted ? 'Revision added · Awaiting approval' : locked ? 'Earlier conversation' : sending ? 'Sending…' : running ? 'Pi is responding…' : candidate ? 'Revision ready to inspect' : messages.length ? 'Step still awaits approval' : 'Starts when you send';

  const save = () => {
    const prior = transport.getState<LocalState>() || {};
    const drafts = { ...prior.conversationDrafts, [conversation.id]: { draft: draftRef.current, following: followingRef.current, scroll: scrollRef.current } };
    const keys = Object.keys(drafts);
    keys.slice(0, Math.max(0, keys.length - 16)).forEach(key => delete drafts[key]);
    transport.setState({ ...prior, conversationDrafts: drafts });
  };
  const updateDraft = (value: string) => { draftRef.current = value; setDraft(value); save(); };
  const sendAction = (action: string) => { save(); transport.postMessage({ action, conversationId: conversation.id, identity, index: conversation.index, candidateId: candidate?.id }); };

  useEffect(() => {
    const cancelFocus = () => { focusPending.current = false; };
    document.addEventListener('pointerdown', cancelFocus, { capture: true, once: true });
    document.addEventListener('keydown', cancelFocus, { capture: true, once: true });
    window.addEventListener('blur', cancelFocus, { once: true });
    return () => {
      document.removeEventListener('pointerdown', cancelFocus, true);
      document.removeEventListener('keydown', cancelFocus, true);
      window.removeEventListener('blur', cancelFocus);
      save();
    };
  }, []);

  useEffect(() => {
    if (focusPending.current && ready && !running) { focusPending.current = false; textarea.current?.focus(); }
  }, [ready, running]);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      if (transcript.current && !followingRef.current) transcript.current.scrollTop = scrollRef.current;
    }
    if (transcript.current && followingRef.current) {
      transcript.current.scrollTop = transcript.current.scrollHeight;
      scrollRef.current = transcript.current.scrollTop;
    }
    const request = pending.current;
    if (sending && request && (running || messages.filter(message => message.role === 'user').length > request.count)) {
      setSending(false); pending.current = undefined;
      if (draftRef.current === request.original) updateDraft('');
    }
  }, [messages, candidate, running, sending]);

  useEffect(() => {
    const error = state.conversationError;
    if (error && (!error.id || error.id === conversation.id)) { setSending(false); setSendError(error.text); }
  }, [state.conversationError?.sequence]);

  const submit = () => {
    const text = draftRef.current.trim();
    if (!ready || running || sending || !text || text.length > 3000) return;
    const last = pending.current;
    pending.current = { text, id: last?.text === text ? last.id : crypto.randomUUID(), original: draftRef.current, count: messages.filter(message => message.role === 'user').length };
    setSending(true); setSendError(''); setFollowing(true); followingRef.current = true; save();
    transport.postMessage({ action: 'conversation-send', conversationId: conversation.id, identity, index: conversation.index, mode: 'chat', text, requestId: pending.current.id });
  };

  const scroll = () => {
    if (!transcript.current) return;
    const next = transcript.current.scrollHeight - transcript.current.scrollTop - transcript.current.clientHeight < 48;
    followingRef.current = next; scrollRef.current = transcript.current.scrollTop; setFollowing(next); save();
  };
  const latest = () => {
    followingRef.current = true; setFollowing(true);
    if (transcript.current) { transcript.current.scrollTop = transcript.current.scrollHeight; scrollRef.current = transcript.current.scrollTop; }
    save();
  };
  const fillPrompt = (value: string) => { updateDraft(value); textarea.current?.focus(); };

  return <>
    <header className="chat-header">
      <div className="chat-navigation"><button className="back-button" onClick={() => sendAction('conversation-back')}><ArrowLeft size={14} />Back to step</button><span className="eyebrow">Chat</span></div>
      <div className="chat-target"><span className="action-symbol">{change ? <ActionIcon change={change} /> : <Code2 size={16} />}</span><div><h1 title={change?.label || label}>{label}</h1><p>Action {conversation.index + 1} of {review?.changes.length || 1}<span className="meta-separator">·</span><span>{selectedLines ? `Lines ${scope.startLine}${scope.endLine && scope.endLine !== scope.startLine ? `–${scope.endLine}` : ''}` : 'Whole action'}</span></p></div><button className="icon-button" title="Open in editor" aria-label="Open this action in the editor" onClick={() => sendAction('conversation-open-action')}><ArrowUpRight size={17} /></button></div>
      {excerpt && <Collapsible.Root open={scopeOpen} onOpenChange={setScopeOpen} className="source-context"><Collapsible.Trigger className="quiet-button disclosure"><ChevronDown size={13} />Selected code<span className="line-count">{excerpt.split('\n').length} lines</span></Collapsible.Trigger><Collapsible.Content><pre tabIndex={0}><code>{excerpt}</code></pre></Collapsible.Content></Collapsible.Root>}
    </header>
    <div className="transcript-container">
      <main ref={transcript} className="chat-scroll" data-testid="chat-scroll" aria-label="Conversation about this action" onScroll={scroll}>
        {!messages.length ? <section className="empty-chat"><div className="empty-symbol"><MessageCircle size={25} /></div><h2>Work through this part.</h2><p>Ask why it works this way, or describe a small change.</p><div className="prompt-suggestions"><button onClick={() => fillPrompt('Explain how this works and what stays unchanged.')}><MessageCircle size={14} />Explain this {command ? 'command' : 'change'}<ArrowUpRight size={12} /></button><button onClick={() => fillPrompt('Could this be simpler while keeping the same behavior?')}><Code2 size={14} />Explore a simpler approach<ArrowUpRight size={12} /></button></div><p className="empty-chat-note">Only this action is in scope. Nothing runs from chat.</p></section>
          : <div className="messages">{messages.map((message, index) => <article className={`chat-message ${message.role}`} key={message.id || `${index}:${message.role}`}><div className="message-byline">{message.role === 'assistant' && <span className="pi-mark"><Layers3 size={12} /></span>}<span>{message.role === 'user' ? 'You' : 'Pi'}</span>{running && message.role === 'assistant' && index === messages.length - 1 && <span className="working-dot" />}</div>{running && message.role === 'assistant' && !message.text.trim() ? <div className="thinking-state"><span /><span /><span /><span className="sr-only">Preparing a response</span></div> : <Markdown text={message.text} />}</article>)}</div>}
        {candidate && <section className="revision-card" aria-label="Suggested revision"><div className="revision-heading"><span><GitCompareArrows size={15} />Suggested revision</span><Delta added={candidate.added} removed={candidate.removed} /></div><Markdown text={candidate.summary} /><div className="revision-actions"><button className="button secondary" onClick={() => sendAction('conversation-preview')} disabled={!ready}><GitCompareArrows size={14} />Inspect diff</button><button className="button primary" onClick={() => sendAction('conversation-adopt')} disabled={!ready || running}><Check size={15} />Use revision</button></div><div className="revision-note"><span>Updates the proposal. Approval still required.</span><button className="quiet-button" onClick={() => sendAction('conversation-discard')} disabled={!ready || running}>Discard</button></div></section>}
      </main>
      {!following && messages.length > 0 && <button className="latest-button" onClick={latest}><ArrowDown size={13} />Latest response</button>}
    </div>
    <footer className="chat-footer">
      {warning && <Notice>{warning}</Notice>}
      <div className="composer-status"><span role="status" aria-live="polite">{running ? <span className="working-dot" /> : adopted ? <CircleCheck size={12} /> : <ShieldCheck size={12} />}{statusText}</span>{running && <button className="quiet-button stop-button" onClick={() => sendAction('conversation-stop')} disabled={!ready}><Square size={11} />Stop</button>}</div>
      {locked ? <button className="button secondary return-button" onClick={() => sendAction('conversation-back')}><ArrowLeft size={14} />Return to step</button> : <form className={`composer ${sending ? 'sending' : ''}`} onSubmit={event => { event.preventDefault(); submit(); }}>
        <label htmlFor="pair-message" className="sr-only">Message</label><textarea ref={textarea} id="pair-message" name="message" rows={3} value={draft} maxLength={3000} placeholder={command ? 'Ask about this command or suggest a change…' : 'Ask a question or describe a change…'} autoComplete="off" onChange={event => updateDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} aria-describedby="composer-help" />
        <div className="composer-bottom"><span id="composer-help">Enter to send<span className="shortcut-extra"> · Shift+Enter for a new line</span></span><button className="send-button" type="submit" disabled={!ready || running || sending || !draft.trim()} aria-label={sending ? 'Sending message' : 'Send message'}><span>{sending ? 'Sending' : 'Send'}</span><ArrowUp size={15} /></button></div>
      </form>}
    </footer>
  </>;
}
