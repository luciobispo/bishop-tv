/* ==================================================================
   tvnav.js — navegação pelo controle remoto (Fire TV / Android TV)

   O WebView só move o foco sozinho entre botões e campos, e os cards são
   <div>: sem isto, o controle remoto não sai do menu superior. Aqui as setas
   escolhem o elemento mais próximo na direção pressionada (navegação
   espacial) e o OK clica nele. Só roda no Android — no PC há mouse.
   ================================================================== */
'use strict';

const TvNav = {
  CANDIDATES: 'button, input, select, textarea, a[href], .card, .ep-item',
  // O coração do card só aparece com mouse; o favorito fica no detalhe.
  EXCLUDE: '.card-fav, .winctl *, .row-arrow, #player *, [disabled]',
  // Ao entrar num destes grupos, o foco vai para o item ativo, não para o
  // mais próximo — ex.: de um canal para a esquerda cai na categoria atual.
  GROUPS: '.cat-list, #rail, .tabs, .search-tabs',
  KEYS: { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' },
  // Ordem = prioridade: o guia pode ser aberto pelo menu de um card.
  MODALS: ['#ctxMenu', '#guide', '#detail', '#onboarding'],
  // Segurar OK num card/categoria abre o menu de ocultar (App.openItemMenu).
  MENU_TARGETS: '.card, .cat-item',
  LONG_PRESS_MS: 550,
  press: null,      // OK pressionado num card: o clique sai ao soltar

  lastMain: null,   // último foco fora dos modais, para voltar ao fechar um

  init() {
    if (!document.documentElement.classList.contains('is-android')) return;
    document.addEventListener('keydown', (e) => this.onKey(e), true);
    document.addEventListener('keyup', (e) => this.onKeyUp(e), true);
    document.addEventListener('focusout', (e) => this.restoreField(e.target), true);

    // Abrir um modal leva o foco para ele; fechar devolve ao card de origem.
    for (const id of this.MODALS) {
      const el = $(id);
      if (!el) continue;
      let open = !el.classList.contains('hidden');
      new MutationObserver(() => {
        const now = !el.classList.contains('hidden');
        if (now === open) return;
        open = now;
        setTimeout(() => this.focus(this.entryPoint(this.scope())), 50);
      }).observe(el, { attributes: true, attributeFilter: ['class'] });
    }
  },

  /** Modal aberto limita a navegação a ele. */
  scope() {
    for (const id of this.MODALS) {
      const el = $(id);
      if (el && !el.classList.contains('hidden')) return el;
    }
    return document.body;
  },

  isVisible(el) {
    if (!el.getClientRects().length) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  },

  candidates(scope) {
    return $$(this.CANDIDATES, scope).filter((el) =>
      !el.matches(this.EXCLUDE) && !el.closest('.hidden') && this.isVisible(el));
  },

  isTextField(el) {
    return el && (el.tagName === 'TEXTAREA' ||
      (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|range|file)$/i.test(el.type)));
  },

  onKey(e) {
    if (typeof Player !== 'undefined' && Player.open) return;
    const cur = document.activeElement;
    const scope = this.scope();

    // O menu abriu com o OK ainda segurado: as repetições não podem clicar
    // na primeira opção (ocultaria sem o usuário escolher).
    if (e.key === 'Enter' && this.press && this.press.menu && Date.now() - this.press.last < 400) {
      this.press.last = Date.now();
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const menuTarget = scope === document.body && cur && cur.matches && cur.matches(this.MENU_TARGETS);
    if (e.key === 'ContextMenu' && menuTarget) {
      e.preventDefault();
      return App.openItemMenu(cur);
    }
    if (e.key === 'Enter' && menuTarget) return this.holdOk(e, cur);
    if (e.key === 'Enter') return this.activate(e, cur);

    const dir = this.KEYS[e.key];
    if (!dir) return;

    // Campo em edição: esquerda/direita movem o cursor até a borda do texto.
    if (this.isTextField(cur) && !cur.readOnly && (dir === 'left' || dir === 'right')) {
      const atStart = cur.selectionStart === 0 && cur.selectionEnd === 0;
      const atEnd = cur.selectionStart === cur.value.length;
      if ((dir === 'left' && !atStart) || (dir === 'right' && !atEnd)) return;
    }

    e.preventDefault();
    e.stopPropagation();

    let from = cur;
    if (!from || from === document.body || !scope.contains(from) || !this.isVisible(from)) {
      // Lista redesenhada (ex.: ao trocar de categoria): segue do item equivalente.
      from = scope === document.body ? this.recover() : null;
      if (!from) {
        this.focus(this.entryPoint(scope));
        return;
      }
    }
    const next = this.find(from, dir, this.candidates(scope));
    if (next) this.focus(next, cur);
  },

  /**
   * OK num card: o clique só sai ao soltar. Segurado (o controle repete o
   * keydown), abre o menu de ocultar no lugar do clique.
   */
  holdOk(e, el) {
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now(), p = this.press;
    // Repetições chegam a cada ~50 ms; um keydown depois de uma pausa é um
    // toque novo (o keyup do anterior pode ter se perdido).
    if (!p || p.el !== el || now - p.last > 400) {
      this.press = { el, at: now, last: now, menu: false };
      return;
    }
    p.last = now;
    if (!p.menu && now - p.at >= this.LONG_PRESS_MS) {
      p.menu = true;
      App.openItemMenu(el);
    }
  },

  onKeyUp(e) {
    if (e.key !== 'Enter' || !this.press) return;
    const { el, menu } = this.press;
    this.press = null;
    e.preventDefault();
    if (!menu && el.isConnected && !(typeof Player !== 'undefined' && Player.open)) el.click();
  },

  /** OK do controle. */
  activate(e, el) {
    if (!el || el === document.body) return;
    if (this.isTextField(el)) {
      if (el.readOnly && el.dataset.tvRo) {
        // Libera a edição e abre o teclado da TV.
        e.preventDefault();
        el.readOnly = false;
        delete el.dataset.tvRo;
        el.blur();
        el.focus();
        el.click();
      }
      return;
    }
    if (el.tagName === 'SELECT') {
      e.preventDefault();
      try { el.showPicker(); } catch { el.click(); }
      return;
    }
    // Clique explícito para tudo (inclusive botões): o clique nativo do Enter
    // depende do WebView e não existe em <div>.
    e.preventDefault();
    el.click();
  },

  /** O último foco saiu do DOM: acha o elemento que o substituiu (mesmo id/data-*). */
  recover() {
    const el = this.lastMain;
    if (!el || el.isConnected) return null;
    for (const attr of ['id', 'data-cat', 'data-key', 'data-nav']) {
      const v = el.getAttribute(attr);
      if (!v) continue;
      const found = attr === 'id' ? document.getElementById(v) : $(`[${attr}="${CSS.escape(v)}"]`);
      if (found && this.isVisible(found)) return found;
    }
    return null;
  },

  /** Primeiro foco da tela: o que estava antes do modal, o "Assistir" do banner ou o 1º card. */
  entryPoint(scope) {
    if (scope === document.body) {
      if (this.lastMain && this.lastMain.isConnected && this.isVisible(this.lastMain)) return this.lastMain;
      const view = $('.view:not(.hidden)');
      return (view && (view.querySelector('#heroPlay') || view.querySelector('.card') || this.candidates(view)[0])) ||
        $('.rail-item.active') || this.candidates(scope)[0];
    }
    // No guia, o foco começa no programa que está no ar.
    return scope.querySelector('.guide-now, .btn-play:not(.hidden)') || this.candidates(scope)[0];
  },

  /**
   * Melhor candidato na direção: fica à frente do atual e minimiza a distância
   * no eixo do movimento, com peso maior para o desalinhamento no outro eixo
   * (prefere a mesma linha/coluna).
   */
  find(cur, dir, list) {
    const c = cur.getBoundingClientRect();
    const cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    const TOL = 12; // o card em foco cresce um pouco (scale)
    let best = null, bestScore = Infinity;

    for (const el of list) {
      if (el === cur || el.contains(cur) || cur.contains(el)) continue;
      const r = el.getBoundingClientRect();
      const rx = r.left + r.width / 2, ry = r.top + r.height / 2;
      let main, cross;
      if (dir === 'right') {
        if (r.left < c.right - TOL || rx <= cx) continue;
        main = Math.max(0, r.left - c.right);
        cross = Math.max(0, r.top - c.bottom, c.top - r.bottom);
      } else if (dir === 'left') {
        if (r.right > c.left + TOL || rx >= cx) continue;
        main = Math.max(0, c.left - r.right);
        cross = Math.max(0, r.top - c.bottom, c.top - r.bottom);
      } else if (dir === 'down') {
        if (r.top < c.bottom - TOL || ry <= cy) continue;
        main = Math.max(0, r.top - c.bottom);
        cross = Math.max(0, r.left - c.right, c.left - r.right);
      } else {
        if (r.bottom > c.top + TOL || ry >= cy) continue;
        main = Math.max(0, c.top - r.bottom);
        cross = Math.max(0, r.left - c.right, c.left - r.right);
      }
      // Desempate entre alinhados: o de centro mais próximo.
      const off = dir === 'left' || dir === 'right' ? Math.abs(ry - cy) : Math.abs(rx - cx);
      const score = main + cross * 4 + off * 0.1;
      if (score < bestScore) { bestScore = score; best = el; }
    }

    if (best) {
      const group = best.closest(this.GROUPS);
      if (group && !group.contains(cur)) {
        const active = group.querySelector('.active');
        if (active && this.isVisible(active)) return active;
      }
    }
    return best;
  },

  focus(el) {
    if (!el) return;
    // Campo de texto entra só leitura: sem isso o teclado da TV abriria a
    // cada vez que o foco passasse por ele. O OK libera a edição.
    if (this.isTextField(el) && !el.readOnly) {
      el.readOnly = true;
      el.dataset.tvRo = '1';
    }
    if (!el.matches('button, input, select, textarea, a[href]') && !el.hasAttribute('tabindex')) {
      el.tabIndex = -1;
    }
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    if (this.scope() === document.body) this.lastMain = el;
  },

  restoreField(el) {
    if (el && el.dataset && el.dataset.tvRo) {
      el.readOnly = false;
      delete el.dataset.tvRo;
    }
  }
};

TvNav.init();
