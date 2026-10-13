'use strict';

const { app, BrowserWindow, ipcMain, dialog, session, shell, powerSaveBlocker, net } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

const isDev = process.argv.includes('--dev');

// Alguns provedores IPTV recusam requisicoes que nao parecam vir de um player.
const DEFAULT_UA = 'VLC/3.0.20 LibVLC/3.0.20';

let mainWindow = null;
let psbId = null;

/* ------------------------------------------------------------------ *
 * Armazenamento simples em JSON (userData/bishoptv-store.json)
 * ------------------------------------------------------------------ */
const storePath = () => path.join(app.getPath('userData'), 'bishoptv-store.json');

/**
 * O app já se chamou NeoTV, e o Electron deriva a pasta de dados do nome do
 * produto. Sem isto, quem já usava a versão anterior perderia as listas,
 * favoritos e o histórico ao atualizar. Roda uma única vez.
 */
async function migrateLegacyStore() {
  try {
    await fsp.access(storePath());
    return; // já existe configuração nova: nada a fazer
  } catch {}

  const legacy = path.join(path.dirname(app.getPath('userData')), 'NeoTV', 'neotv-store.json');
  try {
    const raw = await fsp.readFile(legacy, 'utf8');
    JSON.parse(raw); // só migra se for JSON válido
    await fsp.mkdir(path.dirname(storePath()), { recursive: true });
    await fsp.writeFile(storePath(), raw, 'utf8');
    console.log('[store] configuração do NeoTV migrada para BishopTV');
  } catch {
    // Nada para migrar — instalação nova.
  }
}

/* ------------------------------------------------------------------ *
 * Proteção da configuração
 *
 * Antes, um bishoptv-store.json ilegível (cortado, travado pelo antivírus)
 * virava uma configuração vazia em silêncio — e o próximo salvamento gravava
 * o vazio por cima, apagando as listas de vez. Agora:
 *   - cada gravação guarda a versão anterior em bishoptv-store.json.bak;
 *   - a cada dia de uso fica uma cópia em backups/ (as 10 mais recentes);
 *   - arquivo ilegível é recuperado do .bak ou do backup mais novo, e o
 *     original vai para backups/ em vez de ser sobrescrito.
 * ------------------------------------------------------------------ */
const backupDir = () => path.join(app.getPath('userData'), 'backups');
const BACKUPS_KEPT = 10;

/** Como a configuração foi lida nesta abertura — ver o handler store:status. */
let storeStatus = { state: 'ok' };

async function readJson(file) {
  const raw = await fsp.readFile(file, 'utf8');
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('conteúdo inesperado');
  return data;
}

/** Backups de backups/, do mais novo para o mais antigo. */
async function listBackups() {
  try {
    const names = (await fsp.readdir(backupDir())).filter((n) => /\.json$/i.test(n));
    const withTime = await Promise.all(names.map(async (n) => {
      const st = await fsp.stat(path.join(backupDir(), n)).catch(() => null);
      return st ? { name: n, file: path.join(backupDir(), n), at: st.mtimeMs } : null;
    }));
    return withTime.filter(Boolean).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

async function readStore() {
  let raw = null;
  try {
    return await readJson(storePath());
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Primeira abertura — ou o arquivo sumiu. Se houver cópia, ela volta.
      raw = null;
    } else {
      raw = err;
      console.error('[store] configuração ilegível:', err.message);
    }
  }

  const candidates = [{ file: storePath() + '.bak', label: 'a cópia anterior' }]
    .concat((await listBackups()).map((b) => ({ file: b.file, label: `o backup ${b.name}` })));
  for (const c of candidates) {
    try {
      const data = await readJson(c.file);
      // Guarda o arquivo estragado antes de qualquer gravação substituí-lo.
      if (raw) await quarantineStore();
      await fsp.writeFile(storePath(), JSON.stringify(data, null, 2), 'utf8');
      storeStatus = { state: 'recovered', from: c.label, sources: (data.sources || []).length, missing: !raw };
      console.log(`[store] configuração recuperada de ${c.label}`);
      return data;
    } catch {}
  }

  if (raw) {
    await quarantineStore();
    storeStatus = { state: 'failed' };
  } else {
    storeStatus = { state: 'fresh' };
  }
  return {};
}

/** Move o arquivo ilegível para backups/, para não ser sobrescrito. */
async function quarantineStore() {
  try {
    await fsp.mkdir(backupDir(), { recursive: true });
    await fsp.rename(storePath(), path.join(backupDir(), `store-ilegivel-${stamp()}.json.txt`));
  } catch (e) {
    console.error('[store] não foi possível guardar o arquivo ilegível:', e.message);
  }
}

/** Uma cópia por dia de uso, mantendo as BACKUPS_KEPT mais recentes. */
async function dailyBackup() {
  try {
    await fsp.access(storePath());
    await fsp.mkdir(backupDir(), { recursive: true });
    const today = stamp().slice(0, 10);
    const file = path.join(backupDir(), `store-${today}.json`);
    try { await fsp.access(file); } catch { await fsp.copyFile(storePath(), file); }
    const daily = (await listBackups()).filter((b) => /^store-\d{4}-\d\d-\d\d\.json$/.test(b.name));
    for (const old of daily.slice(BACKUPS_KEPT)) await fsp.unlink(old.file).catch(() => {});
  } catch {}
}

let writeQueue = Promise.resolve();
function writeStore(data) {
  writeQueue = writeQueue.then(async () => {
    const tmp = storePath() + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    // A versão anterior vira .bak antes de ser substituída.
    await fsp.copyFile(storePath(), storePath() + '.bak').catch(() => {});
    await fsp.rename(tmp, storePath());
  }).catch((err) => console.error('[store]', err));
  return writeQueue;
}

/* ------------------------------------------------------------------ *
 * Cache de listas grandes em disco (evita guardar 50k canais no JSON)
 * ------------------------------------------------------------------ */
// Não use "cache": no Windows colide com o diretório de cache HTTP do
// Chromium dentro de userData (nomes são case-insensitive).
const cacheDir = () => path.join(app.getPath('userData'), 'lists-cache');

async function ensureCacheDir() {
  await fsp.mkdir(cacheDir(), { recursive: true });
}

/* ------------------------------------------------------------------ *
 * Janela
 * ------------------------------------------------------------------ */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0b0b0f',
    icon: path.join(__dirname, 'src', 'img', 'logo.png'),
    show: false,
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Necessario para tocar streams de servidores IPTV que nao enviam
      // cabecalhos CORS. O app so carrega conteudo local, entao o risco
      // fica restrito ao que o proprio usuario adiciona como fonte.
      webSecurity: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  if (isDev) {
    // Espelha o console do renderer no terminal durante o desenvolvimento.
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      const tag = ['LOG', 'WARN', 'ERROR', 'DEBUG'][level] || 'LOG';
      console.log(`[renderer:${tag}] ${message}  (${String(source).split('/').pop()}:${line})`);
    });
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  const sendState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state', {
        maximized: mainWindow.isMaximized(),
        fullscreen: mainWindow.isFullScreen()
      });
    }
  };
  mainWindow.on('maximize', sendState);
  mainWindow.on('unmaximize', sendState);
  mainWindow.on('enter-full-screen', sendState);
  mainWindow.on('leave-full-screen', sendState);

  // Links externos abrem no navegador do sistema
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

/* ------------------------------------------------------------------ *
 * User-Agent / cabecalhos nos requests de midia
 * ------------------------------------------------------------------ */
let currentUA = DEFAULT_UA;

function installRequestHooks() {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    const url = details.url || '';
    if (/^https?:/i.test(url)) {
      headers['User-Agent'] = currentUA;
      delete headers['Origin'];
      delete headers['Sec-Fetch-Site'];
      delete headers['Sec-Fetch-Mode'];
      delete headers['Sec-Fetch-Dest'];
    }
    callback({ requestHeaders: headers });
  });

  // Alguns servidores respondem sem os cabecalhos CORS; injetamos para o
  // caso de o Chromium ainda aplicar checagem em algum sub-recurso.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders };
    headers['access-control-allow-origin'] = ['*'];
    headers['access-control-allow-headers'] = ['*'];
    headers['access-control-allow-methods'] = ['GET,POST,OPTIONS,HEAD'];
    callback({ responseHeaders: headers });
  });
}

/* ------------------------------------------------------------------ *
 * Tradução dos erros de rede do Chromium
 *
 * Sem isso o usuário recebe códigos crus como "net::ERR_NAME_NOT_RESOLVED",
 * que não dizem o que fazer a respeito.
 * ------------------------------------------------------------------ */
const NET_ERRORS = {
  ERR_NAME_NOT_RESOLVED: 'o endereço "{host}" não existe — o DNS não encontrou esse domínio',
  ERR_NAME_RESOLUTION_FAILED: 'não foi possível resolver o endereço "{host}"',
  ERR_CONNECTION_REFUSED: 'o servidor "{host}" recusou a conexão',
  ERR_CONNECTION_TIMED_OUT: 'o servidor "{host}" não respondeu a tempo',
  ERR_TIMED_OUT: 'o servidor "{host}" não respondeu a tempo',
  ERR_CONNECTION_RESET: 'a conexão com "{host}" foi interrompida',
  ERR_CONNECTION_CLOSED: 'a conexão com "{host}" foi fechada pelo servidor',
  ERR_CONNECTION_ABORTED: 'a conexão com "{host}" foi abortada',
  ERR_INTERNET_DISCONNECTED: 'este computador está sem conexão com a internet',
  ERR_ADDRESS_UNREACHABLE: 'não há rota de rede até "{host}"',
  ERR_UNKNOWN_URL_SCHEME: 'o endereço precisa começar com http:// ou https://',
  ERR_EMPTY_RESPONSE: 'o servidor "{host}" respondeu vazio',
  ERR_TOO_MANY_REDIRECTS: 'o servidor "{host}" entrou em um ciclo de redirecionamentos',
  ERR_SSL_PROTOCOL_ERROR: 'falha na conexão segura com "{host}" — tente trocar https:// por http://',
  ERR_CERT_AUTHORITY_INVALID: 'o certificado de "{host}" não é confiável',
  ERR_CERT_DATE_INVALID: 'o certificado de "{host}" está vencido',
  ERR_BLOCKED_BY_CLIENT: 'a conexão foi bloqueada (antivírus, firewall ou extensão)',
  ERR_UNSAFE_PORT: 'a porta usada por "{host}" é bloqueada pelo Chromium por segurança (ex.: 6000, 6665–6669) — peça outra porta ao provedor',
  ERR_NETWORK_CHANGED: 'a rede mudou durante a conexão'
};

/**
 * Identifica o formato pelos primeiros bytes. O content-type e a extensão
 * mentem com frequência: há painéis que servem um ".ts" redirecionando para
 * um arquivo MP4.
 */
function sniffFormat(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 8 && buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'mkv';
  if (buf.toString('latin1', 0, 3) === 'FLV') return 'flv';
  // Mesma varredura do mpegts.js: sync byte 0x47 em três pacotes seguidos.
  for (const size of [188, 192, 204]) {
    const end = Math.min(1000, buf.length - 2 * size);
    for (let i = 0; i < end; i++) {
      if (buf[i] === 0x47 && buf[i + size] === 0x47 && buf[i + 2 * size] === 0x47) return 'ts';
    }
  }
  const head = buf.toString('utf8', 0, Math.min(buf.length, 512)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('#EXTM3U')) return 'hls';
  if (head.startsWith('<')) return 'html';
  return '';
}

/** Lê no máximo `limit` bytes do corpo e fecha a conexão. */
async function readHead(res, limit) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (total < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
      total += value.byteLength;
    }
  } finally {
    // Um stream ao vivo pode ignorar o Range e transmitir indefinidamente.
    try { await reader.cancel(); } catch {}
  }
  return Buffer.concat(chunks).subarray(0, limit);
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return String(url || '').slice(0, 60); }
}

function describeNetError(err, url) {
  const raw = String((err && err.message) || err || '');

  if (/Failed to parse URL/i.test(raw)) {
    return 'O endereço informado não é uma URL válida. Verifique se ele foi colado por inteiro, ' +
           'sem espaços ou quebras de linha.';
  }
  if (err && err.name === 'AbortError') {
    return `Tempo esgotado esperando "${hostOf(url)}". O servidor pode estar sobrecarregado.`;
  }

  const code = (raw.match(/ERR_[A-Z_]+/) || [])[0];
  if (code && NET_ERRORS[code]) {
    let msg = 'Não foi possível conectar: ' + NET_ERRORS[code].replace('{host}', hostOf(url)) + '.';
    if (code === 'ERR_NAME_NOT_RESOLVED' || code === 'ERR_NAME_RESOLUTION_FAILED') {
      if (dohEnabled) msg += ' Nem o DNS do Google/Cloudflare encontrou esse domínio.';
      msg += ' Provedores de IPTV trocam de domínio com frequência — confira a URL com quem ' +
             'fornece a lista e veja se ela não mudou de endereço.';
    }
    return msg;
  }
  return raw || 'Falha desconhecida na conexão.';
}

/* ------------------------------------------------------------------ *
 * DNS alternativo (Google / Cloudflare)
 *
 * Provedores de internet costumam bloquear domínios de IPTV respondendo
 * "domínio não existe" no DNS do roteador. Quando isso acontece, o app passa
 * a resolver nomes por DNS-over-HTTPS. A troca vale para o Chromium inteiro —
 * listas, API Xtream e os próprios streams do player — e fica gravada nas
 * configurações para as próximas aberturas.
 * ------------------------------------------------------------------ */
const DOH_SERVERS = ['https://dns.google/dns-query', 'https://cloudflare-dns.com/dns-query'];
let dohEnabled = false;

/** Liga o DoH. Devolve true só na primeira vez, para quem chamou tentar de novo. */
async function enableDoh() {
  if (dohEnabled) return false;
  dohEnabled = true;
  // "secure" e não "automatic": no automático o Chromium só usa o DoH depois
  // de sondar os servidores em segundo plano, e a nova tentativa ainda cairia
  // no DNS do roteador. Endereços IP continuam funcionando (não passam por DNS).
  app.configureHostResolver({ secureDnsMode: 'secure', secureDnsServers: DOH_SERVERS });
  // A falha anterior fica no cache de DNS por um tempo; sem isto a nova
  // tentativa receberia o mesmo erro.
  await session.defaultSession.clearHostResolverCache().catch(() => {});
  console.log('[dns] domínio não resolvido pelo DNS do sistema; usando Google/Cloudflare (DoH)');
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('net:dnsFallback');
  return true;
}

function isDnsFailure(err) {
  return /ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(String((err && err.message) || err || ''));
}

/* ------------------------------------------------------------------ *
 * HTTP helper (processo main -> sem CORS)
 *
 * Usa net.fetch (pilha do Chromium) em vez do fetch do Node: assim os
 * hooks de webRequest e o tratamento de certificados autoassinados
 * valem também para as chamadas da API Xtream.
 * ------------------------------------------------------------------ */
/**
 * Painéis IPTV sobrecarregados costumam falhar na primeira tentativa e
 * responder na seguinte. Tenta de novo, com espera crescente, em erros
 * passageiros: 5xx/429, conexão derrubada e — só em chamadas curtas, como a
 * API Xtream — tempo esgotado. Um download de lista de 2 minutos que estourou
 * o tempo não é repetido: seriam mais 4 minutos de espera.
 */
const RETRY_DELAYS_MS = [1000, 3000];
const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const TRANSIENT_NET = /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED|ERR_HTTP2_PROTOCOL_ERROR|ERR_TIMED_OUT|ERR_CONNECTION_TIMED_OUT/;

async function httpGet(url, opts = {}) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await httpGetOnce(url, opts);
    if (res.ok || !res.transient || attempt >= RETRY_DELAYS_MS.length) break;
    if (res.timedOut && (opts.timeout || 30000) > 30000) break;
    console.log(`[net] falha passageira em ${hostOf(url)}; nova tentativa em ${RETRY_DELAYS_MS[attempt]} ms`);
    await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
  }
  delete res.transient;
  delete res.timedOut;
  return res;
}

async function httpGetOnce(url, { timeout = 30000, json = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await net.fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': currentUA, 'Accept': '*/*' }
    });
    if (!res.ok) {
      const extra = res.status === 401 || res.status === 403
        ? ' — usuário, senha ou assinatura recusados pelo servidor'
        : res.status === 404 ? ' — este endereço não existe nesse servidor' : '';
      return {
        ok: false,
        transient: TRANSIENT_STATUS.has(res.status),
        error: `O servidor respondeu ${res.status} ${res.statusText}${extra}.`
      };
    }
    const text = await res.text();
    if (!json) return { ok: true, data: text };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return {
        ok: false,
        error: 'O servidor respondeu algo que não é JSON. Verifique o endereço, o usuário e a ' +
               'senha — muitos painéis devolvem uma página de erro em HTML quando o login falha.'
      };
    }
  } catch (err) {
    if (isDnsFailure(err) && await enableDoh()) {
      clearTimeout(timer);
      return httpGetOnce(url, { timeout, json });
    }
    const timedOut = !!(err && err.name === 'AbortError');
    return {
      ok: false,
      transient: timedOut || TRANSIENT_NET.test(String((err && err.message) || err || '')),
      timedOut,
      error: describeNetError(err, url)
    };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * Player externo (VLC / mpv)
 *
 * O Chromium não toca .mkv nem áudio AC3/E-AC3 (Dolby) — o vídeo abre mudo ou
 * nem abre. VLC e mpv tocam tudo isso; o app só os chama com a URL e o mesmo
 * User-Agent. O caminho vem da configuração gravada em disco, nunca do
 * renderer, para que nenhuma página consiga mandar executar outro programa.
 * ------------------------------------------------------------------ */
function externalPlayerCandidates() {
  const list = [];
  if (process.platform === 'win32') {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'],
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
    for (const base of bases) {
      list.push(path.join(base, 'VideoLAN', 'VLC', 'vlc.exe'));
      list.push(path.join(base, 'mpv', 'mpv.exe'));
    }
    if (process.env.USERPROFILE) list.push(path.join(process.env.USERPROFILE, 'scoop', 'apps', 'mpv', 'current', 'mpv.exe'));
  } else if (process.platform === 'darwin') {
    list.push('/Applications/VLC.app/Contents/MacOS/VLC', '/Applications/mpv.app/Contents/MacOS/mpv',
      '/opt/homebrew/bin/mpv', '/usr/local/bin/mpv');
  } else {
    list.push('/usr/bin/vlc', '/usr/bin/mpv', '/snap/bin/vlc', '/usr/local/bin/mpv', '/var/lib/flatpak/exports/bin/org.videolan.VLC');
  }
  return list;
}

async function findExternalPlayer() {
  const saved = await readStore();
  const custom = saved && saved.settings && String(saved.settings.externalPlayer || '').trim();
  if (custom) {
    try { await fsp.access(custom); return { path: custom, custom: true }; } catch {
      return { path: null, error: `O player configurado não foi encontrado: ${custom}` };
    }
  }
  for (const p of externalPlayerCandidates()) {
    try { await fsp.access(p); return { path: p, custom: false }; } catch {}
  }
  return { path: null };
}

function externalPlayerName(exe) {
  return /mpv/i.test(path.basename(exe)) ? 'mpv' : /vlc/i.test(path.basename(exe)) ? 'VLC' : path.basename(exe);
}

async function openExternal({ url, title, userAgent, referer } = {}) {
  url = String(url || '').trim();
  if (!/^(https?|rtmp|rtsp|udp|rtp):\/\//i.test(url)) return { ok: false, error: 'Endereço de stream inválido.' };
  const found = await findExternalPlayer();
  if (!found.path) {
    return {
      ok: false,
      error: found.error || 'Nenhum player externo encontrado. Instale o VLC (videolan.org) ou informe o ' +
        'caminho do player em Configurações.'
    };
  }
  const ua = String(userAgent || currentUA);
  const name = externalPlayerName(found.path);
  const args = name === 'mpv'
    ? [`--user-agent=${ua}`, ...(referer ? [`--referrer=${referer}`] : []),
       ...(title ? [`--force-media-title=${title}`] : []), '--', url]
    : [`--http-user-agent=${ua}`, ...(referer ? [`--http-referrer=${referer}`] : []),
       ...(title ? [`--meta-title=${title}`] : []), url];
  return new Promise((resolve) => {
    let child;
    try {
      child = require('child_process').spawn(found.path, args, { detached: true, stdio: 'ignore' });
    } catch (err) {
      resolve({ ok: false, error: `Não foi possível abrir o ${name}: ${err.message || err}` });
      return;
    }
    child.once('error', (err) => resolve({ ok: false, error: `Não foi possível abrir o ${name}: ${err.message || err}` }));
    child.once('spawn', () => { child.unref(); resolve({ ok: true, name }); });
  });
}

/**
 * Descobre o que existe de fato numa URL de stream (ver o handler net:probe).
 * `dnsFallback: true` avisa o player de que o DNS foi trocado agora e que
 * vale tentar tocar de novo.
 */
async function probe(url, retried = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await net.fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': currentUA, 'Accept': '*/*', 'Range': 'bytes=0-8191' }
    });
    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const head = await readHead(res, 8192);
    const sniff = sniffFormat(head);
    const textual = /text\/|json|mpegurl|mpeg-url|x-scpls/.test(contentType) ||
                    sniff === 'hls' || sniff === 'html';
    const snippet = textual ? head.toString('utf8').slice(0, 6000) : '';
    return { ok: true, status: res.status, contentType, finalUrl: res.url || url, snippet, sniff, dnsFallback: retried };
  } catch (err) {
    if (isDnsFailure(err) && await enableDoh()) {
      clearTimeout(timer);
      return probe(url, true);
    }
    return { ok: false, error: describeNetError(err, url) };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  ipcMain.handle('dialog:pickM3U', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Selecionar lista IPTV',
      properties: ['openFile'],
      filters: [
        { name: 'Listas IPTV', extensions: ['m3u', 'm3u8', 'txt'] },
        { name: 'Todos os arquivos', extensions: ['*'] }
      ]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    const file = res.filePaths[0];
    try {
      const data = await fsp.readFile(file, 'utf8');
      return { ok: true, data, path: file, name: path.basename(file) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('fs:readFile', async (_e, filePath) => {
    try {
      const data = await fsp.readFile(filePath, 'utf8');
      return { ok: true, data, name: path.basename(filePath) };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('net:get', async (_e, url, opts) => httpGet(url, opts || {}));
  ipcMain.handle('net:getJson', async (_e, url) => httpGet(url, { json: true }));

  /**
   * Descobre o que existe de fato numa URL de stream: status, content-type e
   * a URL final após redirecionamentos. Muitas listas trazem links sem
   * extensão, e vários painéis respondem com uma página HTML de erro em vez
   * de um código HTTP — sem isso o player só conseguiria dizer
   * "formato não suportado".
   */
  ipcMain.handle('net:probe', async (_e, url) => probe(url));

  ipcMain.handle('player:external', async (_e, opts) => openExternal(opts || {}));
  ipcMain.handle('player:detectExternal', async () => {
    const found = await findExternalPlayer();
    return found.path ? { ok: true, path: found.path, name: externalPlayerName(found.path), custom: found.custom }
      : { ok: false, error: found.error || '' };
  });

  ipcMain.handle('store:read', async () => readStore());
  ipcMain.handle('store:write', async (_e, data) => { await writeStore(data); return { ok: true }; });
  ipcMain.handle('store:status', () => storeStatus);

  /** Salva uma cópia da configuração onde o usuário escolher. */
  ipcMain.handle('store:export', async () => {
    await writeQueue;
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Exportar listas e configurações',
      defaultPath: path.join(app.getPath('documents'), `bishoptv-backup-${stamp().slice(0, 10)}.json`),
      filters: [{ name: 'Backup do BishopTV', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    try {
      await fsp.copyFile(storePath(), res.filePath);
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  /**
   * Troca a configuração atual pela de um backup. A atual vai antes para
   * backups/, então importar o arquivo errado também tem volta.
   */
  ipcMain.handle('store:import', async () => {
    await fsp.mkdir(backupDir(), { recursive: true }).catch(() => {});
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Importar listas e configurações',
      defaultPath: backupDir(),
      properties: ['openFile'],
      filters: [{ name: 'Backup do BishopTV', extensions: ['json', 'bak', 'txt'] }, { name: 'Todos os arquivos', extensions: ['*'] }]
    });
    if (res.canceled || !res.filePaths.length) return { ok: false, canceled: true };
    let data;
    try {
      data = await readJson(res.filePaths[0]);
    } catch (err) {
      return { ok: false, error: `Este arquivo não é um backup válido (${err.message}).` };
    }
    if (!Array.isArray(data.sources)) {
      return { ok: false, error: 'Este arquivo não é um backup do BishopTV: não há listas nele.' };
    }
    await writeQueue;
    await fsp.copyFile(storePath(), path.join(backupDir(), `store-antes-de-importar-${stamp()}.json`)).catch(() => {});
    await writeStore(data);
    return { ok: true, sources: data.sources.length };
  });

  ipcMain.handle('store:openBackups', async () => {
    await fsp.mkdir(backupDir(), { recursive: true }).catch(() => {});
    const err = await shell.openPath(backupDir());
    return err ? { ok: false, error: err } : { ok: true };
  });

  ipcMain.handle('cache:write', async (_e, key, payload) => {
    try {
      await ensureCacheDir();
      const file = path.join(cacheDir(), key + '.json');
      await fsp.writeFile(file, JSON.stringify(payload), 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('cache:read', async (_e, key) => {
    try {
      const file = path.join(cacheDir(), key + '.json');
      const raw = await fsp.readFile(file, 'utf8');
      return { ok: true, data: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle('cache:clear', async () => {
    try {
      await fsp.rm(cacheDir(), { recursive: true, force: true });
      await ensureCacheDir();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  });

  ipcMain.handle('config:setUserAgent', (_e, ua) => {
    currentUA = (ua && String(ua).trim()) || DEFAULT_UA;
    return { ok: true, ua: currentUA };
  });

  ipcMain.handle('window:action', (_e, action) => {
    if (!mainWindow) return { ok: false };
    switch (action) {
      case 'minimize': mainWindow.minimize(); break;
      case 'maximize':
        if (mainWindow.isMaximized()) mainWindow.unmaximize();
        else mainWindow.maximize();
        break;
      case 'close': mainWindow.close(); break;
      case 'fullscreen': mainWindow.setFullScreen(!mainWindow.isFullScreen()); break;
      case 'exit-fullscreen': mainWindow.setFullScreen(false); break;
    }
    if (!mainWindow || mainWindow.isDestroyed()) return { ok: true };
    return { ok: true, maximized: mainWindow.isMaximized(), fullscreen: mainWindow.isFullScreen() };
  });

  ipcMain.handle('power:keepAwake', (_e, on) => {
    if (on && psbId === null) {
      psbId = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!on && psbId !== null) {
      powerSaveBlocker.stop(psbId);
      psbId = null;
    }
    return { ok: true };
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    userData: app.getPath('userData'),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }));

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors,BlockInsecurePrivateNetworkRequests');
app.commandLine.appendSwitch('ignore-certificate-errors');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await ensureCacheDir().catch(() => {});
    await migrateLegacyStore();
    const saved = await readStore();
    await dailyBackup();
    if (saved && saved.settings && saved.settings.userAgent) currentUA = saved.settings.userAgent;
    // A rede já precisou do DNS alternativo antes: liga desde o início, para
    // que listas em cache e streams abram sem esperar uma falha primeiro.
    if (saved && saved.settings && saved.settings.dnsFallback) await enableDoh();
    installRequestHooks();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// Certificados autoassinados sao comuns em paineis IPTV.
app.on('certificate-error', (event, _wc, _url, _err, _cert, callback) => {
  event.preventDefault();
  callback(true);
});
