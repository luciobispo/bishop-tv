/* ==================================================================
   ui.js — renderização das telas
   ================================================================== */
'use strict';

const UI = {
  view: 'home',
  state: {
    live:   { cat: '__all__', filter: '' },
    movie:  { cat: '__all__', filter: '' },
    series: { cat: '__all__', filter: '' },
    searchType: 'all',
    searchQuery: ''
  },
  detailItem: null,
  detailSeasons: null,
  pagers: {},
  _imgIOs: new Map(),   // grade → observador que solta/recarrega as capas

  /* ================================================================
   * Navegação
   * ================================================================ */
  nav(view, opts = {}) {
    this.view = view;
    $$('.view').forEach((v) => v.classList.add('hidden'));
    const target = $('#view-' + view);
    if (target) target.classList.remove('hidden');

    $$('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.nav === view));
    $('#app').scrollTop = 0;
    this._releaseHidden(view);

    switch (view) {
      case 'home':     this.renderHome(); break;
      case 'live':     this.renderCatalog('live', opts.cat); break;
      case 'movies':   this.renderCatalog('movie', opts.cat); break;
      case 'series':   this.renderCatalog('series', opts.cat); break;
      case 'mylist':   this.renderMyList(); break;
      case 'search':   this.renderSearch(); break;
      case 'sources':  this.renderSources(); break;
      case 'settings': this.renderSettings(); break;
    }
  },

  /**
   * Telas escondidas ficam vazias — cada uma é redesenhada ao voltar (ver
   * nav). No Firestick, os cartões e capas de uma grade já rolada até o fim
   * continuariam ocupando a memória do WebView em segundo plano.
   */
  _releaseHidden(view) {
    const hosts = {
      home: '#homeRows', mylist: '#mylistRows', live: '#liveGrid',
      movies: '#movieGrid', series: '#seriesGrid', search: '#searchGrid'
    };
    for (const [v, sel] of Object.entries(hosts)) {
      const host = $(sel);
      if (v === view || !host || !host.firstChild) continue;
      const io = this._imgIOs.get(host);
      if (io) io.disconnect();
      host.innerHTML = '';
    }
    if (view !== 'home') $('#heroBg').style.backgroundImage = '';
  },

  /**
   * Android: com o ExoPlayer na frente, a interface solta as imagens que tem
   * na tela. O vídeo, o buffer e o decodificador precisam dessa memória — sem
   * ela o Android mata o app no meio do filme.
   */
  parkImages() {
    for (const img of $$('.card-img[src], .ep-thumb[src]')) {
      img.dataset.parked = img.getAttribute('src');
      img.removeAttribute('src');
    }
    for (const el of [$('#heroBg'), $('#detailBg')]) {
      const bg = el && el.style.backgroundImage;
      if (!bg || bg === 'none') continue;
      el.dataset.parked = bg;
      el.style.backgroundImage = 'none';
    }
  },

  unparkImages() {
    for (const el of $$('[data-parked]')) {
      if (el.tagName === 'IMG') el.setAttribute('src', el.dataset.parked);
      else el.style.backgroundImage = el.dataset.parked;
      delete el.dataset.parked;
    }
  },

  /* ================================================================
   * Cards
   * ================================================================ */
  shapeClass(shape) {
    return shape === 'poster' ? 'card-poster' : shape === 'logo' ? 'card-logo' : 'card-wide';
  },

  cardHTML(item, shape) {
    const title = U.esc(item.title || item.name || '');
    const favKey = item.seriesKey || item.key;
    const isFav = Store.isFav(favKey);

    let sub = '';
    if (item.type === 'live') sub = U.esc(item.group || '');
    else if (item.type === 'series') sub = item.epCount ? `${item.epCount} episódios` : (item.year || '');
    else sub = [item.year, item.rating ? '★ ' + Number(item.rating).toFixed(1) : ''].filter(Boolean).join(' · ');
    if (item._sub) sub = U.esc(item._sub);

    let badge = '';
    if (item.type === 'live') badge = '<span class="card-badge live"><span class="dot"></span>Ao vivo</span>';
    else if (item.type === 'series') badge = '<span class="card-badge">Série</span>';
    else if (Store.isWatched(item.key)) badge = '<span class="card-badge seen">✓ Assistido</span>';

    let progress = '';
    const p = Store.getProgress(item.key);
    if (p && p.dur) {
      progress = `<div class="card-progress"><i style="width:${Math.min(100, (p.pos / p.dur) * 100).toFixed(1)}%"></i></div>`;
    }

    // O fallback fica sempre no fundo; a capa é removida se não carregar.
    // Se a capa reduzida não existir, tenta uma vez a original (data-full).
    const thumb = item.logo ? U.img(item.logo, 'w342') : '';
    const full = thumb !== item.logo ? ` data-full="${U.esc(item.logo)}"` : '';
    const art = `<div class="card-fallback">${title}</div>` + (thumb
      // Sem src é uma capa solta de propósito (ver _trackImages), não um erro.
      ? `<img class="card-img" src="${U.esc(thumb)}"${full} loading="lazy" decoding="async" alt="" onload="UI.imgLoad(this)" onerror="UI.imgError(this)">`
      : '');

    return `
      <div class="card ${this.shapeClass(shape)}" data-key="${U.esc(item.key)}" data-type="${U.esc(item.type || '')}">
        ${badge}
        ${art}
        <button class="card-fav ${isFav ? 'on' : ''}" data-fav="${U.esc(favKey)}" title="Favoritos">
          <svg viewBox="0 0 24 24"><path d="${U.heartPath(isFav)}"/></svg>
        </button>
        ${progress}
        <div class="card-hover">
          <div class="card-name">${title}</div>
          ${sub ? `<div class="card-sub">${sub}</div>` : ''}
        </div>
      </div>`;
  },

  /**
   * Muitas listas não têm pôster de série/novela e usam a cena de um
   * episódio, sem o título escrito. Imagem deitada num cartão de pôster
   * deixa o nome sempre visível, não só com o foco.
   */
  imgLoad(img) {
    const card = img.parentNode;
    if (card && card.classList.contains('card-poster') && img.naturalWidth > img.naturalHeight) {
      card.classList.add('card-still');
    }
  },

  imgError(img) {
    if (!img.getAttribute('src')) return;
    const full = img.dataset.full;
    if (full) {
      delete img.dataset.full;
      img.setAttribute('src', full);
    } else {
      img.remove();
    }
  },

  /** Fundo de banner/detalhe: o backdrop em 1280 ou, sem ele, a capa em 780. */
  backdropUrl(item) {
    return item.backdrop ? U.img(item.backdrop, 'w1280') : U.img(item.logo, 'w780');
  },

  /* ================================================================
   * HOME
   * ================================================================ */
  renderHome() {
    if (Lib.isEmpty) return;

    // Banner
    const hero = Lib.heroItem();
    if (hero) {
      this.heroRef = hero;
      const bg = this.backdropUrl(hero);
      $('#heroBg').style.backgroundImage = bg ? `url("${bg}")` : 'linear-gradient(120deg,#2a1116,#12121a)';
      $('#heroTitle').textContent = hero.title || hero.name;
      const rating = Lib.rating(hero);
      const kind = { series: 'Série', movie: 'Filme', live: 'Ao vivo' }[hero.type] || '';
      $('#heroMeta').innerHTML = [
        rating ? `<span class="hero-rating"><svg viewBox="0 0 24 24"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>${
          rating.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>` : '',
        hero.year ? `<span>${U.esc(hero.year)}</span>` : '',
        kind ? `<span>${kind}</span>` : '',
        hero.epCount ? `<span>${hero.epCount} episódios</span>` : ''
      ].filter(Boolean).join('');
      $('#heroDesc').textContent = hero.plot || '';
    }

    const rows = Lib.homeRows();
    this.renderRows($('#homeRows'), rows);
  },

  renderRows(host, rows) {
    host.innerHTML = '';
    if (!rows.length) {
      host.innerHTML = '<div class="empty">Nada por aqui ainda. Adicione uma lista em <b>Fontes</b>.</div>';
      return;
    }
    const frag = document.createDocumentFragment();
    for (const row of rows) {
      const el = U.el('div', row.shape === 'rank' ? 'row row-rank' : 'row');
      el.dataset.row = row.id;
      // Top 10: número grande ao lado de cada capa.
      const cards = row.shape === 'rank'
        ? row.items.map((it, i) =>
            `<div class="rank-item"><span class="rank-num">${i + 1}</span>${this.cardHTML(it, 'poster')}</div>`).join('')
        : row.items.map((it) => this.cardHTML(it, row.shape)).join('');
      el.innerHTML = `
        <div class="row-head">
          <h2 class="row-title">${U.esc(row.title)}</h2>
          ${row.nav ? `<button class="row-more" data-gonav="${row.nav}" data-gocat="${U.esc(row.cat || '')}">Ver tudo ›</button>` : ''}
        </div>
        <div class="row-view">
          <button class="row-arrow left" data-dir="-1">‹</button>
          <div class="row-track">${cards}</div>
          <button class="row-arrow right" data-dir="1">›</button>
        </div>`;
      frag.appendChild(el);
    }
    host.appendChild(frag);
  },

  refreshContinue() {
    if (this.view === 'home') this.renderHome();
    if (this.view === 'mylist') this.renderMyList();
  },

  refreshFavUI() {
    $$('.card-fav').forEach((b) => U.setHeart(b, Store.isFav(b.dataset.fav)));
    if (this.detailItem) {
      U.setHeart($('#detailFav'), Store.isFav(this.detailItem.seriesKey || this.detailItem.key));
    }
  },

  /* ================================================================
   * MINHA LISTA
   * ================================================================ */
  renderMyList() {
    const favs = Store.favList().map((f) => Lib.get(f.key) || f);
    const cont = Store.continueList().map((p) => ({ ...(Lib.get(p.key) || {}), ...p, _progress: p }));
    const rows = [];
    if (cont.length) rows.push({ id: 'c', title: 'Continuar assistindo', items: cont, shape: 'wide' });

    const date = (at) => new Date(at).toLocaleDateString('pt-BR');
    Store.linkHistory((k) => Lib.get(k));
    const seenSeries = Store.watchedSeries().map((s) => {
      const h = s.last;
      const base = Lib.get(s.seriesKey) ||
        { key: s.seriesKey, type: 'series', name: h.seriesName, title: h.seriesName, logo: h.seriesLogo || h.logo };
      const ep = h.season != null && h.episode != null ? `T${h.season} E${h.episode}` : (h.name || 'episódio');
      return { ...base, _sub: `${h.done ? 'Viu' : 'Parou em'} ${ep} · ${date(h.at)}` };
    });
    if (seenSeries.length) rows.push({ id: 'hs', title: 'Séries que você assistiu', items: seenSeries, shape: 'poster' });

    const seenMovies = Store.watchedMovies().map((h) => ({
      ...(Lib.get(h.key) || h),
      _sub: (h.done ? 'Assistido em ' : 'Começou em ') + date(h.at)
    }));
    if (seenMovies.length) rows.push({ id: 'hm', title: 'Filmes que você assistiu', items: seenMovies, shape: 'poster' });
    if (favs.length) {
      const g = { live: [], movie: [], series: [] };
      favs.forEach((f) => (g[f.type] || g.movie).push(f));
      if (g.series.length) rows.push({ id: 'fs', title: 'Séries salvas', items: g.series, shape: 'poster' });
      if (g.movie.length)  rows.push({ id: 'fm', title: 'Filmes salvos',  items: g.movie,  shape: 'poster' });
      if (g.live.length)   rows.push({ id: 'fl', title: 'Canais favoritos', items: g.live, shape: 'logo' });
    }
    const host = $('#mylistRows');
    if (!rows.length) {
      host.innerHTML = '<div class="empty">Sua lista está vazia.<br><br>Passe o mouse sobre qualquer capa e clique no <b>+</b> para salvar aqui.</div>';
      return;
    }
    this.renderRows(host, rows);
  },

  /* ================================================================
   * CATÁLOGOS (TV / Filmes / Séries)
   * ================================================================ */
  catalogRefs(type) {
    if (type === 'live')   return { cats: '#liveCats', grid: '#liveGrid', title: '#liveTitle', count: '#liveCount', filter: '#liveFilter', catFilter: '#liveCatFilter', shape: 'logo', label: 'TV ao Vivo' };
    if (type === 'movie')  return { cats: '#movieCats', grid: '#movieGrid', title: '#movieTitle', count: '#movieCount', filter: '#movieFilter', catFilter: '#movieCatFilter', shape: 'poster', label: 'Filmes' };
    return { cats: '#seriesCats', grid: '#seriesGrid', title: '#seriesTitle', count: '#seriesCount', filter: '#seriesFilter', catFilter: '#seriesCatFilter', shape: 'poster', label: 'Séries' };
  },

  renderCatalog(type, forceCat) {
    const r = this.catalogRefs(type);
    const st = this.state[type];
    if (forceCat) st.cat = forceCat;

    this.renderCategories(type);

    const label = st.cat === '__all__' ? `Todos · ${r.label}`
      : st.cat === '__fav__' ? `Favoritos · ${r.label}` : st.cat;
    $(r.title).textContent = label;

    let items = Lib.byCategory(type, st.cat);
    const q = U.norm(st.filter);
    if (q) items = items.filter((i) => (i._n || U.norm(i.title || i.name)).includes(q));

    $(r.count).textContent = `${items.length.toLocaleString('pt-BR')} ${items.length === 1 ? 'item' : 'itens'}`;
    this.renderGrid($(r.grid), items, r.shape);
  },

  renderCategories(type) {
    const r = this.catalogRefs(type);
    const st = this.state[type];
    const host = $(r.cats);
    const q = U.norm($(r.catFilter) ? $(r.catFilter).value : '');
    const total = Lib.listOf(type).length;
    const favCount = Lib.listOf(type).filter((i) => Store.isFav(i.seriesKey || i.key)).length;

    let html = `<button class="cat-item ${st.cat === '__all__' ? 'active' : ''}" data-cat="__all__">
        <span class="label">Todos</span><span class="n">${total.toLocaleString('pt-BR')}</span></button>`;
    if (favCount) {
      html += `<button class="cat-item ${st.cat === '__fav__' ? 'active' : ''}" data-cat="__fav__">
        <span class="label">★ Favoritos</span><span class="n">${favCount}</span></button>`;
    }
    for (const c of Lib.cats[type]) {
      if (q && !U.norm(c.name).includes(q)) continue;
      html += `<button class="cat-item ${st.cat === c.name ? 'active' : ''}" data-cat="${U.esc(c.name)}">
        <span class="label">${U.esc(c.name)}</span><span class="n">${c.count.toLocaleString('pt-BR')}</span></button>`;
    }
    host.innerHTML = html;
  },

  /** Renderiza em blocos, carregando mais ao rolar. */
  renderGrid(host, items, shape) {
    const PAGE = 90;
    const io = this._imgIOs.get(host);
    if (io) io.disconnect();
    host.innerHTML = '';
    host.dataset.shown = '0';

    if (!items.length) {
      host.innerHTML = '<div class="empty" style="grid-column:1/-1">Nenhum item encontrado.</div>';
      return;
    }

    const append = () => {
      const shown = parseInt(host.dataset.shown, 10) || 0;
      if (shown >= items.length) return;
      const slice = items.slice(shown, shown + PAGE);
      const wrap = document.createElement('div');
      wrap.innerHTML = slice.map((it) => this.cardHTML(it, shape)).join('');
      const frag = document.createDocumentFragment();
      while (wrap.firstChild) frag.appendChild(wrap.firstChild);
      const imgs = frag.querySelectorAll('.card-img');
      const sentinel = host.querySelector('.grid-sentinel');
      if (sentinel) sentinel.remove();
      host.appendChild(frag);
      this._trackImages(host, imgs);
      host.dataset.shown = String(shown + slice.length);

      if (shown + slice.length < items.length) {
        const s = U.el('div', 'grid-sentinel');
        s.style.cssText = 'grid-column:1/-1;height:10px';
        host.appendChild(s);
        this._observe(s, append);
      }
    };

    append();
  },

  /**
   * Capas longe da tela soltam a imagem e a recarregam ao voltar. Rolando
   * um catálogo de milhares de itens, toda capa já vista continuaria na
   * memória do WebView — no Firestick, o que mais pesa até ele ser morto.
   * A grade escondida (outra tela aberta) também solta todas.
   */
  _trackImages(host, imgs) {
    let io = this._imgIOs.get(host);
    if (!io) {
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          const img = e.target;
          const src = img.getAttribute('src');
          if (e.isIntersecting) {
            if (!src && img.dataset.src) img.setAttribute('src', img.dataset.src);
          } else if (src) {
            img.dataset.src = src;
            img.removeAttribute('src');
          }
        }
      }, { root: $('#app'), rootMargin: '1500px 0px' });
      this._imgIOs.set(host, io);
    }
    imgs.forEach((img) => io.observe(img));
  },

  _observe(node, cb) {
    if (this._io) this._io.disconnect();
    this._io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        this._io.disconnect();
        cb();
      }
    }, { root: $('#app'), rootMargin: '600px' });
    this._io.observe(node);
  },

  /* ================================================================
   * BUSCA
   * ================================================================ */
  doSearch(q) {
    this.state.searchQuery = q;
    this.renderSearch();
  },

  renderSearch() {
    const q = this.state.searchQuery || '';
    const input = $('#searchInput');
    if (input.value !== q) input.value = q;
    const empty = $('#searchEmpty');
    const tabs = $('#searchTabs');
    const grid = $('#searchGrid');
    const show = (html) => {
      // Solta também as capas e a paginação da grade anterior.
      const io = this._imgIOs.get(grid);
      if (io) io.disconnect();
      if (this._io) this._io.disconnect();
      grid.innerHTML = '';
      grid.dataset.mode = '';
      empty.innerHTML = html;
      empty.classList.remove('hidden');
    };
    this.renderRecentSearches(q);

    // Sem termo: buscas populares no lugar dos resultados.
    if (q.trim().length < 2) {
      tabs.classList.add('hidden');
      // A 1ª letra digitada (ou apagar até ela) não refaz os cartões e capas.
      if (grid.dataset.mode === 'popular' && grid.firstChild) return;
      const top = Lib.topRanked(20);
      if (!top) {
        $('#searchTitle').textContent = 'Buscar';
        return show('Digite pelo menos duas letras para buscar.');
      }
      $('#searchTitle').textContent = `Populares · ${top.title}`;
      empty.classList.add('hidden');
      this.renderGrid(grid, top.items, 'poster');
      grid.dataset.mode = 'popular';
      return;
    }

    $('#searchTitle').textContent = `Resultados para “${q}”`;
    const { items, counts } = Lib.search(q, this.state.searchType, 400);
    tabs.classList.remove('hidden');
    for (const chip of $$('.chip', tabs)) {
      const n = counts[chip.dataset.stype] || 0;
      chip.querySelector('.chip-num').textContent = n ? ` ${n > 999 ? '999+' : n}` : '';
      chip.classList.toggle('chip-zero', !n);
    }

    if (!items.length) {
      const other = counts.all
        ? '<li>Há resultados em outra aba — veja os números acima.</li>'
        : '<li>Digite só o começo do nome, sem o ano ou a qualidade (HD, 4K).</li>' +
          '<li>Ou use as iniciais: “bbb” encontra “Big Brother Brasil”.</li>';
      return show(`<div class="empty-title">Nenhum resultado</div><ol class="empty-hints">${other}</ol>`);
    }
    empty.classList.add('hidden');
    this.renderGrid(grid, items, 'poster');
    grid.dataset.mode = '';
  },

  renderRecentSearches(q) {
    const list = Store.data.searches || [];
    const wrap = $('#searchRecent');
    wrap.classList.toggle('hidden', !list.length || q.trim().length >= 2);
    $('#searchRecentList').innerHTML = list
      .map((s) => `<button class="chip" data-q="${U.esc(s)}">${U.esc(s)}</button>`).join('');
  },

  /* ================================================================
   * DETALHE
   * ================================================================ */
  async openDetail(item) {
    if (!item) return;
    this.detailItem = item;
    this.detailSeasons = null;

    $('#detail').classList.remove('hidden');
    $('#detailTitle').textContent = item.title || item.name;
    $('#detailBg').style.backgroundImage = (item.backdrop || item.logo)
      ? `url("${this.backdropUrl(item)}")`
      : 'linear-gradient(120deg,#2a1116,#12121a)';
    U.setHeart($('#detailFav'), Store.isFav(item.seriesKey || item.key));
    $('#detailPlot').textContent = item.plot || '';
    $('#detailEpisodes').classList.add('hidden');
    $('#detailPlayLabel').textContent = item.type === 'series' ? 'Assistir T1 E1' : 'Assistir';

    const meta = [];
    if (item.year) meta.push(U.esc(item.year));
    if (item.rating) meta.push(`<span class="rating">★ ${Number(item.rating).toFixed(1)}</span>`);
    if (item.type === 'live') meta.push('<span class="tag">AO VIVO</span>');
    if (item.epCount) meta.push(`${item.epCount} episódios`);
    if (item.group) meta.push(`<span class="tag">${U.esc(item.group)}</span>`);
    $('#detailMeta').innerHTML = meta.join('');

    const facts = [];
    if (item.cast) facts.push(`<div><b>Elenco:</b> ${U.esc(item.cast)}</div>`);
    if (item.director) facts.push(`<div><b>Direção:</b> ${U.esc(item.director)}</div>`);
    if (item.genre) facts.push(`<div><b>Gêneros:</b> ${U.esc(item.genre)}</div>`);
    $('#detailFacts').innerHTML = facts.join('');

    // Carrega detalhes sob demanda
    const src = Store.activeSourceObj();

    if (item.type === 'movie' && item.xtream && src && !item._info) {
      const info = await Xtream.vodInfo(src, item.streamId);
      if (info && this.detailItem === item) {
        item._info = info;
        Object.assign(item, {
          plot: info.plot || item.plot, cast: info.cast, director: info.director,
          genre: info.genre, rating: info.rating || item.rating, year: info.year || item.year,
          backdrop: info.backdrop || item.backdrop
        });
        if (info.ext && item.streamId) item.url = Xtream.vodUrl(src, item.streamId, info.ext);
        return this.openDetail(item);
      }
    }

    if (item.type === 'series') {
      await this.loadSeasons(item);
    }
  },

  async loadSeasons(item) {
    const src = Store.activeSourceObj();
    let seasons = Lib.seasonsOf(item);

    if (!seasons && item.xtream && src) {
      $('#detailEpisodes').classList.remove('hidden');
      $('#epList').innerHTML = '<div class="empty">Carregando episódios…</div>';
      try {
        const data = await Xtream.seriesInfo(src, item.seriesId);
        if (this.detailItem !== item) return;
        seasons = data.seasons;
        item.seasons = seasons;
        item.plot = item.plot || data.info.plot;
        if (data.info.backdrop) $('#detailBg').style.backgroundImage = `url("${U.img(data.info.backdrop, 'w1280')}")`;
        if (data.info.plot) $('#detailPlot').textContent = data.info.plot;
        item.epCount = Object.values(seasons).reduce((n, a) => n + a.length, 0);
      } catch (e) {
        $('#epList').innerHTML = `<div class="empty">Não foi possível carregar os episódios.<br>${U.esc(String(e.message || e))}</div>`;
        return;
      }
    }

    if (!seasons || !Object.keys(seasons).length) {
      $('#detailEpisodes').classList.add('hidden');
      return;
    }

    this.detailSeasons = seasons;
    const nums = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));
    $('#seasonSelect').innerHTML = nums
      .map((n) => `<option value="${n}">Temporada ${n} (${seasons[n].length})</option>`).join('');
    $('#detailEpisodes').classList.remove('hidden');

    // Abre na temporada de onde o usuário parou.
    const target = this.resumeTarget(seasons);
    $('#seasonSelect').value = target.season;
    this.renderEpisodes(target.season);

    const ep = target.ep;
    const verb = target.resumed ? 'Continuar' : 'Assistir';
    $('#detailPlayLabel').textContent = `${verb} T${ep.season || target.season} E${ep.episode || 1}`;
  },

  /**
   * Episódio que o botão principal da série deve tocar: o último visto, ou o
   * seguinte se ele já foi concluído; sem histórico, o primeiro.
   */
  resumeTarget(seasons) {
    const nums = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));
    const flat = [];
    for (const n of nums) for (const ep of seasons[n]) flat.push({ ep, season: n });

    let last = -1, lastAt = 0;
    flat.forEach((x, i) => {
      const h = Store.getHistory(x.ep.key);
      const p = Store.getProgress(x.ep.key);
      const at = Math.max(h ? h.at : 0, p ? p.at : 0);
      if (at > lastAt) { lastAt = at; last = i; }
    });

    if (last === -1) return { ...flat[0], resumed: false };
    if (Store.isWatched(flat[last].ep.key) && flat[last + 1]) return { ...flat[last + 1], resumed: true };
    return { ...flat[last], resumed: true };
  },

  renderEpisodes(seasonNum) {
    const eps = (this.detailSeasons || {})[seasonNum] || [];
    $('#epList').innerHTML = eps.map((ep) => {
      const p = Store.getProgress(ep.key);
      const seen = Store.isWatched(ep.key);
      const pct = p && p.dur ? Math.min(100, (p.pos / p.dur) * 100) : seen ? 100 : 0;
      const bar = pct
        ? `<div style="height:3px;background:rgba(255,255,255,.2);border-radius:2px;margin-top:6px">
             <div style="height:100%;width:${pct.toFixed(0)}%;background:var(--accent);border-radius:2px"></div>
           </div>` : '';
      return `
        <div class="ep-item ${seen ? 'seen' : ''}" data-ep="${U.esc(String(ep.key))}" data-season="${U.esc(String(seasonNum))}">
          <div class="ep-num">${seen ? '✓' : (ep.episode || '')}</div>
          <div>${ep.thumb
            ? `<img class="ep-thumb" src="${U.esc(U.img(ep.thumb, 'w300'))}" loading="lazy" onerror="this.style.visibility='hidden'">`
            : '<div class="ep-thumb"></div>'}</div>
          <div style="min-width:0">
            <div class="ep-title">${U.esc(ep.title || ep.name)}${seen ? ' <span class="ep-seen">Assistido</span>' : ''}</div>
            ${ep.plot ? `<div class="ep-plot">${U.esc(ep.plot)}</div>` : ''}
            ${bar}
          </div>
          <div class="ep-dur">${U.esc(U.fmtDuration(ep.duration))}</div>
        </div>`;
    }).join('') || '<div class="empty">Nenhum episódio nesta temporada.</div>';
  },

  closeDetail() {
    $('#detail').classList.add('hidden');
    this.detailItem = null;
  },

  /* ================================================================
   * Reprodução a partir da interface
   * ================================================================ */
  playKey(key) {
    const item = Lib.get(key);
    if (!item) return;
    this.playItem(item);
  },

  async playItem(item) {
    if (!item) return;

    if (item.type === 'series') {
      // Abre o detalhe para escolher episódio; se já houver temporadas, toca a 1ª.
      this.openDetail(item);
      return;
    }

    if (item.type === 'live') {
      const list = Lib.byCategory('live', this.state.live.cat === '__all__' ? '__all__' : this.state.live.cat);
      const idx = Math.max(0, list.findIndex((i) => i.key === item.key));
      this.closeDetail();
      Player.play(item, { list: list.length ? list : Lib.live, index: idx });
      return;
    }

    // Filme: garante URL definitiva e retoma posição
    const src = Store.activeSourceObj();
    if (item.xtream && src && !item._info) {
      const info = await Xtream.vodInfo(src, item.streamId);
      if (info && info.ext) item.url = Xtream.vodUrl(src, item.streamId, info.ext);
      item._info = info || {};
    }
    const p = Store.getProgress(item.key);
    this.closeDetail();
    Player.play(item, { resumeAt: p ? p.pos : 0 });
  },

  playEpisode(epKey, seasonNum) {
    const seasons = this.detailSeasons || {};
    const eps = seasons[seasonNum] || [];
    const idx = eps.findIndex((e) => String(e.key) === String(epKey));
    if (idx === -1) return;
    const ep = eps[idx];
    const series = this.detailItem;

    const item = {
      ...ep,
      key: ep.key,
      type: 'episode',
      logo: ep.thumb || (series && series.logo) || '',
      seriesKey: series ? (series.seriesKey || series.key) : null,
      seriesName: series ? (series.title || series.name) : '',
      seriesRef: series,
      season: Number(seasonNum),
      title: (series ? (series.title || series.name) : '') || ep.title
    };

    const p = Store.getProgress(item.key);
    this.closeDetail();
    Player.play(item, {
      resumeAt: p ? p.pos : 0,
      subtitle: `T${seasonNum} E${ep.episode} · ${ep.title || ep.name}`,
      list: eps.map((e) => ({
        ...e, type: 'episode', season: Number(seasonNum),
        seriesKey: item.seriesKey, seriesName: item.seriesName, seriesRef: series,
        logo: e.thumb || (series && series.logo) || '', title: item.title
      })),
      index: idx
    });
  },

  /** Chamado ao terminar um episódio: toca o próximo automaticamente. */
  playNextEpisode(item) {
    if (!item || item.type !== 'episode') return false;
    const ctx = Player.context;
    if (!ctx || !ctx.list) return false;
    const next = ctx.list[ctx.index + 1];
    if (!next) return false;
    U.toast('Próximo episódio…');
    Player.play(next, {
      list: ctx.list,
      index: ctx.index + 1,
      subtitle: `T${next.season} E${next.episode} · ${next.title || next.name}`
    });
    return true;
  },

  /* ================================================================
   * FONTES
   * ================================================================ */
  renderSources() {
    const host = $('#sourceList');
    const srcs = Store.data.sources;
    if (!srcs.length) {
      host.innerHTML = '<div class="empty">Nenhuma lista cadastrada ainda.</div>';
      return;
    }
    const icons = {
      file: '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8zm-1 7V3.5L18.5 9z"/></svg>',
      url:  '<svg viewBox="0 0 24 24"><path d="M3.9 12a5 5 0 015-5h3v2h-3a3 3 0 100 6h3v2h-3a5 5 0 01-5-5zm5.1-1h6v2H9zm3-4h3a5 5 0 010 10h-3v-2h3a3 3 0 100-6h-3z"/></svg>',
      xtream: '<svg viewBox="0 0 24 24"><path d="M12 2a5 5 0 015 5v2h1a2 2 0 012 2v9a2 2 0 01-2 2H6a2 2 0 01-2-2v-9a2 2 0 012-2h1V7a5 5 0 015-5zm0 2a3 3 0 00-3 3v2h6V7a3 3 0 00-3-3z"/></svg>'
    };
    const tags = { file: 'Arquivo', url: 'URL', xtream: 'Xtream' };

    host.innerHTML = srcs.map((s) => {
      const active = s.id === Store.data.activeSource;
      if (s.id === this.editingSource) return this.sourceEditHTML(s, active, icons);
      const desc = s.type === 'xtream' ? `${U.esc(s.host)} · ${U.esc(s.user)}`
        : s.type === 'url' ? U.esc(s.url) : U.esc(s.path || 'arquivo local');
      const sync = s.lastSync ? new Date(s.lastSync).toLocaleString('pt-BR') : 'nunca';
      return `
        <div class="source-item ${active ? 'active' : ''}" data-src="${s.id}">
          <div class="src-ico">${icons[s.type] || icons.url}</div>
          <div class="src-info">
            <div class="src-name">${U.esc(s.name)} <span class="src-tag">${active ? 'Em uso' : tags[s.type]}</span></div>
            <div class="src-desc">${desc}</div>
            <div class="src-desc">${s.count ? s.count.toLocaleString('pt-BR') + ' itens · ' : ''}atualizado: ${sync}</div>
          </div>
          <div class="src-actions">
            ${active ? '' : `<button class="btn btn-ghost sm" data-use="${s.id}">Usar</button>`}
            ${s.type === 'url' ? `<button class="btn btn-ghost sm" data-edit="${s.id}">Editar</button>` : ''}
            <button class="btn btn-ghost sm" data-sync="${s.id}">Atualizar</button>
            <button class="btn btn-danger sm" data-del="${s.id}">Remover</button>
          </div>
        </div>`;
    }).join('');
  },

  /** Lista (id) sendo editada na tela de Fontes, ou null. */
  editingSource: null,

  sourceEditHTML(s, active, icons) {
    return `
      <div class="source-item editing ${active ? 'active' : ''}" data-src="${s.id}">
        <div class="src-ico">${icons.url}</div>
        <div class="src-edit">
          <label class="field">
            <span>Nome da lista</span>
            <input type="text" data-edit-name value="${U.esc(s.name)}">
          </label>
          <div class="field">
            <span>URL do .m3u</span>
            <div class="field-inline">
              <input type="text" data-edit-url value="${U.esc(s.url)}" spellcheck="false">
              <button class="btn btn-ghost sm" data-copy-url title="Copiar a URL">
                <svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 00-2 2v14h2V3h12zm3 4H8a2 2 0 00-2 2v14a2 2 0 002 2h11a2 2 0 002-2V7a2 2 0 00-2-2zm0 16H8V7h11z"/></svg>
                Copiar
              </button>
            </div>
          </div>
        </div>
        <div class="src-actions">
          <button class="btn btn-play sm" data-save="${s.id}">Salvar</button>
          <button class="btn btn-ghost sm" data-cancel-edit>Cancelar</button>
        </div>
      </div>`;
  },

  /* ================================================================
   * CONFIGURAÇÕES
   * ================================================================ */
  async renderSettings() {
    $('#setUA').value = Store.get('userAgent') || '';
    $('#setBuffer').value = Store.get('buffer') || 'normal';
    $('#setResume').checked = !!Store.get('resume');
    $('#setAwake').checked = !!Store.get('keepAwake');
    const info = await window.bishop.appInfo();
    $('#aboutInfo').innerHTML =
      `BishopTV v${U.esc(info.version)} · ${U.esc(info.platform || 'Electron ' + info.electron)} · Chromium ${U.esc(info.chrome)}<br>` +
      `Dados salvos em: ${U.esc(info.userData)}<br><br>` +
      `Este app apenas reproduz as listas que você fornece — ele não inclui, hospeda nem distribui nenhum conteúdo.`;
  }
};
