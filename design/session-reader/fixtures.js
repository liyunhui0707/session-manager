/* Invented conversations for the visual prototype. No transcript files or APIs. */
window.prototypeFixtures = [
  {
    id: 'reader', title: '设计一个安静的阅读器', provider: 'Codex', date: '今天', time: '10:42', favorite: true,
    preview: '让内容成为主角，让界面退后一步。', project: 'Session Manager',
    messages: [
      { role: 'user', time: '10:28', html: '<p>我想做一个能回看对话的桌面阅读器。它应该安静、简洁，但要有完整产品的质感。</p><p>先帮我确定阅读界面的方向。</p>' },
      { role: 'assistant', time: '10:29', html: '<h2>从阅读本身出发</h2><p>打开一段对话时，最重要的不是知道系统做了多少工作，而是能立刻接上自己的思路。</p><ul><li><strong>清楚的层级：</strong>会话、问题、回答，一眼就能分清。</li><li><strong>稳定的阅读区域：</strong>长文本有合适的行宽，代码和表格有自己的空间。</li><li><strong>克制的操作：</strong>搜索、收藏随手可用，其余工具在需要时出现。</li></ul><blockquote>让内容成为主角，让界面退后一步。</blockquote>' },
      { role: 'user', time: '10:36', html: '<p>我很喜欢这个方向。长对话怎么处理？我不想每次都从开头往后翻。</p>' },
      { role: 'assistant', time: '10:38', html: '<h3>从最新的一句话继续</h3><p>进入会话时直接看到最新回复。向上阅读时保留位置，新的内容到来后给一个轻量提醒，不把你拉走。</p><div class="code-block"><div class="code-heading"><span>JavaScript</span><button data-copy-code>复制代码</button></div><pre><code><span class="syntax-key">const</span> reading = {\n  openAt: <span class="syntax-value">"latest"</span>,\n  preserveScroll: <span class="syntax-key">true</span>,\n  source: <span class="syntax-value">"read-only"</span>\n};</code></pre></div><p>历史内容按需加载，但阅读体验应当连续。分段、扫描进度和文件大小不需要成为界面的主角。</p>' },
      { role: 'user', time: '10:41', html: '<p>就按这个方向。也请把搜索、来源管理和深色模式一起考虑进去。</p>' },
      { role: 'assistant', time: '10:42', html: '<h2>一个完整、轻盈的阅读空间</h2><p>主界面保留<strong>会话列表与正文</strong>。常用动作自然地融入阅读，复杂信息收在下一层。</p><table><thead><tr><th>你想做的事</th><th>它出现的位置</th></tr></thead><tbody><tr><td>找回一句话</td><td>左侧搜索，或 ⌘ K</td></tr><tr><td>回到熟悉的会话</td><td>收藏与最近会话</td></tr><tr><td>调整阅读习惯</td><td>左下角的设置</td></tr></tbody></table><p>浅色像一张柔和的纸，深色像夜晚的书桌。两种主题共享同一套间距、字重与控件，让界面始终熟悉。</p><blockquote>下一次打开时，直接回到你想读的地方。</blockquote>' },
    ],
  },
  {
    id: 'garden', title: '阳台上的小花园', provider: 'Claude', date: '今天', time: '09:18', favorite: false,
    preview: '从薄荷、迷迭香和一盆小番茄开始。', project: '生活笔记',
    messages: [
      { role: 'user', time: '09:12', html: '<p>我有一个朝南的小阳台，想种一点香草。可以给我一个简单的开始方案吗？</p>' },
      { role: 'assistant', time: '09:18', html: '<h2>从三盆植物开始</h2><p>不用一次把阳台填满。给每一盆植物留下空间，也给自己留下观察的余地。</p><ol><li><strong>薄荷：</strong>单独一盆，适合放在容易浇水的位置。</li><li><strong>迷迭香：</strong>选择透气的花盆，让土壤有变干的时间。</li><li><strong>小番茄：</strong>留出最亮的位置，准备一根小支架。</li></ol><blockquote>先建立照料的节奏，再慢慢增加新的植物。</blockquote><p>准备一个小托盘、一把剪刀和一个浇水壶，就可以开始了。</p>' },
    ],
  },
  {
    id: 'notes', title: '给笔记工具减一点重量', provider: 'Codex', date: '今天', time: '08:56', favorite: true,
    preview: '保存应该可靠，界面应该轻巧。', project: 'Notes',
    messages: [
      { role: 'user', time: '08:42', html: '<p>这个笔记工具的工具栏有点重。请给一个更简洁的方案，保留搜索、阅读和导出就好。</p>' },
      { role: 'assistant', time: '08:56', html: '<h2>每一个按钮都需要理由</h2><p>把高频动作留在视线里，把低频动作收进菜单。用户进入阅读状态后，工具栏的存在感应该降低。</p><ul><li>标题栏只保留文档名、搜索和更多操作。</li><li>导出收在更多菜单中，并清楚标明格式。</li><li>保存状态用一个简短提示表达，不打断输入。</li></ul><h3>建议的顺序</h3><p>先统一间距和字号，再整理控件位置，最后补齐空白、加载、失败和完成状态。</p>' },
    ],
  },
  {
    id: 'weekend', title: '周末去山里走一走', provider: 'Claude', date: '昨天', time: '21:04', favorite: true,
    preview: '不赶行程，给散步和发呆留些时间。', project: '周末计划',
    messages: [
      { role: 'user', time: '20:58', html: '<p>帮我做一份轻松的周末安排。不需要具体目的地，只想离开电脑，出去走走。</p>' },
      { role: 'assistant', time: '21:04', html: '<h2>把周末留白一点</h2><p>只安排一件主要的事：找一条容易走的路线，慢慢走完。</p><table><thead><tr><th>时间</th><th>安排</th></tr></thead><tbody><tr><td>周六上午</td><td>睡到自然醒，吃完早餐再出发</td></tr><tr><td>周六下午</td><td>散步、拍照，在安静的地方喝杯茶</td></tr><tr><td>周日</td><td>整理照片，为下周准备一点食物</td></tr></tbody></table><blockquote>不需要把每一个小时都过得有成果。</blockquote>' },
    ],
  },
  {
    id: 'api', title: '整理 API 的错误响应', provider: 'Codex', date: '昨天', time: '16:32', favorite: false,
    preview: '让错误可读，也让下一步可执行。', project: 'Tiny API',
    messages: [
      { role: 'user', time: '16:20', html: '<p>想统一一下接口的错误响应。希望前端能够给用户一个清楚的提示。</p>' },
      { role: 'assistant', time: '16:32', html: '<h2>稳定的错误结构</h2><p>把机器可判断的 <code>code</code> 与给人阅读的 <code>message</code> 分开。不要直接把内部异常暴露给用户。</p><div class="code-block"><div class="code-heading"><span>JSON</span><button data-copy-code>复制代码</button></div><pre><code>{\n  "code": "SOURCE_UNAVAILABLE",\n  "message": "暂时无法读取这个来源",\n  "retryable": true\n}</code></pre></div><p>界面可以提供“重试”操作，同时保留已经显示的内容。失败不应该让用户丢失当前的阅读位置。</p>' },
    ],
  },
  {
    id: 'type', title: '中文排版的小细节', provider: 'Claude', date: '本周', time: '周一', favorite: false,
    preview: '好排版不是装饰，而是更少的阅读阻力。', project: '设计练习',
    messages: [
      { role: 'user', time: '14:02', html: '<p>桌面应用里，中文长文的字号、行距和行宽应该怎么搭配？</p>' },
      { role: 'assistant', time: '14:06', html: '<h2>先让文字舒展起来</h2><p>选择清晰的系统字体，用有节奏的段落间距来组织内容。标题不用特别大，足够区分层级就好。</p><ul><li><strong>字号：</strong>为不同视力和屏幕提供几个阅读档位。</li><li><strong>行距：</strong>中文密度更高，适当增加呼吸空间。</li><li><strong>行宽：</strong>避免句子横跨整个大屏幕。</li></ul><p>在设置里试着调整字号和阅读宽度，正文会立即变化。</p>' },
    ],
  },
  {
    id: 'untitled', title: '未命名会话', provider: 'Codex', date: '本周', time: '周一', favorite: false,
    preview: '如何把一个大任务拆成可验证的小步骤？', project: '个人项目',
    messages: [
      { role: 'user', time: '11:03', html: '<p>如何把一个大任务拆成可验证的小步骤？</p>' },
      { role: 'assistant', time: '11:05', html: '<h2>让每一步都有一个可见结果</h2><p>先写出完成时应该看到什么，再从中选出最小的一段完整体验。</p><ol><li>把目标写成用户能感知的结果。</li><li>为这一结果定义一项可验证的条件。</li><li>完成并检查，再进入下一步。</li></ol><p>这是一个正常的未命名聊天示例。没有名字，不代表它是后台审核记录。</p>' },
    ],
  },
];
