import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function preview(page:Page,scenario='pending',theme='dark') {
  await page.goto(`/?scenario=${scenario}&theme=${theme}`);
  await expect.poll(()=>page.evaluate(()=>Boolean(window.__PAIR_PREVIEW__))).toBe(true);
}
const state=(page:Page)=>page.evaluate(()=>window.__PAIR_PREVIEW__!.state);
const messages=(page:Page)=>page.evaluate(()=>window.__PAIR_PREVIEW__!.messages);
const chat=(page:Page)=>page.getByRole('button',{name:/^(chat|continue chat)( about)?/i}).first();
const input=(page:Page)=>page.getByRole('textbox',{name:'Message',exact:true});
const back=(page:Page)=>page.getByRole('button',{name:/back to step/i});
const send=(page:Page)=>page.getByRole('button',{name:'Send message',exact:true});

test('opening and drafting stay local; one chat reuses its child for natural follow-ups',async({page})=>{
  await preview(page);await chat(page).click();await expect(input(page)).toBeFocused();
  await expect.poll(()=>page.evaluate(()=>({forks:window.__PAIR_PREVIEW__!.forks,requests:window.__PAIR_PREVIEW__!.requests}))).toEqual({forks:0,requests:0});
  await input(page).fill('Keep this draft while I inspect the step');
  await back(page).click();await chat(page).click();await expect(input(page)).toHaveValue('Keep this draft while I inspect the step');
  await expect.poll(()=>page.evaluate(()=>window.__PAIR_PREVIEW__!.requests)).toBe(0);
  await input(page).fill('Why is the protocol unchanged?');await send(page).click();
  await expect(page.getByText('The public contract stays the same.',{exact:false})).toBeVisible();
  await expect.poll(async()=>(await state(page)).actionConversations[0].status).toBe('ready');
  expect((await state(page)).review?.pending).toBe(true);expect((await state(page)).actionConversations[0].candidate).toBeUndefined();
  await input(page).fill('Explain the fallback too.');await input(page).press('Enter');
  await expect.poll(()=>page.evaluate(()=>window.__PAIR_PREVIEW__!.requests)).toBe(2);
  expect(await page.evaluate(()=>window.__PAIR_PREVIEW__!.forks)).toBe(1);
  expect((await messages(page)).filter(message=>['approve','deny','note'].includes(message.action))).toHaveLength(0);
});

test('a revision changes the proposal only, and the approval carries its new identity',async({page})=>{
  await preview(page);const original=(await state(page)).review!;
  await chat(page).click();await input(page).fill('Trim surrounding whitespace and preserve the fallback.');await send(page).click();
  await expect(page.getByRole('button',{name:'Use revision',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Inspect diff',exact:true}).click();
  expect((await state(page)).review).toEqual(original);
  await page.getByRole('button',{name:'Use revision',exact:true}).click();
  await expect(page.getByRole('button',{name:'Approve step',exact:true})).toBeVisible();
  const revised=(await state(page)).review!;expect(revised.pending).toBe(true);expect(revised.revision).toBe(original.revision+1);
  expect(revised.changes[0].after).toContain('name.trim()');expect(revised.changes.slice(1)).toEqual(original.changes.slice(1));
  expect((await messages(page)).filter(message=>message.action==='approve')).toHaveLength(0);
  await page.getByRole('button',{name:'Approve step',exact:true}).click();
  const approval=(await messages(page)).findLast(message=>message.action==='approve')!;
  expect(approval.identity).toEqual({reviewId:revised.id,revision:revised.revision,fingerprint:revised.fingerprint,gate:revised.gate});
  expect((await state(page)).review?.pending).toBe(false);
});

test('a question preserves an existing suggested revision',async({page})=>{
  await preview(page,'candidate');const candidate=(await state(page)).actionConversations[0].candidate;
  await input(page).fill('Why does this preserve the caller protocol?');await send(page).click();
  await expect.poll(async()=>(await state(page)).actionConversations[0].status).toBe('ready');
  expect((await state(page)).actionConversations[0].candidate).toEqual(candidate);
  await expect(page.getByRole('button',{name:'Use revision',exact:true})).toBeEnabled();
});

test('composer rejects blank sends and respects Shift+Enter and IME',async({page})=>{
  await preview(page);await chat(page).click();await expect(send(page)).toBeDisabled();
  await input(page).fill('  ');await expect(send(page)).toBeDisabled();
  await input(page).fill('Why this approach?');await input(page).press('Shift+Enter');
  await expect(input(page)).toHaveValue('Why this approach?\n');
  await input(page).dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
  expect(await page.evaluate(()=>window.__PAIR_PREVIEW__!.requests)).toBe(0);
  await input(page).press('Enter');await expect.poll(()=>page.evaluate(()=>window.__PAIR_PREVIEW__!.requests)).toBe(1);
});

test('failed Send retains its draft and retry identity',async({page})=>{
  await page.goto('/?scenario=pending&sendError=1');await chat(page).click();await input(page).fill('Explain the fallback.');await send(page).click();
  await expect(page.getByText('Connection interrupted. Your draft is safe; try again.',{exact:true})).toBeVisible();
  await expect(input(page)).toHaveValue('Explain the fallback.');await expect(send(page)).toBeEnabled();
  const first=(await messages(page)).filter(message=>message.action==='conversation-send').at(-1)!;
  await send(page).click();const attempts=(await messages(page)).filter(message=>message.action==='conversation-send');
  expect(attempts).toHaveLength(2);expect(attempts[1].requestId).toBe(first.requestId);
});

test('stale or disconnected conversations cannot send or adopt',async({page})=>{
  await preview(page,'candidate');await page.evaluate(()=>{const controls=window.__PAIR_PREVIEW__!;controls.patch({review:{...controls.state.review!,revision:9,fingerprint:'new-review'}});});
  await expect(input(page)).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Use revision',exact:true})).toBeDisabled();
  await page.evaluate(()=>window.__PAIR_PREVIEW__!.patch({connected:false,canDecide:false,canApprove:false}));
  await expect(input(page)).toHaveCount(0);expect((await messages(page)).filter(message=>message.action==='conversation-adopt')).toHaveLength(0);
});

test('untrusted Markdown stays inert while ordinary code is highlighted',async({page})=>{
  await preview(page,'chat');
  await page.evaluate(()=>{const controls=window.__PAIR_PREVIEW__!,threads=structuredClone(controls.state.actionConversations);threads[0].messages.push({role:'assistant',text:'<img src=x onerror="window.__PAIR_XSS__=true">\n\n[Unsafe](javascript:window.__PAIR_XSS__=true)\n\n```ts\nconst message = "hello";\n```'});controls.patch({actionConversations:threads});});
  await expect(page.locator('code .hljs-keyword').first()).toBeAttached();
  expect(await page.evaluate(()=>Boolean((window as unknown as Record<string,unknown>).__PAIR_XSS__))).toBe(false);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);await expect(page.locator('img[onerror]')).toHaveCount(0);
});

test('scrolling a large step never moves approval controls off screen',async({page})=>{
  await page.setViewportSize({width:300,height:700});await preview(page,'long');
  const approve=page.getByRole('button',{name:'Approve step',exact:true});
  const original=await approve.boundingBox();expect(original).toBeTruthy();
  await page.getByTestId('step-scroll').evaluate(element=>{element.scrollTop=element.scrollHeight;});
  await expect(approve).toBeInViewport();const final=await approve.boundingBox();
  expect(Math.abs(final!.y-original!.y)).toBeLessThan(2);
  expect(final!.y+final!.height).toBeLessThan(700);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('chat streaming preserves a draft, input focus and deliberate scroll position',async({page})=>{
  await preview(page,'chat');
  await page.evaluate(()=>{const controls=window.__PAIR_PREVIEW__!,threads=structuredClone(controls.state.actionConversations);threads[0].messages[1].text=Array.from({length:30},(_,index)=>`Paragraph ${index+1}: the selected action preserves the public request and response contract.`).join('\n\n');controls.patch({actionConversations:threads});});
  await input(page).fill('Keep this follow-up draft.');
  const scroll=page.getByTestId('chat-scroll');await scroll.evaluate(element=>{element.scrollTop=110;});
  await expect(page.getByRole('button',{name:'Latest response',exact:true})).toBeVisible();
  const before=await scroll.evaluate(element=>element.scrollTop);
  await page.evaluate(()=>{const controls=window.__PAIR_PREVIEW__!,threads=structuredClone(controls.state.actionConversations);threads[0].messages[1].text+='\n\nA newly streamed conclusion.';controls.patch({actionConversations:threads});});
  await expect(input(page)).toHaveValue('Keep this follow-up draft.');await expect(input(page)).toBeFocused();
  expect(Math.abs(await scroll.evaluate(element=>element.scrollTop)-before)).toBeLessThan(2);
  await back(page).click();await chat(page).click();await expect(input(page)).toHaveValue('Keep this follow-up draft.');
  expect(Math.abs(await scroll.evaluate(element=>element.scrollTop)-before)).toBeLessThan(2);
});

test('suggestions only fill the composer and blocked approval remains disabled',async({page})=>{
  await preview(page);await chat(page).click();
  await page.getByRole('button',{name:/Explain this change/}).click();await expect(input(page)).toHaveValue('Explain how this works and what stays unchanged.');
  expect(await page.evaluate(()=>({forks:window.__PAIR_PREVIEW__!.forks,requests:window.__PAIR_PREVIEW__!.requests}))).toEqual({forks:0,requests:0});
  await back(page).click();await page.evaluate(()=>window.__PAIR_PREVIEW__!.patch({canApprove:false,dirtyFiles:['src/greeting/display-name.ts']}));
  await expect(page.getByRole('button',{name:'Approve step',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Deny',exact:true})).toBeEnabled();
});

for(const theme of ['dark','light'])for(const scenario of ['pending','chat','candidate','disconnected']){
  test(`accessible ${theme} ${scenario}`,async({page})=>{
    await preview(page,scenario,theme);await expect(page.locator('#root')).not.toBeEmpty();
    const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    expect(result.violations.map(item=>({id:item.id,description:item.description,nodes:item.nodes.map(node=>node.target)}))).toEqual([]);
  });
}

for(const width of [300,380,520])for(const scenario of ['pending','chat','candidate','command']){
  test(`visual ${scenario} at ${width}px`,async({page},testInfo)=>{
    await page.setViewportSize({width,height:900});await preview(page,scenario);await expect(page.locator('#root')).not.toBeEmpty();
    await page.screenshot({path:testInfo.outputPath(`${scenario}-${width}.png`),fullPage:true,animations:'disabled'});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(['pending','command'].includes(scenario))await expect(page.getByRole('button',{name:'Approve step',exact:true})).toBeInViewport();
    else await expect(input(page)).toBeInViewport();
  });
}
