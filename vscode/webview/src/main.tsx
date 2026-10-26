import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import {vscodeAdapter} from './adapter';
import type {PairAdapter} from './types';
import './styles.css';

async function start(){
  const adapter:PairAdapter=window.acquireVsCodeApi ? vscodeAdapter() : import.meta.env.DEV ? await import('./preview').then(module=>module.createPreview()) : (()=>{throw new Error('Open Pair inside VS Code.');})();
  function Root(){
    const [state,setState]=useState(adapter.initialState);
    useEffect(()=>{const unsubscribe=adapter.subscribe(setState);adapter.ready();return unsubscribe;},[]);
    return <App state={state} transport={adapter}/>;
  }
  createRoot(document.getElementById('root')!).render(<Root/>);
}
start().catch(error=>{const root=document.getElementById('root');if(root)root.textContent=String(error instanceof Error?error.message:error);});
