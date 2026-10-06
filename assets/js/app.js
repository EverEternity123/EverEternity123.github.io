/* ==========================================================================
   app.js — 页面渲染与交互
   依赖：markdown.js
   数据：**两个**文件，都是写作台写完之后由发布脚本生成的：
     · data/index.json —— 列表页要的元数据（标题/日期/标签/摘要/字数…），**不含正文**
     · data/c/<id>.json —— 单篇文章的正文，只有文章页才去取
   全量的 data/posts.json 仍然在，但只在两处用：搜索时懒加载、以及上面两个
   拿不到时的兜底。正文占 posts.json 的九成体积，列表页一个字都用不上 ——
   这就是「首屏从 1MB 降到几十 KB」的全部原因。

   ⚠️ 改这里之前先记住：**任何一路拿不到，都必须能退回 posts.json**。
      首页开天窗比慢几秒严重得多。
   ========================================================================== */
(function () {
  'use strict';

  /* 全量（写作台写入的那个文件）—— 只当兜底和搜索索引 */
  var DATA_URL = 'data/posts.json';

  /* 列表页的数据源（发布时从 DATA_URL 生成） */
  var INDEX_URL = 'data/index.json';

  /* 单篇正文的目录（同上） */
  var CONTENT_DIR = 'data/c/';

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

  /* 全文索引（全量 posts.json，1MB）。
     列表页**默认不取** —— 只有用户真的要搜索时才去下（搜索要搜正文，
     而列表数据里只有元数据）。null = 还没开始取。 */
  var FULL_TEXT = null;
  var FULL_TEXT_DONE = false;

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

  /* 卡片上地方小，只写「约 N 分钟」。
     ⚠️ 入参是**文章对象**，不是正文字符串 —— 列表数据里只有预计算好的字数、
        没有正文（正文占整个文件的九成）。字数从哪来交给 wordsOf() 决定。 */
  function readingShort(p) {
    return '约 ' + MD.readingTimeFromChars(wordsOf(p)) + ' 分钟';
  }

  /* 文章页地方宽裕：先报字数，再报阅读时长。
     光写「约 N 分钟读完」看不出文章多长，前面垫一个字数就一眼有数了。
     ⚠️ 拼串在 markdown.js（MD.readingLabel）—— 写作台编辑页用的是**同一个函数**，
        这边别另写一份格式，否则编辑器里和文章页上会显示成两样。 */
  function readingLong(content) {
    return MD.readingLabel(content);
  }

  /* 「值得阅读程度」的打分（0–100），只有读书笔记有；没填就返回 null。
     ⚠️ 它是 posts.json 里的**独立字段**（写作台有一个「值得阅读程度」输入框，
        留空就不写这个键）—— **不从 AI 摘要里现抠正则**，摘要那一段是它自己的文字。
        列表数据（data/index.json）里也只有这个 `score`，没有 ai。
     ⚠️ null 和 0 是两回事：0 分也是合法分数，判「有没有」必须用 `!== null`。 */
  function scoreOf(p) {
    return typeof p.score === 'number' ? p.score : null;
  }

  /* 打分小胶囊。只有填了分数的文章才有，别的文章这一段根本不出现。 */
  function scoreBadge(p) {
    var n = scoreOf(p);
    if (n === null) return '';
    return '<span class="badge-score" title="' + SCORE_HINT + '">' +
           SCORE_LABEL + ' ' + n + '</span>';
  }

  /* 阅读时长那行文字的悬停说明 */
  var READING_HINT = '字数＝去掉代码块和空白后的正文字数；阅读时长按每分钟 350 字估算';
  /* 打分胶囊的悬停说明。分数是文章自己的一个字段（`score`），
     目前只有读书笔记填了 —— 别的文章压根没有这个胶囊。 */
  var SCORE_HINT = '值得阅读程度（满分 100）';
  /* 胶囊上的那两个字。**只在这里写一次**，卡片（scoreBadge）和归档（.arch-item .s）
     共用 —— 分头写两份迟早一个改了一个没改。
     主人 2026-10-05：「值得读」这三个字不好，换成「评分」。 */
  var SCORE_LABEL = '评分';

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

  /* ---------- 全文索引（搜索用，懒加载）---------- */

  /* 把全量 posts.json 里的正文补进 POSTS，之后 match() 就能搜到正文了。
     ⚠️ 只在用户真的要用搜索时才调 —— 正常浏览不该下这 1MB。
     ⚠️ 失败要把 FULL_TEXT 清回 null，否则一次网络抖动就永久搜不了正文了。 */
  function startFullText() {
    if (FULL_TEXT) return FULL_TEXT;
    FULL_TEXT = fetchJSON(DATA_URL).then(function (list) {
      if (!Array.isArray(list)) return false;
      var map = {};
      list.forEach(function (p) { if (p && p.id) map[p.id] = p; });
      POSTS.forEach(function (p) {
        var full = map[p.id];
        if (full && typeof full.content === 'string' && !p.content) p.content = full.content;
      });
      FULL_TEXT_DONE = true;
      return true;
    }).catch(function (err) {
      console.warn('[app] 全文没取到，搜索只能覆盖标题、标签和摘要', err);
      FULL_TEXT = null;
      return false;
    });
    return FULL_TEXT;
  }

  /* ---------- 数据加载 ---------- */

  /* ---------- 绕开 GitHub Pages 的 10 分钟缓存 ----------

     Pages 对**所有**文件都回 `Cache-Control: max-age=600`。所以就算用
     `cache:'no-cache'` 让浏览器去问，CDN 也会把自己那份旧副本直接给它 ——
     表现就是「写作台明明改完了，刷新还是老样子」。

     ⚠️⚠️ 这段注释以前写的是「唯一的办法是**让 URL 变**：带上一个参数」——
        **那个结论是错的**。2026-10-06 实测（`_preview/_probe-cdn-cache.py`）：
        **query 不进缓存键**，加 `?v=<时间戳>` 完全没用（两个全新参数拿到的是
        同一个缓存对象，`Age` 连续累加）。真正管用的是**让路径变**，
        见下面 `initSync()` 的注释和它调的 `syncVariantUrl()`。

     ⚠️ 那这里的 `bust()` 还有用吗？——**基本没有**，但留着不删：
        它在 URL 上挂 `?v=`，对缓存无效；可是**只要页面本身是变体路径**
        （`https://…///index.html`），这些**相对路径**就会自动继承变体，
        于是请求照样能 MISS 回源。也就是说「绕缓存」这件事现在由
        `initSync()` 的整页导航负责，`bust()` 只是历史遗留、不再承担职责。
        （大文件那条「只在点过同步之后才带戳」的省流量逻辑同样已失效，
          但保留着不会造成任何问题，改掉反而容易碰坏别的调用点。） */
  var SYNC_KEY = 'ee-sync';

  function syncStamp() {
    try { return sessionStorage.getItem(SYNC_KEY) || ''; } catch (e) { return ''; }
  }

  /* always=true  → 把路径换成一个**新变体**（必定回源，拿最新）；
     always=false → 只有页面本身已经是变体路径时才自然绕开，否则原样返回（吃缓存）。

     ⚠️ 这里用的就是上面说的「路径变体」：`data/index.json` → `data///index.json`。
        小文件（index.json 44KB / order.json 1.4KB / 单篇正文）**故意**每次都换变体，
        换来「写作台改完、刷新就能看到」—— 这点回源流量对个人博客完全值得。
     ⚠️⚠️ 但 `always=false` 那条**千万别**也改成路径变体：
        它服务的是 1MB 的 posts.json（只有点搜索才下），
        每次都回源会把「省流量」这件事彻底做反。 */
  function bust(url, always) {
    if (always) return bustPath(url);
    var v = syncStamp();
    if (!v) return url;
    return url + (url.indexOf('?') < 0 ? '?' : '&') + 'v=' + v;
  }

  /* 给路径中间塞进 3~202 个斜杠 —— CDN 会把它当成另一个文件，必 MISS 回源。
     ⚠️ 只能用「重复斜杠」：浏览器的 URL 规范化会吃掉 `/./` 和 `/../` 段，
        但空段（连续斜杠）会原样保留（实测见 `_preview/_probe-path-variants2.py`）。
     ⚠️ 斜杠必须加在**路径中间**，不能写成 `//data/…` —— 那是协议相对 URL。
     ⚠️ 斜杠数量要和 `syncVariantUrl()` 对齐（那边拼完整 URL 时前面还会多一个
        `/`，所以那边是 `2 + …`，这里直接就是 `3 + …`，两边最终都是 3~202 个）。 */
  function bustPath(url) {
    var m = url.lastIndexOf('/');
    if (m < 0) return url;
    var n = 3 + (Date.now() % 200);
    return url.slice(0, m) + new Array(n + 1).join('/') + url.slice(m + 1);
  }

  function fetchJSON(url, fresh) {
    return fetch(bust(url, fresh), { cache: 'no-cache' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  /* 列表数据：优先用生成的 index.json（只有元数据，几十 KB）；
     拿不到就退回全量 posts.json —— 慢，但页面不会开天窗。
     ⚠️ 这个兜底是有意留的：万一 index.json 没生成 / 没部署上去，
        站点必须还能正常用，只是慢回原来的样子。 */
  function fetchPosts() {
    return fetchJSON(INDEX_URL, true).catch(function (err) {
      console.warn('[app] data/index.json 没拿到，退回全量 posts.json', err);
      return fetchJSON(DATA_URL, true);
    });
  }

  function loadPosts() {
    return Promise.all([
      fetchPosts(),
      // order.json 是可选的第二个请求：读不到、404、解析失败 —— 一律当成「没排过序」
      fetch(bust(ORDER_URL, true), { cache: 'no-cache' })
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

  /* 一篇文章有多少字。
     index.json 里是生成时算好的 `words`；退回全量 posts.json 时没有这个字段，
     就照旧现算 —— 两边口径一样（都走 markdown.js 的 charCount）。 */
  function wordsOf(p) {
    if (typeof p.words === 'number') return p.words;
    return MD.charCount(p.content);
  }

  /* ---------- 文章正文按需加载 ---------- */

  /* 当前这一页要显示的那篇（列表页没有 #post-body，直接返回 null） */
  function currentPost() {
    if (!$('#post-body')) return null;
    var id = STATIC_ID || param('p');
    var shown = visiblePosts();
    return id ? byId(id) : (shown[0] || POSTS[0]);
  }

  /* 把正文补进 post 对象。
     ⚠️ 补完之后**下游渲染逻辑一个字都不用改** —— initPost / initAiIntro
        拿到的还是同一个对象，只是 content / ai 从「本来就在」变成「刚取回来」。 */
  function applyContent(post, d) {
    if (!d) return false;
    post.content = d.content || '';
    if (d.ai) post.ai = d.ai;
    if (d.aiOff === true) post.aiOff = true;
    return true;
  }

  /* 兜底：从全量 posts.json 里捞出这一篇的正文。
     两种情况会走到这儿：① data/c/ 还没生成（部署漏了一步）
     ② 手上这份是老的 posts.json（正文还内联在列表数据里）。 */
  function fetchFullPost(post) {
    return fetchJSON(DATA_URL, true).then(function (list) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === post.id) {
          applyContent(post, list[i]);
          return;
        }
      }
    }).catch(function () { /* 兜底也失败就算了，正文会是空的 */ });
  }

  /* 文章页专用：进渲染之前先把这一篇的正文取回来。
     ⚠️ 只在「列表数据里没有正文」时才发请求 —— 退回全量 posts.json 的情况下
        content 本来就在，不会白白多打一次。 */
  function preloadPostContent() {
    var post = currentPost();
    if (!post || post.content) return Promise.resolve();
    return fetchJSON(CONTENT_DIR + encodeURIComponent(post.id) + '.json', true)
      .then(function (d) { return applyContent(post, d) ? null : fetchFullPost(post); })
      .catch(function (err) {
        console.warn('[app] 单篇正文没拿到，退回全量', err);
        return fetchFullPost(post);
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

    /* 作者：只有不是站主时才显示，免得每张卡片重复同一个名字。
       站主自己写的改标「原创」—— 两者互斥，卡片上不会同时出现。 */
    var who = (p.author && p.author !== DEFAULT_AUTHOR)
      ? '<span class="byline">' + MD.escape(p.author) + '</span>'
      : (isOriginal(p) ? '<span class="badge-original">原创</span>' : '');

    /* ⚠️ 顺序是主人 2026-10-05 定的：**日期 · 作者 · 阅读时长 · 标签 · 评分**。
       原来把评分插在阅读时长后面、作者和标签前面，看着很乱。
       **评分永远排最后** —— 它是这张卡片上唯一「结论性」的东西。
       用数组拼再 join 分隔点：少一个字段就少一个点，
       手写一堆 `'<span class="dot">'` 很容易在某个分支上多出来或漏掉。 */
    var bits = [
      '<time datetime="' + p.date + '">' + fmtDate(p.date, 'long') + '</time>'
    ];
    if (who) bits.push(who);
    bits.push('<span title="' + READING_HINT + '">' + readingShort(p) + '</span>');
    if (tags) bits.push(tags);
    var score = scoreBadge(p);
    if (score) bits.push(score);

    return '' +
      '<a class="post-card reveal" href="' + postUrl(p.id) + '">' +
        '<h3>' + MD.escape(p.title) + '</h3>' +
        '<p class="excerpt">' + MD.escape(p.lede || p.excerpt || '') + '</p>' +
        '<div class="post-meta">' + bits.join('<span class="dot"></span>') + '</div>' +
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

  /* ---------- 「同步最新」按钮 ----------
     ⚠️⚠️ 这个按钮以前是「加一个 ?v=<时间戳> 重新进当前页」，**那是错的**。
        2026-10-06 用 `_preview/_probe-cdn-cache.py` 实测了 GitHub Pages 的 CDN：
          · 所有文件都回 `Cache-Control: max-age=600`；
          · **query 不进缓存键** —— 拿两个全新的参数
            `?probeA=<戳>` / `?probeB=<戳>` 交替请求，
            返回的是**同一个缓存对象**（`Age` 一路 455→456→457→458 连续累加），
            `X-Cache` 全程 HIT；
          · 连**请求头** `Cache-Control: no-cache`（= 浏览器硬刷新 Ctrl+F5）、
            `max-age=0`、`Pragma: no-cache`、`no-store` 也全部 HIT。
        结论：**加参数没用，硬刷新也没用** —— 这就是主人说的
        「按完还是旧的，要等十分钟」的真正原因（等够 600 秒缓存过期才行）。

     ✅ 真正有效的是**让路径本身变**。CDN 的缓存键是**整个路径字符串**：
        `/data/index.json`、`/data//index.json`、`/data///index.json`
        在它眼里是三个不同的对象，每个的第一次请求都必然 MISS 回源 → 拿到最新。
        （实测 `_preview/_probe-path-variants.py`：`/data//index.json` 回
          `X-Cache: MISS`、`Age: 0`；而 `/data/index.json` 回 HIT、`Age: 485`。）

     ⚠️ 为什么用「重复斜杠」而不是 `/./` 或 `/../`：
        浏览器的 URL 规范化会**吃掉** `.` 和 `..` 段，但**空段（连续斜杠）原样保留**。
        实测（`_preview/_probe-path-variants2.py` D2）：
          `new URL('…/data/./index.json').pathname` → `/data/index.json`（被吃）
          `new URL('…/data//index.json').pathname` → `/data//index.json`（保留）
        连 `fetch('/data//index.json')` 实际发出的 request URL 都是原样的。
     ⚠️ 斜杠必须加在**路径中间**（`origin + '/' + slashes + path`）。
        写成 `//x.html` 会被浏览器当成**协议相对 URL**（host 变成 x.html），彻底跑偏。
     ⚠️ 变体自己也会被缓存（实测 Age 同样会累加），所以斜杠数量**每次都得不一样**。
        这里用 `Date.now() % 200 + 2`：2~201 个斜杠，200 毫秒内连点两次才会撞上。

     ✅ 附带好处：导航过去之后，页面里所有**相对路径**（`assets/js/app.js`、
        `data/index.json`、`data/c/<id>.json`…）都会**自动继承**这段变体路径，
        于是一次点击把 HTML / CSS / JS / 数据**全部**刷新，不用逐个处理。
        （`bust()` 里那个 `?v=` 因此其实不起作用，留着只是为了不改动别处；
          真正管用的是路径变体。） */
  function initSync() {
    var btn = $('.sync-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      // 保留这个标记：bust(url, false) 靠它决定大文件要不要绕（见上面 bust()）
      try { sessionStorage.setItem(SYNC_KEY, String(Date.now())); } catch (e) { /* ignore */ }
      btn.classList.add('is-busy');
      btn.disabled = true;
      location.replace(syncVariantUrl());
    });
  }

  /* 当前页面的一份「路径带重复斜杠」的副本 —— CDN 当成另一个文件，回源取新的。
     ⚠️ 斜杠数量每次不同（见上面 initSync 的注释），否则第二次点就命中缓存了。 */
  function syncVariantUrl() {
    // ⚠️ file:// 打开时 location.origin 是字符串 "null"，拼出来的地址是坏的。
    //    绕 CDN 缓存只对线上有意义 → 本地原样重载就行（项目硬约束：
    //    双击 write.html 必须能用，别让这个按钮把它弄坏）。
    if (!/^https?:$/.test(location.protocol)) return location.href;
    var slashes = new Array(2 + (Date.now() % 200) + 1).join('/');
    // 去掉 pathname 开头已有的斜杠，免得反复点越滚越长
    var path = location.pathname.replace(/^\/+/, '');
    return location.origin + '/' + slashes + path + location.search + location.hash;
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
       文章标题 - Ever Eternity的博客 - https://…/p/<id>.html
     格式是用户 2026-09-20 给的（三段用连字符连成一行）；
     2026-10-04 用户要求**连字符两边各加一个空格**，读起来不再挤成一坨。

     为什么带上标题和站点名：只给一个网址的话，粘到不抓卡片的地方
     （备忘录、短信、某些聊天工具、邮件）就只剩一串字符，看不出是哪一篇。
     标题用文章自己的 title，**不缀页面 <title> 里那个「 · Ever Eternity」**——
     站点名已经单独出现在中间那一段了，缀两遍重复。
     标题为空（理论上不该有）就退化成「站点名 - 链接」，别拼出个空标题。 */
  function shareText(post) {
    var title = String((post && post.title) || '').trim();
    var head = title ? title + ' - ' : '';
    return head + SITE_NAME + '的博客 - ' + shareUrl(post && post.id);
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

  /* 「分享本文」有两个：顶部按钮行里的 #btn-share-top，和正文底部的 #btn-share。
     两个共用这一份逻辑 —— 都靠 data-share 标记，别在别处再写一份复制代码。 */
  function initShare(post) {
    if (!post) return;
    var btns = document.querySelectorAll('[data-share]');
    if (!btns.length) return;

    var box = $('#post-share');

    for (var i = 0; i < btns.length; i++) {
      (function (btn) {
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
      })(btns[i]);
    }

    /* 底部那个整块默认 hidden（顶部那个不用 —— 它跟按钮行一起被 initAiIntro 放出来）。
       ⚠️ 页面加载失败时谁都别露出来，所以这里的 hidden 是「找到文章才放开」。 */
    if (box) box.hidden = false;
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
      /* ⚠️ 列表数据里没有正文，而搜索是要搜正文的（输入框占位符也这么写着）。
         所以**等用户真的要搜了**才去取全量 —— 正常浏览一个字都不下。
         焦点一到就开始取（比等按键再早一点），取回来自动重搜一次。 */
      searchEl.addEventListener('focus', startFullText);
      searchEl.addEventListener('input', function () {
        state.q = searchEl.value.trim().toLowerCase();
        render();
        if (state.q && !FULL_TEXT_DONE) {
          startFullText().then(function (ok) { if (ok) render(); });
        }
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
        // 正在取全文时多说一句：不然用户会以为「就是没有」，其实正文还没到
        var pending = state.q && !FULL_TEXT_DONE ? '（正文正在加载，好了会自动再搜一遍）' : '';
        listEl.innerHTML = shown.length
          ? '<div class="empty">没有找到相关的文章。' + pending + '</div>'
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
       （带 ?tag= 的入口：首页标签栏、archive.html 的标签云。文章页底部那排
         标签胶囊 2026-10-04 已撤掉，所以这条现在只服务前两个。） */
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

    /* ⚠️ 从地址栏恢复出来的搜索词，也得去把正文取回来 —— 列表数据（data/index.json）
       里**没有正文**，全文搜索要另外下 posts.json。而「搜索 → 进文章 → 返回」这条路
       上，搜索框的 focus / input 事件**一次都不会触发**（值是浏览器填的），
       不补这一下就永远只匹配标题和标签，条数比第一次搜少。
       verify-back.py 抓到的就是它：搜「炒股」第一次 9 条，返回后只剩 7 条。 */
    if (state.q && !FULL_TEXT_DONE) {
      startFullText().then(function (ok) { if (ok) render(); });
    }
  }

  /* ---------- 文章页 ---------- */
  /* AI 摘要与评价（折叠块，**默认收起**）+ 查看原文（外链按钮）。
     ⚠️ 2026-10-06 起**走 MD.render 渲染 Markdown**（主人报：摘要在写作台里写了
        `**粗体**`，文章页上星号却原样露出来了 —— 那篇是《全球视野下的投资机会》）。
        之前是 textContent + white-space:pre-wrap 的纯文本，改的原因就是主人要在
        摘要里用 Markdown。踩过的坑与仍然成立的两条：
        · XSS 照样挡得住 —— MD.render 内部**先 esc() 再解析**（见 markdown.js），
          `<script>` 会被转义成文本。**别因为「要渲染 Markdown」就自己拼 HTML**。
        · ⚠️ 一旦走 MD.render，CSS 那边**必须**去掉 white-space:pre-wrap ——
          分段现在由 <p> 负责，留着 pre-wrap 会把 <p> 之间的换行也显示成空行。
          对应样式在 style.css 的 .ai-intro-inner 里（2026-10-06 一起加的）。
        · 摘要里的 `[链接](url)` 是**主人自己写的**，所以放开渲染是安全的；
          它跟正文共用同一个渲染器，行为一致，别再单独写一套。
     展开动画在 CSS 里（.ai-intro-body 的 grid-template-rows 0fr↔1fr），
     这里只负责翻 class 和 aria —— **别再往 body 上挂 hidden**，
     display:none 会把过渡整个掐掉，点了就是「啪」一下出来。
     「查看原文」（post.source）2026-10-04 从正文首行挪到这里，和折叠按钮并排；
     同一排还有个「分享本文」（2026-10-04 加的，两个按钮共用 initShare()）。
     ⚠️ 正因为分享按钮**每篇都要有**，这里不能再「都没内容就整块 remove()」——
     容器只负责「有文章就显示」，去留交给各个按钮自己决定。 */
  function initAiIntro(post) {
    var box = $('#ai-intro');
    if (!box) return;

    // 没文字、或者写作台里把开关关掉了（aiOff）→ 不显示 AI 那块
    // （跟 #post-lede 为空就 remove() 是同一个做法）
    var text = (post.ai || '').trim();
    var showAi = !!text && post.aiOff !== true;
    var src = (post.source || '').trim();
    // 原文被作者删了。这些文章可能连地址都没了，所以它是个**独立**标记 ——
    // 不能写成「有 source 才可能有 sourceGone」。
    var gone = post.sourceGone === true;

    var btn = $('#ai-toggle');
    var inner = $('#ai-intro-inner');
    var srcEl = $('#post-source');

    if (showAi && inner) {
      // 见函数头注释：2026-10-06 起走 MD.render（支持 **粗体** / *斜体* / 列表 / 链接…）。
      // XSS 由 MD.render 内部的 esc() 挡，别改成拼字符串。
      inner.innerHTML = MD.render(text);
      if (btn) {
        btn.addEventListener('click', function () {
          var open = btn.getAttribute('aria-expanded') === 'true';
          btn.setAttribute('aria-expanded', open ? 'false' : 'true');
          box.classList.toggle('open', !open);
        });
      }
    } else if (btn) {
      /* 没有 AI 文字（或写作台关了开关）→ 把折叠按钮整个拿掉，只留「查看原文」/「分享本文」。
         inner 取不到 = p/<id>.html 是 build-posts.py 拿 post.html 当壳生成的，
         壳一旦落后于 post.html 就缺这一层 —— 实测过一个 TypeError 会把整篇文章页
         干掉、变成「文章加载失败」。所以宁可少一块，也不能让这一行把页面带走。 */
      btn.remove();
    }

    if (srcEl) {
      if (!src && !gone) {
        srcEl.remove();          // 既没链接、也没「已删除」标记 → 按钮不出现
      } else {
        srcEl.hidden = false;    // HTML 里默认 hidden，确认有内容才放出来
        if (src) srcEl.href = src;
        else srcEl.removeAttribute('href');   // 地址都没了：按钮只负责弹提示
        /* 原文已经删掉的那些：按钮照样显示（好让人知道这篇是有出处的），
           但点了不跳转 —— 与其让人跳过去看一个 404，不如当场说清楚。
           提示用的就是「已复制标题和链接」那条 toast，样式一致。 */
        if (gone) {
          srcEl.addEventListener('click', function (e) {
            e.preventDefault();
            toast('原文已删除');
          });
        }
      }
    }

    /* 这一行里还有「分享本文」（每篇都有），所以容器永远要放出来 ——
       AI 和原文链接都没有时，这一行就只剩一个分享按钮。 */
    box.hidden = false;
  }

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

    // AI 摘要与评价 + 查看原文 + 分享本文（同一排按钮，见 initAiIntro）
    initAiIntro(post);

    /* 文章页底部的标签栏 2026-10-04 按主人要求撤掉了（post.html 里那个 #post-tags
       和它的样式一起删的）。数据里的 tags 没动 —— 首页标签栏、archive.html 的
       标签云、筛选都还在用，只是文章页不再列出来。 */

    // 「分享本文」：顶部按钮行和正文底部各一个，共用 initShare()
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
        /* 作者 2026-10-04 加的（主人要求「每篇文章后面加上作者」）。
           ⚠️ 这里跟首页卡片**不一样**：卡片是「跟默认署名不一样才显示作者」，
              归档是**每篇都显示** —— 主人要的就是每行都能看到署名。
              所以直接用 authorOf()（它自己会兜底默认作者），别用 isOriginal() 过滤。 */
        /* 「值得阅读程度」的打分（只有书籍类文章有，2026-10-05 主人要求）。
           ⚠️ 放在标题和作者之间：`.s` 自己吃 `margin-left:auto` 把这一行剩下的
              空间全占掉，于是「作者」还在最右边、分数紧挨着它 —— 一列扫下来
              能直接比大小。没有分数的行不受影响（`.s + .a` 那条 CSS 只在有分数时生效）。 */
        var sc = scoreOf(p);
        return '<a class="arch-item" href="' + postUrl(p.id) + '">' +
                 '<time datetime="' + p.date + '">' + fmtDate(p.date) + '</time>' +
                 '<span class="t">' + MD.escape(p.title) + '</span>' +
                 (sc === null ? '' :
                   '<span class="s" title="' + SCORE_HINT + '">' +
                   SCORE_LABEL + ' ' + sc + '</span>') +
                 '<span class="a">' + MD.escape(authorOf(p)) + '</span>' +
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
        var words = shown.reduce(function (n, p) { return n + wordsOf(p); }, 0);
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
    initSync();
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
      initArchive();
      /* ⚠️ 文章页要**先把正文取回来**再渲染 —— 列表数据里只有元数据。
         列表页这一步立刻返回（没有 #post-body），所以列表不会多等。 */
      return preloadPostContent();
    }).then(function () {
      initPost();
      observeReveal();
      // ⚠️ 放在最后：等筛选状态和列表都定下来，再去还滚动位置 ——
      //    早还的话会被后面那次 innerHTML 把位置冲掉。
      restoreListPos();
    }).catch(showLoadError);
  });
})();
