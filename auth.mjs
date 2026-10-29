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

const LOGIN_WINDOW_SECONDS = 30 * 60;
const CLOCK_SKEW_SECONDS = 60;

// Os registros abaixo não incluem senha, tokens, código OAuth, estado, cliente ou IP.
function defaultOAuthAudit(event, reason='') { console.info(`[fraseado.oauth] ${event}${reason ? ` ${reason}` : ''}`); }

function base64url(v) { return Buffer.from(v).toString('base64url'); }
function sign(payload, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64url(JSON.stringify(payload));
  const partial = `${header}.${body}`;
  const sig = createHmac('sha256', secret).update(partial).digest('base64url');
  return `${partial}.${sig}`;
}
function verify(token, secret) {
  if (typeof token !== 'string' || token.length > 16384) return null;
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
async function readForm(req, max=32768) {
  let text='';
  for await(const chunk of req) {
    text+=chunk.toString('utf8');
    if (text.length > max) throw new Error('Formulário excede o limite permitido.');
  }
  return new URLSearchParams(text);
}

export function createAuthRoutes(config, now=()=>Date.now(), audit=defaultOAuthAudit) {
  const codes = new Map();
  const failed = new Map();
  const windowMs=15*60*1000;
  function cleanup(){ for (const [k,v] of codes) if (v.until<now()) codes.delete(k); for (const [k,v] of failed) if (v.since+windowMs<now()) failed.delete(k); }
  function authorizeLogin(requestInfo) {
    const issuedAt = Math.floor(now()/1000);
    const payload = { ...requestInfo, kind:'pending', iat:issuedAt, exp:issuedAt+LOGIN_WINDOW_SECONDS, nonce:randomBytes(16).toString('hex') };
    return sign(payload, config.secret);
  }
  function readPendingRequest(signed) {
    if (!signed) return { error:'Solicitação de autorização ausente. Refaça a conexão no ChatGPT.', code:'request_missing' };
    const data = verify(signed, config.secret);
    if (!data || data.kind !== 'pending' || !Number.isInteger(data.iat) || !Number.isInteger(data.exp) ||
        data.exp - data.iat !== LOGIN_WINDOW_SECONDS || data.iat > now()/1000 + CLOCK_SKEW_SECONDS) {
      return { error:'Solicitação de autorização inválida. Abra uma nova conexão no ChatGPT.', code:'request_invalid' };
    }
    if (data.exp <= now()/1000 - CLOCK_SKEW_SECONDS) {
      return { error:'O prazo de autorização terminou. Abra uma nova conexão no ChatGPT.', code:'request_expired' };
    }
    return { data };
  }
  function renderLogin(res, signed, message=''){
    html(res,200,`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Conectar Fraseado</title><style>body{font:16px system-ui;margin:10vh auto;max-width:420px;padding:20px;color:#18202d}input,button{font:inherit;box-sizing:border-box;width:100%;padding:14px;border-radius:9px;margin-top:9px}input{border:1px solid #aaa}button{border:0;background:#d95c1e;color:#fff;cursor:pointer}small{color:#555}.error{color:#b42318}</style><h1>Conectar Fraseado</h1><p>Digite a senha de acesso particular definida no Render. Ela não é a chave da API Groq.</p>${message?`<p class="error">${escapeHtml(message)}</p>`:''}<form method="post" action="/oauth/authorize"><input type="hidden" name="request" value="${escapeHtml(signed)}"><label for="password">Senha de acesso</label><input name="password" id="password" type="password" autocomplete="current-password" minlength="16" required><button type="submit">Autorizar o Fraseado</button></form><p><small>Esta autorização é válida por 30 minutos. Só continue se iniciou a conexão no ChatGPT.</small></p></html>`);
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
      try { renderLogin(res,authorizeLogin(authorizeQuery(url.searchParams,config))); audit('authorize_started'); }
      catch(e) {audit('authorize_rejected','invalid_query');html(res,400,`<p>Solicitação de autorização inválida: ${escapeHtml(e.message)}</p>`);}
      return true;
    }
    if (req.method==='POST' && route==='/oauth/authorize') {
      cleanup();
      try {
        const form = await readForm(req);
        const pending = readPendingRequest(form.get('request'));
        if (pending.error) { audit('login_rejected',pending.code); html(res,400,`<p>Não foi possível autorizar: ${escapeHtml(pending.error)} (código ${pending.code})</p>`); return true; }
        const data = pending.data;
        let validated;
        try { validated = authorizeQuery(new URLSearchParams({ client_id:data.client,redirect_uri:data.redirect,state:data.state,resource:data.resource,scope:data.scope,response_type:'code',code_challenge:data.challenge,code_challenge_method:'S256' }),config); }
        catch { audit('login_rejected','invalid_oauth_parameters');html(res,400,'<p>Não foi possível autorizar: parâmetros de conexão inválidos (código invalid_oauth_parameters).</p>'); return true; }
        const key = createHash('sha256').update(req.socket.remoteAddress||'').digest('hex');
        const recent=failed.get(key);
        if (recent && recent.n>=6 && recent.since+windowMs>now()) {audit('login_rejected','rate_limited');html(res,429,'<p>Muitas tentativas incorretas. Tente mais tarde (código rate_limited).</p>');return true;}
        if (!checkPassword(form.get('password'),config)) {
          audit('login_rejected','bad_password');
          failed.set(key,{since:recent?.since||now(),n:(recent?.n||0)+1});
          renderLogin(res,form.get('request'),'Senha inválida.');return true;
        }
        failed.delete(key);
        const code=randomBytes(32).toString('base64url');
        codes.set(createHash('sha256').update(code).digest('hex'),{...validated,until:now()+180000});
        const dest=new URL(validated.redirect);dest.searchParams.set('code',code);dest.searchParams.set('state',validated.state);dest.searchParams.set('iss',config.origin);
        audit('login_authorized');
        res.writeHead(302,{Location:dest.toString(),'cache-control':'no-store','referrer-policy':'no-referrer'}).end();
      } catch(e) {audit('login_rejected','unexpected_error');html(res,400,'<p>Não foi possível autorizar: falha inesperada (código unexpected_error).</p>');}
      return true;
    }
    if (req.method==='POST' && route==='/oauth/token') {
      cleanup();
      try {
        const form=await readForm(req);
        if (form.get('grant_type')!=='authorization_code') {audit('token_rejected','unsupported_grant_type');json(res,400,{error:'unsupported_grant_type'});return true;}
        const key=createHash('sha256').update(form.get('code')||'').digest('hex');
        const data=codes.get(key);codes.delete(key);
        if(!data){audit('token_rejected','code_unknown');json(res,400,{error:'invalid_grant'});return true;}
        const verifier=form.get('code_verifier')||'';
        const challenge=createHash('sha256').update(verifier).digest('base64url');
        const reason = data.until<now() ? 'code_expired' :
          !/^[a-zA-Z0-9._~-]{43,128}$/.test(verifier) || data.challenge!==challenge ? 'pkce_mismatch' :
          data.client!==form.get('client_id') ? 'client_mismatch' :
          data.redirect!==form.get('redirect_uri') ? 'redirect_mismatch' :
          data.resource!==(form.get('resource')||config.origin) ? 'resource_mismatch' : '';
        if(reason){audit('token_rejected',reason);json(res,400,{error:'invalid_grant'});return true;}
        const iat=Math.floor(now()/1000);
        const token=sign({iss:config.origin,sub:'fraseado-owner',aud:config.audience,iat,exp:iat+43200,kind:'access',scope:config.scope},config.secret);
        audit('token_issued');
        json(res,200,{access_token:token,token_type:'Bearer',expires_in:43200,scope:config.scope});
      }catch{audit('token_rejected','malformed_request');json(res,400,{error:'invalid_request'});}return true;
    }
    return false;
  };
}

export function authChallenge(config, res) {
  const metadata=`${config.origin}/.well-known/oauth-protected-resource`;
  const challenge=`Bearer resource_metadata="${metadata}", scope="${config.scope}", error="invalid_token", error_description="Conecte sua conta Fraseado para continuar"`;
  json(res,401,{error:'unauthorized',message:'Autenticação OAuth necessária.'},{'WWW-Authenticate':challenge});
}