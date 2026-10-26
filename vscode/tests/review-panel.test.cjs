const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { renderReviewPanel, commandTitle } = require('../review-panel.cjs');
const step = () => ({ id:'r1', revision:1, fingerprint:'exact', gate:1, pending:true, status:'Awaiting permission', title:'Extract the prompt', why:'Move the instructions without changing their meaning.', changes:[{kind:'Write',label:'prompts/orchestrator.md',added:3,removed:0,why:'Make instructions independently readable.'},{kind:'powershell',command:'# Check the prompt\nGet-Content prompts/orchestrator.md',why:'Verify the file before loading it.'}] });
const options = review => ({ review, version:'0.9.0', session:{root:'C:/project',sessionId:'s1'}, connected:true, canApprove:true, canDecide:true });
test('pending controls are scoped to one exact step and disappear for running and completed steps', () => {
  const review = step(), html = renderReviewPanel(options(review));
  assert.match(html,/Runs all 2 actions in order/);
  assert.match(html,/"reviewId":"r1","revision":1,"fingerprint":"exact","gate":1/);
  for (const status of ['Applying 2/2', 'Applied', 'Denied']) {
    const result = renderReviewPanel(options({...review, pending:false, status}));
    assert.doesNotMatch(result,/data-action="(?:approve|deny|note)"/);
    assert.match(result,/data-action="open-action"/);
  }
  const disconnected = renderReviewPanel({...options(review),connected:false,canApprove:false,canDecide:false});
  assert.match(disconnected,/data-action="approve" disabled/);
  assert.match(disconnected,/Reconnect to Pi/);
});
test('action labels and explanations are readable and untrusted markup is inert', () => {
  assert.equal(commandTitle('# Check the prompt\nnode test.mjs'), 'Check the prompt');
  assert.equal(commandTitle('npm run check\nnpm test'),'npm run check');
  assert.equal(commandTitle('node ' + 'x'.repeat(300)).length,100);
  assert.match(commandTitle('node ' + 'x'.repeat(300)),/…$/);
  const review=step();review.title='<img src=x onerror=alert(1)>';review.why='</script><iframe src=x>';review.changes[0].why='**Keep** `instructions` readable.';
  const html=renderReviewPanel(options(review));
  assert.doesNotMatch(html,/<img|<iframe/);assert.match(html,/<strong>Keep<\/strong>/);
  assert.match(html,/orchestrator.md/);assert.match(html,/Check the prompt/);
  assert.doesNotMatch(html,/Review Desk|Checkpoint|Section feedback|Send question/);
});
test('scroll and explanation disclosure restore locally without sending a message or approving', () => {
  const html=renderReviewPanel(options(step())), script=html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1];
  const events={}, posted=[], states=[], main={scrollTop:0,addEventListener:(type,fn)=>events[type]=fn};
  const detail={dataset:{detail:'0'},open:true,addEventListener:(type,fn)=>events[type]=fn};
  const saved={key:'r1:1',selection:0,scroll:142,details:{0:false}};
  const api={getState:()=>saved,setState:value=>states.push(value),postMessage:value=>posted.push(value)};
  vm.runInNewContext(script,{acquireVsCodeApi:()=>api,document:{querySelector:()=>main,querySelectorAll:selector=>selector==='[data-detail]'?[detail]:[]}});
  assert.equal(main.scrollTop,142);assert.equal(detail.open,false);assert.equal(posted.length,0);
  main.scrollTop=200;events.scroll();assert.equal(states.at(-1).scroll,200);assert.equal(posted.length,0);
});

test('changing selected actions expands their own rationale instead of restoring the old row', () => {
 const html=renderReviewPanel({...options(step()),selectedIndex:1}),script=html.match(/<script nonce="[^"]+">([\s\S]+)<\/script>/)[1];
 const details=[{dataset:{detail:'0'},open:false,addEventListener(){}},{dataset:{detail:'1'},open:true,addEventListener(){}}];
 const main={scrollTop:0,addEventListener(){}};const api={getState:()=>({key:'r1:1',selection:0,scroll:140,details:{0:true,1:false}}),setState(){},postMessage(){throw Error('Navigation must stay local');}};
 vm.runInNewContext(script,{acquireVsCodeApi:()=>api,document:{querySelector:()=>main,querySelectorAll:s=>s==='[data-detail]'?details:[]}});
 assert.equal(details[0].open,false);assert.equal(details[1].open,true);assert.equal(main.scrollTop,140);
});

test('each pending action has one Chat entry and never separate question or revision modes',()=>{
 const review=step();const html=renderReviewPanel({...options(review),conversationAvailable:true});
 assert.equal((html.match(/data-action="chat-action"/g)||[]).length,2);
 assert.doesNotMatch(html,/data-action="ask-action"|data-action="adjust-action"|>Adjust<|>Ask</);
 const conversation={id:'c1',reviewId:review.id,revision:review.revision,fingerprint:review.fingerprint,gate:review.gate,index:0,status:'ready',messages:[]};
 const resumed=renderReviewPanel({...options(review),conversationAvailable:true,actionConversations:[conversation]});
 assert.match(resumed,/data-conversation-id="c1"/);assert.match(resumed,/Continue chat about orchestrator.md/);
});
