/* =====================================================================
   作文批改工作台 · 2.6.92（模拟皮皮改作文流程）
   面向：小学语文老师 | 形态：Web 主工作台 + 微信小程序端
   流程：选学生/题目 → 拍照或小程序收稿 → 自动识别手写原文 → 老师校对
        → 一键 AI 初批(总评/亮点/旁批/升格文) → 保存归档回写云端
   能力：作文自动识别(可插拔多模态模型)、可配置评语模板、升格文、旁批、
        分段点评、学生画像、姓名脱敏、五维评分、好词本、班级管理、
        自定义模型、网页/小程序双端、全班学情分析、范文库、素材集。
   说明：识别走 OpenAI 兼容多模态 /chat/completions（在「设置」中启用）；
        批改为规则引擎兜底，启用自定义模型后可生成文本类批语。
        未配置识别模型时保留手动录入，绝不用示例文本冒充识别结果。
   ===================================================================== */
'use strict';

/* ---------------- 评分标准（可配置） ---------------- */
const DEFAULT_STANDARDS = [
  { key: 'content',   name: '内容',   weight: 35, desc: '中心明确、有真情实感' },
  { key: 'structure', name: '结构',   weight: 20, desc: '段落清晰、有头有尾' },
  { key: 'language',  name: '语言',   weight: 25, desc: '语句通顺、用词生动' },
  { key: 'writing',   name: '书写标点', weight: 10, desc: '标点正确、错别字少' },
  { key: 'length',    name: '字数',   weight: 10, desc: '达到年段要求' },
];

/* ---------------- 批改词库 ---------------- */
const ERROR_WORDS = {
  '令天': '今天', '晴郎': '晴朗', '在见': '再见', '以经': '已经',
  '玩要': '玩耍', '蓝天': '蓝天', '座落': '坐落', '由忠': '由衷',
};
const GOOD_WORDS = [
  '兴高采烈','五颜六色','万里无云','生机勃勃','栩栩如生','引人入胜',
  '依依不舍','心旷神怡','波光粼粼','欢声笑语','春暖花开','五光十色',
  '千姿百态','翩翩起舞','美不胜收','五彩缤纷','小心翼翼','津津有味',
  '恍然大悟','连绵起伏','争奇斗艳','晶莹剔透','生机盎然','流连忘返',
];
const SICK_PATTERNS = [
  { re: /通过[^。，！？]*使[^。，！？]*/, msg: '“通过……使……”缺少主语，删去“通过”或“使”其一' },
  { re: /在[^。，！？]*中，使/,            msg: '介词结构淹没主语，删去“使”' },
  { re: /非常[^，。！？]*极了/,            msg: '“非常”与“极了”语义重复，保留一个' },
  { re: /大约[^，。！？]*左右/,            msg: '“大约”与“左右”重复，删去一个' },
  { re: /目的是为了/,                       msg: '“目的”与“为了”重复' },
  { re: /有没有[^。，！？]*是[^。，！？]*/, msg: '两面对一面，前后不一致' },
];

/* ---------------- 评语模板栏目定义 ---------------- */
const COLUMN_DEFS = [
  { type: 'total',     title: '总评' },
  { type: 'score',     title: '打分' },
  { type: 'dims',      title: '评价维度' },
  { type: 'upgraded',  title: '升格文' },
  { type: 'side',      title: '旁批' },
  { type: 'para',      title: '分段点评' },
];
const DEFAULT_TEMPLATES = [
  { id: 'tpl_std', name: '标准模板', isDefault: true, columns: COLUMN_DEFS.map(d => ({ ...d, enabled: true })) },
  { id: 'tpl_simple', name: '简评模板', isDefault: false, columns: [
    { type: 'total', title: '总评', enabled: true },
    { type: 'score', title: '打分', enabled: true },
  ] },
];

/* ---------------- 素材归类 ---------------- */
const MATERIAL_TYPES = ['好词','好句','精彩开头','精彩结尾','修辞佳句','细节描写','名言引用'];

/* ---------------- 示例作文 ---------------- */
const SAMPLE_ESSAY = `令天天气晴郎，万里无云。我和爸爸妈妈去公园玩，心里兴高采烈。
公园里五颜六色的花朵竞相开放，美丽极了。通过这一次游玩，使我非常开心极了。
我们又去湖边，波光粼粼的湖面像一面镜子。傍晚，我们依依不舍地回家了。`;
const SAMPLE_ESSAY_2 = `春暖花开的季节到了。校园里生机勃勃，柳枝在风中翩翩起舞。
老师带我们去找春天，我发现了许多千姿百态的小花。有没有认真观察，是写好作文的关键。
今天的收获大约有很多左右，真是流连忘返的一天。`;

/* ---------------- 数据 ---------------- */
const STORE_KEY = 'cw_data_v2';
let DATA = null;
let state = { view: 'dashboard', lastReport: null, matCat: '全部', stuId: null, pendingStu: null,
  essayImages: [], ocrDone: false, ocrText: '', ocrMsg: null };
let mpTabName = 'collect';

/* 2.6.92 作文自动识别配置（可插拔）：
   mode: 'vision' 走 OpenAI 兼容多模态模型 / 'off' 关闭自动识别（手动录入）
   vision 与批改用的 model 分开配置：识别要「看得见图」，批改只要文本。
   老数据没有该字段时在此补齐默认值，不覆盖已有设置。
   2.6.93 实测跨域（OPTIONS 带 Origin）：
     ✅ api.siliconflow.cn  → Access-Control-Allow-Origin: *，浏览器可直连
     ❌ open.bigmodel.cn / dashscope.aliyuncs.com → 无跨域头，网页直连必报 CORS
   故推荐硅基流动；智谱免费视觉模型需经自建代理转发才能用。 */
const VISION_PRESETS = [
  { key: 'sf-qwen3vl8b', label: '硅基流动 · Qwen3-VL-8B（推荐，便宜、支持直连）',
    baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-VL-8B-Instruct' },
  { key: 'sf-qwen3vl32b', label: '硅基流动 · Qwen3-VL-32B（手写更准，略贵）',
    baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen3-VL-32B-Instruct' },
  { key: 'sf-ocr', label: '硅基流动 · DeepSeek-OCR（专做文字转录，限免时可用）',
    baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-OCR' },
  { key: 'custom', label: '自定义端点 / 自建代理（如代理智谱 glm-4v-flash）',
    baseUrl: '', model: '' },
];
function defaultVision() {
  return { mode: 'off', baseUrl: '', apiKey: '', model: '', enabled: false };
}
function visionCfg() {
  if (!DATA.settings) DATA.settings = {};
  if (!DATA.settings.vision) DATA.settings.vision = defaultVision();
  return DATA.settings.vision;
}
function visionReady() {
  const v = visionCfg();
  return v.mode === 'vision' && v.enabled && !!(v.baseUrl && v.apiKey && v.model);
}

function save() { localStorage.setItem(STORE_KEY, JSON.stringify(DATA)); }
function load() {
  const raw = localStorage.getItem(STORE_KEY);
  if (raw) {
    try {
      DATA = JSON.parse(raw);
      if (!DATA.models) DATA.models = [];
      if (!DATA.materials) DATA.materials = [];
      if (!DATA.settings) DATA.settings = {};
      if (!DATA.settings.model) DATA.settings.model = { provider: 'workbuddy', baseUrl: '', apiKey: '', model: '', enabled: false };
      if (!DATA.settings.vision) DATA.settings.vision = defaultVision();
      if (!DATA.vocab) DATA.vocab = [];
      return;
    } catch (e) {}
  }
  DATA = seed(); save();
}
function uid() { return 'id' + Math.random().toString(36).slice(2, 9); }
function today() { return new Date().toISOString().slice(0, 10); }

function seed() {
  const cls = {
    id: uid(), name: '三年级(2)班', grade: '三年级',
    students: [
      { id: uid(), name: '小明', profile: { trait: '观察细致', foundation: '中等', style: '叙事清楚', attitude: '认真' }, essays: [] },
      { id: uid(), name: '小红', profile: { trait: '想象力丰富', foundation: '较好', style: '描写生动', attitude: '积极' }, essays: [] },
      { id: uid(), name: '小刚', profile: {}, essays: [] },
      { id: uid(), name: '小丽', profile: {}, essays: [] },
    ],
  };
  const preset = [
    { s: 0, title: '我的妈妈', text: '我的妈妈很温柔。她每天早起给我做饭，送我上学。妈妈的爱像春天的阳光，温暖极了。我要好好学习，报答妈妈的由忠付出。' },
    { s: 0, title: '下雨天',   text: '今天下雨了，蓝天下蒙蒙细雨。我和同学玩要，欢声笑语充满了校园。雨中的花草显得生机盎然。' },
    { s: 1, title: '秋天的校园', text: '秋天到了，校园里五颜六色的菊花争奇斗艳。我们在操场上奔跑，心情心旷神怡。这真是一个美丽的季节。' },
    { s: 3, title: '一次实验', text: '科学课上，老师做了一个实验。水里的盐晶莹剔透，慢慢融化。我恍然大悟，原来科学这么有趣！' },
  ];
  preset.forEach(p => {
    const r = grade(p.text, DEFAULT_STANDARDS, '标准', cls.students[p.s]);
    cls.students[p.s].essays.push({
      id: uid(), title: p.title, content: p.text, date: today(),
      total: r.total, scores: r.scores, report: r, status: 'done',
      teacherComment: r.studentComment, studentComment: r.studentComment, goodWords: r.goodWords,
    });
  });
  return {
    teacher: '李老师',
    settings: { desensitize: true, guides: true, model: { provider: 'workbuddy', baseUrl: '', apiKey: '', model: '', enabled: false }, vision: defaultVision() },
    standards: DEFAULT_STANDARDS,
    templates: JSON.parse(JSON.stringify(DEFAULT_TEMPLATES)),
    classes: [cls], vocab: [], models: [], materials: [],
  };
}

/* =====================================================================
   批改引擎（规则演示）
   ===================================================================== */
function escapeHtml(s) {
  return (s == null ? '' : String(s)).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function buildMarks(text) {
  const marks = [];
  for (const [wrong, right] of Object.entries(ERROR_WORDS)) {
    let i = text.indexOf(wrong);
    while (i !== -1) { marks.push({ start: i, end: i + wrong.length, cls: 'err', title: `错别字，应为「${right}」` }); i = text.indexOf(wrong, i + wrong.length); }
  }
  GOOD_WORDS.forEach(w => { let i = text.indexOf(w); while (i !== -1) { marks.push({ start: i, end: i + w.length, cls: 'good', title: '好词好句' }); i = text.indexOf(w, i + w.length); } });
  SICK_PATTERNS.forEach(p => { const m = text.match(p.re); if (m) marks.push({ start: m.index, end: m.index + m[0].length, cls: 'sick', title: p.msg }); });
  marks.sort((a, b) => a.start - b.start);
  const used = [], res = [];
  for (const mk of marks) { if (used.some(u => mk.start < u.end && mk.end > u.start)) continue; used.push(mk); res.push(mk); }
  return res;
}
function highlight(text) {
  const marks = buildMarks(text);
  if (!marks.length) return escapeHtml(text);
  let out = '', cur = 0;
  for (const mk of marks) {
    out += escapeHtml(text.slice(cur, mk.start));
    out += `<mark class="${mk.cls}" title="${escapeHtml(mk.title)}">${escapeHtml(text.slice(mk.start, mk.end))}</mark>`;
    cur = mk.end;
  }
  return out + escapeHtml(text.slice(cur));
}
function buildParagraphs(text) {
  const paras = (text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  return paras.map((p, i) => {
    const role = paras.length === 1 ? '全文' : (i === 0 ? '开头' : (i === paras.length - 1 ? '结尾' : '主体'));
    const good = GOOD_WORDS.filter(w => p.includes(w));
    const err = Object.keys(ERROR_WORDS).filter(w => p.includes(w));
    const sick = SICK_PATTERNS.filter(sp => sp.re.test(p));
    let comment = '';
    if (role === '开头') comment = good.length ? '开头用上了好词，挺吸引人。' : '开头可以更点题，先说清要写的事。';
    else if (role === '结尾') comment = '结尾要能收束全文、表达感受。';
    else comment = good.length ? '这一段描写生动，有画面感。' : '这一段可以再具体些，加点细节或真实感受。';
    let fix = '';
    if (err.length) fix += '错别字：' + err.join('、');
    if (sick.length) fix += (fix ? '；' : '') + '病句待调整';
    if (!fix) fix = '本段表达较通顺。';
    return { role, text: p, comment, fix };
  });
}
function buildSideComments(src, strength) {
  const sc = [];
  src.errors.forEach(e => sc.push({ type: '错别字', text: `「${e.word}」应为「${e.right}」` }));
  src.sick.forEach(s => sc.push({ type: '病句', text: s.msg }));
  src.goodWords.forEach(w => sc.push({ type: '好词', text: `「${w}」用得生动` }));
  const cap = strength === '简评' ? 3 : strength === '精批' ? sc.length : 6;
  return sc.slice(0, cap);
}
function buildUpgraded(text) {
  let t = text || '';
  for (const [w, r] of Object.entries(ERROR_WORDS)) t = t.split(w).join(r);
  return t;
}
function grade(text, standards, strength, student) {
  const clean = (text || '').trim();
  const chars = clean.replace(/\s/g, '').length;
  const paras = clean.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const paraCount = paras.length;

  const errors = [];
  for (const [wrong, right] of Object.entries(ERROR_WORDS)) {
    let i = clean.indexOf(wrong);
    while (i !== -1) { errors.push({ word: wrong, right, ctx: snippet(clean, i, wrong.length) }); i = clean.indexOf(wrong, i + wrong.length); }
  }
  const goodWords = [];
  GOOD_WORDS.forEach(w => { let i = clean.indexOf(w); while (i !== -1) { goodWords.push(w); i = clean.indexOf(w, i + w.length); } });
  const sick = [];
  SICK_PATTERNS.forEach(p => { const m = clean.match(p.re); if (m) sick.push({ ctx: m[0], msg: p.msg }); });

  const structureNote = [];
  if (paraCount >= 3) structureNote.push('段落分明，有开头、经过、结尾');
  else if (paraCount === 2) structureNote.push('有分段意识，建议中间再拆分一两段，层次更清楚');
  else structureNote.push('目前只有一段，建议分成“开头—经过—结尾”三段，条理更清晰');

  let content = 75; if (paraCount > 1) content += 10;
  content += Math.min(goodWords.length * 3, 10); content -= sick.length * 5 + errors.length * 3; content = clamp(content);
  let structure = paraCount >= 3 ? 85 : (paraCount === 2 ? 70 : 55); if (paraCount > 1) structure += 5; structure = clamp(structure);
  let language = 70 + Math.min(goodWords.length * 4, 20) - sick.length * 10 - errors.length * 3; language = clamp(language);
  let writing = clamp(100 - errors.length * 12);
  let lengthScore; if (chars < 150) lengthScore = 60; else if (chars < 250) lengthScore = 85; else if (chars <= 500) lengthScore = 100; else lengthScore = 92;

  const pct = { content, structure, language, writing, length: lengthScore };
  const total = Math.round(standards.reduce((s, st) => s + pct[st.key] * st.weight, 0) / 100);

  const level = total >= 90 ? '优秀' : total >= 80 ? '良好' : total >= 70 ? '中等' : '待改进';
  let studentComment = `你的作文被评为「${level}」（${total}分）。`;
  if (goodWords.length) studentComment += `老师特别喜欢你用的词语，比如“${goodWords.slice(0, 3).join('、')}”，很生动。`;
  if (errors.length) studentComment += `要注意${errors.length}个错别字哦，订正后作文会更棒。`;
  if (sick.length) studentComment += `还有${sick.length}处句子可以写得更通顺，看看老师的批注吧。`;
  studentComment += `继续加油，老师期待你下一篇更精彩！`;

  const teacherAdvice = [];
  if (errors.length) teacherAdvice.push(`错别字多为同音/形近字，可针对「${errors.map(e => e.word).join('、')}」做集中辨析`);
  if (sick.length) teacherAdvice.push('病句集中在句式杂糅，建议结合例句讲“主语缺失/语义重复”');
  if (goodWords.length) teacherAdvice.push(`已自动收录${goodWords.length}个好词到班级好词本，可用于仿写训练`);
  if (student && student.profile && student.profile.attitude === '认真') teacherAdvice.push('该生态度认真，可多给方法性建议促其精进');
  teacherAdvice.push('若作文由拍照OCR录入，请核对原文，避免识别误差影响批改');

  const paragraphs = buildParagraphs(clean);
  const sideComments = buildSideComments({ errors, sick, goodWords }, strength || '标准');
  const upgraded = buildUpgraded(clean);

  let profileNote = '';
  if (student && student.profile && (student.profile.foundation || student.profile.style || student.profile.attitude)) {
    const p = student.profile;
    profileNote = `已结合${displayName(student)}画像（基础：${p.foundation || '—'}｜风格：${p.style || '—'}｜态度：${p.attitude || '—'}）给出针对性建议。`;
  }

  return {
    chars, paraCount, errors, goodWords, sick, structureNote,
    paragraphs, sideComments, upgraded,
    scores: {
      content: { val: Math.round(content), full: 35 },
      structure: { val: Math.round(structure), full: 20 },
      language: { val: Math.round(language), full: 25 },
      writing: { val: Math.round(writing), full: 10 },
      length: { val: Math.round(lengthScore), full: 10 },
    },
    total, level, studentComment, teacherAdvice, profileNote,
  };
}
function clamp(n) { return Math.max(0, Math.min(100, n)); }
function snippet(text, i, len) {
  const a = Math.max(0, i - 6), b = Math.min(text.length, i + len + 6);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\n/g, ' ') + (b < text.length ? '…' : '');
}

/* =====================================================================
   自定义模型（WorkBuddy / OpenAI 兼容）
   ===================================================================== */
function extractJSON(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) {}
  const m = s.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}
async function callLLM(sys, user) {
  const m = DATA.settings.model;
  const base = (m.baseUrl || '').replace(/\/+$/, '');
  const url = base + '/chat/completions';
  const body = { model: m.model || 'deepseek-chat', messages: [{ role: 'system', content: sys }, { role: 'user', content: user }], temperature: 0.6 };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + m.apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}
async function enhanceWithModel(r, text, stu, strength) {
  const sys = '你是经验丰富的小学语文批改助手。根据用户提供的作文与学生画像，给出专业、鼓励且具体的点评。只输出 JSON，不要任何多余说明。';
  const prof = stu && stu.profile ? JSON.stringify(stu.profile) : '无';
  const user = `作文：\n${text}\n\n学生画像：${prof}\n批改力度：${strength}\n\n请返回 JSON：\n{"studentComment":"给学生的总评(鼓励+具体优点+改进方向)","teacherAdvice":["给老师的改进意见1","给老师的改进意见2"],"sideComments":[{"type":"错别字|病句|好词","text":"批注内容"}],"upgraded":"修正错别字并做润色后的全文"}`;
  const out = await callLLM(sys, user);
  const json = extractJSON(out);
  if (!json) throw new Error('模型未返回有效 JSON');
  if (json.studentComment) r.studentComment = json.studentComment;
  if (Array.isArray(json.teacherAdvice)) r.teacherAdvice = json.teacherAdvice;
  if (Array.isArray(json.sideComments)) r.sideComments = json.sideComments;
  if (json.upgraded) r.upgraded = json.upgraded;
  r.modelEnhanced = true;
  return r;
}
async function testModel() {
  const box = $('#modelTest'); if (!box) return;
  const m = DATA.settings.model;
  if (!m.baseUrl || !m.apiKey || !m.model) { box.style.display = 'block'; box.className = 'model-test err'; box.textContent = '请先填写完整的 Base URL / API Key / 模型名'; return; }
  box.style.display = 'block'; box.className = 'model-test wait'; box.textContent = '连接测试中…';
  try {
    const out = await callLLM('你是助手', '只回复 JSON：{"ok":true}');
    const j = extractJSON(out);
    if (j && j.ok !== undefined) { box.className = 'model-test ok'; box.textContent = '✓ 连接成功，模型可调用'; }
    else { box.className = 'model-test ok'; box.textContent = '✓ 已连通（返回：' + out.slice(0, 40) + '）'; }
  } catch (e) { box.className = 'model-test err'; box.textContent = '✗ 连接失败：' + e.message + '（若浏览器报 CORS，需经后端代理转发）'; }
}
function quickConfigWorkBuddy() {
  showModal('⚡ 一键配置 WorkBuddy 自定义模型', `
    <div id="wbModelsBox" class="wb-models-box"><div class="muted text-sm">🔄 正在检索 WorkBuddy 已载入的自定义模型…</div></div>
    <div class="divider"><span>或手动填写</span></div>
    <div class="model-form">
      <label>Base URL</label><input type="text" id="qbBase" placeholder="https://api.workbuddy.ai/v1" value="https://api.workbuddy.ai/v1">
      <label>API Key</label><input type="text" id="qbKey" placeholder="wb-...">
      <label>模型名</label><input type="text" id="qbModel" placeholder="如 wb-custom-essay">
    </div>
    <div class="ocr-note">提示：WorkBuddy 自定义模型通常为 OpenAI 兼容接口（/chat/completions）。</div>
  `, () => {
    DATA.settings.model = Object.assign(DATA.settings.model || {}, {
      provider: 'workbuddy',
      baseUrl: $('#qbBase').value.trim(),
      apiKey: $('#qbKey').value.trim(),
      model: $('#qbModel').value.trim(),
    });
    save(); renderSettings(); toast('已填入 WorkBuddy 模型配置，记得点「保存配置」并「测试连接」');
  }, '填入');
  /* 拉取宿主（WorkBuddy 工作台）已载入的自定义模型并渲染可选列表 */
  requestWbModels(function (models) {
    __wbModels = models || [];
    var box = document.getElementById('wbModelsBox');
    if (!box) return;
    if (!__wbModels.length) {
      box.innerHTML = '<div class="muted text-sm">ℹ️ WorkBuddy 暂未检测到已载入的自定义模型。可先在 WorkBuddy「评语 AI 接口」配置一个，或直接在下方手动填写。</div>';
      return;
    }
    box.innerHTML = '<div class="muted text-sm mb">✅ 检索到 ' + __wbModels.length + ' 个 WorkBuddy 自定义模型，点击即可部署到批改模型并启用：</div>' +
      __wbModels.map(function (m, i) {
        return '<div class="wb-model-item">' +
          '<div class="wb-model-info"><b>' + escapeHtml(m.name || m.model) + '</b>' +
          (m.note ? ' <span class="wb-model-note">' + escapeHtml(m.note) + '</span>' : '') +
          '<div class="wb-model-url">' + escapeHtml((m.baseUrl || '').replace(/\/+$/, '')) + ' · ' + escapeHtml(m.model || '') + '</div></div>' +
          '<button class="btn primary sm" onclick="deployWbModel(' + i + ')">⬇️ 部署到此</button>' +
          '</div>';
      }).join('');
  });
}
/* vT47 一键配置：检索并关联宿主（WorkBuddy 工作台）已载入的自定义模型 */
var __wbModels = [];
function requestWbModels(cb) {
  var done = false;
  function finish(list) { if (done) return; done = true; try { window.removeEventListener('message', onMsg); } catch (e) {} cb(list || []); }
  function onMsg(ev) {
    var d = ev.data || {};
    if (d && d.type === 'WB_MODELS' && Array.isArray(d.models)) finish(d.models);
  }
  window.addEventListener('message', onMsg);
  /* ① 优先 postMessage 问宿主（跨域也安全） */
  try { if (window.parent && window.parent !== window) window.parent.postMessage({ type: 'WB_REQ_MODELS' }, '*'); } catch (e) {}
  /* ② 同源直接读宿主配置（更快，免消息往返）：评语 AI 接口 + 通用自定义模型清单 */
  try {
    if (window.parent && window.parent !== window) {
      var list = [];
      var c = JSON.parse(window.parent.localStorage.getItem('wb_cm_ai_v1') || '{}');
      if (c && c.url && c.model) list.push({ name: (c.name || c.model), baseUrl: c.url, apiKey: c.key || '', model: c.model, note: '评语 AI 接口' });
      var arr = JSON.parse(window.parent.localStorage.getItem('wb_custom_models') || '[]');
      if (Array.isArray(arr)) arr.forEach(function (m) { if (m && m.url && m.model) list.push({ name: (m.name || m.model), baseUrl: m.url, apiKey: m.apiKey || '', model: m.model, note: (m.note || '自定义模型') }); });
      if (list.length) finish(list);
    }
  } catch (e) {}
  /* ③ 超时兜底（宿主无响应时给出手动填写入口） */
  setTimeout(function () { finish([]); }, 1500);
}
function deployWbModel(i) {
  var m = (__wbModels || [])[i]; if (!m) return;
  DATA.settings.model = {
    provider: 'workbuddy',
    baseUrl: (m.baseUrl || '').replace(/\/+$/, ''),
    apiKey: m.apiKey || '',
    model: m.model || '',
    enabled: true
  };
  save(); renderSettings(); closeModal();
  toast('✅ 已部署「' + (m.name || m.model) + '」到批改模型并启用，可点「测试连接」验证');
}
function saveModelConfig() {
  DATA.settings.model = {
    provider: $('#mProvider') ? $('#mProvider').value : 'workbuddy',
    baseUrl: $('#mBase') ? $('#mBase').value.trim() : '',
    apiKey: $('#mKey') ? $('#mKey').value.trim() : '',
    model: $('#mModel') ? $('#mModel').value.trim() : '',
    enabled: $('#mEnabled') ? $('#mEnabled').checked : false,
  };
  save(); toast('模型配置已保存' + (DATA.settings.model.enabled ? '（已启用）' : '（未启用）'));
}

/* ---------------- 姓名脱敏 ---------------- */
function studentIndex(id) { return DATA.classes[0].students.findIndex(s => s.id === id); }
function displayName(stu) {
  if (!stu) return '';
  if (!DATA || !DATA.settings || !DATA.settings.desensitize) return stu.name;
  return '学生' + String.fromCharCode(65 + studentIndex(stu.id));
}

/* =====================================================================
   2.6.92 作文自动识别（模拟皮皮流程：拍照 → 识别 → 回填原文 → 老师校对）
   识别通道：OpenAI 兼容「多模态」模型 /chat/completions，图片以
   image_url(dataURL) 随消息发送。手写中文识别只有视觉模型可用，
   本地 Tesseract 对手写体不可用，故做成可插拔适配器：
     - visionCfg().mode = 'vision' → 自动识别（推荐）
     - 'off'                      → 关闭，保留手动粘贴/录入兜底
   未配置或调用失败时，绝不塞示例文本冒充识别结果（旧版正是这个问题）。
   ===================================================================== */
const OCR_SYS = '你是一名严谨的中小学语文老师助手，专门把手写作文照片转录成文字。'
  + '要求：1) 逐字转录正文，保留原有分段，段间用空行分隔；'
  + '2) 不要改写、不要纠错、不要润色、不要总结、不要添加标题或任何说明；'
  + '3) 忽略页眉页码、姓名学号、老师红笔批注与打分、涂改液划掉的字；'
  + '4) 若某处实在辨认不清，用「□」代替，不要编造内容；'
  + '5) 有多张图时按图片顺序连成一篇，不要重复、不要分段标记页码；'
  + '6) 只输出作文正文，不要任何前后缀。';

/* 识别状态条：wait / ok / err */
function ocrNote(kind, msg, canConfig) {
  state.ocrMsg = { kind: kind || 'wait', msg: String(msg || ''), canConfig: !!canConfig };
  const note = $('#ocrNote');
  if (!note) return;
  note.classList.remove('hidden');
  note.innerHTML = '<span class="st ' + (kind || 'wait') + '">'
    + (kind === 'wait' ? '<span class="ocr-spin"></span>' : '')
    + escapeHtml(msg) + '</span>'
    + (canConfig ? ' <button class="btn ghost sm" style="margin-left:8px" onclick="navTo(\'settings\')">⚙️ 去配置识别</button>' : '');
}

/* 本地图片压缩：手机原图动辄数 MB，直接 base64 发给模型会超限。
   压到最长边 1600px、JPEG 0.86，通常 200~400KB。jsdom/无 canvas 时回退原图。 */
function fileToDataUrl(file, maxW) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const raw = String(fr.result || '');
      try {
        const img = new Image();
        img.onload = () => {
          try {
            const scale = Math.min(1, (maxW || 1600) / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL('image/jpeg', 0.86));
          } catch (e) { resolve(raw) }
        };
        img.onerror = () => resolve(raw);
        img.src = raw;
      } catch (e) { resolve(raw) }
    };
    fr.onerror = () => reject(new Error('读取照片失败'));
    fr.readAsDataURL(file);
  });
}

/* 调用一次多模态模型，返回转录文本 */
async function callVision(images, hint) {
  const v = visionCfg();
  const base = (v.baseUrl || '').replace(/\/+$/, '');
  if (!base || !v.apiKey || !v.model) throw new Error('识别模型未配置完整');
  const content = [{ type: 'text', text: '请转录这张/这些手写作文照片的正文。' + (hint || '') }];
  images.forEach(u => content.push({ type: 'image_url', image_url: { url: u } }));
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + v.apiKey },
    body: JSON.stringify({
      model: v.model, messages: [{ role: 'system', content: OCR_SYS }, { role: 'user', content }],
      temperature: 0.1, max_tokens: 4096,
    }),
  });
  if (!res.ok) throw new Error('识别接口 HTTP ' + res.status);
  const j = await res.json();
  const out = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  if (!out.trim()) throw new Error('识别模型返回空内容');
  return cleanOcr(out);
}
/* 去掉模型可能带的代码围栏/说明前缀 */
function cleanOcr(s) {
  let t = String(s || '').trim();
  t = t.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  t = t.replace(/^(作文正文|转录结果|识别结果|正文)\s*[:：]\s*/i, '').trim();
  return t;
}

/* 自动识别主流程：先整批发送，失败再逐页重试；结果回填 #essayText */
async function runRecognition(images, opts) {
  opts = opts || {};
  const list = (images || []).filter(Boolean);
  if (!list.length) { ocrNote('err', '没有可识别的作文照片，请先在小程序拍照上传或在此选择图片。', true); return false }
  if (!visionReady()) {
    ocrNote('err', '尚未启用「作文自动识别」。启用后拍照即自动转录原文；现在也可以对照照片手动输入/粘贴。', true);
    return false;
  }
  state.essayImages = list.slice();
  ocrNote('wait', '正在识别作文（' + list.length + ' 页）…');
  try {
    let text = '';
    try {
      text = await callVision(list, '');
    } catch (batchErr) {
      if (list.length < 2) throw batchErr;
      /* 整批失败 → 逐页识别再合并，单页失败不拖垮整篇 */
      const parts = [];
      for (let i = 0; i < list.length; i++) {
        ocrNote('wait', '正在识别第 ' + (i + 1) + '/' + list.length + ' 页…');
        try { parts.push(await callVision([list[i]], '这是第 ' + (i + 1) + ' 页，只转录本页正文。')) }
        catch (e) { parts.push('') }
      }
      text = parts.filter(Boolean).join('\n\n');
      if (!text.trim()) throw batchErr;
    }
    const sel = opts.target || '#essayText';
    const ta = $(sel);
    if (!ta) return false;
    ta.value = text;
    ta.placeholder = '识别结果已填入，请对照上方照片核对…';
    if (sel === '#essayText') { state.ocrDone = true; state.ocrText = text; }
    ocrNote('ok', '✓ 已自动识别 ' + list.length + ' 页原文，请对照照片核对后点「开始 AI 初批」');
    if (opts.toast !== false) toast('作文原文已自动识别，请核对');
    return true;
  } catch (e) {
    const raw = String((e && e.message) || '未知错误');
    /* 浏览器 CORS 失败通常表现为 Failed to fetch / NetworkError，给可操作指引 */
    const cors = /failed to fetch|networkerror|load failed|network request failed/i.test(raw);
    ocrNote('err', cors
      ? '识别请求被浏览器拦截（多半是端点不支持跨域 CORS）。请改用「识别设置」里的推荐端点（硅基流动），或把请求经自建代理转发；也可以先手动录入。'
      : '识别失败：' + raw + '。可点「重新识别」重试，或手动录入。', !visionReady());
    return false;
  }
}
/* 「重新识别」按钮：用当前已带入的照片重跑 */
function rerunRecognition() {
  if (!state.essayImages || !state.essayImages.length) { toast('没有作文照片，先拍照或让学生用小程序上传'); return }
  runRecognition(state.essayImages);
}

/* 拍照/连拍/上传 → 压缩 → 缩略图 → 自动识别 */
function setupCapture() {
  const input = $('#photoInput'); if (!input) return;
  input.onchange = async e => {
    const files = [...(e.target.files || [])]; if (!files.length) return;
    const prev = $('#imgPrev');
    if (prev) { prev.innerHTML = '<div class="thumbs"></div>'; }
    const box = prev && prev.querySelector('.thumbs');
    ocrNote('wait', '正在读取照片…');
    const urls = [];
    for (const f of files) {
      try {
        const u = await fileToDataUrl(f);
        urls.push(u);
        if (box) { const im = new Image(); im.src = u; im.className = 'thumb'; box.appendChild(im); }
      } catch (err) { /* 单张失败跳过，不阻断其余 */ }
    }
    if (!urls.length) { ocrNote('err', '照片读取失败，请重拍或换一张'); return }
    await runRecognition(urls);
  };
}

/* =====================================================================
   视图渲染
   ===================================================================== */
const $ = sel => document.querySelector(sel);
const view = () => $('#view');

function navTo(v) {
  state.view = v;
  document.querySelectorAll('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  const titles = {
  dashboard: ['工作台', '小学语文 · 作文批改工作台'],
  grade: ['批改工作台', '单篇作文 · AI 初批 + 老师复核'],
  classes: ['班级管理', '班级、学生与作文档案'],
  students: ['学生分析', '个性化诊断 · 分层训练 · 进度追踪'],
  insight: ['班级学情', '全班亮点、问题与改进意见'],
    standards: ['评分标准', '按年段配置各维度权重'],
    vocab: ['好词好句本', '从批改中自动收集的用语积累'],
    templates: ['评语模板', '配置批改报告的栏目结构'],
    models: ['范文库', '优秀作文入库与检索'],
    materials: ['素材集', '精彩片段分类沉淀'],
    miniapp: ['小程序版', '微信/手机端 · 收作业入口'],
    settings: ['设置', '隐私合规、自定义模型与录入偏好'],
  };
  $('#pageTitle').textContent = titles[v][0];
  $('#crumb').textContent = titles[v][1];
  if (v === 'dashboard') renderDashboard();
  else if (v === 'grade') renderGrade();
  else if (v === 'classes') renderClasses();
  else if (v === 'students') renderStudents();
  else if (v === 'insight') renderInsight();
  else if (v === 'standards') renderStandards();
  else if (v === 'vocab') renderVocab();
  else if (v === 'templates') renderTemplates();
  else if (v === 'models') renderModels();
  else if (v === 'materials') renderMaterials();
  else if (v === 'miniapp') renderMiniApp();
  else if (v === 'settings') renderSettings();
}

/* ---------- 首页 ---------- */
function renderDashboard() {
  const cls = DATA.classes[0];
  const all = cls.students.flatMap(s => s.essays);
  const doneStu = cls.students.filter(s => s.essays.length).length;
  const pending = cls.students.length - doneStu;
  const t = today();
  const todayDone = all.filter(e => e.date === t).length;
  const avg = all.length ? Math.round(all.reduce((s, e) => s + e.total, 0) / all.length) : 0;
  view().innerHTML = `
    <div class="grid cols-4 mb">
      ${statCard('📝', pending, '待批改', '本周待处理')}
      ${statCard('✅', todayDone, '今日已批', '今日完成')}
      ${statCard('👧', doneStu, '覆盖学生', `共 ${cls.students.length} 人`)}
      ${statCard('⭐', avg, '平均得分', '已批改均值')}
    </div>
    <div class="grid cols-2">
      <div class="card">
        <div class="section-title">🚀 快捷入口</div>
        <div class="row-actions">
          <button class="btn primary" onclick="navTo('grade')">➕ 批改一篇作文</button>
          <button class="btn" onclick="navTo('classes')">📚 查看班级档案</button>
          <button class="btn" onclick="navTo('insight')">📈 班级学情</button>
          <button class="btn" onclick="navTo('models')">🏆 范文库</button>
          <button class="btn" onclick="navTo('materials')">📦 素材集</button>
          <button class="btn" onclick="navTo('miniapp')">📱 小程序版</button>
        </div>
        <div class="ocr-note mt">📱 ${visionReady()
          ? '<b>作文自动识别已启用</b>：小程序收稿或这里拍照后，手写原文会自动转录并填入，老师核对后一键 AI 初批。'
          : '当前未启用「作文自动识别」：到「设置」启用多模态模型后，拍照即自动转录手写原文；现在也可直接录入/粘贴文字批改。'} <button class="btn ghost sm" onclick="navTo(\'settings\')">⚙️ 识别设置</button>${DATA.settings.desensitize ? '<b>当前已开启姓名脱敏。</b>' : ''}</div>
      </div>
      <div class="card">
        <div class="section-title">🕑 最近批改</div>
        ${all.length ? all.slice().reverse().slice(0, 5).map(e => {
          const st = cls.students.find(s => s.essays.includes(e));
          return `<div class="student-row"><span><b>${escapeHtml(e.title)}</b> <span class="pill">· ${escapeHtml(st ? st.name : '')}</span></span><span class="mini-score" style="color:${scoreColor(e.total)}">${e.total}</span></div>`;
        }).join('') : '<div class="empty">暂无批改记录</div>'}
      </div>
    </div>`;
}
function statCard(icon, num, label, chip) {
  return `<div class="card stat"><div class="icon">${icon}</div><div class="num">${num}</div><div class="label">${label}</div><div class="chip">${chip}</div></div>`;
}
function scoreColor(s) { return s >= 90 ? '#1a9c5b' : s >= 80 ? '#3fbf84' : s >= 70 ? '#f59e0b' : '#ef4444'; }

/* ---------- 批改工作台 ---------- */
function renderGrade() {
  const cls = DATA.classes[0];
  const stuOpts = cls.students.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  const tplOpts = DATA.templates.map(t => `<option value="${t.id}">${t.name}</option>`).join('');
  const guide = DATA.settings.guides
    ? `<div class="guide-card">📐 <b>取景规范</b>：方格纸四边贴框 · 本子放平 · 只保留框内画面、别带页眉姓名 · 支持<b>连拍</b>多页作文</div>` : '';
  const vOn = visionReady();
  view().innerHTML = `
    <div class="step-flow">
      <div class="sp on">① 选学生 / 题目</div>
      <div class="sp ${state.ocrDone ? 'on' : ''}">② 拍照自动识别</div>
      <div class="sp">③ 校对原文</div>
      <div class="sp">④ 一键 AI 初批</div>
      <div class="sp">⑤ 保存归档</div>
    </div>
    <div class="grade-wrap">
      <div class="panel">
        <div class="section-title">① 录入作文</div>
        <div class="toolbar">
          <select id="stuSel" style="max-width:150px">${stuOpts}</select>
          <input type="text" id="essayTitle" placeholder="作文题目" style="max-width:190px" value="我的周末">
          <button class="btn sm" onclick="openProfileById()">✎ 学生画像</button>
        </div>
        <div class="capture-zone">
          <div class="big">📷</div>
          <div>手机拍照 / 扫描作文，${vOn ? '<b>自动识别为文字</b>' : '可自动识别为文字（先在设置里启用）'}（支持连拍多页）</div>
          <div class="row-actions mt" style="justify-content:center">
            <button class="btn primary sm" id="captureBtn">📷 拍照 / 连拍 / 上传</button>
            <button class="btn sm ghost" onclick="loadSample(1)">载入示例①</button>
            <button class="btn sm ghost" onclick="loadSample(2)">载入示例②</button>
          </div>
          <input type="file" id="photoInput" accept="image/*" capture="environment" multiple class="hidden">
          <div id="imgPrev"></div>
        </div>
        <div class="ocr-bar">
          <span class="st" id="visionBadge">自动识别：${vOn ? '<b style="color:#157f4a">已启用</b>' : '<b style="color:#92600a">未启用</b>'}</span>
          <button class="btn sm ghost" onclick="rerunRecognition()">🔄 重新识别</button>
          <button class="btn sm ghost" onclick="navTo('settings')">⚙️ 识别设置</button>
        </div>
        <div class="ocr-note hidden" id="ocrNote"></div>
        ${guide}
        <label class="field">② 作文原文（识别后自动填入，请对照照片核对）</label>
        <textarea id="essayText" rows="11" placeholder="在此粘贴或输入作文内容…"></textarea>
        <div class="toolbar mt" style="margin-bottom:12px">
          <span class="muted text-sm">评语模板</span>
          <select id="tplSel" style="max-width:140px">${tplOpts}</select>
          <span class="muted text-sm" style="margin-left:10px">批改力度</span>
          <select id="strengthSel" style="max-width:110px"><option>简评</option><option selected>标准</option><option>精批</option></select>
          ${DATA.settings.model && DATA.settings.model.enabled ? '<span class="end-badge mp">AI：自定义模型</span>' : '<span class="end-badge web">AI：规则引擎</span>'}
        </div>
        <div class="row-actions">
          <button class="btn primary" id="runBtn">🤖 开始 AI 初批</button>
          <button class="btn ghost sm" onclick="clearEssay()">清空</button>
        </div>
      </div>
      <div class="panel" id="resultPanel">
        <div class="section-title">③ 批改建议（总评 / 亮点 / 改进 / 升格文）</div>
        <div class="empty" id="emptyHint"><div class="result-guide">
          <div style="font-size:26px;text-align:center;margin-bottom:6px">📋</div>
          批改结果会显示在这里，流程与皮皮改作文一致：<br>
          <b>1.</b> 上方选学生、拍照或让小程序收稿<br>
          <b>2.</b> 系统自动识别手写原文并填入左栏<br>
          <b>3.</b> 老师快速核对 / 修正识别误差<br>
          <b>4.</b> 点「🤖 开始 AI 初批」生成总评、亮点、旁批、升格文<br>
          <b>5.</b> 复核后「保存归档」，结果自动回写云端
        </div></div>
        <div id="reportArea" class="hidden"></div>
      </div>
    </div>`;
  $('#captureBtn').onclick = () => $('#photoInput').click();
  $('#runBtn').onclick = runGrade;
  if (state.pendingStu) { const sel = $('#stuSel'); if (sel) sel.value = state.pendingStu; state.pendingStu = null; }
  setupCapture();
  restoreImgPrev();
  if (state.ocrText) { const ta = $('#essayText'); if (ta) { ta.value = state.ocrText; ta.oninput = () => { state.ocrText = ta.value; }; } }
  else { const ta = $('#essayText'); if (ta) ta.oninput = () => { state.ocrText = ta.value; }; }
  if (state.ocrMsg) ocrNote(state.ocrMsg.kind, state.ocrMsg.msg, state.ocrMsg.canConfig);
}
/* 切视图重渲染时恢复已带入的照片与识别文字 */
function restoreImgPrev() {
  const imgs = state.essayImages || [];
  const prev = $('#imgPrev'); if (!prev || !imgs.length) return;
  prev.innerHTML = '<div class="thumbs"></div>';
  const box = prev.querySelector('.thumbs');
  imgs.forEach(src => { const im = new Image(); im.src = src; im.className = 'thumb'; box.appendChild(im); });
}

function loadSample(n) { $('#essayText').value = n === 1 ? SAMPLE_ESSAY : SAMPLE_ESSAY_2; toast('已载入示例作文，可点「开始 AI 初批」'); }
function clearEssay() {
  $('#essayText').value = ''; state.lastReport = null;
  state.ocrDone = false; state.ocrText = ''; state.ocrMsg = null;
  $('#reportArea').classList.add('hidden'); $('#emptyHint').classList.remove('hidden');
  const n = $('#ocrNote'); if (n) { n.classList.add('hidden'); n.innerHTML = ''; }
}
function openProfileById() { const sel = $('#stuSel'); if (sel) openProfile(sel.value); }

async function runGrade() {
  const text = $('#essayText').value.trim();
  if (!text) { toast('请先录入作文内容'); return; }
  const cls = DATA.classes[0];
  const stu = cls.students.find(s => s.id === $('#stuSel').value);
  const tpl = DATA.templates.find(t => t.id === $('#tplSel').value) || DATA.templates[0];
  const strength = $('#strengthSel').value;
  const btn = $('#runBtn'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> 批改中…';
  const useModel = !!(DATA.settings.model && DATA.settings.model.enabled);
  setTimeout(async () => {
    try {
      let r = grade(text, DATA.standards, strength, stu);
      if (useModel) {
        try { r = await enhanceWithModel(r, text, stu, strength); }
        catch (e) { console.warn('自定义模型增强失败，回退规则引擎：', e); toast('模型调用失败，已用规则引擎结果'); }
      }
      state.lastReport = { r, tplId: tpl.id, stuId: stu.id, title: $('#essayTitle').value.trim() || '未命名' };
      renderReport(r, tpl, stu);
      btn.disabled = false; btn.innerHTML = '🤖 重新 AI 初批';
      $('#emptyHint').classList.add('hidden'); $('#reportArea').classList.remove('hidden');
    } catch (e) {
      console.error(e); btn.disabled = false; btn.innerHTML = '🤖 开始 AI 初批'; toast('批改出错，请重试');
    }
  }, 600);
}

function block(title, inner) { return `<div class="block"><h4 style="margin-bottom:8px">${title}</h4>${inner}</div>`; }
function renderReport(r, tpl, student) {
  const name = displayName(student);
  const scoreBars = DATA.standards.map(st => {
    const sc = r.scores[st.key];
    return `<div class="score-row"><div class="top"><span>${st.name}</span><span><b>${sc.val}</b>/100（权重${st.weight}）</span></div><div class="score-bar"><div class="fill" style="width:${sc.val}%"></div></div></div>`;
  }).join('');
  const essayHtml = highlight($('#essayText').value);

  let cols = '';
  tpl.columns.filter(c => c.enabled).forEach(c => {
    if (c.type === 'total') cols += block('📝 总评', `<div class="comment">${escapeHtml(r.studentComment)}</div>` +
      (r.profileNote ? `<div class="comment mt" style="border-left-color:#7c3aed;background:#f6f3ff">${escapeHtml(r.profileNote)}</div>` : ''));
    if (c.type === 'score') cols += block('🔢 打分', `<div style="font-size:26px;font-weight:800;color:${scoreColor(r.total)}">${r.total} 分 · ${r.level}</div>`);
    if (c.type === 'dims') cols += block('📊 评价维度', scoreBars);
    if (c.type === 'upgraded') cols += block('✨ 升格文' + (r.modelEnhanced ? '（模型生成）' : ''), `<div class="upgraded">${escapeHtml(r.upgraded)}</div><div class="muted text-sm mt">已修正错别字并做润色示范，可在此基础上进一步精修。</div>`);
    if (c.type === 'side') cols += block('📍 旁批' + (r.modelEnhanced ? '（模型生成）' : ''), r.sideComments.length ? r.sideComments.map(s => `<div class="side-item"><span class="badge ${s.type === '错别字' ? 'err' : s.type === '病句' ? 'warn' : 'good'}">${s.type}</span><span>${escapeHtml(s.text)}</span></div>`).join('') : '<span class="muted text-sm">无</span>');
    if (c.type === 'para') cols += block('🧩 分段点评', r.paragraphs.map(p => `<div class="para-item"><div class="role">${p.role}</div><div class="cm">${escapeHtml(p.comment)}</div><div class="fix">改法：${escapeHtml(p.fix)}</div><div class="tx">${escapeHtml(p.text)}</div></div>`).join(''));
  });

  $('#reportArea').innerHTML = `
    <div class="grid cols-2" style="align-items:start">
      <div>
        <div style="display:flex;align-items:center;gap:16px" class="mb">
          <div class="score-circle" id="scCircle"><div class="inner" id="scNum">${r.total}</div></div>
          <div><div style="font-size:22px;font-weight:800;color:${scoreColor(r.total)}">${r.level}</div><div class="muted text-sm">字数 ${r.chars} · 段落 ${r.paraCount} · 学生 ${escapeHtml(name)}</div></div>
        </div>
        <div class="card" style="box-shadow:none"><div class="section-title" style="margin-bottom:8px">⚠️ 复核提示</div>${r.teacherAdvice.map(a => `<div class="text-sm" style="padding:3px 0">· ${escapeHtml(a)}</div>`).join('')}</div>
      </div>
      <div>
        <div class="badge brand mb">作文原貌（AI 标注：<span style="color:#b91c1c">错字</span> · <span style="color:#15803d">好词</span> · <span style="color:#b45309">病句</span>）</div>
        <div class="essay-box">${essayHtml}</div>
      </div>
    </div>
    <div class="card mt">${cols}</div>
    <div class="card mt">
      <div class="section-title">③ 老师复核（可修改）</div>
      <label class="field">总评分（${r.total}）</label>
      <input type="number" id="editTotal" value="${r.total}" min="0" max="100" style="max-width:120px">
      <label class="field mt">教师总评 / 个性批语</label>
      <textarea id="editComment" rows="3">${escapeHtml(r.studentComment)}</textarea>
      <div class="row-actions mt">
        <button class="btn green" onclick="saveEssay()">💾 保存并归档</button>
        <button class="btn" onclick="exportReport()">⬇️ 导出报告</button>
        <button class="btn sm" onclick="openCollectModel()">🏆 收藏为范文</button>
        <button class="btn sm" onclick="openCollectMaterial()">📦 收藏片段</button>
      </div>
    </div>`;
  const deg = Math.round(r.total * 3.6);
  $('#scCircle').style.background = `conic-gradient(${scoreColor(r.total)} ${deg}deg, #e8edf6 ${deg}deg)`;
}

function saveEssay() {
  const lr = state.lastReport; if (!lr) return;
  const cls = DATA.classes[0];
  const stu = cls.students.find(s => s.id === lr.stuId);
  const tpl = DATA.templates.find(t => t.id === lr.tplId) || DATA.templates[0];
  const r = lr.r;
  const total = parseInt($('#editTotal').value, 10) || r.total;
  const comment = $('#editComment').value.trim() || r.studentComment;
  const essay = {
    id: uid(), title: lr.title, content: $('#essayText').value, date: today(),
    total, scores: r.scores, report: r, status: 'done', teacherComment: comment,
    studentComment: comment, goodWords: r.goodWords, template: tpl.name,
  };
  stu.essays.push(essay);
  r.goodWords.forEach(w => { if (!DATA.vocab.find(v => v.word === w)) DATA.vocab.push({ word: w, from: displayName(stu), date: essay.date }); });
  save(); toast(`已归档到 ${displayName(stu)} 的作文档案`);
  if (window.EssayGrader) window.EssayGrader._notify('graded', { studentId: stu.id, studentName: stu.name, title: essay.title, total: essay.total, level: r.level, date: essay.date });
  renderDashboard(); navTo('dashboard');
}

function exportReport() {
  const lr = state.lastReport; if (!lr) return;
  const r = lr.r; const stu = DATA.classes[0].students.find(s => s.id === lr.stuId);
  const name = displayName(stu);
  const tplName = (DATA.templates.find(t => t.id === lr.tplId) || {}).name || '';
  const lines = [
    `作文批改报告`,
    `学生：${name}（已按隐私设置脱敏）  题目：${lr.title}  日期：${today()}`,
    `总评：${r.level}（${r.total}分）  字数：${r.chars}  段落：${r.paraCount}  模板：${tplName}`,
    ``,
    `【各维度】`, ...DATA.standards.map(st => `  ${st.name}：${r.scores[st.key].val}/100（权重${st.weight}）`),
    ``,
    `【错别字】${r.errors.length ? r.errors.map(e => `${e.word}→${e.right}`).join('，') : '无'}`,
    `【病句】${r.sick.length ? r.sick.map(s => s.ctx + '（' + s.msg + '）').join('；') : '无'}`,
    `【好词好句】${r.goodWords.join('、') || '无'}`,
    `【分段点评】`, ...r.paragraphs.map(p => `  [${p.role}] ${p.comment} 改法：${p.fix}`),
    `【升格文】${r.upgraded}`,
    `【给学生评语】${r.studentComment}`,
    ``, `（本报告姓名已脱敏处理；作文图片/文本属敏感数据，请依规存储。）`,
  ].join('\n');
  download(`批改报告_${name}_${lr.title}.txt`, lines);
  toast('报告已导出');
}

/* ---------- 班级管理 ---------- */
function renderClasses() {
  const cls = DATA.classes[0];
  const cards = cls.students.map(s => {
    const avg = s.essays.length ? Math.round(s.essays.reduce((a, e) => a + e.total, 0) / s.essays.length) : '—';
    const prof = s.profile && (s.profile.foundation || s.profile.style) ? `<div class="profile-tags"><span class="badge muted">${escapeHtml(s.profile.foundation || '基础—')}</span><span class="badge muted">${escapeHtml(s.profile.style || '风格—')}</span></div>` : '';
    return `<div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center"><b>${escapeHtml(s.name)}</b><span class="mini-score" style="color:${avg === '—' ? '#6b7280' : scoreColor(avg)}">${avg === '—' ? '未批改' : avg + '分'}</span></div>
      <div class="pill mt">已批改 ${s.essays.length} 篇 ${DATA.settings.desensitize ? '<span class="desens-badge">导出脱敏</span>' : ''}</div>
      ${prof}
      <div class="row-actions mt"><button class="btn sm" onclick="openProfile('${s.id}')">✎ 画像</button></div>
      ${s.essays.slice().reverse().slice(0, 3).map(e => `<div class="student-row"><span>${escapeHtml(e.title)}</span><span class="pill">${e.date}</span></div>`).join('') || '<div class="muted text-sm mt">暂无作文</div>'}
    </div>`;
  }).join('');
  view().innerHTML = `
    <div class="card mb"><div class="section-title">📚 ${cls.name}（${cls.grade}）</div>
      <div class="row-actions"><button class="btn sm" onclick="navTo('grade')">➕ 给该班批改</button><button class="btn sm" onclick="navTo('insight')">📈 班级学情分析</button></div></div>
    <div class="grid cols-4">${cards}</div>`;
}

/* ---------- 评分标准 ---------- */
function renderStandards() {
  const rows = DATA.standards.map((st, i) => `
    <div class="std-row">
      <b>${st.name}</b>
      <input type="range" min="0" max="50" value="${st.weight}" data-i="${i}" oninput="onStdChange(${i}, this.value)">
      <span class="std-total" id="stdw${i}">${st.weight}</span>
    </div>`).join('');
  view().innerHTML = `
    <div class="card"><div class="section-title">⚙️ 评分维度与权重</div>
      <div class="muted text-sm mb">按年段调整各维度权重。权重仅影响内部算法，总分仍归一到 100 分。</div>
      ${rows}
      <div class="std-row" style="border-top:2px solid var(--line);font-weight:700"><b>合计</b><span></span><span class="std-total" id="stdTotal">${DATA.standards.reduce((s, x) => s + x.weight, 0)}</span></div>
      <div class="row-actions mt"><button class="btn primary" onclick="saveStandards()">保存标准</button><button class="btn ghost" onclick="resetData()">重置演示数据</button></div>
    </div>`;
}
function onStdChange(i, v) { $('#stdw' + i).textContent = v; $('#stdTotal').textContent = DATA.standards.reduce((s, x, j) => s + (j === i ? +v : x.weight), 0); }
function saveStandards() { document.querySelectorAll('.std-row input[type=range]').forEach(inp => { DATA.standards[+inp.dataset.i].weight = +inp.value; }); save(); toast('评分标准已保存'); }

/* ---------- 评语模板 ---------- */
function renderTemplates() {
  const cards = DATA.templates.map(t => {
    const cols = t.columns.map(c => `<div class="tpl-col"><span class="tt">${c.title}</span><label class="switch"><input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="toggleCol('${t.id}','${c.type}')"><span class="slider"></span></label></div>`).join('');
    return `<div class="card tpl-card"><div style="display:flex;justify-content:space-between;align-items:center"><b>${escapeHtml(t.name)}</b>${t.isDefault ? '<span class="badge brand">默认</span>' : `<button class="btn ghost sm" onclick="deleteTemplate('${t.id}')">删除</button>`}</div>${cols}</div>`;
  }).join('');
  view().innerHTML = `
    <div class="card mb"><div class="section-title">📝 评语模板</div>
      <div class="muted text-sm mb">勾选启用的栏目，决定批改报告的结构。可新建模板，按班级/年段灵活配置。</div>
      <button class="btn primary sm" onclick="addTemplate()">＋ 新建模板</button></div>
    <div class="grid cols-3">${cards}</div>`;
}
function toggleCol(tplId, type) { const t = DATA.templates.find(x => x.id === tplId); const c = t.columns.find(x => x.type === type); if (c) { c.enabled = !c.enabled; save(); } }
function addTemplate() {
  const id = 'tpl_' + Math.random().toString(36).slice(2, 7);
  DATA.templates.push({ id, name: '新模板' + (DATA.templates.length + 1), isDefault: false, columns: COLUMN_DEFS.map(d => ({ ...d, enabled: true })) });
  save(); renderTemplates();
}
function deleteTemplate(id) { DATA.templates = DATA.templates.filter(t => t.id !== id); save(); renderTemplates(); }

/* ---------- 好词本 ---------- */
function renderVocab() {
  const list = DATA.vocab.length ? DATA.vocab.slice().reverse().map(v => `<span class="badge good" style="margin:0 6px 8px 0;display:inline-block;font-size:13px">${escapeHtml(v.word)} <span class="pill">${escapeHtml(v.from)}</span></span>`).join('') : '<div class="empty"><div class="big">💡</div>批改作文后会自动收集好词好句到这里</div>';
  view().innerHTML = `<div class="card"><div class="section-title">💡 好词好句本（${DATA.vocab.length}）</div><div>${list}</div></div>`;
}

/* ---------- 班级学情分析 ---------- */
function analyzeClass() {
  const cls = DATA.classes[0];
  const all = cls.students.flatMap(s => s.essays.map(e => ({ e, stu: s })));
  const n = all.length;
  const avg = n ? Math.round(all.reduce((a, { e }) => a + e.total, 0) / n) : 0;
  const dims = {};
  DATA.standards.forEach(st => { dims[st.key] = n ? Math.round(all.reduce((a, { e }) => a + (e.scores[st.key] ? e.scores[st.key].val : 0), 0) / n) : 0; });
  const errCount = {}, goodFreq = {}, sickCount = {};
  all.forEach(({ e }) => {
    (e.report.errors || []).forEach(x => errCount[x.word] = (errCount[x.word] || 0) + 1);
    (e.goodWords || []).forEach(w => goodFreq[w] = (goodFreq[w] || 0) + 1);
    (e.report.sick || []).forEach(s => { const k = s.msg || s.ctx || '病句'; sickCount[k] = (sickCount[k] || 0) + 1; });
  });
  const topErr = Object.entries(errCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topGood = Object.entries(goodFreq).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topSick = Object.entries(sickCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const excellent = all.filter(({ e }) => e.total >= 90).length;
  const weak = all.filter(({ e }) => e.total < 70).length;
  const lowDim = DATA.standards.reduce((min, st) => dims[st.key] < dims[min.key] ? st : min, DATA.standards[0]);
  const highDim = DATA.standards.reduce((max, st) => dims[st.key] > dims[max.key] ? st : max, DATA.standards[0]);
  const advice = [];
  if (topErr.length) advice.push(`错别字集中在「${topErr[0][0]}」等（累计 ${topErr.reduce((a, [, c]) => a + c, 0)} 处），建议做同音/形近字专项辨析训练。`);
  if (topSick.length) advice.push(`病句以「${topSick[0][0].slice(0, 18)}…」类型最突出，建议结合例句讲清句式杂糅与主语缺失。`);
  if (dims[lowDim.key] < 75) advice.push(`「${lowDim.name}」全班均分仅 ${dims[lowDim.key]}，为相对弱项：${dimAdvice(lowDim.key)}`);
  if (highDim.key !== lowDim.key) advice.push(`「${highDim.name}」表现突出（均分 ${dims[highDim.key]}），可办班级佳作展，让强项带动整体。`);
  if (weak) advice.push(`有待改进作文 ${weak} 篇，建议点对点面批，先抓错别字与字数达标。`);
  if (!advice.length) advice.push('本班整体表现均衡，可进一步提升立意深度与语言丰富度。');
  return { n, avg, dims, topErr, topGood, topSick, excellent, weak, lowDim, highDim, advice };
}
function dimAdvice(key) {
  return ({ content: '加强素材积累与真情实感引导', structure: '训练列提纲、强化分段意识', language: '用好词好句仿写提升表达', writing: '强化订正习惯与标点规范', length: '做扩写与细节描写训练' })[key] || '开展针对性专项训练';
}
function radarChart(dims) {
  const keys = DATA.standards.map(s => s.key);
  const labels = DATA.standards.map(s => s.name);
  const vals = keys.map(k => dims[k] || 0);
  const cx = 160, cy = 150, R = 100, N = keys.length;
  const pt = (i, r) => { const ang = -Math.PI / 2 + i * 2 * Math.PI / N; return [cx + r * Math.cos(ang), cy + r * Math.sin(ang)]; };
  let rings = '';
  [0.25, 0.5, 0.75, 1].forEach(rr => { const p = keys.map((_, i) => pt(i, R * rr).join(',')).join(' '); rings += `<polygon points="${p}" fill="none" stroke="#e2ece7" stroke-width="1"/>`; });
  let axes = '';
  keys.forEach((_, i) => { const [x, y] = pt(i, R); axes += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#e2ece7"/>`; });
  const dataPts = vals.map((v, i) => pt(i, R * v / 100).join(',')).join(' ');
  let labelsSvg = '';
  keys.forEach((_, i) => { const [x, y] = pt(i, R + 20); labelsSvg += `<text x="${x}" y="${y}" font-size="11" fill="#76867e" text-anchor="middle" dominant-baseline="middle">${labels[i]}\n${vals[i]}</text>`; });
  return `<svg class="radar" viewBox="0 0 320 300" width="100%">${rings}${axes}<polygon points="${dataPts}" fill="rgba(26,156,91,.18)" stroke="#1a9c5b" stroke-width="2"/>${labelsSvg}</svg>`;
}
function renderInsight() {
  const a = analyzeClass();
  if (!a.n) { view().innerHTML = `<div class="card"><div class="empty"><div class="big">📈</div>本班还没有批改记录，先去「批改工作台」批几篇，再来分析全班亮点与问题。</div></div>`; return; }
  const maxErr = a.topErr.length ? Math.max(...a.topErr.map(x => x[1])) : 1;
  const errHtml = a.topErr.length ? a.topErr.map(([w, c]) => `<div class="pb-item"><span class="tag-chip" style="background:var(--red-bg);color:var(--red)">${escapeHtml(w)}</span><span class="bar-mini"><i style="width:${c / maxErr * 100}%"></i></span><span class="mp-mini">${c}次</span></div>`).join('') : '<div class="muted text-sm">无</div>';
  const goodHtml = a.topGood.length ? a.topGood.map(([w, c]) => `<span class="tag-chip g" style="margin:0 6px 8px 0">${escapeHtml(w)} ×${c}</span>`).join('') : '<div class="muted text-sm">无</div>';
  const sickHtml = a.topSick.length ? a.topSick.map(([k, c]) => `<div class="pb-item"><span class="tag-chip" style="background:var(--amber-bg);color:#b45309">${escapeHtml(k.slice(0, 16))}</span><span class="mp-mini">${c}次</span></div>`).join('') : '<div class="muted text-sm">无</div>';
  const dimBars = DATA.standards.map(st => `<div class="score-row"><div class="top"><span>${st.name}</span><span><b>${a.dims[st.key]}</b>/100</span></div><div class="score-bar"><div class="fill" style="width:${a.dims[st.key]}%"></div></div></div>`).join('');
  view().innerHTML = `
    <div class="insight-grid mb">
      ${statCard('📝', a.n, '已批作文', '全班累计')}
      ${statCard('⭐', a.avg, '平均得分', '已批均值')}
      ${statCard('🏆', a.excellent, '优秀(≥90)', `占比${Math.round(a.excellent / a.n * 100)}%`)}
      ${statCard('⚠️', a.weak, '待改进(<70)', '需面批')}
    </div>
    <div class="grid cols-2 mb">
      <div class="card">
        <div class="section-title">📊 五维能力雷达</div>
        <div class="radar-wrap">${radarChart(a.dims)}</div>
        <div class="mt">${dimBars}</div>
      </div>
      <div class="card">
        <div class="section-title">✨ 班级亮点</div>
        <div class="highlight-box">
          <div class="hl-item"><span class="tag-chip b">最强维度</span><span>${a.highDim.name}（均分 ${a.dims[a.highDim.key]}）</span></div>
          <div class="hl-item"><span class="tag-chip b">高频好词</span><div>${goodHtml}</div></div>
          <div class="hl-item"><span class="tag-chip b">优秀作文</span><span>${a.excellent} 篇，可作范文讲评</span></div>
        </div>
        <div class="section-title" style="margin-top:16px">🔧 共性问题</div>
        <div class="problem-box">
          <div class="pb-item"><span class="tag-chip" style="background:var(--red-bg);color:var(--red)">最弱维度</span><span>${a.lowDim.name}（均分 ${a.dims[a.lowDim.key]}）</span></div>
          <div style="font-size:12px;color:var(--muted);margin:4px 0 8px">高频错别字</div>${errHtml}
          <div style="font-size:12px;color:var(--muted);margin:8px 0">高频病句类型</div>${sickHtml}
        </div>
      </div>
    </div>
    <div class="card">
      <div class="section-title">💡 改进意见</div>
      <ul class="advice-list">${a.advice.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      <div class="ocr-note mt">ℹ️ 以上分析基于本班已批改数据自动生成；若已配置并启用自定义模型，AI 初批的文本类批语即由该模型产出。</div>
    </div>`;
}

/* ---------- 范文库 ---------- */
function renderModels() {
  view().innerHTML = `
    <div class="card mb"><div class="section-title">🏆 范文库（${DATA.models.length}）</div>
      <div class="muted text-sm mb">将优秀作文入库，按年级/文体/主题归类，供全班仿写、讲评与公开课参考。</div>
      <input class="search-box" id="mSearch" placeholder="搜索题目 / 作者 / 主题" oninput="filterModels()">
    </div>
    <div class="grid cols-3" id="modelList"></div>`;
  filterModels();
}
function filterModels() {
  const q = (($('#mSearch') && $('#mSearch').value) || '').trim().toLowerCase();
  const list = DATA.models.filter(m => !q || (m.title + m.author + (m.tags.theme || '')).toLowerCase().includes(q));
  const box = $('#modelList'); if (!box) return;
  box.innerHTML = list.length ? list.slice().reverse().map(m => `
    <div class="card model-card" onclick="viewModel('${m.id}')">
      <div style="display:flex;justify-content:space-between;align-items:center;cursor:pointer"><b>${escapeHtml(m.title)}</b><span class="mini-score" style="color:${scoreColor(m.score)}">${m.score}分·${m.level}</span></div>
      <div class="meta">${escapeHtml(m.author)} · ${m.tags.grade} · ${m.tags.type}${m.tags.theme ? ' · ' + escapeHtml(m.tags.theme) : ''}</div>
      <div class="mt">${(m.note ? `<span class="tag-chip g">${escapeHtml(m.note.slice(0, 30))}</span>` : '')}<span class="tag-chip b">${m.date}</span></div>
    </div>`).join('') : '<div class="empty"><div class="big">🏆</div>还没有范文，批改后点「收藏为范文」即可入库</div>';
}
function viewModel(id) {
  const m = DATA.models.find(x => x.id === id); if (!m) return;
  const dims = DATA.standards.map(st => `${st.name} ${m.dims && m.dims[st.key] ? m.dims[st.key].val : '-'}/100`).join(' · ');
  showModal('🏆 ' + m.title, `
    <div style="color:var(--muted);font-size:12px;margin-bottom:10px">${escapeHtml(m.author)} · ${m.tags.grade} · ${m.tags.type} · ${m.date} · ${m.score}分(${m.level})</div>
    <div class="upgraded">${escapeHtml(m.content)}</div>
    <div class="mt"><b>各维度：</b>${dims}</div>
    ${m.note ? `<div class="mt"><b>教学要点：</b>${escapeHtml(m.note)}</div>` : ''}
    <div class="row-actions mt"><button class="btn sm" onclick="exportModel('${m.id}')">⬇️ 导出</button><button class="btn sm ghost" onclick="deleteModel('${m.id}')">删除</button></div>
  `);
}
function deleteModel(id) { DATA.models = DATA.models.filter(x => x.id !== id); save(); renderModels(); toast('已删除'); }
function exportModel(id) { const m = DATA.models.find(x => x.id === id); if (!m) return; download('范文_' + m.title + '.txt', m.content); toast('已导出'); }
function openCollectModel() {
  const lr = state.lastReport; if (!lr) { toast('请先完成一篇批改'); return; }
  const grades = ['一年级', '二年级', '三年级', '四年级', '五年级', '六年级'];
  const types = ['写人', '记事', '写景', '状物', '想象', '应用文', '其他'];
  showModal('🏆 收藏为范文', `
    <div class="model-form">
      <label>题目</label><input type="text" id="fmTitle" value="${escapeHtml(lr.title)}">
      <label>年级</label><select id="fmGrade">${grades.map(g => `<option>${g}</option>`).join('')}</select>
      <label>文体</label><select id="fmType">${types.map(t => `<option>${t}</option>`).join('')}</select>
      <label>主题</label><input type="text" id="fmTheme" placeholder="如：亲情/季节/校园">
    </div>
    <div class="field-row"><label>备注</label><textarea id="fmNote" rows="2" placeholder="推荐理由/教学要点"></textarea></div>
    <div class="ocr-note mt">将存入「范文库」，可按年级/文体/主题检索，供全班仿写与讲评使用。</div>
  `, () => {
    const stu = DATA.classes[0].students.find(s => s.id === lr.stuId);
    DATA.models.push({
      id: uid(), title: $('#fmTitle').value.trim() || lr.title,
      author: displayName(stu), content: $('#essayText').value,
      score: lr.r.total, level: lr.r.level, dims: lr.r.scores,
      tags: { grade: $('#fmGrade').value, type: $('#fmType').value, theme: $('#fmTheme').value.trim() },
      note: $('#fmNote').value.trim(), date: today(),
    });
    save(); toast('已收藏为范文');
    if (window.EssayGrader) window.EssayGrader._notify('model_collected', { id: DATA.models[DATA.models.length - 1].id, title: lr.title, studentId: lr.stuId, score: lr.r.total });
  }, '收藏');
}

/* ---------- 素材集 ---------- */
function renderMaterials() {
  const cat = state.matCat || '全部';
  const tabs = ['全部', ...MATERIAL_TYPES].map(t => `<button class="cat-tab ${cat === t ? 'active' : ''}" onclick="matCatSwitch('${t}')">${t}</button>`).join('');
  view().innerHTML = `
    <div class="card mb"><div class="section-title">📦 素材集（${DATA.materials.length}）</div>
      <div class="muted text-sm mb">把精彩片段按类收集，备好词好句、精彩开头/结尾、修辞佳句等，作文课随取随用。</div>
      <div class="cat-tabs">${tabs}</div>
      <input class="search-box" id="matSearch" placeholder="搜索片段内容 / 来源" oninput="filterMaterials()">
    </div>
    <div class="grid cols-3" id="materialList"></div>`;
  filterMaterials();
}
function filterMaterials() {
  const cat = state.matCat || '全部';
  const q = (($('#matSearch') && $('#matSearch').value) || '').trim().toLowerCase();
  let list = DATA.materials;
  if (cat !== '全部') list = list.filter(m => m.type === cat);
  if (q) list = list.filter(m => (m.fragment + m.source + m.type).toLowerCase().includes(q));
  const box = $('#materialList'); if (!box) return;
  box.innerHTML = list.length ? list.slice().reverse().map(m => `
    <div class="card material-card">
      <div style="display:flex;justify-content:space-between;align-items:center"><span class="mtype-badge ${mtypeClass(m.type)}">${m.type}</span><button class="btn ghost sm" onclick="deleteMaterial('${m.id}')">删除</button></div>
      <div class="frag mt">${escapeHtml(m.fragment)}</div>
      <div class="src">来源：${escapeHtml(m.source || '—')} · ${m.date}</div>
    </div>`).join('') : '<div class="empty"><div class="big">📦</div>还没有素材，批改后点「收藏片段」即可按类沉淀</div>';
}
function matCatSwitch(t) { state.matCat = t; renderMaterials(); }
function mtypeClass(t) { const i = MATERIAL_TYPES.indexOf(t); return 't' + (i < 0 ? 0 : Math.min(i, 3)); }
function deleteMaterial(id) { DATA.materials = DATA.materials.filter(x => x.id !== id); save(); renderMaterials(); toast('已删除'); }
function openCollectMaterial() {
  const lr = state.lastReport; if (!lr) { toast('请先完成一篇批改'); return; }
  const r = lr.r;
  const cands = [];
  r.goodWords.forEach(w => cands.push({ frag: w, type: '好词' }));
  r.paragraphs.forEach(p => { if (p.text) cands.push({ frag: p.text, type: p.role === '开头' ? '精彩开头' : p.role === '结尾' ? '精彩结尾' : '好句' }); });
  const sel = cands.map((c, i) => `<div class="check-row"><input type="checkbox" data-i="${i}" checked><span class="type-sel">${escapeHtml(c.frag.slice(0, 40))}</span><select class="ctype" data-i="${i}">${MATERIAL_TYPES.map(t => `<option ${t === c.type ? 'selected' : ''}>${t}</option>`).join('')}</select></div>`).join('');
  showModal('📦 收藏精彩片段到素材集', `
    <div class="muted text-sm mb">勾选要入库的片段，并可调整归类（好词/好句/精彩开头/精彩结尾/修辞佳句/细节描写/名言引用）。</div>
    <div id="matCands">${sel}</div>
  `, () => {
    document.querySelectorAll('#matCands input[type=checkbox]').forEach(cb => {
      if (cb.checked) {
        const i = +cb.dataset.i;
        const type = document.querySelector(`#matCands .ctype[data-i="${i}"]`).value;
        DATA.materials.push({ id: uid(), fragment: cands[i].frag, type, source: lr.title, date: today() });
      }
    });
    save(); toast('已收藏片段到素材集');
    if (window.EssayGrader) window.EssayGrader._notify('material_collected', { count: document.querySelectorAll('#matCands input[type=checkbox]:checked').length, source: lr.title });
  }, '入库');
}

/* ---------- 小程序版（双端） ---------- */
function renderMiniApp() {
  const active = t => mpTabName === t ? 'active' : '';
  view().innerHTML = `
    <div class="miniapp-wrap">
      <div class="miniapp-tip">
        <div class="card"><div class="section-title">📱 小程序版（微信 / 手机浏览器）</div>
          <p class="muted text-sm">老师用手机打开工作台即进入小程序版，主要做「收作业 / 拍照扫描 / 查看批改」。数据与本工作台实时互通，回办公室用网页版做深度批改与学情分析。</p>
          <div class="ocr-note mt">演示：下方为小程序界面预览。点底部 Tab 切换；在「收作业」里选学生 → 拍照/上传 → 提交，作文会同步进网页版班级管理。</div>
          <div class="row-actions mt"><span class="end-badge mp">当前：小程序端</span><span class="end-badge web">网页端：其余菜单</span></div>
        </div>
        <div class="card mt"><div class="section-title">🧭 双端协同建议</div>
          <div class="text-sm" style="line-height:1.9">· 移动端：扫码进班、连拍收作业、当场给等级<br>· 网页端：AI 初批、老师复核、学情分析、范文/素材沉淀<br>· 数据统一存储，正式版建议后端私有化部署</div>
        </div>
      </div>
      <div class="phone">
        <div class="phone-screen">
          <div class="mp-statusbar"><span>9:41</span><span>📶 🔋</span></div>
          <div class="mp-header">作文批改 · 小程序</div>
          <div class="mp-body" id="mpBody"></div>
          <div class="mp-tabbar">
            <button class="mp-tab ${active('collect')}" onclick="mpTab('collect')"><span class="ti">📷</span>收作业</button>
            <button class="mp-tab ${active('class')}" onclick="mpTab('class')"><span class="ti">📚</span>班级</button>
            <button class="mp-tab ${active('me')}" onclick="mpTab('me')"><span class="ti">👤</span>我的</button>
          </div>
        </div>
      </div>
    </div>`;
  mpRender();
}
function mpTab(t) { mpTabName = t; renderMiniApp(); }
function mpRender() {
  const body = $('#mpBody'); if (!body) return;
  if (mpTabName === 'collect') {
    const cls = DATA.classes[0];
    const opts = cls.students.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
    body.innerHTML = `
      <div class="mp-card">
        <h4>📷 收作业</h4>
        <select id="mpStu" style="width:100%;margin-bottom:8px;padding:8px;border-radius:8px;border:1px solid var(--line)">${opts}</select>
        <div class="mp-capture">
          <div style="font-size:26px">📷</div>
          <div style="font-size:12px">拍照 / 连拍 / 上传作文</div>
          <button class="btn primary sm mt" onclick="$('#mpPhoto').click()">选择图片</button>
          <input type="file" id="mpPhoto" accept="image/*" capture="environment" multiple class="hidden">
        </div>
        <textarea class="mp-textarea mt" id="mpText" placeholder="识别后的作文文字会出现在这里（演示自动填入示例）"></textarea>
        <button class="btn green sm mt" style="width:100%" onclick="mpCollectSubmit()">提交批改并归档</button>
      </div>`;
    mpSetupCapture();
  } else if (mpTabName === 'class') {
    const cls = DATA.classes[0];
    body.innerHTML = cls.students.map(s => {
      const avg = s.essays.length ? Math.round(s.essays.reduce((a, e) => a + e.total, 0) / s.essays.length) : '—';
      return `<div class="mp-card"><div class="mp-stu"><b>${s.name}</b><span class="mini-score" style="color:${avg === '—' ? '#6b7280' : scoreColor(avg)}">${avg === '—' ? '未批' : avg + '分'}</span></div>${s.essays.slice().reverse().slice(0, 3).map(e => `<div class="mp-mini">· ${escapeHtml(e.title)} <span class="pill">${e.date}</span></div>`).join('') || '<div class="mp-mini">暂无作文</div>'}</div>`;
    }).join('');
  } else {
    const m = DATA.settings.model;
    body.innerHTML = `
      <div class="mp-card"><h4>👤 我的</h4>
        <div class="mp-stu"><span>教师</span><b>${escapeHtml(DATA.teacher)}</b></div>
        <div class="mp-stu"><span>姓名脱敏</span><b style="color:${DATA.settings.desensitize ? 'var(--green)' : 'var(--red)'}">${DATA.settings.desensitize ? '已开启' : '关闭'}</b></div>
        <div class="mp-stu"><span>自定义模型</span><b style="color:${m && m.enabled ? 'var(--green)' : 'var(--muted)'}">${m && m.enabled ? '已启用' : '未启用'}</b></div>
        <button class="btn sm mt" style="width:100%" onclick="navTo('settings')">去设置模型 / 隐私</button>
      </div>
      <div class="mp-card"><div class="mp-mini">本机数据 · 双端互通<br>回办公室用网页版做深度批改与学情分析</div></div>`;
  }
}
function mpSetupCapture() {
  const input = $('#mpPhoto'); if (!input) return;
  input.onchange = async e => {
    const files = [...(e.target.files || [])]; if (!files.length) return;
    if (!visionReady()) { toast('请先在「设置」启用作文自动识别，或手动粘贴原文'); return }
    toast('正在识别作文…');
    const urls = [];
    for (const f of files) { try { urls.push(await fileToDataUrl(f)) } catch (err) {} }
    if (!urls.length) { toast('照片读取失败'); return }
    const ok = await runRecognition(urls, { target: '#mpText', toast: false });
    toast(ok ? '原文已自动识别，请核对' : '识别失败，可手动粘贴原文');
  };
}
function mpCollectSubmit() {
  const text = $('#mpText').value.trim(); if (!text) { toast('请先拍照/上传作文'); return; }
  const stuId = $('#mpStu').value;
  const stu = DATA.classes[0].students.find(s => s.id === stuId);
  const r = grade(text, DATA.standards, '标准', stu);
  const essay = { id: uid(), title: '移动端收录', content: text, date: today(), total: r.total, scores: r.scores, report: r, status: 'done', teacherComment: r.studentComment, studentComment: r.studentComment, goodWords: r.goodWords };
  stu.essays.push(essay);
  r.goodWords.forEach(w => { if (!DATA.vocab.find(v => v.word === w)) DATA.vocab.push({ word: w, from: displayName(stu), date: essay.date }); });
  save(); toast(`已收入 ${stu.name} 的作文（${r.total}分）`);
  mpTabName = 'class'; renderMiniApp();
}

/* ---------- 设置 ---------- */
/* 2.6.92 作文自动识别配置：与批改模型分开，因为识别模型必须支持图片输入 */
function saveVisionConfig() {
  const v = visionCfg();
  v.mode = $('#vMode') ? $('#vMode').value : 'off';
  v.baseUrl = $('#vBase') ? $('#vBase').value.trim() : '';
  v.apiKey = $('#vKey') ? $('#vKey').value.trim() : '';
  v.model = $('#vModel') ? $('#vModel').value.trim() : '';
  v.enabled = $('#vEnabled') ? $('#vEnabled').checked : false;
  if (v.mode === 'vision' && v.enabled && !(v.baseUrl && v.apiKey && v.model)) {
    toast('请填完整 Base URL / API Key / 视觉模型名'); return;
  }
  save(); toast('识别配置已保存' + (visionReady() ? '（自动识别已启用）' : '（未启用）'));
}
/* 2.6.93 一键填入已验证可直连的推荐配置，用户只需再粘一个 API Key */
function applyVisionPreset() {
  const sel = $('#vPreset');
  const key = sel ? sel.value : 'sf-qwen3vl8b';
  const p = VISION_PRESETS.find(x => x.key === key) || VISION_PRESETS[0];
  const set = (id, v) => { const el = $('#' + id); if (el) el.value = v; };
  set('vBase', p.baseUrl); set('vModel', p.model);
  const mode = $('#vMode'); if (mode) mode.value = 'vision';
  const en = $('#vEnabled'); if (en) en.checked = true;
  const k = $('#vKey'); if (k && !k.value.trim()) k.focus();
  toast(p.key === 'custom'
    ? '已切到自定义端点，请填写 Base URL / Key / 模型名'
    : '已填入推荐配置，粘贴 API Key 后点「保存配置」→「测试识别」');
}
/* 沿用批改模型的端点与密钥（同一厂商的多模态模型时最省事） */
function copyModelToVision() {
  const m = DATA.settings.model || {};
  const map = { vBase: m.baseUrl || '', vKey: m.apiKey || '', vModel: m.model || '' };
  Object.keys(map).forEach(k => { const el = $('#' + k); if (el) el.value = map[k]; });
  const mode = $('#vMode'); if (mode) mode.value = 'vision';
  const en = $('#vEnabled'); if (en) en.checked = true;
  toast('已沿用批改模型的端点/密钥，请确认模型名支持图片输入后点「保存配置」');
}
/* 连通性测试：发一张 1×1 图 + 指令，能返回文本即端点/密钥/模型可用 */
const VISION_TEST_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
async function testVision() {
  const box = $('#visionTest'); if (!box) return;
  const v = visionCfg();
  if (!(v.baseUrl && v.apiKey && v.model)) { box.style.display = 'block'; box.className = 'model-test err'; box.textContent = '请先填写完整的 Base URL / API Key / 视觉模型名'; return }
  box.style.display = 'block'; box.className = 'model-test wait'; box.textContent = '正在测试识别通道…';
  try {
    const out = await callVision([VISION_TEST_IMG], '（连通性测试，只需回复“收到”二字）');
    box.className = 'model-test ok';
    box.textContent = '✓ 识别通道已连通（返回：' + String(out).slice(0, 40) + '）';
  } catch (e) {
    box.className = 'model-test err';
    box.textContent = '✗ 失败：' + (e && e.message ? e.message : '未知错误') + '（若提示 CORS，需换支持浏览器直连的端点或经后端代理）';
  }
}
function renderSettings() {
  const s = DATA.settings;
  const m = s.model || {};
  const v = visionCfg();
  view().innerHTML = `
    <div class="card mb"><div class="section-title">📷 作文自动识别（2.6.92 · 皮皮式流程）</div>
      <div class="muted text-sm mb">启用后：小程序收稿或这里拍照 → <b>自动识别手写原文</b> → 老师核对 → 一键 AI 初批。需要一个支持<b>图片输入</b>的 OpenAI 兼容多模态模型（/chat/completions）。不启用则可手动输入/粘贴，功能不受影响。</div>
      <div class="ocr-note" style="margin:0 0 10px;background:#e8f7ee;color:#157f4a">✅ <b>已实测可浏览器直连：硅基流动</b>（api.siliconflow.cn，返回 Access-Control-Allow-Origin: *）。智谱、阿里百炼的 API 不带跨域头，网页里直连会报 CORS，需要经代理转发。点下面「一键填入推荐配置」后，<b>只需粘贴一个 API Key</b> 即可。</div>
      <div class="test-row" style="margin-bottom:10px">
        <select id="vPreset" style="min-width:280px;max-width:100%">${VISION_PRESETS.map(p => `<option value="${p.key}">${escapeHtml(p.label)}</option>`).join('')}</select>
        <button class="btn primary sm" onclick="applyVisionPreset()">⚡ 一键填入推荐配置</button>
      </div>
      <div class="model-form">
        <label>识别模式</label><select id="vMode">
          <option value="vision" ${v.mode === 'vision' ? 'selected' : ''}>多模态模型自动识别</option>
          <option value="off" ${v.mode !== 'vision' ? 'selected' : ''}>关闭（手动录入）</option>
        </select>
        <label>Base URL</label><input type="text" id="vBase" placeholder="https://your-endpoint/v1" value="${escapeHtml(v.baseUrl || '')}">
        <label>API Key</label><input type="text" id="vKey" placeholder="sk-..." value="${escapeHtml(v.apiKey || '')}">
        <label>视觉模型名</label><input type="text" id="vModel" placeholder="如支持图片输入的模型名" value="${escapeHtml(v.model || '')}">
        <label>启用</label><label class="switch"><input type="checkbox" id="vEnabled" ${v.enabled ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="test-row">
        <button class="btn primary sm" onclick="saveVisionConfig()">保存配置</button>
        <button class="btn sm" onclick="testVision()">测试识别</button>
        <button class="btn sm ghost" onclick="copyModelToVision()">沿用批改模型端点</button>
      </div>
      <div id="visionTest" class="model-test" style="display:none"></div>
      <div class="ocr-note" style="margin-top:10px;background:#f4f7f5;color:#4b5b64">📌 <b>拿 Key 三步</b>：① 打开 cloud.siliconflow.cn 用手机号注册 → ② 在「账户管理 / API Key」新建并复制密钥 → ③ 回到这里点「一键填入推荐配置」、粘贴 Key、点「保存配置」再点「测试识别」。看到「✓ 识别通道已连通」即可去收稿箱点「去批改」验收。</div>
      <div class="ocr-note mt">⚠️ 风险与部署建议：① 密钥保存在本浏览器 localStorage，公用电脑请勿保存；② 作文照片会外发到该模型服务，涉及未成年人作品，建议选用可信服务或私有化部署；③ 浏览器直连可能受 CORS 限制，若测试报 CORS，请换支持跨域的端点，或在教室桌面端/自建代理转发；④ 识别结果务必由老师核对后再批改，手写体难免有误差。</div>
    </div>
    <div class="card mb"><div class="section-title">🔒 设置 / 隐私合规</div>
      <div class="switch-line"><div><b>学生姓名脱敏</b><div class="desc">调用 AI 前将真实姓名替换为化名（学生A/B…），保护未成年人隐私。强烈建议保持开启。</div></div><label class="switch"><input type="checkbox" ${s.desensitize ? 'checked' : ''} onchange="setSetting('desensitize',this.checked)"><span class="slider"></span></label></div>
      <div class="switch-line"><div><b>拍照取景规范提示</b><div class="desc">在录入区显示方格纸贴框、本子放平等拍摄指引，提升识别准确率。</div></div><label class="switch"><input type="checkbox" ${s.guides ? 'checked' : ''} onchange="setSetting('guides',this.checked)"><span class="slider"></span></label></div>
      <div class="row-actions mt"><button class="btn ghost" onclick="resetData()">重置演示数据</button></div>
    </div>
    <div class="card"><div class="section-title">🤖 自定义模型（一键配置 WorkBuddy）</div>
      <div class="muted text-sm mb">接入 WorkBuddy 自定义模型后，AI 初批的总评/旁批/升格文/改进意见将由该模型生成，规则引擎作为兜底。需在下方填写端点与密钥，并「启用」。</div>
      <button class="btn primary sm" onclick="quickConfigWorkBuddy()">⚡ 一键配置 WorkBuddy 自定义模型</button>
      <div class="model-form mt">
        <label>提供方</label><select id="mProvider"><option value="workbuddy" ${m.provider === 'workbuddy' ? 'selected' : ''}>WorkBuddy 自定义模型</option><option value="openai" ${m.provider === 'openai' ? 'selected' : ''}>OpenAI 兼容</option></select>
        <label>Base URL</label><input type="text" id="mBase" placeholder="https://your-endpoint/v1" value="${escapeHtml(m.baseUrl || '')}">
        <label>API Key</label><input type="text" id="mKey" placeholder="sk-..." value="${escapeHtml(m.apiKey || '')}">
        <label>模型名</label><input type="text" id="mModel" placeholder="如 deepseek-chat" value="${escapeHtml(m.model || '')}">
        <label>启用</label><label class="switch"><input type="checkbox" id="mEnabled" ${m.enabled ? 'checked' : ''}><span class="slider"></span></label>
      </div>
      <div class="test-row"><button class="btn sm" onclick="saveModelConfig()">保存配置</button><button class="btn sm ghost" onclick="testModel()">测试连接</button></div>
      <div id="modelTest" class="model-test" style="display:none"></div>
      <div class="ocr-note mt">ℹ️ 浏览器直连第三方 API 可能受 CORS 限制，正式部署建议经后端代理转发并保管密钥；作文图片与文本属敏感数据，建议私有化存储。</div>
    </div>`;
}
function setSetting(k, v) { DATA.settings[k] = v; save(); toast('已保存'); }

/* ---------- 弹窗 / 学生画像 ---------- */
function showModal(title, bodyHtml, onConfirm, confirmText) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-mask" onclick="if(event.target===this)closeModal()"><div class="modal"><h3>${escapeHtml(title)}<span class="x" onclick="closeModal()">×</span></h3><div class="body">${bodyHtml}</div><div class="foot"><button class="btn ghost" onclick="closeModal()">取消</button><button class="btn primary" id="modalOk">${confirmText || '保存'}</button></div></div></div>`;
  const ok = $('#modalOk'); if (ok && onConfirm) ok.onclick = () => { onConfirm(); closeModal(); };
}
function closeModal() { const r = $('#modalRoot'); if (r) r.innerHTML = ''; }
function openProfile(stuId) {
  const stu = DATA.classes[0].students.find(s => s.id === stuId); if (!stu) return;
  const p = stu.profile || {};
  showModal(`编辑学生画像 · ${stu.name}`, `
    <div class="field-row"><label>学生特点</label><input type="text" id="pf_trait" value="${escapeHtml(p.trait || '')}" placeholder="如：观察细致"></div>
    <div class="field-row"><label>语文基础</label><input type="text" id="pf_found" value="${escapeHtml(p.foundation || '')}" placeholder="如：中等/偏弱"></div>
    <div class="field-row"><label>写作风格</label><input type="text" id="pf_style" value="${escapeHtml(p.style || '')}" placeholder="如：叙事清楚"></div>
    <div class="field-row"><label>学习态度</label><input type="text" id="pf_att" value="${escapeHtml(p.attitude || '')}" placeholder="如：认真"></div>
  `, () => {
    stu.profile = { trait: $('#pf_trait').value.trim(), foundation: $('#pf_found').value.trim(), style: $('#pf_style').value.trim(), attitude: $('#pf_att').value.trim() };
    save(); toast('画像已保存'); renderClasses();
  });
}

/* ---------- 工具 ---------- */
function download(fn, text) { const b = new Blob([text], { type: 'text/plain;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = fn; a.click(); URL.revokeObjectURL(a.href); }
function toast(msg) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function resetData() { localStorage.removeItem(STORE_KEY); DATA = seed(); save(); toast('演示数据已重置'); navTo(state.view); }

/* =====================================================================
   学生个性化分析 · 能力分层 · 分层训练方案 · 进度追踪
   ===================================================================== */
function studentTier(avg) {
  if (avg >= 90) return { key: 'top', name: '拔尖层', color: '#7c3aed', goal: '拔高冲刺：在语言文采与立意深度上精进，冲刺一类文、争作范文。' };
  if (avg >= 80) return { key: 'good', name: '优良层', color: '#16a34a', goal: '稳步提升：保持优势，精修细节、结构与书写，向优秀迈进。' };
  if (avg >= 70) return { key: 'pass', name: '达标层', color: '#1a9c5b', goal: '夯实基础：强化分段意识、书写规范与字数达标，巩固合格线。' };
  return { key: 'lift', name: '待提升层', color: '#ef4444', goal: '基础补漏：先攻克错别字、把句子写通顺、达到年段字数要求。' };
}
const DIM_TRAIN = {
  content: ['建立「素材积累卡」，每周摘抄 2 个生活小素材', '写「观察日记」训练发现细节与表达真情实感', '用「五感法」描写一个场景（看/听/闻/触/想）'],
  structure: ['训练列提纲：开头—经过—结尾三段式', '练习段落过渡句，避免“一段到底”', '仿写优秀范文的结构层次'],
  language: ['好词好句仿写（每篇挑 1 个词造句）', '修辞专项：比喻/拟人各写 3 句', '病句修改小练习（缺主语/语义重复）'],
  writing: ['建立「错别字辨析本」，集中订正同音字', '标点专项：逗号句号的正确使用', '每天 5 分钟工整书写练字'],
  length: ['扩写训练：把一句话扩成一段话', '细节描写：加入动作/神态/心理', '用「先…再…最后…」把过程写具体'],
};
function analyzeStudent(stu) {
  const essays = stu.essays.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const n = essays.length;
  if (!n) return { count: 0 };
  const avg = Math.round(essays.reduce((s, e) => s + e.total, 0) / n);
  const dims = {};
  DATA.standards.forEach(st => { dims[st.key] = Math.round(essays.reduce((s, e) => s + (e.scores[st.key] ? e.scores[st.key].val : 0), 0) / n); });
  const lowDim = DATA.standards.reduce((min, st) => dims[st.key] < dims[min.key] ? st : min, DATA.standards[0]);
  const highDim = DATA.standards.reduce((max, st) => dims[st.key] > dims[max.key] ? st : max, DATA.standards[0]);
  const half = Math.ceil(n / 2);
  const firstAvg = Math.round(essays.slice(0, half).reduce((s, e) => s + e.total, 0) / half);
  const lastAvg = Math.round(essays.slice(-half).reduce((s, e) => s + e.total, 0) / half);
  const growth = lastAvg - firstAvg;
  const errCount = {}, sickCount = {}, goodCount = {};
  essays.forEach(e => {
    (e.report.errors || []).forEach(x => errCount[x.word] = (errCount[x.word] || 0) + 1);
    (e.report.sick || []).forEach(s => { const k = s.msg || s.ctx || '病句'; sickCount[k] = (sickCount[k] || 0) + 1; });
    (e.goodWords || []).forEach(w => goodCount[w] = (goodCount[w] || 0) + 1);
  });
  const recurErr = Object.entries(errCount).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);
  const best = essays.reduce((m, e) => e.total > m.total ? e : m, essays[0]);
  const tier = studentTier(avg);
  return { count: n, avg, dims, lowDim, highDim, firstAvg, lastAvg, growth, errCount, recurErr, sickCount, goodCount, best, tier, essays };
}
function buildTierPlan(stu) {
  const a = analyzeStudent(stu);
  if (!a.count) return null;
  return {
    tier: a.tier, focus: a.lowDim.name, avg: a.avg, growth: a.growth,
    drills: (DIM_TRAIN[a.lowDim.key] || []).slice(),
    recommend: '可在「范文库」挑选同文体范文共读，用「素材集」的好词好句做仿写；教师复核时可按需调整方案。',
  };
}
function trendChart(essays) {
  const data = essays.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const W = 560, H = 180, pad = 30, n = data.length;
  const xs = i => pad + (n === 1 ? W / 2 : i * (W - 2 * pad) / (n - 1));
  const ys = v => H - pad - v * (H - 2 * pad) / 100;
  const line = data.map((e, i) => `${xs(i).toFixed(1)},${ys(e.total).toFixed(1)}`).join(' ');
  const dots = data.map((e, i) => `<circle cx="${xs(i).toFixed(1)}" cy="${ys(e.total).toFixed(1)}" r="3.5" fill="#1a9c5b"/><text x="${xs(i).toFixed(1)}" y="${(ys(e.total) - 9).toFixed(1)}" font-size="9" fill="#76867e" text-anchor="middle">${e.total}</text>`).join('');
  const labels = data.map((e, i) => `<text x="${xs(i).toFixed(1)}" y="${H - 9}" font-size="8" fill="#9aa3b2" text-anchor="middle">${e.date.slice(5)}</text>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%"><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#e2ece7"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#e2ece7"/><polyline points="${line}" fill="none" stroke="#1a9c5b" stroke-width="2"/>${dots}${labels}</svg>`;
}
function renderStudents() {
  const cls = DATA.classes[0];
  if (state.stuId) { const stu = cls.students.find(s => s.id === state.stuId); if (stu) return renderStudentAnalysis(stu); }
  const cards = cls.students.map(s => {
    const a = analyzeStudent(s);
    const tier = a.count ? a.tier : { name: '未分层', color: '#9aa3b2' };
    const avg = a.count ? a.avg : '—';
    const trend = a.count ? (a.growth > 0 ? `↑ +${a.growth}` : a.growth < 0 ? `↓ ${a.growth}` : '→ 持平') : '';
    return `<div class="card" onclick="openStudent('${s.id}')" style="cursor:pointer">
      <div style="display:flex;justify-content:space-between;align-items:center"><b>${escapeHtml(s.name)}</b><span class="tier-badge" style="background:${tier.color}">${tier.name}</span></div>
      <div class="mt"><span class="mini-score" style="color:${avg === '—' ? '#6b7280' : scoreColor(avg)};font-size:22px;font-weight:800">${avg === '—' ? '未批改' : avg}</span><span class="muted text-sm"> 分 · ${s.essays.length}篇 ${trend}</span></div>
      <div class="pill mt">${a.count ? ('薄弱：' + a.lowDim.name) : '暂无数据'}</div>
    </div>`;
  }).join('');
  view().innerHTML = `
    <div class="card mb"><div class="section-title">🎯 学生个性化分析</div>
      <div class="muted text-sm mb">基于每位学生已批作文，自动生成<b>能力分层</b>、<b>分层训练方案</b>与<b>习作进度追踪</b>。点学生卡片查看详情。</div>
      <div class="tier-legend">${['拔尖层', '优良层', '达标层', '待提升层'].map((t, i) => `<span class="tier-legend-item"><i style="background:${['#7c3aed', '#16a34a', '#1a9c5b', '#ef4444'][i]}"></i>${t}</span>`).join('')}</div>
    </div>
    <div class="grid cols-4">${cards}</div>`;
}
function openStudent(id) { state.stuId = id; renderStudents(); }
function renderStudentAnalysis(stu) {
  const a = analyzeStudent(stu);
  if (!a.count) {
    view().innerHTML = `<div class="card"><div class="empty"><div class="big">🎯</div>${escapeHtml(stu.name)} 还没有批改记录，先去「批改工作台」批几篇作文再来查看个性化分析。</div><div class="row-actions mt"><button class="btn primary" onclick="window.EssayGrader.openGrade('${stu.id}')">➕ 给该生批改</button></div></div>`;
    return;
  }
  const tier = a.tier;
  const plan = buildTierPlan(stu);
  const dimBars = DATA.standards.map(st => `<div class="score-row"><div class="top"><span>${st.name}</span><span><b>${a.dims[st.key]}</b>/100</span></div><div class="score-bar"><div class="fill" style="width:${a.dims[st.key]}%"></div></div></div>`).join('');
  const recurHtml = a.recurErr.length ? a.recurErr.map(([w, c]) => `<span class="tag-chip" style="background:var(--red-bg);color:var(--red)">${escapeHtml(w)} ×${c}</span>`).join(' ') : '无（错别字未复现，表现稳定）';
  const goodHtml = Object.entries(a.goodCount).slice(0, 6).map(([w, c]) => `<span class="tag-chip g">${escapeHtml(w)}×${c}</span>`).join(' ') || '—';
  const planDrills = plan.drills.map(d => `<li>${escapeHtml(d)}</li>`).join('');
  view().innerHTML = `
    <button class="btn ghost sm mb" onclick="state.stuId=null;renderStudents()">← 返回学生列表</button>
    <div class="grid cols-4 mb">
      ${statCard('🎓', stu.name, '能力分层', `<span style="color:${tier.color}">${tier.name}</span>`)}
      ${statCard('⭐', a.avg, '平均得分', '已批' + a.count + '篇')}
      ${statCard(a.growth >= 0 ? '📈' : '📉', (a.growth > 0 ? '+' : '') + a.growth, '进步幅度', `前期${a.firstAvg}→后期${a.lastAvg}`)}
      ${statCard('🏆', a.best.total, '最佳单篇', a.best.title)}
    </div>
    <div class="grid cols-2 mb">
      <div class="card"><div class="section-title">📊 五维能力画像</div><div class="radar-wrap">${radarChart(a.dims)}</div><div class="mt">${dimBars}</div></div>
      <div class="card"><div class="section-title">🔍 个性化诊断</div>
        <div class="hl-item"><span class="tag-chip b">优势维度</span><span>${a.highDim.name}（${a.dims[a.highDim.key]}分）</span></div>
        <div class="hl-item"><span class="tag-chip b">薄弱维度</span><span style="color:${scoreColor(a.dims[a.lowDim.key])}">${a.lowDim.name}（${a.dims[a.lowDim.key]}分）</span></div>
        <div class="hl-item"><span class="tag-chip b">复现错别字</span><div>${recurHtml}</div></div>
        <div class="hl-item"><span class="tag-chip b">常用好词</span><div>${goodHtml}</div></div>
      </div>
    </div>
    <div class="card mb"><div class="section-title">🎯 分层训练方案 · <span style="color:${tier.color}">${tier.name}</span></div>
      <div class="tier-goal">${escapeHtml(tier.goal)}</div>
      <div class="muted text-sm mt" style="margin-bottom:6px">本期训练重点：<b>${escapeHtml(a.lowDim.name)}</b>（建议优先突破）</div>
      <ul class="advice-list">${planDrills}</ul>
      <div class="ocr-note mt">${escapeHtml(plan.recommend)}</div>
    </div>
    <div class="card mb"><div class="section-title">📈 习作进度追踪</div>
      <div class="trend-wrap">${trendChart(a.essays)}</div>
      <div class="mt"><b>里程碑：</b>首次批改 ${a.essays[0].date}（${a.essays[0].total}分）→ 最新 ${a.essays[a.essays.length - 1].date}（${a.essays[a.essays.length - 1].total}分），共 ${a.count} 篇，最佳 ${a.best.total} 分。</div>
    </div>
    <div class="row-actions">
      <button class="btn primary" onclick="window.EssayGrader.openGrade('${stu.id}')">➕ 给该生再批一篇</button>
      <button class="btn" onclick="navTo('models')">🏆 去范文库</button>
      <button class="btn" onclick="navTo('materials')">📦 去素材集</button>
    </div>`;
}
function findStudent(idOrName) {
  const cls = DATA.classes[0];
  return cls.students.find(s => s.id === idOrName || s.name === idOrName) || null;
}
function gotoGradeWithStudent(idOrName) { const s = findStudent(idOrName); if (s) { state.pendingStu = s.id; navTo('grade'); } }

/* ---------------- 启动 ---------------- */
load();
window.navTo = navTo; window.loadSample = loadSample; window.clearEssay = clearEssay;
window.saveEssay = saveEssay; window.exportReport = exportReport; window.openProfileById = openProfileById;
window.openProfile = openProfile; window.closeModal = closeModal;
window.toggleCol = toggleCol; window.addTemplate = addTemplate; window.deleteTemplate = deleteTemplate;
window.setSetting = setSetting; window.onStdChange = onStdChange; window.saveStandards = saveStandards;
window.resetData = resetData;
window.runGrade = runGrade; window.mpTab = mpTab; window.mpCollectSubmit = mpCollectSubmit;
window.renderInsight = renderInsight; window.renderModels = renderModels; window.filterModels = filterModels; window.viewModel = viewModel;
window.deleteModel = deleteModel; window.exportModel = exportModel; window.openCollectModel = openCollectModel;
window.renderMaterials = renderMaterials; window.filterMaterials = filterMaterials; window.matCatSwitch = matCatSwitch; window.deleteMaterial = deleteMaterial;
window.openCollectMaterial = openCollectMaterial; window.quickConfigWorkBuddy = quickConfigWorkBuddy;
window.saveModelConfig = saveModelConfig; window.testModel = testModel;
window.openStudent = openStudent; window.renderStudents = renderStudents;
window.gotoGradeWithStudent = gotoGradeWithStudent;
/* 2.6.92 作文自动识别 */
window.saveVisionConfig = saveVisionConfig; window.testVision = testVision;
window.copyModelToVision = copyModelToVision; window.rerunRecognition = rerunRecognition;
window.runRecognition = runRecognition; window.visionReady = visionReady;
window.applyVisionPreset = applyVisionPreset;

/* =====================================================================
   集成 API（供宿主工作台 / 小程序 web-view 调用）
   ===================================================================== */
window.EssayGrader = {
  version: '1.0.0',
  navTo: navTo,
  /** 按 学号/姓名 加载学生（小程序扫码识别后调用） */
  loadStudent(idOrName) { const s = findStudent(idOrName); if (s) { state.stuId = s.id; navTo('students'); } return !!s; },
  /** 打开该学生的批改工作台（自动选中） */
  openGrade(idOrName) { const s = findStudent(idOrName); if (s) { state.pendingStu = s.id; navTo('grade'); } return !!s; },
  /** 2.6.88 宿主收稿箱「去批改」：一次性带入 学生+标题+原文照片，并给出操作指引 */
  prefillGrade(opts) {
    opts = opts || {};
    navTo('grade');
    setTimeout(() => {
      try {
        const sel = $('#stuSel');
        if (sel) {
          const wantId = String(opts.studentId || '');
          let hit = [...sel.options].find(o => o.value === wantId);
          if (!hit && opts.studentName) {
            const st = DATA.classes[0].students.find(s => s.name === String(opts.studentName));
            if (st) hit = [...sel.options].find(o => o.value === st.id);
          }
          if (hit) sel.value = hit.value;
        }
        if (opts.title) { const t = $('#essayTitle'); if (t) t.value = String(opts.title); }
        const imgs = (Array.isArray(opts.images) ? opts.images : []).filter(Boolean);
        const prev = $('#imgPrev');
        if (prev && imgs.length) {
          prev.innerHTML = '<div class="thumbs"></div>';
          const box = prev.querySelector('.thumbs');
          imgs.forEach(src => { const im = new Image(); im.src = src; im.className = 'thumb'; im.title = '学生作文原文（小程序上传）'; box.appendChild(im); });
        }
        state.essayImages = imgs.slice();
        state.ocrDone = false;
        const ta = $('#essayText');
        if (ta) { ta.placeholder = visionReady() ? '正在自动识别作文内容…' : '对照上方照片，把作文文字输入/粘贴到这里…'; }
        /* 2.6.92 皮皮式流程：带入照片即自动识别；没配识别模型时给明确引导，
           不再要求老师「对照照片抄录」，也绝不塞示例文本冒充识别结果。 */
        if (imgs.length && visionReady()) {
          runRecognition(imgs, { toast: false });
          toast(opts.studentName ? ('已定位 ' + opts.studentName + '，正在自动识别《' + (opts.title || '未命名') + '》') : '已带入收稿信息，正在识别');
        } else {
          ocrNote('err', imgs.length
            ? '已带入 ' + imgs.length + ' 张作文照片。启用「作文自动识别」后拍照即自动转录原文；当前可对照照片手动输入/粘贴。'
            : '该篇没有照片，请把作文文字录入下方输入框，然后点「开始 AI 初批」。', !visionReady());
          toast(opts.studentName ? ('已定位 ' + opts.studentName + ' 的《' + (opts.title || '未命名') + '》') : '已带入收稿信息');
        }
      } catch (e) { console.warn('prefillGrade:', e); }
    }, 80);
    return true;
  },
  /** 打开该学生的个性化分析 */
  openAnalyze(idOrName) { const s = findStudent(idOrName); if (s) { state.stuId = s.id; navTo('students'); } return !!s; },
  /** 返回单个学生的分析结果对象（无需渲染，供宿主直接取数） */
  analyzeStudent(idOrName) { const s = findStudent(idOrName); return s ? analyzeStudent(s) : null; },
  /** 返回全班学情分析结果 */
  analyzeClass: analyzeClass,
  /** 返回全班学生列表（含分析结果摘要） */
  getStudents() { return DATA.classes[0].students.map(s => ({ id: s.id, name: s.name, profile: s.profile, ...analyzeStudent(s) })); },
  /** 配置自定义模型（一键 WorkBuddy） */
  config(opts) { Object.assign(DATA.settings.model, opts || {}); save(); },
  /** 配置自动识别模型（宿主工作台可一键下发，免去逐个填表） */
  configVision(opts) {
    const v = visionCfg();
    Object.assign(v, opts || {});
    if (v.mode === 'vision' && v.enabled && v.baseUrl && v.apiKey && v.model) v.mode = 'vision';
    save();
    if (state.view === 'settings') renderSettings();
    return visionReady();
  },
  /** 宿主直接把已有照片交给批改台识别（不经过 DOM 选图） */
  recognize(images, target) { return runRecognition(images, { target: target || '#essayText' }); },
  setDesensitize(b) { DATA.settings.desensitize = !!b; save(); },
  setGuides(b) { DATA.settings.guides = !!b; save(); },
  /** 接入宿主已有班级数据：arr=[{id,name,profile?}] */
  setStudents(arr) {
    const cls = DATA.classes[0];
    (arr || []).forEach(s => { if (s && s.id && !cls.students.find(x => x.id === s.id)) cls.students.push({ id: s.id, name: s.name, profile: s.profile || {}, essays: [] }); });
    save();
  },
  /** v1.1 宿主桥接：用真实花名册整体替换演示学生（同 id 保留已有批改记录） */
  replaceStudents(arr) {
    const cls = DATA.classes[0];
    const old = {};
    cls.students.forEach(s => { old[s.id] = s; });
    const next = (arr || []).filter(s => s && s.id && s.name).map(s => {
      const prev = old[s.id];
      return { id: String(s.id), name: String(s.name), profile: (s.profile || (prev && prev.profile) || {}), essays: (prev && prev.essays) || [] };
    });
    if (next.length >= 5) { cls.students = next; save(); }
  },
  /** 订阅工作台向宿主回传的事件：graded / model_collected / material_collected / scan */
  on(ev, cb) { window.addEventListener('essaygrader:' + ev, e => cb && cb(e.detail)); },
  /** 内部：回传事件（postMessage 给父页 / 小程序，并派发本地事件） */
  _notify(type, payload) {
    const msg = { source: 'essay-grader', type, payload };
    try { if (window.__wxjs_environment === 'miniprogram' && window.wx && wx.miniProgram) wx.miniProgram.postMessage({ data: msg }); } catch (e) {}
    try { if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*'); } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('essaygrader:' + type, { detail: payload })); } catch (e) {}
  },
};

navTo('dashboard');
