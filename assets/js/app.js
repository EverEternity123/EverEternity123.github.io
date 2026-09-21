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

  /* 站点名，只用在「分享本文」复制出来的那行文字里（见 shareText）。
     和 DEFAULT_AUTHOR 目前是同一个字符串，但**语义不同** ——
     哪天想把署名改成别的，别顺手把这个也改了。
     `.tools/build-posts.py` 里的 SITE_NAME 要跟着一起改（og:site_name 用它）。 */
  var SITE_NAME = 'Ever Eternity';

  /* 每篇文章的静态页（p/<id>.html，由 .tools/build-posts.py 生成）里会写上
     自己的 id。它优先于 ?p= —— 这样 /p/xxx.html 不带查询参数也能知道是哪篇。
     post.html 里这个值是空字符串（标记位没被替换过）。 */
  var STATIC_ID = typeof window.EE_POST_ID === 'string' ? window.EE_POST_ID : '';

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

  /* 正文有多少字。和阅读时长同源（markdown.js 的 charCount），
     所以「2 千字」和「约 6 分钟」永远对得上。 */
  function readChars(content) { return MD.charCount(content); }

  /* 卡片上地方小，只写「约 N 分钟」 */
  function readingShort(content) {
    return '约 ' + readMinutes(content) + ' 分钟';
  }

  /* 文章页地方宽裕：先报字数，再报阅读时长。
     光写「约 N 分钟读完」看不出文章多长，前面垫一个字数就一眼有数了。 */
  function readingLong(content) {
    return readChars(content) + ' 字 · 约 ' + readMinutes(content) + ' 分钟读完';
  }

  /* 阅读时长那行文字的悬停说明 */
  var READING_HINT = '字数＝去掉代码块和空白后的正文字数；阅读时长按每分钟 350 字估算';

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

  /* ---------- 返回：回到**你来的那一页**，而不是无脑回首页 ---------- */
  /* 2026-09-21 用户要求：文章页左上角那个按钮改叫「返回」，
     而且要**停在原来那个标签 / 那个滚动位置**，别一按就回到干干净净的首页。

     分两半做：

     1）能回就回 —— `document.referrer` 是本站的（＝从首页 / 归档页点进来的），
        就 `history.back()`。这样 `index.html?tag=随笔` 那层筛选状态原样回来。
        没有来路（直接打开、从微信点进来、分享卡片点进来）才退回 `index.html`
        —— 也就是 `<a href="index.html">` 那层兜底，JS 挂了也照样能用。

     2）滚动位置自己记 —— 列表是 JS 渲染的，浏览器自带的「后退恢复滚动位置」
        **赶在列表渲染完成之前就执行了**，结果永远是白恢复（回到顶部）。
        所以列表页把 `history.scrollRestoration` 关掉，改成：点卡片进文章之前
        把位置写进 sessionStorage，列表渲染完再还回去。

     用 sessionStorage 不用 localStorage：一个标签页一份，
     新开一个标签页看首页不会莫名其妙滚到中间。 */
  var LIST_POS_KEY = 'ee-list-scroll';

  /* 当前这页是不是「有文章列表的页」（首页 / 归档页） */
  function isListPage() {
    return !!(document.getElementById('post-list') ||
              document.getElementById('archive-list'));
  }

  function rememberListPos() {
    try {
      sessionStorage.setItem(LIST_POS_KEY, String(window.pageYOffset || 0));
    } catch (e) { /* 隐私模式 / 禁用存储时忽略，顶多是不记 */ }
  }

  function restoreListPos() {
    // ⚠️ 文章页绝不能消费这个 key —— 消费了就白记了，返回时找不回来
    if (!isListPage()) return;
    var v = null;
    try {
      v = sessionStorage.getItem(LIST_POS_KEY);
      sessionStorage.removeItem(LIST_POS_KEY);   // 只还一次，别赖着
    } catch (e) { return; }
    if (v === null) return;
    var y = parseInt(v, 10);
    if (!isFinite(y) || y <= 0) return;
    // 等一帧：列表是刚 innerHTML 进去的，得先完成布局才有得滚
    requestAnimationFrame(function () { window.scrollTo(0, y); });
  }

  /* 来路是不是本站？不是的话就走 href 兜底，别 history.back() 把人家送出站 */
  function cameFromThisSite() {
    if (history.length < 2) return false;
    var ref = document.referrer || '';
    if (!ref) return false;
    try {
      return new URL(ref).origin === location.origin;
    } catch (e) {
      return false;
    }
  }

  function initBack() {
    var link = document.getElementById('back-link');
    if (!link) return;
    link.addEventListener('click', function (e) {
      // 中键 / Ctrl+点击 / Shift+点击 = 「在新窗口打开」，别拦人家
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
      if (!cameFromThisSite()) return;   // 没来路 → 走 href="index.html"
      e.preventDefault();
      history.back();
    });
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

  /* ---------- 分享文章链接 ---------- */
  /* 给出「正式地址」。本地双击打开时 location.origin 是 null、起本地服务时是
     localhost —— 都不该被复制出去，所以退回站点域名。 */
  function siteOrigin() {
    if (location.protocol === 'file:' ||
        /^(localhost|127\.|\[::1\])/.test(location.hostname)) return SITE_ORIGIN;
    return location.origin;
  }

  /* ⚠️ 分享出去的必须是 p/<id>.html，不能是 post.html?p=<id>。
     微信 / QQ 抓预览卡片时只看静态 HTML 里的 og 标签，不跑 JS ——
     post.html 是同一份文件、og:title 只能写一个通用的；
     p/<id>.html 是每篇一张、标题和摘要都写死在 <head> 里。
     万一那篇还没生成（刚在手机上发、本地还没重新发布过），
     404.html 会把它转回 post.html?p=<id>，链接不会断。 */
  function shareUrl(id) {
    return siteOrigin() + '/p/' + encodeURIComponent(id) + '.html';
  }

  /* 「分享本文」复制出去的正文：**一行**，形如
       文章标题-Ever Eternity的博客-https://…/p/<id>.html
     （2026-09-20 用户给的格式，照抄，别自作主张加空格或换行）。

     为什么带上标题和站点名：只给一个网址的话，粘到不抓卡片的地方
     （备忘录、短信、某些聊天工具、邮件）就只剩一串字符，看不出是哪一篇。
     标题用文章自己的 title，**不缀页面 <title> 里那个「 · Ever Eternity」**——
     站点名已经单独出现在中间那一段了，缀两遍重复。
     标题为空（理论上不该有）就退化成「站点名-链接」，别拼出个空标题。 */
  function shareText(post) {
    var title = String((post && post.title) || '').trim();
    var head = title ? title + '-' : '';
    return head + SITE_NAME + '的博客-' + shareUrl(post && post.id);
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
      copyText(shareText(post)).then(function () {
        toast('已复制标题和链接');
        // 按钮自己也变一下，光标不在提示条附近时也看得到反馈
        if (!label) return;
        label.textContent = '已复制';
        btn.classList.add('done');
        clearTimeout(resetTimer);
        resetTimer = setTimeout(function () {
          label.textContent = '分享本文';
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
        setTag(btn.getAttribute('data-tag'));
        render();
      });
    }

    /* 选中某个标签（'' = 全部）。按名字切，不按按钮对象 —— 这样从地址栏
       恢复状态时也能直接调，不必伪造一次 click。 */
    function setTag(t) {
      state.tag = t || '';
      if (!tagbarEl) return;
      Array.prototype.forEach.call(tagbarEl.children, function (b) {
        b.classList.toggle('on', b.getAttribute('data-tag') === state.tag);
      });
    }

    if (searchEl) {
      searchEl.addEventListener('input', function () {
        state.q = searchEl.value.trim().toLowerCase();
        render();
      });
    }

    /* 把当前的筛选状态写进地址栏。
       ⚠️ **这一步不能省**：`post.html` 上的「返回」走的是 `history.back()`，
          回到的是**地址栏里那个 URL**。不写的话：
            · 点标签按钮（URL 不带 ?tag=）→ 进文章 → 返回 = 标签白点了，回到全部
            · 搜索 → 进文章 → 返回 = 搜索框里字还在（浏览器会恢复表单值），
              但列表已经是全部 —— 界面在撒谎，最误导
          （2026-09-21 实测两个都踩到，所以有了这个函数。）

       用 `replaceState` 不用 `pushState`：pushState 会让每点一次标签就多一条历史，
       于是「返回」得按好几次才回得到文章。replaceState 只改当前这条，
       「返回」一步到位。顺带把 URL 变成可分享 / 可刷新的 —— 和全部文章页
       （archive.html?tag=xxx）保持同一套做法。 */
    function syncUrl() {
      var qs = [];
      if (state.tag) qs.push('tag=' + encodeURIComponent(state.tag));
      if (state.q) qs.push('q=' + encodeURIComponent(state.q));
      var url = location.pathname + (qs.length ? '?' + qs.join('&') : '') + location.hash;
      try { history.replaceState(null, '', url); } catch (e) { /* file:// 下可能受限 */ }
    }

    function match(p) {
      if (state.tag && (p.tags || []).indexOf(state.tag) === -1) return false;
      if (!state.q) return true;
      var hay = [p.title, p.lede || '', (p.tags || []).join(' '), p.content || '']
                  .join(' ').toLowerCase();
      return hay.indexOf(state.q) !== -1;
    }

    function render() {
      syncUrl();
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

    /* 从地址栏恢复筛选状态（?tag=xxx&q=xxx）。
       两个都要**先设进 state、再统一 render 一次** —— 分两次 render 的话，
       第一次 render 里的 syncUrl() 会把「还没恢复的那个参数」从地址栏抹掉。
       （首页带 ?tag= 的入口：文章页底部的标签胶囊，见 initPost 里的 post-tags） */
    var urlTag = param('tag');
    if (urlTag && tagbarEl &&
        tagbarEl.querySelector('.tag-btn[data-tag="' + urlTag.replace(/"/g, '\\"') + '"]')) {
      setTag(urlTag);
    }
    if (searchEl) {
      var urlQ = param('q');
      if (urlQ) searchEl.value = urlQ;
      // 浏览器恢复表单值时**不会触发 input 事件**，所以 state.q 必须自己再读一遍，
      // 否则「搜索 → 进文章 → 返回」会看到：搜索框里字还在、列表却是全部（踩过）
      state.q = searchEl.value.trim().toLowerCase();
    }

    render();
  }

  /* ---------- 文章页 ---------- */
  function initPost() {
    var bodyEl = $('#post-body');
    if (!bodyEl) return;

    var shown = visiblePosts();
    // 静态页（p/<id>.html）里写死了 id，优先用它；post.html 走 ?p=
    var id = STATIC_ID || param('p');
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
      note.innerHTML = '这篇还没公开 —— 它不会出现在首页、全部文章和标签里，' +
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

    // 正文底部的「分享本文」按钮。放在上一篇/下一篇之前 —— 读完正文就该看到它
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

  /* ---------- 全部文章页（文件仍然叫 archive.html，改文件名会断链） ---------- */
  function initArchive() {
    var el = $('#archive-list');
    if (!el) return;

    var stat = $('#archive-stat');
    var all = visiblePosts();

    /* 归档页的标签**留在归档页**：archive.html?tag=xxx
       （2026-09-21 用户要求）原来点标签是跳 index.html?tag=xxx，
       于是从「只有标题的年份列表」一下子跳到「带摘要的卡片流」，
       观感完全换了一套。归档就该一直长归档的样子。
       用查询参数而不是纯 JS 过滤：链接能分享、能刷新、能后退。 */
    var tag = param('tag') || '';
    var shown = tag
      ? all.filter(function (p) { return (p.tags || []).indexOf(tag) >= 0; })
      : all;

    /* 标签云**始终按全部可见文章**统计 —— 否则点进某个标签之后，
       云里只剩那一个标签，就再也换不了别的了。 */
    var cloud = $('#tag-cloud');
    if (cloud) {
      var t = allTags(all);
      var chips = '<a class="chip' + (tag ? '' : ' on') + '" href="archive.html">全部' +
                  '<span class="count">' + all.length + '</span></a>';
      chips += t.list.map(function (x) {
        return '<a class="chip' + (x === tag ? ' on' : '') +
               '" href="archive.html?tag=' + encodeURIComponent(x) + '">' +
               MD.escape(x) + '<span class="count">' + t.count[x] + '</span></a>';
      }).join('');
      cloud.innerHTML = chips;
    }

    if (!shown.length) {
      el.innerHTML = '<div class="empty">' +
        (tag ? '没有标签是「' + MD.escape(tag) + '」的文章。' : '还没有文章。') +
        '</div>';
      if (stat) {
        stat.textContent = tag ? '标签：' + tag + ' · 共 0 篇' : '共 0 篇';
      }
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
      if (tag) {
        // 按标签筛选时只报篇数：字数统计是给「整站有多少」用的，这里意义不大
        stat.textContent = '标签：' + tag + ' · 共 ' + shown.length + ' 篇';
      } else {
        var words = shown.reduce(function (n, p) {
          return n + String(p.content || '').replace(/\s+/g, '').length;
        }, 0);
        stat.textContent = '共 ' + shown.length + ' 篇 · 约 ' +
                           (words / 1000).toFixed(1) + ' 千字';
      }
    }
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
    initBack();
    setLoading();

    /* 列表页关掉浏览器自带的滚动恢复，改由我们自己记 / 自己还。
       只对列表页关 —— 别的页面（关于页之类）还是让浏览器自己恢复更省事。 */
    if (isListPage() && 'scrollRestoration' in history) {
      history.scrollRestoration = 'manual';
    }

    /* 点卡片进文章之前，先把当前位置记下来（卡片是动态渲染的，用事件委托） */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('.post-card, .arch-item')) rememberListPos();
    });

    /* 从 bfcache 回来时 DOMContentLoaded **不会再跑**，得单独补一刀，
       否则「后退」回来会停在顶部（列表还在，但滚动位置没人还）。 */
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) restoreListPos();
    });

    // 站点信息（首页介绍 / 关于页 / 页脚）是独立的，文章挂了也不该连累它
    if (window.SITE) {
      window.SITE.load().then(window.SITE.apply).catch(function (err) {
        console.warn('[app] 站点信息没读到，沿用页面里的静态内容', err);
      }).then(window.SITE.reveal, window.SITE.reveal);
      // ↑ 末了这一下是摘遮罩（.ee-site-pending）。**成功失败都得摘**，
      //   否则 <head> 里藏起来的那几块就一直不露出来了。
    }

    loadPosts().then(function (list) {
      POSTS = list;
      initIndex();     // 内部会从地址栏恢复 ?tag= / ?q=，并统一 render 一次
      initPost();
      initArchive();
      observeReveal();
      // ⚠️ 放在最后：等筛选状态和列表都定下来，再去还滚动位置 ——
      //    早还的话会被后面那次 innerHTML 把位置冲掉。
      restoreListPos();
    }).catch(showLoadError);
  });
})();
