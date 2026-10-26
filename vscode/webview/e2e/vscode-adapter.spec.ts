import {test,expect,type Page} from '@playwright/test';
import type {PairState,UiMessage} from '../src/types';

declare global {interface Window {__PAIR_HOST_TEST__?:{messages:UiMessage[]}}}

async function hostApp(page:Page) {
  await page.goto('/?scenario=chat');
  await expect.poll(()=>page.evaluate(()=>Boolean(window.__PAIR_PREVIEW__))).toBe(true);
  const initial=await page.evaluate(()=>window.__PAIR_PREVIEW__!.state);
  await page.addInitScript(()=>{
    const messages:UiMessage[]=[];let local:unknown;
    window.__PAIR_HOST_TEST__={messages};
    window.acquireVsCodeApi=()=>({postMessage(message){messages.push(structuredClone(message));},getState:()=>local,setState:value=>{local=value;}});
  });
  await page.route('**/?host=1',async route=>{
    const response=await route.fetch();
    const bootstrap=`<script type="application/json" id="pair-bootstrap">${JSON.stringify(initial).replace(/</g,'\\u003c')}</script>`;
    await route.fulfill({response,body:(await response.text()).replace('</head>',`${bootstrap}</head>`)});
  });
  await page.goto('/?host=1');
  await expect(page.getByRole('textbox',{name:'Message',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>window.__PAIR_PREVIEW__)).toBeUndefined();
  return initial;
}
async function snapshot(page:Page,state:PairState) {
  await page.evaluate(state=>window.dispatchEvent(new MessageEvent('message',{data:{type:'pair-state',state}})),state);
}
async function error(page:Page,id:string,text:string) {
  await page.evaluate(({id,text})=>window.dispatchEvent(new MessageEvent('message',{data:{type:'action-conversation-error',id,text}})),{id,text});
}

test('real VS Code adapter clears a resolved Send error across success and chat reopen',async({page})=>{
  const initial=await hostApp(page),thread=initial.actionConversations[0],failure='The bridge interrupted this message. Please retry.';
  const input=page.getByRole('textbox',{name:'Message',exact:true}),send=page.getByRole('button',{name:'Send message',exact:true});
  await input.fill('Explain the fallback.');await send.click();
  await error(page,thread.id,failure);await expect(page.getByText(failure,{exact:true})).toBeVisible();
  await snapshot(page,initial);await expect(page.getByText(failure,{exact:true})).toBeVisible();
  await expect(input).toHaveValue('Explain the fallback.');await send.click();
  const requests=await page.evaluate(()=>window.__PAIR_HOST_TEST__!.messages.filter(message=>message.action==='conversation-send'));
  expect(requests).toHaveLength(2);expect(requests[0].requestId).toBe(requests[1].requestId);
  const success=structuredClone(initial);
  success.actionConversations[0].messages.push({role:'user',text:'Explain the fallback.'},{role:'assistant',text:'The fallback provides a friendly display name without changing the response fields.'});
  await snapshot(page,success);await expect(page.getByText(failure,{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Back to step',exact:true}).click();
  await snapshot(page,{...success,activeConversationId:undefined});
  await page.getByRole('button',{name:/^Continue chat about/}).first().click();
  await snapshot(page,success);
  await expect(input).toBeVisible();await expect(page.getByText(failure,{exact:true})).toHaveCount(0);
});

test('real adapter keeps a different chat error but drops errors from a replaced session',async({page})=>{
  const initial=await hostApp(page),first=initial.actionConversations[0];
  const other={...structuredClone(first),id:'second-chat',index:1,messages:[]};
  const twoChats={...initial,actionConversations:[first,other]};
  await snapshot(page,twoChats);await error(page,other.id,'Second chat needs a retry.');
  await page.getByRole('textbox',{name:'Message',exact:true}).fill('Explain the function.');
  await page.getByRole('button',{name:'Send message',exact:true}).click();
  await snapshot(page,{...twoChats,activeConversationId:other.id});
  await expect(page.getByText('Second chat needs a retry.',{exact:true})).toBeVisible();
  await snapshot(page,{...twoChats,session:{sessionId:'replacement-session',root:initial.session!.root},activeConversationId:other.id});
  await expect(page.getByText('Second chat needs a retry.',{exact:true})).toHaveCount(0);
});
