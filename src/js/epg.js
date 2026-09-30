/* ==================================================================
   epg.js — guia de programação (XMLTV)

   Painéis Xtream publicam o guia em /xmltv.php com o mesmo usuário e senha
   da lista; uma M3U pode indicar outro endereço no cabeçalho (url-tvg). O
   XMLTV costuma ter dezenas de MB e uma semana inteira, então só guardamos a
   janela útil (2h para trás, 36h para frente), sem o resto do XML.
   ================================================================== */
'use strict';

const EPG = {
  BACK_MS: 2 * 3600e3,
  AHEAD_MS: 36 * 3600e3,
  MAX_AGE_MS: 6 * 3600e3,   // idade a partir da qual baixa de novo
  DESC_MAX: 280,

  byId: new Map(),    // id do canal no XMLTV (minúsculo) → [[início, fim, título, descrição]] por início
  names: new Map(),   // nome normalizado → id, para canais sem tvg-id
  chanOf: new Map(),  // key do item → id resolvido (ou null)
  sourceId: null,
  at: 0,
  loading: null,
  status: { state: 'idle', msg: '' },
  listeners: [],

  onUpdate(fn) { this.listeners.push(fn); },
  _emit() { for (const fn of this.listeners) { try { fn(); } catch (e) { console.warn('[epg]', e); } } },
  _setStatus(state, msg) { this.status = { state, msg }; this._emit(); },

  cacheKey(src) { return 'epg-' + src.id; },

  /**
   * Endereço do guia da fonte: o informado pelo usuário, o do cabeçalho da
   * M3U ou o xmltv.php do painel. Arquivos .gz ficam de fora — o app não
   * descompacta; os painéis servem o XML com gzip de transporte, que o HTTP
   * já resolve.
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

  reset(sourceId) {
    this.byId = new Map();
    this.names = new Map();
    this.chanOf = new Map();
    this.sourceId = sourceId;
    this.at = 0;
    this.status = { state: 'idle', msg: '' };
  },

  /** Ao abrir uma lista: aplica o cache na hora e atualiza em segundo plano se precisar. */
  async init(src) {
    this.reset(src.id);
    const url = this.urlFor(src);
    if (!url) return this._setStatus('none', 'Esta lista não informa um endereço de EPG.');
    try {
      const cached = await window.bishop.cache.read(this.cacheKey(src));
      if (cached && cached.ok && cached.data && cached.data.url === url) this.apply(cached.data);
    } catch {}
    if (this.stale()) setTimeout(() => this.refresh(src).catch(() => {}), 4000);
  },

  stale() { return !this.at || Date.now() - this.at > this.MAX_AGE_MS; },

  /** Baixa e interpreta o guia da fonte. Uma chamada por vez. */
  refresh(src) {
    if (this.loading) return this.loading;
    const url = this.urlFor(src);
    if (!url) {
      this._setStatus('none', 'Esta lista não informa um endereço de EPG.');
      return Promise.resolve({ ok: false, error: this.status.msg });
    }
    this._setStatus('loading', 'Baixando a programação…');

    this.loading = (async () => {
      const parser = this.parser();
      let res;
      // Android: interpreta enquanto lê, sem montar o XML inteiro na memória.
      if (window.bishop.stream) {
        res = await window.bishop.stream(url, { timeout: 180000, onChunk: (c) => parser.push(c) });
      } else {
        res = await window.bishop.get(url, { timeout: 180000 });
        // Em fatias, devolvendo a vez à interface entre elas.
        const SLICE = 512 * 1024;
        for (let i = 0; res.ok && i < res.data.length; i += SLICE) {
          parser.push(res.data.slice(i, i + SLICE));
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      if (!res.ok) throw new Error(res.error || 'Não foi possível baixar o EPG.');
      const data = parser.end();
      if (!data.count) throw new Error('O endereço do EPG não trouxe programação para as próximas horas.');
      if (this.sourceId !== src.id) return { ok: false, error: 'A lista mudou durante o download.' };

      data.url = url;
      data.at = Date.now();
      this.apply(data);
      await window.bishop.cache.write(this.cacheKey(src), data);
      return { ok: true };
    })().catch((err) => {
      const msg = String(err.message || err);
      if (this.sourceId === src.id) this._setStatus('error', msg);
      return { ok: false, error: msg };
    }).finally(() => { this.loading = null; });

    return this.loading;
  },

  apply(data) {
    this.byId = new Map(Object.entries(data.progs || {}));
    this.names = new Map();
    for (const [id, names] of Object.entries(data.channels || {})) {
      for (const n of names) {
        const k = this.nameKey(n);
        if (k && !this.names.has(k)) this.names.set(k, id);
      }
    }
    this.chanOf = new Map();
    this.at = data.at || Date.now();
    const hh = this.hhmm(this.at);
    this._setStatus('ok', `${this.byId.size.toLocaleString('pt-BR')} canais no guia · atualizado às ${hh}`);
  },

  /* ------------------------------------------------------------------
   * Parser XMLTV incremental
   * ------------------------------------------------------------------ */
  parser() {
    const now = Date.now();
    const from = now - this.BACK_MS;
    const to = now + this.AHEAD_MS;
    const out = { channels: {}, progs: {}, count: 0 };
    let buf = '';

    const drain = () => {
      let pos = 0;
      // Próxima tag de cada tipo, guardada entre as voltas: procurar "<channel"
      // de novo a cada programa varreria o resto do arquivo milhares de vezes.
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
        if (isProg) this._prog(el, out, from, to);
        else this._chan(el, out);
      }
      buf = buf.slice(pos);
    };

    return {
      push: (chunk) => { buf += chunk; drain(); },
      end: () => {
        drain();
        buf = '';
        for (const list of Object.values(out.progs)) list.sort((a, b) => a[0] - b[0]);
        return out;
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

  _chan(el, out) {
    const head = el.slice(0, el.indexOf('>'));
    const id = this._attr(head, 'id').toLowerCase();
    if (!id) return;
    const names = [];
    const re = /<display-name[^>]*>([\s\S]*?)<\/display-name>/g;
    let m;
    while ((m = re.exec(el))) names.push(this._decode(m[1]).trim());
    out.channels[id] = names;
  },

  _prog(el, out, from, to) {
    const head = el.slice(0, el.indexOf('>'));
    const s = this.parseTime(this._attr(head, 'start'));
    const e = this.parseTime(this._attr(head, 'stop'));
    if (!s || !e || e <= from || s >= to) return;
    const id = this._attr(head, 'channel').toLowerCase();
    const title = this._text(el, 'title');
    if (!id || !title) return;
    let desc = this._text(el, 'desc');
    if (desc.length > this.DESC_MAX) desc = desc.slice(0, this.DESC_MAX - 1).trimEnd() + '…';
    (out.progs[id] = out.progs[id] || []).push([s, e, title, desc]);
    out.count++;
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

  channelId(item) {
    if (!item || item.type !== 'live' || !this.byId.size) return null;
    if (this.chanOf.has(item.key)) return this.chanOf.get(item.key);
    let id = null;
    const tid = String(item.tvgId || '').toLowerCase();
    if (tid && this.byId.has(tid)) id = tid;
    else {
      const byName = this.names.get(this.nameKey(item.title || item.name));
      if (byName && this.byId.has(byName)) id = byName;
    }
    this.chanOf.set(item.key, id);
    return id;
  },

  /** { now, next } do canal, cada um {start, stop, title, desc}; null sem guia. */
  nowNext(item, at = Date.now()) {
    const id = this.channelId(item);
    const list = id && this.byId.get(id);
    if (!list || !list.length) return null;
    // Primeiro programa que ainda não terminou.
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid][1] <= at) lo = mid + 1; else hi = mid;
    }
    const cur = list[lo] && list[lo][0] <= at ? list[lo] : null;
    const next = cur ? list[lo + 1] : list[lo];
    if (!cur && !next) return null;
    return { now: cur ? this._obj(cur) : null, next: next ? this._obj(next) : null };
  },

  _obj(p) { return { start: p[0], stop: p[1], title: p[2], desc: p[3] }; },

  progress(p, at = Date.now()) {
    return Math.min(1, Math.max(0, (at - p.start) / Math.max(1, p.stop - p.start)));
  },

  hhmm(t) { return new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }); },

  /** Uma linha para o player: "Agora: X (20:00–21:00) · A seguir: 21:00 Y". */
  line(item) {
    const nn = this.nowNext(item);
    if (!nn) return '';
    const parts = [];
    if (nn.now) parts.push(`Agora: ${nn.now.title} (${this.hhmm(nn.now.start)}–${this.hhmm(nn.now.stop)})`);
    if (nn.next) parts.push(`A seguir: ${this.hhmm(nn.next.start)} ${nn.next.title}`);
    return parts.join(' · ');
  }
};
