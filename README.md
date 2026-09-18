# Ever Eternity · 个人博客

一个零依赖的静态博客：纯 HTML / CSS / JS，没有框架、没有构建步骤、没有后端。
**这个仓库根目录就是网站根目录**，GitHub Pages 直接发布它。

- 线上地址：<https://evereternity123.github.io>
- 手机写作台：<https://evereternity123.github.io/write.html>

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
│   └── js/admin.js       写作台逻辑（读写 GitHub 仓库）
├── data/posts.json       ★ 所有文章都在这个文件里
└── .tools/               本地开发工具（已在 .gitignore，不会发布）
    ├── preview.js        本地预览服务器
    ├── check-content.js  内容与资源自检
    ├── screenshot.py     端到端自检 + 截图
    ├── migrate-via-api.py ★ 搬迁到 GitHub（走 API，不需要 git）
    ├── migrate.cmd       ★ 上面那个脚本的双击启动器
    ├── test-migrate.py   搬迁脚本的自动化测试（假 GitHub API）
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

写作台不需要后端：它用你贴进去的 **GitHub 令牌**直接读写仓库里的
`data/posts.json`。保存 = 向仓库提交一次 commit，GitHub Pages 随后自动重新发布
（通常 1 分钟内）。

### 第一次：生成令牌

1. 手机上登录 GitHub，打开
   <https://github.com/settings/personal-access-tokens/new>
2. **Token name** 随便填，比如 `everternity-blog`
3. **Expiration** 选个期限（比如 1 年，到期后重新生成一次）
4. **Repository access** → 选 **Only select repositories** → 只勾选
   `EverEternity123.github.io`
5. 展开 **Repository permissions** → 找到 **Contents** → 改成 **Read and write**
6. 点最下面 **Generate token**，复制生成的 `github_pat_…`

> 令牌只保存在你这台设备的浏览器里，不会上传到任何地方。
> 但它等同于这个仓库的写权限 —— 别分享给别人，换设备要重新贴一次。

### 之后：发文

1. 打开 <https://evereternity123.github.io/write.html>
2. 贴上令牌，点「连接」（同一台设备只需一次，之后会自动登录）
3. 点「＋ 写新的」，填标题、日期、标签、正文
4. 「预览」看渲染效果 → 「保存并发布」
5. 等 1 分钟左右，网站上就有了

正文支持 Markdown：`**粗体**`、`*斜体*`、`## 标题`、`> 引用`、`- 列表`、
`` `行内代码` ``、` ```代码块``` `。空行分段。

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
2. 把旧博客整条历史备份到 `legacy-hexo-2022` 分支
3. 用本地 17 个文件建一棵**全新的**文件树 —— 注意不基于旧树，
   所以旧的 Hexo 文件（`css/`、`js/`、`2022/` 等）会从站点根目录**整体消失**
4. 建一个以旧 HEAD 为父提交的新提交（历史不断）
5. 把 `main` 指向新提交（force）

跑完会打印远端与本地文件的对照，不一致会直接列出来。

### 想恢复旧博客

在 GitHub 网页上把默认分支切成 `legacy-hexo-2022`，
或者仓库 Settings → Branches 里操作即可。旧文件一个都没丢。

### 这套流程有测试

`.tools/test-migrate.py` 会启动一个**内存里的假 GitHub API**，
先放一个 2022 年的 Hexo 站点上去，跑完整搬迁，再逐字节核对文件内容：

```bat
python .tools\test-migrate.py
```

21 项断言，包括：备份分支是否指向旧 HEAD、新提交的父提交对不对、
旧文件是否被清干净、17 个文件内容是否与本地完全一致（含中文和空的
`.nojekyll`）、令牌是否被回显。**不会碰你的真实仓库。**

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

## 六、（可选）换成自己的域名

GitHub Pages 支持自定义域名，所以 `evereternity.is-a.dev` 这类免费子域名
是可以用的（之前用别的托管方式时绑不了，现在没这个限制了）。

大致两步：

1. **让域名指过来**：按 [is-a.dev 官方文档](https://github.com/is-a-dev/register)
   提交申请，记录类型用 `CNAME`，值填 `evereternity123.github.io`。
   注意：is-a.dev 明确要求**用你自己的话写申请**，不要用 AI 生成请求内容。
2. **告诉 GitHub**：仓库 Settings → Pages → **Custom domain** 填上你的域名，
   等证书签发后勾选 **Enforce HTTPS**。
   同时在仓库根目录加一个 `CNAME` 文件，内容就是那一行域名。

---

## 七、自检（改完东西想确认没坏）

```bat
node .tools\check-content.js        :: 文章数据、资源、链接 —— 秒级，14 项
```

搬迁脚本的逻辑验证（用内存里的假 GitHub 仓库，不碰真实数据）：

```bat
python .tools\test-migrate.py       :: 21 项断言
```

需要跑浏览器、验证完整发文流程：

```bash
node .tools/preview.js &            # 先起预览服务（另开一个终端）
python .tools/screenshot.py         # 写作台全流程 + 页面检查 + 截图
```

`screenshot.py` 会用浏览器把 GitHub API 拦截成一个**内存里的假仓库**，
所以它验证「写作台保存 → 提交 → 站点内容跟着变」这条链路时
**不会动到你的真实仓库**，跑完 `_preview/` 里有各个页面的截图。

### 如果看到「浏览器断开」

这是本机 `--single-process` Chromium 的已知毛病：跑久一点会整进程崩掉
（实测约 1/4 概率，跟代码无关，已经用 A/B 对照排除过平滑滚动、截图新表面
等嫌疑）。脚本已经做了容错，崩了只会让**那一段之后**的检查判失败，
不会丢掉已经跑出来的结论。

想更稳一点，分两次跑，两段互不影响：

```bash
E2E_PART=write python .tools/screenshot.py    # 只跑写作台全流程
E2E_PART=pages python .tools/screenshot.py    # 只跑页面检查 + 截图
```

「撞车保护」（保存时发现文件在别处被改过）那一段是崩得最凶的，
所以特意排在最后跑，万一崩了也不会带走别的结论。

---

## 八、注意事项

- **GitHub Pages 免费版要求仓库是公开的**（现在是公开的，别改成私有）。
- **软性限额**：仓库建议 1GB 以内、每月流量 100GB、每小时最多 10 次构建。
  个人博客完全够用，但别短时间内反复提交十几次。
- **`data/posts.json` 是唯一的内容源**。写作台和本地都改它，
  两处同时改容易撞车 —— 撞车时写作台会提示「文件在别处被改过了」，
  点「刷新」重新读取再保存即可。
- **`write.html` 是公开可访问的**，但没有令牌谁也进不去。
  如果你介意，可以在 GitHub 上把它改名成别人猜不到的名字。
- 备份：写作台列表底部有「导出备份」，会下载一份 `posts-日期.json`。
  另外 `data/posts.json` 本身就在 git 里，历史版本随时能翻。

---

© 2026 Ever Eternity · 慢慢写，慢慢活
