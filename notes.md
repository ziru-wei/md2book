可以，按“已经踩过的坑 / 已确认事实”压缩成这份：

1. **Touch page-fit 原始架构耦合太重**
   - phone 动态改 `@page`
   - touch 用 `zoom`
   - resize/rotate 重新算 geometry / reload
   - 后来改成 fixed `850×1100` + touch `transform: scale()`，这部分方向是对的。

2. **为了消除 single→double flash，加了 blocking loader**
   - `#pagedjs-target { visibility:hidden }`
   - 一直等 `finishUp()`
   - 结果变成黑屏转圈，perceived loading 更差。

3. **“preview resolve 后 reveal”不是真 progressive**
   - `await previewer.preview()` 本身已经等完整 pagination。
   - 所以虽然图片可以后加载，但 pagination 还是黑屏等完。

4. **MutationObserver progressive reveal**
   - 先等 `pageCount >= 2`，仍然太慢。
   - 改成第一张 page 出现就 reveal。
   - runtime log 证明 observer 确实能在 `preview()` pending 时触发。

5. **真正卡 page 1 的是 remote PNG**
   - Paged.js 遇到未知尺寸 remote image 会等资源，无法继续确定后面的 break token/page。
   - `raw.githubusercontent.com/*.png` 因此把后续 pagination 卡住。

6. **PNG placeholder 方案是有效方向**
   - server 用 Range 读 PNG IHDR width/height。
   - Paged.js 输入用等比例 inline SVG placeholder。
   - pagination 完成后才 hydrate 真图。
   - 这样 image network latency 和 pagination 解耦。
   - “placeholder 看起来白”只是因为 SVG 是 transparent，不是 placeholder 没生成。

7. **Debug overlay 自己制造过一次全站 spinner**
   - nested server template literal 里的 `\n` 被错误展开。
   - emitted client JS SyntaxError。
   - pagination script 根本没运行，所以 loader 永远不消失。
   - debug code 即使 query gated，parse error 仍会影响所有人。

8. **移动端 console 不方便**
   - 改成 `?debugPaged=1` on-page overlay。
   - 这是这轮最有价值的 diagnosis 工具。

9. **`source teasers=0` 曾经是 debug 本身错**
   - `<template>` 内容不会被普通 `document.querySelectorAll()` 搜到。
   - 应该查 `#pagedjs-source.content`。

10. **曾怀疑 touch viewer CSS 提前污染 pagination**
    - `.touch-book` 的 flex/100svh/scroll rules 确实不该在 preview 期间生效。
    - 后来改成 `touch-pending`，final pagination 后才 `setupTouchBook()`。
    - 这是合理 cleanup，但最终证明**不是 half-page 的根因**。

11. **曾错误认为 repo 还有 10s early activation timer**
    - 实际 commit 已经删掉。
    - 是我读取 stale code 导致误判。
    - 后续 agent 用 commit hash / grep / diff 证明当前代码没有这个 path。

12. **最关键发现：second/staging `Paged.Previewer()` 会 corrupt WebKit DOM**
    - iPad first preview：
      - `pages=5`
      - `teasers=1`
      - title + teaser 正常在 page 0
    - staging swap 后：
      - `pages=7`
      - `teasers=2`
      - title-only page
      - teaser-only page
      - duplicate teaser
    - `setupTouchBook()` 后只是继承错误，没有制造错误。
    - 所以 teaser duplicate / blank page / title 独页的 root cause 是 **second preview**。

13. **关掉 staging 后**
    - teaser duplicate 消失
    - title/teaser异常换页消失
    - blank page 消失
    - 这个 diagnosis 已经坐实。

14. **但 References correction 原本依赖 staging**
    - desktop 原本有完整：
      `detect overlap → force break before References → second preview`
    - staging 全关以后 References overlap 会回来。
    - iPad 原本也有 References overlap，只是之前没单独提。
    - 合理方向是：
      - desktop 保留已验证正常的 overlap correction
      - touch/WebKit 不跑 second preview，改成 first-preview 前 deterministic page break。

15. **References heading 防 orphan**
    - `.references { break-inside: avoid }`
    - 可再加 `.references h2 { break-after: avoid }`
    - 但这只防 heading/list split，不解决主体 overlap。

16. **Safari“提前换行”最初判断错了**
    - 先怀疑 `zoom`
    - 再怀疑 Georgia font metrics / kerning / ligatures
    - 实测：
      - Safari/Chrome logical body width 都是 `662`
      - column width 都是 `312`
      - kerning/ligature 关闭也没变化
    - 所以不是普通 line wrapping/font 问题。

17. **真正异常是 body fragment 只有半页高**
    - debug 一直显示：
      - `contentH ≈ 798/856`
      - `bodyH ≈ 399–479`
    - 非常接近一半。
    - 这是“半页换页”的直接 evidence。

18. **duplicate `.body` CSS 是一个真实 bug，但不是最终 root cause**
    - 后面的 duplicate rule 让 `column-fill:auto` 没实际生效。
    - consolidated 后 CSS cascade 干净了。
    - 但 half-page 仍存在。
    - 所以 duplicate rule 只是一个 bug，不是全部原因。

19. **`column-fill:auto` 也没有解决 half-page**
    - 即使唯一 `.body` 已明确 `column-fill:auto`，问题仍在。
    - 因为 `.body` 本身是 auto-height nested multicol，Paged.js 又在外层做 fragmentation。
    - 现在最强嫌疑是 **WebKit + Paged.js + nested CSS multicol fragmentation**。

20. **Mac Safari resize 暴露了另一个独立问题**
    - viewport 变窄：
      - paper visual size 变小
      - font 不同比例缩小
      - body 变长
      - footer cutoff
    - 强烈说明 CSS `zoom` 会污染 Safari presentation/layout。
    - 但把 zoom 固定成 1 后 **half-page 仍然存在**。
    - 所以 zoom 是 separate bug，不是 half-page root cause。

21. **“no zoom” diagnostic 一度又出现 title/teaser异常**
    - 不是 no-zoom 本身导致。
    - 当时 desktop staging second preview 仍可能介入。
    - 后来固定 `zoom:1 + staging disabled` 后 title/teaser corruption 消失，但 half-page 还在。

22. **现在 half-page 的最小剩余假设**
    - first preview 本身就产生 `bodyH≈contentH/2`
    - 与 touch regrouping 无关
    - 与 second preview 无关
    - 与 zoom 无关
    - 与 font/kerning 无关
    - 与 remote PNG wait 已基本解耦
    - 最大嫌疑：**native `.body { column-count:2 }` nested inside Paged.js fragmentation on WebKit**。

23. **iOS Chrome/Firefox 不能当成独立 engine**
    - iPhone/iPad 上这些 browser 仍然是 WebKit。
    - 所以“所有 mobile browser 都有问题”其实仍然支持 WebKit-specific root cause。

24. **下一步正确 diagnosis**
    - 只做 single-column isolation：
      `.body { column-count:1 }`
    - 如果 `bodyH` 立刻接近 full `contentH`，half-page root cause 就基本锁定为 nested multicol。
    - 不应该再同时改 zoom / title / teaser / touch / references，否则又会混淆因果。

最重要的 lesson 是：这轮很多时间浪费在**同时存在多个 bug，但把它们当成同一个 root cause**。现在已经拆开成至少三条独立线：`second Previewer corruption`、`WebKit multicol half-page fragmentation`、`Safari zoom/presentation drift`。

25. **References overlap correction 一度被错误地重新引入了 second preview（在这份笔记写完之后）**
    - 为了恢复 References 碰撞检测触发的换页，desktop 分支被改回：
      `needsFinalRepagination = !isTouchBook && overlappingRefs.length > 0`
    - 隐含假设：**只有 touch/iPad 会被 second preview 污染，desktop 是安全的**。
    - 这个假设从未被验证过 —— 第12条的证据只测过 iPad；desktop 的 zoom 诊断期间
      staging 是整体关掉的（touch + desktop 都关），所以从没有人单独测过
      "desktop Safari + staging 开启" 这个组合。
    - Mac Safari 和 iPad Safari 是**同一个 WebKit engine**，所以这个假设大概率是错的。
    - 症状（标题后异常换行、teaser 重复）和第12条描述的 corruption 完全一致，
      而且恰好在这次改动之后出现——时间线吻合。
    - **修复**：second/staging `Paged.Previewer()` 现在对所有设备永久关闭
      （不再区分 touch/desktop）。References 换页改成对所有设备都用第14条已经
      在 touch 上验证过的方案：first preview 之前，无条件给每个
      `.references` 前插入 `.force-page-break`，不再依赖"先测量碰撞、
      再跑第二次 preview 修正"这条路径。
    - 代价：References 现在总是独占一页开头，即使原本不会真的和正文重叠——
      用一点排版上的保守换来跨浏览器不再有 corruption 风险。
    - `findOverlappingReferenceSlugs()`/`overlappingRefs` 仍然保留在代码里
      （只是不再触发任何动作），方便以后如果想恢复"按需换页"再用。