/* ==================================================================
   store.js — estado persistido (fontes, favoritos, progresso, ajustes)
   ================================================================== */
'use strict';

const Store = {
  data: {
    sources: [],        // [{id, type:'file'|'url'|'xtream', name, path?, url?, host?, user?, pass?, addedAt, lastSync}]
    activeSource: null,
    favorites: {},      // { [itemKey]: {key, name, logo, type, url, group, addedAt, ...} }
    progress: {},       // { [itemKey]: {pos, dur, at, name, logo, type, url, seriesKey?, ...} }
    recent: [],         // [itemKey] mais recentes primeiro
    // Filmes e episódios assistidos. Diferente de `progress`, não some quando o
    // item termina: é o que permite marcar "assistido" e retomar séries.
    history: {},        // { [itemKey]: {key, name, title, logo, type, url, seriesKey?, seriesName?, seriesLogo?, season?, episode?, pos, dur, at, done, sourceId} }
    settings: {
      userAgent: 'VLC/3.0.20 LibVLC/3.0.20',
      buffer: 'normal',
      resume: true,
      keepAwake: true,
      volume: 1,
      muted: false
    }
  },

  async load() {
    const saved = await window.bishop.store.read();
    if (saved && typeof saved === 'object') {
      this.data = {
        ...this.data,
        ...saved,
        settings: { ...this.data.settings, ...(saved.settings || {}) }
      };
    }
    this.data.sources = this.data.sources || [];
    this.data.favorites = this.data.favorites || {};
    this.data.progress = this.data.progress || {};
    this.data.recent = this.data.recent || [];
    if (!saved || !saved.history) this._seedHistory();
    return this.data;
  },

  /**
   * Versões anteriores não guardavam histórico: aproveita o que já existe em
   * "Continuar assistindo" e nos recentes para ele não começar vazio.
   */
  _seedHistory() {
    const h = this.data.history = {};
    for (const p of Object.values(this.data.progress)) {
      if (p.type === 'movie' || p.type === 'episode') h[p.key] = { ...p, done: false };
    }
    for (const r of this.data.recent) {
      if ((r.type === 'movie' || r.type === 'episode') && !h[r.key]) {
        h[r.key] = { ...r, pos: 0, dur: 0, done: false };
      }
    }
  },

  _timer: null,
  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => {
      window.bishop.store.write(JSON.parse(JSON.stringify(this.data)));
    }, 250);
  },

  saveNow() {
    clearTimeout(this._timer);
    return window.bishop.store.write(JSON.parse(JSON.stringify(this.data)));
  },

  /* ---------------- fontes ---------------- */
  addSource(src) {
    src.id = src.id || U.uid();
    src.addedAt = Date.now();
    this.data.sources.push(src);
    this.data.activeSource = src.id;
    this.save();
    return src;
  },

  removeSource(id) {
    this.data.sources = this.data.sources.filter((s) => s.id !== id);
    if (this.data.activeSource === id) {
      this.data.activeSource = this.data.sources.length ? this.data.sources[0].id : null;
    }
    this.save();
  },

  getSource(id) {
    return this.data.sources.find((s) => s.id === id) || null;
  },

  activeSourceObj() {
    return this.getSource(this.data.activeSource);
  },

  /* ---------------- favoritos ---------------- */
  isFav(key) {
    return !!this.data.favorites[key];
  },

  toggleFav(item) {
    const key = item.key;
    if (this.data.favorites[key]) {
      delete this.data.favorites[key];
      this.save();
      return false;
    }
    this.data.favorites[key] = {
      key,
      name: item.name,
      title: item.title || item.name,
      logo: item.logo || '',
      type: item.type,
      url: item.url || '',
      group: item.group || '',
      seriesId: item.seriesId || null,
      streamId: item.streamId || null,
      sourceId: this.data.activeSource,
      addedAt: Date.now()
    };
    this.save();
    return true;
  },

  favList() {
    return Object.values(this.data.favorites).sort((a, b) => b.addedAt - a.addedAt);
  },

  /* ---------------- progresso / continuar assistindo ---------------- */
  setProgress(item, pos, dur) {
    if (!item || !item.key) return;
    if (!isFinite(pos) || !isFinite(dur) || dur < 60) return;

    // Quase no fim: considera assistido.
    const done = pos / dur > 0.95;
    if (!done && pos < 30) return;

    // O histórico independe da opção de retomar.
    this.recordHistory(item, pos, dur, done);

    if (!this.data.settings.resume) {
      this.save();
      return;
    }
    if (done) {
      delete this.data.progress[item.key];
      this.save();
      return;
    }

    this.data.progress[item.key] = {
      key: item.key,
      pos, dur,
      at: Date.now(),
      name: item.name,
      title: item.title || item.name,
      logo: item.logo || '',
      type: item.type,
      url: item.url || '',
      group: item.group || '',
      seriesKey: item.seriesKey || null,
      seriesName: item.seriesName || '',
      season: item.season || null,
      episode: item.episode || null,
      sourceId: this.data.activeSource
    };
    this.save();
  },

  getProgress(key) {
    return this.data.progress[key] || null;
  },

  clearProgress(key) {
    delete this.data.progress[key];
    this.save();
  },

  continueList() {
    return Object.values(this.data.progress)
      .filter((p) => p.dur > 0 && p.pos / p.dur < 0.95)
      .sort((a, b) => b.at - a.at)
      .slice(0, 24);
  },

  /* ---------------- recentes (inclui canais ao vivo) ---------------- */
  pushRecent(item) {
    if (!item || !item.key) return;
    const entry = {
      key: item.key,
      name: item.name,
      title: item.title || item.name,
      logo: item.logo || '',
      type: item.type,
      url: item.url || '',
      group: item.group || '',
      at: Date.now(),
      sourceId: this.data.activeSource
    };
    this.data.recent = [entry, ...this.data.recent.filter((r) => r.key !== item.key)].slice(0, 30);
    this.save();
  },

  clearHistory() {
    this.data.progress = {};
    this.data.recent = [];
    this.data.history = {};
    this.save();
  },

  /* ---------------- histórico de filmes e séries ---------------- */
  HISTORY_MAX: 3000,

  recordHistory(item, pos, dur, done) {
    if (item.type !== 'movie' && item.type !== 'episode') return;
    const prev = this.data.history[item.key];
    this.data.history[item.key] = {
      key: item.key,
      name: item.name,
      title: item.title || item.name,
      logo: item.logo || '',
      type: item.type,
      url: item.url || '',
      group: item.group || '',
      seriesKey: item.seriesKey || null,
      seriesName: item.seriesName || '',
      seriesLogo: (item.seriesRef && item.seriesRef.logo) || (prev && prev.seriesLogo) || '',
      season: item.season || null,
      episode: item.episode || null,
      pos, dur,
      at: Date.now(),
      // Rever um item já terminado não o desmarca.
      done: done || !!(prev && prev.done),
      sourceId: this.data.activeSource
    };
    this._trimHistory();
  },

  _trimHistory() {
    const keys = Object.keys(this.data.history);
    if (keys.length <= this.HISTORY_MAX) return;
    keys
      .sort((a, b) => this.data.history[a].at - this.data.history[b].at)
      .slice(0, keys.length - this.HISTORY_MAX)
      .forEach((k) => delete this.data.history[k]);
  },

  /**
   * Entradas vindas dos "recentes" antigos não sabem a que série pertencem.
   * `lookup(key)` devolve o item do catálogo, que tem essa informação.
   */
  linkHistory(lookup) {
    let changed = false;
    for (const h of Object.values(this.data.history)) {
      if (h.type !== 'episode' || h.seriesKey) continue;
      const raw = lookup(h.key);
      if (!raw || !raw.seriesKey) continue;
      h.seriesKey = raw.seriesKey;
      h.seriesName = raw.seriesName || '';
      h.season = h.season || raw.season || null;
      h.episode = h.episode || raw.episode || null;
      changed = true;
    }
    if (changed) this.save();
  },

  getHistory(key) {
    return this.data.history[key] || null;
  },

  isWatched(key) {
    const h = this.data.history[key];
    return !!(h && h.done);
  },

  /** Filmes do histórico, mais recentes primeiro. */
  watchedMovies() {
    return Object.values(this.data.history)
      .filter((h) => h.type === 'movie')
      .sort((a, b) => b.at - a.at);
  },

  /** Uma entrada por série: o episódio visto por último e quantos foram concluídos. */
  watchedSeries() {
    const bySeries = new Map();
    for (const h of Object.values(this.data.history)) {
      if (h.type !== 'episode' || !h.seriesKey) continue;
      const s = bySeries.get(h.seriesKey) || { seriesKey: h.seriesKey, last: h, doneCount: 0 };
      if (h.at > s.last.at) s.last = h;
      if (h.done) s.doneCount++;
      bySeries.set(h.seriesKey, s);
    }
    return Array.from(bySeries.values()).sort((a, b) => b.last.at - a.last.at);
  },

  /* ---------------- ajustes ---------------- */
  set(key, value) {
    this.data.settings[key] = value;
    this.save();
  },

  get(key) {
    return this.data.settings[key];
  }
};
