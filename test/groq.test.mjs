import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { transcribeViaApi } from '../audio.mjs';

test('Groq Free usa Whisper Large V3 com idioma português e não OpenAI', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'fraseado-test-'));
  const file=path.join(dir,'teste.mp3');await writeFile(file,Buffer.from('fake audio'));
  const priorFetch=globalThis.fetch, priorKey=process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY='teste-nao-valido';
  try{
    globalThis.fetch=async (url, opts)=>{
      assert.equal(url,'https://api.groq.com/openai/v1/audio/transcriptions');
      assert.equal(opts.headers.Authorization,'Bearer teste-nao-valido');
      assert.equal(opts.body.get('model'),'whisper-large-v3');
      assert.equal(opts.body.get('language'),'pt');
      assert.match(opts.body.get('prompt'),/UFRN/);
      return {ok:true,status:200,json:async()=>({text:'Olá mundo'})};
    };
    assert.equal(await transcribeViaApi(file,0,1,['UFRN'],''),'Olá mundo');
  } finally {globalThis.fetch=priorFetch; if(priorKey===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=priorKey;await rm(dir,{recursive:true,force:true});}
});

test('limite gratuito do Groq gera erro claro', async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'fraseado-test-'));
  const file=path.join(dir,'teste.mp3');await writeFile(file,Buffer.from('fake audio'));
  const priorFetch=globalThis.fetch,priorKey=process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY='teste-nao-valido';
  try{
    globalThis.fetch=async()=>({ok:false,status:429,json:async()=>({})});
    await assert.rejects(transcribeViaApi(file,0,1,[],''),/Limite de uso gratuito/);
  }finally{globalThis.fetch=priorFetch;if(priorKey===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=priorKey;await rm(dir,{recursive:true,force:true});}
});
