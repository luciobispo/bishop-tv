/* ==================================================================
   android.js — window.bishop no Android (Capacitor)

   No Electron, o preload.js já expôs window.bishop e este arquivo não faz
   nada. No Android, o mesmo contrato é implementado com:
     - NativeHttp     → requisições nativas (sem CORS, com User-Agent e DNS
                        do Google/Cloudflare se o do sistema não resolver)
     - IndexedDB      → configuração e cache das listas
     - NativePlayer   → ExoPlayer (android/.../PlayerActivity.java)
   ================================================================== */
'use strict';

(() => {
  if (window.bishop || !window.Capacitor || !window.Capacitor.isNativePlatform()) return;

  const Cap = window.Capacitor;
  const plugin = (name) => (Cap.Plugins && Cap.Plugins[name]) || Cap.registerPlugin(name);
  const NativeHttp = plugin('NativeHttp');
  const AppPlugin = plugin('App');
  const NativePlayer = plugin('NativePlayer');

  document.documentElement.classList.add('is-android');

  /* ---------------- IndexedDB ---------------- */
  const DB_NAME = 'bishoptv';
  let dbPromise = null;
  function db() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 2);
        req.onupgradeneeded = () => {
          const d = req.result;
          for (const name of ['kv', 'cache', 'files']) {
            if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function idb(storeName, mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, mode);
      const req = fn(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /* ---------------- HTTP ---------------- */
  let userAgent = 'VLC/3.0.20 LibVLC/3.0.20';

  function hostOf(url) {
    try { return new URL(url).host; } catch { return String(url || '').slice(0, 60); }
  }

  function describeError(err, url) {
    const raw = String((err && (err.message || err.errorMessage)) || err || '');
    const host = hostOf(url);
    if (/UnknownHost|Unable to resolve host/i.test(raw)) {
      return `Não foi possível conectar: o endereço "${host}" não existe — nem o DNS da rede nem o do ` +
        'Google/Cloudflare encontraram esse domínio. Provedores de IPTV trocam de domínio com frequência — ' +
        'confira a URL com quem fornece a lista.';
    }
    if (/Failed to parse URL/i.test(raw)) {
      return 'O endereço informado não é uma URL válida. Verifique se ele foi colado por inteiro.';
    }
    if (/ConnectException|refused/i.test(raw)) return `Não foi possível conectar: o servidor "${host}" recusou a conexão.`;
    if (/timeout|timed out/i.test(raw)) return `O servidor "${host}" não respondeu a tempo.`;
    if (/Cleartext/i.test(raw)) return 'O Android bloqueou a conexão sem criptografia (http).';
    return raw || 'Falha desconhecida na conexão.';
  }

  /** Entrega o corpo aos pedaços, sem nunca montar o texto inteiro. */
  async function pump(resp, onChunk) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      onChunk(dec.decode(value, { stream: true }));
    }
    const tail = dec.decode();
    if (tail) onChunk(tail);
  }

  /**
   * O nativo grava a resposta num arquivo e o WebView o lê pelo servidor local
   * do Capacitor — ver NativeHttpPlugin. Com `onChunk`, o texto vai sendo
   * entregue enquanto é lido, para listas que não cabem na memória de uma vez.
   */
  async function httpGet(url, { timeout = 30000, json = false, onChunk } = {}) {
    let path = '';
    try {
      const res = await NativeHttp.download({ url, userAgent, timeoutMs: timeout });
      path = res.path || '';
      if (res.status >= 400) {
        const extra = res.status === 401 || res.status === 403
          ? ' — usuário, senha ou assinatura recusados pelo servidor'
          : res.status === 404 ? ' — este endereço não existe nesse servidor' : '';
        return { ok: false, error: `O servidor respondeu ${res.status}${extra}.` };
      }
      const resp = path ? await fetch(Cap.convertFileSrc(path)) : new Response('');
      if (onChunk) {
        await pump(resp, onChunk);
        return { ok: true };
      }
      if (!json) return { ok: true, data: await resp.text() };
      // Direto dos bytes: o catálogo Xtream tem dezenas de MB e, via text(),
      // o texto inteiro e o objeto ficariam na memória ao mesmo tempo.
      try {
        return { ok: true, data: await resp.json() };
      } catch {
        return {
          ok: false,
          error: 'O servidor respondeu algo que não é JSON. Verifique o endereço, o usuário e a ' +
                 'senha — muitos painéis devolvem uma página de erro em HTML quando o login falha.'
        };
      }
    } catch (err) {
      return { ok: false, error: describeError(err, url) };
    } finally {
      if (path) NativeHttp.discard({ path }).catch(() => {});
    }
  }

  /* ---------------- arquivo .m3u ---------------- */
  // O conteúdo fica num store próprio do IndexedDB e a fonte guarda só a chave
  // ("idb:…"). Dentro da configuração, a lista inteira seria copiada a cada
  // Store.save() — inclusive durante a reprodução, a cada atualização de progresso.
  const FILE_PREFIX = 'idb:';

  async function readFile(path) {
    if (!String(path || '').startsWith(FILE_PREFIX)) {
      return { ok: false, error: 'No Android a lista fica guardada no app; adicione o arquivo de novo.' };
    }
    try {
      const data = await idb('files', 'readonly', (s) => s.get(path.slice(FILE_PREFIX.length)));
      return typeof data === 'string'
        ? { ok: true, data }
        : { ok: false, error: 'A lista guardada no app não foi encontrada; adicione o arquivo de novo.' };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  function pickM3U() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      // Muitos gerenciadores de arquivo não reconhecem o MIME de .m3u.
      input.accept = '.m3u,.m3u8,.txt,audio/x-mpegurl,application/x-mpegurl,text/plain,*/*';
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        if (!f) return resolve({ ok: false, canceled: true });
        try {
          const key = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const text = await f.text();
          await idb('files', 'readwrite', (s) => s.put(text, key));
          resolve({ ok: true, name: f.name, path: FILE_PREFIX + key });
        } catch (err) {
          resolve({ ok: false, error: String(err.message || err) });
        }
      });
      input.addEventListener('cancel', () => resolve({ ok: false, canceled: true }));
      input.click();
    });
  }

  /* ---------------- botão Voltar ---------------- */
  // Na tela inicial, sair pede um segundo toque — como nos apps nativos.
  const EXIT_WINDOW_MS = 2500;
  let exitArmedAt = 0;
  function confirmExit() {
    if (Date.now() - exitArmedAt < EXIT_WINDOW_MS) return AppPlugin.exitApp();
    exitArmedAt = Date.now();
    U.toast('Pressione o botão Voltar novamente para sair.', '', EXIT_WINDOW_MS);
  }

  AppPlugin.addListener('backButton', () => {
    const detail = document.querySelector('#detail');
    if (detail && !detail.classList.contains('hidden')) return UI.closeDetail();
    const search = document.querySelector('#searchInput');
    if (search && document.activeElement === search) return search.blur();
    if (typeof UI !== 'undefined' && UI.view !== 'home' && !Lib.isEmpty) return UI.nav('home');
    confirmExit();
  });

  const noop = () => Promise.resolve({ ok: true });

  window.bishop = {
    platform: 'android',
    libs: {},

    pickM3U,
    readFile,
    pathForFile: () => '',

    get: (url, opts) => httpGet(url, opts || {}),
    // Só no Android: listas M3U grandes são interpretadas enquanto são lidas.
    stream: (url, { timeout, onChunk } = {}) => httpGet(url, { timeout, onChunk }),
    getJson: (url) => httpGet(url, { json: true }),
    // Só o player web usa; no Android quem toca é o ExoPlayer.
    probe: () => Promise.resolve({ ok: false, error: 'indisponível no Android' }),

    store: {
      read: async () => (await idb('kv', 'readonly', (s) => s.get('store'))) || {},
      write: async (data) => { await idb('kv', 'readwrite', (s) => s.put(data, 'store')); return { ok: true }; }
    },

    cache: {
      read: async (key) => {
        try {
          const data = await idb('cache', 'readonly', (s) => s.get(key));
          return data ? { ok: true, data } : { ok: false };
        } catch { return { ok: false }; }
      },
      write: async (key, payload) => {
        try { await idb('cache', 'readwrite', (s) => s.put(payload, key)); return { ok: true }; } catch (err) {
          return { ok: false, error: String(err.message || err) };
        }
      },
      clear: async () => { await idb('cache', 'readwrite', (s) => s.clear()); return { ok: true }; }
    },

    setUserAgent: (ua) => {
      userAgent = (ua && String(ua).trim()) || userAgent;
      return Promise.resolve({ ok: true, ua: userAgent });
    },
    keepAwake: noop,
    appInfo: async () => {
      const info = await AppPlugin.getInfo().catch(() => ({}));
      const chrome = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '';
      return { version: info.version || '', platform: 'Android', chrome, userData: 'armazenamento interno do app' };
    },
    openExternal: noop,

    nativePlayer: {
      play: (opts) => NativePlayer.play(opts)
    },

    window: {
      minimize: noop,
      maximize: noop,
      close: () => AppPlugin.exitApp(),
      toggleFullscreen: noop,
      exitFullscreen: noop,
      onState: () => {}
    }
  };
})();
