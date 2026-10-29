// OAuth 2.1 com PKCE para uma instalação pessoal do Fraseado.
// Uma instância, um operador e um único segredo de acesso; não é um IdP multiusuário.
import { randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function getAuthConfig(env = process.env) {
  const origin = (env.PUBLIC_ORIGIN || (env.RENDER_EXTERNAL_URL || '')).replace(/\/$/, '');
  if (!origin || !/^https:\/\/[^/?#]+$/.test(origin)) throw new Error('Defina PUBLIC_ORIGIN com a URL HTTPS pública do Render.');
  const password = env.FRASEADO_LOGIN_PASSWORD || '';
  const secret = env.AUTH_JWT_SECRET || '';
  if (password.length < 16) throw new Error('FRASEADO_LOGIN_PASSWORD exige no mínimo 16 caracteres.');
  if (secret.length < 32) throw new Error('AUTH_JWT_SECRET exige no mínimo 32 caracteres.');
  return { origin, password, secret, audience: origin, scope: 'transcribe' };
}

function base64url(v) { return Buffer.from(v).toString('base64url'); }
function sign(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const partial = `${header}.${body}`;
  const sig = createHmac('sha256', secret).update(partial).digest('base64url');
  return `${partial}.${sig}`;
}
function verify(token, secret) {
  if (typeof token !== 'string' || token.length > 8192) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = createHmac('sha256', secret).update(parts.slice(0,2).join('.')).digest();
  let given;
  try { given = Buffer.from(parts[2], 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (head.alg !== 'HS256' || head.typ !== 'JWT') return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch { return null; }
}

export function validateAccessToken(token, config, nowSec = Math.floor(Date.now()/1000)) {
  const data = verify(token, config.secret);
  return !!(data && data.iss === config.origin && data.aud === config.audience && data.sub === 'fraseado-owner' &&
    data.scope?.split(' ').includes(config.scope) && data.iat <= nowSec && data.exp > nowSec && data.exp <= data.iat + 43200 && data.kind === 'access');
}
export function checkPassword(candidate, config) {
  const actual = createHash('sha256').update(config.password).digest();
  const supplied = createHash('sha256').update(String(candidate || '')).digest();
  return timingSafeEqual(actual, supplied);
}
export function authorizeQuery(params, config) {
  const client = params.get('client_id') || '';
  const redirect = params.get('redirect_uri') || '';
  const state = params.get('state') || '';
  const resource = params.get('resource') || config.origin;
  const scope = params.get('scope') || config.scope;
  const challenge = params.get('code_challenge') || '';
  if (!/^https:\/\/chatgpt\.com\/oauth\/(?:client\.json|[a-zA-Z0-9_-]+\/client\.json)$/.test(client)) throw new Error('Cliente OAuth não reconhecido.');
  if (!/^https:\/\/chatgpt\.com\/(?:connector_platform_oauth_redirect|connector\/oauth\/[a-zA-Z0-9_-]+)$/.test(redirect)) throw new Error('Callback OAuth não autorizado.');
  if (params.get('response_type') !== 'code' || params.get('code_challenge_method') !== 'S256' || !/^[a-zA-Z0-9_-]{43,128}$/.test(challenge)) throw new Error('PKCE S256 obrigatório.');
  if (resource !== config.origin || !scope.split(' ').includes(config.scope)) throw new Error('Escopo ou recurso inválido.');
  if (!state || state.length > 1024) throw new Error('Parâmetro state obrigatório.');
  return { client, redirect, state, resource, scope: config.scope, challenge };
}

function escapeHtml(value) { return String(value).replace(/[&<>"']/g, s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s])); }
function json(res, status, data, headers={}) {
  res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...headers }).end(JSON.stringify(data));
}
function html(res, code, body) {
  res.writeHead(code, { 'content-type':'text/html; charset=utf-8', 'cache-control':'no-store', 'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'x-content-type-options': 'nosniff' }).end(body);
}
async function readForm(req, max=8192) {
  let text='';
  for await(const chunk of req) {
    text+=chunk.toString('utf8');
    if (text.length > max) throw new Error('Formulário excede o limite permitido.');
  }
  return new URLSearchParams(text);
}

export function createAuthRoutes(config, now=()=>Date.now()) {
  const codes = new Map();
  const failed = new Map();
  const windowMs=15*60*1000;
  function cleanup(){ for (const [k,v] of codes) if (v.until<now()) codes.delete(k); for (const [k,v] of failed) if (v.since+windowMs<now()) failed.delete(k); }
  function authorizeLogin(requestInfo) {
    const payload = { ...requestInfo, kind:'pending', iat:Math.floor(now()/1000), exp:Math.floor(now()/1000)+600, nonce:randomBytes(16).toString('hex') };
    return sign(payload, config.secret);
  }
  function renderLogin(res, signed, message=''){
    html(res,200,`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Conectar Fraseado</title><style>body{font:16px system-ui;margin:10vh auto;max-width:420px;padding:20px;color:#18202d}input,button{font:inherit;box-sizing:border-box;width:100%;padding:14px;border-radius:9px;margin-top:9px}input{border:1px solid #aaa}button{border:0;background:#d95c1e;color:#fff;cursor:pointer}small{color:#555}.error{color:#b42318}</style><h1>Conectar Fraseado</h1><p>Digite a senha de acesso particular definida no Render. Ela não é a chave da API Groq.</p>${message?`<p class="error">${escapeHtml(message)}</p>`:''}<form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escapeHtml(signed)}"><label for="password">Senha de acesso</label><input name="password" id="password" type="password" autocomplete="current-password" minlength="16" required><button type="submit">Autorizar o Fraseado</button></form><p><small>Somente continue se você iniciou esta conexão no ChatGPT.</small></p></html>`);
  }
  return async function handleAuth(req,res,url) {
    const route = url.pathname;
    if (req.method==='GET' && route==='/.well-known/oauth-protected-resource') {
      json(res,200,{resource:config.origin,authorization_servers:[config.origin],scopes_supported:[config.scope]});return true;
    }
    if (req.method==='GET' && route==='/.well-known/oauth-authorization-server') {
      json(res,200,{issuer:config.origin,authorization_response_iss_parameter_supported:true,authorization_endpoint:`${config.origin}/oauth/authorize`,token_endpoint:`${config.origin}/oauth/token`,client_id_metadata_document_supported:true,token_endpoint_auth_methods_supported:['none'],code_challenge_methods_supported:['S256'],response_types_supported:['code'],grant_types_supported:['authorization_code'],scopes_supported:[config.scope]});return true;
    }
    if (req.method==='GET' && route==='/oauth/authorize') {
      try { renderLogin(res,authorizeLogin(authorizeQuery(url.searchParams,config))); }
      catch(e) {html(res,400,`<p>Solicitação de autorização inválida: ${escapeHtml(e.message)}</p>`);}
      return true;
    }
    if (req.method==='POST' && route==='/oauth/authorize') {
      cleanup();
      try {
        const form = await readForm(req);
        const data = verify(form.get('request'),config.secret);
        if (!data || data.kind!=='pending' || data.iat>now()/1000 || data.exp<=now()/1000) throw new Error('Solicitação expirada. Reinicie a conexão.');
        const validated = authorizeQuery(new URLSearchParams({ client_id:data.client,redirect_uri:data.redirect,state:data.state,resource:data.resource,scope:data.scope,response_type:'code',code_challenge:data.challenge,code_challenge_method:'S256' }),config);
        const key = createHash('sha256').update(req.socket.remoteAddress||'').digest('hex');
        const recent=failed.get(key);
        if (recent && recent.n>=6 && recent.since+windowMs>now()) {html(res,429,'<p>Muitas tentativas incorretas. Tente mais tarde.</p>');return true;}
        if (!checkPassword(form.get('password'),config)) {
          failed.set(key,{since:recent?.since||now(),n:(recent?.n||0)+1});
          renderLogin(res,form.get('request'),'Senha inválida.');return true;
        }
        failed.delete(key);
        const code=randomBytes(32).toString('base64url');
        codes.set(createHash('sha256').update(code).digest('hex'),{...validated,until:now()+180000});
        const dest=new URL(validated.redirect);dest.searchParams.set('code',code);dest.searchParams.set('state',validated.state);dest.searchParams.set('iss',config.origin);
        res.writeHead(302,{Location:dest.toString(),'cache-control':'no-store','referrer-policy':'no-referrer'}).end();
      } catch(e) {html(res,400,`<p>Não foi possível autorizar: ${escapeHtml(e.message)}</p>`);}
      return true;
    }
    if (req.method==='POST' && route==='/oauth/token') {
      cleanup();
      try {
        const form=await readForm(req);
        if (form.get('grant_type')!=='authorization_code') {json(res,400,{error:'unsupported_grant_type'});return true;}
        const key=createHash('sha256').update(form.get('code')||'').digest('hex');
        const data=codes.get(key);codes.delete(key);
        const verifier=form.get('code_verifier')||'';
        const challenge=createHash('sha256').update(verifier).digest('base64url');
        if (!data || data.until<now() || !/^[a-zA-Z0-9._~-]{43,128}$/.test(verifier) ||
          data.challenge!==challenge || data.client!==form.get('client_id') ||
          data.redirect!==form.get('redirect_uri') || data.resource!==(form.get('resource')||config.origin)) {json(res,400,{error:'invalid_grant'});return true;}
        const iat=Math.floor(now()/1000);
        const token=sign({iss:config.origin,sub:'fraseado-owner',aud:config.audience,iat,exp:iat+43200,kind:'access',scope:config.scope},config.secret);
        json(res,200,{access_token:token,token_type:'Bearer',expires_in:43200,scope:config.scope});
      }catch{json(res,400,{error:'invalid_request'});}return true;
    }
    return false;
  };
}

export function authChallenge(config, res) {
  const metadata=`${config.origin}/.well-known/oauth-protected-resource`;
  const challenge=`Bearer resource_metadata="${metadata}", scope="${config.scope}", error="invalid_token", error_description="Conecte sua conta Fraseado para continuar"`;
  json(res,401,{error:'unauthorized',message:'Autenticação OAuth necessária.'},{'WWW-Authenticate':challenge});
}
