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
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('kv');
          req.result.createObjectStore('cache');
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

  async function httpGet(url, { timeout = 30000, json = false } = {}) {
    try {
      const res = await NativeHttp.get({ url, userAgent, timeoutMs: timeout });
      if (res.status >= 400) {
        const extra = res.status === 401 || res.status === 403
          ? ' — usuário, senha ou assinatura recusados pelo servidor'
          : res.status === 404 ? ' — este endereço não existe nesse servidor' : '';
        return { ok: false, error: `O servidor respondeu ${res.status}${extra}.` };
      }
      let data = res.data;
      if (!json) return { ok: true, data: typeof data === 'string' ? data : JSON.stringify(data) };
      if (typeof data === 'string') {
        try { data = JSON.parse(data); } catch {
          return {
            ok: false,
            error: 'O servidor respondeu algo que não é JSON. Verifique o endereço, o usuário e a ' +
                   'senha — muitos painéis devolvem uma página de erro em HTML quando o login falha.'
          };
        }
      }
      return { ok: true, data };
    } catch (err) {
      return { ok: false, error: describeError(err, url) };
    }
  }

  /* ---------------- arquivo .m3u ---------------- */
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
          resolve({ ok: true, data: await f.text(), name: f.name, path: '' });
        } catch (err) {
          resolve({ ok: false, error: String(err.message || err) });
        }
      });
      input.addEventListener('cancel', () => resolve({ ok: false, canceled: true }));
      input.click();
    });
  }

  /* ---------------- botão Voltar ---------------- */
  AppPlugin.addListener('backButton', () => {
    const detail = document.querySelector('#detail');
    if (detail && !detail.classList.contains('hidden')) return UI.closeDetail();
    const search = document.querySelector('#searchInput');
    if (search && document.activeElement === search) return search.blur();
    if (typeof UI !== 'undefined' && UI.view !== 'home' && !Lib.isEmpty) return UI.nav('home');
    AppPlugin.exitApp();
  });

  const noop = () => Promise.resolve({ ok: true });

  window.bishop = {
    platform: 'android',
    libs: {},

    pickM3U,
    readFile: () => Promise.resolve({ ok: false, error: 'No Android a lista fica guardada no app; adicione o arquivo de novo.' }),
    pathForFile: () => '',

    get: (url, opts) => httpGet(url, opts || {}),
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
