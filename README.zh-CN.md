<p align="right"><b>中文</b> · <a href="README.md">English</a></p>

# md2book

“分享你的 Markdown 笔记，如同给你的朋友递一本书。”

Markdown 成为了和 agent 交流的好媒介。我制作这个工具的初衷是为了把 Markdown 同样以一种好的方式分享给你的人类朋友：当你认真地呈现你的分享，就会被认真地倾听，并得到也许对你来说很重要的反馈，开启一些启迪心灵的交流。

可以用于本地文件夹或者 Github 仓库：本地版需要在发生改动后更新部署，远端仓库版会自动拉取，和仓库同步；
不需要任何软件、插件或者导出。

## 功能

- 支持一篇或多篇连排，双栏或单栏页面，纸质翻页手感。
- 多篇笔记合集：兼容文件夹或者标签的组织形式。
- 每个合集可选这两种排版：**paper**（每篇笔记单独开页，仿照论文出版版式，适合研究笔记）和 **zine**（笔记一篇接一篇连续排下去，适合随笔、日记）。
- 在标准 Markdown 语法之外，也会支持 [Obsidian](https://obsidian.md) 语法：`[[wikilink]]`、`![[嵌入图片]]`、数学公式。
- 支持 [CriticMarkup](https://criticmarkup.com) 修订（会渲染成最终稿件样式）与批注（会显示为页边旁注）。
   - 如何在 Obsidian 中优雅地 CriticMarkup？欢迎使用插件 [Simple Commentor](https://github.com/ziru-wei/obsidian-criticmarkup/tree/ziru-custom)
- 支持引用格式，链接会变成带编号的引用。
- 图、表、标题自动编号；图、表均支持跨栏排版。
- 支持桌面、手机、平板三种版式；支持双指缩放；
- 支持浏览器内打印为干净的 pdf。

## 在本地运行

需要 Node.js 20.12 或更高版本。第一次：

```bash
git clone https://github.com/ziru-wei/md2book.git
cd md2book
npm install
node bin/md2book.js 你的笔记文件夹路径
```

之后每次（把路径换成你的笔记文件夹）：

```bash
cd md2book
node bin/md2book.js 你的笔记文件夹路径
```

浏览器会自动打开 `http://localhost:3000`，笔记改动后页面自动刷新。按 `Ctrl+C` 停止。

## 设置

md2book 运行时，浏览器打开：

```
http://localhost:3000/settings
```

改动即时保存到笔记文件夹里的 `md2book.settings.json`。


## 以 Vercel 为例部署上线

用 Vercel 部署。第一次先安装并登录：

```bash
npm install -g vercel
vercel login
```

> 不想让别人浏览全部笔记列表？在设置页「站点 → 首页地址」填一个别人猜不到的路径，比如 `/a1b2c3`。

### 方式一：笔记在本地文件夹

**第一次部署**

```bash
cd md2book
rsync -a --delete --exclude '.*' 你的笔记文件夹路径/ notes/
vercel deploy --prod
```

第一次部署时 Vercel 会问几个问题，一路回车即可。最后输出的网址就是你的站点。

**笔记更新后**

```bash
cd md2book
rsync -a --delete --exclude '.*' 你的笔记文件夹路径/ notes/
vercel deploy --prod
```

**修改设置**

修改：

```bash
cd md2book
node bin/md2book.js 你的笔记文件夹路径
```
打开 `http://localhost:3000/settings` 改好后按 `Ctrl+C`

上传你的修改：

```bash
rsync -a --delete --exclude '.*' 你的笔记文件夹路径/ notes/
vercel deploy --prod
```

### 方式二：笔记在 GitHub 仓库

**第一次部署**

1. 创建一个只读 token：打开 <https://github.com/settings/personal-access-tokens/new>，Repository access 选你的笔记仓库，Permissions 里把 Contents 设为 Read-only，生成后复制。
2. 在终端里（每条命令会提示你粘贴对应的值）：

```bash
cd md2book
vercel link
vercel env add GITHUB_OWNER production    # 你的 GitHub 用户名
vercel env add GITHUB_REPO production     # 笔记仓库名
vercel env add GITHUB_TOKEN production    # 上一步复制的 token
vercel deploy --prod
```

可选：笔记不在 `main` 分支时加 `vercel env add GITHUB_BRANCH production`；只发布某几个顶层文件夹时加 `vercel env add GITHUB_DIRS production`（逗号分隔，比如 `Journal,Research`）。加完再执行一次 `vercel deploy --prod`。

**笔记更新后**

照常把笔记 push 到 GitHub 即可，站点会读取最新内容，不需要重新部署。

**修改设置**

在你电脑上的笔记仓库副本上运行：

```bash
cd md2book
node bin/md2book.js ~/我的笔记仓库
```

打开 `http://localhost:3000/settings` 改好后按 `Ctrl+C`，然后：

```bash
cp ~/我的笔记仓库/md2book.settings.json ./md2book.settings.json
vercel deploy --prod
```

## 记录和阅读
### 你的笔记

下面这些字段都是可选的增强：

```md
---
created: 2026-04-02
updated: 2026-04-05
publishTag: [japan, trips]
publishID: awesome-trip
publish: true
---

# Kyoto in Spring

第一个 `# 标题` 会成为文章标题，如果没有一级标题，就会使用笔记的文件名。可以在设置里定义主副标题的分隔记号。

```
- **日期**：`created`/`updated` 会显示成一行小字署名，并且决定合集里笔记按时间从旧到新的排列顺序。没有这两个字段时，本地笔记会用文件本身的创建和修改日期。
- **绘图**：Excalidraw 绘图（`*.excalidraw.md`）和白板（canvas）文件会被跳过。
- **隐藏某篇笔记**：在 yaml 区里写 `publish: false` 即可隐藏；
- **不会失效的链接**：笔记的 URL 默认由文件路径生成，所以改文件名或移动位置会改变链接；给笔记加一个 `publishID: 任意值`，链接就会固定下来，不管文件之后在你的笔记库挪到哪里都不变。


#### 合集

`http://localhost:3000` 会列出所有笔记，顶部的搜索框可以按标题和正文搜索；在这个页面按 **空格键** 可以选择一个合集。一篇笔记会被归入以下几种合集：

- 它所在的顶层文件夹，不论嵌套在哪一层子文件夹里（比如 `travel/japan/kyoto.md` 属于 `travel` 合集）；
- 它 frontmatter 里 `publishTag` 字段的每一个标签。

在配置里可以指定哪些文件夹（也可以是子文件夹）、改用或增加别的 frontmatter 字段并限定其中哪些标签算数，以及是否计入正文里的 `#标签`。

每个合集的地址是 `/contents/<合集名>`。

#### 写作语法

- 支持常规 Markdown。
- `[文字](https://…)` 会显示成「文字 [1]」，来源出现在文末的引用列表里；同一个链接重复出现会共用同一个编号。
- `{==REF==}{>>https://…<<}` 会把来源渲染成一个不带文字的引用标记 `[1]`；连续写在一起的几个，比如 `({==REF==}{>>…<<}, {==REF==}{>>…<<})`，会自动合并成 `[1, 2]`。
- `[[另一篇笔记]]`、`[[另一篇笔记|显示文字]]`、以及 `[文字](另一篇笔记.md)` 都可以链接到别的笔记；链接指向没有发布或不存在的笔记时，点开会显示「This note isn't available now」的提示页。
- 公式：行内用 `$…$`，独立一行的公式块用 `$$…$$`。
- CriticMarkup 只会渲染出最终结果：`{--删除的内容--}` 不会显示，`{++新增的内容++}` 会保留，`{~~旧文字~>新文字~~}` 只显示「新文字」，`{==文字==}` 显示为「文字」。如果在替换或高亮后面紧跟一条批注，比如 `{==文字==}{>>批注<<}`，会变成页边一条带编号的旁注，垂直位置和它标注的那一行对齐；标题里也可以加批注。
- 标题会自动编号（1、1.1……）；但如果文章开头第一个标题正好叫 "Abstract"，它不参与编号。

#### 图片与表格

`![[图片.png]]` 会像 Obsidian 一样在整个笔记库里按文件名查找图片；`![alt](attachments/图片.png)`（相对于当前笔记的路径）和图床链接同样可以用。

在图片下方打标记可以添加 caption，以及设定是否是头图（teaser）和跨栏图片（span）

```md
![[kyoto.jpg]]
//四月的哲学之道。
//teaser

![[kyoto.jpg]]
//teaser
//四月的哲学之道。

![[kyoto.jpg]]
//teaser

![[kyoto.jpg]]
//span

```


### 阅读操作

| 操作 | 桌面端 | 触屏 |
|---|---|---|
| 翻页 | ←/→、A/D，或触控板左右滑动 | 手指滑动 |
| 单页 / 双页切换 | `/` | 旋转设备 |
| 更大字号的「平板」页面 | `\` | — |
| 目录（合集）或大纲（单篇笔记） | 空格 | — |

## 实现

`server.js` 把每篇笔记转换成 HTML；到了浏览器端，`static/reader.js` 负责把内容切成一页一页：每一页的正文是一个双栏的框，高度正好是这一页剩下的空间，浏览器排不下、溢出到第三栏的内容，就成了下一页的开头——换栏和换页因此完全交给浏览器自己的排版引擎决定，而不是另外模拟一套。页面先按固定尺寸排好版，再整体缩放到适配屏幕。p.s. Webkit 和 Paged.js 有多栏排版 nesting 的 bug，所以基于这个项目的初衷，也就是“分享”，笔者为了能让读者在翻阅中不受平台限制，舍弃了使用 Paged.js，重新造了一些轮子。