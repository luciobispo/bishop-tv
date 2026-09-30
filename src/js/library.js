/* ==================================================================
   library.js — catálogo em memória: índice, categorias, busca, fileiras
   ================================================================== */
'use strict';

const Lib = {
  source: null,
  all: [],          // itens brutos
  live: [],
  movies: [],
  series: [],       // agregados (1 objeto por série)
  cats: { live: [], movie: [], series: [] },
  byKey: new Map(),
  seriesByKey: new Map(),
  loadedAt: 0,

  get isEmpty() { return this.all.length === 0; },

  /* ------------------------------------------------------------------
   * Carregamento de uma fonte (com cache em disco)
   * ------------------------------------------------------------------ */
  cacheKey(src) {
    return 'src-' + src.id;
  },

  async load(src, { force = false, onProgress } = {}) {
    const report = (m) => { if (onProgress) onProgress(m); };
    this.source = src;

    if (!force) {
      const cached = await window.bishop.cache.read(this.cacheKey(src));
      if (cached && cached.ok && cached.data && Array.isArray(cached.data.items) && cached.data.items.length) {
        const age = Date.now() - (cached.data.at || 0);
        report('Lendo cache…');
        await this.index(cached.data.items, onProgress);
        this.loadedAt = cached.data.at || Date.now();
        // Atualiza em segundo plano se o cache tiver mais de 12h.
        if (age > 12 * 3600 * 1000) this._refreshLater(src);
        return { fromCache: true };
      }
    }

    const items = await this.fetchSource(src, report);
    if (!items.length) throw new Error('A lista foi carregada, mas não contém nenhum canal válido.');

    await this.index(items, onProgress);
    this.loadedAt = Date.now();
    await window.bishop.cache.write(this.cacheKey(src), { at: this.loadedAt, items });

    src.lastSync = this.loadedAt;
    src.count = items.length;
    Store.save();
    return { fromCache: false };
  },

  _refreshLater(src) {
    setTimeout(async () => {
      try {
        const items = await this.fetchSource(src, () => {});
        if (items.length) {
          await window.bishop.cache.write(this.cacheKey(src), { at: Date.now(), items });
        }
      } catch (e) { console.warn('[lib] refresh', e); }
    }, 8000);
  },

  /** Busca os itens de uma fonte, seja qual for o tipo. */
  async fetchSource(src, report) {
    if (src.type === 'xtream') {
      report('Conectando ao servidor…');
      await Xtream.login(src);
      return Xtream.loadAll(src, report);
    }

    let text = '';
    if (src.type === 'url') {
      report('Baixando lista…');
      if (window.bishop.stream) return this._streamM3U(src, report);
      const res = await window.bishop.get(src.url, { timeout: 120000 });
      if (!res.ok) throw new Error(res.error || 'Não foi possível baixar a lista');
      text = res.data;
    } else if (src.type === 'file') {
      if (src.content) {
        text = src.content;
      } else {
        report('Lendo arquivo…');
        const res = await window.bishop.readFile(src.path);
        if (!res.ok) throw new Error(res.error || 'Não foi possível ler o arquivo');
        text = res.data;
      }
    }

    if (!this.looksLikeM3U(text)) {
      throw new Error('O conteúdo não parece ser uma lista M3U válida.');
    }

    report('Interpretando a lista…');
    const { items, playlistAttrs } = M3U.parse(text);
    this._keepTvgUrl(src, playlistAttrs);
    return items;
  },

  /** Endereço do guia declarado no cabeçalho da M3U (pode vir mais de um, separados por vírgula). */
  _keepTvgUrl(src, attrs) {
    const raw = (attrs && (attrs['url-tvg'] || attrs['x-tvg-url'])) || '';
    const url = raw.split(',').map((s) => s.trim()).find((s) => /^https?:\/\//i.test(s)) || '';
    if (url) src.tvgUrl = url; else delete src.tvgUrl;
  },

  looksLikeM3U(text) {
    return /#EXTM3U|#EXTINF|^https?:/im.test(text || '');
  },

  /** Android: interpreta a lista enquanto ela é lida, sem montar o texto inteiro. */
  async _streamM3U(src, report) {
    const parser = M3U.parser();
    let head = '';
    let reading = false;
    const res = await window.bishop.stream(src.url, {
      timeout: 120000,
      onChunk: (chunk) => {
        if (!reading) { reading = true; report('Interpretando a lista…'); }
        if (head.length < 4096) head += chunk.slice(0, 4096);
        parser.push(chunk);
      }
    });
    if (!res.ok) throw new Error(res.error || 'Não foi possível baixar a lista');
    if (!this.looksLikeM3U(head)) {
      throw new Error('O conteúdo não parece ser uma lista M3U válida.');
    }
    const { items, playlistAttrs } = parser.end();
    this._keepTvgUrl(src, playlistAttrs);
    return items;
  },

  /* ------------------------------------------------------------------
   * Indexação
   * ------------------------------------------------------------------ */
  async index(items, onProgress) {
    if (onProgress) onProgress('Organizando o catálogo…');

    this.all = items;
    this.live = [];
    this.movies = [];
    this.byKey = new Map();
    this.seriesByKey = new Map();

    const seriesAgg = new Map();

    await U.chunked(items, 4000, (it) => {
      it._n = U.norm(it.title || it.name);
      this.byKey.set(it.key, it);

      if (it.type === 'live') {
        this.live.push(it);
      } else if (it.type === 'movie') {
        this.movies.push(it);
      } else if (it.type === 'series') {
        if (it.seriesId != null) {
          // Xtream: cada item já é a série inteira.
          it.episodes = null;
          seriesAgg.set(it.seriesKey, it);
        } else {
          // M3U: agregamos os episódios soltos.
          let agg = seriesAgg.get(it.seriesKey);
          if (!agg) {
            agg = {
              key: it.seriesKey,
              seriesKey: it.seriesKey,
              type: 'series',
              name: it.seriesName,
              title: it.seriesName,
              seriesName: it.seriesName,
              logo: '',
              group: it.group,
              year: it.year || '',
              _n: U.norm(it.seriesName),
              episodes: []
            };
            seriesAgg.set(it.seriesKey, agg);
          }
          agg.episodes.push(it);
        }
      }
    });

    // Painéis costumam gravar num bloco de episódios recém-adicionados a
    // imagem de uma única série; como a lista vem com os mais novos primeiro,
    // essa imagem virava a capa de dezenas de séries. Conta em quantas séries
    // cada imagem aparece para descartar as que não pertencem a nenhuma.
    const SHARED_MAX = 3; // versões dublada/legendada/remasterizada da mesma série
    const logoUse = new Map();
    for (const s of seriesAgg.values()) {
      if (!s.episodes) continue;
      for (const logo of new Set(s.episodes.map((ep) => ep.logo))) {
        if (logo) logoUse.set(logo, (logoUse.get(logo) || 0) + 1);
      }
    }
    const usable = (logo) => !!logo && logoUse.get(logo) <= SHARED_MAX;

    // Ordena episódios e monta as temporadas
    this.series = Array.from(seriesAgg.values());
    for (const s of this.series) {
      this.seriesByKey.set(s.seriesKey, s);
      if (!s.episodes) continue;
      s.episodes.sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
      // Capa: a primeira imagem exclusiva da série, a partir do T1E1 (os
      // episódios mais antigos são os que costumam ter a imagem certa).
      const cover = s.episodes.find((ep) => ep.logo && logoUse.get(ep.logo) === 1)
        || s.episodes.find((ep) => usable(ep.logo));
      s.logo = cover ? cover.logo : '';
      s.seasons = {};
      for (const ep of s.episodes) {
        const sn = String(ep.season || 1);
        (s.seasons[sn] = s.seasons[sn] || []).push({
          key: ep.key,
          id: ep.key,
          season: ep.season || 1,
          episode: ep.episode || 0,
          name: ep.epTitle || `Episódio ${ep.episode || ''}`.trim(),
          title: ep.epTitle || `Episódio ${ep.episode || ''}`.trim(),
          url: ep.url,
          thumb: usable(ep.logo) ? ep.logo : '',
          plot: '',
          duration: '',
          type: 'episode'
        });
      }
      s.epCount = s.episodes.length;
    }

    this.cats = {
      live: this._cats(this.live),
      movie: this._cats(this.movies),
      series: this._cats(this.series)
    };

    if (onProgress) {
      onProgress(`${this.live.length} canais · ${this.movies.length} filmes · ${this.series.length} séries`);
    }
  },

  _cats(list) {
    const m = new Map();
    for (const it of list) {
      const g = it.group || 'Diversos';
      m.set(g, (m.get(g) || 0) + 1);
    }
    return Array.from(m.entries())
      .map(([name, count]) => ({ name, count, id: U.hash(name) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'pt-BR'));
  },

  listOf(type) {
    if (type === 'live') return this.live;
    if (type === 'movie') return this.movies;
    if (type === 'series') return this.series;
    return this.all;
  },

  byCategory(type, catName) {
    const list = this.listOf(type);
    if (!catName || catName === '__all__') return list;
    if (catName === '__fav__') {
      const favs = Store.data.favorites;
      return list.filter((i) => favs[i.key]);
    }
    return list.filter((i) => (i.group || 'Diversos') === catName);
  },

  get(key) {
    return this.byKey.get(key) || this.seriesByKey.get(key) || null;
  },

  /* ------------------------------------------------------------------
   * Busca
   * ------------------------------------------------------------------ */
  search(query, type, limit) {
    const q = U.norm(query);
    if (!q) return [];
    const terms = q.split(' ').filter(Boolean);
    const max = limit || 300;

    const pools = type && type !== 'all'
      ? [this.listOf(type)]
      : [this.series, this.movies, this.live];

    const hits = [];
    for (const pool of pools) {
      for (let i = 0; i < pool.length; i++) {
        const it = pool[i];
        const n = it._n || (it._n = U.norm(it.title || it.name));
        let ok = true;
        for (const t of terms) { if (!n.includes(t)) { ok = false; break; } }
        if (!ok) continue;
        // Pontuação: começo do nome > palavra inteira > substring
        let score = 0;
        if (n.startsWith(q)) score = 3;
        else if (n.includes(' ' + q)) score = 2;
        else score = 1;
        if (it.type === 'series') score += 0.4;
        else if (it.type === 'movie') score += 0.2;
        hits.push({ it, score });
        if (hits.length > max * 4) break;
      }
    }

    hits.sort((a, b) => b.score - a.score || (a.it.title || '').localeCompare(b.it.title || '', 'pt-BR'));
    return hits.slice(0, max).map((h) => h.it);
  },

  /* ------------------------------------------------------------------
   * Fileiras da home
   * ------------------------------------------------------------------ */
  homeRows() {
    const rows = [];

    const top = this.topRanked(10);
    if (top) rows.push({ id: 'top', title: top.title, items: top.items, shape: 'rank' });

    // Continuar assistindo
    const cont = Store.continueList()
      .map((p) => {
        const live = this.get(p.key);
        return { ...p, ...(live || {}), _progress: p };
      })
      .filter((x) => x.url || x.key);
    if (cont.length) {
      rows.push({ id: 'continue', title: 'Continuar assistindo', items: cont, shape: 'wide' });
    }

    // Minha lista
    const favs = Store.favList()
      .map((f) => this.get(f.key) || f)
      .slice(0, 24);
    if (favs.length) {
      rows.push({ id: 'fav', title: 'Minha Lista', items: favs, shape: 'poster', nav: 'mylist' });
    }

    // Adicionados recentemente (Xtream traz timestamp)
    const recentAdds = this.movies
      .filter((m) => m.added)
      .sort((a, b) => b.added - a.added)
      .slice(0, 22);
    if (recentAdds.length >= 6) {
      rows.push({ id: 'new', title: 'Novidades em Filmes', items: recentAdds, shape: 'poster', nav: 'movies' });
    }

    // Séries em destaque
    if (this.series.length) {
      rows.push({
        id: 'series-top',
        title: 'Séries para maratonar',
        items: this._pick(this.series, 22),
        shape: 'poster',
        nav: 'series'
      });
    }

    // Canais assistidos recentemente
    const recent = (Store.data.recent || [])
      .filter((r) => r.type === 'live')
      .map((r) => this.get(r.key) || r)
      .slice(0, 20);
    if (recent.length >= 3) {
      rows.push({ id: 'recent-live', title: 'Canais recentes', items: recent, shape: 'logo', nav: 'live' });
    }

    // Maiores categorias de filmes
    for (const c of this.cats.movie.slice(0, 5)) {
      const items = this._pick(this.movies.filter((m) => m.group === c.name), 22);
      if (items.length >= 6) {
        rows.push({ id: 'mv-' + c.id, title: c.name, items, shape: 'poster', nav: 'movies', cat: c.name });
      }
    }

    // Maiores categorias de séries
    for (const c of this.cats.series.slice(0, 3)) {
      const items = this._pick(this.series.filter((m) => m.group === c.name), 22);
      if (items.length >= 6) {
        rows.push({ id: 'sr-' + c.id, title: c.name, items, shape: 'poster', nav: 'series', cat: c.name });
      }
    }

    // Maiores categorias de TV
    for (const c of this.cats.live.slice(0, 5)) {
      const items = this.live.filter((m) => m.group === c.name).slice(0, 22);
      if (items.length >= 4) {
        rows.push({ id: 'lv-' + c.id, title: c.name, items, shape: 'logo', nav: 'live', cat: c.name });
      }
    }

    return rows;
  },

  // Amostra estável (sem embaralhar a cada render) priorizando itens com capa.
  _pick(list, n) {
    const withArt = [];
    const without = [];
    for (const it of list) {
      (it.logo ? withArt : without).push(it);
      if (withArt.length >= n) break;
    }
    return withArt.length >= n ? withArt.slice(0, n) : withArt.concat(without).slice(0, n);
  },

  /** Nota numérica (painéis mandam "7.4", "7,4" ou vazio); 0 = sem nota. */
  rating(item) {
    return parseFloat(String((item && item.rating) || '').replace(',', '.')) || 0;
  },

  /**
   * Top 10 da home: os mais bem avaliados entre os filmes e séries que
   * chegaram por último. Só o Xtream informa data e nota; numa .m3u vale a
   * ordem da própria lista, que os painéis gravam com os mais novos primeiro.
   * A janela cresce até juntar itens suficientes.
   */
  topRanked(n) {
    const adult = /xxx|\+ ?18|adult/i;
    const eligible = this.movies.concat(this.series).filter((i) => i.logo && !adult.test(i.group || ''));
    const pool = eligible.filter((i) => i.added);
    if (pool.length < n) {
      const newest = this.movies.filter((i) => i.logo && !adult.test(i.group || '')).slice(0, n);
      return newest.length >= n ? { title: 'Top 10 · Novidades', items: newest } : null;
    }
    const best = (list) => list.slice().sort((a, b) => this.rating(b) - this.rating(a)).slice(0, n);
    const DAY = 864e5, now = Date.now();
    for (const [days, title] of [[7, 'Top Semanal'], [30, 'Top do Mês']]) {
      const recent = pool.filter((i) => now - i.added <= days * DAY);
      if (recent.length >= n) return { title, items: best(recent) };
    }
    const newest = pool.slice().sort((a, b) => b.added - a.added).slice(0, 60);
    return { title: 'Top 10 · Novidades', items: best(newest) };
  },

  /** Item para o banner da home. */
  heroItem() {
    const pool = this.series.filter((s) => s.logo && (s.plot || s.backdrop));
    const pool2 = this.movies.filter((m) => m.logo);
    const candidates = pool.length ? pool : (pool2.length ? pool2 : this.live.filter((l) => l.logo));
    if (!candidates.length) return null;
    // Muda a cada dia, mas fica estável durante a sessão.
    const seed = Math.floor(Date.now() / 36e5);
    return candidates[seed % candidates.length];
  }
};
