import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { getAuthConfig, createAuthRoutes, validateAccessToken, checkPassword } from '../auth.mjs';

const config=getAuthConfig({PUBLIC_ORIGIN:'https://fraseado.example',FRASEADO_LOGIN_PASSWORD:'fraseado-testing-owner-password',AUTH_JWT_SECRET:'a-secret-key-with-over-32-characters-of-entropy-only-for-tests'});

test('exige segredos fortes e HTTPS',()=>{
  assert.throws(()=>getAuthConfig({PUBLIC_ORIGIN:'http://x',FRASEADO_LOGIN_PASSWORD:'123',AUTH_JWT_SECRET:'123'}));
  assert.equal(checkPassword('fraseado-testing-owner-password',config),true);
  assert.equal(checkPassword('wrong',config),false);
});
test('OAuth PKCE completa autorização, emite token válido e rejeita replay',async(t)=>{
  const auth=createAuthRoutes(config);
  const server=createServer(async(req,res)=>{ const url=new URL(req.url,'http://localhost');if(!await auth(req,res,url)){res.writeHead(404).end();}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const verifier='testing-oauth-code-verifier-with-over-forty-three-chars';
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const params=new URLSearchParams({client_id:'https://chatgpt.com/oauth/client.json',redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',resource:config.origin,scope:'transcribe',state:'a-random-state'});
  const page=await fetch(`${base}/oauth/authorize?${params}`);
  assert.equal(page.status,200);
  const html=await page.text();
  const signed=html.match(/name="request" value="([^"]+)"/)[1];
  const login=await fetch(`${base}/oauth/authorize`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({request:signed,password:config.password}),redirect:'manual'});
  assert.equal(login.status,302);
  const redirect=new URL(login.headers.get('location'));
  assert.equal(redirect.origin,'https://chatgpt.com');
  assert.equal(redirect.searchParams.get('state'),'a-random-state');
  assert.equal(redirect.searchParams.get('iss'),config.origin);
  const code=redirect.searchParams.get('code');
  const tokenBody=new URLSearchParams({grant_type:'authorization_code',client_id:params.get('client_id'),redirect_uri:params.get('redirect_uri'),resource:config.origin,code,code_verifier:verifier});
  const tokens=await fetch(`${base}/oauth/token`,{method:'POST',body:tokenBody});
  assert.equal(tokens.status,200);
  const result=await tokens.json();
  assert.equal(validateAccessToken(result.access_token,config),true);
  const replay=await fetch(`${base}/oauth/token`,{method:'POST',body:tokenBody});
  assert.equal(replay.status,400);
  assert.equal(validateAccessToken('bad-token',config),false);
  const bad=await fetch(`${base}/oauth/authorize?${new URLSearchParams({...Object.fromEntries(params),redirect_uri:'https://evil.example/cb'})}`);
  assert.equal(bad.status,400);
});

test('login continua válido após 11 minutos e expira após a janela configurada', async(t) => {
  let clock=Date.now();
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url, 'http://localhost');
    if(!await createHandler(req,res,url)) res.writeHead(404).end();
  });
  const createHandler=createAuthRoutes(config,()=>clock);
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const verifier='test-verifier-1234567890123456789012345678901234567890';
  const challenge=createHash('sha256').update(verifier).digest('base64url');
  const params=new URLSearchParams({
    client_id:'https://chatgpt.com/oauth/client.json',
    redirect_uri:'https://chatgpt.com/connector_platform_oauth_redirect',
    response_type:'code',code_challenge:challenge,code_challenge_method:'S256',
    resource:config.origin,scope:'transcribe',state:'teste-expiracao'
  });
  async function issueRequest() {
    const res=await fetch(`${base}/oauth/authorize?${params}`);
    assert.equal(res.status,200);
    return (await res.text()).match(/name="request" value="([^"]+)"/)[1];
  }
  async function postRequest(request,password=config.password) {
    return fetch(`${base}/oauth/authorize`,{
      method:'POST',body:new URLSearchParams({request,password}),redirect:'manual'
    });
  }
  const signed=await issueRequest();
  clock+=11*60*1000;
  const wrong=await postRequest(signed,'senha-incorreta');
  assert.equal(wrong.status,200);
  assert.match(await wrong.text(),/Senha inválida/);
  const correct=await postRequest(signed);
  assert.equal(correct.status,302);
  const fresh=await issueRequest();
  clock+=32*60*1000;
  const expired=await postRequest(fresh);
  assert.equal(expired.status,400);
  assert.match(await expired.text(),/prazo de autorização terminou/);
  const altered=await postRequest(fresh.slice(0,-3)+'xxx');
  assert.equal(altered.status,400);
  assert.match(await altered.text(),/Solicitação de autorização inválida/);
});