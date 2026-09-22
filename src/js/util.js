/* ==================================================================
   util.js — helpers gerais
   ================================================================== */
'use strict';

const $  = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

const U = {
  /* ---------- texto ---------- */
  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  // Normaliza para busca: sem acentos, minúsculo, sem pontuação.
  norm(s) {
    return String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  },

  // Remove prefixos de qualidade/país comuns nas listas: "FHD| ", "[4K] ", "BR: "
  cleanName(s) {
    let n = String(s || '').trim();
    n = n.replace(/^\s*(\[[^\]]{1,14}\]|\([^)]{1,14}\))\s*/i, '');
    n = n.replace(/^\s*(4K|UHD|FHD|HD|SD|H265|HEVC|H\.?264|ADULT|VIP|PPV)\s*[|:\-–]\s*/i, '');
    n = n.replace(/^\s*[A-Z]{2,4}\s*[|:]\s*/, '');
    n = n.replace(/\s*[|]\s*$/, '');
    return n.trim() || String(s || '').trim();
  },

  // Título "limpo" para exibir em cards de filmes/séries
  titleOf(s) {
    let n = U.cleanName(s);
    n = n.replace(/\s*[\(\[]\s*(19|20)\d{2}\s*[\)\]]\s*$/, '');
    n = n.replace(/\s*[-–]\s*(4K|UHD|FHD|HD|SD|DUB|LEG|DUAL|LEGENDADO|DUBLADO)\s*$/i, '');
    return n.trim();
  },

  year(s) {
    const m = String(s || '').match(/(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/);
    return m ? m[1] : '';
  },

  /* ---------- números / tempo ---------- */
  fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  },

  fmtDuration(minsOrStr) {
    if (!minsOrStr) return '';
    if (typeof minsOrStr === 'string' && minsOrStr.includes(':')) return minsOrStr;
    const total = parseInt(minsOrStr, 10);
    if (!isFinite(total) || total <= 0) return '';
    const h = Math.floor(total / 60), m = total % 60;
    return h ? `${h}h ${m}min` : `${m}min`;
  },

  /* ---------- funções ---------- */
  debounce(fn, ms) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), ms);
    };
  },

  throttle(fn, ms) {
    let last = 0, pending = null;
    return function (...args) {
      const now = Date.now();
      if (now - last >= ms) { last = now; fn.apply(this, args); }
      else {
        clearTimeout(pending);
        pending = setTimeout(() => { last = Date.now(); fn.apply(this, args); }, ms - (now - last));
      }
    };
  },

  // Processa um array grande em fatias, devolvendo o controle ao navegador.
  async chunked(arr, size, fn) {
    for (let i = 0; i < arr.length; i += size) {
      const end = Math.min(i + size, arr.length);
      for (let j = i; j < end; j++) fn(arr[j], j);
      if (end < arr.length) await new Promise((r) => setTimeout(r, 0));
    }
  },

  uid() {
    return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  },

  // Hash estável para gerar chaves de cache e ids de item.
  hash(str) {
    let h = 5381;
    const s = String(str);
    for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  },

  /* ---------- URL ---------- */

  // Endereços colados de WhatsApp/Telegram costumam trazer espaços
  // invisíveis, quebras de linha e marcas de direção de texto.
  cleanUrl(s) {
    return String(s || '')
      .replace(/[​-‏‪-‮⁠﻿ ]/g, '')
      .replace(/\s+/g, '')
      .trim();
  },

  normalizeHost(host) {
    let h = U.cleanUrl(host).replace(/\/+$/, '');
    if (!h) return '';
    if (!/^https?:\/\//i.test(h)) h = 'http://' + h;
    return h;
  },

  extOf(url) {
    const m = String(url || '').split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
    return m ? m[1].toLowerCase() : '';
  },

  /* ---------- DOM ---------- */
  el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  },

  on(target, evt, sel, handler) {
    target.addEventListener(evt, (e) => {
      const hit = e.target.closest(sel);
      if (hit && target.contains(hit)) handler(e, hit);
    });
  },

  toast(msg, kind) {
    const host = $('#toasts');
    if (!host) return;
    const t = U.el('div', 'toast' + (kind ? ' ' + kind : ''), U.esc(msg));
    host.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .3s, transform .3s';
      t.style.opacity = '0';
      t.style.transform = 'translateX(28px)';
      setTimeout(() => t.remove(), 320);
    }, 4200);
  },

  loader(show, text, sub) {
    const box = $('#globalLoader');
    if (!box) return;
    if (show) {
      $('#glText').textContent = text || 'Carregando…';
      $('#glSub').textContent = sub || '';
      box.classList.remove('hidden');
    } else {
      box.classList.add('hidden');
    }
  },

  loaderSub(sub) {
    const n = $('#glSub');
    if (n) n.textContent = sub || '';
  }
};
