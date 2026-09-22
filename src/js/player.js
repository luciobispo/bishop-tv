/* ==================================================================
   player.js — reprodução (HLS.js / mpegts.js / nativo) + controles
   ================================================================== */
'use strict';

const Player = {
  video: null,
  hls: null,
  mpegts: null,
  item: null,          // item atual (canal, filme ou episódio)
  context: null,       // { list:[], index:n } para zapping
  isLive: false,
  open: false,
  triedAlt: false,
  hideTimer: null,
  progressTimer: null,
  libsReady: { hls: false, mpegts: false },

  /* ------------------------------------------------------------------
   * Bootstrap
   * ------------------------------------------------------------------ */
  init() {
    this.video = $('#video');
    this.bindUI();
    this.bindKeys();

    const v = Store.get('volume');
    this.video.volume = (typeof v === 'number') ? v : 1;
    this.video.muted = !!Store.get('muted');
    $('#plVol').value = Math.round(this.video.volume * 100);
    this.syncMuteIcon();
  },

  /** Carrega hls.js / mpegts.js sob demanda (uma vez só). */
  _libPromises: {},
  loadLib(which) {
    if (this.libsReady[which]) return Promise.resolve(true);
    if (this._libPromises[which]) return this._libPromises[which];

    this._libPromises[which] = new Promise((resolve) => {
      const src = (window.bishop.libs || {})[which];
      if (!src) { resolve(false); return; }
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { this.libsReady[which] = true; resolve(true); };
      s.onerror = () => {
        console.error('[player] falha ao carregar', which, 'de', src);
        this._libPromises[which] = null;  // permite nova tentativa
        s.remove();
        resolve(false);
      };
      document.head.appendChild(s);
    });
    return this._libPromises[which];
  },

  LIB_MISSING: 'Não foi possível carregar o componente de reprodução ({lib}). ' +
    'Rode "npm install" na pasta do aplicativo e abra-o de novo.',

  /* ------------------------------------------------------------------
   * Abrir / trocar conteúdo
   * ------------------------------------------------------------------ */
  /**
   * @param item  objeto com {url, name/title, logo, type, key, …}
   * @param opts  { list, index, resumeAt, subtitle }
   */
  async play(item, opts = {}) {
    if (!item || !item.url) {
      U.toast('Este item não possui um link de reprodução.', 'warn');
      return;
    }

    this.item = item;
    this.context = opts.list ? { list: opts.list, index: opts.index || 0 } : null;
    this.isLive = item.type === 'live';
    this.triedAlt = false;

    $('#player').classList.remove('hidden');
    this.open = true;
    document.body.style.overflow = 'hidden';

    $('#plTitle').textContent = item.title || item.name || '';
    $('#plSub').textContent = opts.subtitle || this.subtitleFor(item);
    $('#plLiveBadge').classList.toggle('hidden', !this.isLive);
    $('#plSeek').classList.toggle('disabled', this.isLive);
    $('#plSep').classList.toggle('hidden', this.isLive);
    $('#plDur').classList.toggle('hidden', this.isLive);
    $$('.vod-only').forEach((b) => b.classList.toggle('hidden', this.isLive));
    $('#plZapBtn').classList.toggle('hidden', !this.isLive);
    this.syncFav();

    if (Store.get('keepAwake')) window.bishop.keepAwake(true);

    Store.pushRecent(item);
    await this.attach(item.url, opts.resumeAt);
    this.showUI();
    this.startProgressTimer();
  },

  subtitleFor(item) {
    if (item.type === 'live') return item.group || '';
    if (item.season != null && item.episode != null) {
      return `T${item.season} E${item.episode}` + (item.seriesName ? ' · ' + item.seriesName : '');
    }
    return [item.year, item.group].filter(Boolean).join(' · ');
  },

  /** Escolhe o motor e inicia o stream. */
  async attach(url, resumeAt) {
    this.teardown(false);
    this._ignoreErrors = false;
    this.showLoading(true, 'Conectando…');
    this.hideError();
    $('#plCur').textContent = '00:00';
    $('#plDur').textContent = '00:00';
    $('#plSeekPlayed').style.width = '0';
    $('#plSeekBuf').style.width = '0';
    $('#plSeekKnob').style.left = '0';
    $('#plQualityBtn').classList.add('hidden');
    $('#plAudioBtn').classList.add('hidden');

    const gen = ++this._gen;
    try {
      const kind = await this.detectKind(url);
      if (gen !== this._gen) return;  // o usuário já trocou de canal
      await this.playKind(kind, resumeAt);
    } catch (err) {
      this.showError(String(err && err.message ? err.message : err));
    }
  },

  /** Incrementado a cada attach, para descartar respostas atrasadas. */
  _gen: 0,

  async playKind(kind, resumeAt) {
    if (kind.error) throw new Error(kind.error);
    this._ignoreErrors = false;

    if (kind.type === 'hls') {
      await this.playHls(kind.url, resumeAt);
    } else if (kind.type === 'mpegts') {
      const ok = await this.playMpegts(kind.url, resumeAt);
      if (!ok) {
        if (!this.libsReady.mpegts) throw new Error(this.LIB_MISSING.replace('{lib}', 'mpegts.js'));
        await this.playNative(kind.url, resumeAt);
      }
    } else {
      await this.playNative(kind.url, resumeAt);
    }
  },

  /**
   * Decide o motor de reprodução. A extensão resolve a maioria dos casos;
   * quando ela não existe — comum em links de painel do tipo
   * ".../play/<token>/ts" — perguntamos ao servidor o que ele entrega.
   */
  async detectKind(url) {
    const ext = U.extOf(url);
    const tail = String(url).split('?')[0].split('/').pop().toLowerCase();

    if (ext === 'm3u8' || tail === 'm3u8') return { type: 'hls', url };
    if (ext === 'ts' || ext === 'mpegts' || ext === 'mpg' || ext === 'mpeg' || tail === 'ts') {
      return { type: 'mpegts', url };
    }
    if (['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'flv', 'ogv'].includes(ext)) {
      return { type: 'native', url };
    }

    // Sem pista no endereço: pergunta ao servidor.
    this.showLoading(true, 'Identificando o stream…');
    const p = await window.bishop.probe(url);

    return this.kindFromProbe(url, p);
  },

  kindFromProbe(url, p) {
    if (!p.ok) {
      return { error: `Não foi possível conectar ao servidor (${p.error}).` };
    }
    if (p.status >= 400) {
      return { error: `O servidor respondeu ${p.status} para este item.` };
    }

    const ct = p.contentType || '';
    const target = p.finalUrl || url;

    // Muitos painéis devolvem HTTP 200 com uma página HTML de erro.
    if (ct.includes('text/html') || p.sniff === 'html') {
      return { error: this.htmlError(p.snippet) };
    }

    // Os bytes reais valem mais que o content-type ou a extensão.
    if (p.sniff === 'hls') return { type: 'hls', url: target };
    if (p.sniff === 'ts' || p.sniff === 'flv') return { type: 'mpegts', url: target };
    if (p.sniff === 'mp4' || p.sniff === 'mkv') return { type: 'native', url: target };
    if (ct.includes('mpegurl') || ct.includes('mpeg-url') || /^\s*#EXTM3U/.test(p.snippet || '')) {
      return { type: 'hls', url: p.finalUrl || url };
    }
    if (ct.includes('mp2t') || ct.includes('mpeg-ts') || ct.includes('mpegts')) {
      return { type: 'mpegts', url: p.finalUrl || url };
    }

    // Após redirecionamento o arquivo final costuma revelar o formato.
    const finalExt = U.extOf(p.finalUrl || '');
    if (finalExt === 'm3u8') return { type: 'hls', url: p.finalUrl };
    if (finalExt === 'ts') return { type: 'mpegts', url: p.finalUrl };
    if (ct.startsWith('video/') || ct.startsWith('audio/')) {
      return { type: 'native', url: p.finalUrl || url };
    }

    // application/octet-stream e afins: MPEG-TS é a aposta mais provável.
    return { type: 'mpegts', url: p.finalUrl || url };
  },

  /**
   * Quando algo falha, pergunta ao servidor o que ele está devolvendo de fato.
   * É o que transforma um "formato não suportado" genérico numa explicação —
   * painéis costumam responder HTTP 200 com uma página de erro em HTML.
   */
  async diagnose(url, fallback) {
    try {
      const p = await window.bishop.probe(url);
      if (!p.ok) return `${fallback} Não foi possível contatar o servidor (${p.error}).`;
      if ((p.contentType || '').includes('text/html')) return this.htmlError(p.snippet);
      if (p.status >= 400) return `O servidor respondeu ${p.status} para este item.`;
    } catch {}
    return `${fallback} O canal pode estar fora do ar.`;
  },

  /** Extrai a mensagem útil de uma página de erro HTML do painel. */
  htmlError(html) {
    const txt = String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<[^>]+>/g, '\n');
    const lines = [...new Set(txt.split('\n').map((s) => s.trim()).filter((s) => s && s.length < 120))];

    const known = {
      INVALID_STREAM_ID: 'o canal não existe mais no servidor (link da lista desatualizado)',
      INVALID_USER: 'usuário ou senha recusados pelo servidor',
      EXPIRED_ACCOUNT: 'a assinatura está vencida',
      BANNED: 'esta conta foi bloqueada pelo provedor',
      DISABLED: 'esta conta está desativada',
      MAX_CONNECTIONS: 'o limite de conexões simultâneas foi atingido'
    };
    for (const code of Object.keys(known)) {
      if (txt.toUpperCase().includes(code)) {
        return `O servidor recusou o stream: ${known[code]}.` +
          (code === 'INVALID_STREAM_ID'
            ? ' Se você adicionou esta lista por URL .m3u, tente cadastrá-la de novo em Fontes usando Xtream Codes — costuma resolver.'
            : '');
      }
    }
    const msg = lines.slice(1, 4).join(' · ');
    return 'O servidor respondeu com uma página de erro em vez do vídeo' + (msg ? `: ${msg}` : '.');
  },

  async playHls(url, resumeAt) {
    const v = this.video;
    const ok = await this.loadLib('hls');

    if (ok && window.Hls && window.Hls.isSupported()) {
      const buf = Store.get('buffer');
      const cfg = {
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: this.isLive ? 30 : 90,
        maxBufferLength: buf === 'low' ? 12 : buf === 'high' ? 60 : 30,
        maxMaxBufferLength: buf === 'high' ? 120 : 60,
        manifestLoadingTimeOut: 20000,
        manifestLoadingMaxRetry: 3,
        levelLoadingMaxRetry: 4,
        fragLoadingTimeOut: 30000,
        fragLoadingMaxRetry: 6,
        liveSyncDurationCount: buf === 'low' ? 2 : 3
      };
      const hls = new window.Hls(cfg);
      this.hls = hls;

      hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
        this.buildQualityMenu();
        this.start(resumeAt);
      });
      hls.on(window.Hls.Events.LEVEL_SWITCHED, () => this.buildQualityMenu());
      hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, () => this.buildAudioMenu());
      hls.on(window.Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        switch (data.type) {
          case window.Hls.ErrorTypes.NETWORK_ERROR:
            if (data.details === 'manifestLoadError' || data.details === 'manifestParsingError') {
              this.diagnose(url, 'O servidor não respondeu com um stream válido.')
                .then((msg) => this.showError(msg));
            } else {
              hls.startLoad();
            }
            break;
          case window.Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            this.showError('Erro de reprodução: ' + (data.details || 'desconhecido'));
        }
      });

      hls.loadSource(url);
      hls.attachMedia(v);
      return;
    }

    // Suporte nativo a HLS (Safari); o Chromium não tem.
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = url;
      this.start(resumeAt);
      return;
    }
    throw new Error(this.LIB_MISSING.replace('{lib}', 'hls.js'));
  },

  async playMpegts(url, resumeAt) {
    const gen = this._gen;
    const ok = await this.loadLib('mpegts');
    if (!ok || !window.mpegts || !window.mpegts.isSupported()) return false;

    const buf = Store.get('buffer');
    const p = window.mpegts.createPlayer(
      { type: 'mpegts', isLive: this.isLive, url },
      {
        enableWorker: true,
        enableStashBuffer: buf !== 'low',
        stashInitialSize: buf === 'high' ? 1024 : 384,
        liveBufferLatencyChasing: this.isLive,
        liveBufferLatencyMaxLatency: buf === 'low' ? 3 : 6,
        liveBufferLatencyMinRemain: 0.5,
        lazyLoad: false,
        autoCleanupSourceBuffer: true
      }
    );
    this.mpegts = p;
    p.on(window.mpegts.Events.ERROR, (type, detail) => {
      // Encerrar fora do handler: o mpegts.js entra em loop de retry se
      // continuar vivo depois de um erro fatal.
      this._ignoreErrors = true;
      setTimeout(() => {
        try { p.pause(); p.unload(); p.detachMediaElement(); p.destroy(); } catch {}
        if (this.mpegts === p) this.mpegts = null;
      }, 0);
      const fallback = `Falha no stream (${detail || type}).`;
      if (detail === window.mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED) {
        this.switchEngine(url, resumeAt, gen, fallback);
      } else {
        this.diagnose(url, fallback).then((msg) => this.showError(msg));
      }
    });
    p.attachMediaElement(this.video);
    p.load();
    this.start();
    return true;
  },

  /**
   * O mpegts.js recebeu algo que não é MPEG-TS — tipicamente um ".ts" que o
   * painel redireciona para um MP4. Pergunta ao servidor o que ele entrega
   * de fato e troca de motor, em vez de mostrar "FormatUnsupported".
   */
  async switchEngine(url, resumeAt, gen, fallback) {
    const p = await window.bishop.probe(url);
    if (gen !== this._gen) return;
    const kind = this.kindFromProbe(url, p);
    if (kind.error) return this.showError(kind.error);
    if (kind.type === 'mpegts') return this.showError(`${fallback} O canal pode estar fora do ar.`);
    try {
      await this.playKind(kind, resumeAt);
    } catch (err) {
      this.showError(String(err && err.message ? err.message : err));
    }
  },

  async playNative(url, resumeAt) {
    this.video.src = url;
    this.start(resumeAt);
  },

  start(resumeAt) {
    const v = this.video;
    const go = () => {
      if (resumeAt && isFinite(resumeAt) && resumeAt > 5) {
        try { v.currentTime = resumeAt; } catch {}
      }
      const pr = v.play();
      if (pr && pr.catch) pr.catch((e) => console.warn('[player] autoplay', e));
    };
    if (v.readyState >= 1) go();
    else v.addEventListener('loadedmetadata', go, { once: true });
  },

  /**
   * @param reset  true só ao fechar o player. Um video.load() com src vazio
   *               dispara um evento 'error' espúrio; ao apenas trocar de
   *               stream, deixamos o novo src cuidar de abortar o anterior.
   */
  teardown(reset) {
    this.hideError();
    if (this.hls) { try { this.hls.destroy(); } catch {} this.hls = null; }
    if (this.mpegts) {
      try { this.mpegts.pause(); this.mpegts.unload(); this.mpegts.detachMediaElement(); this.mpegts.destroy(); } catch {}
      this.mpegts = null;
    }
    const v = this.video;
    try { v.pause(); } catch {}
    v.removeAttribute('src');
    if (reset) {
      this._ignoreErrors = true;
      try { v.load(); } catch {}
    }
    $('#plQualityMenu').classList.add('hidden');
    $('#plAudioMenu').classList.add('hidden');
  },

  close() {
    this.saveProgress();
    this.stopProgressTimer();
    this.teardown(true);
    $('#player').classList.add('hidden');
    $('#zap').classList.add('hidden');
    this.open = false;
    this.item = null;
    document.body.style.overflow = '';
    window.bishop.keepAwake(false);
    window.bishop.window.exitFullscreen();
    if (typeof UI !== 'undefined') UI.refreshContinue();
  },

  /* ------------------------------------------------------------------
   * Formato alternativo (m3u8 <-> ts) — muito útil em painéis Xtream
   * ------------------------------------------------------------------ */
  async tryAlternate() {
    const it = this.item;
    if (!it) return;
    const u = it.url;
    let alt = it.altUrl;
    if (!alt || alt === u) {
      if (/\.m3u8(\?|$)/i.test(u))      alt = u.replace(/\.m3u8(\?|$)/i, '.ts$1');
      else if (/\.ts(\?|$)/i.test(u))   alt = u.replace(/\.ts(\?|$)/i, '.m3u8$1');
      // Painéis que usam o formato como último segmento: ".../play/<token>/ts"
      else if (/\/ts(\?|$)/i.test(u))   alt = u.replace(/\/ts(\?|$)/i, '/m3u8$1');
      else if (/\/m3u8(\?|$)/i.test(u)) alt = u.replace(/\/m3u8(\?|$)/i, '/ts$1');
      else alt = u.replace(/\/+$/, '') + '.m3u8';
    }
    this.triedAlt = true;
    const swapped = { ...it, url: alt, altUrl: it.url };
    this.item = swapped;
    U.toast('Tentando formato alternativo…');
    await this.attach(alt);
  },

  /* ------------------------------------------------------------------
   * Zapping (próximo/anterior canal)
   * ------------------------------------------------------------------ */
  step(delta) {
    if (!this.context || !this.context.list || this.context.list.length < 2) return;
    const list = this.context.list;
    let i = (this.context.index + delta + list.length) % list.length;
    const next = list[i];
    this.play(next, { list, index: i });
  },

  openZap() {
    const zap = $('#zap');
    zap.classList.remove('hidden');
    this.renderZap('');
    $('#zapFilter').value = '';
    setTimeout(() => $('#zapFilter').focus(), 60);
  },

  renderZap(filter) {
    const list = (this.context && this.context.list) || Lib.live;
    const q = U.norm(filter);
    const host = $('#zapList');
    const frag = document.createDocumentFragment();
    let shown = 0;

    for (let i = 0; i < list.length && shown < 400; i++) {
      const it = list[i];
      if (q && !(it._n || U.norm(it.title || it.name)).includes(q)) continue;
      const b = U.el('button', 'zap-item' + (this.item && it.key === this.item.key ? ' active' : ''));
      b.dataset.idx = i;
      b.innerHTML =
        (it.logo ? `<img src="${U.esc(it.logo)}" loading="lazy" onerror="this.style.visibility='hidden'">`
                 : `<span style="width:44px"></span>`) +
        `<span style="min-width:0"><span class="zi-name">${U.esc(it.title || it.name)}</span>` +
        `<div class="zi-grp">${U.esc(it.group || '')}</div></span>`;
      frag.appendChild(b);
      shown++;
    }
    host.innerHTML = '';
    host.appendChild(frag);
    const active = host.querySelector('.zap-item.active');
    if (active) active.scrollIntoView({ block: 'center' });
  },

  /* ------------------------------------------------------------------
   * Progresso
   * ------------------------------------------------------------------ */
  startProgressTimer() {
    this.stopProgressTimer();
    this.progressTimer = setInterval(() => this.saveProgress(), 8000);
  },

  stopProgressTimer() {
    clearInterval(this.progressTimer);
    this.progressTimer = null;
  },

  saveProgress() {
    if (!this.item || this.isLive) return;
    const v = this.video;
    if (!v.duration || !isFinite(v.duration)) return;
    Store.setProgress(this.item, v.currentTime, v.duration);
  },

  /* ------------------------------------------------------------------
   * Menus de qualidade e áudio
   * ------------------------------------------------------------------ */
  buildQualityMenu() {
    const menu = $('#plQualityMenu');
    const btn = $('#plQualityBtn');
    if (!this.hls || !this.hls.levels || this.hls.levels.length < 2) {
      btn.classList.add('hidden');
      menu.innerHTML = '';
      return;
    }
    btn.classList.remove('hidden');
    const cur = this.hls.currentLevel;
    let html = '<div class="mh">Qualidade</div>';
    html += `<button data-lvl="-1" class="${cur === -1 ? 'sel' : ''}">Automática</button>`;
    this.hls.levels.forEach((l, i) => {
      const label = l.height ? `${l.height}p` : `${Math.round((l.bitrate || 0) / 1000)} kbps`;
      html += `<button data-lvl="${i}" class="${cur === i ? 'sel' : ''}">${label}</button>`;
    });
    menu.innerHTML = html;
  },

  buildAudioMenu() {
    const menu = $('#plAudioMenu');
    const btn = $('#plAudioBtn');
    let html = '';

    const tracks = this.hls ? (this.hls.audioTracks || []) : [];
    if (tracks.length > 1) {
      html += '<div class="mh">Áudio</div>';
      tracks.forEach((t, i) => {
        const nm = t.name || t.lang || `Faixa ${i + 1}`;
        html += `<button data-atrack="${i}" class="${this.hls.audioTrack === i ? 'sel' : ''}">${U.esc(nm)}</button>`;
      });
    } else if (this.video.audioTracks && this.video.audioTracks.length > 1) {
      html += '<div class="mh">Áudio</div>';
      for (let i = 0; i < this.video.audioTracks.length; i++) {
        const t = this.video.audioTracks[i];
        html += `<button data-ntrack="${i}" class="${t.enabled ? 'sel' : ''}">${U.esc(t.label || t.language || 'Faixa ' + (i + 1))}</button>`;
      }
    }

    const texts = this.video.textTracks || [];
    if (texts.length) {
      html += '<div class="mh">Legendas</div>';
      html += `<button data-sub="-1" class="${![].some.call(texts, (t) => t.mode === 'showing') ? 'sel' : ''}">Desligadas</button>`;
      for (let i = 0; i < texts.length; i++) {
        html += `<button data-sub="${i}" class="${texts[i].mode === 'showing' ? 'sel' : ''}">${U.esc(texts[i].label || texts[i].language || 'Legenda ' + (i + 1))}</button>`;
      }
    }

    if (!html) {
      btn.classList.add('hidden');
      menu.innerHTML = '';
    } else {
      btn.classList.remove('hidden');
      menu.innerHTML = html;
    }
  },

  /* ------------------------------------------------------------------
   * Estado visual
   * ------------------------------------------------------------------ */
  showLoading(on, text) {
    $('#plLoading').classList.toggle('hidden', !on);
    if (text) $('#plLoadingText').textContent = text;
  },

  showError(msg) {
    this.showLoading(false);
    $('#plErrorMsg').textContent = msg;
    $('#plError').classList.remove('hidden');
    $('#plAltFormat').classList.toggle('hidden', this.triedAlt);
    this.showUI();
  },

  hideError() {
    $('#plError').classList.add('hidden');
  },

  showUI() {
    $('#plUI').classList.remove('hide');
    $('#player').classList.remove('cursor-none');
    clearTimeout(this.hideTimer);
    if (!this.video.paused) {
      this.hideTimer = setTimeout(() => {
        if (this.video.paused) return;
        if ($('#zap').classList.contains('hidden') === false) return;
        if (!$('#plError').classList.contains('hidden')) return;
        $('#plUI').classList.add('hide');
        $('#player').classList.add('cursor-none');
        $('#plQualityMenu').classList.add('hidden');
        $('#plAudioMenu').classList.add('hidden');
      }, 3200);
    }
  },

  syncPlayIcon() {
    const paused = this.video.paused;
    const icon = paused
      ? '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>';
    $('#plPlay').innerHTML = icon;
    $('#plBigPlay').classList.toggle('show', paused);
  },

  syncMuteIcon() {
    const m = this.video.muted || this.video.volume === 0;
    $('#plMute').innerHTML = m
      ? '<svg viewBox="0 0 24 24"><path d="M16.5 12A4.5 4.5 0 0014 7.97v2.21l2.45 2.45c.03-.2.05-.41.05-.63zM19 12c0 .94-.2 1.82-.54 2.64l1.51 1.51A8.8 8.8 0 0021 12c0-4.28-3-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06a8.94 8.94 0 003.69-1.81L19.73 21 21 19.73l-9-9zM12 4L9.91 6.09 12 8.18z"/></svg>'
      : '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9zm13.5 3a4.5 4.5 0 00-2.5-4v8a4.5 4.5 0 002.5-4zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4-.91 7-4.49 7-8.77s-3-7.86-7-8.77z"/></svg>';
    $('#plMute').classList.toggle('on', m);
  },

  syncFav() {
    if (!this.item) return;
    const on = Store.isFav(this.item.seriesKey || this.item.key);
    $('#plFav').classList.toggle('on', on);
  },

  /* ------------------------------------------------------------------
   * Eventos da interface
   * ------------------------------------------------------------------ */
  bindUI() {
    const v = this.video;
    const seek = $('#plSeek');
    const seekInput = $('#plSeekInput');

    v.addEventListener('playing', () => { this.showLoading(false); this.syncPlayIcon(); this.showUI(); this.buildAudioMenu(); });
    v.addEventListener('play',    () => this.syncPlayIcon());
    v.addEventListener('pause',   () => { this.syncPlayIcon(); this.showUI(); });
    v.addEventListener('waiting', () => this.showLoading(true, 'Carregando buffer…'));
    v.addEventListener('canplay', () => this.showLoading(false));
    v.addEventListener('volumechange', () => {
      $('#plVol').value = Math.round(v.volume * 100);
      this.syncMuteIcon();
      Store.set('volume', v.volume);
      Store.set('muted', v.muted);
    });
    v.addEventListener('error', () => {
      if (this._ignoreErrors) return;       // erro disparado ao limpar o elemento
      if (this.hls || this.mpegts) return;  // esses motores reportam por conta própria
      const e = v.error;
      const map = {
        1: 'Reprodução cancelada.',
        2: 'Erro de rede ao baixar o stream.',
        3: 'Não foi possível decodificar o vídeo (codec ou container não suportado).',
        4: 'Formato não suportado pelo player.'
      };
      const base = map[e && e.code] || 'Falha desconhecida na reprodução.';
      const url = this.item && this.item.url;
      if (url) this.diagnose(url, base).then((msg) => this.showError(msg));
      else this.showError(base);
    });
    v.addEventListener('ended', () => {
      this.saveProgress();
      if (typeof UI !== 'undefined' && UI.playNextEpisode && UI.playNextEpisode(this.item)) return;
      this.syncPlayIcon();
    });

    v.addEventListener('timeupdate', () => {
      if (this.isLive || !isFinite(v.duration)) {
        $('#plCur').textContent = U.fmtTime(v.currentTime);
        return;
      }
      const pct = v.duration ? (v.currentTime / v.duration) : 0;
      $('#plSeekPlayed').style.width = (pct * 100) + '%';
      $('#plSeekKnob').style.left = (pct * 100) + '%';
      $('#plCur').textContent = U.fmtTime(v.currentTime);
      $('#plDur').textContent = U.fmtTime(v.duration);
      if (!this._seeking) seekInput.value = Math.round(pct * 1000);
    });

    v.addEventListener('progress', () => {
      if (!v.buffered.length || !isFinite(v.duration) || !v.duration) return;
      const end = v.buffered.end(v.buffered.length - 1);
      $('#plSeekBuf').style.width = Math.min(100, (end / v.duration) * 100) + '%';
    });

    v.addEventListener('click', () => this.toggle());
    v.addEventListener('dblclick', () => window.bishop.window.toggleFullscreen());

    seekInput.addEventListener('input', () => {
      this._seeking = true;
      if (!isFinite(v.duration)) return;
      const t = (seekInput.value / 1000) * v.duration;
      $('#plSeekPlayed').style.width = (seekInput.value / 10) + '%';
      $('#plSeekKnob').style.left = (seekInput.value / 10) + '%';
      $('#plCur').textContent = U.fmtTime(t);
    });
    seekInput.addEventListener('change', () => {
      if (isFinite(v.duration)) v.currentTime = (seekInput.value / 1000) * v.duration;
      this._seeking = false;
    });

    $('#plPlay').onclick = () => this.toggle();
    $('#plBigPlay').onclick = () => this.toggle();
    $('#plBack').onclick = () => this.close();
    $('#plBack10').onclick = () => { v.currentTime = Math.max(0, v.currentTime - 10); };
    $('#plFwd10').onclick = () => { v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10); };
    $('#plMute').onclick = () => { v.muted = !v.muted; };
    $('#plVol').oninput = (e) => { v.volume = e.target.value / 100; if (v.volume > 0) v.muted = false; };
    $('#plFull').onclick = () => window.bishop.window.toggleFullscreen();
    $('#plPip').onclick = async () => {
      try {
        if (document.pictureInPictureElement) await document.exitPictureInPicture();
        else await v.requestPictureInPicture();
      } catch { U.toast('Picture-in-picture indisponível para este stream.', 'warn'); }
    };
    $('#plRetry').onclick = () => { this.triedAlt = false; this.attach(this.item.url); };
    $('#plAltFormat').onclick = () => this.tryAlternate();
    $('#plCloseErr').onclick = () => this.close();
    $('#plFav').onclick = () => {
      const target = this.item.type === 'episode' && this.item.seriesRef ? this.item.seriesRef : this.item;
      Store.toggleFav(target);
      this.syncFav();
      if (typeof UI !== 'undefined') UI.refreshFavUI();
    };

    $('#plZapBtn').onclick = () => this.openZap();
    $('#zapClose').onclick = () => $('#zap').classList.add('hidden');
    $('#zapFilter').addEventListener('input', U.debounce((e) => this.renderZap(e.target.value), 180));
    U.on($('#zapList'), 'click', '.zap-item', (_e, el) => {
      const list = (this.context && this.context.list) || Lib.live;
      const idx = parseInt(el.dataset.idx, 10);
      const it = list[idx];
      if (it) {
        this.play(it, { list, index: idx });
        $('#zap').classList.add('hidden');
      }
    });

    // Menus
    const toggleMenu = (menu, other) => {
      $(other).classList.add('hidden');
      $(menu).classList.toggle('hidden');
    };
    $('#plQualityBtn').onclick = (e) => { e.stopPropagation(); this.buildQualityMenu(); toggleMenu('#plQualityMenu', '#plAudioMenu'); };
    $('#plAudioBtn').onclick   = (e) => { e.stopPropagation(); this.buildAudioMenu();   toggleMenu('#plAudioMenu', '#plQualityMenu'); };

    U.on($('#plQualityMenu'), 'click', 'button', (_e, b) => {
      if (this.hls) this.hls.currentLevel = parseInt(b.dataset.lvl, 10);
      this.buildQualityMenu();
      $('#plQualityMenu').classList.add('hidden');
    });

    U.on($('#plAudioMenu'), 'click', 'button', (_e, b) => {
      if (b.dataset.atrack != null && this.hls) {
        this.hls.audioTrack = parseInt(b.dataset.atrack, 10);
      } else if (b.dataset.ntrack != null && v.audioTracks) {
        const i = parseInt(b.dataset.ntrack, 10);
        for (let k = 0; k < v.audioTracks.length; k++) v.audioTracks[k].enabled = (k === i);
      } else if (b.dataset.sub != null) {
        const i = parseInt(b.dataset.sub, 10);
        for (let k = 0; k < v.textTracks.length; k++) v.textTracks[k].mode = (k === i) ? 'showing' : 'disabled';
      }
      this.buildAudioMenu();
      $('#plAudioMenu').classList.add('hidden');
    });

    $('#player').addEventListener('mousemove', U.throttle(() => this.showUI(), 120));
    $('#player').addEventListener('click', (e) => {
      if (!e.target.closest('.pl-menu-wrap')) {
        $('#plQualityMenu').classList.add('hidden');
        $('#plAudioMenu').classList.add('hidden');
      }
    });
  },

  toggle() {
    const v = this.video;
    if (v.paused) { v.play().catch(() => {}); }
    else v.pause();
    this.showUI();
  },

  bindKeys() {
    document.addEventListener('keydown', (e) => {
      if (!this.open) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        if (e.key === 'Escape') { $('#zap').classList.add('hidden'); e.target.blur(); }
        return;
      }
      const v = this.video;
      switch (e.key) {
        case ' ':
        case 'k': e.preventDefault(); this.toggle(); break;
        case 'Escape':
          if (!$('#zap').classList.contains('hidden')) $('#zap').classList.add('hidden');
          else this.close();
          break;
        case 'ArrowLeft':
          if (!this.isLive) { v.currentTime = Math.max(0, v.currentTime - 10); this.showUI(); }
          break;
        case 'ArrowRight':
          if (!this.isLive) { v.currentTime = Math.min(v.duration || 1e9, v.currentTime + 10); this.showUI(); }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (this.isLive && this.context) this.step(-1);
          else { v.volume = Math.min(1, v.volume + 0.05); this.showUI(); }
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (this.isLive && this.context) this.step(1);
          else { v.volume = Math.max(0, v.volume - 0.05); this.showUI(); }
          break;
        case 'f': window.bishop.window.toggleFullscreen(); break;
        case 'm': v.muted = !v.muted; this.showUI(); break;
        case 'c': if (this.isLive) this.openZap(); break;
        case 'PageUp':   if (this.context) this.step(-1); break;
        case 'PageDown': if (this.context) this.step(1); break;
      }
    });
  }
};
