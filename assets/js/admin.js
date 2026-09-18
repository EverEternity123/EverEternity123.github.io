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

  var $ = function (s) { return document.querySelector(s); };

  var state = {
    token: '',
    user: '',
    sha: null,        // 当前 posts.json 的 blob sha，提交时必须带上
    posts: [],
    editing: null,
    original: null,
    isNew: true
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
    ['connect', 'list', 'edit'].forEach(function (v) {
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

  function contentsPath() {
    return '/repos/' + encodeURIComponent(CFG.owner) + '/' +
           encodeURIComponent(CFG.repo) + '/contents/' +
           String(CFG.path || '').split('/').map(encodeURIComponent).join('/');
  }

  function loadPosts() {
    var ref = encodeURIComponent(CFG.branch || 'main');
    return gh(contentsPath() + '?ref=' + ref).then(function (data) {
      if (!data || typeof data.content !== 'string') {
        throw new Error('文件内容读取失败');
      }
      state.sha = data.sha;
      var list = JSON.parse(b64decode(data.content));
      if (!Array.isArray(list)) throw new Error('posts.json 格式不对：顶层应该是数组');
      state.posts = list.sort(byDateDesc);
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
      state.posts = state.posts.slice().sort(byDateDesc);
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
    $('#f-token').value = '';
    renderConnect();
    show('connect');
  }

  /* ======================================================================
     文章列表
     ====================================================================== */

  function renderList() {
    var ul = $('#list');
    $('#count-pill').textContent = state.posts.length + ' 篇';
    $('#list-empty').hidden = state.posts.length > 0;

    $('#repo-strip').innerHTML =
      '<span class="repo-ok">●</span> ' +
      esc(CFG.owner + '/' + CFG.repo) +
      '<span class="repo-meta">' + esc(CFG.branch || 'main') +
      (state.user ? ' · 已连接 ' + esc(state.user) : '') + '</span>';

    ul.innerHTML = state.posts.map(function (p) {
      var tags = (p.tags || []).map(function (t) {
        return '<span class="pill">' + esc(t) + '</span>';
      }).join(' ');
      var author = p.author
        ? '<span class="pill pill-author">' + esc(p.author) + '</span>'
        : '';
      var hidden = p.hidden === true
        ? '<span class="pill pill-hidden">已隐藏</span>'
        : '';
      return '' +
        '<li data-id="' + esc(p.id) + '"' + (p.hidden === true ? ' class="is-hidden"' : '') + '>' +
          '<div class="info">' +
            '<div class="ttl">' + esc(p.title) + '</div>' +
            '<div class="meta"><span>' + fmtDate(p.date) + '</span>' +
              hidden + author + tags + '</div>' +
          '</div>' +
          '<div class="ops">' +
            '<button class="btn" data-act="edit">编辑</button>' +
            '<button class="btn btn-danger" data-act="del">删除</button>' +
          '</div>' +
        '</li>';
    }).join('');
  }

  function refresh() {
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
              .filter(Boolean).slice(0, 8),
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

    $('#btn-new').addEventListener('click', function () { openEditor(null); });
    $('#btn-back').addEventListener('click', backToList);
    $('#btn-save').addEventListener('click', doSave);
    $('#btn-preview').addEventListener('click', togglePreview);
    $('#btn-refresh').addEventListener('click', refresh);
    $('#btn-export').addEventListener('click', doExport);

    $('#btn-disconnect').addEventListener('click', function () {
      if (!confirm('断开写作台？\n\n会清掉这台设备上记住的令牌，下次要重新贴一次。\n' +
                   '（文章不受影响）')) return;
      disconnect();
      toast('已断开');
    });

    $('#list').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var id = btn.closest('li').getAttribute('data-id');
      var post = state.posts.filter(function (p) { return p.id === id; })[0];
      if (!post) return;
      if (btn.getAttribute('data-act') === 'edit') openEditor(post);
      else doDelete(id, post.title);
    });

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
      if (!$('#view-edit').hidden && isDirty()) {
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
