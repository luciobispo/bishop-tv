/* ==================================================================
   app.js — inicialização e ligação dos eventos
   ================================================================== */
'use strict';

const App = {
  async init() {
    await Store.load();
    this.reportStoreStatus();
    await window.bishop.setUserAgent(Store.get('userAgent'));
    if (window.bishop.onDnsFallback) {
      window.bishop.onDnsFallback(() => {
        Store.set('dnsFallback', true);  // o main liga o DoH direto nas próximas aberturas
        U.toast('O DNS da sua rede não encontrou o servidor — usando o DNS do Google/Cloudflare.', 'ok');
      });
    }

    Player.init();
    this.bindChrome();
    this.bindNav();
    this.bindCards();
    this.bindDetail();
    this.bindSources();
    this.bindSettings();
    this.bindSearch();
    this.bindHide();
    this.bindGuide();

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
      // `stale`: a URL foi editada e o cache em disco ainda é do endereço antigo.
      await Lib.load(src, { force: force || src.stale, onProgress: (m) => U.loaderSub(m) });
      delete src.stale;
      Store.data.activeSource = src.id;
      Store.save();
      EPG.init(src);  // em segundo plano: o guia nunca segura a abertura da lista
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

  /**
   * Tira a abertura quando o app está pronto, mas nunca antes de a animação
   * terminar — com cache a lista carrega em milissegundos e ela mal apareceria.
   */
  hideSplash() {
    const el = $('#splash');
    if (!el) return;
    const MIN_MS = 1900;
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 600);
    }, Math.max(0, MIN_MS - performance.now()));
  },

  /** Avisa quando a configuração precisou ser recuperada de um backup ao abrir. */
  async reportStoreStatus() {
    if (!window.bishop.store.status) return;
    const st = await window.bishop.store.status().catch(() => null);
    if (!st) return;
    if (st.state === 'recovered') {
      U.toast(`${st.missing ? 'O arquivo de configuração tinha sumido' : 'O arquivo de configuração estava danificado'}; ` +
        `as listas foram recuperadas de ${st.from} (${st.sources} ${st.sources === 1 ? 'lista' : 'listas'}).`, 'ok', 9000);
    } else if (st.state === 'failed') {
      U.toast('O arquivo de configuração estava danificado e não havia backup para recuperar. Ele foi guardado em ' +
        'Configurações › Backups; se tiver um backup exportado, use “Importar”.', 'warn', 12000);
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

    document.addEventListener('keydown', (e) => {
      if (Player.open) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.openSearch();
      }
      if (e.key === 'Escape') {
        if (!$('#ctxMenu').classList.contains('hidden')) this.closeItemMenu();
        else if (!$('#guide').classList.contains('hidden')) UI.closeGuide();
        else if (!$('#detail').classList.contains('hidden')) UI.closeDetail();
        else if (UI.view === 'search') UI.nav('home');
      }
      if (e.key === 'F11') { e.preventDefault(); window.bishop.window.toggleFullscreen(); }
    });
  },

  bindNav() {
    U.on($('#rail'), 'click', '[data-nav]', (_e, el) => {
      if (el.dataset.nav === 'search') this.openSearch();
      else UI.nav(el.dataset.nav);
    });

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
      U.favToast(Store.toggleFav({ ...item, key: el.dataset.fav }));
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
      const sort = $(r.sort);
      sort.innerHTML = Lib.SORTS[type].map(([v, label]) => `<option value="${v}">${U.esc(label)}</option>`).join('');
      sort.value = UI.sortOf(type);
      sort.addEventListener('change', () => UI.setSort(type, sort.value));
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
      U.favToast(Store.toggleFav({ ...it, key: it.seriesKey || it.key }));
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
    UI.nav('search');
    // Na TV o foco vai para o teclado da tela; o da TV só abre se o usuário
    // escolher o campo (ver tvnav.js).
    if (document.documentElement.classList.contains('is-android')) TvNav.focus($('#oskKeys .osk-key'));
    else $('#searchInput').focus();
  },

  bindSearch() {
    const input = $('#searchInput');
    const run = U.debounce((v) => UI.doSearch(v), 260);
    input.addEventListener('input', () => run(input.value));
    U.on($('#searchTabs'), 'click', '.chip', (_e, el) => {
      $$('#searchTabs .chip').forEach((c) => c.classList.toggle('active', c === el));
      UI.state.searchType = el.dataset.stype;
      UI.doSearch(UI.state.searchQuery);
    });

    // Teclado da tela: A–Z e 0–9 em seis colunas, como nos apps de IPTV para
    // TV — com o controle, andar por ele é mais rápido que pelo teclado da TV.
    $('#oskKeys').innerHTML = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')
      .map((ch) => `<button class="osk-key" data-osk="${ch.toLowerCase()}">${ch}</button>`).join('');
    U.on($('#osk'), 'click', '.osk-key', (_e, el) => {
      const k = el.dataset.osk, v = input.value;
      if (k === 'back') input.value = v.slice(0, -1);
      else if (k === 'clear') input.value = '';
      else if (k === 'space') { if (v && !v.endsWith(' ')) input.value = v + ' '; }
      else input.value = v + k;
      run(input.value);
    });

    // Buscas recentes: o termo entra na lista quando um resultado é aberto.
    U.on($('#searchRecentList'), 'click', '.chip', (_e, el) => {
      UI.doSearch(el.dataset.q);
      if (document.documentElement.classList.contains('is-android')) TvNav.focus($('#searchGrid .card'));
    });
    $('#searchRecentClear').onclick = () => {
      Store.clearSearches();
      UI.renderRecentSearches(UI.state.searchQuery || '');
      if (document.documentElement.classList.contains('is-android')) TvNav.focus($('#oskKeys .osk-key'));
    };
    $('#searchGrid').addEventListener('click', (e) => {
      if (e.target.closest('.card')) Store.pushSearch(UI.state.searchQuery);
    }, true);
  },

  /* ================================================================
   * Ocultar canais, filmes, séries e categorias
   * Menu: botão direito no PC; na TV, segurar OK ou o botão ☰ (tvnav.js).
   * ================================================================ */
  bindHide() {
    U.on($('#app'), 'contextmenu', '.card, .cat-item', (e, el) => {
      e.preventDefault();
      this.openItemMenu(el);
    });
    $('#ctxMenu').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn && e.target !== e.currentTarget) return;
      const act = btn && this._ctxActs[btn.dataset.act];
      this.closeItemMenu();
      if (act) act();
    });
  },

  openItemMenu(el) {
    const acts = [];
    let title;
    if (el.classList.contains('cat-item')) {
      const name = el.dataset.cat;
      const type = ['live', 'movie', 'series'].find((t) => $(UI.catalogRefs(t).cats).contains(el));
      if (!type || name.startsWith('__')) return;
      title = name;
      acts.push(['Ocultar categoria', () => this.hide(() => Store.hideGroup(type, name), `Categoria “${name}” oculta`)]);
    } else {
      const item = Lib.get(el.dataset.key);
      if (!item) return;
      // Episódio solto (.m3u) ou série: oculta a série inteira.
      const target = (item.seriesKey && Lib.seriesByKey.get(item.seriesKey)) || item;
      const noun = { live: 'canal', movie: 'filme', series: 'série' }[target.type] || 'item';
      const group = target.group || 'Diversos';
      title = target.title || target.name;
      if (target.type === 'live') {
        acts.push([target.archive ? 'Programação e replay' : 'Programação', () => UI.openGuide(target)]);
      }
      if (window.bishop.externalPlayer && target.url && (target.type === 'live' || target.type === 'movie')) {
        acts.push(['Abrir no player externo (VLC/mpv)', () => this.openInExternal(target)]);
      }
      acts.push([`Ocultar ${noun}`, () => this.hide(() => Store.hideItem(target), `“${title}” oculto`)]);
      if (target.type in { live: 1, movie: 1, series: 1 }) {
        acts.push([`Ocultar categoria “${group}”`, () => this.hide(() => Store.hideGroup(target.type, group), `Categoria “${group}” oculta`)]);
      }
    }
    this._ctxActs = acts.map((a) => a[1]);
    $('#ctxTitle').textContent = title;
    $('#ctxActions').innerHTML = acts.map(([label], i) =>
      `<button class="btn ${i ? 'btn-ghost' : 'btn-play'}" data-act="${i}">${U.esc(label)}</button>`).join('') +
      '<button class="btn btn-ghost" data-act="-1">Cancelar</button>';
    $('#ctxMenu').classList.remove('hidden');
  },

  closeItemMenu() {
    $('#ctxMenu').classList.add('hidden');
  },

  /** Filmes Xtream: a URL definitiva (extensão real) vem do get_vod_info. */
  async openInExternal(item) {
    const src = Store.activeSourceObj();
    if (item.type === 'movie' && item.xtream && src && !item._info) {
      const info = await Xtream.vodInfo(src, item.streamId);
      if (info && info.ext) item.url = Xtream.vodUrl(src, item.streamId, info.ext);
      item._info = info || {};
    }
    Player.openExternal(item);
  },

  /* ================================================================
   * Guia de programação (EPG) e replay
   * ================================================================ */
  bindGuide() {
    $('#guideClose').onclick = () => UI.closeGuide();
    $('#guide').addEventListener('mousedown', (e) => { if (e.target.id === 'guide') UI.closeGuide(); });
    U.on($('#guideList'), 'click', '.guide-row', (_e, el) => UI.guidePick(Number(el.dataset.gi)));

    EPG.onUpdate(() => {
      if (UI.view === 'settings') UI.renderEpgStatus();
      if (EPG.ready() && UI.view === 'live') UI.fillEpg($$('#liveGrid .card'));
      if (EPG.ready() && Player.open && Player.isLive) Player.refreshEpg();
    });
  },

  hide(apply, msg) {
    apply();
    Lib.applyHidden();
    UI.refreshView();
    U.toast(`${msg}. Para mostrar de novo: Configurações › Conteúdo oculto.`, 'ok', 5500);
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
      const src = { type: 'file', name: res.name.replace(/\.[^.]+$/, ''), path: res.path };
      // Android: o arquivo vem sem caminho no disco, só o conteúdo.
      if (!res.path && res.data) src.content = res.data;
      await this.addAndLoad(src);
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
          tz: (info.server_info && info.server_info.timezone) || '',
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

    // --- editar lista por URL ---
    U.on($('#sourceList'), 'click', '[data-edit]', (_e, el) => {
      UI.editingSource = el.dataset.edit;
      UI.renderSources();
      const input = $('#sourceList [data-edit-url]');
      if (input) { input.focus(); input.select(); }
    });
    U.on($('#sourceList'), 'click', '[data-cancel-edit]', () => {
      UI.editingSource = null;
      UI.renderSources();
    });
    U.on($('#sourceList'), 'click', '[data-save]', (_e, el) => this.saveSourceEdit(el.dataset.save));
    U.on($('#sourceList'), 'click', '[data-copy-url]', async (_e, el) => {
      // Copia o que está no campo, inclusive uma edição ainda não salva.
      const url = el.closest('.field-inline').querySelector('[data-edit-url]').value.trim();
      if (!url) return;
      const ok = await U.copyText(url);
      U.toast(ok ? 'URL copiada' : 'Não foi possível copiar a URL', ok ? 'ok' : 'warn');
    });
    U.on($('#sourceList'), 'keydown', '.src-edit input', (e) => {
      if (e.key === 'Enter') this.saveSourceEdit(UI.editingSource);
      if (e.key === 'Escape') { e.stopPropagation(); UI.editingSource = null; UI.renderSources(); }
    });

    U.on($('#sourceList'), 'click', '[data-del]', (_e, el) => {
      const src = Store.getSource(el.dataset.del);
      if (!src) return;
      if (!confirm(`Remover a lista “${src.name}”?`)) return;
      const wasActive = Store.data.activeSource === src.id;
      Store.removeSource(src.id);
      EPG.forget(src.id);
      UI.renderSources();
      U.toast('Lista removida');
      if (wasActive) {
        const next = Store.activeSourceObj();
        if (next) this.loadSource(next).catch(() => {});
        else {
          Lib.reset();
          this.showOnboarding();
        }
      }
    });
  },

  async refreshEpg() {
    const src = Store.activeSourceObj();
    if (!src) return;
    const res = await EPG.refresh(src);
    if (res.ok) U.toast('Guia de programação atualizado', 'ok');
    else U.toast('Guia: ' + res.error, 'warn', 6000);
  },

  /**
   * Salva nome e URL de uma lista. Se a URL mudou na lista em uso, recarrega
   * na hora e, se o novo endereço não funcionar, volta ao anterior — melhor
   * do que deixar salva uma URL quebrada. Nas outras listas, a recarga fica
   * para quando forem usadas.
   */
  async saveSourceEdit(id) {
    const src = Store.getSource(id);
    const row = $(`#sourceList .source-item[data-src="${id}"]`);
    if (!src || !row) return;

    const url = U.cleanUrl(row.querySelector('[data-edit-url]').value);
    const name = row.querySelector('[data-edit-name]').value.trim() || src.name;
    if (!/^https?:\/\//i.test(url)) return U.toast('Informe uma URL começando com http:// ou https://', 'warn');

    const prev = { name: src.name, url: src.url };
    const urlChanged = url !== src.url;
    src.name = name;
    src.url = url;
    UI.editingSource = null;

    if (!urlChanged) {
      Store.save();
      UI.renderSources();
      return U.toast('Lista atualizada', 'ok');
    }

    if (Store.data.activeSource !== src.id) {
      src.stale = true;  // o cache ainda é da URL antiga
      Store.save();
      UI.renderSources();
      return U.toast('URL salva. A lista será baixada do novo endereço quando você usá-la.', 'ok');
    }

    try {
      await this.loadSource(src, true);
      Store.save();
      UI.nav('sources');
      U.toast('URL atualizada e lista recarregada', 'ok');
    } catch (err) {
      Object.assign(src, prev);
      Store.save();
      UI.editingSource = src.id;  // reabre a edição para corrigir
      UI.renderSources();
      const input = $('#sourceList [data-edit-url]');
      if (input) input.value = url;
      U.toast('A nova URL não funcionou, a anterior foi mantida: ' + (err.message || err), 'warn');
    }
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
    $('#setRefresh').addEventListener('change', (e) => Store.set('refreshHours', Number(e.target.value)));
    $('#setAudioLang').addEventListener('change', (e) => Store.set('audioLang', e.target.value));
    $('#setSubLang').addEventListener('change', (e) => Store.set('subLang', e.target.value));

    // --- guia de programação ---
    $('#setEpg').addEventListener('change', (e) => {
      Store.set('epg', e.target.checked);
      const src = Store.activeSourceObj();
      if (src) EPG.init(src);
      UI.renderEpgStatus();
    });
    $('#setEpgUrl').addEventListener('change', async (e) => {
      const src = Store.activeSourceObj();
      if (!src) return;
      const url = U.cleanUrl(e.target.value);
      if (url && !/^https?:\/\//i.test(url)) return U.toast('Informe um endereço começando com http:// ou https://', 'warn');
      src.epgUrl = url;
      Store.save();
      await EPG.init(src);
      if (Store.get('epg') && EPG.urlFor(src)) this.refreshEpg();
    });
    $('#epgRefreshBtn').onclick = () => this.refreshEpg();

    // --- player externo (só no PC) ---
    if (window.bishop.externalPlayer) {
      $('#setExtPlayer').addEventListener('change', async (e) => {
        Store.set('externalPlayer', e.target.value.trim().replace(/^"|"$/g, ''));
        // O main lê o caminho do arquivo de configuração: grava já.
        await Store.saveNow();
        UI.renderExtPlayerInfo();
      });
    } else {
      $$('.desktop-only').forEach((el) => el.classList.add('hidden'));
    }

    // --- backup das listas e configurações (só no PC) ---
    if (window.bishop.store.exportFile) {
      $('#exportStoreBtn').onclick = async () => {
        await Store.saveNow();
        const res = await window.bishop.store.exportFile();
        if (res.ok) U.toast(`Backup salvo em ${res.path}`, 'ok', 7000);
        else if (!res.canceled) U.toast('Não foi possível exportar: ' + res.error, 'warn');
      };
      $('#importStoreBtn').onclick = async () => {
        await Store.saveNow();
        // Até recarregar, nenhum salvamento da memória pode cobrir o backup importado.
        Store.freeze();
        const res = await window.bishop.store.importFile();
        if (!res.ok) {
          Store.unfreeze();
          if (!res.canceled) U.toast(res.error, 'warn', 7000);
          return;
        }
        U.toast(`Backup importado: ${res.sources} ${res.sources === 1 ? 'lista' : 'listas'}. Reabrindo…`, 'ok');
        setTimeout(() => location.reload(), 900);
      };
      $('#openBackupsBtn').onclick = () => window.bishop.store.openBackups();
    }

    $('#clearCacheBtn').onclick = async () => {
      const src = Store.activeSourceObj();
      if (src) await EPG.forget(src.id).then(() => EPG.init(src));
      await window.bishop.cache.clear();
      U.toast('Cache limpo. Use “Atualizar” em Fontes para recarregar.', 'ok');
    };

    const unhide = (fn) => {
      fn();
      Lib.applyHidden();
      UI.renderHidden();
      if (document.documentElement.classList.contains('is-android')) TvNav.focus($('#hiddenList [data-unhide]') || $('#clearHistoryBtn'));
    };
    U.on($('#hiddenList'), 'click', '[data-unhide]', (_e, el) => unhide(() => Store.unhide(el.dataset.unhide)));
    $('#unhideAllBtn').onclick = () => unhide(() => Store.unhideAll());

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
  }).finally(() => App.hideSplash());
});
