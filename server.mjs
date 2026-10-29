import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  registerAppResource, registerAppTool, RESOURCE_MIME_TYPE
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { transcribeFile } from './audio.mjs';
import { getAuthConfig, createAuthRoutes, validateAccessToken, authChallenge } from './auth.mjs';

const base = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(base, 'public/fraseado-widget.html'), 'utf8');
const URI = 'ui://fraseado/transcricao.html';
const authConfig = getAuthConfig();
const authRoutes = createAuthRoutes(authConfig);
let activeTranscriptions = 0;
const MAX_CONCURRENT = Math.max(1, Math.min(4, Number(process.env.MAX_CONCURRENT_TRANSCRIPTIONS || 1))); 
const fileSchema = z.object({
  download_url: z.string().url(),
  file_id: z.string().min(1),
  mime_type: z.string().optional(),
  file_name: z.string().optional()
}).strict();

function newServer() {
  const server = new McpServer({ name: 'fraseado-transcricao', version: '0.1.0' });
  registerAppResource(server, 'fraseado-widget', URI, {}, async () => ({ contents: [{
    uri: URI, mimeType: RESOURCE_MIME_TYPE, text: html,
    _meta: {
      ui: { prefersBorder: true },
      'openai/ui': { availableDisplayModes: ['inline', 'fullscreen'] },
      'openai/widgetDescription': 'Editor do Fraseado para enviar MP3/MP4, transcrever e exportar texto.'
    }
  }] }));

  registerAppTool(server, 'abrir_fraseado', {
    title: 'Abrir Fraseado',
    description: 'Abre a interface do Fraseado para enviar um áudio ou vídeo e transcrevê-lo.',
    inputSchema: {},
    outputSchema: { pronto: z.boolean() },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: [{ type: 'oauth2', scopes: ['transcribe'] }],
    _meta: { ui: { resourceUri: URI }, 'openai/toolInvocation/invoked': 'Fraseado aberto' }
  }, async () => ({ structuredContent: { pronto: true }, content: [{ type: 'text', text: 'Interface Fraseado aberta. Use o seletor de arquivos.' }] }));

  registerAppTool(server, 'transcrever_audio', {
    title: 'Transcrever MP3/MP4',
    description: 'Transcreve de verdade o áudio anexado, em português do Brasil. Extrai áudio de MP4, suporta arquivos longos e devolve texto revisável.',
    inputSchema: {
      arquivo: fileSchema,
      vocabulario: z.string().max(2000).optional()
    },
    outputSchema: {
      sucesso: z.boolean(),
      texto: z.string(),
      nome: z.string(),
      trechos: z.number().int(),
      palavras: z.number().int(),
      erro: z.string().optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    securitySchemes: [{ type: 'oauth2', scopes: ['transcribe'] }],
    _meta: {
      ui: { resourceUri: URI },
      'openai/toolInvocation/invoking': 'Transcrevendo áudio…',
      'openai/toolInvocation/invoked': 'Processamento finalizado'
    }
  }, async ({ arquivo, vocabulario }) => {
    if (activeTranscriptions >= MAX_CONCURRENT) return {
      isError: true,
      content: [{type:'text',text:'O Fraseado já está processando outra solicitação. Tente novamente após a conclusão.'}],
      structuredContent: {sucesso:false,texto:'',nome:arquivo?.file_name||'arquivo',trechos:0,palavras:0,erro:'Limite de transcrições simultâneas atingido.'}
    };
    activeTranscriptions++;
    try {
      const result = await transcribeFile(arquivo, vocabulario);
      return {
        structuredContent: { sucesso: true, texto: result.text, nome: result.name, trechos: result.chunks, palavras: result.words },
        content: [{ type: 'text', text: `Transcrição concluída: ${result.name}, ${result.words} palavras. O texto está na interface do Fraseado.` }]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Erro desconhecido';
      return {
        isError: true,
        structuredContent: { sucesso: false, texto: '', nome: arquivo?.file_name || 'arquivo', trechos: 0, palavras: 0, erro: message },
        content: [{ type: 'text', text: 'Falha: ' + message }]
      };
    } finally { activeTranscriptions--; }
  });
  return server;
}

const port = Number(process.env.PORT || 8787);
const listener = createServer(async (req, res) => {
  const route = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  const url = new URL(req.url || '/', authConfig.origin);
  if (await authRoutes(req, res, url)) return;
  if (req.method === 'GET' && route === '/') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Fraseado MCP ativo. Endpoint: /mcp');
    return;
  }
  if (req.method === 'GET' && route === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ok:true,app:'fraseado',transcriptionReady:Boolean(process.env.GROQ_API_KEY)}));
    return;
  }
  if (route === '/mcp' && req.method !== 'OPTIONS') {
    const raw = req.headers.authorization || '';
    const token = raw.startsWith('Bearer ') ? raw.slice(7) : '';
    if (!validateAccessToken(token, authConfig)) { authChallenge(authConfig, res); return; }
  }
  if (route === '/mcp' && req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE', 'Access-Control-Allow-Headers': 'content-type, mcp-session-id, authorization', 'Access-Control-Expose-Headers': 'Mcp-Session-Id' }).end();
    return;
  }
  if (route === '/mcp' && ['POST','GET','DELETE'].includes(req.method || '')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    const server = newServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('[fraseado]', error);
      if (!res.headersSent) res.writeHead(500).end('Falha interna');
    }
    return;
  }
  res.writeHead(404).end('Não encontrado');
});
listener.listen(port, () => console.log(`Fraseado MCP em http://localhost:${port}/mcp`));
