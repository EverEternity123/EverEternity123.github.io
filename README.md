# Ever Eternity · 个人博客

一个零依赖的静态博客：纯 HTML / CSS / JS，没有框架、没有构建步骤、没有后端。
**这个仓库根目录就是网站根目录**，GitHub Pages 直接发布它。

- 博客地址：<https://evereternity123.github.io>
- **写作台（手机 / 电脑都用这一个）**：<https://evereternity123.github.io/write.html>

> 就用这两个地址，没有别的入口。以前那个临时分享链接已经下线，
> 也不再考虑自定义域名 —— 只用 GitHub 这一个博客。

手机端：浏览器打开写作台 → 分享 → **添加到主屏幕**，以后点图标就能发文。
电脑端：同一个地址，浏览器直接打开即可，排版会自动适配宽屏。

---

## 目录结构

```
（仓库根 = 网站根）
├── index.html            首页（文章列表 + 搜索 + 标签筛选）
├── post.html             文章详情页（post.html?p=文章id）
├── archive.html          归档（按年份 + 标签云）
├── about.html            关于
├── 404.html              GitHub Pages 的找不到页面
├── write.html            手机写作台
├── write.config.js       写作台配置（指向哪个仓库）★ 唯一需要手改的文件
├── .nojekyll             告诉 GitHub Pages 不要跑 Jekyll
├── assets/
│   ├── css/style.css     博客样式（含明暗主题变量）
│   ├── css/admin.css     写作台样式
│   ├── js/app.js         首页/详情/归档的渲染逻辑
│   ├── js/markdown.js    自写的迷你 Markdown 渲染器
│   ├── js/theme.js       明暗切换
│   ├── js/admin.js       写作台逻辑（读写 GitHub 仓库）
│   └── img/              头像、网页缩略图、favicon
│       ├── avatar.jpeg        首页头像（512×512）
│       ├── og-image.jpeg      分享到微信/微博时的缩略图（1200×630）
│       ├── apple-touch-icon.png  加到手机桌面时的图标
│       ├── brand-64.png       页头左上角的小图标
│       └── favicon-32.png / favicon-16.png
├── data/posts.json       ★ 所有文章都在这个文件里
└── .tools/               本地开发工具（已在 .gitignore，不会发布）
    ├── preview.js        本地预览服务器
    ├── make-images.py    ★ 从 .tools/source/ 的原图生成上面那几张图
    ├── check-content.js  内容/资源/配置自检 + 写作台错误提示文案（不用浏览器）
    ├── screenshot.py     端到端自检 + 截图（8 段，见第六节）
    ├── verify-hidden.py  隐藏文章 + 作者一栏在页面上的表现（注入数据，最稳）
    ├── verify-write-fields.py  写作台里作者/隐藏的读写
    ├── verify-looks.py   头像/图标/og 缩略图有没有真的加载出来
    ├── verify-local-file.py  本地双击打开 write.html 能不能用（file://）
    ├── verify-desktop.py 写作台在电脑宽屏下能不能用（VD_SIZE=1440x900 / 1920x1080）
    ├── migrate-via-api.py ★ 发布到 GitHub（走 API，不需要 git）
    ├── migrate.cmd       ★ 上面那个脚本的双击启动器
    ├── sync-from-remote.py ★ 把线上文章拉回本地（手机上写的同步过来）
    ├── test-migrate.py   搬迁脚本的自动化测试（假 GitHub API）
    ├── verify-live.py    用真实令牌验证线上写作台（只读，崩了自动重跑）
    ├── verify-write-api.py  验证保存链路并自动清理
    ├── _probe-409.py     一次性探针：拦截下的 4xx 会不会把 Chromium 弄崩
    ├── _probe-live-route.py  一次性探针：线上自动登录到底崩在哪一步
    ├── source/           图片原图（刘看山.jpeg，不发布，留着重新生成）
    └── publish-to-github.sh  给装了 Git Bash 的人用的备选方案
```

---

## 一、本地预览

```bash
cd D:\03Code\WorkBuddy\blog
node .tools/preview.js
```

打开 <http://127.0.0.1:8080>，写作台在 <http://127.0.0.1:8080/write.html>。

改完文件刷新页面就能看到，不需要重启。换端口：`PORT=9000 node .tools/preview.js`。

---

## 二、日常写文章（手机 / 电脑都能用）

写作台不需要后端：它用 **GitHub 令牌**直接读写仓库里的 `data/posts.json`。
保存 = 向仓库提交一次 commit，GitHub Pages 随后自动重新发布（通常 1 分钟内）。

第一次贴一次令牌，之后就记在这台设备的浏览器里，再打开直接进文章列表。

> 令牌等同于这个仓库的写权限 —— 别分享给别人，也别贴到聊天群里。
> 换手机、换浏览器、清了浏览器数据之后，需要重新贴一次。

### 第一次：生成令牌

1. 登录 GitHub，打开
   <https://github.com/settings/personal-access-tokens/new>
2. **Token name** 随便填，比如 `everternity-blog`
3. **Expiration** 选个期限（比如 1 年，到期后重新生成一次）
4. **Repository access** → 选 **Only select repositories** → 只勾选
   `EverEternity123.github.io`
5. 展开 **Repository permissions** → 找到 **Contents** → 改成 **Read and write**
6. 点最下面 **Generate token**，复制生成的 `github_pat_…`

打开 <https://evereternity123.github.io/write.html>，把令牌贴进去，点「连接」。

想换一个令牌、或者让这台设备忘掉它，点列表页右上角的「断开连接」即可，
再贴一个新的就行。文章都在 GitHub 上，一篇都不会丢。

### 之后：发文

1. 打开 <https://evereternity123.github.io/write.html>
2. 贴过令牌就直接进列表（没贴过才需要再贴一次）
3. 点「＋ 写新的」，填标题、日期、作者、标签、正文
4. 「预览」看渲染效果 → 「保存并发布」
5. 等 1 分钟左右，网站上就有了

### 也可以直接双击打开

写作台是纯前端页面，**双击本地文件也能用**：在文件管理器里打开
`write.html`，功能和线上完全一样。适合电脑上不方便起服务的时候。

（GitHub 的接口允许跨域访问，所以 `file://` 下读写仓库都正常。
万一某个浏览器拦了，用 `node .tools/preview.js` 起个本地服务即可。）

正文支持 Markdown：`**粗体**`、`*斜体*`、`## 标题`、`> 引用`、`- 列表`、
`` `行内代码` ``、` ```代码块``` `。空行分段。

### 作者一栏

留空就用站点默认作者（`write.config.js` 里的 `defaultAuthor`，现在是
`Ever Eternity`）。填了别的名字（比如摘录别人的文章），
文章详情页会显示这个作者；如果跟默认作者不一样，首页卡片上也会标出来。

### 隐藏这篇文章

编辑器里勾上「隐藏这篇文章」，保存后：

- 首页列表、归档、标签栏、标签云里都**看不到**它
- 但它仍然存在，用链接 `post.html?p=文章id` 直接打开就能看（方便自己先预览）
- 打开时顶部会有一行「这篇还没公开」的提醒
- 想公开的时候，取消勾选再保存就行

写了一半被打断也没关系：编辑内容每 0.7 秒自动存一份草稿在本地，
下次打开这篇文章会提示你恢复。

---

## 三、在电脑上改样式 / 改结构

改 `assets/css/style.css` 或 HTML 就行，改完本地预览确认。

**这台电脑上没有装 Git**，所以发布走 API 脚本（见第五节），
不需要 `git add / commit / push` 那套。

颜色、字号这些集中在 `assets/css/style.css` 顶部的 CSS 变量里
（`--bg`、`--fg`、`--accent` 等，明暗两套）。

---

## 四、发布（GitHub Pages 设置，只需做一次）

1. 打开 <https://github.com/EverEternity123/EverEternity123.github.io/settings/pages>
2. **Source** 选 **Deploy from a branch**
3. **Branch** 选 `main`，文件夹选 **`/ (root)`**
4. 保存，等 1～2 分钟

如果之前就是这个设置，那**什么都不用改** —— 推送完自动就更新了。
（现在这个仓库已经就是 `main` + `/ (root)`，所以不用动。）

---

## 五、把旧博客换掉（首次迁移）

> 旧博客（2022 年那个 Hexo 站点）已经完整备份到
> `D:\03Code\WorkBuddy\blog-legacy-hexo\site`，同时旧仓库的历史会保留成
> `legacy-hexo-2022` 分支 —— 这一步是可逆的。

### 为什么不用 `git push`

**这台电脑上没有装 Git**（没有 Git for Windows、没有 GitHub Desktop）。
所以 `.tools/publish-to-github.sh` 跑不起来 —— 在 cmd 里会报
`'bash' 不是内部或外部命令`，那是正常的，不是你的操作问题。

这里改用 **GitHub 官方 API**，只需要一个令牌，不装任何东西。

### 先准备一个令牌

1. 打开 <https://github.com/settings/personal-access-tokens/new>
2. **Token name** 填 `everternity-blog`
3. **Expiration** 选个期限（比如 90 天，到期重新生成）
4. **Repository access** → **Only select repositories** → 只勾
   `EverEternity123.github.io`
5. **Repository permissions** → **Contents** → 改成 **Read and write**
6. **Generate token**，复制生成的 `github_pat_…`

> 这个令牌手机发文也要用（见第二节），所以只需要生成一次。

### 方式 A：把令牌交给助手，我帮你推

把 `github_pat_…` 发我，我执行搬迁并核对结果。这是最省事的一条路。

### 方式 B：自己双击运行

双击 `.tools\migrate.cmd`。它会自动找 Python、问你要令牌、**先预演一遍**
（不改动任何东西），确认后执行。

也可以手动跑：

```bat
cd /d D:\03Code\WorkBuddy\blog
python .tools\migrate-via-api.py            :: 预演，只打印将要做什么
python .tools\migrate-via-api.py --apply    :: 真正执行
```

令牌三种给法，任选其一：

- 命令行参数 `--token github_pat_xxx`
- 环境变量 `set GH_TOKEN=github_pat_xxx`
- 写进 `.gh-token` 文件（已在 `.gitignore` 里，不会被提交）

### 脚本到底做了什么

1. 读远端 `main` 当前的 HEAD
2. **检查 `data/posts.json` 有没有冲突**（见下面「重要：别把手机写的文章冲掉」）
3. 把旧博客整条历史备份到 `legacy-hexo-2022` 分支
4. 用本地 17 个文件建一棵**全新的**文件树 —— 注意不基于旧树，
   所以旧的 Hexo 文件（`css/`、`js/`、`2022/` 等）会从站点根目录**整体消失**
5. 建一个以旧 HEAD 为父提交的新提交（历史不断）
6. 把 `main` 指向新提交（force）

跑完会打印远端与本地文件的对照，不一致会直接列出来。

### 重要：别把手机写的文章冲掉

`data/posts.json` 是唯一会被**两边同时改**的文件：你在手机上写完就提交了，
而本地这份还是旧的。如果直接推送，手机上刚写的文章会被抹掉。

所以脚本默认会先比对远端的 `data/posts.json`：

- **两边一样** → 直接继续，你什么都不用管。
- **两边不一样** → **停下**（退出码 2），列出「只在远端有的文章」，
  要求你显式选一个：

```bat
python .tools\migrate-via-api.py --apply --take-remote    :: 采用远端的（推荐，手机写的不丢）
python .tools\migrate-via-api.py --apply --keep-local     :: 坚持用本地覆盖远端
```

推荐的做法是**先把线上内容拉回本地**，改完再推：

```bat
python .tools\sync-from-remote.py            :: 先看看差在哪（不改任何东西）
python .tools\sync-from-remote.py --apply    :: 真的拉回来（本地旧版会先备份）
```

它只拉 `data/posts.json`，不会动你本地改的 HTML / CSS。

> **别低估这件事发生的频率。** 上线当天就真实发生过一次：你在写作台里连着改了
> 11 篇（给文摘类文章补上「作者」），而本地那份还是旧的 —— 两边同时动过
> 同一个文件。所以规矩很简单：**只要站点交付给你在用，本地副本随时可能是旧的。
> 动手发布之前，先跑一遍不带参数的 `sync-from-remote.py` 看一眼差异。**

### 想恢复旧博客

在 GitHub 网页上把默认分支切成 `legacy-hexo-2022`，
或者仓库 Settings → Branches 里操作即可。旧文件一个都没丢。

### 这套流程有测试

`.tools/test-migrate.py` 会启动一个**内存里的假 GitHub API**，
先放一个 2022 年的 Hexo 站点上去，跑完整搬迁，再逐字节核对文件内容：

```bat
python .tools\test-migrate.py
```

35 项断言，包括：空令牌被拒绝、远端比本地新时会停下、`--take-remote`
采用远端、`--keep-local` 明确覆盖、备份分支是否指向旧 HEAD、新提交的父提交
对不对、旧文件是否被清干净、17 个文件内容是否与本地完全一致（含中文和空的
`.nojekyll`）、令牌是否被回显。**它把脚本指到临时目录里的站点副本上跑，
所以既不碰真实仓库，也不碰你真实的 `data/posts.json`。**

### 验证线上写作台

用真实令牌跑一遍「连接 → 列文章 → 打开编辑器 → Markdown 预览」，
全程只读，并在前后各查一次提交列表证明没有产生提交：

```bat
set VL_PART=main
<playwright 环境的 python> -u .tools\verify-live.py
```

再单独验证「手机上过几天再打开，不用重新贴令牌」：

```bat
set VL_PART=remember
<playwright 环境的 python> -u .tools\verify-live.py
```

**为什么分两段**：`main` 段模拟「这台设备以前贴过令牌」（脚本先把令牌写进
`localStorage` 再打开页面），只加载一次页面；`remember` 段刻意不预置令牌，
走「全新设备 → 贴令牌 → 记住 → 重开」那条真实路径，因此要多加载一次页面 ——
而多加载一次就多一次崩溃机会（见下面「如果看到浏览器断开」）。

**崩了会自动重跑。** 这一段单次成功率只有约 1/5~1/3，所以脚本默认最多跑 6 轮
（`set VL_TRIES=8` 可以再放宽）。实测第 5 轮跑通、22 项全过。
第 1 轮走直连（最贴近真实用户），第 2 轮起改走**代理模式**
（`set VL_PROXY=1` 可强制一上来就用）：请求改由脚本用真令牌转发，
并且**非 GET 请求一律拒掉** —— 于是「只读」从「我们保证不写」变成
「物理上写不进去」。代理模式治不了崩溃（试过，照样崩），它的价值只在这一点。

**崩溃时脚本不会假装通过，也不会记成失败**，而是打印
「未验证完：N 项通过，之后 Chromium 被沙箱弄崩了」并以退出码 2 结束。
退出码：0 全过 / 1 有真失败 / 2 没验完。

**另外有一条不需要浏览器、也更硬的证据**：脚本第 [0] 步直接看远端提交历史里
有没有写作台格式的提交信息（`新文章：`/`更新：`/`删除：`）。
这是真实设备 + 真实令牌 + 真实提交，沙箱再怎么崩都不影响它。

验证「保存」链路（真的写一次再清理干净）：

```bat
python .tools\verify-write-api.py
```

它会写入一个临时文件、读回来核对中文与 emoji、删掉，最后把 `main`
强制重置回原提交 —— 分支历史上不留痕迹。

### 如果你以后装了 Git

`.tools/publish-to-github.sh` 仍然可用，但需要 Git Bash：

```bash
cd /d/03Code/WorkBuddy/blog
bash .tools/publish-to-github.sh
```

> ⚠️ **如果你本地还留着当年那个 Hexo 项目**，记得把它的
> `_config.yml` 里 `deploy` 段落的 `repo` 改掉或删掉。
> 否则哪天手滑跑一次 `hexo deploy`，旧博客会被重新推上来，把新博客覆盖掉。

---

## 六、自检（改完东西想确认没坏）

```bat
node .tools\check-content.js        :: 文章数据、资源、链接、错误文案 —— 秒级，21 项
```

搬迁脚本的逻辑验证（用内存里的假 GitHub 仓库，不碰真实数据）：

```bat
python .tools\test-migrate.py       :: 39 项断言
```

需要跑浏览器、验证完整发文流程（先起预览服务：`node .tools/preview.js`）：

```bash
node .tools/check-content.js            # 内容/资源/配置/错误提示文案（21 项，不用浏览器）
python .tools/test-migrate.py           # 搬迁脚本（39 项，不碰真实仓库）
python .tools/verify-hidden.py          # 隐藏文章 + 作者一栏在页面上的表现（21 项）
python .tools/verify-write-fields.py    # 写作台里作者/隐藏的读写（23 项）
python .tools/verify-looks.py           # 头像/图标/og 缩略图有没有真的加载出来（7 项）
python .tools/verify-local-file.py      # 本地双击打开 write.html 能不能用（两段）
python .tools/verify-desktop.py         # 电脑宽屏下写作台没被挤坏（默认 1440×900）
python .tools/screenshot.py             # 写作台全流程 + 页面检查 + 截图
```

浏览器脚本都会把 GitHub API 拦截成一个**内存里的假仓库**，
所以验证「写作台保存 → 提交 → 站点内容跟着变」这条链路时
**不会动到你的真实仓库**，跑完 `_preview/` 里有各个页面的截图。

### 手机端 / 电脑端都验过

写作台是响应式页面，两种屏幕都用得上，所以分两头验：

- **手机**：`screenshot.py` 和 `verify-live.py` 全部跑在 430×900 / 460×900 视口。
- **电脑宽屏**：`verify-desktop.py` 在 1440×900 与 1920×1080 下渲染，专门看两件事 ——
  **不出横向滚动条**、**内容区是居中的 760px 窄栏而不是被拉满**（表单型界面拉满反而难用）。

```bash
python .tools/verify-desktop.py                    # 默认 1440×900
VD_SIZE=1920x1080 python .tools/verify-desktop.py  # 更宽的显示器
```

实测 1440×900 与 1920×1080 均 **17/17 全过**：文档宽 = 视口宽（无横向滚动），
内容区 760px、左偏移正好是 `(视口 − 760) / 2`（居中），列表 12 篇，
编辑器的标题/作者/正文/预览/隐藏勾选框全部可见，正文输入框 > 400px 宽。

> 这个脚本**一次运行只测一个尺寸**（`VD_SIZE`）—— `--single-process` 下
> `ctx.close()` 会连带杀掉整个浏览器，一个脚本里连测两个尺寸必然挂。

### 为什么把 E2E 切得这么碎

`--single-process` 的 Chromium 在一次会话里能承受的「页面加载 + 拦截请求」
次数很少（实测 3~4 次就到头），一崩就把后面所有结论一起带走。所以
`.tools/screenshot.py` 拆成了互不影响的几段，每段自己连一次、自己造数据：

```bash
E2E_PART=connect    python .tools/screenshot.py  # 令牌连接：贴/校验/记住/断开（16 项）
E2E_PART=features   python .tools/screenshot.py  # 作者一栏（9 项）
E2E_PART=hidden     python .tools/screenshot.py  # 隐藏文章（17 项）
E2E_PART=unhide     python .tools/screenshot.py  # 取消隐藏（12 项）
E2E_PART=write      python .tools/screenshot.py  # 新建并发布（34 项）
E2E_PART=write-edit python .tools/screenshot.py  # 编辑 / 删除 / 空仓库首用（24 项）
E2E_PART=conflict   python .tools/screenshot.py  # 撞车保护（见下面的说明）
E2E_PART=pages      python .tools/screenshot.py  # 页面检查 + 截图（8 项）
```

同理，`.tools/verify-live.py` 和 `.tools/verify-local-file.py` 也各分两段跑。

### 如果看到「浏览器断开」

这是本机 `--single-process` Chromium 的已知毛病：**渲染进程随机崩，
而单进程模式下渲染一崩就等于整个浏览器死掉**。实测约 2/3 概率，
跟页面代码无关。已经查清并排除过的可能原因：

| 猜测 | 实验 | 结果 |
|---|---|---|
| 浏览器自己发真实跨域请求有毛病 | 改成由脚本 `page.route` 代理转发真数据（`.tools/_probe-live-route.py`） | **照样崩**，而且崩之前三个 API 请求全是 200 |
| 事件监听器拖累 | 加 `VL_QUIET=1` 不挂 `page.on(...)` | **照样崩** |
| 等待策略不对 | 一把等 25s / 小步轮询 / 分片等 三种写法 | 一把等反而最稳（CDP 调用越多越容易崩） |

> 这里的教训值得记一下：代理转发那个实验**第一次跑是成功的**，当时差点就
> 当成结论写下来了。连跑 3 次才发现是 1/3 的运气 —— 这个沙箱方差极大，
> 「换个写法就好了」这种判断必须连跑至少 3 次才算数。

所以唯一的办法是**重跑**（`VL_TRIES`，默认 6）。脚本对崩溃做了两层容错：

1. 识别到浏览器断开就**不往结果里记 FAIL**，之后的操作打印「跳过」，
   结尾打印「未验证完」并以退出码 2 结束 —— 环境崩了不等于功能坏了。
   ⚠️ 包装等待函数时**不要改变异常类型**：把 `TargetClosedError` 包成自定义
   `RuntimeError` 后识别逻辑就认不出来，环境崩溃会被记成一条 FAIL，
   看起来像产品坏了。要原样 re-raise。
2. 每轮结果互不影响，一轮崩了从头再来。

### 撞车保护那一段为什么是「环境受限」

`E2E_PART=conflict` 里只要让带请求体的 PUT 收到 4xx，Chromium 就必崩。
已经做过对照实验：

- 单独发一个会返回 409 的 fetch —— 没事（`.tools/_probe-409.py`）
- 把 409 去掉、让保存成功 —— 没事
- 把 409 换成 403 —— 一样崩

所以是「写作台的错误分支 + 拦截下的 4xx」这个组合在这个沙箱里跑不动，
不是页面逻辑的问题。脚本遇到这种情况会**如实打印说明并跳过**，不记成失败；
而 409 那条路上真正重要的东西 —— 用户看到的提示文案 —— 由
`check-content.js` 把 `ghError` 抠出来直接跑（7 项，含 401/403/404/409/422）。

线上实测（用真实令牌，只读，不会提交任何东西）：

```bash
python .tools/verify-live.py                   # 两段都跑
VL_PART=main     python .tools/verify-live.py  # 已记住令牌 → 自动登录 / 列表 / 编辑器
VL_PART=remember python .tools/verify-live.py  # 全新设备：贴令牌 → 记住 → 重开自动登录
```

结果（2026-09-18 实测）：

| 段 | 结果 |
|---|---|
| `main` | **22/22 全过**（第 5 次尝试跑通） |
| `remember` | **14/14 全过**（第 2 次尝试跑通） |

两段最后都会核对「远端 main 未变」，确认脚本没产生任何提交。

---

## 七、注意事项

- **GitHub Pages 免费版要求仓库是公开的**（现在是公开的，别改成私有）。
- **软性限额**：仓库建议 1GB 以内、每月流量 100GB、每小时最多 10 次构建。
  个人博客完全够用，但别短时间内反复提交十几次。
- **只有发布清单里的文件会上线**：`*.html`、`assets/`、`data/`、`write.config.js`、
  `.nojekyll`、`README.md`、`.gitignore`。根目录下别的东西（比如随手放进去的图片）
  **不会**被推上去 —— 搬迁脚本每次都会把这些列出来提醒你。
  想让图片能引用，放到 `assets/img/` 下面，正文里写 `![说明](assets/img/文件名)`。
- **`data/posts.json` 是唯一的内容源**，写作台和本地都改它，两处同时改容易撞车：
  - **在写作台里撞车**：会提示「文件在别处被改过了」，点「刷新」重新读取再保存即可。
  - **在本地推送时撞车**：搬迁脚本会停下并要求你选 `--take-remote` 或
    `--keep-local`（见第五节）。想省事就先跑 `sync-from-remote.py` 把线上内容拉回来。
- **`write.html` 是公开可访问的**，但没有令牌谁也进不去。
  如果你介意，可以在 GitHub 上把它改名成别人猜不到的名字。
- 备份：写作台列表底部有「导出备份」，会下载一份 `posts-日期.json`。
  另外 `data/posts.json` 本身就在 git 里，历史版本随时能翻。

---

© 2026 Ever Eternity · 慢慢写，慢慢活
