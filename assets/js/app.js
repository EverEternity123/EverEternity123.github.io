/* ==========================================================================
   app.js — 页面渲染与交互
   依赖：markdown.js
   数据：fetch('data/posts.json')，与写作台写入的是同一个文件
   ========================================================================== */
(function () {
  'use strict';

  var DATA_URL = 'data/posts.json';

  /* 自定义顺序（可选）。文件不存在就当成没有，退化成「按日期降序」 */
  var ORDER_URL = 'data/order.json';

  /* order.json 里记的标签先后。空数组 = 没排过，标签按「第一次出现」的先后。
     在 loadPosts() 里填。 */
  var ORDER_TAGS = [];

  /* 与 write.config.js 里的 defaultAuthor 保持一致。
     卡片上只在作者跟它不一样时才显示作者，免得每张卡片都在重复同一行字。 */
  var DEFAULT_AUTHOR = 'Ever Eternity';

  /* 复制链接时要给出「正式地址」，不能是 file:// 或者本地调试的 localhost。
     和页面里 og:url 那几处写的是同一个地址。 */
  var SITE_ORIGIN = 'https://evereternity123.github.io';

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

  /* 站主自己写的文章 → 标「原创」，让人在点进去之前就能分辨。
     判据跟「卡片上要不要显示作者」是同一件事的两面：
     作者栏没写、或写的就是默认署名，都算站主自己写的。 */
  function isOriginal(p) { return !p.author || p.author === DEFAULT_AUTHOR; }

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

  /* 「几分钟」说的是**阅读时长**，不是别的。
     算法在 markdown.js：去掉代码块、按每分钟 350 字估算，至少 1 分钟。
     卡片和文章页都走这两个函数，口径不会跑偏。 */
  function readMinutes(content) { return MD.readingTime(content); }

  /* 卡片上地方小，只写「约 N 分钟」 */
  function readingShort(content) {
    return '约 ' + readMinutes(content) + ' 分钟';
  }

  /* 文章页要写清楚，别让人猜「几分钟」是什么 */
  function readingLong(content) {
    return '约 ' + readMinutes(content) + ' 分钟读完';
  }

  /* 阅读时长那行文字的悬停说明 */
  var READING_HINT = '按每分钟 350 字估算的阅读时长';

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
    // 写作台里拖过的标签顺序优先（order.json 的 tags）；
    // 没排过的保持「第一次出现」的先后，排在后面
    if (window.EE_ORDER) out = window.EE_ORDER.sortTags(out, ORDER_TAGS);
    return { list: out, count: seen };
  }

  /* ---------- 数据加载 ---------- */

  function loadPosts() {
    return Promise.all([
      fetch(DATA_URL, { cache: 'no-cache' }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      }),
      // order.json 是可选的第二个请求：读不到、404、解析失败 —— 一律当成「没排过序」
      fetch(ORDER_URL, { cache: 'no-cache' })
        .then(function (res) { return res.ok ? res.json() : null; })
        .catch(function () { return null; })
    ]).then(function (both) {
      var list = both[0], order = both[1];
      if (!Array.isArray(list)) throw new Error('数据格式不对');
      var ord = window.EE_ORDER;
      if (ord) {
        ORDER_TAGS = ord.tagsOf(order);           // 标签先后，给 allTags() 用
        return ord.apply(list, ord.idsOf(order));
      }
      // order.js 没加载上也不至于开天窗：退回按日期降序
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

    // 站主自己写的标「原创」—— 和上面互斥，所以卡片上不会同时出现作者名和这个标
    var original = isOriginal(p)
      ? '<span class="dot"></span><span class="badge-original">原创</span>'
      : '';

    return '' +
      '<a class="post-card reveal" href="' + postUrl(p.id) + '">' +
        '<h3>' + MD.escape(p.title) + '</h3>' +
        '<p class="excerpt">' + MD.escape(p.lede || MD.excerpt(p.content, 92)) + '</p>' +
        '<div class="post-meta">' +
          '<time datetime="' + p.date + '">' + fmtDate(p.date, 'long') + '</time>' +
          '<span class="dot"></span>' +
          '<span title="' + READING_HINT + '">' + readingShort(p.content) + '</span>' +
          original +
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

  /* ---------- 提示条 ---------- */
  /* 跟写作台那个 .toast 长得一样（样式在 style.css 里，写作台另有一处抬高位置的覆盖）。
     同一条提示连着弹两次时重置计时器，不会出现「第二次一闪就没」。 */
  var toastTimer = null;

  function toast(msg, isError) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  /* ---------- 复制文章链接 ---------- */
  /* 给出「正式地址」。本地双击打开时 location.origin 是 null、起本地服务时是
     localhost —— 都不该被复制出去，所以退回站点域名。 */
  function shareUrl(id) {
    var base = (location.protocol === 'file:' || /^(localhost|127\.|\[::1\])/.test(location.hostname))
      ? SITE_ORIGIN + '/post.html'
      : location.origin + location.pathname;
    return base + '?p=' + encodeURIComponent(id);
  }

  /* 剪贴板 API 要求安全上下文（https 或 localhost）。
     本地双击打开是 file://，navigator.clipboard 直接不存在，
     所以留一条 textarea + execCommand 的老路兜底。 */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error('浏览器不让复制'));
    });
  }

  function initShare(post) {
    var box = $('#post-share');
    var btn = $('#btn-share');
    if (!box || !btn || !post) return;

    var label = $('.share-text', btn);
    var resetTimer = null;

    btn.addEventListener('click', function () {
      copyText(shareUrl(post.id)).then(function () {
        toast('已复制网页链接');
        // 按钮自己也变一下，光标不在提示条附近时也看得到反馈
        if (!label) return;
        label.textContent = '已复制';
        btn.classList.add('done');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(function () {
          label.textContent = '复制链接';
          btn.classList.remove('done');
        }, 1800);
      }).catch(function () {
        toast('复制失败，长按地址栏手动复制吧', true);
      });
    });

    box.hidden = false;
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

    // 写清楚这是**阅读时长**，不是「几分钟前发布」之类的意思
    var timeEl = $('#post-time');
    if (timeEl) {
      timeEl.textContent = readingLong(post.content);
      timeEl.title = READING_HINT;
    }

    // 自己写的标「原创」，和列表卡片上是同一个判据
    var originalEl = $('#post-original');
    if (originalEl) originalEl.hidden = !isOriginal(post);

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

    // 正文底部的「复制链接」。放在上一篇/下一篇之前 —— 读完正文就该看到它
    initShare(post);

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

    // 站点信息（首页介绍 / 关于页 / 页脚）是独立的，文章挂了也不该连累它
    if (window.SITE) {
      window.SITE.load().then(window.SITE.apply).catch(function (err) {
        console.warn('[app] 站点信息没读到，沿用页面里的静态内容', err);
      });
    }

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
