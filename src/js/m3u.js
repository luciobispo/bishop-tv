/* ==================================================================
   m3u.js — parser de listas M3U / M3U Plus
   ================================================================== */
'use strict';

const M3U = {
  ATTR_RE: /([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/g,

  // Padrões de "Nome S01E02" em várias formas usadas pelas listas BR/PT.
  EP_PATTERNS: [
    /^(.*?)[\s._\-]+[SsTt](\d{1,2})[\s._\-]*[EeXx](\d{1,3})\b(.*)$/,
    /^(.*?)[\s._\-]+(\d{1,2})[xX](\d{1,3})\b(.*)$/,
    /^(.*?)[\s._\-]+(?:Temporada|TEMPORADA)[\s._\-]*(\d{1,2})[\s._\-]*(?:Epis[oó]dio|EP|Ep)[\s._\-]*(\d{1,3})\b(.*)$/i,
    /^(.*?)[\s._\-]+[Ss](\d{1,2})[\s._\-]+[Ee][Pp]?[\s._\-]*(\d{1,3})\b(.*)$/
  ],

  MOVIE_EXT: ['mp4', 'mkv', 'avi', 'mov', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'webm'],

  /**
   * Faz o parse do texto de uma lista.
   * Retorna { items:[], playlistAttrs:{} }
   */
  parse(text) {
    const lines = String(text || '').split(/\r?\n/);
    const items = [];
    const playlistAttrs = {};

    let pending = null;    // item em construção (aguardando a URL)
    let extgrp = '';       // #EXTGRP aplicado aos próximos itens

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = raw.trim();
      if (!line) continue;

      if (line.startsWith('#EXTM3U')) {
        let m;
        this.ATTR_RE.lastIndex = 0;
        while ((m = this.ATTR_RE.exec(line))) playlistAttrs[m[1].toLowerCase()] = m[2];
        continue;
      }

      if (line.startsWith('#EXTINF')) {
        pending = this._parseExtinf(line);
        if (extgrp && !pending.group) pending.group = extgrp;
        continue;
      }

      if (line.startsWith('#EXTGRP')) {
        extgrp = line.slice(line.indexOf(':') + 1).trim();
        if (pending && !pending.group) pending.group = extgrp;
        continue;
      }

      // Opções de player (user-agent / referer por canal)
      if (line.startsWith('#EXTVLCOPT')) {
        if (!pending) continue;
        const v = line.slice(line.indexOf(':') + 1).trim();
        const eq = v.indexOf('=');
        if (eq > 0) {
          const k = v.slice(0, eq).trim().toLowerCase();
          const val = v.slice(eq + 1).trim();
          if (k === 'http-user-agent') pending.userAgent = val;
          if (k === 'http-referrer' || k === 'http-referer') pending.referer = val;
        }
        continue;
      }

      if (line.startsWith('#KODIPROP')) {
        if (!pending) continue;
        const v = line.slice(line.indexOf(':') + 1).trim();
        const eq = v.indexOf('=');
        if (eq > 0) {
          pending.kodiProps = pending.kodiProps || {};
          pending.kodiProps[v.slice(0, eq).trim()] = v.slice(eq + 1).trim();
        }
        continue;
      }

      if (line.startsWith('#')) continue; // outros comentários

      // Linha de URL
      if (pending) {
        pending.url = line;
        items.push(this._finalize(pending));
        pending = null;
      } else if (/^(https?|rtmp|rtsp|udp|rtp):/i.test(line)) {
        // URL solta, sem EXTINF
        items.push(this._finalize({ name: this._nameFromUrl(line), url: line, group: extgrp }));
      }
    }

    return { items, playlistAttrs };
  },

  /** Primeira vírgula fora de aspas — atributos podem conter vírgulas. */
  _splitAt(line, from) {
    let inQuotes = false;
    for (let i = from; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === ',' && !inQuotes) return i;
    }
    return -1;
  },

  _parseExtinf(line) {
    const out = { attrs: {} };
    const colon = line.indexOf(':');
    const comma = this._splitAt(line, colon + 1);
    const head = comma === -1 ? line.slice(colon + 1) : line.slice(colon + 1, comma);
    out.name = (comma === -1 ? '' : line.slice(comma + 1)).trim();

    const durMatch = head.match(/^\s*(-?\d+(?:\.\d+)?)/);
    out.duration = durMatch ? parseFloat(durMatch[1]) : -1;

    let m;
    this.ATTR_RE.lastIndex = 0;
    while ((m = this.ATTR_RE.exec(head))) out.attrs[m[1].toLowerCase()] = m[2];

    out.logo = out.attrs['tvg-logo'] || out.attrs['logo'] || '';
    out.group = out.attrs['group-title'] || '';
    out.tvgId = out.attrs['tvg-id'] || '';
    out.tvgName = out.attrs['tvg-name'] || '';
    out.chno = out.attrs['tvg-chno'] || out.attrs['channel-number'] || '';
    if (!out.name) out.name = out.tvgName || 'Sem nome';
    return out;
  },

  _nameFromUrl(url) {
    try {
      const p = decodeURIComponent(String(url).split('?')[0].split('/').pop() || '');
      return p.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[._]+/g, ' ').trim() || url;
    } catch {
      return url;
    }
  },

  /** Enriquece o item: tipo, título limpo, chave estável, dados de série. */
  _finalize(it) {
    const url = it.url || '';
    const name = (it.name || '').trim();
    const group = (it.group || '').trim();

    const type = this.classify(name, group, url);
    const item = {
      key: 'm' + U.hash(url + '|' + name),
      name,
      title: U.titleOf(name),
      logo: it.logo || '',
      group: group || (type === 'live' ? 'Sem categoria' : 'Diversos'),
      url,
      type,
      tvgId: it.tvgId || '',
      chno: it.chno || '',
      userAgent: it.userAgent || '',
      referer: it.referer || '',
      year: U.year(name)
    };

    if (type === 'series') {
      const ep = this.parseEpisode(name);
      if (ep) {
        item.seriesName = ep.show;
        item.season = ep.season;
        item.episode = ep.episode;
        item.epTitle = ep.title;
        item.title = ep.show;
        item.seriesKey = 's' + U.hash(U.norm(ep.show));
      } else {
        item.seriesName = U.titleOf(name);
        item.seriesKey = 's' + U.hash(U.norm(item.seriesName));
        item.season = 1;
        item.episode = null;
      }
    }

    return item;
  },

  /** live | movie | series */
  classify(name, group, url) {
    const u = String(url || '').toLowerCase();

    // Xtream Codes deixa o tipo explícito no caminho da URL.
    if (/\/series\//.test(u)) return 'series';
    if (/\/movie\//.test(u) || /\/vod\//.test(u)) return 'movie';
    if (/\/live\//.test(u)) return 'live';

    // Painéis que entregam o formato como último segmento (".../<token>/ts")
    // usam isso só para transmissão ao vivo — VOD vem como arquivo. É um
    // sinal mais confiável que o nome do grupo, que costuma classificar
    // canais 24h como se fossem séries.
    if (/\/(ts|mpegts)(\?|$)/i.test(u)) return 'live';

    const g = U.norm(group);
    const n = name || '';

    if (this.parseEpisode(n)) return 'series';
    if (/\b(serie|series|seriado|temporada|season|novela|anime|animes|doramas?)\b/.test(g)) return 'series';
    if (/\b(filme|filmes|movie|movies|vod|cinema|lancamento|lancamentos)\b/.test(g)) return 'movie';

    const ext = U.extOf(u);
    if (this.MOVIE_EXT.includes(ext)) return 'movie';

    return 'live';
  },

  /** Extrai {show, season, episode, title} de um nome de episódio. */
  parseEpisode(name) {
    const s = String(name || '').trim();
    for (const re of this.EP_PATTERNS) {
      const m = s.match(re);
      if (m) {
        const show = U.titleOf(m[1].replace(/[._]+/g, ' ').trim());
        if (!show) continue;
        return {
          show,
          season: parseInt(m[2], 10) || 1,
          episode: parseInt(m[3], 10) || 1,
          title: (m[4] || '').replace(/^[\s._\-–]+/, '').replace(/[._]+/g, ' ').trim()
        };
      }
    }
    return null;
  }
};
