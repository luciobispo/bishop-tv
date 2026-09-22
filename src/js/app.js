/* ==================================================================
   app.js — inicialização e ligação dos eventos
   ================================================================== */
'use strict';

const App = {
  async init() {
    await Store.load();
    await window.bishop.setUserAgent(Store.get('userAgent'));

    Player.init();
    this.bindChrome();
    this.bindNav();
    this.bindCards();
    this.bindDetail();
    this.bindSources();
    this.bindSettings();
    this.bindSearch();

    const active = Store.activeSourceObj();
    if (!active) {
      this.showOnboarding();
      return;
    }

    try {
      await this.loadSource(active);
    } catch (err) {
      U.loader(false);
      U.toast('Falha ao carregar a lista: ' + (err.message || err), 'warn');
      UI.nav('sources');
    }
  },

  /* ================================================================
   * Carregamento de fonte
   * ================================================================ */
  async loadSource(src, force) {
    U.loader(true, `Carregando “${src.name}”`, 'Preparando…');
    try {
      await Lib.load(src, { force, onProgress: (m) => U.loaderSub(m) });
      Store.data.activeSource = src.id;
      Store.save();
      U.loader(false);
      this.hideOnboarding();
      UI.state.live.cat = '__all__';
      UI.state.movie.cat = '__all__';
      UI.state.series.cat = '__all__';
      UI.nav('home');
      U.toast(
        `${Lib.live.length.toLocaleString('pt-BR')} canais · ` +
        `${Lib.movies.length.toLocaleString('pt-BR')} filmes · ` +
        `${Lib.series.length.toLocaleString('pt-BR')} séries`, 'ok');
    } catch (err) {
      U.loader(false);
      throw err;
    }
  },

  showOnboarding() { $('#onboarding').classList.remove('hidden'); },
  hideOnboarding() { $('#onboarding').classList.add('hidden'); },

  /* ================================================================
   * Janela e barra superior
   * ================================================================ */
  bindChrome() {
    $('#wcMin').onclick = () => window.bishop.window.minimize();
    $('#wcMax').onclick = () => window.bishop.window.maximize();
    $('#wcClose').onclick = () => window.bishop.window.close();

    $('#app').addEventListener('scroll', U.throttle(() => {
      const solid = $('#app').scrollTop > 40 || UI.view !== 'home';
      $('#topbar').classList.toggle('solid', solid);
    }, 100));

    document.addEventListener('keydown', (e) => {
      if (Player.open) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.openSearch();
      }
      if (e.key === 'Escape') {
        if (!$('#detail').classList.contains('hidden')) UI.closeDetail();
        else if ($('#searchbox').classList.contains('open')) this.closeSearch();
      }
      if (e.key === 'F11') { e.preventDefault(); window.bishop.window.toggleFullscreen(); }
    });
  },

  bindNav() {
    U.on($('#topbar'), 'click', '[data-nav]', (_e, el) => UI.nav(el.dataset.nav));
    $('#sourcesBtn').onclick = () => UI.nav('sources');
    $('#settingsBtn').onclick = () => UI.nav('settings');

    // Hero
    $('#heroPlay').onclick = () => { if (UI.heroRef) UI.playItem(UI.heroRef); };
    $('#heroInfo').onclick = () => { if (UI.heroRef) UI.openDetail(UI.heroRef); };

    // Onboarding
    U.on($('#onboarding'), 'click', '[data-onb]', (_e, el) => {
      this.hideOnboarding();
      UI.nav('sources');
      this.selectSourceTab(el.dataset.onb);
    });
  },

  /* ================================================================
   * Cards, fileiras e categorias
   * ================================================================ */
  bindCards() {
    const appRoot = $('#app');

    // Clique no card
    U.on(appRoot, 'click', '.card', (e, el) => {
      if (e.target.closest('.card-fav')) return;
      const item = Lib.get(el.dataset.key);
      if (!item) {
        // Item salvo cujo catálogo mudou (favorito/progresso órfão)
        const fallback = Store.data.favorites[el.dataset.key] || Store.data.progress[el.dataset.key] ||
          Store.data.history[el.dataset.key];
        if (fallback && fallback.url) return UI.playItem({ ...fallback, key: el.dataset.key });
        return U.toast('Este item não está mais disponível nesta lista.', 'warn');
      }
      if (item.type === 'movie' || item.type === 'series') UI.openDetail(item);
      else UI.playItem(item);
    });

    // Favoritar
    U.on(appRoot, 'click', '.card-fav', (e, el) => {
      e.stopPropagation();
      const card = el.closest('.card');
      const item = Lib.get(card.dataset.key) || Store.data.favorites[el.dataset.fav];
      if (!item) return;
      Store.toggleFav({ ...item, key: el.dataset.fav });
      UI.refreshFavUI();
      if (UI.view === 'mylist') UI.renderMyList();
    });

    // Setas dos carrosséis
    U.on(appRoot, 'click', '.row-arrow', (_e, el) => {
      const track = el.parentElement.querySelector('.row-track');
      track.scrollBy({ left: el.dataset.dir * (track.clientWidth * 0.82), behavior: 'smooth' });
    });

    // "Ver tudo"
    U.on(appRoot, 'click', '.row-more', (e, el) => {
      e.stopPropagation();
      UI.nav(el.dataset.gonav, { cat: el.dataset.gocat || '__all__' });
    });

    // Categorias dos catálogos
    ['live', 'movie', 'series'].forEach((type) => {
      const r = UI.catalogRefs(type);
      U.on($(r.cats), 'click', '.cat-item', (_e, el) => {
        UI.state[type].cat = el.dataset.cat;
        UI.renderCatalog(type);
        $('#app').scrollTop = 0;
      });
      $(r.catFilter).addEventListener('input', U.debounce(() => UI.renderCategories(type), 200));
      $(r.filter).addEventListener('input', U.debounce((e) => {
        UI.state[type].filter = e.target.value;
        UI.renderCatalog(type);
      }, 240));
    });
  },

  /* ================================================================
   * Modal de detalhe
   * ================================================================ */
  bindDetail() {
    $('#detailClose').onclick = () => UI.closeDetail();
    $('#detail').addEventListener('mousedown', (e) => {
      if (e.target.id === 'detail') UI.closeDetail();
    });

    $('#detailPlay').onclick = () => {
      const it = UI.detailItem;
      if (!it) return;
      if (it.type === 'series') {
        const seasons = UI.detailSeasons || {};
        const nums = Object.keys(seasons).sort((a, b) => Number(a) - Number(b));
        if (!nums.length) return U.toast('Episódios ainda carregando…');
        const target = UI.resumeTarget(seasons);
        UI.playEpisode(target.ep.key, target.season);
      } else {
        UI.playItem(it);
      }
    };

    $('#detailFav').onclick = () => {
      const it = UI.detailItem;
      if (!it) return;
      Store.toggleFav({ ...it, key: it.seriesKey || it.key });
      UI.refreshFavUI();
    };

    $('#seasonSelect').onchange = (e) => UI.renderEpisodes(e.target.value);

    U.on($('#epList'), 'click', '.ep-item', (_e, el) => {
      UI.playEpisode(el.dataset.ep, el.dataset.season);
    });
  },

  /* ================================================================
   * Busca
   * ================================================================ */
  openSearch() {
    $('#searchbox').classList.add('open');
    $('#searchInput').focus();
  },

  closeSearch() {
    $('#searchbox').classList.remove('open');
    $('#searchInput').value = '';
    if (UI.view === 'search') UI.nav('home');
  },

  bindSearch() {
    $('#searchToggle').onclick = () => {
      if ($('#searchbox').classList.contains('open') && !$('#searchInput').value) this.closeSearch();
      else this.openSearch();
    };
    $('#searchInput').addEventListener('input', U.debounce((e) => UI.doSearch(e.target.value), 260));
    $('#searchInput').addEventListener('blur', () => {
      if (!$('#searchInput').value) $('#searchbox').classList.remove('open');
    });
    U.on($('#searchTabs'), 'click', '.chip', (_e, el) => {
      $$('#searchTabs .chip').forEach((c) => c.classList.toggle('active', c === el));
      UI.state.searchType = el.dataset.stype;
      UI.doSearch(UI.state.searchQuery);
    });
  },

  /* ================================================================
   * Fontes
   * ================================================================ */
  selectSourceTab(which) {
    $$('#srcTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.src === which));
    ['file', 'url', 'xtream'].forEach((k) => {
      $('#srcPanel-' + k).classList.toggle('hidden', k !== which);
    });
  },

  bindSources() {
    U.on($('#srcTabs'), 'click', '.tab', (_e, el) => this.selectSourceTab(el.dataset.src));

    // --- arquivo ---
    $('#pickFileBtn').onclick = async () => {
      const res = await window.bishop.pickM3U();
      if (res.canceled) return;
      if (!res.ok) return U.toast(res.error || 'Não foi possível abrir o arquivo', 'warn');
      await this.addAndLoad({
        type: 'file',
        name: res.name.replace(/\.[^.]+$/, ''),
        path: res.path
      });
    };

    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.add('drag');
    }));
    ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => {
      e.preventDefault(); dz.classList.remove('drag');
    }));
    dz.addEventListener('drop', (e) => this.handleDroppedFile(e, true));

    // A janela inteira aceita soltar um arquivo.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      if (e.target.closest('#dropzone')) return;
      this.handleDroppedFile(e, false);
    });

    // --- URL ---
    $('#addUrlBtn').onclick = async () => {
      const url = U.cleanUrl($('#urlValue').value);
      if (!/^https?:\/\//i.test(url)) return U.toast('Informe uma URL começando com http:// ou https://', 'warn');
      await this.addAndLoad({
        type: 'url',
        name: $('#urlName').value.trim() || 'Lista via URL',
        url
      });
      $('#urlValue').value = ''; $('#urlName').value = '';
    };

    // --- Xtream ---
    $('#addXtreamBtn').onclick = async () => {
      const host = U.normalizeHost($('#xtHost').value);
      const user = $('#xtUser').value.trim();
      const pass = $('#xtPass').value;
      if (!host || !user || !pass) return U.toast('Preencha servidor, usuário e senha', 'warn');

      U.loader(true, 'Conectando…', host);
      try {
        const info = await Xtream.login({ host, user, pass });
        U.loader(false);
        const exp = info.user_info.exp_date
          ? new Date(Number(info.user_info.exp_date) * 1000).toLocaleDateString('pt-BR')
          : null;
        U.toast(`Conectado${exp ? ' · expira em ' + exp : ''}`, 'ok');
        await this.addAndLoad({
          type: 'xtream',
          name: $('#xtName').value.trim() || (info.server_info && info.server_info.url) || 'Xtream',
          host, user, pass,
          expires: info.user_info.exp_date || null,
          maxConnections: info.user_info.max_connections || null
        });
        $('#xtPass').value = '';
      } catch (err) {
        U.loader(false);
        U.toast('Falha ao conectar: ' + (err.message || err), 'warn');
      }
    };

    // --- lista de fontes salvas ---
    U.on($('#sourceList'), 'click', '[data-use]', async (_e, el) => {
      const src = Store.getSource(el.dataset.use);
      if (src) {
        try { await this.loadSource(src); } catch (err) { U.toast(String(err.message || err), 'warn'); }
      }
    });

    U.on($('#sourceList'), 'click', '[data-sync]', async (_e, el) => {
      const src = Store.getSource(el.dataset.sync);
      if (!src) return;
      try {
        await this.loadSource(src, true);
        UI.nav('sources');
      } catch (err) { U.toast(String(err.message || err), 'warn'); }
    });

    U.on($('#sourceList'), 'click', '[data-del]', (_e, el) => {
      const src = Store.getSource(el.dataset.del);
      if (!src) return;
      if (!confirm(`Remover a lista “${src.name}”?`)) return;
      const wasActive = Store.data.activeSource === src.id;
      Store.removeSource(src.id);
      UI.renderSources();
      U.toast('Lista removida');
      if (wasActive) {
        const next = Store.activeSourceObj();
        if (next) this.loadSource(next).catch(() => {});
        else {
          Lib.all = []; Lib.live = []; Lib.movies = []; Lib.series = [];
          this.showOnboarding();
        }
      }
    });
  },

  /**
   * Guardamos o caminho do arquivo quando possível — assim a lista é relida
   * do disco a cada atualização, em vez de ficar inteira dentro do JSON de
   * configuração. O conteúdo só entra como fallback.
   */
  async handleDroppedFile(e, verbose) {
    e.preventDefault();
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    if (!/\.(m3u8?|txt)$/i.test(f.name)) {
      if (verbose) U.toast('Selecione um arquivo .m3u', 'warn');
      return;
    }
    const filePath = window.bishop.pathForFile(f);
    const src = { type: 'file', name: f.name.replace(/\.[^.]+$/, ''), path: filePath };
    if (!filePath) src.content = await f.text();
    await this.addAndLoad(src);
  },

  async addAndLoad(src) {
    const saved = Store.addSource(src);
    try {
      await this.loadSource(saved);
    } catch (err) {
      Store.removeSource(saved.id);
      UI.nav('sources');
      U.toast('Não foi possível carregar: ' + (err.message || err), 'warn');
    }
  },

  /* ================================================================
   * Configurações
   * ================================================================ */
  bindSettings() {
    $('#setUA').addEventListener('change', async (e) => {
      const ua = e.target.value.trim();
      Store.set('userAgent', ua);
      await window.bishop.setUserAgent(ua);
      U.toast('User-Agent atualizado', 'ok');
    });
    $('#setBuffer').addEventListener('change', (e) => Store.set('buffer', e.target.value));
    $('#setResume').addEventListener('change', (e) => Store.set('resume', e.target.checked));
    $('#setAwake').addEventListener('change', (e) => Store.set('keepAwake', e.target.checked));

    $('#clearCacheBtn').onclick = async () => {
      await window.bishop.cache.clear();
      U.toast('Cache limpo. Use “Atualizar” em Fontes para recarregar.', 'ok');
    };

    $('#clearHistoryBtn').onclick = () => {
      if (!confirm('Apagar todo o histórico e o "Continuar assistindo"?')) return;
      Store.clearHistory();
      U.toast('Histórico apagado', 'ok');
      if (UI.view === 'home') UI.renderHome();
    };
  }
};

window.addEventListener('DOMContentLoaded', () => {
  App.init().catch((err) => {
    console.error(err);
    U.loader(false);
    U.toast('Erro na inicialização: ' + (err.message || err), 'warn');
  });
});
