/* ==================================================================
   epg.js — guia de programação (XMLTV) guardado no IndexedDB

   A versão anterior mantinha o guia inteiro num Map e o cache num JSON
   único — dezenas de MB presos na memória, o que derrubava o app no
   Firestick. Agora o XMLTV é lido aos pedaços e cada programa vai direto
   para o IndexedDB, em disco; a memória só guarda o pedaço em leitura e o
   lote em gravação. As telas consultam só o que mostram (agora/a seguir de
   um canal, a grade de um canal), por faixa de chave.

   Chaves (todas começam pela fonte e pela "geração" do download, para trocar
   o guia inteiro de uma vez quando o novo termina de gravar):
     progs  [fonte, geração, canal, início] → [fim, título, descrição]
     names  [fonte, geração, '#'+id]        → id      (canal existe no guia)
            [fonte, geração, nome]          → id      (canal sem tvg-id)
     meta   fonte                           → { gen, at, url, count, channels }
   ================================================================== */
'use strict';

const EPG = {
  DB_NAME: 'bishoptv-epg',
  BACK_MS: 2 * 3600e3,       // sem replay, guarda só as últimas 2h
  AHEAD_MS: 36 * 3600e3,
  ARCHIVE_MAX_DAYS: 7,       // com replay, até 7 dias para trás
  MAX_AGE_MS: 6 * 3600e3,    // idade a partir da qual baixa de novo
  DESC_MAX: 280,
  BATCH: 1500,               // registros por transação de gravação

  source: null,
  meta: null,
  chanOf: new Map(),         // key do item → id do canal no guia (ou null)
  loading: null,
  status: { state: 'idle', msg: '' },
  listeners: [],
  _db: null,

  onUpdate(fn) { this.listeners.push(fn); },
  _emit() { for (const fn of this.listeners) { try { fn(); } catch (e) { console.warn('[epg]', e); } } },
  _setStatus(state, msg) { this.status = { state, msg }; this._emit(); },

  ready() { return !!this.meta; },

  /* ------------------------------------------------------------------
   * IndexedDB
   * ------------------------------------------------------------------ */
  db() {
    if (!this._db) {
      this._db = new Promise((resolve, reject) => {
        const req = indexedDB.open(this.DB_NAME, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          for (const name of ['progs', 'names', 'meta']) {
            if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { this._db = null; reject(req.error); };
      });
    }
    return this._db;
  },

  async tx(stores, mode, fn) {
    const d = await this.db();
    return new Promise((resolve, reject) => {
      const t = d.transaction(stores, mode);
      const req = fn(t);
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  },

  /** Apaga as gerações anteriores a `gen` (ou todas, sem `gen`) de uma fonte. */
  _dropBefore(srcId, gen) {
    const range = gen == null
      ? IDBKeyRange.bound([srcId], [srcId, []])
      : IDBKeyRange.bound([srcId], [srcId, gen], false, true);
    return this.tx(['progs', 'names'], 'readwrite', (t) => {
      t.objectStore('progs').delete(range);
      t.objectStore('names').delete(range);
    }).catch((e) => console.warn('[epg] limpeza', e));
  },

  /** Apaga só uma geração (download que falhou no meio). */
  _dropGen(srcId, gen) {
    const range = IDBKeyRange.bound([srcId, gen], [srcId, gen, []]);
    return this.tx(['progs', 'names'], 'readwrite', (t) => {
      t.objectStore('progs').delete(range);
      t.objectStore('names').delete(range);
    }).catch(() => {});
  },

  /** Lista removida: o guia dela sai do disco junto. */
  async forget(srcId) {
    await this._dropBefore(srcId);
    await this.tx(['meta'], 'readwrite', (t) => t.objectStore('meta').delete(srcId)).catch(() => {});
    if (this.source && this.source.id === srcId) { this.source = null; this.meta = null; }
  },

  /* ------------------------------------------------------------------
   * Fonte do guia
   * ------------------------------------------------------------------ */
  /**
   * Endereço do guia: o informado pelo usuário, o do cabeçalho da M3U ou o
   * xmltv.php do painel. Arquivos .gz ficam de fora — o app não descompacta;
   * os painéis servem o XML com gzip de transporte, que o HTTP já resolve.
   */
  urlFor(src) {
    if (!src) return '';
    if (src.epgUrl) return src.epgUrl;
    if (src.tvgUrl && !/\.gz(\?|$)/i.test(src.tvgUrl)) return src.tvgUrl;
    if (src.type === 'xtream' && src.host && src.user) {
      return `${U.normalizeHost(src.host)}/xmltv.php?username=${encodeURIComponent(src.user)}&password=${encodeURIComponent(src.pass || '')}`;
    }
    if (src.type === 'url') {
      try {
        const u = new URL(src.url);
        const user = u.searchParams.get('username');
        const pass = u.searchParams.get('password');
        if (/get\.php$/i.test(u.pathname) && user && pass) {
          return `${u.origin}/xmltv.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
        }
      } catch {}
    }
    return '';
  },

  /** Ao abrir uma lista: usa o guia já gravado e atualiza em segundo plano se precisar. */
  async init(src) {
    this.source = src;
    this.meta = null;
    this.chanOf = new Map();
    if (!Store.get('epg')) return this._setStatus('off', 'Guia de programação desligado.');
    const url = this.urlFor(src);
    if (!url) return this._setStatus('none', 'Esta lista não informa um endereço de guia (EPG).');
    this._setStatus('idle', 'O guia ainda não foi baixado.');
    try {
      const m = await this.tx(['meta'], 'readonly', (t) => t.objectStore('meta').get(src.id));
      if (this.source !== src) return;
      if (m && m.url === url) { this.meta = m; this._ready(); }
    } catch (e) { console.warn('[epg]', e); }
    // Espera a interface assentar: o download disputa rede e CPU com as capas.
    if (this.stale()) setTimeout(() => { if (this.source === src) this.refresh(src).catch(() => {}); }, 6000);
  },

  stale() { return !this.meta || Date.now() - this.meta.at > this.MAX_AGE_MS; },

  _ready() {
    const m = this.meta;
    const at = new Date(m.at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    this._setStatus('ok', `${(m.channels || 0).toLocaleString('pt-BR')} canais no guia · atualizado em ${at}`);
  },

  /** Maior janela de replay entre os canais da lista, em dias. */
  archiveDays() {
    let max = 0;
    for (const it of Lib.live) if (it.archive > max) max = it.archive;
    return Math.min(this.ARCHIVE_MAX_DAYS, max);
  },

  /** Baixa o guia e grava uma geração nova. Uma chamada por vez. */
  refresh(src) {
    if (this.loading) return this.loading;
    const url = this.urlFor(src);
    if (!url) {
      this._setStatus('none', 'Esta lista não informa um endereço de guia (EPG).');
      return Promise.resolve({ ok: false, error: this.status.msg });
    }
    this._setStatus('loading', 'Baixando a programação…');
    const gen = Date.now();

    this.loading = (async () => {
      const now = Date.now();
      const from = now - Math.max(this.BACK_MS, this.archiveDays() * 864e5);
      const w = this.writer(src.id, gen);
      const parser = this.parser(from, now + this.AHEAD_MS, w);
      let res;
      if (window.bishop.stream) {
        // Android: interpreta e grava enquanto lê, sem montar o XML inteiro.
        res = await window.bishop.stream(url, { timeout: 180000, onChunk: (c) => parser.push(c) });
      } else {
        res = await window.bishop.get(url, { timeout: 180000 });
        const SLICE = 512 * 1024;
        for (let i = 0; res.ok && i < res.data.length; i += SLICE) {
          await parser.push(res.data.slice(i, i + SLICE));
          await new Promise((r) => setTimeout(r, 0));  // devolve a vez à interface
        }
        res.data = null;
      }
      if (!res.ok) throw new Error(res.error || 'Não foi possível baixar o guia.');
      await parser.end();
      if (!w.count) throw new Error('O endereço do guia não trouxe programação para as próximas horas.');

      const meta = { gen, at: Date.now(), url, count: w.count, channels: w.channels };
      await this.tx(['meta'], 'readwrite', (t) => t.objectStore('meta').put(meta, src.id));
      this._dropBefore(src.id, gen);  // gerações antigas, inclusive de downloads interrompidos
      if (this.source === src) {
        this.meta = meta;
        this.chanOf = new Map();
        this._ready();
      }
      return { ok: true };
    })().catch((err) => {
      this._dropGen(src.id, gen);
      const msg = String((err && err.message) || err);
      if (this.source === src) {
        if (this.meta) this._setStatus('ok', `Não foi possível atualizar (${msg}); usando o guia anterior.`);
        else this._setStatus('error', msg);
      }
      return { ok: false, error: msg };
    }).finally(() => { this.loading = null; });

    return this.loading;
  },

  /** Acumula programas e canais e grava em lotes. */
  writer(srcId, gen) {
    let progs = [], names = [];
    const w = {
      count: 0,
      channels: 0,
      prog(ch, start, stop, title, desc) {
        progs.push([[srcId, gen, ch, start], [stop, title, desc]]);
        w.count++;
      },
      chan(id, displayNames) {
        names.push([[srcId, gen, '#' + id], id]);
        for (const n of displayNames) {
          const k = EPG.nameKey(n);
          if (k) names.push([[srcId, gen, k], id]);
        }
        w.channels++;
      },
      full() { return progs.length + names.length >= EPG.BATCH; },
      async flush() {
        if (!progs.length && !names.length) return;
        const p = progs, n = names;
        progs = []; names = [];
        await EPG.tx(['progs', 'names'], 'readwrite', (t) => {
          const ps = t.objectStore('progs'), ns = t.objectStore('names');
          for (const [k, v] of p) ps.put(v, k);
          for (const [k, v] of n) ns.put(v, k);
        });
      }
    };
    return w;
  },

  /* ------------------------------------------------------------------
   * Parser XMLTV incremental
   * ------------------------------------------------------------------ */
  parser(from, to, w) {
    let buf = '';

    const drain = () => {
      let pos = 0;
      // Próxima tag de cada tipo, guardada entre as voltas: procurar "<channel"
      // de novo a cada programa varreria o resto do pedaço milhares de vezes.
      let c = buf.indexOf('<channel');
      let p = buf.indexOf('<programme');
      for (;;) {
        if (c !== -1 && c < pos) c = buf.indexOf('<channel', pos);
        if (p !== -1 && p < pos) p = buf.indexOf('<programme', pos);
        const start = c === -1 ? p : p === -1 ? c : Math.min(c, p);
        if (start === -1) {
          pos = Math.max(pos, buf.length - 16); // um "<progra" pode ter ficado cortado
          break;
        }
        const isProg = start === p;
        const close = isProg ? '</programme>' : '</channel>';
        const end = buf.indexOf(close, start);
        if (end === -1) { pos = start; break; }
        const el = buf.slice(start, end + close.length);
        pos = end + close.length;
        if (isProg) this._prog(el, w, from, to);
        else this._chan(el, w);
      }
      buf = buf.slice(pos);
    };

    return {
      push: async (chunk) => {
        buf += chunk;
        drain();
        if (w.full()) await w.flush();
      },
      end: async () => {
        drain();
        buf = '';
        await w.flush();
      }
    };
  },

  _attr(head, name) {
    const m = head.match(new RegExp('\\s' + name + '="([^"]*)"'));
    return m ? m[1] : '';
  },

  _text(el, tag) {
    const m = el.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>'));
    if (!m) return '';
    return this._decode(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '')).trim();
  },

  _decode(s) {
    return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (all, e) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    });
  },

  _chan(el, w) {
    const head = el.slice(0, el.indexOf('>'));
    const id = this._attr(head, 'id').toLowerCase();
    if (!id) return;
    const names = [];
    const re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
    let m;
    while ((m = re.exec(el))) names.push(this._decode(m[1]).trim());
    w.chan(id, names);
  },

  _prog(el, w, from, to) {
    const head = el.slice(0, el.indexOf('>'));
    const s = this.parseTime(this._attr(head, 'start'));
    const e = this.parseTime(this._attr(head, 'stop'));
    if (!s || !e || e <= from || s >= to) return;
    const id = this._attr(head, 'channel').toLowerCase();
    const title = this._text(el, 'title');
    if (!id || !title) return;
    let desc = this._text(el, 'desc');
    if (desc.length > this.DESC_MAX) desc = desc.slice(0, this.DESC_MAX - 1).trimEnd() + '…';
    w.prog(id, s, e, title, desc);
  },

  /** "20260930015000 +0000" → epoch ms. Sem fuso, assume UTC. */
  parseTime(v) {
    const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)?\s*(?:([+-])(\d\d)(\d\d))?/.exec(v || '');
    if (!m) return 0;
    let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    if (m[7]) t -= (m[7] === '-' ? -1 : 1) * (+m[8] * 60 + +m[9]) * 60000;
    return t;
  },

  /* ------------------------------------------------------------------
   * Consulta
   * ------------------------------------------------------------------ */
  /** Nome comparável: sem qualidade, país ou sufixos ("A&E HD BR" = "A&E FHD"). */
  nameKey(n) {
    return U.norm(U.cleanName(n))
      .replace(/\b(sd|hd|fhd|uhd|4k|8k|h ?265|hevc|br|alt|backup|\d+ ?fps)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },

  async channelId(item) {
    if (!this.meta || !this.source || !item || item.type !== 'live') return null;
    if (this.chanOf.has(item.key)) return this.chanOf.get(item.key);
    const srcId = this.source.id, gen = this.meta.gen;
    const keys = [];
    const tid = String(item.epgId || item.tvgId || '').toLowerCase();
    if (tid) keys.push([srcId, gen, '#' + tid]);
    const nk = this.nameKey(item.title || item.name);
    if (nk) keys.push([srcId, gen, nk]);
    let id = null;
    try {
      for (const k of keys) {
        id = await this.tx(['names'], 'readonly', (t) => t.objectStore('names').get(k));
        if (id) break;
      }
    } catch (e) { console.warn('[epg]', e); }
    if (this.meta && this.meta.gen === gen) this.chanOf.set(item.key, id || null);
    return id || null;
  },

  /** Programas do canal que terminam depois de `from` e começam antes de `to`. */
  async programmes(item, from, to) {
    const id = await this.channelId(item);
    if (!id || !this.meta) return [];
    const srcId = this.source.id, gen = this.meta.gen;
    // Um programa que começou até 12h antes de `from` ainda pode estar no ar.
    const range = IDBKeyRange.bound([srcId, gen, id, from - 12 * 3600e3], [srcId, gen, id, to]);
    const d = await this.db();
    return new Promise((resolve, reject) => {
      const out = [];
      const t = d.transaction('progs', 'readonly');
      const req = t.objectStore('progs').openCursor(range);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return;
        const [stop, title, desc] = cur.value;
        if (stop > from) out.push({ start: cur.key[3], stop, title, desc });
        cur.continue();
      };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  },

  /** { now, next } do canal, cada um {start, stop, title, desc}; null sem guia. */
  async nowNext(item, at = Date.now()) {
    if (!this.meta) return null;
    const list = await this.programmes(item, at, at + 12 * 3600e3);
    const now = list.find((p) => p.start <= at && p.stop > at) || null;
    const next = list.find((p) => p.start >= (now ? now.stop : at)) || null;
    return now || next ? { now, next } : null;
  },

  /** Linha curta para o player: "Agora: X (21:00–22:00) · A seguir: Y". */
  describe(nn) {
    if (!nn) return '';
    const parts = [];
    if (nn.now) parts.push(`Agora: ${nn.now.title} (${this.hhmm(nn.now.start)}–${this.hhmm(nn.now.stop)})`);
    if (nn.next) parts.push(`A seguir: ${nn.next.title} às ${this.hhmm(nn.next.start)}`);
    return parts.join(' · ');
  },

  progress(p, at = Date.now()) {
    return Math.min(1, Math.max(0, (at - p.start) / Math.max(1, p.stop - p.start)));
  },

  hhmm(t) { return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); }
};
