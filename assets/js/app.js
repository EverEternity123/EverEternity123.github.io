/* ==========================================================================
   app.js — 页面渲染与交互
   依赖：markdown.js
   数据：fetch('data/posts.json')，与写作台写入的是同一个文件
   ========================================================================== */
(function () {
  'use strict';

  var DATA_URL = 'data/posts.json';

  /* 与 write.config.js 里的 defaultAuthor 保持一致。
     卡片上只在作者跟它不一样时才显示作者，免得每张卡片都在重复同一行字。 */
  var DEFAULT_AUTHOR = 'Ever Eternity';

  var POSTS = [];

  var MONTHS = ['一月', '二月', '三月', '四月', '五月', '六月',
                '七月', '八月', '九月', '十月', '十一月', '十二月'];

  /* ---------- 工具 ---------- */

  function $(sel, ctx) { return (ctx || document).querySelector(sel); }

  /* 写作台里勾了「隐藏」的文章：不进列表、不进归档、不进标签，
     但 post.html?p=<id> 直接打开仍然看得到（方便自己预览） */
  function isHidden(p) { return p.hidden === true; }

  function visiblePosts() {
    return POSTS.filter(function (p) { return !isHidden(p); });
  }

  function authorOf(p) { return p.author || DEFAULT_AUTHOR; }

  function fmtDate(iso, style) {
    var p = String(iso || '').split('-');
    if (p.length < 3) return iso || '';
    var y = p[0], m = Number(p[1]), d = Number(p[2]);
    if (style === 'long')  return y + ' 年 ' + m + ' 月 ' + d + ' 日';
    if (style === 'month') return MONTHS[m - 1];
    return y + '.' + String(m).padStart(2, '0') + '.' + String(d).padStart(2, '0');
  }

  function byId(id) {
    for (var i = 0; i < POSTS.length; i++) {
      if (POSTS[i].id === id) return POSTS[i];
    }
    return null;
  }

  function postUrl(id) { return 'post.html?p=' + encodeURIComponent(id); }

  function param(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function allTags(list) {
    var seen = {}, out = [];
    (list || POSTS).forEach(function (p) {
      (p.tags || []).forEach(function (t) {
        if (!seen[t]) { seen[t] = 0; out.push(t); }
        seen[t]++;
      });
    });
    return { list: out, count: seen };
  }

  /* ---------- 数据加载 ---------- */

  function loadPosts() {
    return fetch(DATA_URL, { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (list) {
        if (!Array.isArray(list)) throw new Error('数据格式不对');
        return list.slice().sort(function (a, b) {
          return String(b.date).localeCompare(String(a.date));
        });
      });
  }

  function setLoading() {
    var list = $('#post-list');
    if (list) list.innerHTML = '<div class="empty">正在加载文章…</div>';
    var arch = $('#archive-list');
    if (arch) arch.innerHTML = '<div class="empty">正在加载…</div>';
  }

  function showLoadError(err) {
    var tip = '文章加载失败' + (err && err.message ? '（' + err.message + '）' : '') +
              '，刷新试试。';
    var list = $('#post-list');
    if (list) list.innerHTML = '<div class="empty">' + tip + '</div>';
    var arch = $('#archive-list');
    if (arch) arch.innerHTML = '<div class="empty">' + tip + '</div>';
    var main = $('#post-main');
    if (main) {
      main.innerHTML =
        '<a class="back-link" href="index.html">← 返回首页</a>' +
        '<h1 style="font-family:var(--font-serif);margin:0 0 12px">文章加载失败</h1>' +
        '<p style="color:var(--text-2)">' + MD.escape(tip) + '</p>';
    }
    console.error('[app] ' + tip, err);
  }

  /* ---------- 卡片 ---------- */

  function cardHTML(p) {
    var tags = (p.tags || []).map(function (t) {
      return '<span class="tag">' + MD.escape(t) + '</span>';
    }).join('');

    // 只有作者不是站主时才显示，免得每张卡片重复同一个名字
    var author = p.author && p.author !== DEFAULT_AUTHOR
      ? '<span class="dot"></span><span class="byline">' + MD.escape(p.author) + '</span>'
      : '';

    return '' +
      '<a class="post-card reveal" href="' + postUrl(p.id) + '">' +
        '<h3>' + MD.escape(p.title) + '</h3>' +
        '<p class="excerpt">' + MD.escape(p.lede || MD.excerpt(p.content, 92)) + '</p>' +
        '<div class="post-meta">' +
          '<time datetime="' + p.date + '">' + fmtDate(p.date, 'long') + '</time>' +
          '<span class="dot"></span>' +
          '<span>' + MD.readingTime(p.content) + ' 分钟</span>' +
          author +
          (tags ? '<span class="dot"></span>' + tags : '') +
        '</div>' +
      '</a>';
  }

  /* ---------- 入场动画 ---------- */
  function observeReveal() {
    var items = document.querySelectorAll('.reveal:not(.in)');
    if (!items.length) return;

    if (!('IntersectionObserver' in window)) {
      Array.prototype.forEach.call(items, function (el) { el.classList.add('in'); });
      return;
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en, i) {
        if (!en.isIntersecting) return;
        var el = en.target;
        window.setTimeout(function () { el.classList.add('in'); }, i * 55);
        io.unobserve(el);
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });

    Array.prototype.forEach.call(items, function (el) { io.observe(el); });
  }

  /* ---------- 回到顶部 ---------- */
  function initToTop() {
    if ($('.to-top')) return;

    var btn = document.createElement('button');
    btn.className = 'to-top';
    btn.type = 'button';
    btn.setAttribute('aria-label', '回到顶部');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
                    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
                    '<path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    btn.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.body.appendChild(btn);

    var onScroll = function () {
      btn.classList.toggle('show', window.scrollY > 520);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------- 首页 ---------- */
  function initIndex() {
    var listEl = $('#post-list');
    if (!listEl) return;

    var shown = visiblePosts();
    var tags = allTags(shown);
    var tagbarEl = $('#tagbar');
    var searchEl = $('#search');
    var state = { tag: '', q: '' };

    if (tagbarEl) {
      var html = '<button class="tag-btn on" data-tag="">全部<span class="count">' +
                 shown.length + '</span></button>';
      tags.list.forEach(function (t) {
        html += '<button class="tag-btn" data-tag="' + MD.escape(t) + '">' +
                MD.escape(t) + '<span class="count">' + tags.count[t] + '</span></button>';
      });
      tagbarEl.innerHTML = html;

      tagbarEl.addEventListener('click', function (e) {
        var btn = e.target.closest('.tag-btn');
        if (!btn) return;
        state.tag = btn.getAttribute('data-tag');
        Array.prototype.forEach.call(tagbarEl.children, function (b) {
          b.classList.toggle('on', b === btn);
        });
        render();
      });
    }

    if (searchEl) {
      searchEl.addEventListener('input', function () {
        state.q = searchEl.value.trim().toLowerCase();
        render();
      });
    }

    function match(p) {
      if (state.tag && (p.tags || []).indexOf(state.tag) === -1) return false;
      if (!state.q) return true;
      var hay = [p.title, p.lede || '', (p.tags || []).join(' '), p.content || '']
                  .join(' ').toLowerCase();
      return hay.indexOf(state.q) !== -1;
    }

    function render() {
      var result = shown.filter(match);
      if (!result.length) {
        listEl.innerHTML = shown.length
          ? '<div class="empty">没有找到相关的文章。</div>'
          : '<div class="empty">还没有文章。去 <a href="write.html" ' +
            'style="color:var(--accent)">写作台</a> 写第一篇吧。</div>';
        return;
      }
      listEl.innerHTML = result.map(cardHTML).join('');
      observeReveal();
    }

    render();
  }

  /* ---------- 文章页 ---------- */
  function initPost() {
    var bodyEl = $('#post-body');
    if (!bodyEl) return;

    var shown = visiblePosts();
    var id = param('p');
    // 隐藏的文章不在列表里，但知道链接就打得开（方便自己先看看效果）
    var post = id ? byId(id) : (shown[0] || POSTS[0]);
    var wrap = $('#post-main');

    if (!post) {
      if (wrap) {
        wrap.innerHTML =
          '<a class="back-link" href="index.html">← 返回首页</a>' +
          '<h1 style="font-family:var(--font-serif);margin:0 0 12px">找不到这篇文章</h1>' +
          '<p style="color:var(--text-2)">它可能被删掉了，或者链接里的地址不对。</p>';
      }
      return;
    }

    document.title = post.title + ' · Ever Eternity';

    $('#post-title').textContent = post.title;
    $('#post-date').textContent = fmtDate(post.date, 'long');
    $('#post-author').textContent = authorOf(post);
    $('#post-time').textContent = MD.readingTime(post.content) + ' 分钟';

    // 隐藏的文章：只在直接打开时提醒一下，列表里根本看不到
    if (isHidden(post) && wrap) {
      var header = $('.post-header', wrap);
      var note = document.createElement('div');
      note.className = 'hidden-note';
      note.innerHTML = '这篇还没公开 —— 它不会出现在首页、归档和标签里，' +
                       '只有拿到这个链接才能看到。';
      if (header) wrap.insertBefore(note, header);
      else wrap.appendChild(note);
    }

    var ledeEl = $('#post-lede');
    if (ledeEl) {
      if (post.lede) ledeEl.textContent = post.lede;
      else ledeEl.remove();
    }

    var tagsEl = $('#post-tags');
    if (tagsEl) {
      tagsEl.innerHTML = (post.tags || []).map(function (t) {
        return '<a class="chip" href="index.html?tag=' + encodeURIComponent(t) + '">' +
               MD.escape(t) + '</a>';
      }).join('');
    }

    bodyEl.innerHTML = MD.render(post.content);

    // 上一篇 / 下一篇。只在公开的文章之间走，免得把隐藏的标题漏出去
    var navEl = $('#post-nav');
    if (navEl) {
      var idx = shown.indexOf(post);
      if (idx < 0) {
        navEl.innerHTML = '';
      } else {
        var newer = idx > 0 ? shown[idx - 1] : null;
        var older = idx < shown.length - 1 ? shown[idx + 1] : null;
        var out = '';
        out += older
          ? '<a class="prev" href="' + postUrl(older.id) + '"><span class="dir">← 上一篇</span>' +
            '<span class="ttl">' + MD.escape(older.title) + '</span></a>'
          : '<span></span>';
        out += newer
          ? '<a class="next" href="' + postUrl(newer.id) + '"><span class="dir">下一篇 →</span>' +
            '<span class="ttl">' + MD.escape(newer.title) + '</span></a>'
          : '<span></span>';
        navEl.innerHTML = out;
      }
    }

    // 阅读进度条
    var bar = document.createElement('div');
    bar.className = 'reading-progress';
    document.body.appendChild(bar);

    var onScroll = function () {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      bar.style.width = (h > 0 ? Math.min(100, (window.scrollY / h) * 100) : 0) + '%';
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    onScroll();
  }

  /* ---------- 归档页 ---------- */
  function initArchive() {
    var el = $('#archive-list');
    if (!el) return;

    var stat = $('#archive-stat');
    var shown = visiblePosts();

    if (!shown.length) {
      el.innerHTML = '<div class="empty">还没有文章。</div>';
      if (stat) stat.textContent = '共 0 篇';
      return;
    }

    var groups = {}, order = [];
    shown.forEach(function (p) {
      var y = String(p.date).slice(0, 4);
      if (!groups[y]) { groups[y] = []; order.push(y); }
      groups[y].push(p);
    });
    order.sort(function (a, b) { return b.localeCompare(a); });

    el.innerHTML = order.map(function (y) {
      var items = groups[y].map(function (p) {
        return '<a class="arch-item" href="' + postUrl(p.id) + '">' +
                 '<time datetime="' + p.date + '">' + fmtDate(p.date) + '</time>' +
                 '<span class="t">' + MD.escape(p.title) + '</span>' +
               '</a>';
      }).join('');
      return '<section class="year-group">' +
               '<h2 class="year-head">' + y + '</h2>' + items +
             '</section>';
    }).join('');

    if (stat) {
      var words = shown.reduce(function (n, p) {
        return n + String(p.content || '').replace(/\s+/g, '').length;
      }, 0);
      stat.textContent = '共 ' + shown.length + ' 篇 · 约 ' +
                         (words / 1000).toFixed(1) + ' 千字';
    }

    var cloud = $('#tag-cloud');
    if (cloud) {
      var t = allTags(shown);
      cloud.innerHTML = t.list.map(function (tag) {
        return '<a class="chip" href="index.html?tag=' + encodeURIComponent(tag) + '">' +
               MD.escape(tag) + '<span class="count">' + t.count[tag] + '</span></a>';
      }).join('');
    }
  }

  /* ---------- 首页支持 ?tag=xxx ---------- */
  function applyTagFromUrl() {
    var tag = param('tag');
    if (!tag) return;
    var bar = $('#tagbar');
    if (!bar) return;
    var target = bar.querySelector('.tag-btn[data-tag="' + tag.replace(/"/g, '\\"') + '"]');
    if (target) target.click();
  }

  /* ---------- 导航高亮 ---------- */
  function highlightNav() {
    var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    Array.prototype.forEach.call(document.querySelectorAll('.nav a'), function (a) {
      var href = (a.getAttribute('href') || '').toLowerCase();
      if (href === page || (page === '' && href === 'index.html')) a.classList.add('active');
    });
  }

  /* ---------- 启动 ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    highlightNav();
    initToTop();
    setLoading();

    loadPosts().then(function (list) {
      POSTS = list;
      initIndex();
      initPost();
      initArchive();
      applyTagFromUrl();
      observeReveal();
    }).catch(showLoadError);
  });
})();
