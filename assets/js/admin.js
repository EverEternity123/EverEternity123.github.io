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
    posts: [],        // 按**显示顺序**排好的文章（自定义顺序 + 新文章在最前）
    editing: null,
    original: null,
    isNew: true,
    filterTag: '',    // 列表页当前选中的标签，'' = 全部
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
    ['connect', 'list', 'edit', 'site', 'tags'].forEach(function (v) {
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

  /* 仓库里任意一个文件的 Contents API 地址 */
  function contentsPathOf(p) {
    return '/repos/' + encodeURIComponent(CFG.owner) + '/' +
           encodeURIComponent(CFG.repo) + '/contents/' +
           String(p || '').split('/').map(encodeURIComponent).join('/');
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
     一句话：不在 order.json 里的文章（＝新发的）按日期排在最前面，
     在里面的按列表顺序排在后面。标签同理，没记过的排在后面。
     ====================================================================== */

  /* order.json 的内容 → { ids: [...], tags: [...] }。
     文件坏掉就当没排过序，不阻断列表；老文件没有 tags 字段也一样。 */
  function parseOrder(content) {
    var empty = { ids: [], tags: [] };
    try {
      var obj = JSON.parse(b64decode(content));
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
    var ref = encodeURIComponent(CFG.branch || 'main');
    return Promise.all([
      gh(contentsPath() + '?ref=' + ref),
      // order.json 是后加的文件，老仓库里可能还没有 —— 404 当成「没排过序」
      gh(contentsPathOf(orderPath()) + '?ref=' + ref).catch(function (e) {
        if (e.status === 404) return null;
        throw e;
      })
    ]).then(function (both) {
      var data = both[0], odata = both[1];
      if (!data || typeof data.content !== 'string') {
        throw new Error('文件内容读取失败');
      }
      state.sha = data.sha;
      var list = JSON.parse(b64decode(data.content));
      if (!Array.isArray(list)) throw new Error('posts.json 格式不对：顶层应该是数组');

      state.orderSha = odata ? odata.sha : null;
      state.order = odata ? parseOrder(odata.content) : { ids: [], tags: [] };
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
  function visiblePosts() {
    if (!state.filterTag) return state.posts;
    return state.posts.filter(function (p) {
      return (p.tags || []).indexOf(state.filterTag) !== -1;
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
    if (batch) state.filterTag = '';
    renderTagbar();
    var tagbarEl = $('#admin-tagbar');
    if (tagbarEl && batch) tagbarEl.hidden = true;

    var shown = visiblePosts();
    $('#count-pill').textContent = state.filterTag
      ? shown.length + ' / ' + state.posts.length + ' 篇'
      : state.posts.length + ' 篇';

    var empty = $('#list-empty');
    empty.hidden = shown.length > 0;
    empty.textContent = batch
      ? '还没有文章，没什么可编辑的。'
      : (state.filterTag
          ? '没有「' + state.filterTag + '」标签的文章。'
          : '还没有文章，点右上角开始写第一篇。');

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
      btnBatch.textContent = batch ? '批量编辑中' : '批量编辑';
      btnBatch.classList.toggle('on', batch);
    }

    ul.innerHTML = shown.map(function (p, i) {
      var isHidden = p.hidden === true;
      // 作者栏空着 = 用默认署名 = 站主自己写的 → 标「原创」，跟前台卡片一致
      var author = p.author
        ? '<span class="pill pill-author">' + esc(p.author) + '</span>'
        : '<span class="pill pill-original">原创</span>';
      var hiddenPill = isHidden ? '<span class="pill pill-hidden">已隐藏</span>' : '';
      var metaStart = '<div class="meta"><span>' + fmtDate(p.date) + '</span>' + hiddenPill;

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

      return '' +
        '<li data-id="' + esc(p.id) + '"' +
            (isHidden ? ' class="is-hidden"' : '') + '>' +
          // 批量编辑下这个序号同时是**拖拽把手**（CSS 里 touch-action:none，
          // 手指按住它才不会变成滚页面；鼠标则整行都能拖）
          (batch
            ? '<span class="ord" title="按住拖动" aria-label="拖动排序">' +
              (i + 1) + '</span>'
            : '') +
          inner +
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

  /* 保存批量编辑：标签 / 公开状态进 posts.json，文章顺序 + 标签顺序进 order.json。
     Contents API 一次只能写一个文件，所以两处都有改动时就是两次提交；
     任一步失败都重新拉一遍，别让界面跟远端不一致。 */
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
        toast('已保存 ' + parts.join(' + ') + '，网站约 1 分钟后更新');
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

    renderTagsSummary();
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
  function applyTagOverview() {
    var rows = readTagEdit();
    var map = {};
    var changed = 0;
    var i;

    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.to.length > MAX_TAG_LEN) {
        toast('「' + r.to + '」太长了（最多 ' + MAX_TAG_LEN + ' 个字）', true);
        return;
      }
      if (r.to === r.from) continue;
      map[r.from] = r.to;                       // '' = 从所有文章上移除
      changed++;
    }

    if (!changed) { toast('标签没有改动'); return; }

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

    state.tagEdit = null;
    renderList();
    show('list');
    toast('已改 ' + hit + ' 篇的标签，别忘了点「保存全部改动」');
  }

  function backFromTags() {
    if (tagsDirty() && !window.confirm('标签总览里有改动还没应用，确定放弃吗？')) return;
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

  function fillForm(p) {
    $('#f-title').value = p.title || '';
    $('#f-date').value = p.date || todayISO();
    $('#f-tags').value = (p.tags || []).join(', ');
    $('#f-lede').value = p.lede || '';
    $('#f-content').value = p.content || '';
    $('#f-author').value = p.author || '';
    $('#f-hidden').checked = p.hidden === true;
  }

  function readForm() {
    // 固定顺序，方便看 diff
    var out = {
      id: state.editing ? state.editing.id : '',
      title: $('#f-title').value.trim(),
      date: $('#f-date').value || todayISO(),
      tags: $('#f-tags').value.split(/[,，]/).map(function (t) { return t.trim(); })
              .filter(Boolean).slice(0, MAX_TAGS),
      lede: $('#f-lede').value.trim(),
      content: $('#f-content').value,
      author: $('#f-author').value.trim(),
      hidden: $('#f-hidden').checked
    };
    // 带上将来可能新增的字段，编辑旧文章时不会把它们弄丢
    if (state.editing) {
      Object.keys(state.editing).forEach(function (k) {
        if (!(k in out)) out[k] = state.editing[k];
      });
    }
    // 用不到的字段就不写进 JSON，保持 posts.json 干净
    if (!out.hidden) delete out.hidden;
    if (!out.author) delete out.author;
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
      state.editing.content = post.content || '';
    } else {
      state.editing = {
        id: '', title: '', date: todayISO(), tags: [], lede: '', content: '',
        author: '', hidden: false
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
        toast('已提交' + (sha ? '（' + sha + '）' : '') +
              (post.hidden ? '，这篇是隐藏的' : '') + '，网站约 1 分钟后更新');
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
        toast('已删除，网站约 1 分钟后更新');
      })
      .catch(function (err) {
        if (removed) state.posts.push(removed);
        state.posts.sort(byDateDesc);
        renderList();
        toast(err.message, true);
      });
  }

  function togglePreview() {
    var wrap = $('#preview-wrap');
    if (!wrap.hidden) {
      wrap.hidden = true;
      $('#btn-preview').textContent = '预览';
      return;
    }
    $('#preview').innerHTML = MD.render($('#f-content').value);
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
    var ref = encodeURIComponent(CFG.branch || 'main');
    return gh(contentsPathOf(sitePath()) + '?ref=' + ref).then(function (data) {
      if (!data || typeof data.content !== 'string') {
        throw new Error('站点信息读取失败');
      }
      state.siteSha = data.sha;
      var obj = JSON.parse(b64decode(data.content));
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

    /* ---------- 标签总览 ---------- */
    $('#btn-batch-tags').addEventListener('click', openTagOverview);
    $('#btn-tags-save').addEventListener('click', applyTagOverview);
    $('#btn-tags-cancel').addEventListener('click', backFromTags);
    $('#btn-tags-back').addEventListener('click', backFromTags);
    $('#tag-edit-list').addEventListener('input', renderTagsSummary);
    $('#tag-edit-list').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); applyTagOverview(); }
    });

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

    ['#f-title', '#f-date', '#f-tags', '#f-lede', '#f-content', '#f-author', '#f-hidden']
      .forEach(function (sel) {
        var el = $(sel);
        var onEdit = function () {
          state.editing = readForm();
          scheduleDraft();
        };
        el.addEventListener('input', onEdit);
        el.addEventListener('change', onEdit);
      });

    window.addEventListener('beforeunload', function (e) {
      var dirty = (!$('#view-edit').hidden && isDirty()) ||
                  (!$('#view-site').hidden && isSiteDirty()) ||
                  (!$('#view-tags').hidden && tagsDirty()) ||
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
