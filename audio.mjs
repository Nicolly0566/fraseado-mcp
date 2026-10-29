import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { spawn } from 'node:child_process';

export const AUDIO_EXTENSIONS = new Set(['.mp3', '.mp4', '.m4a', '.wav', '.webm', '.mpeg', '.mpga', '.ogg', '.flac']);
const SIZE_LIMIT = 24 * 1024 * 1024;

export function validateFile(input, allowedHosts) {
  if (!input || typeof input !== 'object') throw new Error('Arquivo inválido.');
  if (typeof input.file_id !== 'string' || !input.file_id.startsWith('file_')) throw new Error('Identificador de arquivo inválido.');
  const name = String(input.file_name || 'audio.mp3').slice(0, 180);
  if (!AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())) throw new Error('Formato não suportado. Selecione MP3, MP4, M4A, WAV, WEBM, OGG ou FLAC.');
  const url = new URL(input.download_url);
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('URL de arquivo não permitida.');
  if (!allowedHosts.has(url.hostname.toLowerCase())) throw new Error(`Domínio do arquivo não autorizado: ${url.hostname}. Configure ALLOWED_FILE_HOSTS.`);
  return { url, name };
}

async function runFfmpeg(args, maxMs = 180_000) {
  return await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorOutput = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (s) => { errorOutput = (errorOutput + s).slice(-1800); });
    const timeout = setTimeout(() => child.kill('SIGKILL'), maxMs);
    child.on('error', (error) => { clearTimeout(timeout); reject(new Error(`FFmpeg indisponível: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`Não foi possível extrair o áudio. ${errorOutput || 'FFmpeg encerrado.'}`));
    });
  });
}

export async function downloadAudio(fileUrl, target, maxBytes) {
  const abort = AbortSignal.timeout(90_000);
  const res = await fetch(fileUrl, { signal: abort, redirect: 'error', headers: { Accept: 'application/octet-stream,*/*' } });
  if (!res.ok || !res.body) throw new Error(`Falha ao obter o arquivo do ChatGPT (HTTP ${res.status}).`);
  const announced = Number(res.headers.get('content-length') || 0);
  if (announced > maxBytes) throw new Error('Arquivo excede o limite máximo configurado.');
  let bytes = 0;
  const cap = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) cb(new Error('Arquivo excede o limite máximo configurado.'));
      else cb(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(target));
}

export async function prepareChunks(source, dir) {
  // 32 kbps, 16 kHz, 1 canal: 10 minutos ~= 2,4 MB por trecho.
  const pattern = path.join(dir, 'trecho_%04d.mp3');
  await runFfmpeg(['-i', source, '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '32k', '-f', 'segment', '-segment_time', '600', '-reset_timestamps', '1', pattern], 600_000);
  const names = (await readdir(dir)).filter(n => /^trecho_\d{4}\.mp3$/.test(n)).sort();
  if (!names.length) throw new Error('Não foi encontrada uma faixa de áudio válida.');
  const parts = names.map(n => path.join(dir, n));
  for (const p of parts) {
    const info = await stat(p);
    if (info.size > SIZE_LIMIT) throw new Error('Trecho excede o limite da API.');
    if (info.size < 64) throw new Error('Trecho vazio após conversão.');
  }
  return parts;
}

export function normalizeVocabulary(text) {
  return String(text || '').split(/[,;\n]/g)
    .map(x => x.trim().replace(/[<>\r\n]/g, '').slice(0, 80))
    .filter(Boolean).slice(0, 40);
}

export function joinTranscripts(parts) {
  return parts.map(t => String(t || '').trim()).filter(Boolean).join('\n\n');
}

export async function transcribeViaApi(filePath, index, count, vocabulary, priorText) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY não configurada no servidor.');
  const bytes = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), `trecho_${index + 1}.mp3`);
  form.append('model', 'whisper-large-v3');
  form.append('language', 'pt');
  form.append('response_format', 'json');
  form.append('temperature', '0');
  const hints = vocabulary.slice(0, 40).join(', ');
  const previous = String(priorText || '').slice(-200);
  if (hints || previous) {
    const prompt = [`Termos possivelmente presentes: ${hints}`, previous ? `Contexto do trecho anterior: ${previous}` : ''].filter(Boolean).join('. ');
    form.append('prompt', prompt.slice(0, 800));
  }
  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: AbortSignal.timeout(120_000)
  });
  let json = {};
  try { json = await res.json(); } catch {}
  if (res.status === 429) throw new Error('Limite de uso gratuito do Groq atingido. Tente novamente após o período de renovação da cota.');
  if (!res.ok) throw new Error(`Serviço de transcrição (${res.status}): ${String(json?.error?.message || 'falha no processamento').slice(0, 200)}`);
  if (typeof json?.text !== 'string') throw new Error('O serviço de transcrição não retornou texto.');
  return json.text;
}

export async function transcribeFile(file, vocabularyText) {
  const allowed = new Set(String(process.env.ALLOWED_FILE_HOSTS || 'files.oaiusercontent.com,cdn.openai.com,chatgpt.com').split(',').map(h => h.trim().toLowerCase()).filter(Boolean));
  const { url, name } = validateFile(file, allowed);
  const maxMb = Math.min(512, Math.max(1, Number(process.env.MAX_INPUT_MB || 50)));
  const dir = await mkdtemp(path.join(tmpdir(), 'fraseado-'));
  try {
    const raw = path.join(dir, 'entrada' + path.extname(name).toLowerCase());
    await downloadAudio(url, raw, maxMb * 1024 * 1024);
    const parts = await prepareChunks(raw, dir);
    const vocabulary = normalizeVocabulary(vocabularyText);
    const texts = [];
    for (let i = 0; i < parts.length; i++) {
      const text = await transcribeViaApi(parts[i], i, parts.length, vocabulary, texts.at(-1));
      texts.push(text);
    }
    return { name, text: joinTranscripts(texts), chunks: parts.length, words: joinTranscripts(texts).trim().split(/\s+/).filter(Boolean).length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
