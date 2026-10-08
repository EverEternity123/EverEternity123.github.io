/* ==========================================================================
   admin.js — 写作台逻辑（纯前端，直接读写 GitHub 仓库）
   依赖：markdown.js、write.config.js
   保存 = 向仓库提交一次 commit，托管平台随后自动重新部署

   令牌存在本设备的 localStorage 里（键 ee-gh-token），不经过任何服务器。
   它等同于这个仓库的写权限，所以别分享给别人。
   ========================================================================== */
(function () {
  'use strict';

  var CFG = window.BLOG_CONFIG || {};
  var API = 'https://api.github.com';
  var TOKEN_KEY = 'ee-gh-token';
  var DRAFT_PREFIX = 'ee-draft:';
  var MAX_TAG_LEN = 24;      // 单个标签最长几个字（编辑页、批量编辑、标签总览共用）
  var MAX_TAGS = 8;          // 一篇文章最多几个标签

  /* 插入图片。上传前一律在浏览器里重压一遍：
     手机随手拍一张 3~5MB，原样塞进仓库会让每次部署都变慢，
     写作台那点上行带宽也传得难受。压到长边 1600px、JPEG q=0.82，
     一般 150~400KB —— 手机上看着完全够。 */
  var IMG_DIR = 'assets/img/post';
  var IMG_MAX_EDGE = 1600;                 // 长边上限（像素）
  var IMG_QUALITY = 0.82;
  var IMG_MAX_BYTES = 12 * 1024 * 1024;    // 原图超过这个直接拒，别让浏览器卡死

  var $ = function (s) { return document.querySelector(s); };

  var state = {
    token: '',
    user: '',
    sha: null,        // 当前 posts.json 的 blob sha，提交时必须带上
    posts: [],        // 按**显示顺序**排好的文章（自定义顺序 + 新文章按日期插入）
    editing: null,
    original: null,
    isNew: true,
    filterTag: '',    // 列表页当前选中的标签，'' = 全部
    q: '',            // 列表页的搜索词（已转小写），'' = 不搜
    previewId: '',    // 列表里展开了「预览」的那一篇的 id，'' = 都没展开
    site: null,       // data/site.json 的内容（首页介绍 / 关于页 / 页脚）
    siteSha: null,    // site.json 的 blob sha，提交时必须带上
    order: { ids: [], tags: [] }, // data/order.json 的内容：文章顺序 + 标签顺序
    orderSha: null,     // order.json 的 blob sha，提交时必须带上
    tagOrder: [],       // 标签的当前先后（= order.tags，拖完立刻改它）
    batch: false,       // 是否处于「批量编辑」模式（排序 + 改标签 + 隐藏）
    batchBaseline: null,// 进入那一刻的顺序快照，用来判断文章顺序有没有动过
    batchBaselineTags: [], // 进入那一刻的标签顺序快照
    batchSnapshot: null,// 进入那一刻的文章深拷贝，取消时用它整体回滚
    tagEdit: null       // 标签总览那一屏的初始内容 [{from, to}]
  };

  /* ======================================================================
     小工具
     ====================================================================== */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3400);
  }

  function show(view) {
    ['connect', 'list', 'edit', 'site', 'tags', 'drafts'].forEach(function (v) {
      $('#view-' + v).hidden = (v !== view);
    });
    window.scrollTo(0, 0);
  }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  }

  function fmtDate(iso) {
    var p = String(iso || '').split('-');
    return p.length < 3 ? (iso || '') : p[0] + '.' + p[1] + '.' + p[2];
  }

  function byDateDesc(a, b) { return String(b.date).localeCompare(String(a.date)); }

  /* UTF-8 ↔ base64（GitHub Contents API 用 base64 传内容，中文必须正确处理） */
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str);
    var chunk = 0x8000, parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return btoa(parts.join(''));
  }

  function b64decode(b64) {
    var bin = atob(String(b64 || '').replace(/[\r\n\s]/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  /* ======================================================================
     GitHub API
     ====================================================================== */

  function ghError(status, data) {
    var msg = (data && data.message) || '';
    if (status === 401) return '令牌无效或已过期，请重新生成一个';
    if (status === 403) return '权限不足，或触发了 GitHub 限流：' + msg;
    if (status === 404) {
      return '找不到仓库或文件。请检查 write.config.js 里的 owner / repo / path，' +
             '以及令牌是否勾选了这个仓库、Contents 权限是否为 Read and write';
    }
    if (status === 409) return '文件在别处被改过了，请点「刷新」重新读取后再保存';
    if (status === 422) return '提交被拒绝：' + msg;
    return 'GitHub 返回 ' + status + (msg ? '：' + msg : '');
  }

  function gh(path, options) {
    options = options || {};
    var headers = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    if (options.body) headers['Content-Type'] = 'application/json';

    return fetch(API + path, {
      method: options.method || 'GET',
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!res.ok) {
          var err = new Error(ghError(res.status, data));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* 文件文本 → 对象。解析失败时给一句人话，
     别把 `Unexpected end of JSON input` 这种原生报错直接甩给用户。 */
  function parseFileJson(text, name) {
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(name + ' 的内容不是有效的 JSON（读到 ' + text.length +
                      ' 个字符）。先确认文件没被改坏，再点「刷新」重试。');
    }
  }

  /* 仓库里任意一个文件的 Contents API 地址 */
  function contentsPathOf(p) {
    return '/repos/' + encodeURIComponent(CFG.owner) + '/' +
           encodeURIComponent(CFG.repo) + '/contents/' +
           String(p || '').split('/').map(encodeURIComponent).join('/');
  }

  /* 读文件的**原文**（raw 媒体类型）。
     ⚠️ 为什么需要它：Contents API 只对 **≤1MB** 的文件内联返回内容 ——
        更大的文件会返回 `"content": ""` + `"encoding": "none"`。
        这时候必须换 `Accept: application/vnd.github.raw` 再要一次，
        它直接给文件原文（支持到 100MB，也不用 base64 解码）。
     2026-10-05 踩到：posts.json 涨到 1.07MB 后写作台**登不进去**，
        报的是 `Unexpected end of JSON input`（`JSON.parse("")` 抛的），
        看着像令牌坏了，其实是文件越过了 1MB 这道坎。
     ⚠️ 这不是「偶发故障」，别靠重试解决 —— 文件一旦过线，每次都会这样。
     ⚠️ raw 不返回 sha，所以 sha 仍然要从 Contents API 拿（见 ghTextFile）。 */
  function ghRaw(path, ref) {
    var headers = { 'Accept': 'application/vnd.github.raw' };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    var url = API + path;
    if (ref) url += (url.indexOf('?') >= 0 ? '&' : '?') + 'ref=' + encodeURIComponent(ref);

    return fetch(url, { headers: headers, cache: 'no-store' }).then(function (res) {
      return res.text().then(function (text) {
        if (res.ok) return text;
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        var err = new Error(ghError(res.status, data));
        err.status = res.status;
        throw err;
      });
    });
  }

  /* 读仓库里的一个文本文件 → { sha, text }。
     ≤1MB 走 Contents API 一次搞定；超过 1MB 时它不给内容，补一次 raw 请求。
     ⚠️ 别把这两条路合成「一律走 raw」—— raw 不返回 sha，
        而保存时要用 sha 做乐观锁（防止覆盖别处的改动）。
     ⚠️⚠️ 判「有没有内联内容」**必须看 `content` 的长度，不能看类型**：
        >1MB 时 GitHub 返回的是 `"content": ""`（**空字符串，不是 null**），
        而 `typeof "" === 'string'` 恒为 true —— 2026-10-05 就栽在这上面：
        兜底分支写了却永远进不去，`JSON.parse('')` 照样抛
        `Unexpected end of JSON input`，看着像令牌失效。 */
  function ghTextFile(path, ref) {
    var branch = ref || CFG.branch || 'main';
    return gh(contentsPathOf(path) + '?ref=' + encodeURIComponent(branch))
      .then(function (data) {
        if (!data) throw new Error('文件读取失败：仓库没有返回内容');
        var inline = typeof data.content === 'string' && data.content.length > 0;
        if (inline && data.encoding !== 'none') {
          return { sha: data.sha, text: b64decode(data.content) };
        }
        // 没内联内容（>1MB）：换 raw 媒体类型再要一次，它给文件原文
        return ghRaw(contentsPathOf(path), branch).then(function (text) {
          return { sha: data.sha, text: text };
        });
      });
  }

  function contentsPath() {
    return contentsPathOf(CFG.path);
  }

  function sitePath() {
    return CFG.sitePath || 'data/site.json';
  }

  function orderPath() {
    return CFG.orderPath || 'data/order.json';
  }

  /* ======================================================================
     显示顺序（文章 + 标签）
     ----------------------------------------------------------------------
     真正的规则在 assets/js/order.js（前台也用它），这里只负责取数据。
     一句话：在 order.json 里的文章按列表顺序排，不在里面的（＝新发的）
     按日期插进对应的位置（不是一律顶到最前面）。标签同理，没记过的排在后面。
     ====================================================================== */

  /* order.json 的**原文** → { ids: [...], tags: [...] }。
     文件坏掉就当没排过序，不阻断列表；老文件没有 tags 字段也一样。 */
  function parseOrder(text) {
    var empty = { ids: [], tags: [] };
    try {
      var obj = JSON.parse(text);
      if (!window.EE_ORDER) return empty;
      return { ids: window.EE_ORDER.idsOf(obj), tags: window.EE_ORDER.tagsOf(obj) };
    } catch (e) {
      return empty;
    }
  }

  /* 把一组文章按 state.order 排好 */
  function applyOrder(list) {
    var ord = window.EE_ORDER;
    if (!ord) return list.slice().sort(byDateDesc);
    return ord.apply(list, (state.order && state.order.ids) || []);
  }

  /* 当前显示顺序对应的 id 列表 */
  function currentIds() {
    if (window.EE_ORDER) return window.EE_ORDER.idsFrom(state.posts);
    return state.posts.map(function (p) { return p.id; });
  }

  /* 标签的当前先后（没记过的按「出现次数多的在前」，跟以前一样）。
     首页标签栏、归档标签云、写作台这一条筛选栏都用这个顺序。 */
  function tagOrderList() {
    var st = tagStats(state.posts);
    if (window.EE_ORDER) return window.EE_ORDER.sortTags(st.list, state.tagOrder || []);
    return st.list;
  }

  function tagOrderDirty() {
    return (state.tagOrder || []).join('\u0000') !==
           (state.batchBaselineTags || []).join('\u0000');
  }

  /* 批量编辑模式下：跟进入时的快照比，有没有动过
     （文章顺序 / 标签顺序 / 标签 / 隐藏，四样都算） */
  function batchDirty() {
    var c = batchChanges();
    return c.order || c.tagOrder || c.tags.length > 0 || c.hidden.length > 0;
  }

  function loadPosts() {
    var ref = CFG.branch || 'main';
    return Promise.all([
      /* ⚠️ 走 ghTextFile 而不是 gh：posts.json 一旦超过 1MB，Contents API 就不给
         内联内容了，必须由它自动补一次 raw 请求（2026-10-05 踩到）。 */
      ghTextFile(CFG.path, ref),
      // order.json 是后加的文件，老仓库里可能还没有 —— 404 当成「没排过序」
      ghTextFile(orderPath(), ref).catch(function (e) {
        if (e.status === 404) return null;
        throw e;
      })
    ]).then(function (both) {
      var data = both[0], odata = both[1];
      state.sha = data.sha;
      var list = parseFileJson(data.text, 'posts.json');
      if (!Array.isArray(list)) throw new Error('posts.json 格式不对：顶层应该是数组');

      state.orderSha = odata ? odata.sha : null;
      state.order = odata ? parseOrder(odata.text) : { ids: [], tags: [] };
      state.tagOrder = state.order.tags.slice();
      state.posts = applyOrder(list);
    }).catch(function (err) {
      // 文件还不存在（第一次用）：允许从空列表开始，保存时会创建它
      if (err.status === 404) {
        state.sha = null;
        state.posts = [];
        return;
      }
      throw err;
    });
  }

  function commit(message) {
    var json = JSON.stringify(state.posts.slice().sort(byDateDesc), null, 2) + '\n';
    var body = {
      message: message,
      content: b64encode(json),
      branch: CFG.branch || 'main'
    };
    if (state.sha) body.sha = state.sha;

    return gh(contentsPath(), { method: 'PUT', body: body }).then(function (data) {
      if (data && data.content && data.content.sha) state.sha = data.content.sha;
      // 写进仓库的永远是「按日期降序」（posts.json 只管内容）；
      // 内存里这份要恢复成显示顺序 —— 新文章没进 order.json，会自动排到最前面
      state.posts = applyOrder(state.posts);
      return data;
    });
  }

  /* ======================================================================
     产物：data/index.json（列表页用）+ data/c/<id>.json（文章页用）
     ======================================================================
     ⚠️⚠️ 为什么写作台也得管这两个文件：
        它们平时是 `.tools/build-index.py` 在**电脑上发布时**生成的「产物」。
        但主人主要在**手机上**发文 / 改文 —— 写作台保存只改 data/posts.json 的话，
        产物不会跟着更新，于是：
          · 文章页（读 data/c/<id>.json）还是**旧正文**；
          · 列表页（读 data/index.json）还是旧标题 / 旧摘要 / 旧阅读时长。
        而且**刷新永远刷不出来** —— 数据源本身就是旧的，不是缓存问题。
        2026-10-06 主人报的「改了《全球视野下的投资机会》，网页没变」就是这个：
        线上 posts.json 已经是新正文（7495 字），data/c/p-mutvv133.json 还是旧的（7806 字）。
     ⚠️ 结构必须和 build-index.py **完全一致**（那边有 `--selfcheck` 拿 node 对着 JS 比）。
        改任何一边都要同时改另一边：
          · index.json 一行 = 该篇**除 content / ai 之外的所有键**
                            + excerpt（lede 优先，否则正文前 92 字）+ words（charCount）
          · data/c/<id>.json = { id, content }（ai / aiOff 有才写）
     ⚠️ excerpt 的 limit 是 **92**（build-index.py 的 EXCERPT_LIMIT）——
        MD.excerpt() 自己的默认值是 88，**必须显式传 92**，不然卡片摘要会跟以前不一样。
     ⚠️ 三个文件是**三次提交**（Contents API 一次只能写一个文件）。顺序：
        posts.json（唯一真源，先写，保证主人的改动一定落盘）→ 两个产物。
        产物写失败只会让页面慢一拍，不会丢内容；界面会提示「请再点一次保存」。
     ⚠️⚠️ **这三个写必须串行，一次只能有一个在飞**。原因见 syncArtifacts
        上面的注释：GitHub 对同分支并发写会 409。 */
  var EXCERPT_LIMIT = 92;

  function jsonText(obj) {
    // 和 build-index.py 的 _write_json 一致：indent=2 + ensure_ascii=False + 末尾换行
    return JSON.stringify(obj, null, 2) + '\n';
  }

  function indexRowOf(p) {
    var row = {};
    Object.keys(p).forEach(function (k) {
      if (k === 'content' || k === 'ai') return;   // 正文不进列表
      row[k] = p[k];
    });
    row.excerpt = p.lede || MD.excerpt(p.content || '', EXCERPT_LIMIT);
    row.words = MD.charCount(p.content || '');
    return row;
  }

  function postBodyOf(p) {
    var body = { id: p.id, content: p.content || '' };
    if (p.ai) body.ai = p.ai;
    if (p.aiOff === true) body.aiOff = true;
    return body;
  }

  /* 写一个文本文件（Contents API）。文件还不存在时 sha 传 null → 直接创建。 */
  function putTextFile(path, text, message, sha) {
    var body = {
      message: message,
      content: b64encode(text),
      branch: CFG.branch || 'main'
    };
    if (sha) body.sha = sha;
    return gh(contentsPathOf(path), { method: 'PUT', body: body });
  }

  /* 拿一个文件当前的 sha；文件不存在（第一次用）返回 null。
     ⚠️ 写已有文件**必须**带 sha，不然 GitHub 回 422。 */
  function shaOfFile(path) {
    return gh(contentsPathOf(path) + '?ref=' + encodeURIComponent(CFG.branch || 'main'))
      .then(function (d) { return (d && d.sha) ? d.sha : null; })
      .catch(function (err) {
        if (err.status === 404) return null;
        throw err;
      });
  }

  /* 写一个已有文件，失败（409）时**重新取一次 sha 再试**。
     ⚠️ 为什么值得重试：409 的真实含义是「分支 HEAD 在我读 sha 之后动过了」，
        不是「文件内容冲突」。重新取一次 sha 通常就过了。
        别把 409 直接甩给用户说「文件在别处被改过」—— 那是 ghError 的通用文案，
        在产物同步这个场景里是**误导**。 */
  function putWithRetry(path, text, message, tries) {
    tries = (tries == null) ? 3 : tries;
    function once(n) {
      return shaOfFile(path)
        .then(function (sha) { return putTextFile(path, text, message, sha); })
        .catch(function (err) {
          if (n > 1 && err.status === 409) {
            // 稍等一下再重来，避免又和「刚刚那次写」撞上
            return new Promise(function (res) { setTimeout(res, 400); })
              .then(function () { return once(n - 1); });
          }
          throw err;
        });
    }
    return once(tries);
  }

  /* 把两个产物按**当前 state.posts** 整份重建。
     列表页读 index.json、文章页读 c/<id>.json，两个都要写。
     ⚠️⚠️ **必须串行，绝对不能 Promise.all 并发**。
        2026-10-06 实测（`_preview/_probe-concurrent-put.py`，在临时分支上做、
        不影响 main）：
          · 并发 PUT 两个不同文件 → 1 个 201、1 个 **409**
            （`is at <sha> but expected <sha>`，是 **ref/分支层面**的冲突，
             不是文件 blob 的乐观锁）；
          · 串行 PUT 两个文件 → 2/2 全 201。
        GitHub 的 Contents API 服务端是「读分支 HEAD → 建 commit → 更新 ref」，
        同一分支上并发的第二次写会拿着过期的 base，直接被拒。
        这个并发就是主人「改完文章、文章页还是旧的」的**直接原因**：
        c/<id>.json 和 index.json 每轮**只成功一个**，而且是随机的。
        （提交历史可见：10:13 那轮只落了 index，10:14 那轮只落了 c/，10:15 两个都没落。） */
  function syncArtifacts(post, opts) {
    opts = opts || {};
    var ordered = state.posts.slice().sort(byDateDesc);
    var id = post.id;
    var errs = [];

    // 每个产物独立：前一个失败也要继续写后一个（两个文件互不依赖）。
    function step(fn) {
      return fn().catch(function (err) { errs.push(err); });
    }

    return step(function () {
      // 被删掉的那篇：它的单篇文件留着也无害（index.json 不再引用它，
      // 永远不会被请求；build-index.py 下次发布会清掉），这里不单独删。
      if (opts.deleted) return Promise.resolve();
      return putWithRetry('data/c/' + id + '.json', jsonText(postBodyOf(post)),
                          '更新正文缓存：' + post.title);
    }).then(function () {
      // 顺序固定：先文章页正文，再列表页。主人最在意的是「点进去看到新内容」。
      return step(function () {
        return putWithRetry('data/index.json', jsonText(ordered.map(indexRowOf)),
                            (opts.deleted ? '重建列表缓存：' : '更新列表缓存：') + post.title);
      });
    }).then(function () {
      if (errs.length) throw errs[0];
    });
  }

  /* 产物是「后置」的：失败了不影响这次保存本身，只提示主人再点一次。
     ⚠️ 不要把它的失败冒泡给调用方 —— 那会让 doSave 走回滚分支，
        把明明已经提交成功的文章从界面上抹掉。
     返回 true/false 表示产物到底写没写成功（调用方要据此决定弹哪句 toast）。 */
  function syncArtifactsQuietly(post, opts) {
    return syncArtifacts(post, opts).then(function () { return true; },
      function (err) {
        toast('正文已保存，但页面数据没跟上（' + err.message + '）—— ' +
              '请再点一次「保存并发布」', true);
        return false;
      });
  }

  /* ======================================================================
     连接 / 锁定
     ====================================================================== */

  function renderRepoInfo() {
    var el = $('#repo-info');
    var configured = !!(CFG.owner && CFG.repo);

    if (!configured) {
      el.innerHTML = '<span class="repo-bad">●</span> 还没配置仓库';
      $('#config-missing').hidden = false;
      $('#token-form').hidden = true;
      return;
    }
    el.innerHTML =
      '<span class="repo-ok">●</span> ' + esc(CFG.owner + '/' + CFG.repo) +
      '<span class="repo-meta">' + esc(CFG.branch || 'main') + ' · ' + esc(CFG.path) + '</span>';
    $('#config-missing').hidden = true;
    $('#token-form').hidden = false;
  }

  /* 记住 / 忘掉这台设备上的令牌 */
  function setToken(t) {
    state.token = t || '';
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) { /* 隐私模式下写不进去，不影响这一次的使用 */ }
  }

  /* 作者留空就用默认作者，占位文字跟着配置走 */
  function renderConnect() {
    var authorEl = $('#f-author');
    if (authorEl) authorEl.placeholder = '留空 = ' + defaultAuthor();
  }

  /* 真正去连仓库：先验令牌，再看仓库写权限，最后读一遍文章 */
  function connect(token) {
    state.token = token;
    return gh('/user').then(function (me) {
      state.user = me.login;
      return gh('/repos/' + encodeURIComponent(CFG.owner) + '/' + encodeURIComponent(CFG.repo));
    }).then(function (repo) {
      if (repo && repo.permissions && repo.permissions.push === false) {
        throw new Error('这个令牌没有该仓库的写入权限：请把 Contents 权限设为 Read and write');
      }
      return loadPosts();
    }).then(function () {
      setToken(token);
      $('#f-token').value = '';
      renderList();
      show('list');
      toast('已连接 ' + CFG.owner + '/' + CFG.repo);
    });
  }

  /* 断开：清掉本设备记住的令牌，回到「贴令牌」那一屏 */
  function disconnect() {
    setToken('');
    state.user = '';
    state.sha = null;
    state.posts = [];
    state.filterTag = '';
    state.site = null;
    state.siteSha = null;
    state.order = { ids: [], tags: [] };
    state.orderSha = null;
    state.tagOrder = [];
    state.batch = false;
    state.batchBaseline = null;
    state.batchBaselineTags = [];
    state.batchSnapshot = null;
    state.tagEdit = null;
    $('#f-token').value = '';
    renderConnect();
    show('connect');
  }

  /* ======================================================================
     文章列表
     ====================================================================== */

  /* 数一遍所有标签：count 是每个标签的篇数，list 按**第一次出现**的先后排。
     含已隐藏的文章 —— 这里是管理界面，得看全。
     ⚠️ list 用「第一次出现」而不是「出现次数多的在前」：这样它跟首页标签栏的
        兜底顺序是同一个口径，标签总览里看到的先后 = 首页上看到的先后，
        拖起来才所见即所得（以前按篇数排，拖之前两边显示的顺序不一样，踩过）。
     ⚠️ 真正显示时还要再过一遍 tagOrderList()，让拖过的标签排到前面去。 */
  function tagStats(posts) {
    var count = Object.create(null);
    var order = [];
    posts.forEach(function (p) {
      (p.tags || []).forEach(function (t) {
        var k = String(t).trim();
        if (!k) return;
        if (count[k] === undefined) { count[k] = 0; order.push(k); }
        count[k]++;
      });
    });
    return { list: order, count: count };
  }

  /* 当前筛选下要显示的文章 */
  /* 列表里这一篇命中搜索词没有。
     ⚠️ 口径跟站外首页（app.js 的 match()）**保持一致**：标题 / 摘要 / 标签 / 正文。
        **外加「作者」** —— 主人 2026-10-07 明确要求写作台的搜索要能检索作者，
        站外不需要所以那边没有这一项。
     ⚠️ 正文也进搜索：posts.json 就在手上（不像前台列表页只有 index.json），
        不搜白不搜。 */
  function matchQuery(p, q) {
    if (!q) return true;
    var hay = [p.title, p.lede || '', (p.tags || []).join(' '),
               p.author || '', p.content || '']
                .join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function visiblePosts() {
    var q = state.q;
    return state.posts.filter(function (p) {
      if (state.filterTag && (p.tags || []).indexOf(state.filterTag) === -1) return false;
      return matchQuery(p, q);
    });
  }

  function renderTagbar() {
    var bar = $('#admin-tagbar');
    if (!bar) return;

    var st = tagStats(state.posts);
    // 选中的标签可能已经不存在了（比如刚删掉最后一篇用它标过的文章）
    if (state.filterTag && st.list.indexOf(state.filterTag) === -1) state.filterTag = '';

    if (!st.list.length) { bar.innerHTML = ''; bar.hidden = true; return; }

    var html = '<button class="tag-btn' + (state.filterTag ? '' : ' on') +
               '" data-tag="">全部<span class="count">' + state.posts.length + '</span></button>';
    // 顺序跟首页标签栏一致 —— 标签总览里拖过就按拖的来
    tagOrderList().forEach(function (t) {
      html += '<button class="tag-btn' + (state.filterTag === t ? ' on' : '') +
              '" data-tag="' + esc(t) + '">' + esc(t) +
              '<span class="count">' + st.count[t] + '</span></button>';
    });
    bar.innerHTML = html;
    bar.hidden = false;
  }

  function renderList() {
    var ul = $('#list');
    var batch = state.batch === true;

    // 批量编辑下强制看全部：在筛选后的列表里挪位置，很容易挪到自己看不见的地方
    if (batch) {
      state.filterTag = '';
      state.q = '';
      var sb = $('#admin-search');
      if (sb) { sb.value = ''; sb.__eeLastQ = null; }
      var sc = $('#btn-search-clear');
      if (sc) sc.hidden = true;
    }
    renderTagbar();
    var tagbarEl = $('#admin-tagbar');
    if (tagbarEl && batch) tagbarEl.hidden = true;

    var shown = visiblePosts();
    var narrowed = state.filterTag || state.q;
    $('#count-pill').textContent = narrowed
      ? shown.length + ' / ' + state.posts.length + ' 篇'
      : state.posts.length + ' 篇';

    var empty = $('#list-empty');
    empty.hidden = shown.length > 0;
    empty.textContent = batch
      ? '还没有文章，没什么可编辑的。'
      : (state.q
          ? '没有匹配「' + state.q + '」的文章。'
          : (state.filterTag
              ? '没有「' + state.filterTag + '」标签的文章。'
              : '还没有文章，点右上角开始写第一篇。'));

    $('#repo-strip').innerHTML =
      '<span class="repo-ok">●</span> ' +
      esc(CFG.owner + '/' + CFG.repo) +
      '<span class="repo-meta">' + esc(CFG.branch || 'main') +
      (state.user ? ' · 已连接 ' + esc(state.user) : '') + '</span>';

    // 批量编辑在 body 上挂个类：CSS 靠它把「电脑端整行可拖」的光标、
    // 「收起 ↑↓ 按钮」这些规则限定在批量编辑模式内（平时列表要能正常选中文字）
    document.body.classList.toggle('ee-batch', batch);

    var batchBar = $('#batch-bar');
    if (batchBar) batchBar.hidden = !batch;
    var btnBatch = $('#btn-batch');
    if (btnBatch) {
      btnBatch.textContent = batch ? '退出批量编辑' : '批量编辑文章';
      btnBatch.classList.toggle('on', batch);
    }

    ul.innerHTML = shown.map(function (p, i) {
      var isHidden = p.hidden === true;
      // 作者栏空着 = 用默认署名 = 站主自己写的 → 标「原创」，跟前台卡片一致
      var author = p.author
        ? '<span class="pill pill-author">' + esc(p.author) + '</span>'
        : '<span class="pill pill-original">原创</span>';
      var hiddenPill = isHidden ? '<span class="pill pill-hidden">已隐藏</span>' : '';
      // 值得阅读程度（只有读书笔记填了才有）。主人 2026-10-05：「在文章列表那里显示打分就行」
      // 标签用「评分」两个字 —— 跟前台卡片上那个胶囊一致（那边是 app.js 的 SCORE_LABEL）。
      // ⚠️ 用 `typeof === 'number'` 判，别用 `p.score &&`：0 分是合法分数，
      //    用真假值判的话 0 分的文章在这里会没有胶囊（前台卡片上却有）。
      var scorePill = typeof p.score === 'number'
        ? '<span class="pill pill-score" title="值得阅读程度（满分 100）">评分 ' +
          p.score + '</span>'
        : '';
      var metaStart = '<div class="meta"><span>' + fmtDate(p.date) + '</span>' +
                      hiddenPill + scorePill;

      var inner;
      if (!batch) {
        var tags = (p.tags || []).map(function (t) {
          return '<span class="pill">' + esc(t) + '</span>';
        }).join(' ');
        inner =
          '<div class="info">' +
            '<div class="ttl">' + esc(p.title) + '</div>' +
            metaStart + author + tags + '</div>' +
          '</div>' +
          '<div class="ops">' +
            '<button class="btn' + (state.previewId === p.id ? ' on' : '') + '"' +
              ' data-act="preview" title="就地看一眼正文（再点一次收起）">' +
              (state.previewId === p.id ? '收起' : '预览') + '</button>' +
            '<button class="btn" data-act="edit">编辑</button>' +
            '<button class="btn btn-danger" data-act="del">删除</button>' +
          '</div>';
      } else {
        // 标签做成可删的小胶囊；行内再给一个输入框，回车就加上。
        // 布局压成三行：标题 + 隐藏按钮 / 日期·作者 + 位移按钮 / 标签 + ＋标签。
        // 手机上每一行的高度直接决定「一屏能看几篇」，多一行就少一篇。
        var chips = (p.tags || []).map(function (t) {
          return '<span class="tag-chip">' + esc(t) +
            '<button class="chip-x" data-act="rmtag" data-tag="' + esc(t) + '"' +
            ' title="删掉这个标签" aria-label="删掉标签 ' + esc(t) + '">×</button>' +
            '</span>';
        }).join('');
        inner =
          '<div class="info">' +
            '<div class="ttl-row">' +
              '<div class="ttl">' + esc(p.title) + '</div>' +
              '<button class="btn btn-toggle' + (isHidden ? ' on' : '') + '"' +
                ' data-act="toggle-hidden" title="切换这篇是公开还是隐藏">' +
                (isHidden ? '已隐藏' : '隐藏') + '</button>' +
            '</div>' +
            metaStart + author +
              '<div class="ops">' +
                '<button class="btn btn-move" data-act="top"' +
                  (i === 0 ? ' disabled' : '') + ' title="移到最前">置顶</button>' +
                '<button class="btn btn-move" data-act="up"' +
                  (i === 0 ? ' disabled' : '') + ' title="上移一位">↑</button>' +
                '<button class="btn btn-move" data-act="down"' +
                  (i === shown.length - 1 ? ' disabled' : '') + ' title="下移一位">↓</button>' +
              '</div>' +
            '</div>' +
            '<div class="row-tags">' + chips +
              '<input class="row-tag-input" type="text" maxlength="' + MAX_TAG_LEN + '"' +
              ' placeholder="＋ 标签" aria-label="给这篇加标签">' +
            '</div>' +
          '</div>';
      }

      // 列表里的「预览」（2026-10-07 主人要求）：就地渲染**正文**，不带 AI 摘要。
      // 再点一次「收起」撤掉。展开的是哪一篇记在 state.previewId 上 ——
      // 这样列表因为别的原因重画（搜了词、改了标签）之后，展开状态还在。
      // ⚠️ 用 MD.render（和文章页同一个渲染器）而不是塞纯文本：
      //    主人的正文是 Markdown，塞纯文本会看到满屏星号。
      //    XSS 由 MD.render 内部的 esc() 兜住，别自己拼字符串。
      var previewBlock = (!batch && state.previewId === p.id)
        ? '<div class="row-preview">' +
            '<div class="row-preview-inner post-body">' +
              (p.content ? MD.render(p.content)
                         : '<p class="row-preview-empty">（这篇还没有正文）</p>') +
            '</div>' +
          '</div>'
        : '';

      var liCls = [];
      if (isHidden) liCls.push('is-hidden');
      if (previewBlock) liCls.push('has-preview');

      return '' +
        '<li data-id="' + esc(p.id) + '"' +
            (liCls.length ? ' class="' + liCls.join(' ') + '"' : '') + '>' +
          // 批量编辑下这个序号同时是**拖拽把手**（CSS 里 touch-action:none，
          // 手指按住它才不会变成滚页面；鼠标则整行都能拖）
          (batch
            ? '<span class="ord" title="按住拖动" aria-label="拖动排序">' +
              (i + 1) + '</span>'
            : '') +
          inner +
          previewBlock +
        '</li>';
    }).join('');

    renderBatchSummary();
  }

  /* ---------- 批量编辑：待保存的改动 ---------- */

  /* 跟进入批量编辑时的快照比，看动了什么。文章顺序、标签顺序、标签、公开状态 */
  function batchChanges() {
    var snap = state.batchSnapshot;
    if (!snap) return { order: false, tagOrder: false, tags: [], hidden: [] };

    var before = {};
    snap.forEach(function (p) { before[p.id] = p; });
    var beforeOrder = snap.map(function (p) { return p.id; });

    var tags = [], hidden = [];
    state.posts.forEach(function (p) {
      var was = before[p.id];
      if (!was) return;                       // 期间新增的文章，不算改动
      if ((p.tags || []).join('\u0000') !== (was.tags || []).join('\u0000')) tags.push(p.id);
      if ((p.hidden === true) !== (was.hidden === true)) hidden.push(p.id);
    });

    return {
      order: currentIds().join('\u0000') !== beforeOrder.join('\u0000'),
      tagOrder: tagOrderDirty(),
      tags: tags,
      hidden: hidden
    };
  }

  function renderBatchSummary() {
    var box = $('#batch-summary');
    if (!box) return;
    if (state.batch !== true) { box.hidden = true; return; }

    var c = batchChanges();
    var parts = [];
    if (c.order) parts.push('顺序有调整');
    if (c.tagOrder) parts.push('标签顺序有调整');
    if (c.tags.length) parts.push(c.tags.length + ' 篇的标签改了');
    if (c.hidden.length) parts.push(c.hidden.length + ' 篇的公开状态改了');

    box.hidden = !parts.length;
    box.textContent = parts.length ? '待保存：' + parts.join(' · ') : '';
  }

  /* ======================================================================
     批量编辑：排序 + 改标签 + 隐藏，做完一次提交
     ----------------------------------------------------------------------
     三件事都**直接改 state.posts**（所见即所得），进入时存一份深拷贝，
     取消时整体回滚 —— 标签和隐藏状态是改在文章对象上的，
     光靠「重新排一次序」回不去。
     ====================================================================== */

  function enterBatch() {
    if (!state.posts.length) {
      toast('还没有文章，没什么可编辑的', true);
      return;
    }
    state.batch = true;
    state.filterTag = '';
    state.batchBaseline = currentIds();                             // 文章顺序基线
    state.batchBaselineTags = (state.tagOrder || []).slice();        // 标签顺序基线
    state.batchSnapshot = JSON.parse(JSON.stringify(state.posts));  // 取消时回滚用
    renderList();
  }

  function cancelBatch() {
    var c = batchChanges();
    var n = (c.order ? 1 : 0) + (c.tagOrder ? 1 : 0) + c.tags.length + c.hidden.length;
    if (n && !window.confirm('有 ' + n + ' 处改动还没保存，确定放弃吗？')) return;
    state.batch = false;
    state.batchBaseline = null;
    state.tagOrder = (state.batchBaselineTags || []).slice();   // 标签顺序也退回进入时的样子
    state.batchBaselineTags = [];
    state.posts = applyOrder(state.batchSnapshot || state.posts);
    state.batchSnapshot = null;
    renderList();
  }

  /* 切换一篇的公开 / 隐藏 */
  function toggleHidden(id) {
    var post = state.posts.filter(function (p) { return p.id === id; })[0];
    if (!post) return;
    if (post.hidden === true) delete post.hidden;   // 假值不落盘，跟编辑页保持一致
    else post.hidden = true;
    renderList();
  }

  /* 从一篇上删掉一个标签 */
  function removeTag(id, tag) {
    var post = state.posts.filter(function (p) { return p.id === id; })[0];
    if (!post || !post.tags) return;
    var next = post.tags.filter(function (t) { return t !== tag; });
    if (next.length === post.tags.length) return;
    post.tags = next;
    renderList();
  }

  /* 给一篇加一个标签。上限 8 个，跟编辑页那个输入框保持一致 */
  function addTag(id, raw) {
    var tag = String(raw || '').trim().replace(/^#/, '');
    if (!tag) return false;
    if (tag.length > MAX_TAG_LEN) {
      toast('标签太长了（最多 ' + MAX_TAG_LEN + ' 个字）', true);
      return false;
    }

    var post = state.posts.filter(function (p) { return p.id === id; })[0];
    if (!post) return false;

    var tags = post.tags || [];
    if (tags.indexOf(tag) !== -1) { toast('这篇已经有「' + tag + '」了'); return false; }
    if (tags.length >= MAX_TAGS) { toast('一篇最多 ' + MAX_TAGS + ' 个标签', true); return false; }

    post.tags = tags.concat([tag]);
    renderList();
    return true;
  }

  /* delta：-1 上移一位 / 1 下移一位 / 'top' 移到最前
     ----------------------------------------------------------------------
     以前是「改完 state.posts 就 renderList()」，整张表重画一遍 —— 顺序确实变了，
     但看上去是「啪」地跳过去，眼睛跟不上，会怀疑到底动没动。
     现在走跟拖拽同一套 FLIP：其它行滑到新位置，被挪的那行再闪一下确认落点。
     （所以这里也不能 renderList()，会把刚起头的动画打断。） */
  function movePost(id, delta) {
    var i = -1;
    for (var k = 0; k < state.posts.length; k++) {
      if (state.posts[k].id === id) { i = k; break; }
    }
    if (i < 0) return;

    var j = delta === 'top' ? 0 : i + delta;
    if (j < 0 || j >= state.posts.length || j === i) return;

    var ul = $('#list');
    var li = ul.querySelector('li[data-id="' +
      (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');

    flipReorder(function () {
      var moved = state.posts.splice(i, 1)[0];
      state.posts.splice(j, 0, moved);

      // DOM 跟着 state.posts 重排一遍：appendChild 会「移动」已有节点，
      // 所以按目标顺序挨个 append 就等于排序，不用自己算插到谁前面。
      var byId = {};
      [].slice.call(ul.querySelectorAll('li')).forEach(function (row) {
        byId[row.getAttribute('data-id')] = row;
      });
      state.posts.forEach(function (p) { if (byId[p.id]) ul.appendChild(byId[p.id]); });

      renumberRows();
    }, ul);

    refreshMoveButtons();
    settleRow(li);
    // 以前整表重画顺手就把「待保存」那行刷新了，现在不重画，得自己叫一次
    renderBatchSummary();

    // 手机上一屏放不下几行，挪完把这一行滚回视野里，不然会「找不到刚才那篇」
    if (li && li.scrollIntoView) {
      try { li.scrollIntoView({ block: 'nearest' }); } catch (e) { /* 老浏览器忽略 */ }
    }
  }

  /* ======================================================================
     拖拽排序（鼠标和手指用同一套代码）
     ----------------------------------------------------------------------
     ⚠️ 不要用 HTML5 的 draggable / dragstart —— 它在触屏上**根本不触发**
     （安卓/iOS 都不发 drag 事件），而这个写作台主要在手机上用。
     改用 Pointer Events：鼠标按住行就能拖；手指要按住**把手**
     （CSS 里 touch-action:none，所以不会变成滚动页面）。

     拖动过程中直接搬 DOM（把被拖的 li insertBefore 到目标位置），
     不搞幽灵元素 —— 少一层同步，落点就是最终落点。

     两个地方用它，差别只有三处（容器、手指按哪、松手后怎么把顺序读回去），
     所以做成「一份实现 + 一张注册表」，而不是把这一百行抄两遍：
       · 文章列表 #list          → 决定文章的先后
       · 标签总览 #tag-edit-list → 决定首页标签栏里标签的先后
     ====================================================================== */

  var dragState = null;
  var DRAG_MARGIN = 72;      // 离视口上下边缘多近开始自动滚动

  /* { root, handle, key, commit }
       root   —— 装 li 的容器选择器
       handle —— 手指必须按住的把手选择器（鼠标不用按它，整行可拖）
       key    —— 每行上用来认身份的属性名（文章是 data-id，标签是 data-from）
       commit —— 松手后拿 DOM 里的新顺序去更新数据，参数是 key 值数组 */
  var DRAG_ZONES = [];

  function registerDragZone(zone) { DRAG_ZONES.push(zone); }

  function dragCleanup() {
    if (!dragState) return;
    if (dragState.timer) clearTimeout(dragState.timer);
    if (dragState.li) dragState.li.classList.remove('dragging');
    document.documentElement.classList.remove('ee-dragging');
    document.removeEventListener('pointermove', dragMove);
    document.removeEventListener('pointerup', dragEnd);
    document.removeEventListener('pointercancel', dragEnd);
    dragState = null;
  }

  /* 把序号重新编一遍（搬完 DOM 之后编号会乱）。
     只有文章列表有「序号」这回事，标签总览那边不调它。 */
  function renumberRows(root) {
    var rows = (root || $('#list')).querySelectorAll('li .ord');
    for (var i = 0; i < rows.length; i++) rows[i].textContent = String(i + 1);
  }

  /* 只刷新首末行的按钮禁用状态。
     拖拽结束走这里，而不是 renderList() —— 整表重画会闪一下，
     还会把刚做完的位移动画一起打断。 */
  function refreshMoveButtons() {
    var rows = $('#list').querySelectorAll('li');
    for (var i = 0; i < rows.length; i++) {
      var up = rows[i].querySelector('button[data-act="up"]');
      var top = rows[i].querySelector('button[data-act="top"]');
      var down = rows[i].querySelector('button[data-act="down"]');
      var first = i === 0, last = i === rows.length - 1;
      if (up) up.disabled = first;
      if (top) top.disabled = first;
      if (down) down.disabled = last;
    }
  }

  /* 松手后在被拖的那一行上打一下高亮，确认「就落在这儿」 */
  function settleRow(li) {
    if (!li || !li.classList) return;
    li.classList.add('settled');
    setTimeout(function () { li.classList.remove('settled'); }, 460);
  }

  /* FLIP：先量位置 → 改 DOM → 补一个反向位移再过渡回 0，
     这样其它行是「滑」到新位置，而不是瞬间跳过去。
     container 不给就默认文章列表（拖拽用）；↑↓ 按钮和标签总览会显式传进来。
     ⚠️ 量位置用 offsetTop，不用 getBoundingClientRect()：后者把 transform
     算进去，上一次动画还没跑完时量到的就是中间态，位移量会算错（越拖越飘）。
     ⚠️ 被拖的那一行要跳过（它跟手，不该再被动画拉回去）。dragState 可能为
     null —— ↑↓ 按钮走的就是这条路，所以不能直接读 dragState.li。 */
  function flipReorder(mutate, container) {
    var root = container || $('#list');
    var lis = [].slice.call(root.querySelectorAll('li'));
    var tops = [];
    var i;
    for (i = 0; i < lis.length; i++) tops.push(lis[i].offsetTop);

    mutate();

    for (i = 0; i < lis.length; i++) {
      var li = lis[i];
      if (dragState && li === dragState.li) continue;
      var dy = tops[i] - li.offsetTop;
      if (!dy) continue;
      li.style.transition = 'none';
      li.style.transform = 'translateY(' + dy + 'px)';
      void li.offsetHeight;                     // 强制回流，让起点真的生效
      li.style.transition = 'transform .16s cubic-bezier(.2, .7, .3, 1)';
      li.style.transform = '';
      clearFlipLater(li);
    }
  }

  function clearFlipLater(li) {
    setTimeout(function () {
      li.style.transition = '';
      li.style.transform = '';
    }, 240);
  }

  /* 指针位置下面是哪一行（被拖的那行 pointer-events:none，所以会被"看穿"） */
  function rowUnder(x, y) {
    if (!dragState) return null;
    var el = document.elementFromPoint(x, y);
    if (!el || !el.closest) return null;
    var li = el.closest(dragState.zone.root + ' li');
    if (!li || li === dragState.li) return null;
    return li;
  }

  function autoScroll(y) {
    var step = 0;
    if (y < DRAG_MARGIN) step = -(DRAG_MARGIN - y) / 3;
    else if (y > window.innerHeight - DRAG_MARGIN) {
      step = (y - (window.innerHeight - DRAG_MARGIN)) / 3;
    }
    if (step) window.scrollBy(0, step);
  }

  function dragMove(e) {
    if (!dragState) return;
    var x = e.clientX, y = e.clientY;

    if (!dragState.active) {
      // 还没真正进入拖拽：手指一动就说明用户是在滚页面，让路
      if (Math.abs(y - dragState.y0) > 8 || Math.abs(x - dragState.x0) > 8) {
        dragCleanup();
      }
      return;
    }

    if (e.cancelable) e.preventDefault();
    dragState.y = y;
    autoScroll(y);

    var over = rowUnder(x, y);
    if (!over) return;
    var r = over.getBoundingClientRect();
    var after = y > r.top + r.height / 2;
    var ref = after ? over.nextSibling : over;
    // 落点没变就别碰 DOM：否则每一帧都重排一次，动画会被自己反复打断
    if (ref === dragState.li || ref === dragState.li.nextSibling) return;
    flipReorder(function () {
      dragState.li.parentNode.insertBefore(dragState.li, ref);
    }, dragState.root);
    if (dragState.zone.renumber) renumberRows(dragState.root);
  }

  function dragEnd() {
    if (!dragState) return;
    var wasActive = dragState.active;
    var dragged = dragState.li;
    var zone = dragState.zone;
    var root = dragState.root;
    dragCleanup();
    if (!wasActive) return;

    // 把 DOM 里的新顺序读出来，交给这一区自己的 commit 去更新数据
    var order = [];
    var rows = root.querySelectorAll('li');
    for (var i = 0; i < rows.length; i++) {
      var v = rows[i].getAttribute(zone.key);
      if (v) order.push(v);
    }
    zone.commit(order);

    // ⚠️ 这里**不能** renderList()：整表重画会闪一下，还会把刚做完的位移动画打断。
    //    序号在拖动过程中已经编好，只需要补一下首末行的按钮禁用状态。
    if (zone.renumber) refreshMoveButtons();
    settleRow(dragged);
  }

  function dragStart(zone, li, e) {
    var isTouch = e.pointerType === 'touch';
    // 手指只认把手，否则一按住就拖，页面没法滚了
    if (isTouch && !(e.target.closest && e.target.closest(zone.handle))) return;
    // 点按钮 / 想打字不算拖。⚠️ input 也要排除：整行可拖的情况下，
    //    被拖的行会拿到 pointer-events:none，点进输入框就永远聚焦不上。
    if (e.target.closest && e.target.closest('button, input, textarea, select, a')) return;

    dragState = {
      zone: zone, root: $(zone.root), li: li,
      y0: e.clientY, x0: e.clientX, y: e.clientY,
      pid: e.pointerId, active: false, isTouch: isTouch, timer: null
    };

    if (isTouch) {
      // 手指按住把手 250ms 才算「要拖」，中途动了就当滚动
      dragState.timer = setTimeout(function () {
        if (dragState) dragActivate();
      }, 250);
    }

    document.addEventListener('pointermove', dragMove);
    document.addEventListener('pointerup', dragEnd);
    document.addEventListener('pointercancel', dragEnd);
  }

  function dragActivate() {
    if (!dragState || dragState.active) return;
    dragState.active = true;
    dragState.li.classList.add('dragging');
    document.documentElement.classList.add('ee-dragging');
    try {
      // 合成事件没有真实指针，会抛 —— 包起来，拖拽照样能用
      dragState.li.parentNode.setPointerCapture(dragState.pid);
    } catch (err) { /* ignore */ }
  }

  /* 给每个拖拽区挂上 pointerdown。判断「能不能拖」交给 zone.enabled ——
     文章列表只在批量编辑模式下可拖（平时列表要能正常选中文字），
     标签总览那一屏本身就是干这个的，随时可拖。 */
  function initDrag() {
    DRAG_ZONES.forEach(function (zone) {
      var root = $(zone.root);
      if (!root) return;
      root.addEventListener('pointerdown', function (e) {
        if (dragState || (zone.enabled && !zone.enabled())) return;
        if (e.button && e.button !== 0) return;              // 只认左键
        var li = e.target.closest && e.target.closest(zone.root + ' li');
        if (!li) return;
        dragStart(zone, li, e);
        // 鼠标：按住就可以直接拖，不用等
        if (e.pointerType !== 'touch') dragActivate();
      });
    });
  }

  /* 文章列表：松手后把 DOM 顺序读回 state.posts */
  function commitPostOrder(ids) {
    var byId = {};
    state.posts.forEach(function (p) { byId[p.id] = p; });
    var next = [];
    ids.forEach(function (id) { if (byId[id]) next.push(byId[id]); });
    // 兜底：万一有哪篇没进 DOM（理论上不会），原样补在后面，别把它弄丢
    state.posts.forEach(function (p) {
      if (ids.indexOf(p.id) === -1) next.push(p);
    });
    state.posts = next;
  }

  /* 标签总览：松手后按 DOM 顺序记住标签先后。
     ⚠️ 这里**不重画**列表 —— 那一行的输入框里可能有用户刚打的字，
        重画就没了。state.tagEdit 只是初始内容，渲染完 DOM 就是准的。 */
  function commitTagOrder() {
    state.tagOrder = readTagEdit().map(function (r) { return r.from; });
    renderTagsSummary();
  }

  function registerDragZones() {
    registerDragZone({
      root: '#list',
      handle: '.ord',                    // 手指按住序号才能拖
      key: 'data-id',
      renumber: true,
      enabled: function () { return state.batch === true; },
      commit: commitPostOrder
    });
    registerDragZone({
      root: '#tag-edit-list',
      handle: '.tag-grip',
      key: 'data-from',
      renumber: false,
      commit: commitTagOrder
    });
  }

  /* 只重建**列表产物** data/index.json，不动单篇文件。
     批量编辑改的是标签 / 隐藏状态 / 标题这些 —— 它们只在 index.json 里
     （data/c/<id>.json 只有 content / ai），所以只重建这一个。
     ⚠️ 和 syncArtifacts 一样：**串行**，别和别的写并发（见那边的注释）。
     ⚠️ 只改「顺序」时**不要**调它 —— 顺序不在 index.json 里，
        写了内容也不变，只会白多一个空提交。 */
  function syncIndexQuietly(message) {
    var rows = state.posts.slice().sort(byDateDesc).map(indexRowOf);
    return putWithRetry('data/index.json', jsonText(rows), message)
      .then(function () { return true; },
        function (err) {
          toast('改动已保存，但列表页数据没跟上（' + err.message + '）—— ' +
                '请再点一次「保存全部改动」', true);
          return false;
        });
  }

  /* 保存批量编辑：标签 / 公开状态进 posts.json，文章顺序 + 标签顺序进 order.json。
     Contents API 一次只能写一个文件，所以两处都有改动时就是两次提交；
     任一步失败都重新拉一遍，别让界面跟远端不一致。
     ⚠️ 两次写是**串行**的（下面 reduce 链）—— 并发会 409（见 syncArtifacts 的注释）。
     ⚠️ 标签 / 隐藏状态改完还要重建 data/index.json，不然首页卡片还是旧标签。 */
  function saveBatch() {
    var c = batchChanges();
    if (!c.order && !c.tagOrder && !c.tags.length && !c.hidden.length) {
      toast('还没有任何改动');
      return;
    }

    var parts = [];
    if (c.order) parts.push('顺序');
    if (c.tagOrder) parts.push('标签顺序');
    if (c.tags.length) parts.push('标签');
    if (c.hidden.length) parts.push('公开状态');
    var message = '批量编辑：' + parts.join(' + ');

    // 顺序先记进 state.order：commit() 里会按它重排一次，
    // 不先写进去的话，刚拖好的顺序会被旧 ids 排回原样。
    var ids = currentIds();
    var tags = (state.tagOrder || []).slice();
    state.order = { ids: ids, tags: tags };

    var jobs = [];
    if (c.tags.length || c.hidden.length) jobs.push(function () { return commit(message); });
    if (c.order || c.tagOrder) jobs.push(function () { return commitOrder(message, ids, tags); });

    var btn = $('#btn-batch-save');
    btn.disabled = true;
    btn.textContent = '保存中…';

    return jobs.reduce(function (chain, job) {
      return chain.then(function () { return job(); });
    }, Promise.resolve())
      .then(function () {
        state.batch = false;
        state.batchBaseline = null;
        state.batchBaselineTags = [];
        state.batchSnapshot = null;
        renderList();
        toast('已保存 ' + parts.join(' + ') + '，正在更新页面数据…');
        // ⚠️ 标签 / 隐藏状态会进 index.json（首页卡片读它）——
        //    不重建的话「改了标签首页没变」又是一轮排查。
        //    「顺序」不进 index.json，所以那种情况跳过，免得白写一个空提交。
        if (!c.tags.length && !c.hidden.length) return;
        return syncIndexQuietly(message).then(function (ok) {
          if (ok) toast('已保存 ' + parts.join(' + ') + '，页面数据已更新');
        });
      })
      .catch(function (e) {
        // 只成功了一半（比如顺序写进去了、标签没有）：拉回远端的真实状态，
        // 用户再点一次「保存全部改动」就能把剩下的补上
        return loadPosts().catch(function () {}).then(function () {
          renderList();
          toast(e.message, true);
        });
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = '保存全部改动';
      });
  }

  /* 只写 data/order.json。
     两个字段都写全：文章顺序 ids + 标签顺序 tags。
     ⚠️ 即使这次只动了其中一个，也要把另一个原样带上 —— 覆盖式写入，
         漏掉谁就等于把谁清空了。 */
  function commitOrder(message, ids, tags) {
    var payload = { ids: ids, tags: tags || [] };
    var body = {
      message: message,
      content: b64encode(JSON.stringify(payload, null, 2) + '\n'),
      branch: CFG.branch || 'main'
    };
    if (state.orderSha) body.sha = state.orderSha;

    return gh(contentsPathOf(orderPath()), { method: 'PUT', body: body })
      .then(function (data) {
        if (data && data.content && data.content.sha) state.orderSha = data.content.sha;
      });
  }

  /* ======================================================================
     标签总览：全局改名 / 合并 / 移除 + 拖动排序
     ----------------------------------------------------------------------
     一篇一篇地改标签，改到第十篇就会开始漏。这里按「标签」列出来，
     改一次就作用到所有文章（含未公开的）。
     结果先落在 state.posts / state.tagOrder 上，回列表点「保存全部改动」才真正提交。

     这里的先后就是**首页标签栏的先后**（存进 order.json 的 tags），
     所以按住左边的把手拖动即可，跟文章列表拖拽是同一套实现。
     ====================================================================== */

  function openTagOverview() {
    // ⚠️ 不管从哪进来（顶栏「标签总览」还是批量编辑里那个），都要先把基线定下来 ——
    //    否则 tagOrderDirty() 拿空数组当基线，一进来就说「标签顺序调过了」。
    state.batchBaselineTags = (state.tagOrder || []).slice();
    // 进来时的顺序 = 当前显示顺序（拖过的按拖的来，没拖过的按出现次数）
    state.tagEdit = tagOrderList().map(function (t) {
      return { from: t, to: t };
    });
    renderTagEditList();
    show('tags');
  }

  function renderTagEditList() {
    var rows = state.tagEdit || [];
    var count = tagStats(state.posts).count;

    $('#tags-empty').hidden = rows.length > 0;
    $('#tag-edit-list').innerHTML = rows.map(function (r) {
      return '<li data-from="' + esc(r.from) + '">' +
        // 把手：手指按住它才能拖（CSS 里 touch-action:none，不会变成滚页面）；
        // 鼠标则整行可拖。跟文章列表左侧那个序号是同一个角色。
        '<span class="tag-grip" title="按住拖动，调整首页标签栏里的先后"' +
          ' aria-label="拖动调整标签顺序">' +
          '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
          '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>' +
          '<circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>' +
          '<circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>' +
          '</svg></span>' +
        '<span class="tag-from">' + esc(r.from) +
          '<span class="tag-count">' + (count[r.from] || 0) + ' 篇</span></span>' +
        '<input class="tag-to" type="text" maxlength="' + MAX_TAG_LEN + '"' +
          ' value="' + esc(r.to) + '" placeholder="留空 = 移除"' +
          ' aria-label="把标签 ' + esc(r.from) + ' 改成">' +
        '</li>';
    }).join('');

    renderUncat();
    renderTagsSummary();
  }

  /* 标签总览底部的「未分类」：一篇标签都没有的文章（2026-10-08 主人要求）。
     ⚠️ 必须常驻显示（0 篇也显示）—— 别的标签没文章就不出现，这个要是也这样，
        标签一多就没人知道还有没有漏标的文章。
     只读展示，改标签还是走上面那些标签行。 */
  function renderUncat() {
    var box = $('#tag-uncat');
    if (!box) return;
    var items = state.posts.filter(function (p) {
      return !(p.tags && p.tags.length);
    });
    $('#tag-uncat-count').textContent = items.length + ' 篇';
    var note = $('#tag-uncat-note');
    var list = $('#tag-uncat-list');
    if (!items.length) {
      note.textContent = '每篇文章都有标签。';
      list.hidden = true;
      list.innerHTML = '';
      return;
    }
    note.textContent = '这些文章还没有标签：';
    list.hidden = false;
    list.innerHTML = items.map(function (p) {
      return '<li><span class="tag-uncat-ttl">' +
        esc(p.title || '(无标题)') + '</span>' +
        '<span class="tag-count">' + fmtDate(p.date) + '</span></li>';
    }).join('');
  }

  /* 读一遍列表当前的样子（还没点「应用到列表」）。
     ⚠️ 认的是 DOM 上的 data-from，不是 state.tagEdit 的下标 ——
        拖过之后 DOM 顺序跟 state.tagEdit 就不一样了，按下标读会张冠李戴。 */
  function readTagEdit() {
    var items = $('#tag-edit-list').querySelectorAll('li');
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var input = items[i].querySelector('input.tag-to');
      out.push({
        from: items[i].getAttribute('data-from') || '',
        to: input ? input.value.trim().replace(/^#/, '') : ''
      });
    }
    return out;
  }

  /* 有没有还没应用的改名 / 移除（拖动顺序不算 —— 那个是立刻生效的） */
  function tagsDirty() {
    return readTagEdit().some(function (r) { return r.to !== r.from; });
  }

  function renderTagsSummary() {
    var box = $('#tags-summary');
    if (!box) return;

    var changed = readTagEdit().filter(function (r) { return r.to !== r.from; });
    var parts = [];

    if (changed.length) {
      var names = changed.slice(0, 3).map(function (r) {
        return r.to ? ('「' + r.from + '」→「' + r.to + '」') : ('移除「' + r.from + '」');
      });
      if (changed.length > 3) names.push('等 ' + changed.length + ' 个');
      parts.push(names.join('，'));
    }
    if (tagOrderDirty()) parts.push('标签顺序调过了');

    if (!parts.length) { box.hidden = true; box.textContent = ''; return; }

    box.hidden = false;
    box.textContent = '待保存：' + parts.join('；') +
      '。回到列表点「保存全部改动」才提交。';
  }

  /* 一次性作用到所有文章。⚠️ 必须同时改，不能一个一个串着改 ——
     否则「A→B、B→C」会连带变成 A→C。 */
  /* 把标签总览里的「改名 / 移除」作用到所有文章（含未公开的）+ 标签顺序。
     返回改了几篇；没有改名时返回 0；标签名太长时返回 -1（调用方直接放弃）。
     ⚠️ 必须**同时**改，不能一个一个串着改 ——
        否则「A→B、B→C」会连带变成 A→C。 */
  function applyTagRenames() {
    var rows = readTagEdit();
    var map = {};
    var changed = 0;
    var i;

    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.to.length > MAX_TAG_LEN) {
        toast('「' + r.to + '」太长了（最多 ' + MAX_TAG_LEN + ' 个字）', true);
        return -1;
      }
      if (r.to === r.from) continue;
      map[r.from] = r.to;                       // '' = 从所有文章上移除
      changed++;
    }

    if (!changed) return 0;

    var hit = 0;
    state.posts.forEach(function (p) {
      var tags = p.tags || [];
      var next = [], seen = Object.create(null);
      var touched = false;

      tags.forEach(function (t) {
        var mapped = Object.prototype.hasOwnProperty.call(map, t) ? map[t] : t;
        if (mapped !== t) touched = true;
        if (!mapped) return;                    // 被移除
        if (seen[mapped]) return;               // 合并后去掉重复
        seen[mapped] = true;
        next.push(mapped);
      });

      if (!touched) return;
      hit++;
      p.tags = next;                            // 一个不剩也留空数组，字段顺序不变
    });

    // 标签顺序里记的是**改名之前**的名字，得跟着一起挪过去，
    // 否则 order.json 里会留下几个已经不存在的标签。
    var seenOrder = Object.create(null);
    var nextOrder = [];
    (state.tagOrder || []).forEach(function (t) {
      var mapped = Object.prototype.hasOwnProperty.call(map, t) ? map[t] : t;
      if (!mapped) return;                      // 这个标签被移除了
      if (seenOrder[mapped]) return;            // 两个并成一个，只留一个
      seenOrder[mapped] = true;
      nextOrder.push(mapped);
    });
    state.tagOrder = nextOrder;

    return hit;
  }

  /* 标签总览的「保存并发布」：改名 / 移除 + 顺序，一次提交完，然后回列表。
     ⚠️ 为什么不能直接复用批量编辑的 saveBatch()：从顶栏「标签总览」进来时
        没经过批量编辑（state.batchSnapshot 是 null），batchChanges() 会认为
        什么都没改。这里只认「标签」这一件事：改名（进 posts.json）+ 顺序（进 order.json）。
     ⚠️⚠️ 只拖了顺序、**一个字都没改**时也必须能走完 ——
        以前这里直接报「标签没有改动」然后停在原地，主人以为顺序白拖了
        （2026-10-07 报的「只更改标签前后顺序无法保存」就是这个）。
        顺序其实在拖动松手那一刻就记进 state.tagOrder 了，只要 tagOrderDirty()
        为真就该提交，跟有没有改名无关。 */
  function saveTagOverview() {
    var orderDirty = tagOrderDirty();
    var hit = applyTagRenames();
    if (hit < 0) return;                          // 有标签名太长，已经提示过
    if (!hit && !orderDirty) { toast('标签没有改动'); return; }

    var ids = currentIds();
    var tags = (state.tagOrder || []).slice();
    // 先记进 state.order：commit() 里会按它重排一次
    state.order = { ids: ids, tags: tags };

    var parts = [];
    if (hit) parts.push('标签');
    if (orderDirty) parts.push('标签顺序');
    var message = '标签总览：' + parts.join(' + ');

    // ⚠️ 串行：GitHub 对同分支并发写会 409（见 syncArtifacts 的注释）
    var jobs = [];
    if (hit) jobs.push(function () { return commit(message); });
    jobs.push(function () { return commitOrder(message, ids, tags); });

    var btn = $('#btn-tags-save');
    btn.disabled = true;
    btn.textContent = '提交中…';

    return jobs.reduce(function (chain, job) {
      return chain.then(function () { return job(); });
    }, Promise.resolve())
      .then(function () {
        // 如果是从批量编辑里进来的，顺手把批量编辑也收尾 —— 改动已经提交了，
        // 不收尾的话回列表还挂着「待保存」，看着像没存上。
        if (state.batch === true) {
          state.batch = false;
          state.batchBaseline = null;
          state.batchBaselineTags = [];
          state.batchSnapshot = null;
        }
        state.tagEdit = null;
        renderList();
        show('list');
        toast('已保存 ' + parts.join(' + ') + '，正在更新页面数据…');
        // 改名会进 index.json（首页卡片读它）；只调顺序不用重建
        if (!hit) return;
        return syncIndexQuietly(message).then(function (ok) {
          if (ok) toast('已保存 ' + parts.join(' + ') + '，页面数据已更新');
        });
      })
      .catch(function (e) {
        // 只成功了一半：拉回远端真实状态，用户再点一次就能把剩下的补上
        return loadPosts().catch(function () {}).then(function () {
          renderList();
          toast(e.message, true);
        });
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = '保存并发布';
      });
  }

  function backFromTags() {
    // ⚠️ 顺序也要算进「有没有改动」—— 以前只判改名，拖过顺序再点「取消」会
    //    静默丢掉、也不弹确认（2026-10-07 一并修的）。
    if ((tagsDirty() || tagOrderDirty()) &&
        !window.confirm('标签总览里有改动还没保存，确定放弃吗？')) return;
    // 退回进来时的标签顺序（拖过的要还原）
    state.tagOrder = (state.batchBaselineTags || []).slice();
    state.tagEdit = null;
    renderList();
    show('list');
  }

  /* 批量编辑有没保存的改动时，离开列表页之前先问一声 */
  function guardBatch() {
    if (state.batch !== true || !batchDirty()) return true;
    return window.confirm('批量编辑有改动还没保存，确定离开吗？');
  }

  function refresh() {
    if (!guardBatch()) return;
    var btn = $('#btn-refresh');
    btn.disabled = true;
    btn.textContent = '刷新中…';
    loadPosts().then(function () {
      renderList();
      toast('已从 GitHub 重新读取');
    }).catch(function (e) {
      toast(e.message, true);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '刷新';
    });
  }

  /* ======================================================================
     草稿
     ====================================================================== */

  function draftKey(id) { return DRAFT_PREFIX + (id || '__new__'); }

  function saveDraft() {
    if (!state.editing) return;
    try {
      localStorage.setItem(draftKey(state.editing.id),
        JSON.stringify({ post: state.editing, at: Date.now() }));
    } catch (e) { /* ignore */ }
  }

  function readDraft(id) {
    try {
      var raw = localStorage.getItem(draftKey(id));
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function clearDraft(id) {
    try { localStorage.removeItem(draftKey(id)); } catch (e) { /* ignore */ }
  }

  /* ---------- 草稿箱（2026-10-07 主人要求） ----------
     草稿一直存在本机 localStorage 里（key = `ee-draft:<id>`，新文章是 `ee-draft:__new__`），
     但以前只有「正好打开那一篇」时才看得到，很容易忘。这里把它们全列出来。 */
  function listDrafts() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var key = localStorage.key(i);
        if (!key || key.indexOf(DRAFT_PREFIX) !== 0) continue;
        var raw = localStorage.getItem(key);
        if (!raw) continue;
        var obj = null;
        try { obj = JSON.parse(raw); } catch (e) { obj = null; }
        if (!obj || !obj.post) continue;
        out.push({ key: key, post: obj.post, at: obj.at || 0 });
      }
    } catch (e) { /* localStorage 不可用就当没有 */ }
    out.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });   // 最近改的在前
    return out;
  }

  function fmtWhen(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
           p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function renderDrafts() {
    var ul = $('#draft-list');
    if (!ul) return;
    var list = listDrafts();
    $('#drafts-count').textContent = list.length ? (list.length + ' 份草稿') : '草稿箱';
    $('#drafts-empty').hidden = list.length > 0;
    ul.innerHTML = list.map(function (d) {
      var p = d.post || {};
      var isNew = !p.id;
      var title = String(p.title || '').trim() || '（还没写标题）';
      var meta = [
        isNew ? '新文章' : ('改自 ' + p.id),
        fmtWhen(d.at),
        MD.charCount(p.content || '') + ' 字'
      ].join(' · ');
      return '<li>' +
        '<div class="info">' +
          '<div class="ttl">' + esc(title) + '</div>' +
          '<div class="meta"><span>' + esc(meta) + '</span></div>' +
        '</div>' +
        '<div class="ops">' +
          '<button class="btn btn-primary" data-act="open" data-draft="' + esc(d.key) + '">继续写</button>' +
          '<button class="btn btn-danger" data-act="del" data-draft="' + esc(d.key) + '">删除</button>' +
        '</div>' +
      '</li>';
    }).join('');
  }

  function openDrafts() {
    renderDrafts();
    show('drafts');
  }

  /* 把一份草稿调回编辑器。
     ⚠️ 已有文章的草稿要拿**原文章**当底再 openEditor() —— 这样 state.isNew 才是
        false，保存时是「更新」而不是新建（否则会多出一篇同标题的）。 */
  function openDraft(key) {
    var id = key.slice(DRAFT_PREFIX.length);
    var realId = (id === '__new__') ? '' : id;
    var draft = readDraft(realId);
    if (!draft || !draft.post) { toast('这份草稿已经没了', true); renderDrafts(); return; }
    var base = realId
      ? state.posts.filter(function (p) { return p.id === realId; })[0]
      : null;
    openEditor(base || null);
    // 用户点的是「继续写」—— 直接接着写，不再弹一次「要恢复吗」
    state.editing = shallowCopy(draft.post);
    state.editing.tags = (draft.post.tags || []).slice();
    fillForm(state.editing);
    $('#draft-banner').hidden = true;
    toast('已打开草稿');
  }

  function deleteDraft(key) {
    var id = key.slice(DRAFT_PREFIX.length);
    if (!confirm('删掉这份草稿？删了就找不回来了。')) return;
    clearDraft(id === '__new__' ? '' : id);
    renderDrafts();
    toast('草稿已删除');
  }

  var draftTimer = null;
  function scheduleDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 700);
  }

  function isDirty() {
    if (!state.editing || !state.original) return false;
    return JSON.stringify(state.editing) !== JSON.stringify(state.original);
  }

  /* ======================================================================
     编辑器
     ====================================================================== */

  /* 站点默认作者，和 write.config.js 里的 defaultAuthor 保持一致 */
  function defaultAuthor() {
    return CFG.defaultAuthor || 'Ever Eternity';
  }

  /* 正文的字数 / 阅读时长。走 markdown.js 的 MD.readingLabel() —— 和文章页
     是**同一个函数**，所以编辑器里显示的数字和发布后文章页上的永远一致。
     ⚠️ 只算 #f-content（标题、导语、标签都不算正文）。 */
  function updateCount() {
    var el = $('#f-count');
    if (el) el.textContent = MD.readingLabel($('#f-content').value);
  }

  /* ---------- 标签快捷按钮 ----------
     用户 2026-09-30 提的：手打标签容易打成「随笔 」「随笔」「随笔,」好几种，
     站点里就多出几个看着一样、其实不是一个的标签。
     所以在输入框下面把**已经用过的标签**全列出来，点一下就选上。
     ⚠️ 输入框始终是唯一的数据源，按钮只是它的快捷方式 ——
        这样「手打」和「点按钮」两条路不会各存一份状态。 */

  /* #f-tags 里现在的标签。跟 readForm() 同一套拆法，别再各写一份 */
  function currentTags() {
    return $('#f-tags').value.split(/[,，]/)
      .map(function (t) { return t.trim(); })
      .filter(Boolean);
  }

  /* 用代码改了表单里的值之后要补的事 —— 直接改 value 不会触发 input 事件 */
  function afterFieldEdit() {
    state.editing = readForm();
    scheduleDraft();
  }

  function renderTagPicks() {
    var box = $('#tag-picks');
    if (!box) return;

    var picked = currentTags();
    var known = tagOrderList();   // 已有标签，按首页标签栏的显示顺序
    // 刚手打进来、站点里还没有的新标签也要露出来 ——
    // 否则它没有对应的按钮，看着像「这个标签没选上」
    var extra = picked.filter(function (t) { return known.indexOf(t) === -1; });
    var all = known.concat(extra);
    var count = tagStats(state.posts).count;

    box.hidden = all.length === 0;
    box.innerHTML = all.map(function (t) {
      var on = picked.indexOf(t) !== -1;
      var n = count[t] || 0;
      return '<button type="button" class="tag-pick' + (on ? ' on' : '') + '"' +
        ' data-tag="' + esc(t) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
        ' title="' + (n ? '已有 ' + n + ' 篇用这个标签' : '这是个新标签') + '">' +
        esc(t) + '</button>';
    }).join('');
  }

  /* 点一个标签按钮 = 加上 / 去掉 */
  function togglePickedTag(tag) {
    var picked = currentTags();
    var i = picked.indexOf(tag);
    if (i === -1) {
      if (picked.length >= MAX_TAGS) {
        toast('一篇最多 ' + MAX_TAGS + ' 个标签', true);
        return;
      }
      picked.push(tag);
    } else {
      picked.splice(i, 1);
    }
    $('#f-tags').value = picked.join(', ');
    afterFieldEdit();
    renderTagPicks();
  }

  /* 「这篇文章显示 AI 摘要与评价」开关。
     关掉时把文本框变灰，但**内容留着** —— 不然看着像文字被删了。
     写进 JSON 的是 aiOff: true（不是把 ai 删掉），所以随时能再勾回来。 */
  function syncAiSwitch() {
    var on = $('#f-ai-on');
    var ta = $('#f-ai');
    if (on && ta) ta.disabled = !on.checked;
  }

  /* #f-score 里的「值得阅读程度」→ 整数；空着就返回 undefined（调用方据此**删掉**
     这个键，前台就什么都不显示）。

     ⚠️ 判「有没有填」看的是**字符串空不空**，不是数值真假：
        `Number('') === 0`、`!0 === true` —— 用真假值判的话，空框会被当成 0 分
        存进去，前台就冒出一个「评分 0」。0 分是合法分数，跟「没填」是两回事。
     ⚠️ 格式非法（`abc` / `150` / `8.5`）也返回 undefined，但**别指望它兜底** ——
        doSave() 里会先拦下来报错，不然用户填了东西却被静默丢掉。 */
  function scoreFromInput() {
    var el = $('#f-score');
    if (!el) return undefined;
    var raw = String(el.value || '').trim();
    if (!raw) return undefined;
    if (!/^(?:100|[0-9]|[1-9][0-9])$/.test(raw)) return undefined;
    return parseInt(raw, 10);
  }

  function fillForm(p) {
    $('#f-title').value = p.title || '';
    $('#f-date').value = p.date || todayISO();
    $('#f-tags').value = (p.tags || []).join(', ');
    renderTagPicks();
    // 导语（lede）那一栏 2026-10-04 从写作台移除了；字段本身留着，
    // 老文章的值靠下面 readForm 里 state.editing 的兜底原样带过去，不会丢。
    $('#f-source').value = p.source || '';
    $('#f-source-gone').checked = p.sourceGone === true;
    $('#f-ai').value = p.ai || '';
    $('#f-ai-on').checked = p.aiOff !== true;
    syncAiSwitch();
    // 值得阅读程度：**没有这个字段就显示空**（不是显示 0）—— 0 分是合法分数。
    // ⚠️ 用 `typeof === 'number'` 判，别用 `p.score || ''`：那样 0 分会变成空串，
    //    一保存就把人家的 0 分弄丢了。
    $('#f-score').value = typeof p.score === 'number' ? String(p.score) : '';
    $('#f-content').value = p.content || '';
    // 换了篇文章，缓存的选区就作废了
    sel.start = sel.end = 0;
    paintSelHint();
    $('#f-author').value = p.author || '';
    $('#f-hidden').checked = p.hidden === true;
    updateCount();
  }

  function readForm() {
    // ⚠️ 这里的**字面量顺序就是写进 posts.json 的键顺序**（手机保存时写作台是
    //    直接 PUT 这个 JSON 上去的，中间没有 Python 帮忙重排）。
    //    所以必须逐字对齐权威顺序（定义在 .tools/set-ai.py / migrate-score.py 的 ORDER）：
    //      id | title | date | tags | lede | source | sourceGone
    //         | content | author | hidden | ai | aiOff | score
    //    2026-10-06 之前 ai / score 被排在 content / author 前面 —— 主人手机上
    //    保存《动物农场》后远端键序变成 `…lede, ai, score, content, author`，
    //    跟本地逐字节对不上（内容一字没改，纯键序问题）。**别再挪这几个键。**
    //    条件字段（sourceGone / hidden / aiOff / score）先写占位值，
    //    下面统一 delete 掉不要的 —— delete 不会打乱剩下键的相对顺序。
    var out = {
      id: state.editing ? state.editing.id : '',
      title: $('#f-title').value.trim(),
      date: $('#f-date').value || todayISO(),
      tags: currentTags().slice(0, MAX_TAGS),
      // 导语（lede）：写作台已经没有它的输入框了（2026-10-04 移除），
      // 但**位置必须留在原处** —— 老文章的值靠 state.editing 带过来。
      // 不能干脆不管它：out 里没有这个键的话，下面那条「带上将来可能新增的字段」
      // 的兜底会把它补到对象**末尾**，字段顺序就乱了（verify-write-fields 抓到的）。
      lede: state.editing ? (state.editing.lede || '') : '',
      source: $('#f-source').value.trim(),
      // 原文已删除的允许**没有链接** —— 地址都被作者删没了，只剩这个标记
      sourceGone: $('#f-source-gone').checked ? true : null,
      content: $('#f-content').value,
      author: $('#f-author').value.trim(),
      hidden: $('#f-hidden').checked,
      ai: $('#f-ai').value.trim(),
      // 开关关掉 = 文字留着但不显示（aiOff: true）。没有文字时两个键都别留。
      aiOff: ($('#f-ai').value.trim() && !$('#f-ai-on').checked) ? true : null,
      // 值得阅读程度（0–100）。**必须写在字面量里**：写在下面那条
      // 「带上将来可能新增的字段」的兜底之后的话，编辑旧文章时
      // state.editing 里的老 score 会被补回来 —— 用户明明清空了框，
      // 一保存分数又回来了。
      score: scoreFromInput()
    };
    // 带上将来可能新增的字段，编辑旧文章时不会把它们弄丢
    // （导语 lede 就是靠这条：写作台已经没有它的输入框了，但老文章的值
    //   会被原样带过来 —— 前台 #post-lede 还在显示它）
    if (state.editing) {
      Object.keys(state.editing).forEach(function (k) {
        if (!(k in out)) out[k] = state.editing[k];
      });
    }
    // 用不到的字段就不写进 JSON，保持 posts.json 干净
    if (!out.hidden) delete out.hidden;
    if (!out.author) delete out.author;
    if (!out.ai) delete out.ai;
    if (!out.source) delete out.source;
    // 值得阅读程度留空 = 不写这个键（前台就不显示）。0 是合法分数，不走这条。
    if (out.score === undefined) delete out.score;
    if (out.sourceGone !== true) delete out.sourceGone;
    if (out.aiOff !== true) delete out.aiOff;
    return out;
  }

  /* 从标题生成一个 URL 友好的 id；taken 是已占用的 id 集合（Set） */
  function makeId(title, taken) {
    var base = String(title || '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!base) base = 'p-' + Date.now().toString(36);
    var id = base, n = 2;
    while (taken.has(id)) id = base + '-' + (n++);
    return id;
  }

  function shallowCopy(o) {
    var out = {};
    Object.keys(o || {}).forEach(function (k) { out[k] = o[k]; });
    return out;
  }

  function openEditor(post) {
    state.isNew = !post;
    if (post) {
      state.editing = shallowCopy(post);
      state.editing.tags = (post.tags || []).slice();
      state.editing.lede = post.lede || '';
      state.editing.ai = post.ai || '';
      state.editing.content = post.content || '';
    } else {
      state.editing = {
        id: '', title: '', date: todayISO(), tags: [], lede: '', ai: '',
        aiOff: false, content: '', author: '', hidden: false
      };
    }
    state.original = JSON.parse(JSON.stringify(state.editing));

    $('#edit-mode').textContent = state.isNew ? '新文章' : ('编辑 · ' + state.editing.id);
    $('#preview-wrap').hidden = true;
    $('#btn-preview').textContent = '预览';
    fillForm(state.editing);

    var draft = readDraft(state.editing.id);
    var banner = $('#draft-banner');
    if (draft && draft.post &&
        JSON.stringify(draft.post) !== JSON.stringify(state.original)) {
      var when = new Date(draft.at);
      $('#draft-text').textContent =
        '有一份未保存的草稿（' + (when.getMonth() + 1) + '月' + when.getDate() + '日 ' +
        String(when.getHours()).padStart(2, '0') + ':' +
        String(when.getMinutes()).padStart(2, '0') + '），要恢复吗？';
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }

    show('edit');
  }

  function backToList() {
    if (isDirty() && !confirm('有改动还没保存，确定要离开吗？\n（改动会留成草稿，下次可以恢复）')) {
      return;
    }
    saveDraft();
    clearTimeout(draftTimer);
    renderList();
    show('list');
  }

  function doSave() {
    var post = readForm();

    if (!post.title) { toast('标题还没写', true); $('#f-title').focus(); return; }
    if (post.title.length > 120) { toast('标题太长了', true); return; }
    if (!post.content.trim()) { toast('正文还是空的', true); $('#f-content').focus(); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(post.date)) { toast('日期格式不对', true); return; }
    if (post.author && post.author.length > 60) {
      toast('作者名太长了', true); $('#f-author').focus(); return;
    }
    // 值得阅读程度：留空是允许的（= 不显示）；填了就必须是 0–100 的整数。
    // ⚠️ 必须在这里拦 —— readForm() 里格式非法是当「没填」处理的，
    //    不拦的话用户填了 `150` 一保存就被静默丢掉，还不知道为什么。
    var scRaw = String($('#f-score').value || '').trim();
    if (scRaw && !/^(?:100|[0-9]|[1-9][0-9])$/.test(scRaw)) {
      toast('值得阅读程度要填 0–100 的整数', true); $('#f-score').focus(); return;
    }

    var list = state.posts.slice();
    var idx = post.id ? list.findIndex(function (p) { return p.id === post.id; }) : -1;
    var created = idx < 0;

    if (created) {
      var taken = new Set();
      list.forEach(function (p) { taken.add(p.id); });
      post.id = makeId(post.title, taken);
      list.push(post);
    } else {
      list[idx] = post;
    }    state.posts = list.sort(byDateDesc);

    var btn = $('#btn-save');
    btn.disabled = true;
    btn.textContent = '提交中…';

    commit((created ? '新文章：' : '更新：') + post.title)
      .then(function (data) {
        clearDraft(post.id);
        clearDraft('');
        state.original = JSON.parse(JSON.stringify(post));
        state.editing = post;
        renderList();
        show('list');
        var sha = data && data.commit && data.commit.sha ? data.commit.sha.slice(0, 7) : '';
        // ⚠️ 这两句 toast 是**故意分两段**的：
        //    第一段在 posts.json 提交成功时弹，第二段在**产物也写完之后**才弹。
        //    合起来的话主人会以为「已提交」= 全好了，然后马上关掉页面 ——
        //    而产物还在飞，手机浏览器一切后台/关页就**掐断 fetch**，
        //    文章页于是又停在旧内容上（2026-10-06 那两次保存就有这个嫌疑）。
        toast('已提交' + (sha ? '（' + sha + '）' : '') +
              (post.hidden ? '，这篇是隐藏的' : '') + '，正在更新页面数据…');
        // ⚠️ 顺手重建两个产物 —— 不重建的话文章页 / 列表页读到的还是旧数据，
        //    而且「刷新」永远刷不出来（数据源本身是旧的，不是缓存问题）。
        //    失败也不影响这次保存，所以走 quietly 版本（见它的注释）。
        return syncArtifactsQuietly(post).then(function (ok) {
          if (ok) toast('页面数据已更新' + (sha ? '（' + sha + '）' : '') + '，稍后即可看到');
        });
      })
      .catch(function (err) {
        // 提交失败：回滚内存状态，避免界面与远端不一致
        return loadPosts().catch(function () {}).then(function () {
          toast(err.message, true);
        });
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = '保存并发布';
      });
  }

  function doDelete(id, title) {
    if (!confirm('确定删掉《' + title + '》吗？\n会向仓库提交一次删除。')) return;

    var removed = state.posts.filter(function (p) { return p.id === id; })[0];
    state.posts = state.posts.filter(function (p) { return p.id !== id; });

    commit('删除：' + title)
      .then(function () {
        clearDraft(id);
        renderList();
        toast('已删除，正在更新页面数据…');
        // 列表页读的是产物 —— 不重建的话那张卡片还会留在首页上
        return syncArtifactsQuietly(removed || { id: id, title: title }, { deleted: true })
          .then(function (ok) { if (ok) toast('页面数据已更新，稍后即可看到'); });
      })
      .catch(function (err) {
        if (removed) state.posts.push(removed);
        state.posts.sort(byDateDesc);
        renderList();
        toast(err.message, true);
      });
  }

  /* 预览里的 AI 摘要与评价（2026-10-07 主人要求）。
     它跟正文一样支持 Markdown，光看文本框看不出渲染效果，所以预览要带上。
     位置和文章页一致：正文**上面**；**折叠形式和文章页也是同一套 class**
     （`.ai-intro.open` ↔ `.ai-intro-body` 的 grid-template-rows 动画）。
     ⚠️ 三种情况要分清，别糊成一种：
       · 没写内容     → 整块不出现（文章页也是这样）
       · 写了但关掉开关 → **不渲染内容**，只留一条灰字说明
                          （文章页那时也不显示，预览不能骗人）
       · 写了且开着   → 正常渲染 */
  function renderPreviewAi() {
    var box = $('#preview-ai');
    if (!box) return;              // 壳还没更新（老 HTML），别把整页弄崩
    var el = $('#f-ai');
    var text = ((el && el.value) || '').trim();
    var inner = $('#preview-ai-inner');
    var off = $('#preview-ai-off');
    var btn = $('#preview-ai-toggle');
    var aiBox = $('#preview-ai-box');
    var on = $('#f-ai-on') ? $('#f-ai-on').checked : true;
    if (!text) {
      box.hidden = true;
      inner.innerHTML = '';
      off.hidden = true;
      return;
    }
    box.hidden = false;
    off.hidden = on;
    inner.innerHTML = on ? MD.render(text) : '';
    /* 折叠：跟文章页 app.js 的 initAiIntro() **同一套切换**（class + aria-expanded），
       样式全靠 style.css 的 `.ai-intro.open`，这里不碰任何尺寸。
       ⚠️ 用 `onclick =` 赋值而不是 addEventListener —— 这个函数**每点一次预览都会跑**，
          addEventListener 会一层层叠上去（点一下切换好几次）。
       ⚠️ 折叠状态**不重置**：主人收起来之后再看预览，还是收着的。 */
    if (btn && aiBox) {
      btn.onclick = function () {
        var open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        aiBox.classList.toggle('open', !open);
      };
    }
  }

  function togglePreview() {
    var wrap = $('#preview-wrap');
    if (!wrap.hidden) {
      wrap.hidden = true;
      $('#btn-preview').textContent = '预览';
      return;
    }
    $('#preview').innerHTML = MD.render($('#f-content').value);
    renderPreviewAi();
    wrap.hidden = false;
    $('#btn-preview').textContent = '收起预览';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ======================================================================
     插入图片
     ----------------------------------------------------------------------
     选图（或直接粘贴截图）→ 在浏览器里重压 → 走 Contents API 传到
     assets/img/post/ → 在光标处插入 ![](assets/img/post/xxx.jpg)。
     图片和文章是**两次独立提交**：图先传，文章要等点「保存并发布」。
     所以传完图但没保存就离开，仓库里会留下一张没人引用的图 —— 不致命。
     ====================================================================== */

  /* 压到长边 IMG_MAX_EDGE 以内。PNG 可能有透明，继续存 PNG；其余一律 JPEG。 */
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        URL.revokeObjectURL(url);
        if (!w || !h) { reject(new Error('读不出这张图的尺寸')); return; }

        var scale = Math.min(1, IMG_MAX_EDGE / Math.max(w, h));
        var tw = Math.max(1, Math.round(w * scale));
        var th = Math.max(1, Math.round(h * scale));

        var canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, tw, th);

        var isPng = /png/i.test(file.type);
        var type = isPng ? 'image/png' : 'image/jpeg';
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('浏览器没能把这张图转出来')); return; }
          resolve({ blob: blob, ext: isPng ? 'png' : 'jpg', w: tw, h: th });
        }, type, IMG_QUALITY);
      };

      // iPhone 的 HEIC 在 Safari 里能解开、在别的浏览器里解不开，
      // 这条错误提示就是给后者看的。
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('这个文件浏览器解不开（HEIC 之类），先转成 JPG 再传'));
      };

      img.src = url;
    });
  }

  function blobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var s = String(fr.result || '');
        var comma = s.indexOf(',');
        if (comma < 0) { reject(new Error('读文件失败')); return; }
        resolve(s.slice(comma + 1));
      };
      fr.onerror = function () { reject(new Error('读文件失败')); };
      fr.readAsDataURL(blob);
    });
  }

  /* 名字带上日期和时间戳：既看得出是哪天传的，又不会和已有的撞上
     （Contents API 覆盖同名文件要带 sha，不带就是 422）。 */
  function imageName(ext) {
    var d = new Date();
    var day = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') +
              String(d.getDate()).padStart(2, '0');
    return 'img-' + day + '-' + Date.now().toString(36) +
           Math.random().toString(36).slice(2, 5) + '.' + ext;
  }

  function uploadImage(file) {
    return compressImage(file).then(function (out) {
      return blobToB64(out.blob).then(function (b64) {
        var path = IMG_DIR + '/' + imageName(out.ext);
        return gh(contentsPathOf(path), {
          method: 'PUT',
          body: {
            message: '图片：' + path.split('/').pop(),
            content: b64,
            branch: CFG.branch || 'main'
          }
        }).then(function () {
          return { path: path, w: out.w, h: out.h, bytes: out.blob.size };
        });
      });
    });
  }

  /* 插到光标处。图片单独占一行 —— 前后紧贴着文字的话，Markdown 渲染出来
     会和文字挤在同一段里。 */
  function insertAtCursor(ta, text) {
    var start = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    var end = ta.selectionEnd == null ? start : ta.selectionEnd;
    var before = ta.value.slice(0, start);
    var after = ta.value.slice(end);
    var head = (before && !/\n$/.test(before)) ? '\n\n' : '';
    var tail = (after && !/^\n/.test(after)) ? '\n\n' : '';
    var chunk = head + text + tail;

    ta.value = before + chunk + after;
    var pos = (before + chunk).length;
    ta.selectionStart = ta.selectionEnd = pos;
    ta.focus();
  }

  /* 一张一张串着传：GitHub 的 Contents API 没有批量接口，
     并发 PUT 还可能互相撞 sha，慢一点但不会出错。 */
  function insertImages(files) {
    var list = [].slice.call(files || []);
    if (!list.length) return;

    var tooBig = list.filter(function (f) { return f.size > IMG_MAX_BYTES; });
    if (tooBig.length) {
      toast(tooBig.length + ' 张图超过 ' +
            Math.round(IMG_MAX_BYTES / 1024 / 1024) + 'MB，先压一下再传', true);
      list = list.filter(function (f) { return f.size <= IMG_MAX_BYTES; });
      if (!list.length) return;
    }

    var ta = $('#f-content');
    var btn = $('#btn-image');
    var hint = $('#image-hint');
    var HINT_IDLE = '照片会自动压到长边 ' + IMG_MAX_EDGE + 'px 以内再传';
    var done = 0, failed = 0;

    btn.disabled = true;

    function step(i) {
      if (i >= list.length) {
        btn.disabled = false;
        hint.textContent = HINT_IDLE;
        toast(failed ? ('插入了 ' + done + ' 张，' + failed + ' 张没传上去')
                     : ('已插入 ' + done + ' 张图片'), failed > 0);
        // 直接改 textarea.value 不会触发 input 事件，草稿和「有改动」得自己叫一次
        state.editing = readForm();
        scheduleDraft();
        updateCount();
        return;
      }
      hint.textContent = '正在上传 ' + (i + 1) + ' / ' + list.length + '…';
      uploadImage(list[i]).then(function (info) {
        insertAtCursor(ta, '![](' + info.path + ')');
        done++;
      }).catch(function (err) {
        failed++;
        toast(err.message, true);
      }).then(function () { step(i + 1); });
    }

    step(0);
  }

  /* ======================================================================
     正文的剪切 / 复制 / 粘贴 / 删除 / 撤销 / 重做
     ----------------------------------------------------------------------
     手机上长按输入框弹出来的系统菜单又长又挡字，「剪切」「删除」经常翻半天
     找不到，所以自己给一排按钮。
     ⚠️ 两个坑：
       ① 点按钮时正文框会失焦，浏览器可能顺手把选区清掉 → 所以选区要**提前
          缓存**（selectionchange 一路记着），用时再还原回去。
       ② 删除/粘贴必须走 execCommand，不能自己拼字符串替换 value —— 自己拼
          会绕过浏览器的撤销栈，删错了按「撤销」也回不来。
     ====================================================================== */

  // 正文框里最后一次有效选区（只在它还是焦点时更新，失焦后 selectionStart 不可信）
  var sel = { start: 0, end: 0 };

  function paintSelHint() {
    var el = $('#sel-hint');
    if (!el) return;
    var n = Math.max(0, sel.end - sel.start);
    el.textContent = n ? ('已选中 ' + n + ' 字') : '未选中文字';
    el.classList.toggle('on', n > 0);
  }

  function rememberSel() {
    var ta = $('#f-content');
    if (!ta || document.activeElement !== ta) return;
    sel.start = ta.selectionStart == null ? 0 : ta.selectionStart;
    sel.end = ta.selectionEnd == null ? sel.start : ta.selectionEnd;
    paintSelHint();
  }

  // 把焦点和选区还给正文框（点按钮已经把焦点抢走了）
  function restoreSel() {
    var ta = $('#f-content');
    ta.focus();
    ta.selectionStart = sel.start;
    ta.selectionEnd = sel.end;
    return ta;
  }

  // 改完正文要补的事（input 事件不会自己来）。前两件跟别的字段一样，
  // 后两件是正文特有的：字数和选区提示。
  function afterTextEdit() {
    afterFieldEdit();
    updateCount();
    rememberSel();
    paintSelHint();
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // file:// 或老浏览器上没有 navigator.clipboard，退回老办法
    return new Promise(function (resolve, reject) {
      var tmp = document.createElement('textarea');
      tmp.value = text;
      tmp.setAttribute('readonly', '');
      tmp.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(tmp);
      tmp.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(tmp);
      ok ? resolve() : reject(new Error('复制失败'));
    });
  }

  function initTextTools() {
    var ta = $('#f-content');
    if (!ta || !$('#btn-cut')) return;

    ['select', 'keyup', 'mouseup', 'touchend', 'input', 'focus']
      .forEach(function (ev) { ta.addEventListener(ev, rememberSel); });
    document.addEventListener('selectionchange', rememberSel);

    function needSelection() {
      if (sel.end > sel.start) return true;
      toast('先选中要处理的文字', true);
      return false;
    }

    $('#btn-cut').addEventListener('click', function () {
      if (!needSelection()) return;
      var text = ta.value.slice(sel.start, sel.end);
      copyText(text).catch(function () { /* 复制失败也让删除继续，别把人卡住 */ })
        .then(function () {
          restoreSel();
          document.execCommand('delete');
          afterTextEdit();
          toast('已剪切 ' + text.length + ' 字');
        });
    });

    $('#btn-copy').addEventListener('click', function () {
      if (!needSelection()) return;
      var text = ta.value.slice(sel.start, sel.end);
      copyText(text).then(function () {
        toast('已复制 ' + text.length + ' 字');
      }).catch(function () {
        toast('复制失败，长按输入框用系统菜单试试', true);
      });
    });

    $('#btn-paste').addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        toast('这个浏览器不让读剪贴板，长按输入框用系统菜单粘贴', true);
        return;
      }
      navigator.clipboard.readText().then(function (text) {
        if (!text) { toast('剪贴板是空的'); return; }
        restoreSel();
        document.execCommand('insertText', false, text);
        afterTextEdit();
        toast('已粘贴 ' + text.length + ' 字');
      }).catch(function () {
        toast('读不到剪贴板，长按输入框用系统菜单粘贴', true);
      });
    });

    $('#btn-del').addEventListener('click', function () {
      if (!needSelection()) return;
      var n = sel.end - sel.start;
      restoreSel();
      document.execCommand('delete');
      afterTextEdit();
      toast('已删除 ' + n + ' 字');
    });

    $('#btn-undo').addEventListener('click', function () {
      restoreSel();
      document.execCommand('undo');
      afterTextEdit();
    });

    $('#btn-redo').addEventListener('click', function () {
      restoreSel();
      document.execCommand('redo');
      afterTextEdit();
    });
  }

  function doExport() {
    var blob = new Blob([JSON.stringify(state.posts, null, 2) + '\n'],
                        { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'posts-' + todayISO() + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    toast('已导出备份');
  }

  /* ======================================================================
     站点信息（data/site.json）
     ----------------------------------------------------------------------
     首页那段自我介绍、关于页、页脚落款。跟文章一样是一次 commit。
     字段顺序固定，方便看 diff；也为空就删掉，保持文件干净。
     ====================================================================== */

  var DEFAULT_SITE = {
    hero: { title: '', tagline: '', chips: [] },
    about: { sub: '', now: { title: '', items: [] }, body: '' },
    footer: { note: '' }
  };

  function loadSite() {
    // ⚠️ 同样走 ghTextFile：site.json 现在很小，但万一哪天写长了超过 1MB，
    //    Contents API 会同样不给内容（跟 posts.json 一个坑）。
    return ghTextFile(sitePath(), CFG.branch || 'main').then(function (data) {
      state.siteSha = data.sha;
      var obj = parseFileJson(data.text, 'site.json');
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        throw new Error('site.json 格式不对：顶层应该是一个对象');
      }
      state.site = obj;
      return true;                       // true = 远端有这个文件
    }).catch(function (err) {
      if (err.status === 404) {          // 还没有这个文件：从空开始，保存时会创建
        state.siteSha = null;
        state.site = JSON.parse(JSON.stringify(DEFAULT_SITE));
        return false;
      }
      throw err;
    });
  }

  /* 「此刻」条目在界面里是「名称 | 内容」一行一条 */
  function nowToLines(now) {
    return ((now && now.items) || []).map(function (it) {
      return (it.label || '') + ' | ' + (it.text || '');
    }).join('\n');
  }

  function linesToNow(text) {
    return String(text || '').split('\n').map(function (ln) {
      var i = ln.indexOf('|');
      var label = (i < 0 ? ln : ln.slice(0, i)).trim();
      var val = (i < 0 ? '' : ln.slice(i + 1)).trim();
      return { label: label, text: val };
    }).filter(function (it) {
      return it.label || it.text;
    }).slice(0, 12);
  }

  function fillSiteForm() {
    var s = state.site || DEFAULT_SITE;
    var hero = s.hero || {}, about = s.about || {}, now = about.now || {};
    var footer = s.footer || {};

    $('#s-hero-title').value = hero.title || '';
    $('#s-hero-tagline').value = hero.tagline || '';
    $('#s-hero-chips').value = (hero.chips || []).join(', ');
    $('#s-about-sub').value = about.sub || '';
    $('#s-now-title').value = now.title || '';
    $('#s-now-items').value = nowToLines(now);
    $('#s-about-body').value = about.body || '';
    $('#s-footer-note').value = footer.note || '';

    $('#site-preview-wrap').hidden = true;
    $('#btn-site-preview').textContent = '预览关于页';
  }

  function readSiteForm() {
    return {
      hero: {
        title: $('#s-hero-title').value.trim(),
        tagline: $('#s-hero-tagline').value.trim(),
        chips: $('#s-hero-chips').value.split(/[,，]/)
                 .map(function (t) { return t.trim(); })
                 .filter(Boolean).slice(0, 6)
      },
      about: {
        sub: $('#s-about-sub').value.trim(),
        now: {
          title: $('#s-now-title').value.trim(),
          items: linesToNow($('#s-now-items').value)
        },
        body: $('#s-about-body').value
      },
      footer: {
        note: $('#s-footer-note').value.trim()
      }
    };
  }

  function isSiteDirty() {
    if (!state.site) return false;
    return JSON.stringify(readSiteForm()) !== JSON.stringify(state.site);
  }

  function openSite() {
    var btn = $('#btn-site');
    btn.disabled = true;
    loadSite().then(function (exists) {
      fillSiteForm();
      // 基线设成「表单现在的样子」，这样脏检查只反映用户自己的改动
      state.site = readSiteForm();
      $('#site-missing').hidden = (exists !== false);
      show('site');
    }).catch(function (err) {
      toast(err.message, true);
    }).then(function () {
      btn.disabled = false;
    });
  }

  function backFromSite() {
    if (isSiteDirty() && !confirm('站点信息有改动还没保存，确定要离开吗？')) return;
    state.site = null;                   // 下次进来重新拉一遍，拿到最新的 sha
    renderList();
    show('list');
  }

  function saveSite() {
    var site = readSiteForm();
    var btn = $('#btn-site-save');
    btn.disabled = true;
    btn.textContent = '提交中…';

    var body = {
      message: '更新站点信息',
      content: b64encode(JSON.stringify(site, null, 2) + '\n'),
      branch: CFG.branch || 'main'
    };
    if (state.siteSha) body.sha = state.siteSha;

    gh(contentsPathOf(sitePath()), { method: 'PUT', body: body }).then(function (data) {
      if (data && data.content && data.content.sha) state.siteSha = data.content.sha;
      state.site = site;
      $('#site-missing').hidden = true;
      var sha = data && data.commit && data.commit.sha ? data.commit.sha.slice(0, 7) : '';
      toast('已提交' + (sha ? '（' + sha + '）' : '') + '，网站约 1 分钟后更新');
    }).catch(function (err) {
      // 撞车（文件在别处被改过）：重新拉一次，免得下次还带着过期的 sha
      return loadSite().catch(function () {}).then(function () {
        toast(err.message, true);
      });
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '保存并发布';
    });
  }

  function toggleSitePreview() {
    var wrap = $('#site-preview-wrap');
    if (!wrap.hidden) {
      wrap.hidden = true;
      $('#btn-site-preview').textContent = '预览关于页';
      return;
    }
    var about = readSiteForm().about;
    $('#site-preview').innerHTML =
      '<p class="sub">' + esc(about.sub) + '</p>' +
      SITE.aboutBodyHTML(about.body, about.now);
    wrap.hidden = false;
    $('#btn-site-preview').textContent = '收起预览';
    wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ======================================================================
     页头的「同步最新」按钮（2026-10-06 加）
     ======================================================================

     写作台**自己**也被 GitHub Pages 缓存 10 分钟（所有文件都是
     `Cache-Control: max-age=600`）。所以「我刚改了写作台的布局/字段，手机上打开
     还是老样子」这件事，在这里同样会发生 —— 而写作台恰恰是主人手机上用得最多的页面。

     前台那五个页面用的是 `app.js` 的 `initSync()`；写作台不加载 `app.js`，
     所以这里再绑一次。**两处逻辑必须保持一致**（改一处记得改另一处）。

     ⚠️⚠️ 原来这里也是「加一个 ?v=<时间戳> 重新进当前页」—— **那是错的**。
        2026-10-06 实测（`_preview/_probe-cdn-cache.py`）：GitHub Pages 的 CDN
        **缓存键不含 query**，两个全新的参数拿到的是同一个缓存对象；
        连请求头 `Cache-Control: no-cache`（硬刷新）也照样命中 HIT。
        → 改成**让路径本身变**：路径中间塞进若干个重复斜杠，
          CDN 把它当另一个文件，第一次请求必定 MISS 回源。
        完整原理、实测数据和「为什么只能用重复斜杠不能用 `/./`」
        都写在 `app.js` 的 `initSync()` 上面，**要看就去那边看**，别在这边重写一遍。

     ⚠️ 点了会重载页面 —— 没保存的正文靠草稿（scheduleDraft）兜底，恢复横幅会出来。
        所以这个按钮别做得太显眼，也别做成自动触发。 */
  function initSync() {
    var btn = $('.sync-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      try { sessionStorage.setItem('ee-sync', String(Date.now())); } catch (e) { /* ignore */ }
      btn.classList.add('is-busy');
      btn.disabled = true;
      location.replace(syncVariantUrl());
    });
  }

  /* 当前页面的一份「路径带重复斜杠」的副本（和 app.js 里同名函数一致）。
     ⚠️ 斜杠数量每次不同，否则第二次点就命中缓存了。 */
  function syncVariantUrl() {
    // ⚠️ file:// 下 location.origin 是字符串 "null"（见 app.js 同名函数的注释）
    if (!/^https?:$/.test(location.protocol)) return location.href;
    var slashes = new Array(2 + (Date.now() % 200) + 1).join('/');
    var path = location.pathname.replace(/^\/+/, '');
    return location.origin + '/' + slashes + path + location.search + location.hash;
  }

  /* ======================================================================
     绑定
     ====================================================================== */

  function bind() {
    /* ---------- 连接 ---------- */
    $('#btn-connect').addEventListener('click', function () {
      var btn = this;
      var token = $('#f-token').value.trim();
      if (!token) { toast('先贴上令牌', true); $('#f-token').focus(); return; }

      btn.disabled = true;
      btn.textContent = '连接中…';
      connect(token).catch(function (err) {
        state.token = '';
        toast(err.message, true);
      }).then(function () {
        btn.disabled = false;
        btn.textContent = '连接';
      });
    });

    $('#f-token').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('#btn-connect').click(); }
    });

    $('#btn-new').addEventListener('click', function () {
      if (!guardBatch()) return;
      openEditor(null);
    });
    $('#btn-back').addEventListener('click', backToList);
    $('#btn-save').addEventListener('click', doSave);
    $('#btn-preview').addEventListener('click', togglePreview);

    /* ---------- 插入图片 ---------- */
    $('#btn-image').addEventListener('click', function () { $('#f-image').click(); });
    $('#f-image').addEventListener('change', function () {
      insertImages(this.files);
      // 清空，否则「再选一次同一个文件」不会触发 change
      this.value = '';
    });
    // 电脑上直接 Ctrl+V 粘截图比走文件选择器顺手得多
    $('#f-content').addEventListener('paste', function (e) {
      var items = (e.clipboardData && e.clipboardData.items) || [];
      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;   // 粘的是文字就按默认行为走
      e.preventDefault();
      insertImages(files);
    });
    /* ---------- 正文的剪切 / 复制 / 粘贴 / 删除 / 撤销 / 重做 ---------- */
    initTextTools();

    $('#btn-refresh').addEventListener('click', refresh);
    $('#btn-export').addEventListener('click', doExport);

    /* ---------- 站点信息 ---------- */
    $('#btn-site').addEventListener('click', openSite);
    $('#btn-site-back').addEventListener('click', backFromSite);
    $('#btn-site-save').addEventListener('click', saveSite);
    $('#btn-site-preview').addEventListener('click', toggleSitePreview);

    $('#btn-disconnect').addEventListener('click', function () {
      if (!guardBatch()) return;
      if (!confirm('断开写作台？\n\n会清掉这台设备上记住的令牌，下次要重新贴一次。\n' +
                   '（文章不受影响）')) return;
      disconnect();
      toast('已断开');
    });

    $('#list').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn || btn.disabled) return;
      var id = btn.closest('li').getAttribute('data-id');
      var act = btn.getAttribute('data-act');

      // 批量编辑的行内操作：改的是内存里的 state.posts，点「保存全部改动」才提交
      if (act === 'toggle-hidden') return toggleHidden(id);
      if (act === 'rmtag') return removeTag(id, btn.getAttribute('data-tag'));

      if (act === 'up') return movePost(id, -1);
      if (act === 'down') return movePost(id, 1);
      if (act === 'top') return movePost(id, 'top');

      if (act === 'preview') {
        // 再点同一篇 = 收起；点别的篇 = 换成展开那一篇
        state.previewId = (state.previewId === id) ? '' : id;
        renderList();
        return;
      }

      var post = state.posts.filter(function (p) { return p.id === id; })[0];
      if (!post) return;
      if (act === 'edit') openEditor(post);
      else doDelete(id, post.title);
    });

    // 批量编辑：行内「＋标签」回车就加上。
    // 加完要重新聚焦这一行的输入框 —— renderList() 会把整行重建，
    // 不补这一下的话，想连加两个标签就得重新点一次。
    $('#list').addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var input = e.target.closest && e.target.closest('input.row-tag-input');
      if (!input) return;
      e.preventDefault();
      var id = input.closest('li').getAttribute('data-id');
      if (!addTag(id, input.value)) return;
      var again = $('#list li[data-id="' +
        (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"] input.row-tag-input');
      if (again) again.focus();
    });

    $('#btn-batch').addEventListener('click', function () {
      if (state.batch) cancelBatch();
      else enterBatch();
    });
    $('#btn-batch-save').addEventListener('click', saveBatch);
    $('#btn-batch-cancel').addEventListener('click', cancelBatch);

    /* ---------- 拖拽排序（文章列表 + 标签总览） ---------- */
    registerDragZones();
    initDrag();

    /* ---------- 标签总览（顶栏那个 + 批量编辑里那个，通向同一屏） ---------- */
    $('#btn-tags').addEventListener('click', openTagOverview);
    $('#btn-batch-tags').addEventListener('click', openTagOverview);
    $('#btn-tags-save').addEventListener('click', saveTagOverview);
    $('#btn-tags-cancel').addEventListener('click', backFromTags);
    $('#btn-tags-back').addEventListener('click', backFromTags);
    $('#tag-edit-list').addEventListener('input', renderTagsSummary);
    $('#tag-edit-list').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveTagOverview(); }
    });

    /* ---------- 草稿箱 ---------- */
    $('#btn-drafts').addEventListener('click', openDrafts);
    $('#btn-drafts-back').addEventListener('click', function () {
      renderList();
      show('list');
    });
    $('#draft-list').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-draft]');
      if (!btn) return;
      if (btn.getAttribute('data-act') === 'open') {
        return openDraft(btn.getAttribute('data-draft'));
      }
      return deleteDraft(btn.getAttribute('data-draft'));
    });

    /* ---------- 搜索（口径跟站外首页一致，另加「作者」） ---------- */
    var searchBox = $('#admin-search');
    function runAdminSearch() {
      var q = searchBox.value.trim().toLowerCase();
      // ⚠️ 「上次搜过什么」记在**输入框自己身上**，不能放闭包变量 ——
      //    renderList() 在批量编辑时会把搜索框清空，而那个函数够不到这个闭包。
      if (q === searchBox.__eeLastQ) return;
      searchBox.__eeLastQ = q;
      state.q = q;
      var clr = $('#btn-search-clear');
      if (clr) clr.hidden = !searchBox.value;
      renderList();
    }
    if (searchBox) {
      /* ⚠️ 中文输入法打字时 `input` 事件**在拼音上屏之前**就会一直触发
         （跟站外首页是同一个坑，主人 2026-10-07 一并提的）。
         composition 期间一律不搜；上屏后再补搜一次（Chrome 的 compositionend
         后面还会跟一个 input，Safari 不跟，所以两边都调 runAdminSearch，靠
         searchLastQ 去重）。 */
      var searchComposing = false;
      searchBox.addEventListener('compositionstart', function () { searchComposing = true; });
      searchBox.addEventListener('compositionend', function () {
        searchComposing = false;
        runAdminSearch();
      });
      searchBox.addEventListener('input', function (e) {
        if (searchComposing || e.isComposing) return;
        runAdminSearch();
      });
    }
    var searchClear = $('#btn-search-clear');
    if (searchClear) {
      searchClear.addEventListener('click', function () {
        if (searchBox) { searchBox.value = ''; searchBox.focus(); }
        searchBox.__eeLastQ = null;          // 清空后同名的词也要能再搜一次
        runAdminSearch();
      });
    }

    var tagbar = $('#admin-tagbar');
    if (tagbar) {
      tagbar.addEventListener('click', function (e) {
        var btn = e.target.closest('.tag-btn');
        if (!btn) return;
        state.filterTag = btn.getAttribute('data-tag') || '';
        renderList();
      });
    }

    $('#btn-draft-restore').addEventListener('click', function () {
      var draft = readDraft(state.editing.id);
      if (!draft || !draft.post) return;
      state.editing = draft.post;
      fillForm(draft.post);
      $('#draft-banner').hidden = true;
      toast('草稿已恢复');
    });

    $('#btn-draft-discard').addEventListener('click', function () {
      clearDraft(state.editing.id);
      $('#draft-banner').hidden = true;
      toast('草稿已丢弃');
    });

    ['#f-title', '#f-date', '#f-tags', '#f-source', '#f-source-gone',
     '#f-ai', '#f-ai-on', '#f-content', '#f-author', '#f-hidden']
      .forEach(function (sel) {
        var el = $(sel);
        var onEdit = function () {
          afterFieldEdit();
          updateCount();
        };
        el.addEventListener('input', onEdit);
        el.addEventListener('change', onEdit);
      });

    // 关掉 AI 开关时把文本框变灰（内容留着），别让人以为文字被删了
    var aiOnEl = $('#f-ai-on');
    if (aiOnEl) aiOnEl.addEventListener('change', syncAiSwitch);

    /* ---------- 标签快捷按钮（输入框下面那排已有标签） ---------- */
    // 手打标签时下面那排的高亮要跟着变：打了「随笔」，「随笔」那颗就该亮起来
    $('#f-tags').addEventListener('input', renderTagPicks);

    $('#tag-picks').addEventListener('click', function (e) {
      var btn = e.target.closest('.tag-pick');
      if (btn) togglePickedTag(btn.getAttribute('data-tag') || '');
    });

    window.addEventListener('beforeunload', function (e) {
      var dirty = (!$('#view-edit').hidden && isDirty()) ||
                  (!$('#view-site').hidden && isSiteDirty()) ||
                  (!$('#view-tags').hidden && (tagsDirty() || tagOrderDirty())) ||
                  (state.batch && batchDirty());
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) saveDraft();
    });
  }

  /* ======================================================================
     启动
     ====================================================================== */

  document.addEventListener('DOMContentLoaded', function () {
    // ⚠️ 放在最前面：下面有好几个提前 return 的分支（没配仓库、没令牌），
    //    写在后面的话那些情况下按钮就是个死的。
    initSync();
    bind();
    renderRepoInfo();
    renderConnect();

    if (!CFG.owner || !CFG.repo) { show('connect'); return; }

    // 本地双击打开（file://）也能正常用：GitHub API 允许跨域，令牌也存得下。
    // 只是顺手提一句还有本地服务这条路。
    if (location.protocol === 'file:') {
      var hint = document.createElement('p');
      hint.className = 'lead';
      hint.style.cssText = 'margin:16px 0 0;font-size:13.5px';
      hint.innerHTML = '你正在本地打开这个页面，功能完全可用。' +
        '如果浏览器拦了跨域请求，可以改用 <code>node .tools/preview.js</code> 起本地服务。';
      $('#view-connect .admin-card').appendChild(hint);
    }

    // 先站在连接页：自动登录要发几个网络请求，期间页面不能是空白的
    show('connect');

    var saved = '';
    try { saved = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) { /* ignore */ }
    if (!saved) return;                       // 没贴过令牌，等用户贴

    var btn = $('#btn-connect');
    btn.disabled = true;
    btn.textContent = '正在自动登录…';

    connect(saved).catch(function (err) {
      setToken('');
      show('connect');
      toast('自动登录失败：' + err.message + '，请重新贴一次令牌', true);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = '连接';
    });
  });

})();
