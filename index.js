/**
 * User Persona Forge（UPF）v2
 * 跨世界观 User 人设管理扩展
 *
 * 主流程：
 *   1. 你写好一份「核心性格」（L0 内核，跨世界观不变）
 *   2. 插件读取当前角色卡的世界书 + 角色卡设定，作为世界观素材
 *   3. 调用当前配置的模型，按你的自然语言要求（可留空随机）生成一份身份设定
 *   4. 生成结果可编辑，一键注入到该角色卡的世界书里（条目名默认「玩家人物设定」）
 *   5. 注入后可随时启用 / 禁用 / 更新 / 移除该条目
 *
 * 另外保留宏注入（{{user_persona}} 等）作为轻量用法，两种可以并存。
 */

const MODULE_NAME = 'user_persona_forge';

const MACRO_CORE = 'user_core';
const MACRO_IDENTITY = 'user_identity';
const MACRO_PERSONA = 'user_persona';

/** 世界书条目的默认字段（与 ST 的 newWorldInfoEntryTemplate 对齐，用作 fallback） */
const WI_ENTRY_FALLBACK = {
    key: [],
    keysecondary: [],
    comment: '',
    content: '',
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: false,
    order: 100,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 1,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: null,
    automationId: '',
    role: 0,
    sticky: null,
    cooldown: null,
    delay: null,
};

const DEFAULT_SETTINGS = Object.freeze({
    /** L0 内核层：跨世界观不变的你 */
    core: '',
    /** 身份档案库（手动 / 生成历史）：{ [id]: { id, name, content } } */
    identities: {},
    order: [],
    /** 绑定关系 */
    bindings: {
        characters: {},
        worlds: {},
    },
    defaultIdentityId: null,
    lastIdentityId: null,
    /** v2：生成相关配置 */
    gen: {
        entryTitle: '玩家人物设定',
        lastRequirement: '',
        maxWorldChars: 6000,
        maxEntries: 60,
        extraInstruction: '',
    },
    /** v2：注入记录 { [世界书名]: { uid, comment } } */
    injections: {},
    /** v2.1：生成时被排除的世界书条目 { [世界书名]: string[] }，元素形如 'wi:3' / 'book:2' */
    excluded: {},
    /** v2.2：NPC 注入记录 { [世界书名]: [{ uid, comment, keys }] } */
    npcs: {},
});

/** 取 context（每次都重新取，保证 characterId 等是最新值） */
const ctx = () => SillyTavern.getContext();

function toast(message, type = 'info') {
    try {
        if (typeof toastr !== 'undefined' && typeof toastr[type] === 'function') {
            toastr[type](message);
            return;
        }
    } catch (_) { /* 忽略 */ }
    console.log(`[UPF] ${message}`);
}

async function askInput(title, text = '', defaultValue = '') {
    try {
        const { Popup } = ctx();
        if (Popup?.show?.input) {
            const result = await Popup.show.input(title, text, defaultValue);
            return result == null ? null : String(result);
        }
    } catch (e) {
        console.warn('[UPF] Popup 不可用，退化为原生 prompt', e);
    }
    return window.prompt(title, defaultValue);
}

async function askConfirm(title, text = '') {
    try {
        const { Popup, POPUP_RESULT } = ctx();
        if (Popup?.show?.confirm) {
            return await Popup.show.confirm(title, text) === POPUP_RESULT.AFFIRMATIVE;
        }
    } catch (e) {
        console.warn('[UPF] Popup 不可用，退化为原生 confirm', e);
    }
    return window.confirm(text || title);
}

function getSettings() {
    const store = ctx().extensionSettings;
    if (!store[MODULE_NAME]) {
        store[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = store[MODULE_NAME];

    for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(s, key)) {
            s[key] = structuredClone(DEFAULT_SETTINGS[key]);
        }
    }
    if (!s.bindings || typeof s.bindings !== 'object') s.bindings = { characters: {}, worlds: {} };
    if (!s.bindings.characters) s.bindings.characters = {};
    if (!s.bindings.worlds) s.bindings.worlds = {};
    if (!s.gen || typeof s.gen !== 'object') s.gen = structuredClone(DEFAULT_SETTINGS.gen);
    for (const k of Object.keys(DEFAULT_SETTINGS.gen)) {
        if (!Object.hasOwn(s.gen, k)) s.gen[k] = DEFAULT_SETTINGS.gen[k];
    }
    if (!s.injections || typeof s.injections !== 'object') s.injections = {};
    if (!s.excluded || typeof s.excluded !== 'object') s.excluded = {};
    if (!s.npcs || typeof s.npcs !== 'object') s.npcs = {};
    if (!Array.isArray(s.order)) s.order = [];

    return s;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

/* ------------------------------------------------------------------ */
/* 上下文解析                                                          */
/* ------------------------------------------------------------------ */

function getCurrentCharacterKey() {
    const c = ctx();
    const chid = c.characterId;
    if (chid === undefined || chid === null || !Array.isArray(c.characters)) return null;
    return c.characters[chid]?.avatar ?? null;
}

function getCurrentWorldKey() {
    const c = ctx();
    const chid = c.characterId;
    if (chid === undefined || chid === null || !Array.isArray(c.characters)) return null;
    const w = c.characters[chid]?.data?.extensions?.world;
    return typeof w === 'string' && w.length > 0 ? w : null;
}

function getCurrentCharacter() {
    const c = ctx();
    const chid = c.characterId;
    if (chid === undefined || chid === null || !Array.isArray(c.characters)) return null;
    return c.characters[chid] ?? null;
}

function resolveIdentityId() {
    const s = getSettings();
    const charKey = getCurrentCharacterKey();
    if (charKey && s.bindings.characters[charKey]) {
        return { id: s.bindings.characters[charKey], source: 'character' };
    }
    const worldKey = getCurrentWorldKey();
    if (worldKey && s.bindings.worlds[worldKey]) {
        return { id: s.bindings.worlds[worldKey], source: 'world' };
    }
    if (s.defaultIdentityId && s.identities[s.defaultIdentityId]) {
        return { id: s.defaultIdentityId, source: 'default' };
    }
    return { id: null, source: 'none' };
}

function getIdentityText() {
    const s = getSettings();
    const { id } = resolveIdentityId();
    if (!id) return '';
    return s.identities[id]?.content ?? '';
}

function getCoreText() {
    return getSettings().core ?? '';
}

function getCombinedText() {
    return [getCoreText(), getIdentityText()]
        .map(x => String(x ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 世界书素材收集                                                      */
/* ------------------------------------------------------------------ */

/**
 * 收集「世界观素材」：角色卡自身设定 + 绑定的世界书 + 角色卡内嵌世界书
 * @returns {Promise<{ worldName: string|null, text: string, entryCount: number, sources: string[] }>}
 */
async function collectWorldContext() {
    const c = ctx();
    const s = getSettings();
    const ch = getCurrentCharacter();
    const sources = [];
    const chunks = [];

    const worldName = getCurrentWorldKey();
    const excluded = new Set(s.excluded[worldName] ?? []);

    // 1) 角色卡自身设定
    if (ch) {
        const parts = [];
        if (ch.name) parts.push(`角色名：${ch.name}`);
        if (ch.description) parts.push(`【角色描述】\n${ch.description}`);
        if (ch.personality) parts.push(`【角色性格】\n${ch.personality}`);
        if (ch.scenario) parts.push(`【场景】\n${ch.scenario}`);
        const notes = ch.data?.creator_notes ?? ch.creatorcomment;
        if (notes) parts.push(`【作者备注】\n${notes}`);
        if (parts.length) {
            chunks.push(parts.join('\n\n'));
            sources.push('角色卡设定');
        }
    }

    // 2) 角色卡绑定的世界书
    let entryCount = 0;
    if (worldName) {
        try {
            const world = await c.loadWorldInfo(worldName);
            const entries = world?.entries ?? {};
            const list = Object.values(entries);
            // 常驻条目优先（世界观骨架通常在常驻条目里）
            const sorted = [...list].sort((a, b) => {
                if (!!b.constant !== !!a.constant) return b.constant ? 1 : -1;
                return (b.order ?? 100) - (a.order ?? 100);
            });
            const picked = [];
            let size = 0;
            for (const e of sorted) {
                if (picked.length >= s.gen.maxEntries) break;
                if (size >= s.gen.maxWorldChars) break;
                if (excluded.has(`wi:${e.uid}`)) continue;
                const title = (e.comment || '').trim();
                const body = (e.content || '').trim();
                if (!body) continue;
                const piece = title ? `【${title}】\n${body}` : body;
                picked.push(piece);
                size += piece.length;
            }
            entryCount = picked.length;
            if (picked.length) {
                chunks.push(`【世界书：${worldName}】\n${picked.join('\n\n')}`);
                sources.push(`世界书 ${worldName}（${picked.length} 条）`);
            }
        } catch (e) {
            console.warn('[UPF] 读取世界书失败', e);
        }
    }

    // 3) 角色卡内嵌世界书（V2 character_book）
    const book = ch?.data?.character_book;
    if (book && Array.isArray(book.entries) && book.entries.length) {
        const picked = [];
        let size = 0;
        for (const [idx, e] of book.entries.entries()) {
            if (picked.length >= s.gen.maxEntries) break;
            if (size >= s.gen.maxWorldChars) break;
            if (excluded.has(`book:${idx}`)) continue;
            const body = (e.content || '').trim();
            if (!body) continue;
            const piece = (e.comment || e.name) ? `【${e.comment || e.name}】\n${body}` : body;
            picked.push(piece);
            size += piece.length;
        }
        if (picked.length) {
            chunks.push(`【角色卡内嵌世界书】\n${picked.join('\n\n')}`);
            sources.push(`内嵌世界书（${picked.length} 条）`);
            entryCount += picked.length;
        }
    }

    return { worldName, text: chunks.join('\n\n---\n\n'), entryCount, sources };
}

/* ------------------------------------------------------------------ */
/* AI 生成                                                             */
/* ------------------------------------------------------------------ */

const OUTPUT_TEMPLATE = [
    '■ 姓名 / 称号：',
    '■ 外表年龄与体感：',
    '■ 职业 / 职阶：',
    '■ 出身：',
    '■ 当前处境：',
    '■ 与 __CHAR__ 的关系：',
    '■ 与 __CHAR__ 的初识方式：',
    '■ 手头资源 / 可动用的能力：',
    '■ 这个世界观下我做不到的事：',
    '■ 【特质转译】我的核心爱好在本世界观表现为：',
    '■ 【语气微调】本世界观下我的用词习惯（禁止出现现代词汇）：',
    '■ 【称呼表】上位者→___ / 平辈→___ / 服务者→___',
].join('\n');

function buildGeneratePrompt(coreText, requirement, worldContext, charName) {
    const s = getSettings();
    const req = String(requirement ?? '').trim();
    const template = OUTPUT_TEMPLATE.replace(/__CHAR__/g, charName || '{{char}}');

    return [
        '你是一个资深 TRPG / 角色扮演设定助手。请为「玩家（User）」生成一份人物身份设定。',
        '',
        '【第一步：不可改变的核心性格】',
        coreText.trim() || '（用户未填写，请自行补全一个自洽的性格，并在最后注明你补全了什么）',
        '',
        '【第二步：目标世界观素材】',
        worldContext.text || '（该角色卡没有世界书，请自行构想一个与角色卡相符的世界观）',
        '',
        '【第三步：用户的额外要求】',
        req || '（无要求。请自由发挥：创造一个能自然融入该世界观、并与主角有强烈戏剧张力的身份，不要写成路人甲。）',
        '',
        s.gen.extraInstruction.trim() ? `【附加指令】\n${s.gen.extraInstruction.trim()}\n` : '',
        '【生成规则】',
        '1. 核心性格、说话腔调、底线、关系模式必须原样保留，绝对不许 OOC。只换身份外壳。',
        '2. 把核心特质里的现代元素「翻译」成本世界观的等价物（例：写代码→研究炼金阵列/刷固件），禁止出现现代词汇。',
        '3. 身份必须能与该世界观的主角自然产生交集，并给出具体的关系和初识方式。',
        '4. 明确写出「在这个世界观下做不到的事」，这能防止模型后续乱编。',
        '5. 只输出设定正文。不要任何开场白、解释、总结，不要用 markdown 代码块包裹。',
        '',
        '【输出格式（严格遵守，条目不增减）】',
        template,
    ].filter(Boolean).join('\n');
}

/** 调用当前配置的模型生成身份 */
async function generateIdentity(requirement) {
    const s = getSettings();
    const c = ctx();
    const ch = getCurrentCharacter();
    const charName = ch?.name ?? '';

    if (!c.generateRaw) {
        throw new Error('当前版本不支持 generateRaw，无法调用 AI 生成');
    }

    const worldContext = await collectWorldContext();
    const prompt = buildGeneratePrompt(s.core, requirement, worldContext, charName);

    const result = await c.generateRaw({
        prompt,
        systemPrompt: 'You are a creative character-setting assistant. Output only the requested setting text, no commentary.',
    });

    const text = String(result ?? '').trim();
    if (!text) throw new Error('模型返回为空，请检查 API 连接与预设');

    return { text, worldContext, charName };
}

/* ------------------------------------------------------------------ */
/* NPC 生成（v2.2）                                                    */
/* ------------------------------------------------------------------ */

const NPC_OUTPUT_TEMPLATE = [
    '■ 姓名 / 称号：',
    '■ 外表年龄与外貌：',
    '■ 身份 / 职业：',
    '■ 性格与癖好：',
    '■ 背景：',
    '■ 与 __CHAR__ 的关系：',
    '■ 当前处境 / 目的：',
    '■ 说话方式：',
    '■ 秘密 / 弱点：',
    '■ 【触发关键词】（逗号分隔，务必包含名字、称号和别人可能的称呼）：',
].join('\n');

function buildNpcPrompt(requirement, worldContext, charName) {
    const req = String(requirement ?? '').trim();
    const template = NPC_OUTPUT_TEMPLATE.replace(/__CHAR__/g, charName || '{{char}}');

    return [
        '你是一个资深 TRPG / 角色扮演设定助手。请为下面这个世界观生成一个配角 NPC。',
        '',
        '【世界观素材】',
        worldContext.text || '（该角色卡没有世界书，请自行构想一个相符的世界观）',
        '',
        '【用户的额外要求】',
        req || '（无要求。请自由创造一个有戏剧张力的 NPC：有明确目的、有秘密、和主角有具体关系。不要写成无功能的路人甲。）',
        '',
        '【生成规则】',
        '1. NPC 必须严格贴合该世界观，禁止出现现代词汇或与世界观冲突的设定。',
        '2. NPC 要有自己的目的和秘密 —— 有目的才有戏，有秘密才有深度。',
        `3. 与主角（${charName || '该世界观的主角'}）的关系要具体，不要写"认识"这种空话。`,
        '4. 触发关键词必须包含 NPC 的名字、称号，以及别人可能怎么称呼他 —— 这条会写进世界书，决定 NPC 什么时候出现。',
        '5. 只输出设定正文。不要任何开场白、解释、总结，不要用 markdown 代码块包裹。',
        '',
        '【输出格式（严格遵守，条目不增减）】',
        template,
    ].filter(Boolean).join('\n');
}

/** 从生成的 NPC 文本里提取名字和触发关键词 */
function parseNpc(text) {
    const nameMatch = /■\s*姓名\s*\/\s*称号\s*[：:]\s*(.+)/.exec(text);
    const keyMatch = /■\s*【触发关键词】[^\n]*?[：:]\s*(.+)/.exec(text);
    const name = nameMatch ? nameMatch[1].trim() : '';
    let keys = keyMatch
        ? keyMatch[1].split(/[,，、;；]/).map(x => x.trim()).filter(Boolean)
        : [];
    if (!keys.length && name) keys = [name];
    return { name, keys };
}

/** 调用当前配置的模型生成 NPC */
async function generateNpc(requirement) {
    const c = ctx();
    const ch = getCurrentCharacter();
    const charName = ch?.name ?? '';

    if (!c.generateRaw) {
        throw new Error('当前版本不支持 generateRaw，无法调用 AI 生成');
    }

    const worldContext = await collectWorldContext();
    const prompt = buildNpcPrompt(requirement, worldContext, charName);

    const result = await c.generateRaw({
        prompt,
        systemPrompt: 'You are a creative character-setting assistant. Output only the requested setting text, no commentary.',
    });

    const text = String(result ?? '').trim();
    if (!text) throw new Error('模型返回为空，请检查 API 连接与预设');

    return { text, worldContext, charName };
}

/* ------------------------------------------------------------------ */
/* 世界书写入                                                          */
/* ------------------------------------------------------------------ */

/** 新建一个世界书条目（优先用 ST 内部函数，失败则 fallback） */
async function createEntry(worldData) {
    try {
        const mod = await import('../../../world-info.js');
        if (typeof mod?.createWorldInfoEntry === 'function') {
            const entry = mod.createWorldInfoEntry('', worldData);
            if (entry) return entry;
        }
    } catch (e) {
        console.debug('[UPF] 无法 import createWorldInfoEntry，使用内置模板', e);
    }
    const uids = Object.keys(worldData.entries ?? {}).map(Number).filter(Number.isInteger);
    const uid = uids.length ? Math.max(...uids) + 1 : 0;
    const entry = { uid, ...structuredClone(WI_ENTRY_FALLBACK) };
    worldData.entries[uid] = entry;
    return entry;
}

/**
 * 把生成的身份注入到当前角色卡的世界书
 * @returns {Promise<{ worldName: string, uid: number, comment: string, created: boolean }>}
 */
/** 确保当前角色卡有一本世界书；没有就创建一本并绑定 */
async function ensureWorld() {
    const c = ctx();
    let worldName = getCurrentWorldKey();
    if (worldName) return worldName;

    const ch = getCurrentCharacter();
    if (!ch) throw new Error('请先选中一个角色卡');
    worldName = `UPF-${ch.name || 'World'}`;
    try {
        await c.saveWorldInfo(worldName, { entries: {} });
        await c.writeExtensionField(c.characterId, 'world', worldName);
        if (typeof c.updateWorldInfoList === 'function') await c.updateWorldInfoList();
        toast(`已创建并绑定新世界书「${worldName}」`, 'info');
    } catch (e) {
        console.error('[UPF] 创建世界书失败', e);
        throw new Error('创建世界书失败，请手动为该角色卡绑定一本世界书后重试');
    }
    return worldName;
}

/** 保存世界书并刷新编辑器 */
async function persistWorld(worldName, world) {
    const c = ctx();
    await c.saveWorldInfo(worldName, world);
    if (typeof c.reloadWorldInfoEditor === 'function') {
        try { await c.reloadWorldInfoEditor(); } catch (_) { /* ignore */ }
    }
}

async function injectToWorld(content, title) {
    const c = ctx();
    const s = getSettings();
    const worldName = await ensureWorld();

    const world = await c.loadWorldInfo(worldName);
    if (!world) throw new Error(`读不到世界书「${worldName}」`);
    world.entries ??= {};

    // 已注入过就更新同一条
    const rec = s.injections[worldName];
    let entry = rec && world.entries[rec.uid] ? world.entries[rec.uid] : null;
    let created = false;

    if (!entry) {
        entry = await createEntry(world);
        created = true;
    }

    entry.comment = title || s.gen.entryTitle;
    entry.content = String(content ?? '');
    entry.constant = true;      // 常驻（蓝条），保证每次生成都能读到
    entry.disable = false;      // 默认启用
    entry.position = 0;         // 角色定义之前
    entry.key = [];
    entry.keysecondary = [];

    s.injections[worldName] = { uid: entry.uid, comment: entry.comment };
    saveSettings();

    await c.saveWorldInfo(worldName, world);
    if (typeof c.reloadWorldInfoEditor === 'function') {
        try { await c.reloadWorldInfoEditor(); } catch (_) { /* ignore */ }
    }

    return { worldName, uid: entry.uid, comment: entry.comment, created };
}

/**
 * 把生成的 NPC 注入为「绿灯条目」（非常驻，靠关键词触发）
 * @param {string} content NPC 设定正文
 * @param {string} keysRaw 用户手填的关键词（逗号分隔）；留空则用 AI 生成的
 */
async function injectNpcToWorld(content, keysRaw) {
    const c = ctx();
    const s = getSettings();
    const worldName = await ensureWorld();

    const { name, keys } = parseNpc(String(content ?? ''));

    let finalKeys = [];
    const manual = String(keysRaw ?? '').split(/[,，、;；]/).map(x => x.trim()).filter(Boolean);
    if (manual.length) finalKeys = manual;
    else finalKeys = keys;

    if (!finalKeys.length) {
        throw new Error('没拿到触发关键词。绿灯条目必须靠关键词才会触发，请在关键词框里填 NPC 的名字。');
    }

    const world = await c.loadWorldInfo(worldName);
    if (!world) throw new Error(`读不到世界书「${worldName}」`);
    world.entries ??= {};

    const entry = await createEntry(world);
    entry.comment = name || finalKeys[0] || 'NPC';
    entry.content = String(content ?? '');
    entry.constant = false;      // 绿灯：非常驻，只在命中关键词时注入
    entry.disable = false;
    entry.position = 0;
    entry.key = finalKeys;       // 关键词（决定什么时候触发）
    entry.keysecondary = [];
    entry.selective = true;

    const list = Array.isArray(s.npcs[worldName]) ? s.npcs[worldName] : [];
    list.push({ uid: entry.uid, comment: entry.comment, keys: finalKeys });
    s.npcs[worldName] = list;
    saveSettings();

    await persistWorld(worldName, world);

    return { worldName, uid: entry.uid, comment: entry.comment, keys: finalKeys };
}

/** 列出当前世界书里已注入的 NPC */
async function renderNpcList() {
    const c = ctx();
    const s = getSettings();
    const worldName = getCurrentWorldKey();
    const $el = $('#upf-npc-list');

    if (!worldName || !Array.isArray(s.npcs[worldName]) || !s.npcs[worldName].length) {
        $el.text('（无）');
        return;
    }

    let world = null;
    try { world = await c.loadWorldInfo(worldName); } catch (_) { /* ignore */ }

    const alive = (s.npcs[worldName] ?? []).filter(rec => !world?.entries || world.entries[rec.uid] != null);
    if (!alive.length) {
        $el.text('（无）');
        return;
    }
    s.npcs[worldName] = alive;

    $el.html(alive.map(rec => {
        const label = String(rec.comment || 'NPC').replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
        const keys = (rec.keys ?? []).join(' / ');
        return `<span class="upf-npc-chip" title="关键词：${keys}">${label}</span>`;
    }).join(' '));
}

/** 读取当前注入条目的状态 */
async function getInjectionState() {
    const c = ctx();
    const s = getSettings();
    const worldName = getCurrentWorldKey();
    if (!worldName) return { state: 'no_world', worldName: null };
    const rec = s.injections[worldName];
    if (!rec) return { state: 'not_injected', worldName };
    try {
        const world = await c.loadWorldInfo(worldName);
        const entry = world?.entries?.[rec.uid];
        if (!entry) return { state: 'missing', worldName, rec };
        return {
            state: 'injected',
            worldName,
            uid: rec.uid,
            comment: entry.comment,
            disabled: !!entry.disable,
            content: entry.content,
        };
    } catch (e) {
        console.warn('[UPF] 读取注入状态失败', e);
        return { state: 'error', worldName, rec };
    }
}

/** 修改注入条目的启用状态 / 内容；remove=true 则删除 */
async function modifyInjection({ disable, content, remove = false } = {}) {
    const c = ctx();
    const s = getSettings();
    const worldName = getCurrentWorldKey();
    if (!worldName) throw new Error('当前角色卡没有绑定世界书');
    const rec = s.injections[worldName];
    if (!rec) throw new Error('这个世界书还没有注入过条目');

    const world = await c.loadWorldInfo(worldName);
    if (!world?.entries) throw new Error('读不到世界书数据');

    if (remove) {
        delete world.entries[rec.uid];
        delete s.injections[worldName];
    } else {
        const entry = world.entries[rec.uid];
        if (!entry) throw new Error('注入的条目已不存在');
        if (disable !== undefined) entry.disable = !!disable;
        if (content !== undefined) entry.content = String(content);
    }

    saveSettings();
    await c.saveWorldInfo(worldName, world);
    if (typeof c.reloadWorldInfoEditor === 'function') {
        try { await c.reloadWorldInfoEditor(); } catch (_) { /* ignore */ }
    }
    return true;
}

/* ------------------------------------------------------------------ */
/* 宏注册（保留，作为轻量用法）                                         */
/* ------------------------------------------------------------------ */

let registered = false;

function registerMacros() {
    const { macros } = ctx();
    if (!macros?.register) {
        console.warn('[UPF] 当前版本没有 macros.register，宏注入不可用（世界书注入不受影响）');
        return;
    }

    const category = macros.category?.CHARACTER ?? 'character';
    const returnType = macros.valueType?.STRING ?? 'string';

    macros.register(MACRO_CORE, {
        handler: () => { try { return getCoreText(); } catch (e) { console.error('[UPF] user_core 失败', e); return ''; } },
        category, returnType,
        description: 'UPF：跨世界观不变的 User 内核层（性格 / 腔调 / 底线）',
        aliases: [{ alias: 'me_core' }],
        exampleUsage: `{{${MACRO_CORE}}}`,
    });

    macros.register(MACRO_IDENTITY, {
        handler: () => { try { return getIdentityText(); } catch (e) { console.error('[UPF] user_identity 失败', e); return ''; } },
        category, returnType,
        description: 'UPF：随角色卡 / 世界书自动切换的 User 身份层',
        aliases: [{ alias: 'me_identity' }],
        exampleUsage: `{{${MACRO_IDENTITY}}}`,
    });

    macros.register(MACRO_PERSONA, {
        handler: () => { try { return getCombinedText(); } catch (e) { console.error('[UPF] user_persona 失败', e); return ''; } },
        category, returnType,
        description: 'UPF：内核层 + 身份层合并后的完整 User 人设',
        aliases: [{ alias: 'me' }, { alias: 'my_persona' }],
        exampleUsage: `{{${MACRO_PERSONA}}}`,
    });
}

function registerSlashCommands() {
    const { SlashCommandParser } = ctx();
    if (!SlashCommandParser?.addCommandObject) return;

    SlashCommandParser.addCommandObject({
        name: 'upf',
        aliases: ['persona'],
        helpString: 'UPF 人设管理。/upf 状态；/upf gen 要求文字（留空=随机）生成身份；/upf inject 注入到世界书；/upf on|off 启用/禁用注入条目；/upf list。',
        callback: async (namedArgs, unnamedArgs) => {
            const s = getSettings();
            const parts = Array.isArray(unnamedArgs) ? unnamedArgs : String(unnamedArgs ?? '').split(' ');
            const [action, ...rest] = parts.map(x => String(x).trim()).filter(Boolean);
            const arg = rest.join(' ');
            const chName = getCurrentCharacter()?.name ?? '（未选角色）';

            if (!action) {
                const inj = await getInjectionState();
                const injText = inj.state === 'injected'
                    ? `已注入「${inj.comment}」(${inj.disabled ? '已禁用' : '启用中'})`
                    : '未注入';
                return `UPF · 角色：${chName} ｜ 世界书：${inj.worldName ?? '无'} ｜ ${injText}`;
            }

            if (action === 'gen') {
                try {
                    const { text } = await generateIdentity(arg);
                    const id = ctx().uuidv4();
                    const name = `生成·${chName}·${new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
                    s.identities[id] = { id, name, content: text };
                    s.order.push(id);
                    s.lastIdentityId = id;
                    saveSettings();
                    refreshPanel();
                    return text;
                } catch (e) {
                    console.error('[UPF] 生成失败', e);
                    return `UPF 生成失败：${e.message}`;
                }
            }

            if (action === 'inject') {
                const id = s.lastIdentityId;
                if (!id || !s.identities[id]) return 'UPF：没有可注入的身份，请先 /upf gen';
                try {
                    const r = await injectToWorld(s.identities[id].content, s.gen.entryTitle);
                    refreshPanel();
                    return `UPF：已${r.created ? '创建' : '更新'}条目「${r.comment}」于世界书 ${r.worldName}`;
                } catch (e) {
                    return `UPF 注入失败：${e.message}`;
                }
            }

            if (action === 'on' || action === 'off') {
                try {
                    await modifyInjection({ disable: action === 'off' });
                    refreshPanel();
                    return `UPF：注入条目已${action === 'off' ? '禁用' : '启用'}`;
                } catch (e) {
                    return `UPF：${e.message}`;
                }
            }

            if (action === 'list') {
                const ids = Object.keys(s.identities);
                if (!ids.length) return 'UPF：还没有任何身份档案。';
                return `UPF 身份档案：${ids.map(i => s.identities[i].name).join('、')}`;
            }

            return 'UPF：可用 gen / inject / on / off / list';
        },
    });
}

function ensureRegistered() {
    if (registered) return;
    registered = true;
    registerMacros();
    registerSlashCommands();
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

let panelBuilt = false;
let lastGenerated = '';

function buildPanelHtml() {
    return `
    <div class="upf-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>User Persona Forge · 跨世界观 User 人设</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <div class="upf-status">
                    <div><span class="upf-label">当前角色</span><span id="upf-char-name">—</span></div>
                    <div><span class="upf-label">世界书</span><span id="upf-world-name">—</span></div>
                    <div><span class="upf-label">注入状态</span><span id="upf-inject-state">—</span></div>
                </div>

                <hr class="sysHR">

                <div class="upf-section">
                    <div class="upf-section-title">① 核心性格（跨世界观不变，只写一次）</div>
                    <div class="upf-hint">写「是个什么样的人」：性格、爱好、说话腔调、底线。
                        铁律：别写世界观专属名词 —— 写「沉迷拆解复杂系统」，别写「我是程序员」。</div>
                    <textarea id="upf-core" class="upf-textarea text_pole" rows="7"
                        placeholder="user 是个……的人&#10;性格：&#10;爱好：&#10;说话方式：&#10;底线 / 雷区：&#10;对关系的态度："></textarea>
                    <div class="upf-meta"><span id="upf-core-meta">0 字</span></div>
                </div>

                <hr class="sysHR">

                <div class="upf-section">
                    <div class="upf-section-title">② AI 生成身份（读世界书 → 生成 → 注入）</div>
                    <div class="upf-hint">插件会把「你的核心性格 + 当前角色卡的世界书内容 + 下面的要求」一起发给当前配置的模型。</div>
                    <div class="upf-row">
                        <input id="upf-requirement" class="text_pole upf-input" type="text"
                            placeholder="想当什么身份？（留空 = 让 AI 自由发挥）例：和主角敌对的赏金猎人">
                    </div>
                    <div class="upf-row">
                        <input id="upf-entry-title" class="text_pole upf-input-short" type="text" value="玩家人物设定">
                        <button id="upf-generate" class="menu_button">生成身份</button>
                        <button id="upf-regen" class="menu_button">再生成一次</button>
                        <button id="upf-generated-clear" class="menu_button">清空</button>
                    </div>
                    <div class="upf-hint">生成结果可以直接改，改满意了再注入。</div>
                    <textarea id="upf-generated" class="upf-textarea text_pole" rows="12"
                        placeholder="（点「生成身份」后，结果会出现在这里，可直接编辑）"></textarea>
                    <div class="upf-meta"><span id="upf-generated-meta">0 字</span></div>

                    <div class="upf-subsection">
                        <div class="upf-subsection-title">素材过滤（勾选的条目不会被 AI 读到）</div>
                        <div class="upf-hint">剧透条目、跟玩家身份无关的条目可以勾掉。默认全部读取。</div>
                        <div class="upf-row">
                            <input id="upf-exclude-search" class="text_pole upf-input" type="text"
                                placeholder="搜索条目名 / 内容">
                            <button id="upf-exclude-clear" class="menu_button">清空排除</button>
                        </div>
                        <div id="upf-exclude-list" class="upf-exclude-list"></div>
                        <div class="upf-meta"><span id="upf-exclude-summary">—</span></div>
                    </div>
                </div>

                <hr class="sysHR">

                <div class="upf-section">
                    <div class="upf-section-title">③ 注入到角色卡的世界书</div>
                    <div class="upf-row">
                        <button id="upf-inject" class="menu_button">注入 / 更新到世界书</button>
                        <button id="upf-toggle" class="menu_button">启用 / 禁用</button>
                        <button id="upf-remove" class="menu_button menu_button_danger">从世界书移除</button>
                    </div>
                    <div class="upf-hint">注入的条目是<strong>常驻条目</strong>（蓝色），插入位置在角色定义之前，所以模型一定会读到。
                        注入后可以随时禁用 —— 禁用后它就不会进 prompt 了。</div>
                </div>

                <hr class="sysHR">

                <div class="upf-section">
                    <div class="upf-section-title">④ 生成 NPC（绿灯条目，关键词触发）</div>
                    <div class="upf-hint">NPC 会写成<strong>绿灯条目</strong> —— 只有在对话里提到关键词时才注入，不常驻、不白占上下文。
                        所以生成时 AI 会连「触发关键词」一起给出来（名字、称号、别人怎么称呼他）。</div>
                    <div class="upf-row">
                        <input id="upf-npc-requirement" class="text_pole upf-input" type="text"
                            placeholder="什么样的 NPC？（留空 = 让 AI 自由发挥）例：酒馆老板，豪爽但藏了秘密">
                        <button id="upf-npc-generate" class="menu_button">生成 NPC</button>
                        <button id="upf-npc-clear" class="menu_button">清空</button>
                    </div>
                    <textarea id="upf-npc-result" class="upf-textarea text_pole" rows="12"
                        placeholder="（点「生成 NPC」后，结果会出现在这里，可直接编辑）"></textarea>
                    <div class="upf-meta"><span id="upf-npc-meta">0 字</span> · <span id="upf-npc-info">—</span></div>
                    <div class="upf-row">
                        <input id="upf-npc-keys" class="text_pole upf-input" type="text"
                            placeholder="触发关键词（逗号分隔；留空则用 AI 生成的）">
                        <button id="upf-npc-inject" class="menu_button">注入为绿灯条目</button>
                    </div>
                    <div class="upf-hint">本世界书已注入的 NPC：<span id="upf-npc-list">（无）</span></div>
                </div>

                <hr class="sysHR">

                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>身份档案库（手动管理 / 生成历史，可选）</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-up up"></div>
                    </div>
                    <div class="inline-drawer-content" style="display:none">
                        <div class="upf-row">
                            <select id="upf-identity-select" class="text_pole upf-select"></select>
                            <button id="upf-identity-new" class="menu_button">新建</button>
                            <button id="upf-identity-rename" class="menu_button">重命名</button>
                            <button id="upf-identity-delete" class="menu_button menu_button_danger">删除</button>
                        </div>
                        <textarea id="upf-identity-content" class="upf-textarea text_pole" rows="8"
                            placeholder="手动维护的身份文本（给宏注入用，不用可忽略）"></textarea>
                        <div class="upf-row">
                            <button id="upf-bind-character" class="menu_button">绑定到当前角色卡</button>
                            <button id="upf-bind-world" class="menu_button">绑定到当前世界书</button>
                            <button id="upf-bind-clear" class="menu_button">解绑</button>
                        </div>
                    </div>
                </div>

                <hr class="sysHR">

                <div class="inline-drawer">
                    <div class="inline-drawer-toggle inline-drawer-header">
                        <b>工具</b>
                        <div class="inline-drawer-icon fa-solid fa-circle-chevron-up up"></div>
                    </div>
                    <div class="inline-drawer-content" style="display:none">
                        <div class="upf-row">
                            <button id="upf-write-persona" class="menu_button">把宏写入 Persona 描述</button>
                            <button id="upf-copy-macro" class="menu_button">复制 {{user_persona}}</button>
                        </div>
                        <div class="upf-row">
                            <button id="upf-export" class="menu_button">导出 JSON</button>
                            <button id="upf-import" class="menu_button">导入 JSON</button>
                            <input id="upf-import-file" type="file" accept="application/json" hidden>
                        </div>
                        <div class="upf-hint">世界书注入是主用法；宏注入（<code>{{user_persona}}</code>）是轻量备选，两者可以并存。</div>
                    </div>
                </div>

            </div>
        </div>
    </div>`;
}

/** 渲染「素材过滤」的条目勾选列表 */
async function renderExcludeList() {
    const c = ctx();
    const s = getSettings();
    const worldName = getCurrentWorldKey();
    const $list = $('#upf-exclude-list');

    if (!worldName) {
        $list.empty().append('<div class="upf-exclude-empty">（该卡没有绑定世界书）</div>');
        $('#upf-exclude-summary').text('—');
        return;
    }

    let world = null;
    try { world = await c.loadWorldInfo(worldName); } catch (e) { /* 读不到就只显示内嵌书 */ }

    const items = [];
    for (const e of Object.values(world?.entries ?? {})) {
        const body = (e.content ?? '').trim();
        if (!body) continue;
        items.push({
            key: `wi:${e.uid}`,
            label: (e.comment || '').trim() || body.slice(0, 40),
            title: body.slice(0, 120),
            constant: !!e.constant,
        });
    }

    const book = getCurrentCharacter()?.data?.character_book;
    if (book && Array.isArray(book.entries)) {
        book.entries.forEach((e, idx) => {
            const body = (e.content ?? '').trim();
            if (!body) return;
            items.push({
                key: `book:${idx}`,
                label: (e.comment || e.name || '').trim() || body.slice(0, 40),
                title: body.slice(0, 120),
                constant: !!e.constant,
                embedded: true,
            });
        });
    }

    const excluded = new Set(s.excluded[worldName] ?? []);
    // 常驻条目排前面（通常就是世界观骨架），被排除的也往前排，方便复查
    items.sort((a, b) => {
        // 常驻条目排前面（b 常驻 → a 往后）
        if (!!b.constant !== !!a.constant) return b.constant ? 1 : -1;
        // 其次：被排除的排前面，方便复查勾了哪些
        return (excluded.has(b.key) ? 1 : 0) - (excluded.has(a.key) ? 1 : 0);
    });

    const esc = (x) => String(x).replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
    const rows = items.map(it => {
        const checked = excluded.has(it.key) ? ' checked' : '';
        const badge = it.constant ? '<span class="upf-badge">常驻</span>' : '';
        const tag = it.embedded ? '<span class="upf-badge upf-badge-alt">内嵌</span>' : '';
        return `<label class="upf-exclude-item" title="${esc(it.title)}">`
            + `<input type="checkbox" data-key="${it.key}"${checked}> `
            + `<span>${badge}${tag}${esc(it.label)}</span></label>`;
    });

    $list.empty().append(rows.length ? rows.join('') : '<div class="upf-exclude-empty">（没有可读的条目）</div>');

    const excludedHere = [...excluded].filter(k => items.some(i => i.key === k)).length;
    $('#upf-exclude-summary').text(`共 ${items.length} 条 · 已排除 ${excludedHere} 条`);
}

function refreshIdentitySelect(keep) {
    const s = getSettings();
    const $sel = $('#upf-identity-select');
    const prev = keep ?? s.lastIdentityId;

    $sel.empty();
    const ids = s.order.filter(id => s.identities[id]);
    for (const id of Object.keys(s.identities)) {
        if (!ids.includes(id)) ids.push(id);
    }
    if (!ids.length) {
        $sel.append($('<option>', { value: '', text: '（暂无身份档案）' }));
        $('#upf-identity-content').val('');
        return;
    }
    for (const id of ids) {
        $sel.append($('<option>', { value: id, text: s.identities[id].name }));
    }
    const target = (prev && s.identities[prev]) ? prev : ids[0];
    $sel.val(target);
    s.lastIdentityId = target;
    $('#upf-identity-content').val(s.identities[target]?.content ?? '');
}

function updateCoreMeta() {
    $('#upf-core-meta').text(`${String($('#upf-core').val() ?? '').length} 字`);
}

function updateGeneratedMeta() {
    $('#upf-generated-meta').text(`${String($('#upf-generated').val() ?? '').length} 字`);
}

async function refreshInjectionState() {
    const inj = await getInjectionState();
    $('#upf-world-name').text(inj.worldName ?? '（未绑定）');
    const map = {
        no_world: '（该卡没有世界书，注入时会自动创建）',
        not_injected: '未注入',
        missing: '条目丢失，重新注入即可',
        injected: inj.disabled ? `已注入「${inj.comment}」· 已禁用` : `已注入「${inj.comment}」· 启用中`,
        error: '读取失败',
    };
    $('#upf-inject-state').text(map[inj.state] ?? '—');

    const $btn = $('#upf-toggle');
    if (inj.state === 'injected') {
        $btn.text(inj.disabled ? '启用' : '禁用').prop('disabled', false);
    } else {
        $btn.text('启用 / 禁用').prop('disabled', true);
    }
    return inj;
}

function refreshStatus() {
    const s = getSettings();
    $('#upf-char-name').text(getCurrentCharacter()?.name ?? '（未选角色）');
    $('#upf-entry-title').val(s.gen.entryTitle);
    refreshInjectionState();
    renderExcludeList();
    renderNpcList();
}

function refreshPanel() {
    if (!panelBuilt) return;
    const s = getSettings();
    $('#upf-core').val(s.core ?? '');
    updateCoreMeta();
    refreshIdentitySelect(null);
    refreshStatus();
}

function bindEvents() {
    // 内核
    let coreTimer = null;
    $('#upf-core').on('input', () => {
        updateCoreMeta();
        clearTimeout(coreTimer);
        coreTimer = setTimeout(() => {
            getSettings().core = String($('#upf-core').val() ?? '');
            saveSettings();
        }, 400);
    });

    // 条目名
    $('#upf-entry-title').on('input', () => {
        const s = getSettings();
        s.gen.entryTitle = String($('#upf-entry-title').val() ?? '玩家人物设定').trim() || '玩家人物设定';
        saveSettings();
    });

    // 生成结果编辑
    $('#upf-generated').on('input', updateGeneratedMeta);

    // 排除列表：搜索过滤
    $('#upf-exclude-search').on('input', () => {
        const q = String($('#upf-exclude-search').val() ?? '').trim().toLowerCase();
        $('#upf-exclude-list').find('.upf-exclude-item').each(function () {
            const text = String($(this).text() ?? '').toLowerCase();
            $(this).toggle(!q || text.includes(q));
        });
    });

    // 排除列表：勾选 / 取消（事件委托）
    $('#upf-exclude-list').on('change', 'input[type="checkbox"]', (ev) => {
        const key = ev?.target?.dataset?.key;
        if (!key) return;
        const s = getSettings();
        const worldName = getCurrentWorldKey();
        if (!worldName) return;
        const set = new Set(s.excluded[worldName] ?? []);
        if (ev.target.checked) set.add(key); else set.delete(key);
        s.excluded[worldName] = [...set];
        saveSettings();
        renderExcludeList();
    });

    // 清空排除
    $('#upf-exclude-clear').on('click', () => {
        const s = getSettings();
        const worldName = getCurrentWorldKey();
        if (!worldName) { toast('该卡没有世界书', 'info'); return; }
        delete s.excluded[worldName];
        saveSettings();
        renderExcludeList();
        toast('已清空该世界书的排除设置', 'success');
    });

    // 生成
    const doGenerate = async () => {
        const s = getSettings();
        if (!s.core.trim()) {
            const ok = await askConfirm('还没写核心性格', '核心性格为空会让生成结果很飘。确定继续吗？');
            if (!ok) return;
        }
        const req = String($('#upf-requirement').val() ?? '').trim();
        s.gen.lastRequirement = req;

        const btn = $('#upf-generate');
        btn.prop('disabled', true).text('生成中…');
        try {
            const { loader } = ctx();
            const hide = loader?.show ? loader.show('UPF 生成中') : null;
            try {
                const { text, worldContext } = await generateIdentity(req);
                lastGenerated = text;
                $('#upf-generated').val(text);
                updateGeneratedMeta();
                toast(`已生成（参考了 ${worldContext.sources.join('、') || '无素材'}）`, 'success');
            } finally {
                if (typeof hide === 'function') hide();
                else if (loader?.hide) loader.hide();
            }
        } catch (e) {
            // 详细错误日志：不同 API 客户端抛错结构差异很大，尽量多打几个字段
            console.error('[UPF] 生成失败');
            console.error('  message:', e?.message);
            console.error('  status:', e?.status ?? e?.response?.status);
            const body = e?.response?.body ?? e?.response?.data ?? e?.data ?? e?.error ?? null;
            if (body !== null && body !== undefined) {
                const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
                console.error('  body:', bodyStr);
            }
            if (e?.stack) console.error('  stack:', e.stack);
            toast(`生成失败：${e.message}`, 'error');
        } finally {
            btn.prop('disabled', false).text('生成身份');
        }
    };

    $('#upf-generate').on('click', doGenerate);
    $('#upf-regen').on('click', doGenerate);

    // 注入
    $('#upf-inject').on('click', async () => {
        const content = String($('#upf-generated').val() ?? '').trim();
        if (!content) { toast('先生成（或手动填写）身份内容', 'warning'); return; }
        try {
            const title = String($('#upf-entry-title').val() ?? '玩家人物设定').trim();
            const r = await injectToWorld(content, title);
            // 同时存一份到档案库
            const s = getSettings();
            const id = ctx().uuidv4();
            s.identities[id] = { id, name: `${r.comment} · ${r.worldName}`, content };
            s.order.push(id);
            s.lastIdentityId = id;
            saveSettings();
            refreshIdentitySelect(id);
            await refreshInjectionState();
            toast(`已${r.created ? '注入' : '更新'}到世界书 ${r.worldName}`, 'success');
        } catch (e) {
            console.error('[UPF] 注入失败', e);
            toast(`注入失败：${e.message}`, 'error');
        }
    });

    // 启用 / 禁用
    $('#upf-toggle').on('click', async () => {
        try {
            const inj = await getInjectionState();
            if (inj.state !== 'injected') { toast('还没注入', 'warning'); return; }
            await modifyInjection({ disable: !inj.disabled });
            await refreshInjectionState();
            toast(inj.disabled ? '已启用' : '已禁用', 'success');
        } catch (e) {
            toast(`操作失败：${e.message}`, 'error');
        }
    });

    // 移除
    $('#upf-remove').on('click', async () => {
        try {
            const inj = await getInjectionState();
            if (inj.state !== 'injected') { toast('还没注入', 'warning'); return; }
            const ok = await askConfirm('从世界书移除？', `将删除条目「${inj.comment}」，不可撤销。`);
            if (!ok) return;
            await modifyInjection({ remove: true });
            await refreshInjectionState();
            toast('已移除', 'success');
        } catch (e) {
            toast(`移除失败：${e.message}`, 'error');
        }
    });

    // ---- NPC 生成 ----
    function updateNpcMeta() {
        $('#upf-npc-meta').text(`${String($('#upf-npc-result').val() ?? '').length} 字`);
    }
    $('#upf-npc-result').on('input', updateNpcMeta);

    $('#upf-generated-clear').on('click', () => {
        $('#upf-generated').val('');
        updateGeneratedMeta();
    });
    $('#upf-npc-clear').on('click', () => {
        $('#upf-npc-result').val('');
        $('#upf-npc-info').text('—');
        $('#upf-npc-keys').val('');
        updateNpcMeta();
    });

    $('#upf-npc-generate').on('click', async () => {
        const btn = $('#upf-npc-generate');
        btn.prop('disabled', true).text('生成中…');
        try {
            const req = String($('#upf-npc-requirement').val() ?? '');
            const { text } = await generateNpc(req);
            $('#upf-npc-result').val(text);
            $('#upf-npc-meta').text(`${text.length} 字`);
            const { name, keys } = parseNpc(text);
            $('#upf-npc-keys').val(keys.join('、'));
            $('#upf-npc-info').text(
                keys.length
                    ? `关键词 ${keys.length} 个${name ? ` · 名字：${name}` : ''}`
                    : '没识别到关键词，请手动填写',
            );
            toast(keys.length ? 'NPC 已生成，关键词已填好' : 'NPC 已生成，但没识别到关键词',
                keys.length ? 'success' : 'warning');
        } catch (e) {
            console.error('[UPF] NPC 生成失败', e);
            toast(`生成失败：${e.message}`, 'error');
        } finally {
            btn.prop('disabled', false).text('生成 NPC');
        }
    });

    $('#upf-npc-inject').on('click', async () => {
        const content = String($('#upf-npc-result').val() ?? '').trim();
        if (!content) { toast('先生成或填写 NPC 内容', 'warning'); return; }
        try {
            const r = await injectNpcToWorld(content, $('#upf-npc-keys').val());
            await renderNpcList();
            toast(`已注入「${r.comment}」· 关键词：${r.keys.join('、')}`, 'success');
        } catch (e) {
            console.error('[UPF] NPC 注入失败', e);
            toast(`注入失败：${e.message}`, 'error');
        }
    });

    // 档案库
    $('#upf-identity-select').on('change', () => {
        const s = getSettings();
        const id = String($('#upf-identity-select').val() ?? '');
        s.lastIdentityId = id || null;
        $('#upf-identity-content').val(id ? (s.identities[id]?.content ?? '') : '');
        saveSettings();
    });

    let idTimer = null;
    $('#upf-identity-content').on('input', () => {
        clearTimeout(idTimer);
        idTimer = setTimeout(() => {
            const s = getSettings();
            const id = String($('#upf-identity-select').val() ?? '');
            if (id && s.identities[id]) {
                s.identities[id].content = String($('#upf-identity-content').val() ?? '');
                saveSettings();
            }
        }, 400);
    });

    $('#upf-identity-new').on('click', async () => {
        const name = await askInput('新身份名称', '例如：西幻·伊莱恩', '');
        if (!name) return;
        const s = getSettings();
        const id = ctx().uuidv4();
        s.identities[id] = { id, name: String(name), content: '' };
        s.order.push(id);
        s.lastIdentityId = id;
        saveSettings();
        refreshIdentitySelect(id);
        toast('已创建', 'success');
    });

    $('#upf-identity-rename').on('click', async () => {
        const s = getSettings();
        const id = String($('#upf-identity-select').val() ?? '');
        if (!id || !s.identities[id]) { toast('先选中一个身份', 'warning'); return; }
        const name = await askInput('重命名', '', s.identities[id].name);
        if (!name) return;
        s.identities[id].name = String(name);
        saveSettings();
        refreshIdentitySelect(id);
        toast('已重命名', 'success');
    });

    $('#upf-identity-delete').on('click', async () => {
        const s = getSettings();
        const id = String($('#upf-identity-select').val() ?? '');
        if (!id || !s.identities[id]) { toast('先选中一个身份', 'warning'); return; }
        const ok = await askConfirm(`删除「${s.identities[id].name}」？`, '只是删掉档案库里的这份记录，不影响已注入的世界书条目。');
        if (!ok) return;
        delete s.identities[id];
        s.order = s.order.filter(x => x !== id);
        for (const k of Object.keys(s.bindings.characters)) {
            if (s.bindings.characters[k] === id) delete s.bindings.characters[k];
        }
        for (const k of Object.keys(s.bindings.worlds)) {
            if (s.bindings.worlds[k] === id) delete s.bindings.worlds[k];
        }
        if (s.defaultIdentityId === id) s.defaultIdentityId = null;
        saveSettings();
        refreshIdentitySelect(null);
        toast('已删除', 'success');
    });

    $('#upf-bind-character').on('click', () => {
        const key = getCurrentCharacterKey();
        const s = getSettings();
        const id = String($('#upf-identity-select').val() ?? '');
        if (!key) { toast('没有选中角色卡', 'warning'); return; }
        if (!id || !s.identities[id]) { toast('先选中一个身份', 'warning'); return; }
        s.bindings.characters[key] = id;
        saveSettings();
        toast('已绑定', 'success');
    });

    $('#upf-bind-world').on('click', () => {
        const key = getCurrentWorldKey();
        const s = getSettings();
        const id = String($('#upf-identity-select').val() ?? '');
        if (!key) { toast('该卡没有世界书', 'warning'); return; }
        if (!id || !s.identities[id]) { toast('先选中一个身份', 'warning'); return; }
        s.bindings.worlds[key] = id;
        saveSettings();
        toast('已绑定', 'success');
    });

    $('#upf-bind-clear').on('click', () => {
        const key = getCurrentCharacterKey();
        const s = getSettings();
        if (key && s.bindings.characters[key]) {
            delete s.bindings.characters[key];
            saveSettings();
            toast('已解绑', 'success');
        } else {
            toast('当前卡没有绑定', 'info');
        }
    });

    // 工具
    $('#upf-write-persona').on('click', () => {
        try {
            const c = ctx();
            const pu = c.powerUserSettings;
            const currentName = c.name1;
            const avatarId = Object.keys(pu?.personas ?? {}).find(id => pu.personas[id] === currentName);
            if (!avatarId) {
                toast(`没找到名为「${currentName}」的人设，请先在人设面板创建并选中它`, 'warning');
                return;
            }
            pu.persona_descriptions ??= {};
            pu.persona_descriptions[avatarId] ??= {
                description: '', position: 0, depth: 4, role: 'system', lorebook: '', title: '',
            };
            pu.persona_descriptions[avatarId].description = `{{${MACRO_PERSONA}}}`;
            saveSettings();
            toast('已写入 {{user_persona}}', 'success');
        } catch (e) {
            console.error('[UPF] 写入 Persona 失败', e);
            toast('写入失败，详见控制台', 'error');
        }
    });

    $('#upf-copy-macro').on('click', async () => {
        const text = `{{${MACRO_PERSONA}}}`;
        try {
            await navigator.clipboard.writeText(text);
            toast('已复制', 'success');
        } catch (_) {
            toast(`复制失败，请手动输入：${text}`, 'warning');
        }
    });

    $('#upf-export').on('click', () => {
        const data = JSON.stringify(getSettings(), null, 2);
        const blob = new Blob([data], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'upf-persona-backup.json';
        a.click();
        URL.revokeObjectURL(a.href);
        toast('已导出', 'success');
    });

    $('#upf-import').on('click', () => $('#upf-import-file').trigger('click'));
    $('#upf-import-file').on('change', (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const parsed = JSON.parse(String(reader.result));
                const s = getSettings();
                if (typeof parsed.core === 'string') s.core = parsed.core;
                if (parsed.identities && typeof parsed.identities === 'object') {
                    s.identities = { ...s.identities, ...parsed.identities };
                }
                if (Array.isArray(parsed.order)) s.order = [...new Set([...s.order, ...parsed.order])];
                if (parsed.bindings?.characters) Object.assign(s.bindings.characters, parsed.bindings.characters);
                if (parsed.bindings?.worlds) Object.assign(s.bindings.worlds, parsed.bindings.worlds);
                if (parsed.injections) Object.assign(s.injections, parsed.injections);
                if (parsed.gen) Object.assign(s.gen, parsed.gen);
                saveSettings();
                refreshPanel();
                toast('导入成功', 'success');
            } catch (e) {
                console.error('[UPF] 导入失败', e);
                toast('导入失败：不是合法的 JSON', 'error');
            } finally {
                ev.target.value = '';
            }
        };
        reader.readAsText(file);
    });

    $('.upf-settings .inline-drawer-toggle').on('click', () => setTimeout(() => { refreshStatus(); }, 50));
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

export async function onActivate() {
    ensureRegistered();
}

async function init() {
    ensureRegistered();
    try {
        const container = $('#extensions_settings2');
        if (!container.length) {
            console.warn('[UPF] 找不到 #extensions_settings2，面板未注入');
            return;
        }
        container.append(buildPanelHtml());
        panelBuilt = true;

        refreshPanel();
        bindEvents();

        const { eventSource, eventTypes } = ctx();
        if (eventSource && eventTypes?.CHAT_CHANGED) {
            eventSource.on(eventTypes.CHAT_CHANGED, () => refreshStatus());
        }
        if (eventSource && eventTypes?.CHARACTER_EDITED) {
            eventSource.on(eventTypes.CHARACTER_EDITED, () => refreshStatus());
        }

        console.debug('[UPF] 已就绪 v2');
    } catch (e) {
        console.error('[UPF] 初始化失败', e);
    }
}

if (typeof jQuery !== 'undefined') {
    jQuery(init);
} else if (document.readyState !== 'loading') {
    init();
} else {
    document.addEventListener('DOMContentLoaded', init);
}
