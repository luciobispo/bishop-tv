/* ==================================================================
   xtream.js — cliente da API Xtream Codes
   ================================================================== */
'use strict';

const Xtream = {
  /** Monta a URL do player_api. */
  api(src, params) {
    const host = U.normalizeHost(src.host);
    const qs = new URLSearchParams({
      username: src.user || '',
      password: src.pass || '',
      ...(params || {})
    });
    return `${host}/player_api.php?${qs.toString()}`;
  },

  async call(src, params) {
    const res = await window.bishop.getJson(this.api(src, params));
    if (!res.ok) throw new Error(res.error || 'Falha na comunicação com o servidor');
    return res.data;
  },

  /** Valida credenciais e devolve info da conta. */
  async login(src) {
    const data = await this.call(src, {});
    if (!data || !data.user_info) throw new Error('Servidor respondeu de forma inesperada');
    if (String(data.user_info.auth) === '0') throw new Error('Usuário ou senha inválidos');
    const st = String(data.user_info.status || '').toLowerCase();
    if (st && st !== 'active') throw new Error(`Conta ${data.user_info.status}`);
    return data;
  },

  /* ---------------- URLs de stream ---------------- */
  liveUrl(src, streamId, ext) {
    const host = U.normalizeHost(src.host);
    return `${host}/live/${encodeURIComponent(src.user)}/${encodeURIComponent(src.pass)}/${streamId}.${ext || 'm3u8'}`;
  },

  vodUrl(src, streamId, ext) {
    const host = U.normalizeHost(src.host);
    return `${host}/movie/${encodeURIComponent(src.user)}/${encodeURIComponent(src.pass)}/${streamId}.${ext || 'mp4'}`;
  },

  seriesUrl(src, episodeId, ext) {
    const host = U.normalizeHost(src.host);
    return `${host}/series/${encodeURIComponent(src.user)}/${encodeURIComponent(src.pass)}/${episodeId}.${ext || 'mp4'}`;
  },

  /* ---------------- catálogo ---------------- */
  async loadAll(src, onProgress) {
    const report = (msg) => { if (onProgress) onProgress(msg); };
    const items = [];

    const catMap = (list) => {
      const m = {};
      (list || []).forEach((c) => { m[String(c.category_id)] = c.category_name; });
      return m;
    };

    // ----- TV ao vivo -----
    report('Carregando canais ao vivo…');
    let liveCats = {}, live = [];
    try {
      liveCats = catMap(await this.call(src, { action: 'get_live_categories' }));
      live = await this.call(src, { action: 'get_live_streams' }) || [];
    } catch (e) { console.warn('[xtream] live', e); }

    for (const s of live) {
      const name = String(s.name || '').trim();
      items.push({
        key: 'x' + src.id + 'l' + s.stream_id,
        name,
        title: U.cleanName(name),
        logo: s.stream_icon || '',
        group: liveCats[String(s.category_id)] || 'Sem categoria',
        type: 'live',
        streamId: s.stream_id,
        url: this.liveUrl(src, s.stream_id, 'm3u8'),
        altUrl: this.liveUrl(src, s.stream_id, 'ts'),
        tvgId: s.epg_channel_id || '',
        chno: s.num || '',
        xtream: true
      });
    }

    // ----- Filmes -----
    report('Carregando filmes…');
    let vodCats = {}, vod = [];
    try {
      vodCats = catMap(await this.call(src, { action: 'get_vod_categories' }));
      vod = await this.call(src, { action: 'get_vod_streams' }) || [];
    } catch (e) { console.warn('[xtream] vod', e); }

    for (const s of vod) {
      const name = String(s.name || '').trim();
      items.push({
        key: 'x' + src.id + 'm' + s.stream_id,
        name,
        title: U.titleOf(name),
        logo: s.stream_icon || s.cover || '',
        group: vodCats[String(s.category_id)] || 'Diversos',
        type: 'movie',
        streamId: s.stream_id,
        ext: s.container_extension || 'mp4',
        url: this.vodUrl(src, s.stream_id, s.container_extension || 'mp4'),
        rating: s.rating || s.rating_5based || '',
        year: s.year || U.year(name),
        added: s.added ? Number(s.added) * 1000 : 0,
        xtream: true
      });
    }

    // ----- Séries -----
    report('Carregando séries…');
    let serCats = {}, series = [];
    try {
      serCats = catMap(await this.call(src, { action: 'get_series_categories' }));
      series = await this.call(src, { action: 'get_series' }) || [];
    } catch (e) { console.warn('[xtream] series', e); }

    for (const s of series) {
      const name = String(s.name || '').trim();
      items.push({
        key: 'x' + src.id + 's' + s.series_id,
        name,
        title: U.titleOf(name),
        logo: s.cover || '',
        backdrop: (Array.isArray(s.backdrop_path) && s.backdrop_path[0]) || '',
        group: serCats[String(s.category_id)] || 'Diversos',
        type: 'series',
        seriesId: s.series_id,
        seriesKey: 'x' + src.id + 's' + s.series_id,
        seriesName: U.titleOf(name),
        plot: s.plot || '',
        cast: s.cast || '',
        director: s.director || '',
        genre: s.genre || '',
        rating: s.rating || '',
        year: s.releaseDate ? String(s.releaseDate).slice(0, 4) : U.year(name),
        episodeRunTime: s.episode_run_time || '',
        lazyEpisodes: true,
        xtream: true
      });
    }

    report(`${items.length.toLocaleString('pt-BR')} itens carregados`);
    return items;
  },

  /* ---------------- detalhes ---------------- */
  async vodInfo(src, streamId) {
    try {
      const d = await this.call(src, { action: 'get_vod_info', vod_id: streamId });
      const i = (d && d.info) || {};
      const m = (d && d.movie_data) || {};
      return {
        plot: i.plot || i.description || '',
        cast: i.cast || i.actors || '',
        director: i.director || '',
        genre: i.genre || '',
        rating: i.rating || '',
        year: i.releasedate ? String(i.releasedate).slice(0, 4) : (i.year || ''),
        duration: i.duration || i.episode_run_time || '',
        backdrop: (Array.isArray(i.backdrop_path) && i.backdrop_path[0]) || '',
        cover: i.movie_image || i.cover_big || '',
        ext: m.container_extension || 'mp4',
        country: i.country || '',
        trailer: i.youtube_trailer || ''
      };
    } catch (e) {
      console.warn('[xtream] vodInfo', e);
      return null;
    }
  },

  /** Episódios agrupados por temporada. */
  async seriesInfo(src, seriesId) {
    const d = await this.call(src, { action: 'get_series_info', series_id: seriesId });
    const info = (d && d.info) || {};
    const rawEps = (d && d.episodes) || {};
    const seasons = {};

    Object.keys(rawEps).forEach((sn) => {
      const list = Array.isArray(rawEps[sn]) ? rawEps[sn] : Object.values(rawEps[sn] || {});
      seasons[sn] = list.map((ep) => {
        const ei = ep.info || {};
        return {
          key: 'x' + src.id + 'e' + ep.id,
          id: ep.id,
          episode: parseInt(ep.episode_num, 10) || 0,
          season: parseInt(sn, 10) || 0,
          name: ep.title || `Episódio ${ep.episode_num}`,
          title: ep.title || `Episódio ${ep.episode_num}`,
          ext: ep.container_extension || 'mp4',
          url: this.seriesUrl(src, ep.id, ep.container_extension || 'mp4'),
          plot: ei.plot || ei.overview || '',
          duration: ei.duration || (ei.duration_secs ? Math.round(ei.duration_secs / 60) : ''),
          thumb: ei.movie_image || ei.cover_big || (Array.isArray(ei.backdrop_path) && ei.backdrop_path[0]) || '',
          rating: ei.rating || '',
          type: 'episode'
        };
      }).sort((a, b) => a.episode - b.episode);
    });

    return {
      info: {
        plot: info.plot || '',
        cast: info.cast || '',
        director: info.director || '',
        genre: info.genre || '',
        rating: info.rating || '',
        year: info.releaseDate ? String(info.releaseDate).slice(0, 4) : '',
        cover: info.cover || '',
        backdrop: (Array.isArray(info.backdrop_path) && info.backdrop_path[0]) || '',
        runtime: info.episode_run_time || ''
      },
      seasons
    };
  },

  /** EPG curto (agora / a seguir) de um canal. */
  async shortEpg(src, streamId, limit) {
    try {
      const d = await this.call(src, {
        action: 'get_short_epg',
        stream_id: streamId,
        limit: limit || 4
      });
      const list = (d && d.epg_listings) || [];
      return list.map((e) => ({
        title: this._b64(e.title),
        desc: this._b64(e.description),
        start: e.start ? new Date(e.start.replace(' ', 'T')) : null,
        end: e.end ? new Date(e.end.replace(' ', 'T')) : null
      }));
    } catch {
      return [];
    }
  },

  _b64(s) {
    if (!s) return '';
    try { return decodeURIComponent(escape(atob(s))); }
    catch { return String(s); }
  }
};
