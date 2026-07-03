// ============================================================
// Pocket Buddy - 电子宠物游戏核心逻辑
// ============================================================

(function() {
'use strict';

// ===== 常量与配置 =====
const SAVE_KEY = 'pocket_buddy_save';

// ===== 用户系统配置 =====
// Supabase 云存档配置（可选，不配置则使用本地多账号系统）
// 把下面两个值替换成你自己的 Supabase 项目信息即可启用云存档
const SUPABASE_URL = 'https://moqywcmlbreepxkqkhom.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Uy1fV9bAPi2uHg-FKMI6rQ_fRAm3IpT';

// 本地存储 key
const LOCAL_USERS_KEY = 'pocket_buddy_users';
const CURRENT_USER_KEY = 'pocket_buddy_current_user';

// 全局状态
let supabase = null;
let currentUser = null;       // 当前登录用户 { id, username, email?, type: 'local'|'cloud' }
let cloudSaveEnabled = false; // 是否启用云端存档

// ===== 工具：简单哈希（用于本地密码存储，非加密级别，仅防肉眼） =====
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

// ===== 本地用户系统 =====
function getLocalUsers() {
  try {
    const data = localStorage.getItem(LOCAL_USERS_KEY);
    return data ? JSON.parse(data) : {};
  } catch(e) {
    return {};
  }
}

function saveLocalUsers(users) {
  try {
    localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(users));
    return true;
  } catch(e) {
    console.warn('保存用户数据失败:', e);
    return false;
  }
}

// 本地注册
function localRegister(username, password) {
  const users = getLocalUsers();
  if (users[username.toLowerCase()]) {
    return { success: false, error: '用户名已存在' };
  }
  const userId = 'local_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  users[username.toLowerCase()] = {
    id: userId,
    username: username,
    passwordHash: simpleHash(password),
    createdAt: new Date().toISOString(),
    gameData: null // 游戏数据在第一次保存时写入
  };
  saveLocalUsers(users);
  return {
    success: true,
    user: { id: userId, username: username, type: 'local' }
  };
}

// 本地登录
function localLogin(username, password) {
  const users = getLocalUsers();
  const user = users[username.toLowerCase()];
  if (!user) {
    return { success: false, error: '用户不存在' };
  }
  if (user.passwordHash !== simpleHash(password)) {
    return { success: false, error: '密码错误' };
  }
  return {
    success: true,
    user: { id: user.id, username: user.username, type: 'local' }
  };
}

// 本地保存游戏数据
function saveLocalUserData(userId, gameData) {
  let success = false;
  try {
    // 方法1：存在用户专属的独立 key 里（最可靠）
    const userSaveKey = 'pocket_buddy_user_save_' + userId;
    localStorage.setItem(userSaveKey, JSON.stringify(gameData));
    success = true;

    // 方法2：也更新到 users 对象里（兼容）
    try {
      const users = getLocalUsers();
      for (const key in users) {
        if (users[key].id === userId) {
          users[key].gameData = JSON.parse(JSON.stringify(gameData));
          users[key].lastSaveTime = new Date().toISOString();
          saveLocalUsers(users);
          break;
        }
      }
    } catch(e2) { console.warn('更新 users 对象失败:', e2); }

    // 方法3：保存到 IndexedDB（异步，不阻塞）
    saveToIDB(userId, gameData).catch(() => {});
  } catch(e) {
    console.warn('本地用户数据保存失败:', e);
  }
  return success;
}

// ===== IndexedDB 持久化存储（最可靠的本地存储） =====
const IDB_DB_NAME = 'pocket_buddy_db';
const IDB_STORE_NAME = 'game_saves';
const IDB_VERSION = 1;
let idbPromise = null;

function openIDB() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    try {
      if (!window.indexedDB) { resolve(null); return; }
      const req = indexedDB.open(IDB_DB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
          db.createObjectStore(IDB_STORE_NAME, { keyPath: 'userId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { console.warn('IndexedDB 打开失败'); resolve(null); };
    } catch(e) { resolve(null); }
  });
  return idbPromise;
}

async function saveToIDB(userId, gameData) {
  try {
    const db = await openIDB();
    if (!db) return false;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      const store = tx.objectStore(IDB_STORE_NAME);
      const req = store.put({ userId, gameData: JSON.parse(JSON.stringify(gameData)), savedAt: Date.now() });
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
    });
  } catch(e) { return false; }
}

async function loadFromIDB(userId) {
  try {
    const db = await openIDB();
    if (!db) return null;
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE_NAME, 'readonly');
      const store = tx.objectStore(IDB_STORE_NAME);
      const req = store.get(userId);
      req.onsuccess = () => {
        const result = req.result;
        resolve(result && result.gameData ? result.gameData : null);
      };
      req.onerror = () => resolve(null);
    });
  } catch(e) { return null; }
}

// 本地读取游戏数据（同步版本，用于快速加载）
function loadLocalUserData(userId) {
  let result = null;

  // 方法1：优先从用户专属 key 读取（最可靠）
  try {
    const userSaveKey = 'pocket_buddy_user_save_' + userId;
    const data = localStorage.getItem(userSaveKey);
    if (data) {
      const parsed = JSON.parse(data);
      if (parsed && parsed.pet) {
        result = parsed;
      }
    }
  } catch(e) {
    console.warn('从专属 key 读取失败:', e);
  }

  // 方法2：兜底从 users 对象里读取
  if (!result) {
    try {
      const users = getLocalUsers();
      for (const key in users) {
        if (users[key].id === userId && users[key].gameData && users[key].gameData.pet) {
          result = users[key].gameData;
          break;
        }
      }
    } catch(e) {
      console.warn('本地用户数据读取失败:', e);
    }
  }

  // 方法3：从通用存档位置兜底
  if (!result) {
    try {
      const data = localStorage.getItem(SAVE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed && parsed.pet) {
          result = parsed;
        }
      }
    } catch(e) {}
  }

  return result;
}

// 异步加载用户数据（包含 IndexedDB）
async function loadLocalUserDataAsync(userId) {
  // 先尝试同步 localStorage（快速）
  const syncResult = loadLocalUserData(userId);
  if (syncResult && syncResult.pet) {
    return syncResult;
  }

  // localStorage 没有，尝试 IndexedDB（更持久）
  const idbResult = await loadFromIDB(userId);
  if (idbResult && idbResult.pet) {
    // 找到就回写到 localStorage，加速下次读取
    try {
      const userSaveKey = 'pocket_buddy_user_save_' + userId;
      localStorage.setItem(userSaveKey, JSON.stringify(idbResult));
    } catch(e) {}
    return idbResult;
  }

  return null;
}

// ===== Supabase 云存档 =====
// 初始化 Supabase
function initSupabase() {
  if (typeof window !== 'undefined' && window.supabase && SUPABASE_URL && SUPABASE_ANON_KEY) {
    try {
      supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      return true;
    } catch(e) {
      console.warn('Supabase 初始化失败:', e);
      return false;
    }
  }
  return false;
}

// 检查是否启用了云存档
function isCloudSaveEnabled() {
  return cloudSaveEnabled && supabase && currentUser && currentUser.type === 'cloud';
}

// 带超时的 Promise 工具
function withTimeout(promise, ms, timeoutMsg = '超时') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMsg)), ms);
    promise.then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

// 云存档：保存游戏数据
async function saveToCloud() {
  if (!isCloudSaveEnabled()) return false;
  try {
    const result = await withTimeout(
      supabase
        .from('game_saves')
        .upsert({
          user_id: currentUser.id,
          game_data: JSON.parse(JSON.stringify(gameState)),
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' }),
      5000, // 5秒超时
      '云存档保存超时'
    );
    const { error } = result;
    if (error) {
      console.warn('云存档保存失败:', error);
      return false;
    }
    return true;
  } catch(e) {
    console.warn('云存档异常:', e);
    return false;
  }
}

// 云存档：读取游戏数据
async function loadFromCloud() {
  if (!isCloudSaveEnabled()) return null;
  try {
    const result = await withTimeout(
      supabase
        .from('game_saves')
        .select('game_data, updated_at')
        .eq('user_id', currentUser.id)
        .single(),
      5000, // 5秒超时
      '云存档读取超时'
    );
    const { data, error } = result;
    if (error || !data) {
      console.warn('云存档读取失败或无数据:', error);
      return null;
    }
    return data;
  } catch(e) {
    console.warn('云存档读取异常:', e);
    return null;
  }
}

// ===== 统一的用户接口 =====

// 云用户本地缓存（用于离线登录）
const CLOUD_USERS_CACHE_KEY = 'pocket_buddy_cloud_users_cache';

function getCloudUsersCache() {
  try {
    const data = localStorage.getItem(CLOUD_USERS_CACHE_KEY);
    return data ? JSON.parse(data) : {};
  } catch(e) { return {}; }
}

function saveCloudUserCache(userInfo, passwordHash) {
  try {
    const cache = getCloudUsersCache();
    cache[userInfo.username.toLowerCase()] = {
      id: userInfo.id,
      username: userInfo.username,
      email: userInfo.email,
      passwordHash: passwordHash,
      type: 'cloud',
      lastLogin: new Date().toISOString()
    };
    localStorage.setItem(CLOUD_USERS_CACHE_KEY, JSON.stringify(cache));
  } catch(e) {}
}

function getCloudUserCache(username, password) {
  try {
    const cache = getCloudUsersCache();
    const user = cache[username.toLowerCase()];
    if (user && user.passwordHash === simpleHash(password)) {
      return {
        id: user.id,
        username: user.username,
        email: user.email,
        type: 'cloud'
      };
    }
  } catch(e) {}
  return null;
}

// 注册
async function registerUser(username, password) {
  // 如果配置了 Supabase，优先使用云注册
  if (supabase) {
    try {
      // Supabase 使用邮箱，这里把用户名当邮箱用（加个假域名）
      const email = username.includes('@') ? username : username + '@local.app';
      const { data, error } = await withTimeout(
        supabase.auth.signUp({ email, password }),
        8000,
        '云注册超时'
      );
      if (error) {
        // 如果 Supabase 注册失败，降级到本地注册
        console.warn('云注册失败，使用本地注册:', error.message);
      } else if (data.user) {
        cloudSaveEnabled = true;
        const userInfo = {
          id: data.user.id,
          username: username,
          email: data.user.email,
          type: 'cloud'
        };
        // 缓存云用户信息到本地，支持离线登录
        saveCloudUserCache(userInfo, simpleHash(password));
        return {
          success: true,
          user: userInfo
        };
      }
    } catch(e) {
      console.warn('云注册异常:', e);
    }
  }

  // 本地注册（降级方案）
  return localRegister(username, password);
}

// 登录
async function loginUser(username, password) {
  let cloudLoginSuccess = false;
  let cloudUser = null;

  // 如果配置了 Supabase，优先尝试云登录
  if (supabase) {
    try {
      const email = username.includes('@') ? username : username + '@local.app';
      const { data, error } = await withTimeout(
        supabase.auth.signInWithPassword({ email, password }),
        8000,
        '云登录超时'
      );
      if (error) {
        console.warn('云登录失败，尝试离线/本地登录:', error.message);
      } else if (data.user) {
        cloudLoginSuccess = true;
        cloudSaveEnabled = true;
        cloudUser = {
          id: data.user.id,
          username: username,
          email: data.user.email,
          type: 'cloud'
        };
        // 缓存云用户信息到本地
        saveCloudUserCache(cloudUser, simpleHash(password));
        return {
          success: true,
          user: cloudUser
        };
      }
    } catch(e) {
      console.warn('云登录异常:', e);
    }
  }

  // 云登录失败，尝试云用户本地缓存（离线模式）
  const cachedCloudUser = getCloudUserCache(username, password);
  if (cachedCloudUser) {
    cloudSaveEnabled = false; // 离线模式，禁用云同步
    return {
      success: true,
      user: { ...cachedCloudUser, offline: true },
      offline: true
    };
  }

  // 本地登录（降级方案）
  const result = localLogin(username, password);
  if (result.success) {
    cloudSaveEnabled = false;
  }
  return result;
}

// 保存当前用户的游戏数据（本地+云端）
function saveUserData() {
  if (!currentUser) return false;

  // 保存到对应用户的存储
  if (currentUser.type === 'local') {
    // 双保险：同时保存到用户专属存储和通用存档位置
    const r1 = saveLocalUserData(currentUser.id, gameState);
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(gameState));
    } catch(e) {}
    return r1;
  } else if (currentUser.type === 'cloud') {
    // 云存档异步保存
    saveToCloud().catch(() => {});
    // 同时也保存一份到本地作为缓存
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(gameState));
    } catch(e) {}
    // 也保存到本地用户数据，双重保险
    try { saveLocalUserData(currentUser.id, gameState); } catch(e) {}
    return true;
  }
  return false;
}

// 加载当前用户的游戏数据
async function loadUserData() {
  if (!currentUser) return null;

  if (currentUser.type === 'local') {
    // 本地用户：使用异步加载（localStorage + IndexedDB）
    const userData = await loadLocalUserDataAsync(currentUser.id);
    if (userData && userData.pet) {
      return userData;
    }
    return null;
  } else if (currentUser.type === 'cloud') {
    // 云用户：先快速检查本地缓存（避免无网络时等待超时）
    const localUserData = loadLocalUserData(currentUser.id);
    if (localUserData && localUserData.pet) {
      // 有本地缓存，后台异步尝试从云端同步最新数据
      loadFromCloud().then(cloudData => {
        if (cloudData && cloudData.game_data && cloudData.game_data.pet) {
          // 云端有更新的数据，更新到本地
          const cloudTime = cloudData.updated_at ? new Date(cloudData.updated_at).getTime() : 0;
          const localTime = localUserData.records?.lastSave || 0;
          if (cloudTime > localTime) {
            // 云端数据更新，静默更新本地缓存
            saveLocalUserData(currentUser.id, cloudData.game_data);
            try {
              localStorage.setItem(SAVE_KEY, JSON.stringify(cloudData.game_data));
            } catch(e) {}
          }
        }
      }).catch(() => {});
      // 立即返回本地数据，让用户先玩起来
      return localUserData;
    }

    // 本地没有缓存，尝试从云端加载
    const cloudData = await loadFromCloud();
    if (cloudData && cloudData.game_data && cloudData.game_data.pet) {
      // 云端有数据，保存到本地缓存
      saveLocalUserData(currentUser.id, cloudData.game_data);
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(cloudData.game_data));
      } catch(e) {}
      return cloudData.game_data;
    }

    // 云端也没有，再试一次 IndexedDB
    const idbData = await loadFromIDB(currentUser.id);
    if (idbData && idbData.pet) {
      return idbData;
    }

    return null;
  }
  return null;
}

// 记住当前登录用户（会话持久化）
function saveCurrentSession() {
  try {
    if (currentUser) {
      localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(currentUser));
    } else {
      localStorage.removeItem(CURRENT_USER_KEY);
    }
  } catch(e) {}
}

// 恢复上次登录会话
function restoreSession() {
  try {
    const data = localStorage.getItem(CURRENT_USER_KEY);
    if (data) {
      currentUser = JSON.parse(data);
      if (currentUser.type === 'cloud') {
        cloudSaveEnabled = !!supabase;
      }
      return true;
    }
  } catch(e) {}
  return false;
}

// 登出
function logoutUser() {
  currentUser = null;
  cloudSaveEnabled = false;
  saveCurrentSession();
  // 清除当前游戏状态
  gameState = createInitialState();
  // 返回登录画面
  showScreen('login-screen');
  showLoginForm();
}
const SPECIES_LIST = [
  { id: 'duck',      name: '鸭子',     emoji: '🦆', desc: '经典橡皮鸭，尾巴会摇', stage: 1, evolveBranch: null, baseId: 'duck',    modifiers: { hp: 1.05, atk: 1.0, def: 1.0, spd: 1.0, crit: 1.0 } },
  { id: 'goose',     name: '鹅',       emoji: '🪿', desc: '伸脖子的鹅，脖子会左右晃', stage: 1, evolveBranch: null, baseId: 'goose',   modifiers: { hp: 0.95, atk: 1.15, def: 0.9, spd: 1.05, crit: 1.0 } },
  { id: 'blob',      name: '果冻',     emoji: '🫧', desc: '会膨胀收缩的软体生物', stage: 1, evolveBranch: null, baseId: 'blob',    modifiers: { hp: 1.2, atk: 0.8, def: 1.15, spd: 0.85, crit: 0.9 } },
  { id: 'cat',       name: '猫',       emoji: '🐱', desc: 'ω嘴猫脸，尾巴会甩', stage: 1, evolveBranch: null, baseId: 'cat',     modifiers: { hp: 0.9, atk: 1.0, def: 0.85, spd: 1.2, crit: 1.15 } },
  { id: 'dragon',    name: '龙',       emoji: '🐉', desc: '双角小龙，顶上有火焰', stage: 1, evolveBranch: null, baseId: 'dragon',  modifiers: { hp: 1.05, atk: 1.25, def: 1.0, spd: 0.95, crit: 1.0 } },
  { id: 'octopus',   name: '章鱼',     emoji: '🐙', desc: '触手交替摆动', stage: 1, evolveBranch: null, baseId: 'octopus', modifiers: { hp: 1.0, atk: 1.05, def: 1.1, spd: 0.95, crit: 1.1 } },
  { id: 'owl',       name: '猫头鹰',   emoji: '🦉', desc: '大眼睛会眨', stage: 1, evolveBranch: null, baseId: 'owl',     modifiers: { hp: 0.95, atk: 0.95, def: 1.05, spd: 1.05, crit: 1.2 } },
  { id: 'penguin',   name: '企鹅',     emoji: '🐧', desc: '翅膀拍打，脚下有雪花', stage: 1, evolveBranch: null, baseId: 'penguin', modifiers: { hp: 1.0, atk: 0.95, def: 1.3, spd: 1.0, crit: 1.0 } },
  { id: 'turtle',    name: '乌龟',     emoji: '🐢', desc: '壳上花纹会变', stage: 1, evolveBranch: null, baseId: 'turtle',  modifiers: { hp: 1.3, atk: 0.75, def: 1.45, spd: 0.7, crit: 0.8 } },
  { id: 'snail',     name: '蜗牛',     emoji: '🐌', desc: '触角伸缩，留下波浪痕迹', stage: 1, evolveBranch: null, baseId: 'snail',   modifiers: { hp: 1.15, atk: 0.8, def: 1.35, spd: 0.7, crit: 0.85 } },
  { id: 'ghost',     name: '幽灵',     emoji: '👻', desc: '下摆飘动', stage: 1, evolveBranch: null, baseId: 'ghost',   modifiers: { hp: 0.9, atk: 0.9, def: 0.85, spd: 1.15, crit: 1.15 } },
  { id: 'axolotl',   name: '六角恐龙', emoji: '🦎', desc: '两侧腮须交替摇摆', stage: 1, evolveBranch: null, baseId: 'axolotl', modifiers: { hp: 1.15, atk: 0.95, def: 1.05, spd: 0.95, crit: 1.05 } },
  { id: 'capybara',  name: '水豚',     emoji: '🐹', desc: '呆萌大脸，耳朵会动', stage: 1, evolveBranch: null, baseId: 'capybara', modifiers: { hp: 1.2, atk: 0.85, def: 1.15, spd: 0.9, crit: 0.95 } },
  { id: 'cactus',    name: '仙人掌',   emoji: '🌵', desc: '手臂上下交替', stage: 1, evolveBranch: null, baseId: 'cactus',  modifiers: { hp: 1.1, atk: 0.9, def: 1.4, spd: 0.8, crit: 0.95 } },
  { id: 'robot',     name: '机器人',   emoji: '🤖', desc: '天线闪烁，嘴部表情变化', stage: 1, evolveBranch: null, baseId: 'robot',   modifiers: { hp: 1.0, atk: 1.15, def: 1.05, spd: 0.95, crit: 1.1 } },
  { id: 'rabbit',    name: '兔子',     emoji: '🐰', desc: '耳朵一只会耷拉', stage: 1, evolveBranch: null, baseId: 'rabbit',  modifiers: { hp: 0.9, atk: 0.95, def: 0.85, spd: 1.3, crit: 1.1 } },
  { id: 'mushroom',  name: '蘑菇',     emoji: '🍄', desc: '蘑菇帽上斑点交替', stage: 1, evolveBranch: null, baseId: 'mushroom', modifiers: { hp: 1.1, atk: 0.85, def: 1.1, spd: 0.9, crit: 1.15 } },
  { id: 'chonk',     name: '胖猫',     emoji: '😺', desc: '耳朵抖动，尾巴甩动', stage: 1, evolveBranch: null, baseId: 'chonk',   modifiers: { hp: 1.25, atk: 1.1, def: 1.1, spd: 0.7, crit: 0.85 } }
];

// 进化分支配置
const EVOLVE_BRANCHES = {
  // 二阶段分支
  flame:  { prefix: '烈焰', emoji: '🔥', stage: 2 },
  ice:    { prefix: '寒冰', emoji: '❄️', stage: 2 },
  // 三阶段分支（烈焰系）
  blaze:  { prefix: '炽焰', emoji: '🔥🔥', stage: 3, parentBranch: 'flame' },
  demon:  { prefix: '炎魔', emoji: '🔥💀', stage: 3, parentBranch: 'flame' },
  // 三阶段分支（寒冰系）
  frost:  { prefix: '极寒', emoji: '❄️❄️', stage: 3, parentBranch: 'ice' },
  emperor:{ prefix: '冰皇', emoji: '❄️👑', stage: 3, parentBranch: 'ice' }
};

// 动态生成所有进化阶段的物种（18 + 36 + 72 = 126种）
(function expandSpeciesList() {
  const baseSpecies = [...SPECIES_LIST];
  const generated = [];

  // 生成二阶段：烈焰 / 寒冰
  baseSpecies.forEach(base => {
    ['flame', 'ice'].forEach(branch => {
      const br = EVOLVE_BRANCHES[branch];
      generated.push({
        id: base.id + '_' + branch,
        name: br.prefix + base.name,
        emoji: br.emoji + base.emoji,
        desc: br.prefix + '系的' + base.name,
        stage: br.stage,
        evolveBranch: branch,
        baseId: base.id,
        modifiers: base.modifiers || { hp: 1, atk: 1, def: 1, spd: 1, crit: 1 }
      });
    });
  });

  // 生成三阶段：炽焰/炎魔（烈焰系），极寒/冰皇（寒冰系）
  baseSpecies.forEach(base => {
    [
      { branch: 'blaze', parent: 'flame' },
      { branch: 'demon', parent: 'flame' },
      { branch: 'frost', parent: 'ice' },
      { branch: 'emperor', parent: 'ice' }
    ].forEach(({ branch, parent }) => {
      const br = EVOLVE_BRANCHES[branch];
      generated.push({
        id: base.id + '_' + branch,
        name: br.prefix + base.name,
        emoji: br.emoji + base.emoji,
        desc: br.prefix + '系的' + base.name,
        stage: br.stage,
        evolveBranch: branch,
        baseId: base.id,
        parentBranch: parent,
        modifiers: base.modifiers || { hp: 1, atk: 1, def: 1, spd: 1, crit: 1 }
      });
    });
  });

  // 全部加入 SPECIES_LIST
  generated.forEach(s => SPECIES_LIST.push(s));
})();

// 查找物种（支持 baseId 或 id）
function findSpecies(id) {
  if (!id) return null;
  return SPECIES_LIST.find(s => s.id === id) || null;
}

// 获取物种的基础物种（用于技能继承等）
function getBaseSpecies(species) {
  if (!species) return null;
  if (species.stage === 1) return species;
  return SPECIES_LIST.find(s => s.id === species.baseId) || species;
}

// 获取进化路径
function getEvolutionPaths(pet) {
  const species = pet.species;
  const stage = pet.stage || 1;
  const paths = [];

  if (stage === 1) {
    // 一阶段 → 二阶段：2个方向
    ['flame', 'ice'].forEach(branch => {
      const targetId = species.baseId + '_' + branch;
      const targetSpecies = findSpecies(targetId);
      if (targetSpecies) {
        paths.push({
          toSpecies: targetSpecies,
          level: 10,
          cost: 100,
          branch: branch
        });
      }
    });
  } else if (stage === 2) {
    // 二阶段 → 三阶段：2个方向
    const branch = pet.evolveBranch;
    let subBranches = [];
    if (branch === 'flame') {
      subBranches = ['blaze', 'demon'];
    } else if (branch === 'ice') {
      subBranches = ['frost', 'emperor'];
    }
    subBranches.forEach(subBranch => {
      const targetId = species.baseId + '_' + subBranch;
      const targetSpecies = findSpecies(targetId);
      if (targetSpecies) {
        paths.push({
          toSpecies: targetSpecies,
          level: 25,
          cost: 300,
          branch: subBranch
        });
      }
    });
  }
  // 三阶段没有进化路径

  return paths;
}

const RARITIES = [
  { id: 'common',    name: '普通', stars: '★',         color: '#888',    weight: 60, statMin: 15 },
  { id: 'uncommon',  name: '非凡', stars: '★★',        color: '#00B894', weight: 25, statMin: 20 },
  { id: 'rare',      name: '稀有', stars: '★★★',       color: '#0984E3', weight: 10, statMin: 25 },
  { id: 'epic',      name: '史诗', stars: '★★★★',      color: '#FDCB6E', weight: 4,  statMin: 30 },
  { id: 'legendary', name: '传说', stars: '★★★★★',     color: '#E17055', weight: 1,  statMin: 40 }
];

const HATS = ['none', 'crown', 'tophat', 'propeller', 'halo', 'wizard', 'beanie', 'tinyduck', 'glasses', 'scarf', 'bowtie', 'necklace', 'flower', 'ribbon', 'crown_gold', 'santa', 'party', 'sunglasses', 'monocle', 'bell', 'backpack', 'bow', 'wings'];
const HAT_EMOJI = {
  none:'',
  crown:'👑',
  tophat:'🎩',
  propeller:'🧢',
  halo:'😇',
  wizard:'🧙',
  beanie:'🧶',
  tinyduck:'🐥',
  glasses:'👓',
  scarf:'🧣',
  bowtie:'🎀',
  necklace:'📿',
  flower:'🌸',
  ribbon:'🎗️',
  crown_gold:'👑',
  santa:'🎅',
  party:'🎉',
  sunglasses:'🕶️',
  monocle:'🧐',
  bell:'🔔',
  backpack:'🎒',
  bow:'🎀',
  wings:'🪽'
};

const STAT_NAMES = ['debugging', 'patience', 'chaos', 'wisdom', 'snark'];
const STAT_LABELS = {
  debugging: { name: '活力', desc: '充满活力，精力充沛', icon: '⚡', battle: '提高攻击力' },
  patience:  { name: '温柔', desc: '性格温顺，有耐心', icon: '🌸', battle: '提高最大HP和防御力' },
  chaos:     { name: '调皮', desc: '调皮捣蛋，鬼点子多', icon: '🎭', battle: '提高攻击力和暴击率' },
  wisdom:    { name: '聪明', desc: '聪明伶俐，一点就通', icon: '💡', battle: '提高防御力和闪避率' },
  snark:     { name: '傲娇', desc: '外表高冷，内心柔软', icon: '😼', battle: '提高速度，决定先手' }
};

// ===== 属性克制系统 =====
// 克制关系：活力→调皮→聪明→傲娇→活力（循环克制），温柔被所有克制但克制所有（特殊）
// 克制方对被克制方造成 30% 额外伤害
const STAT_COUNTER = {
  debugging: 'chaos',    // 活力克制调皮
  chaos:     'wisdom',    // 调皮克制聪明
  wisdom:    'snark',     // 聪明克制傲娇
  snark:     'debugging', // 傲娇克制活力
  patience:  null         // 温柔：不被克制也不克制别人
};

// 检查攻击方是否克制防守方
function isCounterAttack(attackerPet, defenderPet) {
  const atkDom = getDominantStat(attackerPet);
  const defDom = getDominantStat(defenderPet);
  if (!atkDom || !defDom) return false;
  // 温柔不参与克制
  if (atkDom === 'patience' || defDom === 'patience') return false;
  return STAT_COUNTER[atkDom] === defDom;
}

// ===== 季节/天气系统 =====
const WEATHER_TYPES = [
  { id: 'sunny',    name: '晴天', icon: '☀️',  desc: '阳光明媚', effects: { happinessDecay: 0.8, energyDecay: 0.9 } },
  { id: 'cloudy',   name: '多云', icon: '☁️',  desc: '云层较厚', effects: {} },
  { id: 'rainy',    name: '雨天', icon: '🌧️',  desc: '淅淅沥沥', effects: { cleanDecay: 2.0, happinessDecay: 1.3, energyDecay: 0.85 } },
  { id: 'stormy',   name: '暴风雨', icon: '⛈️', desc: '风雨交加', effects: { cleanDecay: 3.0, happinessDecay: 1.6, energyDecay: 1.2 } },
  { id: 'snowy',    name: '雪天', icon: '❄️',  desc: '白雪飘飘', effects: { cleanDecay: 0.5, energyDecay: 0.7, hungerDecay: 1.3 } },
  { id: 'windy',    name: '大风', icon: '💨',  desc: '狂风呼啸', effects: { happinessDecay: 1.2, cleanDecay: 1.5 } },
  { id: 'hot',      name: '酷热', icon: '🔥',  desc: '酷暑难耐', effects: { hungerDecay: 1.5, energyDecay: 1.3, cleanDecay: 1.3 } },
  { id: 'foggy',    name: '雾天', icon: '🌫️',  desc: '雾蒙蒙', effects: { happinessDecay: 0.7 } },
  { id: 'rainbow',  name: '彩虹', icon: '🌈',  desc: '雨后彩虹', effects: { happinessDecay: 0.5, allGain: 1.1 } },
  { id: 'starry',   name: '星夜', icon: '🌟',  desc: '星空璀璨', effects: { happinessDecay: 0.6, energyDecay: 0.8 } }
];

const SEASONS = [
  { name: '春天', icon: '🌸', months: [2, 3, 4], desc: '万物复苏' },
  { name: '夏天', icon: '☀️', months: [5, 6, 7], desc: '热情似火' },
  { name: '秋天', icon: '🍂', months: [8, 9, 10], desc: '秋高气爽' },
  { name: '冬天', icon: '❄️', months: [11, 0, 1], desc: '银装素裹' }
];

// 获取当前季节
function getSeason() {
  const month = new Date().getMonth();
  return SEASONS.find(s => s.months.includes(month)) || SEASONS[0];
}

// 根据季节获取天气池
function getSeasonWeatherPool() {
  const month = new Date().getMonth();
  // 春天：多云/雨/晴天多
  if (month >= 2 && month <= 4) return ['sunny','cloudy','rainy','cloudy','sunny','foggy','rainy','sunny'];
  // 夏天：晴天/酷热/暴风雨多
  if (month >= 5 && month <= 7) return ['sunny','hot','sunny','cloudy','stormy','sunny','hot','rainy'];
  // 秋天：多云/大风/晴天多
  if (month >= 8 && month <= 10) return ['cloudy','windy','sunny','cloudy','foggy','sunny','rainbow','windy'];
  // 冬天：雪天/阴天/大风多
  return ['snowy','cloudy','windy','snowy','cloudy','foggy','starry','snowy'];
}

// ===== 随机事件系统 =====
const RANDOM_EVENTS = [
  // 好事件
  { id: 'treasure',    name: '发现宝藏',   icon: '💰', type: 'good',   desc: '{pet}在外面溜达时发现了一袋金币！', effect: (gs) => { const coins = randInt(20, 80); gs.coins += coins; gs.records.totalCoinsEarned += coins; return `获得 ${coins} 金币！`; } },
  { id: 'gift',        name: '神秘礼物',   icon: '🎁', type: 'good',   desc: '一个神秘的包裹送到了！', effect: (gs) => { const coins = randInt(30, 100); gs.coins += coins; gs.records.totalCoinsEarned += coins; return `打开获得了 ${coins} 金币！`; } },
  { id: 'mood_boost',  name: '心情大好',   icon: '😊', type: 'good',   desc: '{pet}今天特别开心！', effect: (gs) => { if(gs.pet) gs.pet.status.happiness = clamp(gs.pet.status.happiness + 20, 0, 100); return '快乐值 +20！'; } },
  { id: 'energy_drink',name: '能量饮料',   icon: '🧃', type: 'good',   desc: '{pet}找到了一瓶能量饮料！', effect: (gs) => { if(gs.pet) gs.pet.status.energy = clamp(gs.pet.status.energy + 25, 0, 100); return '体力 +25！'; } },
  { id: 'lucky_star',  name: '幸运之星',   icon: '⭐', type: 'good',   desc: '一颗流星划过，{pet}显得特别幸运！', effect: (gs) => { const exp = randInt(10, 30); if(gs.pet) gainExp(exp); return `获得 ${exp} 经验值！`; } },
  { id: 'clean_fairy', name: '清洁仙子',   icon: '🧚', type: 'good',   desc: '清洁仙子路过，帮{pet}打扫了一下！', effect: (gs) => { if(gs.pet) gs.pet.status.clean = clamp(gs.pet.status.clean + 30, 0, 100); return '清洁度 +30！'; } },
  { id: 'food_find',   name: '美食发现',   icon: '🍖', type: 'good',   desc: '{pet}发现了藏起来的零食！', effect: (gs) => { if(gs.pet) gs.pet.status.hunger = clamp(gs.pet.status.hunger + 25, 0, 100); return '饱食度 +25！'; } },
  // 坏事件
  { id: 'bad_mood',    name: '心情不好',   icon: '😤', type: 'bad',    desc: '{pet}今天不太高兴...', effect: (gs) => { if(gs.pet) gs.pet.status.happiness = clamp(gs.pet.status.happiness - 15, 0, 100); return '快乐值 -15...'; } },
  { id: 'messy',       name: '弄脏了',     icon: '😬', type: 'bad',    desc: '{pet}不小心把自己弄脏了！', effect: (gs) => { if(gs.pet) gs.pet.status.clean = clamp(gs.pet.status.clean - 20, 0, 100); return '清洁度 -20'; } },
  { id: 'tired',       name: '突然疲倦',   icon: '😩', type: 'bad',    desc: '{pet}突然觉得很累...', effect: (gs) => { if(gs.pet) gs.pet.status.energy = clamp(gs.pet.status.energy - 15, 0, 100); return '体力 -15'; } },
  { id: 'hungry',      name: '肚子饿了',   icon: '🤤', type: 'bad',    desc: '{pet}的肚子咕咕叫了...', effect: (gs) => { if(gs.pet) gs.pet.status.hunger = clamp(gs.pet.status.hunger - 15, 0, 100); return '饱食度 -15'; } },
  { id: 'coin_loss',   name: '丢钱了',     icon: '💸', type: 'bad',    desc: '风吹走了{pet}的一些金币！', effect: (gs) => { const loss = Math.min(gs.coins, randInt(5, 20)); gs.coins -= loss; return `损失了 ${loss} 金币...`; } },
  { id: 'refuse_eat',  name: '拒绝进食',   icon: '🚫', type: 'bad',    desc: '{pet}闹脾气，拒绝进食！', effect: (gs) => { gameState._refuseEatUntil = Date.now() + 60000; return '接下来1分钟内宠物会拒绝进食...'; } },
  // 特殊事件
  { id: 'wild_pet',    name: '野生宠物',   icon: '🐾', type: 'special', desc: '遇到了一只野生宠物！', effect: (gs) => { return '一只野生宠物好奇地看了你一眼就跑了。'; } },
  { id: 'rainbow_sky', name: '彩虹出现',   icon: '🌈', type: 'special', desc: '天空中出现了美丽的彩虹！', effect: (gs) => { if(gs.pet) gs.pet.status.happiness = clamp(gs.pet.status.happiness + 10, 0, 100); return '心情变好了！'; } },
  { id: 'shooting_star', name: '流星雨',  icon: '🌠', type: 'special', desc: '流星雨来了！快许愿！', effect: (gs) => { const coins = randInt(10, 50); gs.coins += coins; gs.records.totalCoinsEarned += coins; if(gs.pet) gs.pet.status.happiness = clamp(gs.pet.status.happiness + 5, 0, 100); return `获得 ${coins} 金币，心情也不错！`; } },
  { id: 'mysterious',  name: '神秘声音',   icon: '👻', type: 'special', desc: '听到了神秘的声音...', effect: (gs) => { return '声音消失了，什么都没有发生...也许下次会有什么？'; } },
  { id: 'old_friend',  name: '老友来访',   icon: '💌', type: 'special', desc: '收到了一封来自远方朋友的信！', effect: (gs) => { const exp = randInt(5, 15); if(gs.pet) gainExp(exp); return `信里分享了经验，获得 ${exp} 经验！`; } },
];

const PERSONALITIES = [
  '总是充满活力，喜欢在你写代码时蹦来蹦去',
  '安静而智慧，偶尔冒出一句深刻的吐槽',
  '调皮捣蛋，但关键时刻总能帮上忙',
  '温柔体贴，会默默注视你直到你注意到它',
  '好奇心旺盛，对每一个新函数都充满兴趣',
  '有点懒散，但一旦认真起来效率惊人',
  '性格傲娇，嘴上说着不在乎其实很关心你',
  '是个小哲学家，经常陷入沉思',
  '精力充沛的乐天派，永远在微笑',
  '有点害羞，但熟悉后会变得很粘人'
];

const MOODS = {
  ecstatic: { emoji: '🤩', minAvg: 85 },
  happy:    { emoji: '😊', minAvg: 65 },
  neutral:  { emoji: '😐', minAvg: 40 },
  sad:      { emoji: '😢', minAvg: 20 },
  sick:     { emoji: '🤒', minAvg: 0 }
};

const SPEECH_LINES = {
  hungry:    ['肚子好饿...', '想吃东西！', '咕噜咕噜~', '有零食吗？'],
  dirty:     ['身上痒痒的...', '需要洗个澡', '好想泡温泉', '帮我清洁一下嘛'],
  tired:     ['好困啊...', '想睡觉了', '眼皮好重', '让我休息一会...'],
  sad:       ['有点无聊...', '陪我玩嘛', '好寂寞啊', '你在忙吗？'],
  sick:      ['不舒服...', '需要治疗', '头好晕...', '帮我吃点药'],
  happy:     ['今天真开心！', '最喜欢你了！', '嘿嘿~', '生活真美好'],
  ecstatic:  ['太幸福了！', '你是最好的主人！', '开心到飞起！', '每天都想这样！'],
  idle:      ['在干嘛呢？', '看看代码...', '嗯...这段有点问题', '加油！', '我在监督你哦', '别偷懒~', '好无聊...'],
  pet:       ['好舒服~', '再摸摸~', '喵~', '嘿嘿嘿', '还要还要！', '幸福...'],
  feed:      ['好好吃！', '谢谢投喂！', '满足~', '还想吃！'],
  play:      ['太好玩了！', '再来一次！', '哈哈哈！', '耶！'],
  clean:     ['好清爽！', '干干净净~', '香香的', '舒服！'],
  sleep:     ['晚安~', 'Zzz...', '做个好梦', '呼噜呼噜...'],
  heal:      ['好多了！', '谢谢关心~', '恢复活力了！', '你又救了我一次'],
  levelup:   ['我变强了！', '升级啦！', '感觉自己不一样了！', '越来越厉害了！']
};

// 性格台词（根据最高属性决定说话风格）
const PERSONALITY_SPEECH = {
  debugging: { // 活力型
    hungry:    ['好饿啊！！冲去吃！', '肚子饿得咕咕叫，快给我吃的！', '能量不足！需要补给！', '我要吃饭！马上！'],
    dirty:     ['脏了就脏了嘛，玩才重要！', '啊？要洗澡？等我再玩会儿...', '身上有点痒，但还能忍！', '洗就洗吧，快点！'],
    tired:     ['呼...好累...但还能再战！', '稍微歇会儿就好...', '眼皮有点重...不行，我还能玩！', '让我眯一会儿...就一小会儿...'],
    sad:       ['好无聊啊！带我出去玩！', '快陪我玩！不然我要拆家了！', '你怎么一直在忙啊？陪我嘛~', '好寂寞...来玩嘛！'],
    sick:      ['呜...身体好重...', '我好像生病了...但还能玩！', '头好晕...帮我看看嘛', '不舒服...要抱抱才能好'],
    happy:     ['耶！今天超开心！', '最最喜欢你啦！冲过来抱你！', '哇哈哈！太爽了！', '今天也要元气满满！'],
    ecstatic:  ['哇哈哈哈哈！太幸福啦！', '你是全世界最好的！', '我要飞起来啦！！', '每天都这么开心就好了！'],
    idle:      ['快来陪我玩！', '别写代码了，陪我玩嘛~', '在干什么呢？理我一下嘛', '好无聊好无聊好无聊！', '我来捣乱啦~', '别偷懒，我盯着你呢！'],
    pet:       ['舒服！再大力点！', '哈哈好痒！', '哇~继续继续！', '嘿嘿，最喜欢被摸了！', '还要还要！不许停！'],
    feed:      ['好吃！！！', '哇塞！美味！', '再来一碗！', '太棒了！满足！'],
    play:      ['冲啊！！！', '太刺激了！再来！', '哈哈哈！赢了赢了！', '耶！我最厉害！'],
    clean:     ['冲个澡也不错！', '洗完澡又能去玩了！', '泡泡好好玩！', '干净啦，继续玩！'],
    sleep:     ['晚安！明天继续玩！', 'Zzz...充能中...', '明天见！做个有活力的梦！', '呼噜...明天早起玩！'],
    heal:      ['复活！又是一条好汉！', '谢谢！我又充满能量了！', '满血复活！', '你救了我！我会报答你的！'],
    levelup:   ['我变强了！！', '升级啦！力量涌上来了！', '哇！感觉浑身都是劲！', '更强了！来挑战我吧！']
  },
  patience: { // 温柔型
    hungry:    ['肚子有点饿了呢...', '如果有吃的就好了...', '咕噜...', '主人，我有点饿...'],
    dirty:     ['身上好像有点脏了...', '想洗个热水澡...', '希望能清洁一下...', '有点痒痒的...'],
    tired:     ['有点累了呢...', '想休息一会儿...', '眼皮好重啊...', '让我靠一下...'],
    sad:       ['有点孤单呢...', '主人在忙吗...', '好想被抱抱...', '你已经很久没陪我了...'],
    sick:      ['身体有点不舒服...', '好像生病了...对不起让你担心了', '头有点晕...', '需要你的照顾...'],
    happy:     ['和你在一起真幸福...', '你真好...', '心里暖暖的~', '谢谢你陪着我'],
    ecstatic:  ['太幸福了...想哭...', '你是我最好的主人...', '感觉被爱包围着...', '希望时间停在这一刻'],
    idle:      ['在工作吗？加油哦~', '我陪着你呢...', '你认真的样子真好看', '累了就休息一下吧', '我会一直陪着你的', '...', '偷偷看着你'],
    pet:       ['嗯...好舒服...', '谢谢你...', '被你摸真幸福', '再摸摸头...', '最喜欢你了...'],
    feed:      ['谢谢你的投喂~', '好好吃...好幸福', '你对我真好', '满足了...'],
    play:      ['和你玩真开心~', '谢谢你陪我', '好开心呀~', '有你在真好'],
    clean:     ['谢谢你帮我洗澡~', '香香的呢~', '感觉清爽了很多', '你对我真好...'],
    sleep:     ['晚安...做个好梦', '谢谢你今天也陪着我', 'Zzz...', '明天也请多关照...'],
    heal:      ['谢谢你照顾我...', '好多了...有你真好', '让你担心了，对不起', '你是最温柔的...'],
    levelup:   ['都是因为你...我才能成长', '谢谢你一直陪着我', '感觉自己变得更好了', '和你一起真好...']
  },
  chaos: { // 调皮型
    hungry:    ['嘿！有吃的吗？我要偷！', '肚子饿了！去翻零食柜！', '咕噜噜~我要偷吃！', '你的外卖看起来很好吃！'],
    dirty:     ['洗澡？休想！我要跑！', '脏脏的才是男子汉！', '啊别抓我！我不要洗澡！', '身上脏才有味道嘛~'],
    tired:     ['才不累！我还能玩！', '累是什么？能吃吗？', '再玩五分钟！就五分钟！', '我还能再战三百回合！'],
    sad:       ['好无聊...搞点事情做做', '嘿嘿，你猜我藏了什么？', '你在忙啊？那我捣乱了哦~', '陪我玩嘛~不然我要捣蛋了！'],
    sick:      ['呜...生病了就不能捣蛋了...', '头好晕...今天先放过你', '不舒服...但是还能搞点小破坏', '我才没生病！就是有点...晕...'],
    happy:     ['嘿嘿嘿！今天心情好！', '太好玩了！我还要！', '哈哈哈哈你上当了！', '整蛊成功！'],
    ecstatic:  ['哇哈哈！太爽了！', '今天我要大闹一场！', '无敌是多么寂寞~', '快来追我呀~'],
    idle:      ['嘿嘿，我想到一个恶作剧...', '你在写代码？我来帮你（捣乱）！', '嘘...我要偷偷吓你一跳！', '你的笔不见了？嘿嘿~', '好无聊啊，来找点乐子', '猜猜我藏在哪里？', '在看什么？让我看看！'],
    pet:       ['嘿嘿，被你抓到了', '好痒！别摸了哈哈哈', '嗯...好吧，就让你摸一下', '别以为这样我就不捣蛋了！', '舒服...但我还会回来的！'],
    feed:      ['好吃！再来！', '嘿嘿，又骗到吃的了', '不错不错，勉强及格', '下次给我带更多好吃的！'],
    play:      ['哈哈哈！你输了！', '太好玩了！再来一局！', '我赢了我赢了！', '你不行啊，让让你吧~'],
    clean:     ['哼，这次就乖乖洗', '别以为我会感谢你！', '...还挺舒服的嘛', '洗完继续捣蛋！'],
    sleep:     ['才不想睡觉！...Zzz', '明天再继续玩！', '晚安...明天搞什么好呢...', '哼，才不是因为累才睡的！'],
    heal:      ['切，我才没事...', '谢谢你啦...笨蛋', '我又可以捣蛋了！', '别得意，我马上就好！'],
    levelup:   ['变强了！可以搞更大的恶作剧了！', '升级了！嘿嘿，你管不住我了', '更厉害了！来抓我呀~', '哇！感觉可以征服世界！']
  },
  wisdom: { // 聪明型
    hungry:    ['根据计算，我现在需要补充能量了', '饥饿值已低于阈值，建议进食', '从生物学角度，我该吃东西了', '数据分析：我饿了'],
    dirty:     ['清洁度下降中，建议进行清洗', '从卫生角度考虑，该洗澡了', '细菌指数上升中...', '需要维护身体清洁度'],
    tired:     ['能量不足，建议进入休眠模式', '疲劳值过高，需要休息恢复', '根据计算，我需要睡一会儿', '系统负载过高，需要冷却'],
    sad:       ['有点寂寞...不过我能理解你很忙', '独处时间过长，社交需求增加', '思考人生中...', '在观察你的工作进度'],
    sick:      ['免疫系统正在作战...', '体温升高，疑似感染', '需要药物辅助治疗', '身体出现异常状态'],
    happy:     ['和你在一起很愉快', '数据显示，今天心情很好', '幸福指数：95%', '心情：愉悦'],
    ecstatic:  ['幸福度已突破常规上限', '这是最优的一天！', '所有指标都指向快乐', '完美的一天...'],
    idle:      ['这段代码可以优化一下', '在思考一个有趣的问题...', '你的逻辑有个小漏洞哦', '我在分析人类行为模式', '观察中...', '嗯，让我想想...', '你知道吗...算了'],
    pet:       ['嗯...这有助于心理健康', '舒适指数上升中', '数据表明，抚摸有益健康', '继续，我在分析这种感觉...'],
    feed:      ['营养摄入完成，谢谢', '食物质量：优秀', '能量补充完毕', '计算正确，很好吃'],
    play:      ['有趣的互动，记录中', '游戏体验：良好', '分析你的游戏策略...', '下次我会赢的'],
    clean:     ['清洁度已恢复至最佳状态', '洗澡完成，效率很高', '卫生指数：100%', '清爽，有助于思考'],
    sleep:     ['进入休眠模式，晚安', '正在整理记忆...Zzz', '明天见，记得早起', '系统待机中...'],
    heal:      ['健康值已恢复', '治疗有效，感谢照顾', '免疫系统感谢你', '恢复速度超出预期'],
    levelup:   ['能力值提升，效率增加', '升级了，计算能力增强', '智慧等级提升', '又掌握了新的知识']
  },
  snark: { // 傲娇型
    hungry:    ['哼...才不是饿了，只是...刚好想吃而已', '喂，你不吃饭吗？我...我只是随便问问', '肚子叫了？才没有！是你听错了！', '才、才不是为了吃才看你的！'],
    dirty:     ['洗澡什么的...才不稀罕呢', '脏一点怎么了！...好吧确实有点痒', '哼，要你帮我洗我才洗', '才不是想洗澡呢！是你说要洗的！'],
    tired:     ['我才不累！...就是有点想躺一下', '睡觉什么的...才不是因为累！', '哼，就睡一会儿，只是一会儿哦', '才、才不是因为想睡才闭眼的！'],
    sad:       ['哼，谁要你陪了...', '才不无聊呢！一个人也挺好的...', '你忙你的，不用管我...真的不用', '...你终于注意到我了？'],
    sick:      ['才、才没有生病！就是有点...不舒服而已', '不用你管啦...唔', '我自己能扛...好吧，帮我拿点药', '才不是想让你担心！'],
    happy:     ['哼，还...还行吧', '才不是因为你才开心的！', '一般般啦，勉勉强强', '就、就一点点开心而已！'],
    ecstatic:  ['才、才不是特别开心呢！...哼', '这种程度就想让我高兴？...好吧有一点', '别得意忘形了！我只是...刚好心情好', '幸福什么的...才不会说呢！'],
    idle:      ['哼，又在写代码，不理我算了', '我才没有在看你！', '喂...你不累吗？...随便问问', '在、在干嘛呢？才不是想和你说话！', '...别不理我啊', '哼，不理你了！...真的不理了？', '才不无聊呢！'],
    pet:       ['哼...算、算了，就让你摸一下', '别、别摸那里！好痒...', '才、才不舒服呢！...再摸会儿也不是不行', '笨蛋...轻点啦'],
    feed:      ['哼，勉勉强强能吃', '才、才不是好吃！就是...不难吃而已', '谢、谢什么的...才不说呢', '下次再带我吃好吃的...听见没！'],
    play:      ['哼，赢了你也没什么好得意的', '才、才不是因为和你玩才开心的！', '再来一局！这次一定要赢你', '玩得...还行吧'],
    clean:     ['哼，洗干净了也不是给你看的', '才不喜欢洗澡呢！...泡泡还挺好玩', '别盯着我看！笨蛋', '香香的？才、才没有！'],
    sleep:     ['晚安什么的...才不说呢', '才不是因为累才睡的！...晚安', '哼，明天才不要叫我起床', '梦里才不会梦到你呢！'],
    heal:      ['才...才不需要你照顾！', '谢谢什么的...才不会说！', '哼，都是你的错我才会生病', '别、别碰我！...轻点啦'],
    levelup:   ['哼，变强是理所当然的', '才、才不是因为你才升级的！', '这种程度很正常吧', '...别夸我了，笨蛋']
  }
};

// 物品品质对应五维成长概率和成长量倍率
const QUALITY_GROW_PROB = {
  common: 0.05,  // 普通：5% 概率
  rare:   0.30,  // 稀有：30% 概率
  epic:   0.60   // 史诗：60% 概率
};
const QUALITY_GROW_AMOUNT = {
  common: 1.0,   // 普通：基础成长量
  rare:   1.0,   // 稀有：基础成长量
  epic:   1.5    // 史诗：1.5 倍成长量
};

const SHOP_ITEMS = {
  food: [
    { id: 'apple',      name: '苹果',     icon: '🍎', price: 5,   hunger: 15, happiness: 5,  desc: '普通但管饱', quality: 'common' },
    { id: 'cake',       name: '蛋糕',     icon: '🎂', price: 15,  hunger: 30, happiness: 15, desc: '美味又开心', quality: 'common' },
    { id: 'steak',      name: '牛排',     icon: '🥩', price: 25,  hunger: 50, happiness: 20, desc: '大餐！', quality: 'rare' },
    { id: 'sushi',      name: '寿司',     icon: '🍣', price: 20,  hunger: 35, happiness: 25, desc: '精致美味', quality: 'rare' },
    { id: 'pizza',      name: '披萨',     icon: '🍕', price: 18,  hunger: 40, happiness: 18, desc: '经典美食', quality: 'rare' },
    { id: 'golden_apple',name: '金苹果',  icon: '🍏', price: 50,  hunger: 80, happiness: 40, desc: '传说级食物', quality: 'epic' }
  ],
  toys: [
    { id: 'ball',       name: '球',       icon: '⚽', price: 10,  happiness: 20, energy: -10, desc: '简单快乐', quality: 'common' },
    { id: 'teddy',      name: '玩偶',     icon: '🧸', price: 20,  happiness: 35, energy: -15, desc: '温暖的陪伴', quality: 'common' },
    { id: 'puzzle',     name: '拼图',     icon: '🧩', price: 30,  happiness: 50, energy: -20, desc: '烧脑又有趣', quality: 'rare' },
    { id: 'gamepad',    name: '游戏机',   icon: '🎮', price: 40,  happiness: 60, energy: -25, desc: '停不下来！', quality: 'epic' }
  ],
  medicine: [
    { id: 'potion',     name: '药水',     icon: '🧪', price: 10,  health: 25, desc: '恢复一些生命' },
    { id: 'herb',       name: '草药',     icon: '🌿', price: 8,   health: 15, desc: '天然疗愈' },
    { id: 'elixir',     name: '灵药',     icon: '✨', price: 30,  health: 60, desc: '强力恢复' }
  ],
  cosmetics: [
    // 帽子类 (hat) - 普通/稀有
    { id: 'hat_tophat',      name: '礼帽',       icon: '🎩', price: 80,  desc: '优雅绅士', hatType: 'tophat',    type: 'hat',     rarity: 'common', hasColor: true },
    { id: 'hat_propeller',   name: '螺旋桨帽',   icon: '🧢', price: 60,  desc: '起飞！',   hatType: 'propeller', type: 'hat',     rarity: 'common', hasColor: true },
    { id: 'hat_beanie',      name: '针织帽',     icon: '🧶', price: 70,  desc: '温暖过冬', hatType: 'beanie',    type: 'hat',     rarity: 'common', hasColor: true },
    { id: 'hat_tinyduck',    name: '小鸭帽',     icon: '🐥', price: 90,  desc: '嘎嘎嘎~',  hatType: 'tinyduck',  type: 'hat',     rarity: 'common', hasColor: false },
    { id: 'hat_santa',       name: '圣诞帽',     icon: '🎅', price: 100, desc: '节日气氛', hatType: 'santa',     type: 'hat',     rarity: 'rare',   hasColor: false },
    { id: 'hat_party',       name: '派对帽',     icon: '🎉', price: 75,  desc: '庆祝一下', hatType: 'party',     type: 'hat',     rarity: 'common', hasColor: true },
    { id: 'hat_crown',       name: '皇冠',       icon: '👑', price: 300, desc: '戴上就是王者', hatType: 'crown',   type: 'hat',     rarity: 'rare',   hasColor: false },
    { id: 'hat_wizard',      name: '巫师帽',     icon: '🧙', price: 200, desc: '魔法力量', hatType: 'wizard',    type: 'hat',     rarity: 'rare',   hasColor: true },
    { id: 'hat_halo',        name: '光环',       icon: '😇', price: 250, desc: '天使降临', hatType: 'halo',      type: 'hat',     rarity: 'rare',   hasColor: false },
    // 眼镜类 (glasses)
    { id: 'acc_glasses',     name: '眼镜',       icon: '👓', price: 50,  desc: '博学多才', hatType: 'glasses',   type: 'glasses', rarity: 'common', hasColor: true },
    { id: 'acc_sunglasses',  name: '墨镜',       icon: '🕶️', price: 80,  desc: '酷炫十足', hatType: 'sunglasses',type: 'glasses', rarity: 'common', hasColor: true },
    { id: 'acc_monocle',     name: '单片眼镜',   icon: '🧐', price: 150, desc: '学者风范', hatType: 'monocle',   type: 'glasses', rarity: 'rare',   hasColor: false },
    // 围巾/丝带类 (scarf)
    { id: 'acc_scarf',       name: '围巾',       icon: '🧣', price: 60,  desc: '温暖舒适', hatType: 'scarf',     type: 'scarf',   rarity: 'common', hasColor: true },
    { id: 'acc_ribbon',      name: '丝带',       icon: '🎗️', price: 55,  desc: '甜美可爱', hatType: 'ribbon',    type: 'scarf',   rarity: 'common', hasColor: true },
    { id: 'acc_bowtie',      name: '领结',       icon: '🎀', price: 65,  desc: '可爱俏皮', hatType: 'bowtie',    type: 'scarf',   rarity: 'common', hasColor: true },
    // 饰品类 (necklace)
    { id: 'acc_necklace',    name: '项链',       icon: '📿', price: 150, desc: '神秘优雅', hatType: 'necklace',  type: 'necklace',rarity: 'rare',   hasColor: false },
    { id: 'acc_flower',      name: '小花',       icon: '🌸', price: 50,  desc: '清新自然', hatType: 'flower',    type: 'necklace',rarity: 'common', hasColor: true },
    { id: 'acc_bell',        name: '铃铛项圈',   icon: '🔔', price: 120, desc: '叮当叮当', hatType: 'bell',      type: 'necklace',rarity: 'rare',   hasColor: true },
    // 背包类 (backpack)
    { id: 'acc_backpack',    name: '小背包',     icon: '🎒', price: 180, desc: '探险必备', hatType: 'backpack',  type: 'backpack',rarity: 'rare',   hasColor: true },
    { id: 'acc_bow',         name: '蝴蝶结',     icon: '🎀', price: 70,  desc: '少女心',   hatType: 'bow',       type: 'backpack',rarity: 'common', hasColor: true },
    // 传说级
    { id: 'hat_crown_gold',  name: '黄金皇冠',   icon: '👑', price: 500, desc: '传说中的王者之冠', hatType: 'crown_gold', type: 'hat', rarity: 'legendary', hasColor: false },
    { id: 'acc_wings',       name: '天使翅膀',   icon: '🪽', price: 600, desc: '神圣羽翼', hatType: 'wings',     type: 'backpack',rarity: 'legendary', hasColor: false }
  ]
};

// 装扮颜色配置
// 使用 sepia+saturate+hue-rotate 方案：先统一转为 sepia 基调，再偏移到目标色相
// 这样无论原始 emoji 是什么颜色都能一致染色
const HAT_COLORS = [
  { id: 'default', name: '默认', filter: '' },
  { id: 'red',     name: '红色', filter: 'sepia(1) saturate(8) hue-rotate(-25deg)' },
  { id: 'blue',    name: '蓝色', filter: 'sepia(1) saturate(8) hue-rotate(190deg)' },
  { id: 'green',   name: '绿色', filter: 'sepia(1) saturate(8) hue-rotate(80deg)' },
  { id: 'yellow',  name: '黄色', filter: 'sepia(1) saturate(8) hue-rotate(10deg)' },
  { id: 'purple',  name: '紫色', filter: 'sepia(1) saturate(8) hue-rotate(260deg)' },
  { id: 'pink',    name: '粉色', filter: 'sepia(1) saturate(6) hue-rotate(300deg)' },
  { id: 'black',   name: '黑色', filter: 'grayscale(1) brightness(0.3)' },
  { id: 'white',   name: '白色', filter: 'grayscale(1) brightness(2.2)' }
];

// ===== 宠物问答题目库（至少60题）=====
const QUIZ_QUESTIONS = [
  // === 动物冷知识 ===
  { q: '猫一天大约睡多少小时？', opts: ['8小时', '12-16小时', '20小时', '6小时'], ans: 1 },
  { q: '以下哪种动物是哺乳动物？', opts: ['鳄鱼', '海豚', '蜥蜴', '蛇'], ans: 1 },
  { q: '世界上最大的鸟是什么？', opts: ['老鹰', '鸵鸟', '孔雀', '天鹅'], ans: 1 },
  { q: '章鱼有几颗心脏？', opts: ['1颗', '2颗', '3颗', '4颗'], ans: 2 },
  { q: '水豚的原产地是哪里？', opts: ['非洲', '南美洲', '亚洲', '澳洲'], ans: 1 },
  { q: '猫头鹰的头能转多少度？', opts: ['90度', '180度', '270度', '360度'], ans: 2 },
  { q: '蜗牛大约有多少颗牙齿？', opts: ['0颗', '100颗', '25000颗', '1000颗'], ans: 2 },
  { q: '以下哪种动物会变色？', opts: ['金鱼', '变色龙', '鹦鹉', '兔子'], ans: 1 },
  { q: '恐龙属于哪类动物？', opts: ['两栖类', '爬行类', '哺乳类', '鱼类'], ans: 1 },
  { q: '企鹅主要生活在哪个半球？', opts: ['北半球', '南半球', '赤道', '都有'], ans: 1 },
  { q: '兔子最擅长做什么？', opts: ['游泳', '跳跃', '爬树', '飞行'], ans: 1 },
  { q: '蘑菇属于什么生物？', opts: ['植物', '动物', '真菌', '细菌'], ans: 2 },
  { q: '乌龟的壳是什么做的？', opts: ['石头', '骨骼', '角质', '钙质'], ans: 1 },
  { q: '蝙蝠是哪类动物？', opts: ['鸟类', '哺乳动物', '爬行动物', '昆虫'], ans: 1 },
  { q: '海马的繁殖方式有什么特别？', opts: ['雌性产卵', '雄性孵化育儿', '卵生在水里', '胎生'], ans: 1 },
  { q: '袋鼠主要用什么方式移动？', opts: ['奔跑', '跳跃', '爬行', '飞行'], ans: 1 },
  { q: '北极熊的皮肤是什么颜色？', opts: ['白色', '黑色', '灰色', '粉色'], ans: 1 },
  { q: '蓝鲸的心脏大约有多大？', opts: ['足球大', '篮球大', '小汽车大', '乒乓球大'], ans: 2 },
  { q: '世界上最长寿的动物记录保持者是谁？', opts: ['大象', '弓壳龟（约190岁）', '鹦鹉', '鳄鱼'], ans: 1 },
  { q: '陆地上跑得最快的动物是什么？', opts: ['狮子', '猎豹', '马', '羚羊'], ans: 1 },
  // === 宠物饲养知识 ===
  { q: '猫不能吃什么食物？', opts: ['鱼', '巧克力', '鸡肉', '牛肉'], ans: 1 },
  { q: '狗的嗅觉细胞大约有多少个？', opts: ['100万', '2亿', '3亿', '50万'], ans: 2 },
  { q: '兔子能用自来水洗澡吗？', opts: ['可以', '不可以，容易感冒', '偶尔可以', '必须用热水'], ans: 1 },
  { q: '猫的胡须有什么作用？', opts: ['装饰', '感知空间大小', '闻气味', '调节体温'], ans: 1 },
  { q: '狗的正常体温是多少？', opts: ['36℃', '38-39℃', '42℃', '35℃'], ans: 1 },
  { q: '猫的正常心跳每分钟大约多少次？', opts: ['60次', '110-140次', '200次', '40次'], ans: 1 },
  { q: '以下哪种食物对狗有毒？', opts: ['胡萝卜', '葡萄和葡萄干', '米饭', '鸡肉'], ans: 1 },
  { q: '金鱼的记忆力大约能维持多久？', opts: ['3秒', '数月甚至更长', '1分钟', '1天'], ans: 1 },
  { q: '猫为什么经常推东西下桌？', opts: ['无聊', '狩猎本能', '生气', '想打扫卫生'], ans: 1 },
  { q: '猫的耳朵能转动多少度？', opts: ['90度', '180度', '45度', '360度'], ans: 1 },
  // === 电子宠物游戏知识 ===
  { q: '以下哪个不是电子宠物游戏？', opts: ['拓麻歌子', '宝可梦', '我的世界', '电子鸡'], ans: 2 },
  { q: '拓麻歌子（Tamagotchi）最初诞生于哪一年？', opts: ['1990年', '1996年', '2000年', '1985年'], ans: 1 },
  { q: '宝可梦（Pokémon）的创始人是？', opts: ['宫本茂', '田尻智', '坂口博信', '小岛秀夫'], ans: 1 },
  { q: '最初的拓麻歌子是哪个国家发明的？', opts: ['美国', '日本', '中国', '韩国'], ans: 1 },
  { q: '《宝可梦》系列中最经典的初始御三家是？', opts: ['皮卡丘、伊布、卡比兽', '妙蛙种子、小火龙、杰尼龟', '皮卡丘、胖丁、可达鸭', '路卡利欧、烈咬陆鲨、巨金怪'], ans: 1 },
  { q: '拓麻歌子最初的外形灵感来自什么？', opts: ['鸡蛋', '手机', '手表', '钥匙扣'], ans: 0 },
  { q: '《动物森友会》中狸克（Tom Nook）是什么动物？', opts: ['狐狸', '狸猫', '浣熊', '兔子'], ans: 2 },
  { q: '拓麻歌子之父是谁？', opts: ['田尻智', '真板亚纪（Aki Maita）', '宫本茂', '远藤雅伸'], ans: 1 },
  // === 自然科学知识 ===
  { q: '地球大约有多少岁？', opts: ['10亿年', '46亿年', '100亿年', '1亿年'], ans: 1 },
  { q: '光速大约是每秒多少公里？', opts: ['15万', '30万', '3万', '300万'], ans: 1 },
  { q: '世界上最深的海洋是？', opts: ['大西洋', '太平洋', '印度洋', '北冰洋'], ans: 1 },
  { q: '世界上最大的哺乳动物是？', opts: ['大象', '蓝鲸', '长颈鹿', '犀牛'], ans: 1 },
  { q: '太阳系中最大的行星是？', opts: ['土星', '木星', '天王星', '海王星'], ans: 1 },
  { q: '人体最大的器官是什么？', opts: ['心脏', '肝脏', '皮肤', '大脑'], ans: 2 },
  { q: '声音在空气中的传播速度大约是？', opts: ['340米/秒', '1000米/秒', '100米/秒', '3400米/秒'], ans: 0 },
  { q: '水结冰时的温度是？', opts: ['-10℃', '0℃', '10℃', '4℃'], ans: 1 },
  // === 宠物品种知识 ===
  { q: '金毛寻回犬原产于哪个国家？', opts: ['法国', '英国（苏格兰）', '德国', '美国'], ans: 1 },
  { q: '柯基犬最初是用来做什么的？', opts: ['看门', '牧牛', '捕鼠', '导盲'], ans: 1 },
  { q: '暹罗猫原产于哪个国家？', opts: ['日本', '中国', '泰国', '英国'], ans: 2 },
  { q: '哈士奇是什么类型的犬？', opts: ['牧羊犬', '雪橇犬', '猎犬', '斗牛犬'], ans: 1 },
  { q: '波斯猫以什么特征闻名？', opts: ['大耳朵', '长毛和扁脸', '短尾', '蓝眼睛'], ans: 1 },
  { q: '边境牧羊犬以什么著称？', opts: ['体型巨大', '智商最高', '寿命最长', '毛色最亮'], ans: 1 },
  { q: '布偶猫的性格特点是什么？', opts: ['好斗', '温顺像布偶', '活泼好动', '胆小怕人'], ans: 1 },
  { q: '秋田犬原产于哪个国家？', opts: ['中国', '韩国', '日本', '美国'], ans: 2 },
  // === 有趣的动物记录 ===
  { q: '世界上最大的蜘蛛是什么？', opts: ['黑寡妇', '捕鸟蛛（格莱斯捕鸟蛛）', '蝎子', '蜈蚣'], ans: 1 },
  { q: '蜂鸟的心脏每分钟跳动多少次？', opts: ['200次', '1200次', '60次', '500次'], ans: 1 },
  { q: '大象的妊娠期大约多久？', opts: ['6个月', '22个月', '12个月', '9个月'], ans: 1 },
  { q: '变色龙舌头弹出的速度大约是？', opts: ['1米/秒', '26米/秒', '5米/秒', '0.5米/秒'], ans: 1 },
  { q: '猫的鼻纹像人类的什么特征一样独一无二？', opts: ['虹膜', '指纹', '声纹', 'DNA'], ans: 1 },
  { q: '世界上最高的犬种是？', opts: ['金毛', '大丹犬', '圣伯纳', '德牧'], ans: 1 },
  { q: '以下哪种动物睡眠时间最长？', opts: ['猫', '树懒', '考拉（每天约22小时）', '蝙蝠'], ans: 2 },
  { q: '海豚睡觉时是怎样的？', opts: ['完全静止', '半脑睡眠', '闭着眼睛漂浮', '躺在海底'], ans: 1 },
  { q: '长颈鹿的舌头是什么颜色的？', opts: ['粉色', '蓝紫色', '黑色', '白色'], ans: 1 },
  { q: '以下哪种动物能发出最响亮的声音？', opts: ['狮子', '枪虾', '鲸鱼', '大象'], ans: 1 },
  { q: '蜻蜓的复眼有多少只小眼？', opts: ['100只', '约28000只', '1000只', '10只'], ans: 1 },
  { q: '松鼠的牙齿一生都在生长，它靠什么保持长度？', opts: ['刷牙', '不断啃咬', '自然脱落', '喝牛奶'], ans: 1 }
];

// ===== 工具函数 =====
function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rollRarity(rng) {
  const total = RARITIES.reduce((s, r) => s + r.weight, 0);
  let roll = rng() * total;
  for (const r of RARITIES) {
    roll -= r.weight;
    if (roll < 0) return r;
  }
  return RARITIES[0];
}

function pick(arr, rng) {
  const randomFn = rng || Math.random;
  return arr[Math.floor(randomFn() * arr.length)];
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function randFloat(min, max) { return Math.random() * (max - min) + min; }

// 获取属性上限（根据阶段）
function getStatCap(pet) {
  const stage = pet?.stage || 1;
  if (stage >= 3) return 150;
  if (stage >= 2) return 125;
  return 100;
}

// 增加属性值（带动态上限）
function addStat(pet, stat, amount) {
  const cap = getStatCap(pet);
  pet.stats[stat] = clamp(pet.stats[stat] + amount, 0, cap);
}

// 获取属性成长倍率（峰值×1.5，低谷×0.5，普通×1.0）
function getGrowthMultiplier(pet, stat) {
  if (!pet) return 1;
  if (stat === pet.peakStat) return 1.5;
  if (stat === pet.lowStat) return 0.5;
  return 1;
}

// 小概率属性成长（默认30%概率增加 0.1~0.3）
// probability: 成长概率 (0~1)，默认 0.3
// amountMult: 成长量倍率，默认 1.0
function tryGrowStat(stat, probability, amountMult) {
  const prob = probability !== undefined ? probability : 0.3;
  const mult = amountMult !== undefined ? amountMult : 1;
  if (Math.random() < prob) {
    const pet = gameState.pet;
    if (pet) {
      const growthMult = getGrowthMultiplier(pet, stat);
      const amount = randFloat(0.1, 0.3) * growthMult * mult;
      const before = pet.stats[stat];
      addStat(pet, stat, amount);
      const after = pet.stats[stat];
      const actualGain = after - before;
      if (actualGain > 0.01) {
        showStatGain(stat, actualGain);
      }
    }
  }
}

// 显示属性提升浮动提示
function showStatGain(stat, amount) {
  const statInfo = STAT_LABELS[stat];
  if (!statInfo) return;

  // 在宠物精灵上方显示浮动文字
  const petContainer = document.querySelector('.pet-display');
  if (!petContainer) return;

  const gainEl = document.createElement('div');
  gainEl.className = 'stat-gain-popup';
  gainEl.innerHTML = `<span class="stat-gain-icon">${statInfo.icon}</span> <span class="stat-gain-text">${statInfo.name} +${amount.toFixed(1)}</span>`;
  gainEl.style.cssText = `
    position: absolute;
    left: 50%;
    top: 20%;
    transform: translateX(-50%);
    background: rgba(46, 213, 115, 0.9);
    color: white;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 14px;
    font-weight: bold;
    white-space: nowrap;
    z-index: 100;
    pointer-events: none;
    box-shadow: 0 4px 12px rgba(46, 213, 115, 0.4);
    animation: statGainFloat 1.5s ease-out forwards;
  `;
  petContainer.style.position = 'relative';
  petContainer.appendChild(gainEl);

  setTimeout(() => gainEl.remove(), 1500);

  // 同时触发宠物说话提示
  const phrases = {
    debugging: ['感觉浑身充满力量！', '活力upup！', '我变强了！'],
    patience: ['心情好平静~', '变得更温柔了呢', '内心很平和'],
    chaos: ['让我来捣乱！', '嘿嘿嘿~捣蛋成功！', '再来一次！'],
    wisdom: ['我变得更聪明了~', '知识就是力量！', '让我想想...'],
    snark: ['哼，本大爷就是这么厉害', '你才发现吗？', '也就一般般吧~']
  };
  const phraseList = phrases[stat] || ['有什么东西增长了...'];
  const phrase = phraseList[Math.floor(Math.random() * phraseList.length)];
  showSpeechCustom(phrase);
}

function generatePetId() {
  return 'pet_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

// 获取装扮的颜色filter CSS
function getHatColorFilter(pet) {
  if (!pet || !pet.equippedHatColor || pet.equippedHatColor === 'default') return '';
  const color = HAT_COLORS.find(c => c.id === pet.equippedHatColor);
  if (!color) return '';
  return color.filter || '';
}

// 获取颜色圆点的背景样式
function getColorBgStyle(colorId) {
  const colors = {
    red:    '#E17055',
    blue:   '#0984E3',
    green:  '#00B894',
    yellow: '#FDCB6E',
    purple: '#6C5CE7',
    pink:   '#FD79A8',
    black:  '#2D3436',
    white:  '#DFE6E9'
  };
  const bg = colors[colorId] || '#888';
  return `background:${bg};`;
}

// 切换装扮颜色
function changeHatColor(colorId) {
  const pet = gameState.pet;
  if (!pet || !pet.equippedHat) return;
  pet.equippedHatColor = colorId === 'default' ? null : colorId;
  renderShopItems();
  updateGameUI();
  saveGame();
  showToast(`颜色已切换为${HAT_COLORS.find(c => c.id === colorId)?.name || '默认'}`);
}

// 获取稀有度标签文字
function getRarityLabel(rarityId) {
  const labels = { common: '普通', rare: '稀有', epic: '史诗', legendary: '传说' };
  return labels[rarityId] || '普通';
}

// 获取带装扮的宠物emoji显示文本
function getPetDisplayEmoji(pet) {
  if (!pet) return '';
  const hatEmoji = pet.equippedHat ? HAT_EMOJI[pet.equippedHat] : '';
  const speciesEmoji = pet.species?.emoji || '';
  if (hatEmoji) {
    return hatEmoji + '\n' + speciesEmoji;
  }
  return speciesEmoji;
}

// ===== 宠物生成 =====
function generatePetBones(userId) {
  const salt = 'pocket-buddy-2026';
  const seed = hashString(userId + salt);
  const rng = mulberry32(seed);

  const rarity = rollRarity(rng);
  // 初始宠物只能是一阶段物种，不能越阶出现
  const stage1Species = SPECIES_LIST.filter(s => s.stage === 1);
  const species = pick(stage1Species, rng);
  const shiny = rng() < 0.01;

  // 帽子：初始宠物不带装扮，需在商店购买
  const hat = 'none';

  // 五维属性
  const stats = {};
  const peakStat = pick(STAT_NAMES, rng);
  const lowStat = pick(STAT_NAMES.filter(s => s !== peakStat), rng);

  STAT_NAMES.forEach(stat => {
    let val;
    if (stat === peakStat) {
      val = rarity.statMin + 50 + Math.floor(rng() * 30);
    } else if (stat === lowStat) {
      val = Math.max(1, rarity.statMin - 10 + Math.floor(rng() * 15));
    } else {
      val = rarity.statMin + Math.floor(rng() * 40);
    }
    stats[stat] = clamp(val, 1, 100);
  });

  return { species, rarity, shiny, hat, stats, peakStat, lowStat };
}

function generatePetGender(rng) {
  return (rng || Math.random)() < 0.5 ? 'male' : 'female';
}

function getGenderSymbol(gender) {
  return gender === 'male' ? '♂' : gender === 'female' ? '♀' : '';
}

function generatePetSoul(rng) {
  const names = ['小团子','豆豆','球球','棉花糖','布丁','年糕','糯米','芝麻','汤圆','饭团',
                 '可乐','奶茶','咖啡','抹茶','芒果','草莓','蓝莓','樱桃','西瓜','蜜桃',
                 '星星','月亮','太阳','云朵','彩虹','雪花','闪电','微风','露珠','花瓣'];
  return {
    name: pick(names, rng || Math.random),
    personality: pick(PERSONALITIES, rng || Math.random)
  };
}

// ===== 段位配置 =====
const RANKS = [
  { id: 'tap_water',  name: '自来水', icon: '🚰', minPoints: 0,    maxPoints: 50 },
  { id: 'raw_egg',    name: '生鸡蛋', icon: '🥚', minPoints: 50,   maxPoints: 120 },
  { id: 'potato',     name: '土豆',   icon: '🥔', minPoints: 120,  maxPoints: 220 },
  { id: 'steamed_bun',name: '白馒头', icon: '🍞', minPoints: 220,  maxPoints: 350 },
  { id: 'rice',       name: '白米饭', icon: '🍚', minPoints: 350,  maxPoints: 500 },
  { id: 'ramen',      name: '拉面',   icon: '🍜', minPoints: 500,  maxPoints: 700 },
  { id: 'fried_egg',  name: '荷包蛋', icon: '🍳', minPoints: 700,  maxPoints: 900 },
  { id: 'curry',      name: '咖喱饭', icon: '🍛', minPoints: 900,  maxPoints: 1150 },
  { id: 'char_siu',   name: '叉烧',   icon: '🍖', minPoints: 1150, maxPoints: 1400 },
  { id: 'pudding',    name: '焦糖布丁',icon: '🍮', minPoints: 1400, maxPoints: 1700 },
  { id: 'cake',       name: '草莓蛋糕',icon:'🍰', minPoints: 1700, maxPoints: 2050 },
  { id: 'chocolate',  name: '巧克力', icon: '🍫', minPoints: 2050, maxPoints: 2500 },
  { id: 'rainbow',    name: '彩虹',   icon: '🌈', minPoints: 2500, maxPoints: 999999 }
];

// ===== 进化路线配置 =====
const EVOLUTION_TREE = {
  duck:     [{ to: 'goose',    level: 10, cost: 200, statReq: { patience: 40 }, name: '大白鹅' }],
  cat:      [{ to: 'chonk',    level: 12, cost: 300, statReq: { snark: 50 },    name: '胖猫' }],
  blob:     [{ to: 'ghost',    level: 8,  cost: 150, statReq: { chaos: 40 },    name: '幽灵' }],
  turtle:   [{ to: 'dragon',   level: 15, cost: 500, statReq: { wisdom: 60 },   name: '龙' }],
  snail:    [{ to: 'octopus',  level: 10, cost: 250, statReq: { wisdom: 45 },   name: '章鱼' }],
  rabbit:   [{ to: 'capybara', level: 10, cost: 200, statReq: { patience: 50 }, name: '水豚' }],
  mushroom: [{ to: 'cactus',   level: 8,  cost: 180, statReq: { chaos: 35 },    name: '仙人掌' }],
  owl:      [{ to: 'robot',    level: 12, cost: 350, statReq: { debugging: 55 },name: '机器人' }],
  penguin:  [{ to: 'axolotl',  level: 10, cost: 220, statReq: { patience: 45 }, name: '六角恐龙' }],
  ghost:    [{ to: 'dragon',   level: 15, cost: 600, statReq: { chaos: 60, wisdom: 50 }, name: '龙' }]
};

// ===== 头衔配置（前缀/后缀） =====
// 前缀和后缀通过成就解锁，可在改名时选择
const TITLE_PREFIXES = {
  // 养成类前缀（偶数位置：0,2,4,6）
  'p_adorable':   { text: '可爱的',   source: 'first_feed' },
  'p_playful':    { text: '爱玩的',   source: 'play_master' },
  'p_growing':    { text: '成长中的', source: 'level_10' },
  'p_gentle':     { text: '温柔的',   source: 'pet_master' },
  // 对战类前缀（偶数位置：0,2,4,6）
  'p_brave':      { text: '勇敢的',   source: 'first_battle' },
  'p_flame':      { text: '烈焰的',   source: 'win_streak_5' },
  'p_golden':     { text: '土豆',     source: 'rank_gold' },
  'p_dark':       { text: '黑暗的',   source: 'close_win_master' },
  // 收集类前缀（偶数位置：0,2,4）
  'p_collector':  { text: '收藏的',   source: 'collector_5' },
  'p_omniscient': { text: '全知的',   source: 'collector_all' },
  'p_rainbow':    { text: '彩虹的',   source: 'shiny_collector_3' },
  // 特殊类前缀（偶数位置：0,2,4,6）
  'p_parent':     { text: '新手爸妈', source: 'first_breed' },
  'p_wealthy':    { text: '富有的',   source: 'rich' },
  'p_gamer':      { text: '游戏宅',   source: 'game_master' },
  'p_sage':       { text: '贤者',     source: 'evolve_master' },
  // 新增成就前缀
  'p_healer':     { text: '治愈的',   source: 'heal_master' },
  'p_hoarder':    { text: '守财的',   source: 'coin_hoarder' },
  'p_evolved2':   { text: '再进化',   source: 'evolution_3' },
  'p_social':     { text: '交际的',   source: 'diverse_friends' },
  'p_feeder':     { text: '喂养的',   source: 'feed_500' },
  'p_allround':   { text: '全能的',   source: 'all_rounder' },
  // 隐藏头衔前缀
  'p_forgotten': { text: '被遗忘的', source: 'hidden_neglect', hidden: true },
  'p_lonely':    { text: '孤独的',   source: 'hidden_lonely', hidden: true },
  'p_midnight':  { text: '午夜的',   source: 'hidden_midnight', hidden: true },
  'p_broke':     { text: '破产的',   source: 'hidden_broke', hidden: true },
  'p_stinky':    { text: '腐败的',   source: 'hidden_stinky', hidden: true },
  // 极难隐藏头衔前缀
  'p_dedicated':   { text: '坚持的', source: 'hidden_dedicated', hidden: true },
  'p_losestreak':  { text: '不屈的', source: 'hidden_losestreak', hidden: true },
  'p_glutton':     { text: '贪吃的', source: 'hidden_glutton', hidden: true },
  'p_dreamer':     { text: '追梦的', source: 'hidden_dreamer', hidden: true },
  // 小游戏隐藏头衔
  'p_catchmaster': { text: '接物达人', source: 'hidden_catch_master', hidden: true },
  'p_gomokugenius': { text: '棋圣', source: 'hidden_gomoku_genius', hidden: true },
  'p_quizfail':    { text: '学渣', source: 'hidden_quiz_fail', hidden: true },
};

const TITLE_SUFFIXES = {
  // 养成类后缀（奇数位置：1,3,5,7）
  's_foodie':     { text: '美食家',   source: 'feed_master' },
  's_cleaner':    { text: '洁癖',     source: 'clean_freak' },
  's_master':     { text: '大师',     source: 'level_20' },
  's_sleeper':    { text: '睡神',     source: 'sleep_master' },
  // 对战类后缀（奇数位置：1,3,5,7）
  's_veteran':    { text: '老兵',     source: 'battle_veteran' },
  's_storm':      { text: '风暴',     source: 'win_streak_10' },
  's_legend':     { text: '拉面',     source: 'rank_master' },
  's_god':        { text: '之神',     source: 'win_streak_20' },
  // 收集类后缀（奇数位置：1,3）
  's_scholar':    { text: '学者',     source: 'collector_10' },
  's_shiny':      { text: '闪光',     source: 'shiny_hunter' },
  // 特殊类后缀（奇数位置：1,3,5）
  's_evo':        { text: '进化体',   source: 'first_evolve' },
  's_millionaire':{ text: '富翁',     source: 'millionaire' },
  's_breeder':    { text: '繁殖家',   source: 'breed_master' },
  // 新增成就后缀
  's_perfect':    { text: '完美体',   source: 'perfect_pet' },
  's_speed':      { text: '速成者',   source: 'speed_runner' },
  's_hero':       { text: '英雄',     source: 'battle_100' },
  's_clean':      { text: '清洁者',   source: 'clean_200' },
  // 隐藏头衔后缀
  's_forgotten': { text: '遗弃者', source: 'hidden_neglect', hidden: true },
  's_insomniac': { text: '失眠者', source: 'hidden_insomniac', hidden: true },
  's_greedy':    { text: '贪心鬼', source: 'hidden_greedy', hidden: true },
  's_unlucky':   { text: '倒霉蛋', source: 'hidden_unlucky', hidden: true },
  's_nightowl':  { text: '夜猫子', source: 'hidden_nightowl', hidden: true },
  // 极难隐藏头衔后缀
  's_dedicated':   { text: '坚守者', source: 'hidden_dedicated', hidden: true },
  's_losestreak':  { text: '永不服输', source: 'hidden_losestreak', hidden: true },
  's_glutton':     { text: '吃货', source: 'hidden_glutton', hidden: true },
  's_dreamer':     { text: '梦想家', source: 'hidden_dreamer', hidden: true },
  's_catchmaster': { text: '黄金之手', source: 'hidden_catch_master', hidden: true },
  's_gomokugenius': { text: '五子之神', source: 'hidden_gomoku_genius', hidden: true },
  's_quizfail':    { text: '答题之王', source: 'hidden_quiz_fail', hidden: true },
};

// 获取已解锁的前缀列表
function getUnlockedPrefixes() {
  const unlocked = [];
  for (const [id, prefix] of Object.entries(TITLE_PREFIXES)) {
    if (gameState.achievements.unlocked.includes(prefix.source)) {
      unlocked.push({ id, text: prefix.text });
    }
  }
  return unlocked;
}

// 获取已解锁的后缀列表
function getUnlockedSuffixes() {
  const unlocked = [];
  for (const [id, suffix] of Object.entries(TITLE_SUFFIXES)) {
    if (gameState.achievements.unlocked.includes(suffix.source)) {
      unlocked.push({ id, text: suffix.text });
    }
  }
  return unlocked;
}

// 获取宠物的完整显示名称
// 自适应字号：根据文字长度调整元素字号，确保不溢出
function fitText(el, maxWidth, maxFontSize, minFontSize) {
  if (!el) return;
  maxFontSize = maxFontSize || 18;
  minFontSize = minFontSize || 10;
  maxWidth = maxWidth || 180;
  let fontSize = maxFontSize;
  el.style.fontSize = fontSize + 'px';
  // 简单估算：每个中文字符约1.1em宽，每个英文字符约0.6em宽
  const text = el.textContent || '';
  let estimatedWidth = 0;
  for (const ch of text) {
    estimatedWidth += (ch.charCodeAt(0) > 127) ? fontSize * 1.05 : fontSize * 0.55;
  }
  if (estimatedWidth > maxWidth) {
    fontSize = Math.max(minFontSize, Math.floor(maxWidth / (estimatedWidth / fontSize)));
    el.style.fontSize = fontSize + 'px';
  }
}

function getPetDisplayName(pet) {
  if (!pet) return '';
  const prefix = pet.titlePrefix ? TITLE_PREFIXES[pet.titlePrefix]?.text || '' : '';
  const suffix = pet.titleSuffix ? TITLE_SUFFIXES[pet.titleSuffix]?.text || '' : '';
  const name = pet.name || '';
  let fullName = '';
  if (prefix) fullName += prefix + ' ';
  fullName += name;
  if (suffix) fullName += ' ' + suffix;
  return fullName;
}

// ===== 成就配置 =====
const ACHIEVEMENTS = [
  // 养成类
  { id: 'first_feed',      name: '初次喂食',   desc: '第一次喂食宠物',         icon: '🍖', category: 'care',   reward: 20,  check: s => s.records.totalFeeds >= 1 },
  { id: 'feed_master',     name: '喂食大师',   desc: '累计喂食 100 次',        icon: '🍰', category: 'care',   reward: 100, check: s => s.records.totalFeeds >= 100 },
  { id: 'play_master',     name: '玩耍达人',   desc: '累计玩耍 50 次',         icon: '🎾', category: 'care',   reward: 80,  check: s => s.records.totalPlays >= 50 },
  { id: 'clean_freak',     name: '洁癖狂魔',   desc: '累计清洁 50 次',         icon: '✨', category: 'care',   reward: 80,  check: s => s.records.totalCleans >= 50 },
  { id: 'level_10',        name: '茁壮成长',   desc: '宠物达到 10 级',         icon: '⭐', category: 'care',   reward: 150, check: s => s.pet && s.pet.level >= 10 },
  { id: 'level_20',        name: '宠物精英',   desc: '宠物达到 20 级',         icon: '🌟', category: 'care',   reward: 300, check: s => s.pet && s.pet.level >= 20 },
  { id: 'pet_master',      name: '抚摸达人',   desc: '累计抚摸 100 次',        icon: '🤲', category: 'care',   reward: 80,  check: s => s.records.totalPets >= 100 },
  { id: 'sleep_master',    name: '睡神',       desc: '累计睡眠 50 次',         icon: '😴', category: 'care',   reward: 60,  check: s => s.records.totalSleeps >= 50 },
  // 对战类
  { id: 'first_battle',    name: '初入战场',   desc: '完成第一场对战',         icon: '⚔️', category: 'battle', reward: 30,  check: s => s.battleStats && s.battleStats.total >= 1 },
  { id: 'battle_veteran',  name: '百战老兵',   desc: '累计对战 50 场',         icon: '🛡️', category: 'battle', reward: 200, check: s => s.battleStats && s.battleStats.total >= 50 },
  { id: 'win_streak_5',    name: '五连胜',     desc: '取得 5 连胜',            icon: '🔥', category: 'battle', reward: 150, check: s => s.battleStats && s.battleStats.maxStreak >= 5 },
  { id: 'win_streak_10',   name: '十连胜',     desc: '取得 10 连胜',           icon: '💥', category: 'battle', reward: 300, check: s => s.battleStats && s.battleStats.maxStreak >= 10 },
  { id: 'win_streak_20',   name: '二十连胜',   desc: '取得 20 连胜',           icon: '⚡', category: 'battle', reward: 500, check: s => s.battleStats && s.battleStats.maxStreak >= 20 },
  { id: 'rank_gold',       name: '土豆段位',   desc: '段位达到土豆',           icon: '🥔', category: 'battle', reward: 250, check: s => s.battleStats && getRankIndex(s.battleStats.rank) >= 2 },
  { id: 'rank_master',     name: '拉面段位',   desc: '段位达到拉面',           icon: '🍜', category: 'battle', reward: 500, check: s => s.battleStats && getRankIndex(s.battleStats.rank) >= 5 },
  { id: 'close_win_master',name: '险胜专家',   desc: '累计险胜 10 次',         icon: '😅', category: 'battle', reward: 200, check: s => s.battleStats && s.battleStats.closeWins >= 10 },
  // 收集类
  { id: 'collector_5',     name: '初级收藏家', desc: '图鉴收集 5 种',          icon: '📖', category: 'collect',reward: 80,  check: s => s.album.length >= 5 },
  { id: 'collector_10',    name: '中级收藏家', desc: '图鉴收集 10 种',         icon: '📚', category: 'collect',reward: 200, check: s => s.album.length >= 10 },
  { id: 'collector_all',   name: '全图鉴',     desc: '收集全部物种',           icon: '🏅', category: 'collect',reward: 500, check: s => s.album.length >= SPECIES_LIST.length },
  { id: 'shiny_hunter',    name: '闪光猎人',   desc: '拥有一只闪光宠物',       icon: '✨', category: 'collect',reward: 200, check: s => s.petCollection && s.petCollection.some(p => p.shiny) },
  { id: 'shiny_collector_3',name:'闪光收藏家', desc: '拥有 3 只闪光宠物',      icon: '🌈', category: 'collect',reward: 400, check: s => s.petCollection && s.petCollection.filter(p => p.shiny).length >= 3 },
  // 特殊类
  { id: 'first_breed',     name: '繁衍后代',   desc: '第一次繁殖宠物',         icon: '🥚', category: 'special',reward: 100, check: s => s.records && s.records.totalBreeds >= 1 },
  { id: 'first_evolve',    name: '进化之光',   desc: '第一次进化宠物',         icon: '🌟', category: 'special',reward: 150, check: s => s.records && s.records.totalEvolves >= 1 },
  { id: 'rich',            name: '小富翁',     desc: '累计获得 1000 金币',     icon: '💰', category: 'special',reward: 100, check: s => s.records.totalCoinsEarned >= 1000 },
  { id: 'millionaire',     name: '百万富翁',   desc: '累计获得 10000 金币',    icon: '💎', category: 'special',reward: 500, check: s => s.records.totalCoinsEarned >= 10000 },
  { id: 'game_master',     name: '游戏大师',   desc: '迷你游戏游玩 30 次',     icon: '🎮', category: 'special',reward: 150, check: s => s.records.totalGamesPlayed >= 30 },
  { id: 'breed_master',    name: '繁殖专家',   desc: '累计繁殖 10 次',         icon: '🐣', category: 'special',reward: 300, check: s => s.records && s.records.totalBreeds >= 10 },
  { id: 'evolve_master',   name: '进化大师',   desc: '累计进化 5 次',          icon: '🧬', category: 'special',reward: 400, check: s => s.records && s.records.totalEvolves >= 5 },
  // 新增成就
  { id: 'heal_master',     name: '神医',       desc: '累计治疗 30 次',         icon: '💊', category: 'care',   reward: 80,  check: s => s.records.totalHeals >= 30 },
  { id: 'coin_hoarder',    name: '守财奴',     desc: '同时拥有 3000 金币',    icon: '🏦', category: 'special',reward: 200, check: s => s.coins >= 3000 },
  { id: 'perfect_pet',     name: '完美状态',   desc: '五维全满（各达到100）',   icon: '👑', category: 'care',   reward: 500, check: s => s.pet && STAT_NAMES.every(st => s.pet.stats[st] >= 100) },
  { id: 'speed_runner',    name: '速成大师',   desc: '7天内达到20级',          icon: '⏱️', category: 'special',reward: 300, check: s => s.pet && s.pet.level >= 20 && s.pet.createdAt && (Date.now() - new Date(s.pet.createdAt).getTime()) < 7*86400000 },
  { id: 'evolution_3',     name: '进化之路',   desc: '同一只宠物进化3次',      icon: '🧬', category: 'special',reward: 400, check: s => s.records.totalEvolves >= 3 },
  { id: 'diverse_friends', name: '交际花',     desc: '图鉴收集 15 种',         icon: '🤝', category: 'collect',reward: 300, check: s => s.album.length >= 15 },
  { id: 'battle_100',      name: '百战英雄',   desc: '累计对战 100 场',        icon: '🎖️', category: 'battle', reward: 300, check: s => s.battleStats && s.battleStats.total >= 100 },
  { id: 'feed_500',        name: '喂养狂人',   desc: '累计喂食 500 次',        icon: '🍖', category: 'care',   reward: 200, check: s => s.records.totalFeeds >= 500 },
  { id: 'clean_200',       name: '清洁大师',   desc: '累计清洁 200 次',        icon: '🧹', category: 'care',   reward: 150, check: s => s.records.totalCleans >= 200 },
  { id: 'all_rounder',     name: '全能选手',   desc: '五项养成操作各超过50次', icon: '🏅', category: 'care',   reward: 400, check: s => s.records.totalFeeds >= 50 && s.records.totalPlays >= 50 && s.records.totalCleans >= 50 && s.records.totalPets >= 50 && s.records.totalSleeps >= 50 }
];

// ===== 每日任务模板 =====
const DAILY_TASK_TEMPLATES = [
  { id: 'feed_3',    name: '喂食 3 次',     type: 'feed',    target: 3,  reward: 30 },
  { id: 'feed_5',    name: '喂食 5 次',     type: 'feed',    target: 5,  reward: 50 },
  { id: 'play_2',    name: '玩耍 2 次',     type: 'play',    target: 2,  reward: 30 },
  { id: 'play_3',    name: '玩耍 3 次',     type: 'play',    target: 3,  reward: 50 },
  { id: 'clean_2',   name: '清洁 2 次',     type: 'clean',   target: 2,  reward: 30 },
  { id: 'battle_win',name: '赢得 1 场对战', type: 'battleWin', target: 1, reward: 50 },
  { id: 'battle_2',  name: '完成 2 场对战', type: 'battle',  target: 2,  reward: 40 },
  { id: 'game_1',    name: '玩 1 次小游戏', type: 'game',    target: 1,  reward: 30 },
  { id: 'pet_5',     name: '抚摸 5 次',     type: 'pet',     target: 5,  reward: 20 },
  { id: 'heal_1',    name: '治疗 1 次',     type: 'heal',    target: 1,  reward: 30 }
];

// ===== 物种特殊技能 =====
const SPECIES_SKILLS = {
  duck:    { name: '水之波动', desc: '造成额外伤害并恢复少量HP', effect: (dmg, self) => ({ dmg: dmg * 1.2, heal: 5 }) },
  goose:   { name: '俯冲攻击', desc: '高伤害一击',              effect: (dmg) => ({ dmg: dmg * 1.5 }) },
  blob:    { name: '分裂',     desc: '恢复自身HP',              effect: (dmg, self) => ({ dmg, heal: self.maxHp * 0.1 }) },
  cat:     { name: '九命',     desc: '低血量时暴击率大幅提升',   effect: (dmg, self) => self.hp < self.maxHp * 0.3 ? { critBonus: 0.2, dmg } : { dmg } },
  dragon:  { name: '龙息',     desc: '造成大量伤害',            effect: (dmg) => ({ dmg: dmg * 1.8 }) },
  octopus: { name: '墨汁喷射', desc: '降低对手闪避',            effect: (dmg) => ({ dmg, dodgeReduce: 0.1 }) },
  owl:     { name: '洞察',     desc: '必定命中且暴击',          effect: (dmg) => ({ dmg: dmg * 1.3, guaranteed: true, critBonus: 0.2 }) },
  penguin: { name: '冰冻',     desc: '有几率使对手下回合无法攻击',effect: (dmg) => ({ dmg, freezeChance: 0.25 }) },
  turtle:  { name: '龟壳防御', desc: '本回合防御大幅提升',      effect: (dmg) => ({ dmg, defenseBoost: 0.5 }) },
  snail:   { name: '缓慢侵蚀', desc: '持续伤害效果',            effect: (dmg) => ({ dmg, dot: dmg * 0.2, dotTurns: 3 }) },
  ghost:   { name: '幽灵形态', desc: '高概率闪避下一次攻击',    effect: (dmg) => ({ dmg, dodgeBoost: 0.3 }) },
  axolotl: { name: '再生',     desc: '恢复大量HP',              effect: (dmg, self) => ({ dmg, heal: self.maxHp * 0.15 }) },
  capybara:{ name: '治愈光环', desc: '恢复HP并提升防御',        effect: (dmg, self) => ({ dmg, heal: 8, defenseBoost: 0.2 }) },
  cactus:  { name: '尖刺反伤', desc: '反弹部分伤害',            effect: (dmg) => ({ dmg, reflect: 0.2 }) },
  robot:   { name: '过载',     desc: '造成巨额伤害但自身掉血',   effect: (dmg, self) => ({ dmg: dmg * 2, selfDamage: self.maxHp * 0.08 }) },
  rabbit:  { name: '疾风连击', desc: '攻击两次',                effect: (dmg) => ({ dmg, doubleStrike: true }) },
  mushroom:{ name: '孢子',     desc: '降低对手攻击力',          effect: (dmg) => ({ dmg, atkReduce: 0.15, atkReduceTurns: 2 }) },
  chonk:   { name: '胖猫压顶', desc: '造成大量伤害',            effect: (dmg) => ({ dmg: dmg * 1.6 }) }
};

// ===== 技能树配置（按五维属性分组，每组20个技能，序号0-19） =====
const SKILL_TREE_GROUPS = {
  // ----- 活力(debugging)技能组 -----
  // 特点：分支A偏重攻击和暴击，分支B偏重养成效率和金币
  debugging: [
    null,
    { branchA: { id:'db_1a', name:'⚡力量觉醒', desc:'攻击力+8%', type:'passive', branch:'A', level:1, passiveEffect:{atkBonus:0.08} },
      branchB: { id:'db_1b', name:'⚡治愈之手', desc:'治疗效果+15%+攻击+3%', type:'passive', branch:'B', level:1, passiveEffect:{healBonus:0.15, atkBonus:0.03} } },
    { branchA: { id:'db_2a', name:'⚡精准打击', desc:'暴击率+3%+吸血1%', type:'passive', branch:'A', level:2, passiveEffect:{critBonus:0.03, lifeSteal:0.01} },
      branchB: { id:'db_2b', name:'⚡快速恢复', desc:'睡觉体力恢复+20%+攻击+3%', type:'passive', branch:'B', level:2, passiveEffect:{sleepEnergyBonus:0.20, atkBonus:0.03} } },
    { branchA: { id:'db_3a', name:'⚡铁拳', desc:'攻击力+6%', type:'passive', branch:'A', level:3, passiveEffect:{atkBonus:0.06} },
      branchB: { id:'db_3b', name:'⚡治愈之心', desc:'每回合恢复2%HP+攻击+3%', type:'passive', branch:'B', level:3, passiveEffect:{hpRegenPercent:0.02, atkBonus:0.03} } },
    { branchA: { id:'db_4a', name:'⚡无视防御', desc:'无视6%防御', type:'passive', branch:'A', level:4, passiveEffect:{ignoreDefense:0.06} },
      branchB: { id:'db_4b', name:'⚡生命汲取', desc:'造成伤害2%回血+攻击+3%', type:'passive', branch:'B', level:4, passiveEffect:{lifeSteal:0.02, atkBonus:0.03} } },
    { active: { id:'db_5', name:'⚡⚡雷霆一击', desc:'1.5倍伤害攻击', type:'active', level:5, battleEffect:{dmgMult:1.5, triggerChance:0.22} } },
    { branchA: { id:'db_6a', name:'⚡锐利目光', desc:'暴击率+4%+吸血1%', type:'passive', branch:'A', level:6, passiveEffect:{critBonus:0.04, lifeSteal:0.01}  },
      branchB: { id:'db_6b', name:'⚡恢复之力', desc:'治疗效果+20%+暴击+2%', type:'passive', branch:'B', level:6, passiveEffect:{healBonus:0.20, critBonus:0.02} } },
    { branchA: { id:'db_7a', name:'⚡力量涌动', desc:'攻击力+10%', type:'passive', branch:'A', level:7, passiveEffect:{atkBonus:0.10} },
      branchB: { id:'db_7b', name:'⚡治愈之光', desc:'每回合恢复3%HP+攻击+3%', type:'passive', branch:'B', level:7, passiveEffect:{hpRegenPercent:0.03, atkBonus:0.03} } },
    { branchA: { id:'db_8a', name:'⚡暴击强化', desc:'暴击伤害+12%', type:'passive', branch:'A', level:8, passiveEffect:{critDmgBonus:0.12} },
      branchB: { id:'db_8b', name:'⚡生命汲取II', desc:'造成伤害3%回血+攻击+3%', type:'passive', branch:'B', level:8, passiveEffect:{lifeSteal:0.03, atkBonus:0.03} } },
    { branchA: { id:'db_9a', name:'⚡穿透攻击', desc:'无视10%防御', type:'passive', branch:'A', level:9, passiveEffect:{ignoreDefense:0.10} },
      branchB: { id:'db_9b', name:'⚡强力治疗', desc:'治疗效果+25%+暴击+2%', type:'passive', branch:'B', level:9, passiveEffect:{healBonus:0.25, critBonus:0.02} } },
    { active: { id:'db_10', name:'⚡⚡⚡狂暴冲击', desc:'1.7倍伤害+6%暴击', type:'active', level:10, battleEffect:{dmgMult:1.7, critBonus:0.06, triggerChance:0.18} } },
    { branchA: { id:'db_11a', name:'⚡战斗狂人', desc:'攻击力+14%', type:'passive', branch:'A', level:11, passiveEffect:{atkBonus:0.14} },
      branchB: { id:'db_11b', name:'⚡恢复专家', desc:'每回合恢复4%HP+攻击+3%', type:'passive', branch:'B', level:11, passiveEffect:{hpRegenPercent:0.04, atkBonus:0.03} } },
    { branchA: { id:'db_12a', name:'⚡铁壁突破', desc:'无视14%防御', type:'passive', branch:'A', level:12, passiveEffect:{ignoreDefense:0.14} },
      branchB: { id:'db_12b', name:'⚡治愈光环', desc:'治疗效果+30%+攻击+3%', type:'passive', branch:'B', level:12, passiveEffect:{healBonus:0.30, atkBonus:0.03} } },
    { branchA: { id:'db_13a', name:'⚡暴击大师', desc:'暴击率+5%', type:'passive', branch:'A', level:13, passiveEffect:{critBonus:0.05} },
      branchB: { id:'db_13b', name:'⚡生命汲取III', desc:'造成伤害4%回血+暴击+2%', type:'passive', branch:'B', level:13, passiveEffect:{lifeSteal:0.04, critBonus:0.02} } },
    { branchA: { id:'db_14a', name:'⚡暴击伤害x1.7', desc:'暴击伤害x1.7', type:'passive', branch:'A', level:14, passiveEffect:{critDmgMult:1.7} },
      branchB: { id:'db_14b', name:'⚡自愈体质', desc:'每回合恢复5%HP+攻击+3%', type:'passive', branch:'B', level:14, passiveEffect:{hpRegenPercent:0.05, atkBonus:0.03} } },
    { active: { id:'db_15', name:'⚡⚡⚡⚡雷霆风暴', desc:'1.9倍伤害+吸血15%', type:'active', level:15, battleEffect:{dmgMult:1.9, healPercent:0.15, triggerChance:0.15} } },
    { branchA: { id:'db_16a', name:'⚡终极铁拳', desc:'攻击力+18%', type:'passive', branch:'A', level:16, passiveEffect:{atkBonus:0.18} },
      branchB: { id:'db_16b', name:'⚡神速恢复', desc:'治疗效果+35%+暴击+2%', type:'passive', branch:'B', level:16, passiveEffect:{healBonus:0.35, critBonus:0.02} } },
    { branchA: { id:'db_17a', name:'⚡无坚不摧', desc:'无视20%防御', type:'passive', branch:'A', level:17, passiveEffect:{ignoreDefense:0.20} },
      branchB: { id:'db_17b', name:'⚡不朽生命', desc:'每回合恢复6%HP+攻击+3%', type:'passive', branch:'B', level:17, passiveEffect:{hpRegenPercent:0.06, atkBonus:0.03} } },
    { branchA: { id:'db_18a', name:'⚡战意高昂', desc:'HP>50%攻击+15%', type:'passive', branch:'A', level:18, passiveEffect:{highHpAtk:{threshold:0.50,mult:0.15}} },
      branchB: { id:'db_18b', name:'⚡生命汲取IV', desc:'造成伤害5%回血+攻击+3%', type:'passive', branch:'B', level:18, passiveEffect:{lifeSteal:0.05, atkBonus:0.03} } },
    { branchA: { id:'db_19a', name:'⚡暴击率+6%', desc:'暴击率+6%', type:'passive', branch:'A', level:19, passiveEffect:{critBonus:0.06} },
      branchB: { id:'db_19b', name:'⚡治愈大师', desc:'治疗效果+40%+暴击+2%', type:'passive', branch:'B', level:19, passiveEffect:{healBonus:0.40, critBonus:0.02} } },
    { active: { id:'db_20', name:'⚡⚡⚡⚡⚡毁灭打击', desc:'2.0倍伤害', type:'active', level:20, battleEffect:{dmgMult:2.0, triggerChance:0.12} } },
    { branchA: { id:'db_21a', name:'⚡伤害反弹', desc:'反弹8%伤害', type:'passive', branch:'A', level:21, passiveEffect:{reflect:0.08} },
      branchB: { id:'db_21b', name:'⚡每回合+5%HP', desc:'每回合恢复5%HP+攻击+3%', type:'passive', branch:'B', level:21, passiveEffect:{hpRegenPercent:0.05, atkBonus:0.03} } },
    { branchA: { id:'db_22a', name:'⚡暴击终极', desc:'暴击伤害x2.0', type:'passive', branch:'A', level:22, passiveEffect:{critDmgMult:2.0} },
      branchB: { id:'db_22b', name:'⚡生命汲取V', desc:'造成伤害6%回血+暴击+2%', type:'passive', branch:'B', level:22, passiveEffect:{lifeSteal:0.06, critBonus:0.02} } },
    { branchA: { id:'db_23a', name:'⚡全攻击+15%', desc:'攻击力+15%', type:'passive', branch:'A', level:23, passiveEffect:{atkBonus:0.15} },
      branchB: { id:'db_23b', name:'⚡不死之身', desc:'免死一次+攻击+3%', type:'passive', branch:'B', level:23, passiveEffect:{undying:true, atkBonus:0.03} } },
    { branchA: { id:'db_24a', name:'⚡无视25%防御', desc:'无视25%防御', type:'passive', branch:'A', level:24, passiveEffect:{ignoreDefense:0.25} },
      branchB: { id:'db_24b', name:'⚡每回合+6%HP', desc:'每回合恢复6%HP+攻击+3%', type:'passive', branch:'B', level:24, passiveEffect:{hpRegenPercent:0.06, atkBonus:0.03} } },
    { active: { id:'db_25', name:'⚡⚡⚡⚡⚡⚡终极雷霆', desc:'2.2倍伤害+吸血20%', type:'active', level:25, battleEffect:{dmgMult:2.2, healPercent:0.20, triggerChance:0.10} } },
    { branchA: { id:'db_26a', name:'⚡战神之力', desc:'攻击力+20%', type:'passive', branch:'A', level:26, passiveEffect:{atkBonus:0.20} },
      branchB: { id:'db_26b', name:'⚡生命汲取VI', desc:'造成伤害7%回血+攻击+3%', type:'passive', branch:'B', level:26, passiveEffect:{lifeSteal:0.07, atkBonus:0.03} } },
    { branchA: { id:'db_27a', name:'⚡无尽怒火', desc:'HP<30%暴击+12%', type:'passive', branch:'A', level:27, passiveEffect:{lowHpCrit:{threshold:0.30,critBonus:0.12}} },
      branchB: { id:'db_27b', name:'⚡每回合+7%HP', desc:'每回合恢复7%HP+暴击+3%', type:'passive', branch:'B', level:27, passiveEffect:{hpRegenPercent:0.07, critBonus:0.03} } },
    { branchA: { id:'db_28a', name:'⚡暴击伤害x2.2', desc:'暴击伤害x2.2', type:'passive', branch:'A', level:28, passiveEffect:{critDmgMult:2.2} },
      branchB: { id:'db_28b', name:'⚡治愈之王', desc:'治疗效果+50%+攻击+3%', type:'passive', branch:'B', level:28, passiveEffect:{healBonus:0.50, atkBonus:0.03} } },
    { branchA: { id:'db_29a', name:'⚡伤害减免', desc:'受到伤害-12%', type:'passive', branch:'A', level:29, passiveEffect:{damageReduce:0.12} },
      branchB: { id:'db_29b', name:'⚡不死之心', desc:'免死一次+每回合+4%HP', type:'passive', branch:'B', level:29, passiveEffect:{undying:true, hpRegenPercent:0.04} } },
    { active: { id:'db_30', name:'⚡⚡⚡⚡⚡⚡⚡雷霆神罚', desc:'2.4倍伤害+吸血20%', type:'active', level:30, battleEffect:{dmgMult:2.4, healPercent:0.20, triggerChance:0.08} } },
  ],

  // ----- 温柔(patience)技能组 -----
  // 特点：分支A偏重防御和回复，分支B偏重养成稳定性和状态保持
  patience: [
    null,
    { branchA: { id:'pt_1a', name:'🌸坚韧之体', desc:'最大HP+6%+金币+5%', type:'passive', branch:'A', level:1, passiveEffect:{maxHpBonus:0.06, gameCoinBonus:0.05} },
      branchB: { id:'pt_1b', name:'🌸不急不躁', desc:'离线衰减-15%+防御+3%', type:'passive', branch:'B', level:1, passiveEffect:{decayReduce:0.15, defBonus:0.03} } },
    { branchA: { id:'pt_2a', name:'🌸自然护盾', desc:'防御+8%+金币+5%', type:'passive', branch:'A', level:2, passiveEffect:{defBonus:0.08, gameCoinBonus:0.05} },
      branchB: { id:'pt_2b', name:'🌸安心守护', desc:'健康下限提高10+闪避+3%', type:'passive', branch:'B', level:2, passiveEffect:{minHealthBonus:10, dodgeBonus:0.03} } },
    { branchA: { id:'pt_3a', name:'🌸生命回复', desc:'每回合恢复2%HP+金币+5%', type:'passive', branch:'A', level:3, passiveEffect:{hpRegenPercent:0.02, gameCoinBonus:0.05} },
      branchB: { id:'pt_3b', name:'🌸清洁如新', desc:'离线衰减-20%+防御+3%', type:'passive', branch:'B', level:3, passiveEffect:{decayReduce:0.20, defBonus:0.03} } },
    { branchA: { id:'pt_4a', name:'🌸柔韧身法', desc:'闪避+5%+经验+5%', type:'passive', branch:'A', level:4, passiveEffect:{dodgeBonus:0.05, expBonus:0.05} },
      branchB: { id:'pt_4b', name:'🌸离线保护', desc:'离线衰减-20%+闪避+3%', type:'passive', branch:'B', level:4, passiveEffect:{decayReduce:0.20, dodgeBonus:0.03} } },
    { active: { id:'pt_5', name:'🌸🌸花之盾', desc:'恢复10%HP+1.2倍伤害', type:'active', level:5, battleEffect:{healPercent:0.10, dmgMult:1.2, triggerChance:0.22} } },
    { branchA: { id:'pt_6a', name:'🌸厚重甲壳', desc:'最大HP+8%+金币+5%', type:'passive', branch:'A', level:6, passiveEffect:{maxHpBonus:0.08, gameCoinBonus:0.05} },
      branchB: { id:'pt_6b', name:'🌸活力不减', desc:'离线衰减-20%+防御+3%', type:'passive', branch:'B', level:6, passiveEffect:{decayReduce:0.20, defBonus:0.03} } },
    { branchA: { id:'pt_7a', name:'🌸生命涌泉', desc:'每回合恢复3%HP+金币+5%', type:'passive', branch:'A', level:7, passiveEffect:{hpRegenPercent:0.03, gameCoinBonus:0.05} },
      branchB: { id:'pt_7b', name:'🌸稳定心情', desc:'快乐下限提高10+闪避+3%', type:'passive', branch:'B', level:7, passiveEffect:{minHappinessBonus:10, dodgeBonus:0.03} } },
    { branchA: { id:'pt_8a', name:'🌸铁壁', desc:'防御+14%+经验+5%', type:'passive', branch:'A', level:8, passiveEffect:{defBonus:0.14, expBonus:0.05} },
      branchB: { id:'pt_8b', name:'🌸健康守护', desc:'健康下限提高10+防御+3%', type:'passive', branch:'B', level:8, passiveEffect:{minHealthBonus:10, defBonus:0.03} } },
    { branchA: { id:'pt_9a', name:'🌸闪避本能', desc:'闪避+8%+金币+5%', type:'passive', branch:'A', level:9, passiveEffect:{dodgeBonus:0.08, gameCoinBonus:0.05} },
      branchB: { id:'pt_9b', name:'🌸全面防护', desc:'离线衰减-25%+闪避+3%', type:'passive', branch:'B', level:9, passiveEffect:{decayReduce:0.25, dodgeBonus:0.03} } },
    { active: { id:'pt_10', name:'🌸🌸🌸治愈之风', desc:'恢复15%HP+1.3倍伤害', type:'active', level:10, battleEffect:{healPercent:0.15, dmgMult:1.3, triggerChance:0.18} } },
    { branchA: { id:'pt_11a', name:'🌸伤害减免', desc:'受到伤害-8%+经验+5%', type:'passive', branch:'A', level:11, passiveEffect:{damageReduce:0.08, expBonus:0.05} },
      branchB: { id:'pt_11b', name:'🌸衰减抵抗', desc:'离线衰减-25%+防御+3%', type:'passive', branch:'B', level:11, passiveEffect:{decayReduce:0.25, defBonus:0.03} } },
    { branchA: { id:'pt_12a', name:'🌸生命绽放', desc:'每回合恢复4%HP+金币+5%', type:'passive', branch:'A', level:12, passiveEffect:{hpRegenPercent:0.04, gameCoinBonus:0.05} },
      branchB: { id:'pt_12b', name:'🌸健康守护II', desc:'健康下限提高10+闪避+3%', type:'passive', branch:'B', level:12, passiveEffect:{minHealthBonus:10, dodgeBonus:0.03} } },
    { branchA: { id:'pt_13a', name:'🌸最大HP+10%', desc:'最大HP+10%', type:'passive', branch:'A', level:13, passiveEffect:{maxHpBonus:0.10} },
      branchB: { id:'pt_13b', name:'🌸快乐守护', desc:'快乐下限提高10+防御+3%', type:'passive', branch:'B', level:13, passiveEffect:{minHappinessBonus:10, defBonus:0.03} } },
    { branchA: { id:'pt_14a', name:'🌸再生之力', desc:'每回合恢复5%HP+经验+5%', type:'passive', branch:'A', level:14, passiveEffect:{hpRegenPercent:0.05, expBonus:0.05} },
      branchB: { id:'pt_14b', name:'🌸健康守护III', desc:'健康下限提高10+防御+3%', type:'passive', branch:'B', level:14, passiveEffect:{minHealthBonus:10, defBonus:0.03} } },
    { active: { id:'pt_15', name:'🌸🌸🌸🌸守护之花', desc:'恢复20%HP+冰冻对手', type:'active', level:15, battleEffect:{healPercent:0.20, freezeChance:1.0, triggerChance:0.15} } },
    { branchA: { id:'pt_16a', name:'🌸不屈意志', desc:'HP<15%防御x2', type:'passive', branch:'A', level:16, passiveEffect:{lowHpDef:{threshold:0.15,mult:1.0}} },
      branchB: { id:'pt_16b', name:'🌸永恒守护', desc:'健康下限提高10+闪避+3%', type:'passive', branch:'B', level:16, passiveEffect:{minHealthBonus:10, dodgeBonus:0.03} } },
    { branchA: { id:'pt_17a', name:'🌸坚不可摧', desc:'防御+20%+金币+5%', type:'passive', branch:'A', level:17, passiveEffect:{defBonus:0.20, gameCoinBonus:0.05} },
      branchB: { id:'pt_17b', name:'🌸全方位防护', desc:'离线衰减-35%+防御+3%', type:'passive', branch:'B', level:17, passiveEffect:{decayReduce:0.35, defBonus:0.03} } },
    { branchA: { id:'pt_18a', name:'🌸生命之泉', desc:'每回合恢复6%HP+经验+5%', type:'passive', branch:'A', level:18, passiveEffect:{hpRegenPercent:0.06, expBonus:0.05} },
      branchB: { id:'pt_18b', name:'🌸衰减免疫', desc:'离线衰减-40%+闪避+3%', type:'passive', branch:'B', level:18, passiveEffect:{decayReduce:0.40, dodgeBonus:0.03} } },
    { branchA: { id:'pt_19a', name:'🌸伤害减免II', desc:'受到伤害-15%+金币+5%', type:'passive', branch:'A', level:19, passiveEffect:{damageReduce:0.15, gameCoinBonus:0.05} },
      branchB: { id:'pt_19b', name:'🌸快乐之心', desc:'快乐下限提高10+防御+3%', type:'passive', branch:'B', level:19, passiveEffect:{minHappinessBonus:10, defBonus:0.03} } },
    { active: { id:'pt_20', name:'🌸🌸🌸🌸🌸生命守护', desc:'恢复25%HP+1.5倍伤害', type:'active', level:20, battleEffect:{healPercent:0.25, dmgMult:1.5, triggerChance:0.12} } },
    { branchA: { id:'pt_21a', name:'🌸绝对防御', desc:'防御+24%+经验+5%', type:'passive', branch:'A', level:21, passiveEffect:{defBonus:0.24, expBonus:0.05} },
      branchB: { id:'pt_21b', name:'🌸健康天使', desc:'健康下限提高10+闪避+3%', type:'passive', branch:'B', level:21, passiveEffect:{minHealthBonus:10, dodgeBonus:0.03} } },
    { branchA: { id:'pt_22a', name:'🌸生命汲取', desc:'造成伤害2%回血+金币+5%', type:'passive', branch:'A', level:22, passiveEffect:{lifeSteal:0.02, gameCoinBonus:0.05} },
      branchB: { id:'pt_22b', name:'🌸衰减免疫II', desc:'离线衰减-45%+防御+3%', type:'passive', branch:'B', level:22, passiveEffect:{decayReduce:0.45, defBonus:0.03} } },
    { branchA: { id:'pt_23a', name:'🌸最大HP+12%', desc:'最大HP+12%', type:'passive', branch:'A', level:23, passiveEffect:{maxHpBonus:0.12} },
      branchB: { id:'pt_23b', name:'🌸快乐之心II', desc:'快乐下限提高10+防御+3%', type:'passive', branch:'B', level:23, passiveEffect:{minHappinessBonus:10, defBonus:0.03} } },
    { branchA: { id:'pt_24a', name:'🌸每回合+7%HP', desc:'每回合恢复7%HP+经验+5%', type:'passive', branch:'A', level:24, passiveEffect:{hpRegenPercent:0.07, expBonus:0.05} },
      branchB: { id:'pt_24b', name:'🌸全方位守护', desc:'离线衰减-50%+闪避+3%', type:'passive', branch:'B', level:24, passiveEffect:{decayReduce:0.50, dodgeBonus:0.03} } },
    { active: { id:'pt_25', name:'🌸🌸🌸🌸🌸🌸圣光审判', desc:'恢复30%HP+1.6倍伤害', type:'active', level:25, battleEffect:{healPercent:0.30, dmgMult:1.6, freezeChance:1.0, triggerChance:0.15} } },
    { branchA: { id:'pt_26a', name:'🌸不死之身', desc:'免死一次+金币+5%', type:'passive', branch:'A', level:26, passiveEffect:{undying:true, gameCoinBonus:0.05} },
      branchB: { id:'pt_26b', name:'🌸健康守护IV', desc:'健康下限提高10+防御+3%', type:'passive', branch:'B', level:26, passiveEffect:{minHealthBonus:10, defBonus:0.03} } },
    { branchA: { id:'pt_27a', name:'🌸终极回复', desc:'每回合恢复8%HP+经验+5%', type:'passive', branch:'A', level:27, passiveEffect:{hpRegenPercent:0.08, expBonus:0.05} },
      branchB: { id:'pt_27b', name:'🌸衰减免疫III', desc:'离线衰减-55%+闪避+3%', type:'passive', branch:'B', level:27, passiveEffect:{decayReduce:0.55, dodgeBonus:0.03} } },
    { branchA: { id:'pt_28a', name:'🌸伤害减免III', desc:'受到伤害-20%+金币+5%', type:'passive', branch:'A', level:28, passiveEffect:{damageReduce:0.20, gameCoinBonus:0.05} },
      branchB: { id:'pt_28b', name:'🌸快乐之心III', desc:'快乐下限提高10+防御+3%', type:'passive', branch:'B', level:28, passiveEffect:{minHappinessBonus:10, defBonus:0.03} } },
    { branchA: { id:'pt_29a', name:'🌸生命之泉II', desc:'最大HP+15%+经验+5%', type:'passive', branch:'A', level:29, passiveEffect:{maxHpBonus:0.15, expBonus:0.05} },
      branchB: { id:'pt_29b', name:'🌸永恒守护II', desc:'健康下限提高10+闪避+3%', type:'passive', branch:'B', level:29, passiveEffect:{minHealthBonus:10, dodgeBonus:0.03} } },
    { active: { id:'pt_30', name:'🌸🌸🌸🌸🌸🌸🌸天堂之翼', desc:'恢复35%HP+2.0倍伤害', type:'active', level:30, battleEffect:{healPercent:0.35, dmgMult:2.0, freezeChance:1.0, triggerChance:0.10} } },
  ],

  // ----- 调皮(chaos)技能组 -----
  // 特点：分支A偏重暴击和闪避，分支B偏重养成刺激和小游戏
  chaos: [
    null,
    { branchA: { id:'ch_1a', name:'🎭暴击天赋', desc:'暴击率+3%+金币+5%', type:'passive', branch:'A', level:1, passiveEffect:{critBonus:0.03, gameCoinBonus:0.05}, gameCoinBonus:0.05 },
      branchB: { id:'ch_1b', name:'🎭调皮捣蛋', desc:'小游戏金币+12%+暴击+1%', type:'passive', branch:'B', level:1, passiveEffect:{gameCoinBonus:0.12, critBonus:0.01} } },
    { branchA: { id:'ch_2a', name:'🎭暴击伤害', desc:'暴击伤害+15%+金币+5%', type:'passive', branch:'A', level:2, passiveEffect:{critDmgBonus:0.15, gameCoinBonus:0.05} },
      branchB: { id:'ch_2b', name:'🎭小贪心', desc:'对战金币+15%+暴击+1%', type:'passive', branch:'B', level:2, passiveEffect:{battleCoinBonus:0.15, critBonus:0.01} } },
    { branchA: { id:'ch_3a', name:'🎭灵巧闪避', desc:'闪避+4%+金币+5%', type:'passive', branch:'A', level:3, passiveEffect:{dodgeBonus:0.04, gameCoinBonus:0.05} },
      branchB: { id:'ch_3b', name:'🎭惊喜投喂', desc:'喂食10%双倍+暴击+1%', type:'passive', branch:'B', level:3, passiveEffect:{feedDoubleChance:0.10, critBonus:0.01} } },
    { branchA: { id:'ch_4a', name:'🎭暴击强化', desc:'暴击率+4%+金币+5%', type:'passive', branch:'A', level:4, passiveEffect:{critBonus:0.04, gameCoinBonus:0.05}, gameCoinBonus:0.05 },
      branchB: { id:'ch_4b', name:'🎭商店折扣', desc:'商店-5%+闪避+2%', type:'passive', branch:'B', level:4, passiveEffect:{shopDiscount:0.05, dodgeBonus:0.02} } },
    { active: { id:'ch_5', name:'🎭🎭混乱打击', desc:'1.5倍伤害+15%暴击', type:'active', level:5, battleEffect:{dmgMult:1.5, critBonus:0.15, triggerChance:0.22} } },
    { branchA: { id:'ch_6a', name:'🎭暴击伤害+20%', desc:'暴击伤害+20%+金币+5%', type:'passive', branch:'A', level:6, passiveEffect:{critDmgBonus:0.20, gameCoinBonus:0.05} },
      branchB: { id:'ch_6b', name:'🎭小游戏达人', desc:'小游戏金币+15%+暴击+1%', type:'passive', branch:'B', level:6, passiveEffect:{gameCoinBonus:0.15, critBonus:0.01} } },
    { branchA: { id:'ch_7a', name:'🎭暴击率+5%', desc:'暴击率+5%+金币+5%', type:'passive', branch:'A', level:7, passiveEffect:{critBonus:0.05, gameCoinBonus:0.05}, gameCoinBonus:0.05 },
      branchB: { id:'ch_7b', name:'🎭对战金币+20%', desc:'对战金币+20%+暴击+1%', type:'passive', branch:'B', level:7, passiveEffect:{battleCoinBonus:0.20, critBonus:0.01} } },
    { branchA: { id:'ch_8a', name:'🎭连击概率', desc:'8%概率二连击+金币+5%', type:'passive', branch:'A', level:8, passiveEffect:{doubleStrikeChance:0.08, gameCoinBonus:0.05} },
      branchB: { id:'ch_8b', name:'🎭贪心商人', desc:'商店-8%+闪避+2%', type:'passive', branch:'B', level:8, passiveEffect:{shopDiscount:0.08, dodgeBonus:0.02} } },
    { branchA: { id:'ch_9a', name:'🎭暴击伤害x1.7', desc:'暴击伤害x1.7', type:'passive', branch:'A', level:9, passiveEffect:{critDmgMult:1.7} },
      branchB: { id:'ch_9b', name:'🎭金币猎手', desc:'小游戏金币+25%+暴击+1%', type:'passive', branch:'B', level:9, passiveEffect:{gameCoinBonus:0.25, critBonus:0.01} } },
    { active: { id:'ch_10', name:'🎭🎭🎭恶作剧', desc:'1.6倍伤害+暴击+10%', type:'active', level:10, battleEffect:{dmgMult:1.6, critBonus:0.10, triggerChance:0.18} } },
    { branchA: { id:'ch_11a', name:'🎭暴击率+6%', desc:'暴击率+6%+金币+5%', type:'passive', branch:'A', level:11, passiveEffect:{critBonus:0.06, gameCoinBonus:0.05}, gameCoinBonus:0.05 },
      branchB: { id:'ch_11b', name:'🎭对战金币+25%', desc:'对战金币+25%+暴击+1%', type:'passive', branch:'B', level:11, passiveEffect:{battleCoinBonus:0.25, critBonus:0.01} } },
    { branchA: { id:'ch_12a', name:'🎭低血暴击', desc:'HP<25%暴击+15%', type:'passive', branch:'A', level:12, passiveEffect:{lowHpCrit:{threshold:0.25,critBonus:0.15}} },
      branchB: { id:'ch_12b', name:'🎭商店达人', desc:'商店-12%+闪避+2%', type:'passive', branch:'B', level:12, passiveEffect:{shopDiscount:0.12, dodgeBonus:0.02} } },
    { branchA: { id:'ch_13a', name:'🎭暴击伤害x2.2', desc:'暴击伤害x2.2', type:'passive', branch:'A', level:13, passiveEffect:{critDmgMult:2.2} },
      branchB: { id:'ch_13b', name:'🎭金币暴击', desc:'小游戏金币+30%+暴击+1%', type:'passive', branch:'B', level:13, passiveEffect:{gameCoinBonus:0.30, critBonus:0.01} } },
    { branchA: { id:'ch_14a', name:'🎭连击大师', desc:'连击概率+12%+金币+5%', type:'passive', branch:'A', level:14, passiveEffect:{doubleStrikeChance:0.12, gameCoinBonus:0.05} },
      branchB: { id:'ch_14b', name:'🎭对战金币+30%', desc:'对战金币+30%+闪避+2%', type:'passive', branch:'B', level:14, passiveEffect:{battleCoinBonus:0.30, dodgeBonus:0.02} } },
    { active: { id:'ch_15', name:'🎭🎭🎭🎭终极恶作剧', desc:'1.8倍伤害+暴击+15%', type:'active', level:15, battleEffect:{dmgMult:1.8, critBonus:0.15, triggerChance:0.15} } },
    { branchA: { id:'ch_16a', name:'🎭暴击率+7%', desc:'暴击率+7%+金币+5%', type:'passive', branch:'A', level:16, passiveEffect:{critBonus:0.07, gameCoinBonus:0.05}, gameCoinBonus:0.05 },
      branchB: { id:'ch_16b', name:'🎭商店-15%金币', desc:'商店-15%+暴击+1%', type:'passive', branch:'B', level:16, passiveEffect:{shopDiscount:0.15, critBonus:0.01} } },
    { branchA: { id:'ch_17a', name:'🎭暴击伤害x2.0', desc:'暴击伤害x2.0', type:'passive', branch:'A', level:17, passiveEffect:{critDmgMult:2.0} },
      branchB: { id:'ch_17b', name:'🎭金币王者', desc:'对战金币+35%+闪避+2%', type:'passive', branch:'B', level:17, passiveEffect:{battleCoinBonus:0.35, dodgeBonus:0.02} } },
    { branchA: { id:'ch_18a', name:'🎭暴击终极', desc:'暴击率+9%+金币+5%', type:'passive', branch:'A', level:18, passiveEffect:{critBonus:0.09, gameCoinBonus:0.05}, gameCoinBonus:0.05 },
      branchB: { id:'ch_18b', name:'🎭小游戏王者', desc:'小游戏金币+35%+暴击+1%', type:'passive', branch:'B', level:18, passiveEffect:{gameCoinBonus:0.35, critBonus:0.01} } },
    { branchA: { id:'ch_19a', name:'🎭伤害减免', desc:'受到伤害-8%+金币+5%', type:'passive', branch:'A', level:19, passiveEffect:{damageReduce:0.08, gameCoinBonus:0.05} },
      branchB: { id:'ch_19b', name:'🎭商店-18%金币', desc:'商店-18%+闪避+2%', type:'passive', branch:'B', level:19, passiveEffect:{shopDiscount:0.18, dodgeBonus:0.02} } },
    { active: { id:'ch_20', name:'🎭🎭🎭🎭🎭混沌觉醒', desc:'2.0倍伤害+暴击+18%', type:'active', level:20, battleEffect:{dmgMult:2.0, critBonus:0.18, triggerChance:0.12} } },
    { branchA: { id:'ch_21a', name:'🎭暴击伤害x2.2', desc:'暴击伤害x2.2', type:'passive', branch:'A', level:21, passiveEffect:{critDmgMult:2.2} },
      branchB: { id:'ch_21b', name:'🎭金币暴击', desc:'对战金币+40%+暴击+1%', type:'passive', branch:'B', level:21, passiveEffect:{battleCoinBonus:0.40, critBonus:0.01} } },
    { branchA: { id:'ch_22a', name:'🎭暴击率+11%', desc:'暴击率+11%+金币+5%', type:'passive', branch:'A', level:22, passiveEffect:{critBonus:0.11, gameCoinBonus:0.05}, gameCoinBonus:0.05 },
      branchB: { id:'ch_22b', name:'🎭对战金币+45%', desc:'对战金币+45%+闪避+2%', type:'passive', branch:'B', level:22, passiveEffect:{battleCoinBonus:0.45, dodgeBonus:0.02} } },
    { branchA: { id:'ch_23a', name:'🎭连击概率+15%', desc:'连击概率+15%+金币+5%', type:'passive', branch:'A', level:23, passiveEffect:{doubleStrikeChance:0.15, gameCoinBonus:0.05} },
      branchB: { id:'ch_23b', name:'🎭金币雨', desc:'小游戏金币+40%+暴击+2%', type:'passive', branch:'B', level:23, passiveEffect:{gameCoinBonus:0.40, critBonus:0.02} } },
    { branchA: { id:'ch_24a', name:'🎭伤害反弹', desc:'反弹6%伤害+金币+5%', type:'passive', branch:'A', level:24, passiveEffect:{reflect:0.06, gameCoinBonus:0.05} },
      branchB: { id:'ch_24b', name:'🎭商店-22%金币', desc:'商店-22%+闪避+2%', type:'passive', branch:'B', level:24, passiveEffect:{shopDiscount:0.22, dodgeBonus:0.02} } },
    { active: { id:'ch_25', name:'🎭🎭🎭🎭🎭🎭毁灭之力', desc:'2.2倍伤害+暴击+35%', type:'active', level:25, battleEffect:{dmgMult:2.2, critBonus:0.35, triggerChance:0.10} } },
    { branchA: { id:'ch_26a', name:'🎭暴击率+20%', desc:'暴击率+20%+金币+5%', type:'passive', branch:'A', level:26, passiveEffect:{critBonus:0.20, gameCoinBonus:0.05} },
      branchB: { id:'ch_26b', name:'🎭对战金币+50%', desc:'对战金币+50%+暴击+2%', type:'passive', branch:'B', level:26, passiveEffect:{battleCoinBonus:0.50, critBonus:0.02} } },
    { branchA: { id:'ch_27a', name:'🎭暴击伤害x3.5', desc:'暴击伤害x3.5', type:'passive', branch:'A', level:27, passiveEffect:{critDmgMult:3.5} },
      branchB: { id:'ch_27b', name:'🎭15%金币翻倍', desc:'15%金币翻倍+闪避+2%', type:'passive', branch:'B', level:27, passiveEffect:{coinDoubleChance:0.15, dodgeBonus:0.02} } },
    { branchA: { id:'ch_28a', name:'🎭暴击之神', desc:'暴击率+22%+金币+5%', type:'passive', branch:'A', level:28, passiveEffect:{critBonus:0.22, gameCoinBonus:0.05} },
      branchB: { id:'ch_28b', name:'🎭金币之王', desc:'对战金币+55%+暴击+2%', type:'passive', branch:'B', level:28, passiveEffect:{battleCoinBonus:0.55, critBonus:0.02} } },
    { branchA: { id:'ch_29a', name:'🎭连击概率+18%', desc:'连击概率+18%+金币+5%', type:'passive', branch:'A', level:29, passiveEffect:{doubleStrikeChance:0.18, gameCoinBonus:0.05} },
      branchB: { id:'ch_29b', name:'🎭商店-25%金币', desc:'商店-25%+闪避+2%', type:'passive', branch:'B', level:29, passiveEffect:{shopDiscount:0.25, dodgeBonus:0.02} } },
    { active: { id:'ch_30', name:'🎭🎭🎭🎭🎭🎭🎭混沌之怒', desc:'2.4倍伤害+暴击+45%', type:'active', level:30, battleEffect:{dmgMult:2.4, critBonus:0.45, triggerChance:0.08} } },
  ],

  // ----- 聪明(wisdom)技能组 -----
  // 特点：分支A偏重策略防御和控场，分支B偏重经验、金币和效率
  wisdom: [
    null,
    { branchA: { id:'ws_1a', name:'💡分析弱点', desc:'闪避+6%+经验+5%', type:'passive', branch:'A', level:1, passiveEffect:{dodgeBonus:0.06, expBonus:0.05} },
      branchB: { id:'ws_1b', name:'💡聪明学习', desc:'获取经验+12%+闪避+2%', type:'passive', branch:'B', level:1, passiveEffect:{expBonus:0.12, dodgeBonus:0.02} } },
    { branchA: { id:'ws_2a', name:'💡反射护盾', desc:'反弹4%伤害+经验+5%', type:'passive', branch:'A', level:2, passiveEffect:{reflect:0.04, expBonus:0.05} },
      branchB: { id:'ws_2b', name:'💡勤奋好学', desc:'获取经验+15%+闪避+2%', type:'passive', branch:'B', level:2, passiveEffect:{expBonus:0.15, dodgeBonus:0.02} } },
    { branchA: { id:'ws_3a', name:'💡敏锐直觉', desc:'闪避+8%+经验+5%', type:'passive', branch:'A', level:3, passiveEffect:{dodgeBonus:0.08, expBonus:0.05} },
      branchB: { id:'ws_3b', name:'💡高效学习', desc:'获取经验+20%+闪避+2%', type:'passive', branch:'B', level:3, passiveEffect:{expBonus:0.20, dodgeBonus:0.02} } },
    { branchA: { id:'ws_4a', name:'💡伤害反弹', desc:'反弹6%伤害+经验+5%', type:'passive', branch:'A', level:4, passiveEffect:{reflect:0.06, expBonus:0.05} },
      branchB: { id:'ws_4b', name:'💡智慧积累', desc:'获取经验+25%+闪避+2%', type:'passive', branch:'B', level:4, passiveEffect:{expBonus:0.25, dodgeBonus:0.02} } },
    { active: { id:'ws_5', name:'💡💡洞察之眼', desc:'1.3倍伤害+降对手攻击', type:'active', level:5, battleEffect:{dmgMult:1.3, atkReduce:0.12, atkReduceTurns:2, triggerChance:0.22} } },
    { branchA: { id:'ws_6a', name:'💡灵动身影', desc:'闪避+10%+经验+5%', type:'passive', branch:'A', level:6, passiveEffect:{dodgeBonus:0.10, expBonus:0.05} },
      branchB: { id:'ws_6b', name:'💡双倍经验', desc:'获取经验+30%+闪避+2%', type:'passive', branch:'B', level:6, passiveEffect:{expBonus:0.30, dodgeBonus:0.02} } },
    { branchA: { id:'ws_7a', name:'💡反弹强化', desc:'反弹10%伤害+经验+5%', type:'passive', branch:'A', level:7, passiveEffect:{reflect:0.10, expBonus:0.05} },
      branchB: { id:'ws_7b', name:'💡经验大师', desc:'获取经验+35%+防御+2%', type:'passive', branch:'B', level:7, passiveEffect:{expBonus:0.35, defBonus:0.02} } },
    { branchA: { id:'ws_8a', name:'💡完美闪避', desc:'闪避+12%+经验+5%', type:'passive', branch:'A', level:8, passiveEffect:{dodgeBonus:0.12, expBonus:0.05} },
      branchB: { id:'ws_8b', name:'💡速成计划', desc:'升级经验-6%+闪避+2%', type:'passive', branch:'B', level:8, passiveEffect:{expReduce:0.06, dodgeBonus:0.02} } },
    { branchA: { id:'ws_9a', name:'💡低血闪避', desc:'HP<20%闪避+15%', type:'passive', branch:'A', level:9, passiveEffect:{lowHpDodge:{threshold:0.20,dodgeBonus:0.15}} },
      branchB: { id:'ws_9b', name:'💡知识之光', desc:'获取经验+40%+防御+2%', type:'passive', branch:'B', level:9, passiveEffect:{expBonus:0.40, defBonus:0.02} } },
    { active: { id:'ws_10', name:'💡💡💡战术打击', desc:'1.5倍伤害+降对手防御', type:'active', level:10, battleEffect:{dmgMult:1.5, defReduce:0.15, defReduceTurns:2, triggerChance:0.18} } },
    { branchA: { id:'ws_11a', name:'💡伤害反弹', desc:'反弹14%伤害+经验+5%', type:'passive', branch:'A', level:11, passiveEffect:{reflect:0.14, expBonus:0.05} },
      branchB: { id:'ws_11b', name:'💡经验专家', desc:'获取经验+45%+闪避+2%', type:'passive', branch:'B', level:11, passiveEffect:{expBonus:0.45, dodgeBonus:0.02} } },
    { branchA: { id:'ws_12a', name:'💡闪避+15%', desc:'闪避+15%+经验+5%', type:'passive', branch:'A', level:12, passiveEffect:{dodgeBonus:0.15, expBonus:0.05} },
      branchB: { id:'ws_12b', name:'💡速成计划II', desc:'升级经验-10%+闪避+2%', type:'passive', branch:'B', level:12, passiveEffect:{expReduce:0.10, dodgeBonus:0.02} } },
    { branchA: { id:'ws_13a', name:'💡绝对闪避', desc:'闪避+18%+经验+5%', type:'passive', branch:'A', level:13, passiveEffect:{dodgeBonus:0.18, expBonus:0.05} },
      branchB: { id:'ws_13b', name:'💡经验狂人', desc:'获取经验+50%+防御+2%', type:'passive', branch:'B', level:13, passiveEffect:{expBonus:0.50, defBonus:0.02} } },
    { branchA: { id:'ws_14a', name:'💡反弹大师', desc:'反弹16%伤害+经验+5%', type:'passive', branch:'A', level:14, passiveEffect:{reflect:0.16, expBonus:0.05} },
      branchB: { id:'ws_14b', name:'💡速成计划III', desc:'升级经验-12%+闪避+2%', type:'passive', branch:'B', level:14, passiveEffect:{expReduce:0.12, dodgeBonus:0.02} } },
    { active: { id:'ws_15', name:'💡💡💡💡绝对智慧', desc:'1.6倍伤害+20%冰冻', type:'active', level:15, battleEffect:{dmgMult:1.6, freezeChance:0.20, triggerChance:0.15} } },
    { branchA: { id:'ws_16a', name:'💡不可预测', desc:'闪避+20%+经验+5%', type:'passive', branch:'A', level:16, passiveEffect:{dodgeBonus:0.20, expBonus:0.05} },
      branchB: { id:'ws_16b', name:'💡经验之心', desc:'获取经验+55%+防御+2%', type:'passive', branch:'B', level:16, passiveEffect:{expBonus:0.55, defBonus:0.02} } },
    { branchA: { id:'ws_17a', name:'💡伤害反弹', desc:'反弹20%伤害+经验+5%', type:'passive', branch:'A', level:17, passiveEffect:{reflect:0.20, expBonus:0.05} },
      branchB: { id:'ws_17b', name:'💡速成计划IV', desc:'升级经验-15%+闪避+2%', type:'passive', branch:'B', level:17, passiveEffect:{expReduce:0.15, dodgeBonus:0.02} } },
    { branchA: { id:'ws_18a', name:'💡低血闪避II', desc:'HP<30%闪避+20%', type:'passive', branch:'A', level:18, passiveEffect:{lowHpDodge:{threshold:0.30,dodgeBonus:0.20}} },
      branchB: { id:'ws_18b', name:'💡经验王者', desc:'获取经验+60%+防御+2%', type:'passive', branch:'B', level:18, passiveEffect:{expBonus:0.60, defBonus:0.02} } },
    { branchA: { id:'ws_19a', name:'💡反弹强化II', desc:'反弹22%伤害+经验+5%', type:'passive', branch:'A', level:19, passiveEffect:{reflect:0.22, expBonus:0.05} },
      branchB: { id:'ws_19b', name:'💡速成计划V', desc:'升级经验-18%+闪避+2%', type:'passive', branch:'B', level:19, passiveEffect:{expReduce:0.18, dodgeBonus:0.02} } },
    { active: { id:'ws_20', name:'💡💡💡💡💡绝对洞察', desc:'1.8倍伤害+降防3回合', type:'active', level:20, battleEffect:{dmgMult:1.8, defReduce:0.20, defReduceTurns:3, triggerChance:0.12} } },
    { branchA: { id:'ws_21a', name:'💡幻影步', desc:'闪避+22%+经验+5%', type:'passive', branch:'A', level:21, passiveEffect:{dodgeBonus:0.22, expBonus:0.05} },
      branchB: { id:'ws_21b', name:'💡经验传说', desc:'获取经验+70%+防御+2%', type:'passive', branch:'B', level:21, passiveEffect:{expBonus:0.70, defBonus:0.02} } },
    { branchA: { id:'ws_22a', name:'💡反弹王', desc:'反弹24%伤害+经验+5%', type:'passive', branch:'A', level:22, passiveEffect:{reflect:0.24, expBonus:0.05} },
      branchB: { id:'ws_22b', name:'💡速成计划VI', desc:'升级经验-20%+闪避+2%', type:'passive', branch:'B', level:22, passiveEffect:{expReduce:0.20, dodgeBonus:0.02} } },
    { branchA: { id:'ws_23a', name:'💡绝对闪避II', desc:'闪避+25%+经验+5%', type:'passive', branch:'A', level:23, passiveEffect:{dodgeBonus:0.25, expBonus:0.05} },
      branchB: { id:'ws_23b', name:'💡经验之神', desc:'获取经验+80%+防御+2%', type:'passive', branch:'B', level:23, passiveEffect:{expBonus:0.80, defBonus:0.02} } },
    { branchA: { id:'ws_24a', name:'💡伤害减免', desc:'受到伤害-12%+经验+5%', type:'passive', branch:'A', level:24, passiveEffect:{damageReduce:0.12, expBonus:0.05} },
      branchB: { id:'ws_24b', name:'💡速成计划VII', desc:'升级经验-22%+闪避+2%', type:'passive', branch:'B', level:24, passiveEffect:{expReduce:0.22, dodgeBonus:0.02} } },
    { active: { id:'ws_25', name:'💡💡💡💡💡💡智慧审判', desc:'2.0倍伤害+降攻防', type:'active', level:25, battleEffect:{dmgMult:2.0, atkReduce:0.20, defReduce:0.20, atkReduceTurns:3, defReduceTurns:3, triggerChance:0.15} } },
    { branchA: { id:'ws_26a', name:'💡绝对闪避III', desc:'闪避+28%+经验+5%', type:'passive', branch:'A', level:26, passiveEffect:{dodgeBonus:0.28, expBonus:0.05} },
      branchB: { id:'ws_26b', name:'💡双倍经验II', desc:'获取经验+90%+防御+2%', type:'passive', branch:'B', level:26, passiveEffect:{expBonus:0.90, defBonus:0.02} } },
    { branchA: { id:'ws_27a', name:'💡反弹终极', desc:'反弹28%伤害+经验+5%', type:'passive', branch:'A', level:27, passiveEffect:{reflect:0.28, expBonus:0.05} },
      branchB: { id:'ws_27b', name:'💡速成终极', desc:'升级经验-25%+闪避+2%', type:'passive', branch:'B', level:27, passiveEffect:{expReduce:0.25, dodgeBonus:0.02} } },
    { branchA: { id:'ws_28a', name:'💡不死之身', desc:'免死一次+经验+5%', type:'passive', branch:'A', level:28, passiveEffect:{undying:true, expBonus:0.05} },
      branchB: { id:'ws_28b', name:'💡经验神话', desc:'获取经验+100%+防御+2%', type:'passive', branch:'B', level:28, passiveEffect:{expBonus:1.0, defBonus:0.02} } },
    { branchA: { id:'ws_29a', name:'💡伤害减免II', desc:'受到伤害-18%+经验+5%', type:'passive', branch:'A', level:29, passiveEffect:{damageReduce:0.18, expBonus:0.05} },
      branchB: { id:'ws_29b', name:'💡速成神话', desc:'升级经验-28%+闪避+2%', type:'passive', branch:'B', level:29, passiveEffect:{expReduce:0.28, dodgeBonus:0.02} } },
    { active: { id:'ws_30', name:'💡💡💡💡💡💡💡全知全能', desc:'2.2倍伤害+降攻防+必中', type:'active', level:30, battleEffect:{dmgMult:2.2, defReduce:0.15, atkReduce:0.15, defReduceTurns:2, atkReduceTurns:2, guaranteed:true, triggerChance:0.10} } },
  ],

  // ----- 傲娇(snark)技能组 -----
  // 特点：分支A偏重速度和控场，分支B偏重养成品质和互动
  snark: [
    null,
    { branchA: { id:'sk_1a', name:'😼速度觉醒', desc:'速度+10%+好事件+5%', type:'passive', branch:'A', level:1, passiveEffect:{speedBonus:0.10, goodEventBonus:0.05} },
      branchB: { id:'sk_1b', name:'😼傲娇魅力', desc:'抚摸快乐+15%+速度+2%', type:'passive', branch:'B', level:1, passiveEffect:{petBonus:0.15, speedBonus:0.02} } },
    { branchA: { id:'sk_2a', name:'😼寒冰之触', desc:'对手攻击-6%+好事件+5%', type:'passive', branch:'A', level:2, passiveEffect:{enemyAtkReduce:0.06, goodEventBonus:0.05} },
      branchB: { id:'sk_2b', name:'😼幸运星', desc:'好事件概率+15%+速度+2%', type:'passive', branch:'B', level:2, passiveEffect:{goodEventBonus:0.15, speedBonus:0.02} } },
    { branchA: { id:'sk_3a', name:'😼疾风步', desc:'速度+8%+好事件+5%', type:'passive', branch:'A', level:3, passiveEffect:{speedBonus:0.08, goodEventBonus:0.05} },
      branchB: { id:'sk_3b', name:'😼好运连连', desc:'好事件概率+20%+闪避+2%', type:'passive', branch:'B', level:3, passiveEffect:{goodEventBonus:0.20, dodgeBonus:0.02} } },
    { branchA: { id:'sk_4a', name:'😼寒霜之触', desc:'每回合毒伤2%HP+好事件+5%', type:'passive', branch:'A', level:4, passiveEffect:{dotPercent:0.02, goodEventBonus:0.05} },
      branchB: { id:'sk_4b', name:'😼奇遇', desc:'10%效果翻倍+速度+2%', type:'passive', branch:'B', level:4, passiveEffect:{allDoubleChance:0.10, speedBonus:0.02} } },
    { active: { id:'sk_5', name:'😼😼疾风击', desc:'1.3倍伤害+必中+15%冰冻', type:'active', level:5, battleEffect:{dmgMult:1.3, guaranteed:true, freezeChance:0.15, triggerChance:0.22} } },
    { branchA: { id:'sk_6a', name:'😼速度+15%', desc:'速度+15%+好事件+5%', type:'passive', branch:'A', level:6, passiveEffect:{speedBonus:0.15, goodEventBonus:0.05} },
      branchB: { id:'sk_6b', name:'😼好运光环', desc:'好事件概率+25%+速度+2%', type:'passive', branch:'B', level:6, passiveEffect:{goodEventBonus:0.25, speedBonus:0.02} } },
    { branchA: { id:'sk_7a', name:'😼冰霜之力', desc:'对手攻击-10%+好事件+5%', type:'passive', branch:'A', level:7, passiveEffect:{enemyAtkReduce:0.10, goodEventBonus:0.05} },
      branchB: { id:'sk_7b', name:'😼傲娇之人', desc:'好事件概率+30%+闪避+2%', type:'passive', branch:'B', level:7, passiveEffect:{goodEventBonus:0.30, dodgeBonus:0.02} } },
    { branchA: { id:'sk_8a', name:'😼毒雾弥漫', desc:'每回合毒伤3%HP+好事件+5%', type:'passive', branch:'A', level:8, passiveEffect:{dotPercent:0.03, goodEventBonus:0.05} },
      branchB: { id:'sk_8b', name:'😼15%效果翻倍', desc:'15%效果翻倍+速度+2%', type:'passive', branch:'B', level:8, passiveEffect:{allDoubleChance:0.15, speedBonus:0.02} } },
    { branchA: { id:'sk_9a', name:'😼低血闪避', desc:'HP<35%闪避+15%', type:'passive', branch:'A', level:9, passiveEffect:{lowHpDodge:{threshold:0.35,dodgeBonus:0.15}} },
      branchB: { id:'sk_9b', name:'😼奇遇达人', desc:'好事件概率+35%+速度+2%', type:'passive', branch:'B', level:9, passiveEffect:{goodEventBonus:0.35, speedBonus:0.02} } },
    { active: { id:'sk_10', name:'😼😼😼凝视', desc:'1.4倍伤害+降对手攻防', type:'active', level:10, battleEffect:{dmgMult:1.4, atkReduce:0.08, defReduce:0.08, atkReduceTurns:2, defReduceTurns:2, triggerChance:0.20} } },
    { branchA: { id:'sk_11a', name:'😼高速突袭', desc:'速度+8% 攻击+3%', type:'passive', branch:'A', level:11, passiveEffect:{speedBonus:0.08, atkBonus:0.03} },
      branchB: { id:'sk_11b', name:'😼幸运之星', desc:'好事件概率+40%+闪避+2%', type:'passive', branch:'B', level:11, passiveEffect:{goodEventBonus:0.40, dodgeBonus:0.02} } },
    { branchA: { id:'sk_12a', name:'😼冰封领域', desc:'对手攻击-12%+好事件+5%', type:'passive', branch:'A', level:12, passiveEffect:{enemyAtkReduce:0.12, goodEventBonus:0.05} },
      branchB: { id:'sk_12b', name:'😼20%效果翻倍', desc:'20%效果翻倍+速度+2%', type:'passive', branch:'B', level:12, passiveEffect:{allDoubleChance:0.20, speedBonus:0.02} } },
    { branchA: { id:'sk_13a', name:'😼速度+20%', desc:'速度+20%+好事件+5%', type:'passive', branch:'A', level:13, passiveEffect:{speedBonus:0.20, goodEventBonus:0.05} },
      branchB: { id:'sk_13b', name:'😼摸头大师', desc:'抚摸快乐+20%+速度+2%', type:'passive', branch:'B', level:13, passiveEffect:{petBonus:0.20, speedBonus:0.02} } },
    { branchA: { id:'sk_14a', name:'😼灵动身影', desc:'闪避+12%+好事件+5%', type:'passive', branch:'A', level:14, passiveEffect:{dodgeBonus:0.12, goodEventBonus:0.05} },
      branchB: { id:'sk_14b', name:'😼好运连连II', desc:'好事件概率+45%+闪避+2%', type:'passive', branch:'B', level:14, passiveEffect:{goodEventBonus:0.45, dodgeBonus:0.02} } },
    { active: { id:'sk_15', name:'😼😼😼😼冰封领域', desc:'1.6倍伤害+必中+35%冰冻', type:'active', level:15, battleEffect:{dmgMult:1.6, freezeChance:0.35, guaranteed:true, triggerChance:0.18} } },
    { branchA: { id:'sk_16a', name:'😼低血全属性+25%', desc:'HP<15%全属性+25%', type:'passive', branch:'A', level:16, passiveEffect:{lowHpAllBoost:{threshold:0.15,bonus:0.25}} },
      branchB: { id:'sk_16b', name:'😼经验大师', desc:'获取经验+25%+速度+2%', type:'passive', branch:'B', level:16, passiveEffect:{expBonus:0.25, speedBonus:0.02} } },
    { branchA: { id:'sk_17a', name:'😼风驰电掣', desc:'速度+12% 攻击+5%', type:'passive', branch:'A', level:17, passiveEffect:{speedBonus:0.12, atkBonus:0.05} },
      branchB: { id:'sk_17b', name:'😼25%效果翻倍', desc:'25%效果翻倍+闪避+2%', type:'passive', branch:'B', level:17, passiveEffect:{allDoubleChance:0.25, dodgeBonus:0.02} } },
    { branchA: { id:'sk_18a', name:'😼闪避+15%', desc:'闪避+15%+好事件+5%', type:'passive', branch:'A', level:18, passiveEffect:{dodgeBonus:0.15, goodEventBonus:0.05} },
      branchB: { id:'sk_18b', name:'😼好运光环II', desc:'好事件概率+50%+速度+2%', type:'passive', branch:'B', level:18, passiveEffect:{goodEventBonus:0.50, speedBonus:0.02} } },
    { branchA: { id:'sk_19a', name:'😼速度+25%', desc:'速度+25%+好事件+5%', type:'passive', branch:'A', level:19, passiveEffect:{speedBonus:0.25, goodEventBonus:0.05} },
      branchB: { id:'sk_19b', name:'😼速成计划', desc:'升级经验-8%+闪避+2%', type:'passive', branch:'B', level:19, passiveEffect:{expReduce:0.08, dodgeBonus:0.02} } },
    { active: { id:'sk_20', name:'😼😼😼😼😼绝对零度', desc:'1.9倍伤害+必中+冰冻', type:'active', level:20, battleEffect:{dmgMult:1.9, freezeChance:1.0, guaranteed:true, triggerChance:0.15} } },
    { branchA: { id:'sk_21a', name:'😼剧毒蔓延', desc:'每回合毒伤4%HP+好事件+5%', type:'passive', branch:'A', level:21, passiveEffect:{dotPercent:0.04, goodEventBonus:0.05} },
      branchB: { id:'sk_21b', name:'😼幸运传说', desc:'好事件概率+55%+速度+2%', type:'passive', branch:'B', level:21, passiveEffect:{goodEventBonus:0.55, speedBonus:0.02} } },
    { branchA: { id:'sk_22a', name:'😼幻影步', desc:'闪避+12%+好事件+5%', type:'passive', branch:'A', level:22, passiveEffect:{dodgeBonus:0.12, goodEventBonus:0.05} },
      branchB: { id:'sk_22b', name:'😼30%效果翻倍', desc:'30%效果翻倍+闪避+2%', type:'passive', branch:'B', level:22, passiveEffect:{allDoubleChance:0.30, dodgeBonus:0.02} } },
    { branchA: { id:'sk_23a', name:'😼风驰电掣II', desc:'速度+12% 攻击+5%', type:'passive', branch:'A', level:23, passiveEffect:{speedBonus:0.12, atkBonus:0.05} },
      branchB: { id:'sk_23b', name:'😼经验之光', desc:'获取经验+35%+速度+2%', type:'passive', branch:'B', level:23, passiveEffect:{expBonus:0.35, speedBonus:0.02} } },
    { branchA: { id:'sk_24a', name:'😼每回合+2%HP', desc:'每回合恢复2%HP+好事件+5%', type:'passive', branch:'A', level:24, passiveEffect:{hpRegenPercent:0.02, goodEventBonus:0.05} },
      branchB: { id:'sk_24b', name:'😼好运传说', desc:'好事件概率+60%+闪避+2%', type:'passive', branch:'B', level:24, passiveEffect:{goodEventBonus:0.60, dodgeBonus:0.02} } },
    { active: { id:'sk_25', name:'😼😼😼😼😼😼风之裁决', desc:'2.0倍伤害+必中+闪避+15%冰冻', type:'active', level:25, battleEffect:{dmgMult:2.0, guaranteed:true, dodgeBoost:0.15, freezeChance:0.15, triggerChance:0.12} } },
    { branchA: { id:'sk_26a', name:'😼全战斗+15%', desc:'全战斗属性+15%', type:'passive', branch:'A', level:26, passiveEffect:{allBattleBonus:0.15} },
      branchB: { id:'sk_26b', name:'😼摸头天才', desc:'抚摸恢复4体力+速度+2%', type:'passive', branch:'B', level:26, passiveEffect:{petEnergyRestore:4, speedBonus:0.02} } },
    { branchA: { id:'sk_27a', name:'😼虚无之影', desc:'闪避+15%+好事件+5%', type:'passive', branch:'A', level:27, passiveEffect:{dodgeBonus:0.15, goodEventBonus:0.05} },
      branchB: { id:'sk_27b', name:'😈35%效果翻倍', desc:'35%效果翻倍+速度+2%', type:'passive', branch:'B', level:27, passiveEffect:{allDoubleChance:0.35, speedBonus:0.02} } },
    { branchA: { id:'sk_28a', name:'😼疾风迅雷', desc:'速度+8% 攻击+5%', type:'passive', branch:'A', level:28, passiveEffect:{speedBonus:0.08, atkBonus:0.05} },
      branchB: { id:'sk_28b', name:'😼好运神话', desc:'好事件概率+65%+闪避+2%', type:'passive', branch:'B', level:28, passiveEffect:{goodEventBonus:0.65, dodgeBonus:0.02} } },
    { branchA: { id:'sk_29a', name:'😼不死之身', desc:'免死一次+好事件+5%', type:'passive', branch:'A', level:29, passiveEffect:{undying:true, goodEventBonus:0.05} },
      branchB: { id:'sk_29b', name:'😈快乐天才', desc:'快乐下限提高10+速度+2%', type:'passive', branch:'B', level:29, passiveEffect:{minHappinessBonus:10, speedBonus:0.02} } },
    { active: { id:'sk_30', name:'😼😼😼😼😼😼😼终焉审判', desc:'2.2倍伤害+必中+40%冰冻+降攻防', type:'active', level:30, battleEffect:{dmgMult:2.2, freezeChance:0.40, guaranteed:true, atkReduce:0.12, defReduce:0.12, atkReduceTurns:2, defReduceTurns:2, triggerChance:0.10} } },
  ]
};

// 从技能树构建技能id到技能对象的映射（用于快速查找）
const LEARNED_SKILL_MAP = {};
Object.values(SKILL_TREE_GROUPS).forEach(group => {
  group.forEach(slot => {
    if (!slot) return;
    if (slot.active && slot.active.id) LEARNED_SKILL_MAP[slot.active.id] = slot.active;
    if (slot.branchA && slot.branchA.id) LEARNED_SKILL_MAP[slot.branchA.id] = slot.branchA;
    if (slot.branchB && slot.branchB.id) LEARNED_SKILL_MAP[slot.branchB.id] = slot.branchB;
  });
});

// 聚合宠物的所有被动效果（从已解锁技能中收集）
function getPassiveEffects(pet) {
  if (!pet || !pet.unlockedSkills) return {};
  const effects = {};
  pet.unlockedSkills.forEach(id => {
    const skill = LEARNED_SKILL_MAP[id];
    if (skill && skill.type === 'passive' && skill.passiveEffect) {
      Object.entries(skill.passiveEffect).forEach(([key, val]) => {
        // critDmgMult 取最大值（倍率不应累加）
        if (key === 'critDmgMult') {
          effects[key] = Math.max(effects[key] || 0, val);
        } else if (typeof val === 'number') {
          effects[key] = (effects[key] || 0) + val;
        } else {
          effects[key] = val;
        }
      });
    }
  });
  // dotPercent 上限保护（每回合最多毒伤5%HP）
  if (effects.dotPercent) effects.dotPercent = Math.min(0.05, effects.dotPercent);
  return effects;
}

// ===== 游戏状态 =====
let gameState = {
  pet: null,
  coins: 100,
  inventory: { food: {}, toys: {}, medicine: {}, cosmetics: {} },
  album: [], // discovered species IDs
  records: {
    totalFeeds: 0,
    totalPlays: 0,
    totalCleans: 0,
    totalSleeps: 0,
    totalPets: 0,
    totalHeals: 0,
    totalGamesPlayed: 0,
    totalCoinsEarned: 0,
    totalBreeds: 0,
    totalEvolves: 0,
    hatchTime: null,
    lastLogin: null
  },
  settings: { sound: true },
  version: 2,

  // === 新增字段 ===
  petCollection: [], // 所有宠物收藏
  activePetId: null, // 当前活跃宠物ID
  battleStats: {
    total: 0,
    wins: 0,
    losses: 0,
    closeWins: 0,  // 险胜次数（胜利时HP低于10%）
    streak: 0,
    maxStreak: 0,
    rankPoints: 0,
    rank: 'tap_water'
  },
  pvpStats: { total: 0, wins: 0, losses: 0 },
  achievements: {
    unlocked: [], // 已解锁成就ID
    claimed: []   // 已领取奖励的成就ID
  },
  dailyTasks: {
    date: null,      // YYYY-MM-DD
    tasks: [],       // [{id, name, type, target, progress, reward, claimed}]
    claimedAll: false
  },
  breedSlot1: null,  // 繁殖槽位1的宠物ID
  breedSlot2: null,  // 繁殖槽位2的宠物ID
  breedHistory: {},  // 繁殖次数记录：key = 排序后的id组合，value = 次数
  importedPets: [],   // 导入的宠物（可用于繁殖/对战）
  importedPetIds: [], // 已导入宠物的 originalId 列表，防止重复导入
  leaderboards: { catch: [], memory: [], quiz: [], gomoku: [] },  // 迷你游戏排行榜
  albumDetails: {},  // 图鉴详细信息
  lastActionTime: Date.now(),  // 最后一次玩家操作时间，用于自动睡觉检测
  lastInteractionTime: Date.now(),  // 最后一次玩家互动时间，用于快乐度加速衰减
  lastCloseTime: null,  // 最后一次关闭/保存时间，用于离线计算
  // 季节/天气系统
  weather: null,
  weatherDate: null,
  // 随机事件系统
  lastEventTime: null,
  eventCooldown: 180000,
  // 隐藏计数器
  hiddenCounters: {
    consecutiveLoginDays: 0,
    lastLoginDate: null,
    consecutiveBattleLosses: 0,
    forceFeedCount: 0,
    sleepPetCount: 0,
  }
};

let currentTab = 'home';
let currentShopTab = 'food';
let speechTimeout = null;
let decayInterval = null;
let autoSaveInterval = null;
let activeMinigame = null;

// ===== 存档系统 =====
function saveGame() {
  try {
    // 注意：lastCloseTime 只在页面关闭时（doSave）更新，
    // 不在普通保存时更新，否则自动保存会覆盖真正的离开时间
    gameState.records = gameState.records || {};
    gameState.records.lastSave = Date.now();
    // 始终保存到本地通用存档（兼容游客模式和缓存）
    localStorage.setItem(SAVE_KEY, JSON.stringify(gameState));
  } catch(e) { console.warn('Save failed:', e); }

  // 保存到 IndexedDB 作为全局备份（即使没登录也有备份）
  if (gameState.pet) {
    saveToIDB('global_backup', gameState).catch(() => {});
  }

  // 如果已登录用户，也保存到用户专属存储空间
  if (currentUser) {
    saveUserData();
  }
}

function loadGame() {
  try {
    const data = localStorage.getItem(SAVE_KEY);
    if (data) {
      const parsed = JSON.parse(data);
      gameState = { ...gameState, ...parsed };
      // 统一调用 ensureGameStateDefaults 补全所有新增字段
      ensureGameStateDefaults();
      return true;
    }
  } catch(e) { console.warn('Load failed:', e); }
  return false;
}

async function resetGame() {
  // 清除通用缓存
  try { localStorage.removeItem(SAVE_KEY); } catch(e) {}

  // 清除当前用户的本地存档
  if (currentUser) {
    try {
      const userSaveKey = 'pocket_buddy_user_save_' + currentUser.id;
      localStorage.removeItem(userSaveKey);
    } catch(e) {}

    // 清除 users 对象里的游戏数据
    try {
      const users = getLocalUsers();
      for (const key in users) {
        if (users[key].id === currentUser.id) {
          users[key].gameData = null;
          saveLocalUsers(users);
          break;
        }
      }
    } catch(e) {}

    // 清除 IndexedDB 用户存档
    try {
      const db = await openIDB();
      if (db) {
        const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
        tx.objectStore(IDB_STORE_NAME).delete(currentUser.id);
      }
    } catch(e) {}
  }

  // 清除 IndexedDB 全局备份
  try {
    const db = await openIDB();
    if (db) {
      const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
      tx.objectStore(IDB_STORE_NAME).delete('global_backup');
    }
  } catch(e) {}

  gameState = {
    pet: null, coins: 100,
    inventory: { food: {}, toys: {}, medicine: {}, cosmetics: {} },
    album: [], records: { totalFeeds: 0, totalPlays: 0, totalCleans: 0, totalSleeps: 0,
      totalPets: 0, totalHeals: 0, totalGamesPlayed: 0, totalCoinsEarned: 0,
      totalBreeds: 0, totalEvolves: 0, hatchTime: null, lastLogin: null },
    settings: { sound: true }, version: 2,
    petCollection: [], activePetId: null,
    battleStats: { total: 0, wins: 0, losses: 0, closeWins: 0, streak: 0, maxStreak: 0, rankPoints: 0, rank: 'tap_water' },
    pvpStats: { total: 0, wins: 0, losses: 0 },
    achievements: { unlocked: [], claimed: [] },
    dailyTasks: { date: null, tasks: [], claimedAll: false },
    breedSlot1: null, breedSlot2: null, breedHistory: {},
    importedPets: [], importedPetIds: [],
    leaderboards: { catch: [], memory: [], quiz: [], gomoku: [] },
    albumDetails: {},
    weather: null,
    weatherDate: null,
    lastEventTime: null,
    eventCooldown: 180000,
    hiddenCounters: {
      consecutiveLoginDays: 0, lastLoginDate: null,
      consecutiveBattleLosses: 0, forceFeedCount: 0, sleepPetCount: 0,
    },
    lastActionTime: Date.now(),
    lastInteractionTime: Date.now(),
    lastCloseTime: null
  };

  // 稍微等一下确保存储操作完成，再刷新
  setTimeout(() => {
    location.reload();
  }, 200);
}

// ===== UI 工具 =====
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $(`#${id}`).classList.add('active');
  // 切换到孵化画面时，自动绑定蛋的点击事件（兜底，防止重复绑定）
  if (id === 'hatch-screen' && typeof initHatch === 'function') {
    try { initHatch(); } catch(e) { console.warn('initHatch 失败:', e); }
  }
}

const panelTimeouts = {};

function showPanel(id) {
  // 清除之前的隐藏 timeout，防止闪烁
  if (panelTimeouts[id]) {
    clearTimeout(panelTimeouts[id]);
    panelTimeouts[id] = null;
  }
  const el = $(`#${id}`);
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('active'));
}

function hidePanel(id) {
  const el = $(`#${id}`);
  if (!el.classList.contains('active') && el.classList.contains('hidden')) {
    return; // 已经隐藏，不需要操作
  }
  el.classList.remove('active');
  if (panelTimeouts[id]) clearTimeout(panelTimeouts[id]);
  panelTimeouts[id] = setTimeout(() => {
    el.classList.add('hidden');
    panelTimeouts[id] = null;
  }, 300);
}

function showToast(msg) {
  const container = $('#toast-container');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

function spawnParticles(emoji, count, x, y) {
  const layer = $('#particles-layer');
  for (let i = 0; i < count; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.textContent = emoji;
    p.style.left = (x + randInt(-40, 40)) + 'px';
    p.style.top = (y + randInt(-20, 20)) + 'px';
    p.style.animationDelay = (i * 0.1) + 's';
    layer.appendChild(p);
    setTimeout(() => p.remove(), 1200);
  }
}

// 获取主导属性（决定性格）
function getDominantStat(pet) {
  if (!pet || !pet.stats) return null;
  let maxStat = STAT_NAMES[0];
  let maxVal = -1;
  STAT_NAMES.forEach(stat => {
    if (pet.stats[stat] > maxVal) {
      maxVal = pet.stats[stat];
      maxStat = stat;
    }
  });
  return maxStat;
}

// ===== 动作属性修正系统 =====
// 每个动作的数值修正配置：{ 主导属性: { 数值类型: 倍率 } }
const ACTION_MODIFIERS = {
  feed: {
    debugging: { hunger: 1.2 }  // 活力型：喂食饱食度+20%
  },
  play: {
    wisdom:    { happiness: 1.25 },  // 聪明型：玩耍快乐+25%
    debugging: { energy: 1.3 },      // 活力型：体力消耗+30%
    patience:  { energy: 0.75 }      // 温柔型：体力消耗-25%
  },
  clean: {
    patience: { clean: 1.15 },  // 温柔型：清洁度+15%
    chaos:    { clean: 0.8 }    // 调皮型：清洁度-20%
  },
  sleep: {
    snark:    { energy: 1.2 },   // 傲娇型：体力恢复+20%
    patience: { energy: 0.85 }   // 温柔型：体力恢复-15%
  },
  pet: {
    chaos: { happiness: 1.3 }    // 调皮型：抚摸快乐+30%
  }
};

// 根据主导属性修正动作数值
function applyActionModifier(pet, action, valueType, baseValue) {
  const dominant = getDominantStat(pet);
  if (!dominant) return baseValue;
  const actionMods = ACTION_MODIFIERS[action];
  if (!actionMods) return baseValue;
  const statMods = actionMods[dominant];
  if (!statMods) return baseValue;
  const multiplier = statMods[valueType];
  if (multiplier === undefined) return baseValue;
  return baseValue * multiplier;
}

function showSpeech(category) {
  const pet = gameState.pet;
  let lines = SPEECH_LINES[category];

  // 如果有宠物，尝试用性格台词
  if (pet) {
    const dominantStat = getDominantStat(pet);
    if (dominantStat && PERSONALITY_SPEECH[dominantStat] && PERSONALITY_SPEECH[dominantStat][category]) {
      lines = PERSONALITY_SPEECH[dominantStat][category];
    }
  }

  if (!lines) return;
  const text = pick(lines);
  const speechEl = $('#pet-speech');
  const textEl = $('#speech-text');
  textEl.textContent = text;
  speechEl.classList.remove('hidden');

  if (speechTimeout) clearTimeout(speechTimeout);
  speechTimeout = setTimeout(() => {
    speechEl.classList.add('hidden');
  }, 4000);
}

// 直接显示指定文字的气泡（用于属性提升等特殊提示）
function showSpeechCustom(text) {
  const pet = gameState.pet;
  if (!pet) return;
  const speechEl = $('#pet-speech');
  const textEl = $('#speech-text');
  if (!speechEl || !textEl) return;
  textEl.textContent = text;
  speechEl.classList.remove('hidden');

  if (speechTimeout) clearTimeout(speechTimeout);
  speechTimeout = setTimeout(() => {
    speechEl.classList.add('hidden');
  }, 3000);
}

function getMood() {
  if (!gameState.pet) return MOODS.neutral;
  const s = gameState.pet.status;
  const avg = (s.hunger + s.happiness + s.clean + s.energy + s.health) / 5;
  if (s.health < 30) return MOODS.sick;
  for (const [key, mood] of Object.entries(MOODS)) {
    if (avg >= mood.minAvg) return mood;
  }
  return MOODS.sick;
}

// ===== 孵化系统 =====
let hatchClicks = 0;
const HATCH_CLICKS_NEEDED = 5;

function initHatch() {
  hatchClicks = 0;
  const egg = $('#egg-container');
  const hint = $('#hatch-hint');
  const anim = $('#hatch-animation');
  const info = $('#hatch-info');

  egg.classList.remove('hidden');
  anim.classList.add('hidden');
  info.classList.add('hidden');
  hint.classList.remove('hidden');
  hint.textContent = '点击蛋来孵化你的宠物！';

  egg.onclick = function() {
    hatchClicks++;
    egg.classList.add('cracking');
    setTimeout(() => egg.classList.remove('cracking'), 500);

    if (hatchClicks >= HATCH_CLICKS_NEEDED) {
      egg.onclick = null;
      hatchPet();
    } else {
      hint.textContent = `再点击 ${HATCH_CLICKS_NEEDED - hatchClicks} 次！`;
    }
  };
}

function hatchPet() {
  const userId = generatePetId();
  const bones = generatePetBones(userId);
  const soul = generatePetSoul();

  // 显示孵化动画
  setTimeout(() => {
    $('#egg-container').classList.add('hidden');
    const anim = $('#hatch-animation');
    anim.classList.remove('hidden');
    $('#hatch-pet').textContent = bones.species.emoji;

    // 闪光效果
    if (bones.shiny) {
      $('#hatch-pet').style.filter = 'drop-shadow(0 0 20px gold) brightness(1.3)';
    }

    // 闪光粒子
    const sparkles = $('#hatch-sparkles');
    sparkles.innerHTML = '';
    for (let i = 0; i < 12; i++) {
      const sp = document.createElement('span');
      sp.textContent = '✨';
      sp.style.cssText = `position:absolute;font-size:${randInt(16,28)}px;
        left:${randInt(-60,60)}px;top:${randInt(-60,60)}px;
        animation:sparkle 0.8s ease ${i*0.08}s both;`;
      sparkles.appendChild(sp);
    }

    // 显示信息
    setTimeout(() => {
      const info = $('#hatch-info');
      info.classList.remove('hidden');
      $('#hatch-hint').classList.add('hidden');

      const badge = $('#hatch-rarity-badge');
      badge.textContent = `${bones.rarity.stars} ${bones.rarity.name}`;
      badge.className = `rarity-badge ${bones.rarity.id}`;

      if (bones.shiny) {
        $('#hatch-shiny-badge').classList.remove('hidden');
      } else {
        $('#hatch-shiny-badge').classList.add('hidden');
      }

      $('#hatch-species-name').textContent = `${bones.species.emoji} ${bones.species.name}`;
      $('#hatch-personality').textContent = `"${soul.personality}"`;

      // 属性预览
      const preview = $('#hatch-stats-preview');
      preview.innerHTML = '';
      STAT_NAMES.forEach(stat => {
        const item = document.createElement('div');
        item.className = 'stat-preview-item';
        item.innerHTML = `<span class="stat-name">${STAT_LABELS[stat].icon} ${STAT_LABELS[stat].name}</span> <span class="stat-val">${bones.stats[stat]}</span>`;
        preview.appendChild(item);
      });

      // 领养按钮
      $('#btn-adopt').onclick = function() {
        adoptPet(bones, soul);
      };
    }, 800);
  }, 600);
}

function adoptPet(bones, soul) {
  const gender = generatePetGender();
  gameState.pet = {
    id: generatePetId(),
    species: bones.species,
    rarity: bones.rarity,
    shiny: bones.shiny,
    hat: bones.hat,
    stats: bones.stats,
    peakStat: bones.peakStat,
    lowStat: bones.lowStat,
    name: soul.name,
    personality: soul.personality,
    gender: gender,
    stage: 1,
    evolveBranch: null,
    level: 1,
    exp: 0,
    expToNext: 100,
    status: {
      hunger: 80,
      happiness: 80,
      clean: 100,
      energy: 90,
      health: 100
    },
    isSleeping: false,
    equippedHat: null,
    equippedHatColor: null,
    hatchTime: Date.now(),
    skillPoints: 1,
    unlockedSkills: [],
    dominantStat: getDominantStat({ stats: bones.stats })
  };

  // 添加到图鉴
  if (!gameState.album.includes(bones.species.id)) {
    gameState.album.push(bones.species.id);
  }
  // 更新图鉴详细信息
  updateAlbumDetails(gameState.pet);

  gameState.records.hatchTime = Date.now();
  gameState.records.lastLogin = Date.now();

  // 添加到宠物收藏
  if (!gameState.petCollection) gameState.petCollection = [];
  gameState.petCollection.push(gameState.pet);
  gameState.activePetId = gameState.pet.id;

  saveGame();
  enterGame();
}

// 更新天气/日期显示
function updateWeatherDisplay() {
  const el = $('#weather-display');
  if (!el) return;
  const weather = getCurrentWeather();
  if (!weather) return;
  const season = getSeason();
  const now = new Date();
  const dateStr = `${now.getMonth()+1}/${now.getDate()}`;
  const weekDays = ['日','一','二','三','四','五','六'];
  const dayStr = `周${weekDays[now.getDay()]}`;

  let html = `<div>${dateStr} ${dayStr} ${season.icon}</div>`;
  html += `<div class="weather-icon">${weather.icon} ${weather.name}</div>`;

  // 如果天气有特殊效果，显示小提示
  const effects = weather.effects || {};
  const effectDescs = [];
  if (effects.happinessDecay && effects.happinessDecay < 1) effectDescs.push('心情衰减减缓');
  if (effects.happinessDecay && effects.happinessDecay > 1) effectDescs.push('心情衰减加速');
  if (effects.cleanDecay && effects.cleanDecay < 1) effectDescs.push('清洁衰减减缓');
  if (effects.cleanDecay && effects.cleanDecay > 1) effectDescs.push('清洁衰减加速');
  if (effects.energyDecay && effects.energyDecay < 1) effectDescs.push('体力衰减减缓');
  if (effects.energyDecay && effects.energyDecay > 1) effectDescs.push('体力衰减加速');
  if (effects.hungerDecay && effects.hungerDecay < 1) effectDescs.push('饥饿衰减减缓');
  if (effects.hungerDecay && effects.hungerDecay > 1) effectDescs.push('饥饿衰减加速');
  if (effects.allGain) effectDescs.push('全属性加成');
  if (effectDescs.length > 0) {
    html += `<div style="font-size:10px;color:#778;margin-top:2px;">${effectDescs.join(' · ')}</div>`;
  }

  el.innerHTML = html;
}

// ===== 主游戏界面 =====
function enterGame() {
  showScreen('game-screen');
  updateGameUI();
  updateWeatherDisplay();
  startDecay();
  startAutoSave();

  // 随机说话
  setTimeout(() => showSpeech('happy'), 1000);
  // 定期随机说话
  setInterval(() => {
    if (!gameState.pet?.isSleeping && Math.random() < 0.3) {
      showSpeech('idle');
    }
  }, 30000);
}

function updateGameUI() {
  const pet = gameState.pet;
  if (!pet) return;

  // 被动技能：状态最小值保护（每次 UI 刷新时检查）
  const passive = getPassiveEffects(pet);
  if (passive.minHealthBonus !== undefined) {
    const minHealth = passive.minHealthBonus;
    if (pet.status.health < minHealth) pet.status.health = minHealth;
  }
  if (passive.minHappinessBonus !== undefined) {
    const minHappiness = passive.minHappinessBonus;
    if (pet.status.happiness < minHappiness) pet.status.happiness = minHappiness;
  }

  // 名字和等级（包含头衔前缀后缀）
  const genderSym = getGenderSymbol(pet.gender);
  $('#pet-name-display').textContent = getPetDisplayName(pet) + genderSym;
  fitText($('#pet-name-display'), 180, 18, 10);
  $('#pet-level-badge').textContent = `Lv.${pet.level}`;

  // 金币
  $('#coin-count').textContent = gameState.coins;

  // 宠物精灵
  const sprite = $('#pet-sprite');
  const hatEmoji = pet.equippedHat ? HAT_EMOJI[pet.equippedHat] : '';
  const speciesEmoji = pet.species?.emoji || '';
  const hatFilter = getHatColorFilter(pet);
  if (hatEmoji) {
    sprite.innerHTML = `<span class="pet-hat" style="${hatFilter ? `filter:${hatFilter};` : ''}display:block;">${hatEmoji}</span><span class="pet-body">${speciesEmoji}</span>`;
  } else {
    sprite.innerHTML = speciesEmoji;
  }
  if (pet.shiny) {
    sprite.style.filter = 'drop-shadow(0 0 12px gold) brightness(1.2)';
  } else {
    sprite.style.filter = '';
  }
  sprite.style.whiteSpace = 'pre';

  // 更新主页段位图标
  const rankBadgeEl = $('#rank-badge-display');
  if (rankBadgeEl) {
    const currentRank = getCurrentRank();
    rankBadgeEl.textContent = currentRank.icon;
    rankBadgeEl.title = currentRank.name;
  }

  // 精灵动画状态
  sprite.className = 'pet-sprite';
  if (pet.isSleeping) {
    sprite.classList.add('sleeping');
  } else {
    const mood = getMood();
    if (mood === MOODS.sad || mood === MOODS.sick) {
      sprite.classList.add('sad');
    }
  }

  // 心情
  const mood = getMood();
  $('#mood-emoji').textContent = pet.isSleeping ? '💤' : mood.emoji;

  // 状态条
  const s = pet.status;
  updateStatBar('hunger', s.hunger);
  updateStatBar('happiness', s.happiness);
  updateStatBar('clean', s.clean);
  updateStatBar('energy', s.energy);
  updateStatBar('health', s.health);

  // EXP
  const expPct = (pet.exp / pet.expToNext) * 100;
  $('#bar-exp').style.width = expPct + '%';
  $('#exp-text').textContent = `${pet.exp} / ${pet.expToNext} EXP`;
}

function updateStatBar(stat, value) {
  $(`#bar-${stat}`).style.width = value + '%';
  $(`#val-${stat}`).textContent = Math.round(value);
}

// ===== 养成操作 =====
function doAction(action) {
  const pet = gameState.pet;
  if (!pet) return;

  if (pet.isSleeping && action !== 'pet') {
    showToast(`${pet.name} 正在睡觉...`);
    return;
  }

  switch(action) {
    case 'feed':
      feedPet();
      break;
    case 'play':
      playWithPet();
      break;
    case 'clean':
      cleanPet();
      break;
    case 'sleep':
      toggleSleep();
      break;
    case 'pet':
      petThePet();
      break;
    case 'heal':
      healPet();
      break;
  }
  gameState.lastInteractionTime = Date.now();
  saveGame();
  updateGameUI();
}

function feedPet() {
  const pet = gameState.pet;

  // 睡觉状态检查
  if (pet.isSleeping) {
    showToast('宠物正在睡觉，让它休息吧~');
    return;
  }

  // 随机事件：拒绝进食
  if (gameState._refuseEatUntil && Date.now() < gameState._refuseEatUntil) {
    const remaining = Math.ceil((gameState._refuseEatUntil - Date.now()) / 1000);
    showToast(`${pet.name}闹脾气呢，还要 ${remaining} 秒才能进食`);
    return;
  }

  // 饱食度检查
  if (pet.status.hunger >= 95) {
    // 隐藏计数：饱食时强行喂食
    if (gameState.hiddenCounters) {
      gameState.hiddenCounters.forceFeedCount++;
      if (gameState.hiddenCounters.forceFeedCount >= 20 && !gameState.achievements.unlocked.includes('hidden_glutton')) {
        gameState.achievements.unlocked.push('hidden_glutton');
        showToast('🎁 发现隐藏头衔：贪吃的！');
      }
    }
    showToast('宠物已经吃饱了');
    return;
  }

  gameState.lastActionTime = Date.now();

  // 使用背包中第一个食物，或默认喂食
  const foodInv = gameState.inventory.food;
  let foodItem = null;
  for (const [id, count] of Object.entries(foodInv)) {
    if (count > 0) {
      const item = SHOP_ITEMS.food.find(f => f.id === id);
      if (item) { foodItem = item; foodInv[id]--; if (foodInv[id] <= 0) delete foodInv[id]; break; }
    }
  }

  if (foodItem) {
    const passive = getPassiveEffects(pet);
    let feedMult = 1 + (passive.feedBonus || 0) + (passive.allCareBonus || 0);
    if (passive.feedDoubleChance && Math.random() < passive.feedDoubleChance) feedMult *= 2;
    if (passive.allDoubleChance && Math.random() < passive.allDoubleChance) feedMult *= 2;
    const hungerGain = applyActionModifier(pet, 'feed', 'hunger', foodItem.hunger || 20);
    pet.status.hunger = clamp(pet.status.hunger + Math.floor(hungerGain * feedMult), 0, 100);
    pet.status.happiness = clamp(pet.status.happiness + (foodItem.happiness || 5), 0, 100);
    if (passive.feedHappiness) pet.status.happiness = clamp(pet.status.happiness + passive.feedHappiness, 0, 100);
    if (passive.feedHealthRestore) pet.status.health = clamp(pet.status.health + passive.feedHealthRestore, 0, 100);
    showToast(`喂了 ${pet.name} ${foodItem.icon}${foodItem.name}`);
    // 记录使用的物品品质，用于成长概率
    pet._lastFoodQuality = foodItem.quality || 'common';
  } else {
    // 没有背包食物，消耗金币购买苹果
    if (gameState.coins < 5) {
      showToast('金币不足');
      return;
    }
    gameState.coins -= 5;
    const passive = getPassiveEffects(pet);
    let feedMult = 1 + (passive.feedBonus || 0) + (passive.allCareBonus || 0);
    if (passive.feedDoubleChance && Math.random() < passive.feedDoubleChance) feedMult *= 2;
    if (passive.allDoubleChance && Math.random() < passive.allDoubleChance) feedMult *= 2;
    const hungerGain = applyActionModifier(pet, 'feed', 'hunger', 15);
    pet.status.hunger = clamp(pet.status.hunger + Math.floor(hungerGain * feedMult), 0, 100);
    pet.status.happiness = clamp(pet.status.happiness + 5, 0, 100);
    if (passive.feedHappiness) pet.status.happiness = clamp(pet.status.happiness + passive.feedHappiness, 0, 100);
    if (passive.feedHealthRestore) pet.status.health = clamp(pet.status.health + passive.feedHealthRestore, 0, 100);
    showToast(`花费 5🪙 喂了 ${pet.name} 🍎苹果`);
    pet._lastFoodQuality = 'common';
  }

  gainExp(2);
  // 应用生活技能加成
  applyLifeSkillBonus('feed');
  // 操作成长：喂食 → 活力(debugging)，根据品质调整概率和成长量
  const foodQuality = pet._lastFoodQuality || 'common';
  const foodGrowProb = QUALITY_GROW_PROB[foodQuality] || 0.05;
  const foodGrowAmount = QUALITY_GROW_AMOUNT[foodQuality] || 1.0;
  tryGrowStat('debugging', foodGrowProb, foodGrowAmount);
  gameState.records.totalFeeds++;
  updateDailyTaskProgress('feed', 1);
  checkAchievements();
  showSpeech('feed');

  const sprite = $('#pet-sprite');
  sprite.classList.add('happy');
  setTimeout(() => sprite.classList.remove('happy'), 500);
  spawnParticles('🍖', 3, window.innerWidth/2, window.innerHeight/2);
}

function playWithPet() {
  const pet = gameState.pet;

  // 睡觉状态检查
  if (pet.isSleeping) {
    showToast('宠物正在睡觉，让它休息吧~');
    return;
  }

  // 生病状态检查
  if (pet.status.health < 30) {
    showToast('宠物身体不舒服，先治疗一下吧~');
    return;
  }

  // 开心值满了
  if (pet.status.happiness >= 95) {
    showToast('宠物已经很开心了！');
    return;
  }

  if (pet.status.energy < 20) {
    if (pet.status.energy < 10) {
      showToast('宠物精疲力竭了，必须睡觉！');
    } else {
      showToast('宠物太累了，让它休息一下吧！');
    }
    showSpeech('tired');
    return;
  }

  gameState.lastActionTime = Date.now();

  // 使用背包中第一个玩具，或消耗金币
  const toyInv = gameState.inventory.toys;
  let toyItem = null;
  for (const [id, count] of Object.entries(toyInv)) {
    if (count > 0) {
      const item = SHOP_ITEMS.toys.find(t => t.id === id);
      if (item) { toyItem = item; toyInv[id]--; if (toyInv[id] <= 0) delete toyInv[id]; break; }
    }
  }

  let happinessGain = 20;
  let energyCost = 15;
  let toyQuality = 'common';

  if (toyItem) {
    happinessGain = toyItem.happiness || 20;
    energyCost = Math.abs(toyItem.energy || -15);
    toyQuality = toyItem.quality || 'common';
    showToast(`和 ${pet.name} 玩了 ${toyItem.icon}${toyItem.name}`);
  } else {
    // 没有背包玩具，消耗金币
    if (gameState.coins < 10) {
      showToast('金币不足');
      return;
    }
    gameState.coins -= 10;
    showToast(`花费 10🪙 和 ${pet.name} 玩 ⚽球`);
  }

  // 应用属性修正
  happinessGain = applyActionModifier(pet, 'play', 'happiness', happinessGain);
  energyCost = applyActionModifier(pet, 'play', 'energy', energyCost);

  // 被动技能：玩耍加成
  const passive = getPassiveEffects(pet);
  let playMult = 1 + (passive.playBonus || 0) + (passive.allCareBonus || 0);
  if (passive.allDoubleChance && Math.random() < passive.allDoubleChance) playMult *= 2;

  pet.status.happiness = clamp(pet.status.happiness + Math.floor(happinessGain * playMult), 0, 100);
  pet.status.energy = clamp(pet.status.energy - energyCost, 0, 100);
  pet.status.hunger = clamp(pet.status.hunger - 5, 0, 100);

  // 应用生活技能加成
  applyLifeSkillBonus('play');

  gainExp(3);
  // 操作成长：玩耍 → 调皮(chaos)，根据品质调整概率和成长量
  const playGrowProb = QUALITY_GROW_PROB[toyQuality] || 0.05;
  const playGrowAmount = QUALITY_GROW_AMOUNT[toyQuality] || 1.0;
  tryGrowStat('chaos', playGrowProb, playGrowAmount);
  gameState.records.totalPlays++;
  updateDailyTaskProgress('play', 1);
  checkAchievements();
  showSpeech('play');

  const sprite = $('#pet-sprite');
  sprite.classList.add('excited');
  setTimeout(() => sprite.classList.remove('excited'), 1500);
  spawnParticles('🎾', 5, window.innerWidth/2, window.innerHeight/2);
}

function cleanPet() {
  const pet = gameState.pet;

  // 睡觉状态检查
  if (pet.isSleeping) {
    showToast('宠物正在睡觉，让它休息吧~');
    return;
  }

  // 生病状态检查
  if (pet.status.health < 30) {
    showToast('宠物身体不舒服，先治疗一下吧~');
    return;
  }

  // 清洁值满了
  if (pet.status.clean >= 95) {
    showToast('宠物已经很干净了！');
    return;
  }

  if (pet.status.energy < 20) {
    if (pet.status.energy < 10) {
      showToast('宠物精疲力竭了，必须睡觉！');
    } else {
      showToast('宠物太累了，让它休息一下吧！');
    }
    return;
  }

  gameState.lastActionTime = Date.now();

  let cleanGain = 30;
  cleanGain = applyActionModifier(pet, 'clean', 'clean', cleanGain);

  // 被动技能：清洁加成
  const passive = getPassiveEffects(pet);
  let cleanMult = 1 + (passive.cleanBonus || 0) + (passive.allCareBonus || 0);
  if (passive.allDoubleChance && Math.random() < passive.allDoubleChance) cleanMult *= 2;

  pet.status.clean = clamp(pet.status.clean + Math.floor(cleanGain * cleanMult), 0, 100);
  pet.status.happiness = clamp(pet.status.happiness + 5, 0, 100);
  pet.status.energy = clamp(pet.status.energy - 5, 0, 100);

  // 应用生活技能加成
  applyLifeSkillBonus('clean');

  gainExp(2);
  // 操作成长：清洁 → 温柔(patience)，按基础common概率
  tryGrowStat('patience', 0.05);
  gameState.records.totalCleans++;
  updateDailyTaskProgress('clean', 1);
  checkAchievements();
  showSpeech('clean');

  const sprite = $('#pet-sprite');
  sprite.classList.add('happy');
  setTimeout(() => sprite.classList.remove('happy'), 500);
  spawnParticles('✨', 4, window.innerWidth/2, window.innerHeight/2);
  spawnParticles('🫧', 3, window.innerWidth/2, window.innerHeight/2);
}

function toggleSleep() {
  const pet = gameState.pet;
  pet.isSleeping = !pet.isSleeping;

  if (pet.isSleeping) {
    showToast(`${pet.name} 开始睡觉了 💤`);
    showSpeech('sleep');
    gameState.records.totalSleeps++;
  } else {
    showToast(`${pet.name} 醒来了！`);
    refreshWeatherOnWake();
    let energyGain = 30;
    energyGain = applyActionModifier(pet, 'sleep', 'energy', energyGain);
    const passive = getPassiveEffects(pet);
    if (passive.sleepEnergyBonus) energyGain = Math.floor(energyGain * (1 + passive.sleepEnergyBonus));
    pet.status.energy = clamp(pet.status.energy + energyGain, 0, 100);
    // 应用生活技能加成
    applyLifeSkillBonus('sleep');
    // 操作成长：睡觉醒来 → 温柔(patience)，按基础common概率
    tryGrowStat('patience', 0.05);
  }

  gameState.lastActionTime = Date.now();
  gameState.lastInteractionTime = Date.now();
}

function petThePet() {
  const pet = gameState.pet;

  // 睡觉时抚摸没有反应
  if (pet.isSleeping) {
    // 隐藏计数：睡觉时抚摸
    if (gameState.hiddenCounters) {
      gameState.hiddenCounters.sleepPetCount++;
      if (gameState.hiddenCounters.sleepPetCount >= 15 && !gameState.achievements.unlocked.includes('hidden_dreamer')) {
        gameState.achievements.unlocked.push('hidden_dreamer');
        showToast('🎁 发现隐藏头衔：追梦的！');
      }
    }
    showToast('嘘...它正在睡觉呢');
    return;
  }

  // 开心值满了
  if (pet.status.happiness >= 95) {
    showToast('宠物已经很开心了！');
    return;
  }

  gameState.lastActionTime = Date.now();
  gameState.lastInteractionTime = Date.now();

  let happinessGain = 10;
  const dominant = getDominantStat(pet);

  // 傲娇型：30%概率反而减少快乐
  if (dominant === 'snark') {
    if (Math.random() < 0.3) {
      happinessGain = -5;
      showToast(`${pet.name} 傲娇地躲开了... 😼`);
    } else {
      happinessGain = applyActionModifier(pet, 'pet', 'happiness', happinessGain);
    }
  } else {
    happinessGain = applyActionModifier(pet, 'pet', 'happiness', happinessGain);
  }

  // 被动技能：抚摸加成
  const passive = getPassiveEffects(pet);
  let petMult = 1 + (passive.petBonus || 0) + (passive.allCareBonus || 0);
  if (passive.allDoubleChance && Math.random() < passive.allDoubleChance) petMult *= 2;

  pet.status.happiness = clamp(pet.status.happiness + Math.floor(happinessGain * petMult), 0, 100);
  if (passive.petEnergyRestore) pet.status.energy = clamp(pet.status.energy + passive.petEnergyRestore, 0, 100);

  gainExp(1);
  // 操作成长：抚摸 → 聪明(wisdom)，按基础common概率
  tryGrowStat('wisdom', 0.05);
  gameState.records.totalPets++;
  updateDailyTaskProgress('pet', 1);
  checkAchievements();
  showSpeech('pet');

  const sprite = $('#pet-sprite');
  sprite.classList.add('happy');
  setTimeout(() => sprite.classList.remove('happy'), 500);
  spawnParticles('❤️', 5, window.innerWidth/2, window.innerHeight/2);
}

function healPet() {
  const pet = gameState.pet;

  // 睡觉状态检查
  if (pet.isSleeping) {
    showToast('宠物正在睡觉，让它休息吧~');
    return;
  }

  if (pet.status.health >= 90) {
    showToast(`${pet.name} 很健康，不需要治疗`);
    return;
  }

  gameState.lastActionTime = Date.now();

  // 使用背包药品或默认治疗
  const medInv = gameState.inventory.medicine;
  let medItem = null;
  for (const [id, count] of Object.entries(medInv)) {
    if (count > 0) {
      const item = SHOP_ITEMS.medicine.find(m => m.id === id);
      if (item) { medItem = item; medInv[id]--; if (medInv[id] <= 0) delete medInv[id]; break; }
    }
  }

  if (medItem) {
    const passive = getPassiveEffects(pet);
    let healMult = 1 + (passive.healBonus || 0) + (passive.allCareBonus || 0);
    if (passive.allDoubleChance && Math.random() < passive.allDoubleChance) healMult *= 2;
    pet.status.health = clamp(pet.status.health + Math.floor((medItem.health || 25) * healMult), 0, 100);
    showToast(`给 ${pet.name} 使用了 ${medItem.icon}${medItem.name}`);
  } else {
    // 没有背包药品，消耗金币
    if (gameState.coins < 8) {
      showToast('金币不足');
      return;
    }
    gameState.coins -= 8;
    const passive = getPassiveEffects(pet);
    let healMult = 1 + (passive.healBonus || 0) + (passive.allCareBonus || 0);
    if (passive.allDoubleChance && Math.random() < passive.allDoubleChance) healMult *= 2;
    pet.status.health = clamp(pet.status.health + Math.floor(15 * healMult), 0, 100);
    showToast(`花费 8🪙 给 ${pet.name} 使用了 🌿草药`);
  }

  // 应用生活技能加成
  applyLifeSkillBonus('heal');

  gainExp(3);
  gameState.records.totalHeals++;
  updateDailyTaskProgress('heal', 1);
  checkAchievements();
  showSpeech('heal');
  spawnParticles('💊', 3, window.innerWidth/2, window.innerHeight/2);
}

// ===== 生活技能加成函数 =====
function applyLifeSkillBonus(action) {
  // 新版被动技能通过 passiveEffect 直接在对应系统中生效
  // 此函数保留接口兼容，暂时不执行逻辑
}

// ===== 经验与升级 =====
function gainExp(amount) {
  const pet = gameState.pet;
  if (!pet) return;

  // 稀有度加成
  const rarityMult = { common: 1, uncommon: 1.2, rare: 1.5, epic: 2, legendary: 3 };
  amount = Math.floor(amount * (rarityMult[pet.rarity.id] || 1));

  // 被动技能：经验加成
  const passive = getPassiveEffects(pet);
  let expMult = 1;
  if (passive.expBonus) expMult += passive.expBonus;
  if (passive.expReduce) expMult *= (1 - passive.expReduce);
  amount = Math.floor(amount * expMult);

  pet.exp += amount;

  while (pet.exp >= pet.expToNext) {
    pet.exp -= pet.expToNext;
    pet.level++;
    pet.expToNext = Math.floor(pet.expToNext * 1.3);

    // 升级奖励技能点
    pet.skillPoints = (pet.skillPoints || 0) + 1;

    // 升级奖励：五维属性成长
    STAT_NAMES.forEach(stat => {
      let gain = randInt(1, 3);
      if (stat === pet.peakStat) {
        gain += randInt(2, 4);
      }
      const mult = getGrowthMultiplier(pet, stat);
      addStat(pet, stat, gain * mult);
    });

    // 升级奖励
    const coinReward = pet.level * 10;
    gameState.coins += coinReward;
    gameState.records.totalCoinsEarned += coinReward;

    showToast(`🎉 ${pet.name} 升级到 Lv.${pet.level}！+${coinReward}🪙`);
    setTimeout(() => showToast(`✨ 获得1个技能点！(共${pet.skillPoints}点)`), 1500);
    showSpeech('levelup');

    const sprite = $('#pet-sprite');
    sprite.style.animation = 'levelUp 0.6s ease';
    setTimeout(() => sprite.style.animation = '', 600);
    spawnParticles('⭐', 8, window.innerWidth/2, window.innerHeight/2);
    // 升级时更新图鉴 maxLevel
    updateAlbumDetailsLevel(pet);
  }
}

// ===== 随机事件检查与触发 =====

// 检查并触发随机事件（在游戏循环中调用）
function checkRandomEvent() {
  const pet = gameState.pet;
  if (!pet) return;

  const now = Date.now();
  const lastEvent = gameState.lastEventTime || 0;
  const cooldown = gameState.eventCooldown || 180000;

  // 冷却时间内不触发
  if (now - lastEvent < cooldown) return;

  // 只有宠物清醒且不在对战/小游戏时才触发
  if (pet.isSleeping) return;
  if (activeMinigame) return;
  if (battleState && battleState.isRunning) return;

  // 触发概率：约每冷却期结束时有 30% 概率触发
  if (Math.random() > 0.3) {
    // 没触发，重置冷却计时器
    gameState.lastEventTime = now;
    return;
  }

  // 触发事件
  gameState.lastEventTime = now;

  // 权重选择事件（好事件和坏事件概率相当，特殊事件较少）
  const goodEvents = RANDOM_EVENTS.filter(e => e.type === 'good');
  const badEvents = RANDOM_EVENTS.filter(e => e.type === 'bad');
  const specialEvents = RANDOM_EVENTS.filter(e => e.type === 'special');

  let event;
  const passive = getPassiveEffects(pet);
  const goodBonus = passive.goodEventBonus || 0;
  const roll = Math.random();
  if (roll < 0.35 * (1 + goodBonus)) {
    event = goodEvents[Math.floor(Math.random() * goodEvents.length)];
  } else if (roll < 0.65) {
    event = badEvents[Math.floor(Math.random() * badEvents.length)];
  } else {
    event = specialEvents[Math.floor(Math.random() * specialEvents.length)];
  }

  if (!event) return;

  // 执行事件效果
  const petName = pet.name || '宠物';
  const desc = event.desc.replace('{pet}', petName);
  const result = event.effect(gameState);

  // 显示事件弹窗
  showEventPopup(event, desc, result);

  saveGame();
  updateGameUI();
}

// 显示事件弹窗
function showEventPopup(event, desc, result) {
  // 使用 toast 显示简单版
  const typeLabel = event.type === 'good' ? '✨ 好事' : event.type === 'bad' ? '😅 糟了' : '❓ 奇遇';
  showToast(`${typeLabel} | ${event.icon} ${desc}`);
  setTimeout(() => showToast(result), 1500);
}

// ===== 状态衰减 =====
function startDecay() {
  if (decayInterval) clearInterval(decayInterval);
  decayInterval = setInterval(() => {
    if (!gameState.pet) return;

    const pet = gameState.pet;
    const s = pet.status;

    // 获取天气衰减系数
    const weather = getCurrentWeather();
    const wfx = weather?.effects || {};

    // 自动睡觉：体力 < 5 且玩家 30 秒内没有操作
    if (s.energy < 5 && !pet.isSleeping && Date.now() - gameState.lastActionTime > 30000) {
      pet.isSleeping = true;
      gameState.records.totalSleeps++;
      showToast(`${pet.name} 太累了，自己睡着了...`);
      showSpeech('sleep');
    }

    // 体力 = 0 强制睡觉
    if (s.energy <= 0 && !pet.isSleeping) {
      pet.isSleeping = true;
      gameState.records.totalSleeps++;
      showToast(`${pet.name} 累倒了，强制进入睡眠...`);
      showSpeech('sleep');
    }

    if (pet.isSleeping) {
      // 睡觉时恢复体力，其他缓慢衰减（应用天气系数）
      s.energy = clamp(s.energy + 3, 0, 100);
      s.hunger = clamp(s.hunger - 0.5 * (wfx.hungerDecay || 1), 0, 100);
      s.clean = clamp(s.clean - 0.2 * (wfx.cleanDecay || 1), 0, 100);
      // 睡觉时快乐缓慢下降（-0.3/5s）
      s.happiness = clamp(s.happiness - 0.3 * (wfx.happinessDecay || 1), 0, 100);

      // 聪明型：体力满80就可能醒
      const dominant = getDominantStat(pet);
      const wakeThreshold = dominant === 'wisdom' ? 80 : 100;
      if (s.energy >= wakeThreshold) {
        pet.isSleeping = false;
        gameState.records.totalSleeps++;
        if (dominant === 'wisdom') {
          showToast(`${pet.name} 精神抖擞地醒来了（聪明型早醒）！`);
        } else {
          showToast(`${pet.name} 精神饱满地醒来了！`);
        }
        showSpeech('happy');
      }
    } else {
      // 清醒时正常衰减（应用天气系数）
      s.hunger = clamp(s.hunger - 1.2 * (wfx.hungerDecay || 1), 0, 100);
      // 快乐度基础衰减 -0.3/5s，超过60秒无互动则加速到 -1.0/5s
      const noInteraction = Date.now() - gameState.lastInteractionTime > 60000;
      const happinessDecay = noInteraction ? 1.0 : 0.3;
      s.happiness = clamp(s.happiness - happinessDecay * (wfx.happinessDecay || 1), 0, 100);
      s.clean = clamp(s.clean - 0.5 * (wfx.cleanDecay || 1), 0, 100);
      s.energy = clamp(s.energy - 0.6 * (wfx.energyDecay || 1), 0, 100);
    }

    // 健康受其他状态影响
    if (s.hunger < 20 || s.clean < 20 || s.energy < 10) {
      s.health = clamp(s.health - 1, 0, 100);
    } else if (s.hunger > 50 && s.clean > 50 && s.energy > 50) {
      s.health = clamp(s.health + 0.3, 0, 100);
    }

    // 被动技能：状态最小值保护
    const passive = getPassiveEffects(pet);
    if (passive.minHealthBonus !== undefined) {
      const minHealth = passive.minHealthBonus;
      if (s.health < minHealth) s.health = minHealth;
    }
    if (passive.minHappinessBonus !== undefined) {
      const minHappiness = passive.minHappinessBonus;
      if (s.happiness < minHappiness) s.happiness = minHappiness;
    }

    // 低状态警告
    if (s.hunger < 20 && Math.random() < 0.1) showSpeech('hungry');
    if (s.clean < 20 && Math.random() < 0.1) showSpeech('dirty');
    if (s.energy < 15 && !pet.isSleeping && Math.random() < 0.1) showSpeech('tired');
    if (s.health < 30 && Math.random() < 0.15) showSpeech('sick');

    // 随机事件检查
    checkRandomEvent();

    updateGameUI();
  }, 5000); // 每5秒衰减一次
}

function startAutoSave() {
  if (autoSaveInterval) clearInterval(autoSaveInterval);
  autoSaveInterval = setInterval(saveGame, 10000); // 10秒自动保存一次
}

// ===== 登录/注册界面逻辑 =====
// 切换到登录表单
function showLoginForm() {
  $('#login-form').classList.remove('hidden');
  $('#register-form').classList.add('hidden');
  // 清空输入
  $('#login-email').value = '';
  $('#login-password').value = '';
}

// 切换到注册表单
function showRegisterForm() {
  $('#login-form').classList.add('hidden');
  $('#register-form').classList.remove('hidden');
  // 清空输入
  $('#register-email').value = '';
  $('#register-password').value = '';
}

// 登录按钮处理
async function handleLogin() {
  const username = $('#login-email').value.trim();
  const password = $('#login-password').value;

  if (!username || !password) {
    showToast('请输入用户名和密码');
    return;
  }
  if (password.length < 4) {
    showToast('密码至少4位');
    return;
  }

  showToast('登录中...');
  const result = await loginUser(username, password);

  if (result.success) {
    currentUser = result.user;
    saveCurrentSession();
    showToast('登录成功！欢迎回来，' + currentUser.username);
    await enterGameAfterLogin();
  } else {
    showToast(result.error || '登录失败');
  }
}

// 注册按钮处理
async function handleRegister() {
  const username = $('#register-email').value.trim();
  const password = $('#register-password').value;

  if (!username || !password) {
    showToast('请输入用户名和密码');
    return;
  }
  if (username.length < 2) {
    showToast('用户名至少2个字符');
    return;
  }
  if (password.length < 6) {
    showToast('密码至少6位');
    return;
  }

  showToast('注册中...');
  const result = await registerUser(username, password);

  if (result.success) {
    currentUser = result.user;
    // 云注册后，确保 session 已建立（有些 Supabase 配置需要邮箱验证，这里自动登录一次）
    if (result.user.type === 'cloud' && supabase) {
      try {
        const email = username.includes('@') ? username : username + '@local.app';
        await supabase.auth.signInWithPassword({ email, password });
      } catch(e) {
        console.warn('注册后自动登录失败:', e);
      }
    }
    saveCurrentSession();
    showToast('注册成功！欢迎，' + currentUser.username);
    await enterGameAfterLogin();
  } else {
    showToast(result.error || '注册失败');
  }
}

// 计算离线时间并应用属性衰减
// 逻辑：离线时宠物优先睡觉恢复体力，等睡饱了再轻微活动，
// 但体力不会掉太低（最低保持50），确保用户回来时宠物有精神
function applyOfflineDecay() {
  const now = Date.now();
  const lastClose = gameState.lastCloseTime || gameState.records?.lastLogin;
  if (!lastClose || !gameState.pet) return { minsAway: 0, msg: null };

  const offlineSeconds = (now - lastClose) / 1000;
  const maxOfflineSeconds = 8 * 3600;
  const effectiveSeconds = Math.min(offlineSeconds, maxOfflineSeconds);
  const ticks = Math.floor(effectiveSeconds / 5);

  let sleptTicks = 0;
  let awakeTicks = 0;

  if (ticks > 0) {
    const pet = gameState.pet;
    const s = pet.status;

    // 被动技能：离线衰减减少
    const passive = getPassiveEffects(pet);
    const decayMult = 1 - Math.min(0.8, passive.decayReduce || 0);

    // 阶段一：优先睡觉恢复体力
    // 计算从当前体力恢复到100需要多少tick（每tick +3体力）
    const energyToFull = Math.max(0, 100 - s.energy);
    const sleepTicksNeeded = Math.ceil(energyToFull / 3);
    sleptTicks = Math.min(sleepTicksNeeded, ticks);

    for (let i = 0; i < sleptTicks; i++) {
      s.energy = clamp(s.energy + 3, 0, 100);
      s.hunger = clamp(s.hunger - 0.3 * decayMult, 0, 100);   // 睡觉消耗更慢
      s.clean = clamp(s.clean - 0.1 * decayMult, 0, 100);
      s.happiness = clamp(s.happiness - 0.1 * decayMult, 0, 100);
      if (s.hunger < 20 || s.clean < 20) {
        s.health = clamp(s.health - 0.2 * decayMult, 0, 100);
      } else {
        s.health = clamp(s.health + 0.3, 0, 100);
      }
    }

    // 阶段二：睡饱了，醒来轻微活动
    // 体力缓慢下降但不低于50，确保用户回来时有精神
    awakeTicks = ticks - sleptTicks;
    for (let i = 0; i < awakeTicks; i++) {
      s.hunger = clamp(s.hunger - 0.5 * decayMult, 0, 100);
      s.happiness = clamp(s.happiness - 0.3 * decayMult, 0, 100);
      s.clean = clamp(s.clean - 0.15 * decayMult, 0, 100);
      s.energy = clamp(s.energy - 0.15 * decayMult, 75, 100); // 最低保持75体力
      if (s.hunger < 20 || s.clean < 20 || s.happiness < 20) {
        s.health = clamp(s.health - 0.1 * decayMult, 0, 100);
      }
    }

    // 体力充足说明睡饱了，标记为醒着
    pet.isSleeping = s.energy < 30;
  }

  const minsAway = Math.floor((now - lastClose) / 60000);

  // 生成离线提示
  let msg = null;
  if (offlineSeconds >= 60) {
    const displaySeconds = Math.min(offlineSeconds, maxOfflineSeconds);
    const hours = Math.floor(displaySeconds / 3600);
    const minutes = Math.floor((displaySeconds % 3600) / 60);
    let timeStr = '';
    if (hours > 0) {
      timeStr = `${hours}小时${minutes}分钟`;
    } else {
      timeStr = `${minutes}分钟`;
    }

    const pet = gameState.pet;
    const s = pet.status;
    let statusDesc = '';
    if (sleptTicks > 0 && awakeTicks === 0) {
      statusDesc = `一直在睡觉，休息得很好`;
    } else if (s.energy >= 90) {
      statusDesc = `睡饱了精神满满`;
    } else if (s.energy >= 50) {
      statusDesc = `休息得不错`;
    } else if (s.hunger < 20) {
      statusDesc = `饿得肚子咕咕叫`;
    } else if (s.health < 30) {
      statusDesc = `看起来不太舒服`;
    } else {
      statusDesc = `有点困了`;
    }
    msg = `你离开了 ${timeStr}，${pet.name} ${statusDesc}`;
  }

  return { minsAway, msg };
}

// 登录/注册成功后进入游戏
async function enterGameAfterLogin() {
  try {
    // 尝试加载用户存档
    const userData = await loadUserData();

    if (userData && userData.pet) {
      // 有存档，加载进来
      gameState = { ...createInitialState(), ...userData };
      // 确保字段完整性
      ensureGameStateDefaults();

      // 初始化每日任务（必须在加载存档后调用，避免被旧存档覆盖）
      initDailyTasks();

      // 计算离线时间
      const { minsAway, msg } = applyOfflineDecay();
      gameState.records.lastLogin = Date.now();

      saveGame();
      enterGame();
      setTimeout(() => checkAchievements(), 1000);

      // 显示离线提示
      if (msg) {
        setTimeout(() => showToast(msg), 800);
      }
    } else {
      // 没有存档，走新用户流程（孵化画面）
      gameState = createInitialState();
      showScreen('hatch-screen');
    }
  } catch(e) {
    console.error('进入游戏时出错，使用新存档:', e);
    // 出错了也能玩，用新存档
    gameState = createInitialState();
    showScreen('hatch-screen');
  }
}

// 游客模式（本地通用存档）
function enterGuestMode() {
  currentUser = null;
  cloudSaveEnabled = false;
  saveCurrentSession();

  const hasSave = loadGame();
  if (hasSave && gameState.pet) {
    // 有本地存档
    // 初始化每日任务（必须在加载存档后调用，避免被旧存档覆盖）
    initDailyTasks();
    // 计算离线时间
    const { minsAway, msg } = applyOfflineDecay();
    gameState.records.lastLogin = Date.now();
    saveGame();
    enterGame();
    setTimeout(() => checkAchievements(), 1000);

    if (msg) {
      setTimeout(() => showToast(msg), 800);
    }
  } else {
    gameState = createInitialState();
    showScreen('hatch-screen');
    initHatch();
  }
}

// 确保 gameState 所有字段都有默认值
function ensureGameStateDefaults() {
  if (!gameState.petCollection) gameState.petCollection = gameState.pet ? [gameState.pet] : [];
  if (!gameState.activePetId && gameState.pet) gameState.activePetId = gameState.pet.id;
  if (!gameState.battleStats) gameState.battleStats = { total: 0, wins: 0, losses: 0, closeWins: 0, streak: 0, maxStreak: 0, rankPoints: 0, rank: 'tap_water' };
  if (gameState.battleStats.closeWins === undefined) gameState.battleStats.closeWins = 0;
  if (!gameState.pvpStats) gameState.pvpStats = { total: 0, wins: 0, losses: 0 };
  if (!gameState.achievements) gameState.achievements = { unlocked: [], claimed: [] };
  if (!gameState.dailyTasks) gameState.dailyTasks = { date: null, tasks: [], claimedAll: false };
  if (!gameState.records) gameState.records = {};
  if (!gameState.records.totalBreeds) gameState.records.totalBreeds = 0;
  if (!gameState.records.totalEvolves) gameState.records.totalEvolves = 0;
  if (gameState.breedSlot1 === undefined) gameState.breedSlot1 = null;
  if (gameState.breedSlot2 === undefined) gameState.breedSlot2 = null;
  if (!gameState.breedHistory) gameState.breedHistory = {};
  if (!gameState.importedPets) gameState.importedPets = [];
  if (!gameState.importedPetIds) gameState.importedPetIds = [];
  if (!gameState.leaderboards) gameState.leaderboards = { catch: [], memory: [], quiz: [], gomoku: [] };
  if (!gameState.album) gameState.album = [];
  if (!gameState.albumDetails) gameState.albumDetails = {};
  if (!gameState.settings) gameState.settings = { sound: true };
  if (gameState.coins === undefined) gameState.coins = 100;
  if (!gameState.inventory) gameState.inventory = { food: {}, toys: {}, medicine: {}, cosmetics: {} };
  if (!gameState.lastActionTime) gameState.lastActionTime = Date.now();
  if (!gameState.lastInteractionTime) gameState.lastInteractionTime = Date.now();
  if (gameState.lastCloseTime === undefined) gameState.lastCloseTime = null;

  // 天气/事件字段默认值
  if (!gameState.weather) gameState.weather = null;
  if (!gameState.weatherDate) gameState.weatherDate = null;
  if (!gameState.lastEventTime) gameState.lastEventTime = null;
  if (!gameState.eventCooldown) gameState.eventCooldown = 180000;

  // 隐藏计数器默认值（确保子字段存在）
  if (!gameState.hiddenCounters) {
    gameState.hiddenCounters = {
      consecutiveLoginDays: 0,
      lastLoginDate: null,
      consecutiveBattleLosses: 0,
      forceFeedCount: 0,
      sleepPetCount: 0,
    };
  } else {
    if (gameState.hiddenCounters.consecutiveLoginDays === undefined) gameState.hiddenCounters.consecutiveLoginDays = 0;
    if (gameState.hiddenCounters.lastLoginDate === undefined) gameState.hiddenCounters.lastLoginDate = null;
    if (gameState.hiddenCounters.consecutiveBattleLosses === undefined) gameState.hiddenCounters.consecutiveBattleLosses = 0;
    if (gameState.hiddenCounters.forceFeedCount === undefined) gameState.hiddenCounters.forceFeedCount = 0;
    if (gameState.hiddenCounters.sleepPetCount === undefined) gameState.hiddenCounters.sleepPetCount = 0;
  }

  // 迁移宠物字段
  function migratePet(pet) {
    if (!pet) return pet;
    if (!pet.gender) pet.gender = Math.random() < 0.5 ? 'male' : 'female';
    if (pet.stage === undefined) pet.stage = 1;
    if (pet.evolveBranch === undefined) pet.evolveBranch = null;
    if (pet.equippedHatColor === undefined) pet.equippedHatColor = null;
    // 技能系统字段
    if (!pet.skillPoints) pet.skillPoints = 0;
    if (!pet.unlockedSkills) pet.unlockedSkills = [];
    // 锁定优势属性（防止后期培养导致技能树切换）
    if (!pet.dominantStat && pet.stats) pet.dominantStat = getDominantStat(pet);
    // 状态字段补全
    if (!pet.status) pet.status = {};
    if (pet.status.hunger === undefined) pet.status.hunger = 80;
    if (pet.status.happiness === undefined) pet.status.happiness = 80;
    if (pet.status.clean === undefined) pet.status.clean = 100;
    if (pet.status.energy === undefined) pet.status.energy = 90;
    if (pet.status.health === undefined) pet.status.health = 100;
    return pet;
  }
  if (gameState.pet) migratePet(gameState.pet);
  if (gameState.petCollection) gameState.petCollection.forEach(migratePet);
  if (gameState.importedPets) gameState.importedPets.forEach(migratePet);
}

// 获取当前天气（如果没天气或日期变了就生成新的）
function getCurrentWeather() {
  const today = new Date().toISOString().split('T')[0];
  if (gameState.weather && gameState.weatherDate === today) {
    return gameState.weather;
  }
  // 生成新天气
  const pool = getSeasonWeatherPool();
  const weatherId = pool[Math.floor(Math.random() * pool.length)];
  const weather = WEATHER_TYPES.find(w => w.id === weatherId) || WEATHER_TYPES[0];
  gameState.weather = weather;
  gameState.weatherDate = today;
  return weather;
}

// 宠物睡醒时刷新天气
function refreshWeatherOnWake() {
  const pool = getSeasonWeatherPool();
  const weatherId = pool[Math.floor(Math.random() * pool.length)];
  const weather = WEATHER_TYPES.find(w => w.id === weatherId) || WEATHER_TYPES[0];
  gameState.weather = weather;
  gameState.weatherDate = new Date().toISOString().split('T')[0];
  const season = getSeason();
  showToast(`${weather.icon} 醒来啦！今天${season.name}${weather.name} ${weather.desc}`);
  updateWeatherDisplay();
}

// 创建初始游戏状态
function createInitialState() {
  return {
    pet: null, coins: 100,
    inventory: { food: {}, toys: {}, medicine: {}, cosmetics: {} },
    album: [], records: { totalFeeds: 0, totalPlays: 0, totalCleans: 0, totalSleeps: 0,
      totalPets: 0, totalHeals: 0, totalGamesPlayed: 0, totalCoinsEarned: 0,
      totalBreeds: 0, totalEvolves: 0, hatchTime: null, lastLogin: null },
    settings: { sound: true }, version: 2,
    petCollection: [], activePetId: null,
    battleStats: { total: 0, wins: 0, losses: 0, closeWins: 0, streak: 0, maxStreak: 0, rankPoints: 0, rank: 'tap_water' },
    pvpStats: { total: 0, wins: 0, losses: 0 },
    achievements: { unlocked: [], claimed: [] },
    dailyTasks: { date: null, tasks: [], claimedAll: false },
    breedSlot1: null, breedSlot2: null, breedHistory: {},
    importedPets: [], importedPetIds: [],
    leaderboards: { catch: [], memory: [], quiz: [], gomoku: [] },
    albumDetails: {},
    lastActionTime: Date.now(),
    lastInteractionTime: Date.now(),
    lastCloseTime: null,
    // 隐藏计数器（用于极难获取的隐藏头衔）
    hiddenCounters: {
      consecutiveLoginDays: 0,      // 连续登录天数
      lastLoginDate: null,           // 上次登录日期
      consecutiveBattleLosses: 0,     // 连续对战失败次数
      forceFeedCount: 0,             // 饱食时强行喂食次数
      sleepPetCount: 0,              // 睡觉时抚摸次数
    },
    // 季节/天气系统
    weather: null,        // 当前天气对象
    weatherDate: null,    // 当前天气的日期（YYYY-MM-DD）
    // 随机事件系统
    lastEventTime: null,       // 上次事件触发时间
    eventCooldown: 180000,     // 事件冷却时间（毫秒，默认3分钟）
  };
}

// 更新设置弹窗中的账号信息
function updateSettingsAccountInfo() {
  const nameEl = $('#settings-account-name');
  const typeEl = $('#settings-save-type');
  const logoutBtn = $('#btn-logout');

  if (currentUser) {
    nameEl.textContent = currentUser.username;
    if (currentUser.type === 'cloud') {
      typeEl.textContent = '☁️ 云端存档';
      typeEl.className = 'save-type-badge cloud';
    } else {
      typeEl.textContent = '📱 本地账号';
      typeEl.className = 'save-type-badge';
    }
    logoutBtn.style.display = '';
    logoutBtn.textContent = '切换账号';
  } else {
    nameEl.textContent = '游客模式';
    typeEl.textContent = '📱 本地存档';
    typeEl.className = 'save-type-badge';
    logoutBtn.style.display = '';
    logoutBtn.textContent = '登录账号';
  }
}

// ===== 属性面板 =====
function openStatsPanel() {
  const pet = gameState.pet;
  if (!pet) return;

  $('#stats-pet-sprite').textContent = getPetDisplayEmoji(pet);
  $('#stats-pet-sprite').style.whiteSpace = 'pre';
  if (pet.shiny) {
    $('#stats-pet-sprite').style.filter = 'drop-shadow(0 0 12px gold)';
  } else {
    $('#stats-pet-sprite').style.filter = '';
  }

  $('#stats-pet-name').textContent = getPetDisplayName(pet);
  const badge = $('#stats-rarity-badge');
  badge.textContent = pet.rarity.stars;
  badge.className = `rarity-badge-sm ${pet.rarity.id}`;
  badge.style.background = pet.rarity.color;
  badge.style.color = pet.rarity.id === 'epic' ? '#333' : '#fff';

  if (pet.shiny) {
    $('#stats-shiny-badge').classList.remove('hidden');
  } else {
    $('#stats-shiny-badge').classList.add('hidden');
  }

  $('#stats-pet-personality').textContent = `"${pet.personality}"`;
  const stageText = pet.stage > 1 ? ` · ${pet.stage}阶` : '';
  $('#stats-pet-species').textContent = `${pet.species.name} · ${pet.rarity.name}${pet.shiny ? ' · ✨闪光' : ''}${stageText}`;

  // 显示本体技能
  const baseSpecies = getBaseSpecies(pet.species);
  const speciesSkill = SPECIES_SKILLS[baseSpecies?.id];
  const skillInfoEl = $('#stats-species-skill');
  if (skillInfoEl && speciesSkill) {
    skillInfoEl.textContent = `天赋技能：${speciesSkill.name} — ${speciesSkill.desc}`;
    skillInfoEl.classList.remove('hidden');
  } else if (skillInfoEl) {
    skillInfoEl.classList.add('hidden');
  }

  // 属性详情
  const detail = $('#stats-detail');
  detail.innerHTML = '';
  const statCap = getStatCap(pet);
  STAT_NAMES.forEach(stat => {
    const label = STAT_LABELS[stat];
    const val = pet.stats[stat];
    const intVal = Math.floor(val);
    const progressPct = (val / statCap) * 100;
    const isPeak = stat === pet.peakStat;
    const isLow = stat === pet.lowStat;
    const row = document.createElement('div');
    row.className = 'stat-detail-row';
    row.innerHTML = `
      <div>
        <div class="stat-detail-name">${label.icon} ${label.name} ${isPeak ? '⬆️' : ''} ${isLow ? '⬇️' : ''}</div>
        <div class="stat-detail-desc">${label.desc}</div>
        <div class="stat-detail-battle" style="font-size:11px;color:#666;margin-top:2px;">💡 ${label.battle}</div>
      </div>
      <div class="stat-detail-value" style="color:${isPeak ? '#00B894' : isLow ? '#E17055' : '#A29BFE'}">
        <div style="text-align:right;">${intVal}<span style="font-size:10px;opacity:0.6;">/${statCap}</span></div>
        <div style="width:60px;height:4px;background:rgba(255,255,255,0.1);border-radius:2px;margin-top:2px;overflow:hidden;">
          <div style="width:${progressPct}%;height:100%;background:${isPeak ? '#00B894' : isLow ? '#E17055' : '#A29BFE'};border-radius:2px;"></div>
        </div>
      </div>
    `;
    detail.appendChild(row);
  });

  // 雷达图
  drawRadarChart();

  // 养成记录
  const records = $('#stats-records');
  const r = gameState.records;
  // 陪伴天数按自然天计算（跨日期即算一天，不按24小时）
  function getNaturalDays(hatchTime) {
    if (!hatchTime) return 0;
    const hatchDate = new Date(hatchTime);
    const nowDate = new Date();
    hatchDate.setHours(0, 0, 0, 0);
    nowDate.setHours(0, 0, 0, 0);
    return Math.floor((nowDate - hatchDate) / 86400000);
  }
  const age = getNaturalDays(r.hatchTime);
  records.innerHTML = `
    <div class="record-item"><span class="label">陪伴天数</span><span class="value">${age} 天</span></div>
    <div class="record-item"><span class="label">等级</span><span class="value">Lv.${pet.level}</span></div>
    <div class="record-item"><span class="label">喂食次数</span><span class="value">${r.totalFeeds}</span></div>
    <div class="record-item"><span class="label">玩耍次数</span><span class="value">${r.totalPlays}</span></div>
    <div class="record-item"><span class="label">清洁次数</span><span class="value">${r.totalCleans}</span></div>
    <div class="record-item"><span class="label">休息次数</span><span class="value">${r.totalSleeps}</span></div>
    <div class="record-item"><span class="label">抚摸次数</span><span class="value">${r.totalPets}</span></div>
    <div class="record-item"><span class="label">治疗次数</span><span class="value">${r.totalHeals}</span></div>
    <div class="record-item"><span class="label">游戏次数</span><span class="value">${r.totalGamesPlayed}</span></div>
    <div class="record-item"><span class="label">累计金币</span><span class="value">🪙 ${r.totalCoinsEarned}</span></div>
  `;

  updateStatsSkillsSummary();
  showPanel('stats-panel');
}

function drawRadarChart() {
  const canvas = $('#radar-canvas');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  const cx = w/2, cy = h/2;
  const r = 100;

  ctx.clearRect(0, 0, w, h);

  // 背景网格
  for (let i = 1; i <= 5; i++) {
    ctx.beginPath();
    const gr = r * (i / 5);
    for (let j = 0; j < 5; j++) {
      const angle = (Math.PI * 2 * j / 5) - Math.PI / 2;
      const x = cx + gr * Math.cos(angle);
      const y = cy + gr * Math.sin(angle);
      j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.stroke();
  }

  // 轴线
  for (let j = 0; j < 5; j++) {
    const angle = (Math.PI * 2 * j / 5) - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.stroke();
  }

  // 数据区域
  const pet = gameState.pet;
  const statCap = getStatCap(pet);
  ctx.beginPath();
  STAT_NAMES.forEach((stat, j) => {
    const val = pet.stats[stat] / statCap;
    const angle = (Math.PI * 2 * j / 5) - Math.PI / 2;
    const x = cx + r * val * Math.cos(angle);
    const y = cy + r * val * Math.sin(angle);
    j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(108, 92, 231, 0.3)';
  ctx.fill();
  ctx.strokeStyle = '#A29BFE';
  ctx.lineWidth = 2;
  ctx.stroke();

  // 数据点 + 标签
  STAT_NAMES.forEach((stat, j) => {
    const val = pet.stats[stat] / statCap;
    const angle = (Math.PI * 2 * j / 5) - Math.PI / 2;
    const x = cx + r * val * Math.cos(angle);
    const y = cy + r * val * Math.sin(angle);

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#A29BFE';
    ctx.fill();

    // 标签
    const lx = cx + (r + 20) * Math.cos(angle);
    const ly = cy + (r + 20) * Math.sin(angle);
    ctx.fillStyle = '#8888AA';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(STAT_LABELS[stat].name, lx, ly);
  });
}

// ===== 商店系统 =====
function openShop() {
  $('#shop-coins').textContent = gameState.coins;
  renderShopItems();
  showPanel('shop-panel');
}

function renderShopItems() {
  const grid = $('#shop-items');
  grid.innerHTML = '';
  const items = SHOP_ITEMS[currentShopTab] || [];

  items.forEach(item => {
    const owned = gameState.inventory[currentShopTab]?.[item.id] || 0;
    const div = document.createElement('div');
    div.className = 'shop-item';

    if (currentShopTab === 'cosmetics') {
      // 装扮类特殊处理
      const isOwned = owned > 0;
      const isEquipped = gameState.pet && gameState.pet.equippedHat === item.hatType;
      let bottomHtml;
      if (isOwned) {
        if (isEquipped) {
          // 已装备 - 显示颜色选择器（如果支持变色）和已装备按钮
          let colorPickerHtml = '';
          if (item.hasColor) {
            colorPickerHtml = '<div class="hat-color-picker">';
            HAT_COLORS.forEach(color => {
              if (color.id === 'default') return;
              const isActive = gameState.pet.equippedHatColor === color.id ||
                (!gameState.pet.equippedHatColor && color.id === 'red');
              const bgStyle = getColorBgStyle(color.id);
              colorPickerHtml += `<span class="hat-color-dot ${isActive ? 'active' : ''}" style="${bgStyle}" data-color="${color.id}" title="${color.name}"></span>`;
            });
            colorPickerHtml += '</div>';
          }
          bottomHtml = `${colorPickerHtml}<button class="shop-item-equipped" disabled>已装备 ✓</button>`;
        } else {
          bottomHtml = `<button class="shop-item-equip">装扮</button>`;
        }
      } else {
        bottomHtml = `<div class="shop-item-price">🪙 ${item.price}</div>`;
      }
      div.innerHTML = `
        <div class="shop-item-icon">${item.icon}</div>
        <div class="shop-item-name">${item.name}</div>
        <div class="shop-item-desc">${item.desc}</div>
        <div class="shop-item-rarity shop-rarity-${item.rarity || 'common'}">${getRarityLabel(item.rarity || 'common')}</div>
        ${bottomHtml}
      `;
      if (isOwned && !isEquipped) {
        div.querySelector('.shop-item-equip').onclick = (e) => {
          e.stopPropagation();
          equipCosmetic(item);
        };
      } else if (isOwned && isEquipped && item.hasColor) {
        // 绑定颜色选择器事件
        div.querySelectorAll('.hat-color-dot').forEach(dot => {
          dot.onclick = (e) => {
            e.stopPropagation();
            changeHatColor(dot.dataset.color);
          };
        });
      } else if (!isOwned) {
        div.onclick = () => buyItem(item);
      }
    } else {
      // 普通商品
      div.innerHTML = `
        <div class="shop-item-icon">${item.icon}</div>
        <div class="shop-item-name">${item.name}</div>
        <div class="shop-item-desc">${item.desc}</div>
        ${owned > 0 ? `<div class="shop-item-owned">拥有: ${owned}</div>` : ''}
        <div class="shop-item-price">🪙 ${item.price}</div>
      `;
      div.onclick = () => buyItem(item);
    }
    grid.appendChild(div);
  });
}

function equipCosmetic(item) {
  if (!gameState.pet) {
    showToast('没有宠物！');
    return;
  }
  gameState.pet.equippedHat = item.hatType;
  gameState.pet.equippedHatColor = null; // 重置颜色
  showToast(`已装备 ${item.icon}${item.name}`);
  renderShopItems();
  updateGameUI();
  saveGame();
}

function buyItem(item) {
  // 被动技能：商店折扣
  const passive = getPassiveEffects(gameState.pet);
  const discount = 1 - Math.min(0.5, passive.shopDiscount || 0);
  const finalPrice = Math.floor(item.price * discount);

  if (gameState.coins < finalPrice) {
    showToast('金币不足！');
    return;
  }

  gameState.coins -= finalPrice;
  if (!gameState.inventory[currentShopTab]) gameState.inventory[currentShopTab] = {};
  gameState.inventory[currentShopTab][item.id] = (gameState.inventory[currentShopTab][item.id] || 0) + 1;

  // 如果是装扮，自动装备
  if (currentShopTab === 'cosmetics' && item.hatType && gameState.pet) {
    gameState.pet.equippedHat = item.hatType;
    gameState.pet.equippedHatColor = null; // 重置颜色
    showToast(`购买了 ${item.icon}${item.name}，已装备！`);
  } else {
    showToast(`购买了 ${item.icon}${item.name}`);
  }

  $('#shop-coins').textContent = gameState.coins;
  $('#coin-count').textContent = gameState.coins;
  renderShopItems();
  updateGameUI();
  saveGame();
}

// ===== 迷你游戏 =====
// 更新排行榜
function updateLeaderboard(game, score) {
  if (!gameState.leaderboards[game]) gameState.leaderboards[game] = [];
  const board = gameState.leaderboards[game];
  const entry = { score: score, date: Date.now(), petName: gameState.pet?.name || '未知' };
  board.push(entry);
  board.sort((a, b) => b.score - a.score);
  // 只保留前5名
  while (board.length > 5) board.pop();
  // 检查是否上榜
  const rank = board.findIndex(e => e === entry);
  return rank >= 0 && rank < 5 ? rank + 1 : 0;
}

// 获取游戏最高分
function getHighScore(game) {
  const board = gameState.leaderboards[game];
  if (!board || board.length === 0) return 0;
  // 五子棋的score存的是负步数，转换为正步数显示
  if (game === 'gomoku') return -board[0].score;
  return board[0].score;
}

function openGamesPanel() {
  // 更新每个游戏卡片的最高分
  const gameCards = $$('.game-card');
  gameCards.forEach(card => {
    const gameType = card.dataset.game;
    const highScore = getHighScore(gameType);
    let scoreEl = card.querySelector('.game-highscore');
    if (!scoreEl) {
      scoreEl = document.createElement('div');
      scoreEl.className = 'game-highscore';
      scoreEl.style.cssText = 'font-size:12px;color:#FDCB6E;margin-top:4px;';
      card.appendChild(scoreEl);
    }
    scoreEl.textContent = highScore > 0 ? `🏆 最高分: ${highScore}` : '';
  });
  showPanel('games-panel');
}

// 接接乐
function startCatchGame() {
  const overlay = $('#minigame-overlay');
  overlay.classList.remove('hidden');
  $('#minigame-title').textContent = '🎯 接接乐';
  $('#minigame-canvas').classList.remove('hidden');
  $('#minigame-ui').classList.add('hidden');

  const canvas = $('#minigame-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth;
  canvas.height = canvas.offsetHeight;

  let score = 0;
  let basketX = canvas.width / 2;
  let items = [];
  let gameRunning = true;
  let spawnTimer = 0;
  let timeLeft = 30;
  let timeInterval;

  const foodEmojis = ['🍎', '🍕', '🎂', '🍣', '🥩', '🧁', '🍩', '🍪'];
  const badEmojis = ['💣', '🪨'];

  // 触摸/鼠标控制
  function moveBasket(x) {
    basketX = clamp(x, 30, canvas.width - 30);
  }

  canvas.ontouchmove = (e) => { e.preventDefault(); moveBasket(e.touches[0].clientX - canvas.getBoundingClientRect().left); };
  canvas.onmousemove = (e) => moveBasket(e.clientX - canvas.getBoundingClientRect().left);
  canvas.ontouchstart = (e) => { e.preventDefault(); moveBasket(e.touches[0].clientX - canvas.getBoundingClientRect().left); };

  function spawnItem() {
    const isBad = Math.random() < 0.2;
    items.push({
      x: randInt(30, canvas.width - 30),
      y: -20,
      speed: 2 + Math.random() * 2 + score * 0.05,
      emoji: isBad ? pick(badEmojis) : pick(foodEmojis),
      bad: isBad,
      size: 24
    });
  }

  function update() {
    if (!gameRunning) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 背景
    ctx.fillStyle = '#0A0A15';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 篮子
    ctx.font = '36px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🧺', basketX, canvas.height - 30);

    // 掉落物
    items.forEach((item, i) => {
      item.y += item.speed;

      // 检测碰撞
      if (item.y > canvas.height - 60 && Math.abs(item.x - basketX) < 35) {
        if (item.bad) {
          score = Math.max(0, score - 5);
          spawnParticles('💥', 2, item.x, item.y);
        } else {
          score += 10;
          spawnParticles('✨', 2, item.x, item.y);
        }
        items.splice(i, 1);
        return;
      }

      // 超出屏幕
      if (item.y > canvas.height + 20) {
        items.splice(i, 1);
        return;
      }

      ctx.font = item.size + 'px sans-serif';
      ctx.fillText(item.emoji, item.x, item.y);
    });

    // 生成新物品
    spawnTimer++;
    if (spawnTimer > Math.max(15, 40 - score * 0.3)) {
      spawnItem();
      spawnTimer = 0;
    }

    // 时间显示
    ctx.fillStyle = '#888';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`⏱️ ${timeLeft}s`, 10, 25);

    $('#minigame-score').textContent = `分数: ${score}`;

    if (gameRunning) requestAnimationFrame(update);
  }

  timeInterval = setInterval(() => {
    timeLeft--;
    if (timeLeft <= 0) {
      gameRunning = false;
      clearInterval(timeInterval);
      endCatchGame(score);
    }
  }, 1000);

  update();
}

function endCatchGame(score) {
  const passive = getPassiveEffects(gameState.pet);
  const coinMult = 1 + (passive.gameCoinBonus || 0);
  const reward = Math.floor((Math.floor(score * 0.5) + 5) * coinMult);
  if (passive.coinDoubleChance && Math.random() < passive.coinDoubleChance) reward *= 2;
  gameState.coins += reward;
  gameState.records.totalCoinsEarned += reward;
  gameState.records.totalGamesPlayed++;
  gameState.lastInteractionTime = Date.now();
  updateDailyTaskProgress('game', 1);
  checkAchievements();

  // 更新排行榜
  const rank = updateLeaderboard('catch', score);

  const canvas = $('#minigame-canvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0A0A15';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#EAEAEA';
  ctx.font = 'bold 24px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('游戏结束！', canvas.width/2, canvas.height/2 - 40);
  ctx.font = '18px sans-serif';
  ctx.fillText(`得分: ${score}`, canvas.width/2, canvas.height/2);
  ctx.fillStyle = '#FDCB6E';
  ctx.fillText(`获得 🪙${reward}`, canvas.width/2, canvas.height/2 + 35);
  if (rank > 0) {
    ctx.fillStyle = '#00B894';
    ctx.fillText(`🎉 排行榜第 ${rank} 名！`, canvas.width/2, canvas.height/2 + 65);
  }

  setTimeout(() => {
    closeMinigame();
    showToast(`接接乐结束！得分 ${score}，获得 🪙${reward}`);
    saveGame();
    updateGameUI();
  }, 2500);
}

// 记忆翻牌
function startMemoryGame() {
  const overlay = $('#minigame-overlay');
  overlay.classList.remove('hidden');
  $('#minigame-title').textContent = '🧠 记忆翻牌';
  $('#minigame-canvas').classList.add('hidden');

  const ui = $('#minigame-ui');
  ui.classList.remove('hidden');

  const emojis = ['🐱', '🐶', '🐰', '🐻', '🦊', '🐼', '🐨', '🦁'];
  let cards = [...emojis, ...emojis];
  // 洗牌
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }

  let flipped = [];
  let matched = 0;
  let moves = 0;
  let canFlip = true;

  ui.innerHTML = '<div class="memory-grid" id="memory-grid"></div>';
  const grid = document.getElementById('memory-grid');

  cards.forEach((emoji, i) => {
    const card = document.createElement('div');
    card.className = 'memory-card';
    card.textContent = '?';
    card.dataset.index = i;
    card.dataset.emoji = emoji;
    card.onclick = () => flipCard(card);
    grid.appendChild(card);
  });

  function flipCard(card) {
    if (!canFlip || card.classList.contains('flipped') || card.classList.contains('matched')) return;

    card.classList.add('flipped');
    card.textContent = card.dataset.emoji;
    flipped.push(card);

    if (flipped.length === 2) {
      moves++;
      canFlip = false;
      $('#minigame-score').textContent = `步数: ${moves}`;

      if (flipped[0].dataset.emoji === flipped[1].dataset.emoji) {
        flipped[0].classList.add('matched');
        flipped[1].classList.add('matched');
        matched++;
        flipped = [];
        canFlip = true;

        if (matched === emojis.length) {
          setTimeout(() => endMemoryGame(moves), 500);
        }
      } else {
        setTimeout(() => {
          flipped[0].classList.remove('flipped');
          flipped[0].textContent = '?';
          flipped[1].classList.remove('flipped');
          flipped[1].textContent = '?';
          flipped = [];
          canFlip = true;
        }, 800);
      }
    }
  }
}

function endMemoryGame(moves) {
  const passive = getPassiveEffects(gameState.pet);
  const coinMult = 1 + (passive.gameCoinBonus || 0);
  const reward = Math.floor(Math.max(15, 50 - moves * 2) * coinMult);
  if (passive.coinDoubleChance && Math.random() < passive.coinDoubleChance) reward *= 2;
  gameState.coins += reward;
  gameState.records.totalCoinsEarned += reward;
  gameState.records.totalGamesPlayed++;
  gameState.lastInteractionTime = Date.now();
  updateDailyTaskProgress('game', 1);
  checkAchievements();

  // 更新排行榜（记忆游戏步数越少越好，用负分表示）
  const score = 100 - moves;
  const rank = updateLeaderboard('memory', score);
  if (rank > 0) {
    setTimeout(() => showToast(`🎉 记忆翻牌排行榜第 ${rank} 名！`), 500);
  }

  closeMinigame();
  showToast(`记忆翻牌完成！${moves} 步，获得 🪙${reward}`);
  saveGame();
  updateGameUI();
}

// 宠物问答
function startQuizGame() {
  const overlay = $('#minigame-overlay');
  overlay.classList.remove('hidden');
  $('#minigame-title').textContent = '❓ 宠物问答';
  $('#minigame-canvas').classList.add('hidden');

  const ui = $('#minigame-ui');
  ui.classList.remove('hidden');

  let questions = [...QUIZ_QUESTIONS].sort(() => Math.random() - 0.5).slice(0, 5);
  let currentQ = 0;
  let score = 0;

  function showQuestion() {
    if (currentQ >= questions.length) {
      endQuizGame(score);
      return;
    }

    const q = questions[currentQ];
    // 随机打乱选项顺序，确保正确答案索引对应更新
    const indices = q.opts.map((_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    const shuffledOpts = indices.map(i => q.opts[i]);
    const correctIdx = indices.indexOf(q.ans);
    ui.innerHTML = `
      <div class="quiz-question">第 ${currentQ + 1}/${questions.length} 题<br>${q.q}</div>
      <div class="quiz-options">
        ${shuffledOpts.map((opt, i) => `<div class="quiz-option" data-idx="${i}">${opt}</div>`).join('')}
      </div>
    `;

    ui.querySelectorAll('.quiz-option').forEach(opt => {
      opt.onclick = () => {
        const idx = parseInt(opt.dataset.idx);
        const options = ui.querySelectorAll('.quiz-option');
        options.forEach(o => o.style.pointerEvents = 'none');

        if (idx === correctIdx) {
          opt.classList.add('correct');
          score++;
          $('#minigame-score').textContent = `正确: ${score}/${currentQ + 1}`;
        } else {
          opt.classList.add('wrong');
          options[correctIdx].classList.add('correct');
          $('#minigame-score').textContent = `正确: ${score}/${currentQ + 1}`;
        }

        setTimeout(() => {
          currentQ++;
          showQuestion();
        }, 1000);
      };
    });
  }

  $('#minigame-score').textContent = `正确: 0/0`;
  showQuestion();
}

// ===== 五子棋小游戏 =====
function startGomokuGame() {
  const overlay = $('#minigame-overlay');
  overlay.classList.remove('hidden');
  $('#minigame-title').textContent = '⚫⚪ 五子棋';
  
  const canvas = $('#minigame-canvas');
  canvas.classList.remove('hidden');
  const ui = $('#minigame-ui');
  ui.classList.add('hidden');

  const SIZE = 15;
  const CELL = Math.min(20, Math.floor((Math.min(window.innerWidth, 400) - 40) / SIZE));
  const BOARD_PX = CELL * (SIZE - 1) + 40;
  canvas.width = BOARD_PX;
  canvas.height = BOARD_PX + 50;
  const ctx = canvas.getContext('2d');

  const board = Array.from({ length: SIZE }, () => Array(SIZE).fill(0)); // 0空 1黑(玩家) 2白(AI)
  let gameOver = false;
  let playerTurn = true;
  let lastMove = null;
  let moveCount = 0; // 记录总步数（每方落子都算）

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // 背景
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 棋盘背景
    const ox = 20, oy = 20;
    ctx.fillStyle = '#d4a76a';
    ctx.fillRect(ox - CELL/2, oy - CELL/2, CELL * (SIZE-1) + CELL, CELL * (SIZE-1) + CELL);
    
    // 网格线
    ctx.strokeStyle = '#8B6914';
    ctx.lineWidth = 1;
    for (let i = 0; i < SIZE; i++) {
      ctx.beginPath();
      ctx.moveTo(ox, oy + i * CELL);
      ctx.lineTo(ox + (SIZE-1) * CELL, oy + i * CELL);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ox + i * CELL, oy);
      ctx.lineTo(ox + i * CELL, oy + (SIZE-1) * CELL);
      ctx.stroke();
    }
    
    // 星位
    const stars = [3, 7, 11];
    ctx.fillStyle = '#8B6914';
    stars.forEach(r => stars.forEach(c => {
      ctx.beginPath();
      ctx.arc(ox + c * CELL, oy + r * CELL, 3, 0, Math.PI * 2);
      ctx.fill();
    }));
    
    // 棋子
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c] === 0) continue;
        const x = ox + c * CELL, y = oy + r * CELL;
        // 阴影
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.beginPath();
        ctx.arc(x + 2, y + 2, CELL * 0.4, 0, Math.PI * 2);
        ctx.fill();
        // 棋子
        const grd = ctx.createRadialGradient(x - 3, y - 3, 2, x, y, CELL * 0.4);
        if (board[r][c] === 1) {
          grd.addColorStop(0, '#555');
          grd.addColorStop(1, '#000');
        } else {
          grd.addColorStop(0, '#fff');
          grd.addColorStop(1, '#ccc');
        }
        ctx.fillStyle = grd;
        ctx.beginPath();
        ctx.arc(x, y, CELL * 0.4, 0, Math.PI * 2);
        ctx.fill();
        // 最后落子标记
        if (lastMove && lastMove[0] === r && lastMove[1] === c) {
          ctx.strokeStyle = '#f44';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, CELL * 0.45, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }
    
    // 状态文字
    ctx.fillStyle = '#dde';
    ctx.font = '14px sans-serif';
    ctx.textAlign = 'center';
    const statusText = gameOver ? '游戏结束' : (playerTurn ? '轮到你了(黑⚫)' : 'AI思考中(白⚪)');
    ctx.fillText(statusText, canvas.width / 2, canvas.height - 10);
  }

  function checkWin(row, col, player) {
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    for (const [dr, dc] of dirs) {
      let count = 1;
      for (let d = -1; d <= 1; d += 2) {
        for (let i = 1; i < 5; i++) {
          const nr = row + dr * i * d, nc = col + dc * i * d;
          if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE || board[nr][nc] !== player) break;
          count++;
        }
      }
      if (count >= 5) return true;
    }
    return false;
  }

  // 简单AI：评分系统
  function aiMove() {
    let bestScore = -1, bestMoves = [];
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        if (board[r][c] !== 0) continue;
        // 只考虑周围有棋子的位置
        let hasNeighbor = false;
        for (let dr = -2; dr <= 2 && !hasNeighbor; dr++) {
          for (let dc = -2; dc <= 2 && !hasNeighbor; dc++) {
            if (dr === 0 && dc === 0) continue;
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < SIZE && nc >= 0 && nc < SIZE && board[nr][nc] !== 0) hasNeighbor = true;
          }
        }
        if (!hasNeighbor) continue;

        // 评估进攻分和防守分
        let score = 0;
        board[r][c] = 2;
        score += evaluatePos(r, c, 2) * 1.1; // 进攻略高权重
        board[r][c] = 1;
        score += evaluatePos(r, c, 1); // 防守
        board[r][c] = 0;

        // 中心偏好
        score += (7 - Math.abs(r - 7)) * 0.1 + (7 - Math.abs(c - 7)) * 0.1;

        if (score > bestScore) { bestScore = score; bestMoves = [{r, c}]; }
        else if (score === bestScore) bestMoves.push({r, c});
      }
    }
    if (bestMoves.length === 0) {
      // 棋盘空或没有邻居，下中心
      board[7][7] = 2;
      lastMove = [7, 7];
    } else {
      const move = bestMoves[Math.floor(Math.random() * bestMoves.length)];
      board[move.r][move.c] = 2;
      lastMove = [move.r, move.c];
    }
    moveCount++;
  }

  function evaluatePos(row, col, player) {
    const dirs = [[0,1],[1,0],[1,1],[1,-1]];
    let totalScore = 0;
    for (const [dr, dc] of dirs) {
      let count = 1, openEnds = 0;
      for (let d = -1; d <= 1; d += 2) {
        let blocked = false;
        for (let i = 1; i <= 4; i++) {
          const nr = row + dr * i * d, nc = col + dc * i * d;
          if (nr < 0 || nr >= SIZE || nc < 0 || nc >= SIZE) { blocked = true; break; }
          if (board[nr][nc] === player) count++;
          else if (board[nr][nc] === 0) { openEnds++; break; }
          else { blocked = true; break; }
        }
      }
      // 评分
      if (count >= 5) totalScore += 100000;
      else if (count === 4 && openEnds === 2) totalScore += 10000;
      else if (count === 4 && openEnds === 1) totalScore += 1000;
      else if (count === 3 && openEnds === 2) totalScore += 1000;
      else if (count === 3 && openEnds === 1) totalScore += 100;
      else if (count === 2 && openEnds === 2) totalScore += 100;
      else if (count === 2 && openEnds === 1) totalScore += 10;
      else if (count === 1 && openEnds === 2) totalScore += 10;
    }
    return totalScore;
  }

  // 点击事件
  canvas.onclick = (e) => {
    if (gameOver || !playerTurn) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const ox = 20, oy = 20;
    const col = Math.round((px - ox) / CELL);
    const row = Math.round((py - oy) / CELL);
    if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) return;
    if (board[row][col] !== 0) return;

    board[row][col] = 1;
    lastMove = [row, col];
    moveCount++;

    if (checkWin(row, col, 1)) {
      gameOver = true;
      draw();
      const passive = getPassiveEffects(gameState.pet);
      const coinMult = 1 + (passive.gameCoinBonus || 0);
      const reward = Math.floor((20 + Math.floor(Math.random() * 31)) * coinMult); // 20-50
      if (passive.coinDoubleChance && Math.random() < passive.coinDoubleChance) reward *= 2;
      gameState.coins += reward;
      gameState.records.totalCoinsEarned += reward;
      gameState.records.totalGamesPlayed++;
      gameState.lastInteractionTime = Date.now();
      updateDailyTaskProgress('game', 1);
      // 步数越少越好，用负数让排行榜降序排列时步数少的排前面
      updateLeaderboard('gomoku', -moveCount);
      checkAchievements();
      saveGame();
      setTimeout(() => {
        closeMinigame();
        showToast(`五子棋${moveCount}步获胜！获得 🪙${reward}`);
        updateGameUI();
      }, 1500);
      return;
    }

    playerTurn = false;
    draw();
    setTimeout(() => {
      aiMove();
      if (checkWin(lastMove[0], lastMove[1], 2)) {
        gameOver = true;
        draw();
        gameState.records.totalGamesPlayed++;
        gameState.lastInteractionTime = Date.now();
        updateDailyTaskProgress('game', 1);
        saveGame();
        setTimeout(() => {
          closeMinigame();
          showToast('五子棋惜败，再接再厉！');
          updateGameUI();
        }, 1500);
        return;
      }
      // 检查平局
      let full = true;
      for (let r = 0; r < SIZE && full; r++)
        for (let c = 0; c < SIZE && full; c++)
          if (board[r][c] === 0) full = false;
      if (full) {
        gameOver = true;
        draw();
        const passive = getPassiveEffects(gameState.pet);
        const coinMult = 1 + (passive.gameCoinBonus || 0);
        const reward = Math.floor(10 * coinMult);
        if (passive.coinDoubleChance && Math.random() < passive.coinDoubleChance) reward *= 2;
        gameState.coins += reward;
        gameState.records.totalCoinsEarned += reward;
        gameState.records.totalGamesPlayed++;
        gameState.lastInteractionTime = Date.now();
        updateDailyTaskProgress('game', 1);
        saveGame();
        setTimeout(() => {
          closeMinigame();
          showToast(`五子棋平局！获得 🪙${reward}`);
          updateGameUI();
        }, 1500);
        return;
      }
      playerTurn = true;
      draw();
    }, 300);
  };

  draw();
}

function endQuizGame(score) {
  const passive = getPassiveEffects(gameState.pet);
  const coinMult = 1 + (passive.gameCoinBonus || 0);
  const reward = Math.floor((20 + score * 6) * coinMult);
  if (passive.coinDoubleChance && Math.random() < passive.coinDoubleChance) reward *= 2;
  gameState.coins += reward;
  gameState.records.totalCoinsEarned += reward;
  gameState.records.totalGamesPlayed++;
  gameState.lastInteractionTime = Date.now();
  updateDailyTaskProgress('game', 1);
  checkAchievements();

  // 隐藏成就：全零分
  if (score === 0 && !gameState.achievements.unlocked.includes('hidden_quiz_fail')) {
    gameState.achievements.unlocked.push('hidden_quiz_fail');
    setTimeout(() => showToast('🎁 发现隐藏头衔：学渣！'), 1500);
  }

  // 更新排行榜
  const rank = updateLeaderboard('quiz', score);

  const ui = $('#minigame-ui');
  ui.innerHTML = `
    <div class="quiz-question">🎉 答题结束！<br>答对 ${score}/5 题<br><span style="color:#FDCB6E">获得 🪙${reward}</span>
    ${rank > 0 ? `<br><span style="color:#00B894">🏆 排行榜第 ${rank} 名！</span>` : ''}
    </div>
  `;

  setTimeout(() => {
    closeMinigame();
    showToast(`问答结束！答对 ${score} 题，获得 🪙${reward}`);
    saveGame();
    updateGameUI();
  }, 2000);
}

function closeMinigame() {
  $('#minigame-overlay').classList.add('hidden');
  $('#minigame-canvas').classList.remove('hidden');
  $('#minigame-ui').classList.add('hidden');
  $('#minigame-ui').innerHTML = '';
  // 清理五子棋等 canvas 事件监听器，防止关闭后残留点击
  const canvas = $('#minigame-canvas');
  if (canvas) canvas.onclick = null;
  activeMinigame = null;
}

// ===== 图鉴系统 =====
function openAlbum() {
  const grid = $('#album-grid');
  grid.innerHTML = '';

  const discovered = gameState.album.length;
  const total = SPECIES_LIST.length;
  const pct = total > 0 ? Math.floor((discovered / total) * 100) : 0;
  $('#album-progress').textContent = `图鉴收集进度: ${discovered}/${total} (${pct}%)`;

  SPECIES_LIST.forEach(species => {
    const isDiscovered = gameState.album.includes(species.id);
    const detail = isDiscovered ? (gameState.albumDetails && gameState.albumDetails[species.id]) : null;
    const card = document.createElement('div');
    card.className = `album-card ${isDiscovered ? 'discovered' : 'undiscovered'}`;

    if (isDiscovered) {
      // 已发现：显示详细信息
      const rarityObj = RARITIES.find(r => r.id === (detail?.highestRarity || 'common')) || RARITIES[0];
      card.innerHTML = `
        <div class="album-card-icon" style="white-space:pre;line-height:1.2;font-size:28px;">${species.emoji}</div>
        <div class="album-card-name">${species.name}</div>
        <div class="album-card-rarity" style="color:${rarityObj.color}">${rarityObj.stars} ${rarityObj.name}</div>
        <div class="album-card-detail">Lv.${detail?.maxLevel || '?'} | ${detail?.totalOwned || '?'}只</div>
      `;
      card.style.cursor = 'pointer';
      card.onclick = () => showAlbumDetail(species, detail);
    } else {
      // 未发现：显示剪影
      const stageLabel = species.stage > 1 ? ` [${species.stage}阶]` : '';
      let undiscoveredText = '未发现';
      if (species.stage === 2 || species.stage === 3) {
        undiscoveredText = '进化获得';
      } else {
        undiscoveredText = '可能发现';
      }
      card.innerHTML = `
        <div class="album-card-icon" style="white-space:pre;line-height:1.2;font-size:28px;filter:grayscale(1);">❓</div>
        <div class="album-card-name">???</div>
        <div class="album-card-rarity" style="color:#555">${undiscoveredText}${stageLabel}</div>
      `;
    }

    grid.appendChild(card);
  });

  showPanel('album-panel');
}

// 显示图鉴物种详细信息面板
function showAlbumDetail(species, detail) {
  const rarityObj = RARITIES.find(r => r.id === (detail?.highestRarity || 'common')) || RARITIES[0];
  // 查找收藏中该物种的宠物
  const petsOfSpecies = (gameState.petCollection || []).filter(p => p.species?.id === species.id);
  const hasShiny = petsOfSpecies.some(p => p.shiny);

  const dateStr = detail?.firstDiscoveredAt
    ? new Date(detail.firstDiscoveredAt).toLocaleDateString('zh-CN')
    : '未知';

  // 用 toast 或在 grid 上方展开详情
  // 使用一个详情覆盖区域
  let detailPanel = $('#album-detail-overlay');
  if (!detailPanel) {
    detailPanel = document.createElement('div');
    detailPanel.id = 'album-detail-overlay';
    detailPanel.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:50;display:flex;align-items:center;justify-content:center;padding:20px;';
    document.getElementById('app').appendChild(detailPanel);
  }
  detailPanel.classList.remove('hidden');
  detailPanel.innerHTML = `
    <div style="background:#1A1A2E;border-radius:16px;padding:24px;max-width:320px;width:100%;text-align:center;">
      <div style="font-size:56px;margin-bottom:8px;white-space:pre;">${species.emoji}</div>
      <h3 style="font-size:20px;font-weight:700;margin-bottom:4px;">${species.name}</h3>
      <p style="font-size:13px;color:#8888AA;margin-bottom:12px;">${species.desc || ''}</p>
      <div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:16px;">
        <span style="padding:4px 12px;border-radius:8px;font-size:12px;font-weight:700;background:${rarityObj.color};color:#fff;">${rarityObj.name}</span>
        ${hasShiny ? '<span style="padding:4px 12px;border-radius:8px;font-size:12px;font-weight:700;background:linear-gradient(90deg,#FFD700,#FFA500);color:#333;">闪光</span>' : ''}
      </div>
      <div style="text-align:left;background:rgba(255,255,255,0.05);border-radius:12px;padding:12px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13px;">
          <span style="color:#888;">最高等级</span><span style="font-weight:700;color:#FDCB6E;">Lv.${detail?.maxLevel || 0}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13px;">
          <span style="color:#888;">累计拥有</span><span style="font-weight:700;">${detail?.totalOwned || 0} 只</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:13px;">
          <span style="color:#888;">发现时间</span><span style="font-weight:700;">${dateStr}</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;">
          <span style="color:#888;">进化次数</span><span style="font-weight:700;">${detail?.evolutions || 0} 次</span>
        </div>
      </div>
      <button class="btn btn-secondary" id="btn-album-detail-close" style="width:100%;">关闭</button>
    </div>
  `;
  detailPanel.querySelector('#btn-album-detail-close').onclick = () => {
    detailPanel.classList.add('hidden');
  };
}

// ===== 事件绑定 =====
function bindEvents() {
  // 开始按钮
  $('#btn-start').onclick = () => {
    const hasSave = loadGame();
    if (hasSave && gameState.pet) {
      initDailyTasks();
      const { msg } = applyOfflineDecay();
      gameState.records.lastLogin = Date.now();
      saveGame();
      enterGame();

      if (msg) {
        setTimeout(() => showToast(msg), 800);
      }
    } else {
      showScreen('hatch-screen');
      initHatch();
    }
  };

  // 操作按钮
  $$('.btn-action').forEach(btn => {
    btn.onclick = () => doAction(btn.dataset.action);
  });

  // 宠物点击
  $('#pet-sprite').onclick = (e) => {
    const pet = gameState.pet;
    if (pet && pet.isSleeping) {
      showToast('嘘...它正在睡觉呢');
      return;
    }
    petThePet();
    spawnParticles('❤️', 3, e.clientX || window.innerWidth/2, e.clientY || window.innerHeight/2);
    saveGame();
    updateGameUI();
  };

  // 底部导航
  $$('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      $$('.nav-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.dataset.tab;

      // 关闭所有面板
      ['stats-panel', 'shop-panel', 'games-panel', 'album-panel', 'skill-tree-panel', 'evolve-panel'].forEach(p => hidePanel(p));

      switch(currentTab) {
        case 'stats': openStatsPanel(); break;
        case 'shop': openShop(); break;
        case 'games': openGamesPanel(); break;
        case 'album': openAlbum(); break;
      }
    };
  });

  // 面板返回
  $('#btn-stats-back').onclick = () => {
    hidePanel('stats-panel');
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    $$('.nav-btn')[0].classList.add('active');
    currentTab = 'home';
  };
  $('#btn-shop-back').onclick = () => {
    hidePanel('shop-panel');
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    $$('.nav-btn')[0].classList.add('active');
    currentTab = 'home';
    updateGameUI();
  };
  $('#btn-games-back').onclick = () => {
    hidePanel('games-panel');
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    $$('.nav-btn')[0].classList.add('active');
    currentTab = 'home';
  };
  $('#btn-album-back').onclick = () => {
    hidePanel('album-panel');
    $$('.nav-btn').forEach(b => b.classList.remove('active'));
    $$('.nav-btn')[0].classList.add('active');
    currentTab = 'home';
  };

  // 商店标签
  $$('.shop-tab').forEach(tab => {
    tab.onclick = () => {
      $$('.shop-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentShopTab = tab.dataset.shopTab;
      renderShopItems();
    };
  });

  // 迷你游戏
  $$('.game-card').forEach(card => {
    card.onclick = () => {
      switch(card.dataset.game) {
        case 'catch': startCatchGame(); break;
        case 'memory': startMemoryGame(); break;
        case 'quiz': startQuizGame(); break;
        case 'gomoku': startGomokuGame(); break;
      }
    };
  });

  $('#btn-minigame-close').onclick = closeMinigame;

  // 设置
  $('#btn-settings').onclick = () => {
    $('#settings-modal').classList.remove('hidden');
    $('#input-rename').value = gameState.pet?.name || '';
    $('#toggle-sound').checked = gameState.settings.sound;
    // 填充头衔下拉选项
    populateTitleSelects();
    // 更新预览
    updateTitlePreview();
    // 更新账号信息
    updateSettingsAccountInfo();
  };
  $('#btn-settings-close').onclick = () => {
    $('#settings-modal').classList.add('hidden');
  };

  // 登出/切换账号
  $('#btn-logout').onclick = () => {
    if (currentUser) {
      // 已登录用户：确认切换账号
      if (confirm('确定要切换账号吗？当前进度已自动保存。')) {
        $('#settings-modal').classList.add('hidden');
        // 先保存
        saveGame();
        // 登出
        logoutUser();
      }
    } else {
      // 游客模式：跳转到登录页
      $('#settings-modal').classList.add('hidden');
      saveGame();
      showScreen('login-screen');
      showLoginForm();
    }
  };

  // 云存档测试 + 存档诊断
  $('#btn-test-cloud').onclick = async () => {
    // 收集诊断信息
    const diagnostics = [];

    // 1. 基本信息
    diagnostics.push('📋 存档诊断报告');
    diagnostics.push('─────────────');
    diagnostics.push(`用户类型: ${currentUser ? (currentUser.type + (currentUser.offline ? ' (离线)' : '')) : '未登录'}`);
    diagnostics.push(`云存档启用: ${cloudSaveEnabled ? '是' : '否'}`);
    diagnostics.push(`Supabase: ${supabase ? '已初始化' : '未初始化'}`);

    // 2. 本地存储检测
    let localStorageOk = false;
    try {
      localStorage.setItem('test_key', 'test');
      localStorage.removeItem('test_key');
      localStorageOk = true;
      diagnostics.push(`localStorage: 正常`);
    } catch(e) {
      diagnostics.push(`localStorage: 不可用 (${e.message})`);
    }

    // 3. IndexedDB 检测
    let idbOk = false;
    try {
      if (window.indexedDB) {
        diagnostics.push(`IndexedDB: 浏览器支持`);
        // 尝试读取当前用户数据
        if (currentUser) {
          const idbData = await loadFromIDB(currentUser.id);
          diagnostics.push(`IndexedDB存档: ${idbData && idbData.pet ? '有数据 🟢' : '无数据 🔴'}`);
          if (idbData && idbData.pet) {
            diagnostics.push(`  宠物: ${idbData.pet.name || '未命名'} (${idbData.pet.species || '未知'})`);
          }
          idbOk = !!(idbData && idbData.pet);
        }
      } else {
        diagnostics.push(`IndexedDB: 浏览器不支持`);
      }
    } catch(e) {
      diagnostics.push(`IndexedDB: 检测失败 (${e.message})`);
    }

    // 4. localStorage 用户存档检测
    if (currentUser && localStorageOk) {
      const localData = loadLocalUserData(currentUser.id);
      diagnostics.push(`本地用户存档: ${localData && localData.pet ? '有数据 🟢' : '无数据 🔴'}`);
      if (localData && localData.pet) {
        diagnostics.push(`  宠物: ${localData.pet.name || '未命名'} (${localData.pet.species || '未知'})`);
        diagnostics.push(`  等级: ${localData.pet.level || 1} | 年龄: ${localData.pet.age || 0}天`);
      }

      // 通用存档
      try {
        const generalData = localStorage.getItem(SAVE_KEY);
        if (generalData) {
          const parsed = JSON.parse(generalData);
          diagnostics.push(`通用缓存存档: ${parsed && parsed.pet ? '有数据' : '无宠物数据'}`);
        } else {
          diagnostics.push(`通用缓存存档: 无`);
        }
      } catch(e) {}

      // IndexedDB 全局备份
      try {
        const idbBackup = await loadFromIDB('global_backup');
        diagnostics.push(`IndexedDB全局备份: ${idbBackup && idbBackup.pet ? '有数据 🟢' : '无数据 🔴'}`);
        if (idbBackup && idbBackup.pet) {
          diagnostics.push(`  宠物: ${idbBackup.pet.name || '未命名'}`);
        }
      } catch(e) {}
    }

    // 5. 云存档测试
    if (supabase && currentUser && currentUser.type === 'cloud') {
      diagnostics.push('─────────────');
      diagnostics.push('☁️  云存档测试:');
      showToast('🔍 正在测试云存档...');
      try {
        const testData = { test: true, time: Date.now() };
        const writeResult = await withTimeout(
          supabase
            .from('game_saves')
            .upsert({
              user_id: currentUser.id,
              game_data: testData,
              updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' }),
          5000,
          '写入超时'
        );
        if (writeResult.error) {
          diagnostics.push(`写入: ❌ 失败 (${writeResult.error.message})`);
        } else {
          diagnostics.push(`写入: ✅ 成功`);
          // 测试读取
          const readResult = await withTimeout(
            supabase
              .from('game_saves')
              .select('game_data, updated_at')
              .eq('user_id', currentUser.id)
              .single(),
            5000,
            '读取超时'
          );
          if (readResult.error) {
            diagnostics.push(`读取: ❌ 失败 (${readResult.error.message})`);
          } else if (readResult.data && readResult.data.game_data) {
            diagnostics.push(`读取: ✅ 成功`);
            diagnostics.push(`云端存档: ${readResult.data.game_data.pet ? '有宠物数据 🟢' : '无宠物数据 🔴'}`);
            if (readResult.data.game_data.pet) {
              diagnostics.push(`  宠物: ${readResult.data.game_data.pet.name || '未命名'}`);
            }
            diagnostics.push(`最后更新: ${readResult.data.updated_at || '未知'}`);
          }
        }
      } catch(e) {
        diagnostics.push(`云存档: ❌ 异常 (${e.message})`);
        diagnostics.push(`  (可能是网络问题，无网络时使用本地缓存即可)`);
      }
    }

    // 显示诊断结果
    diagnostics.push('─────────────');
    diagnostics.push('💡 提示: 即使云存档不可用，');
    diagnostics.push('   本地存档也能正常游戏。');
    diagnostics.push('   数据会保存在手机本地。');

    // 用 alert 显示详细诊断（toast 显示不下）
    alert(diagnostics.join('\n'));
  };
  $('#input-rename').oninput = () => {
    updateTitlePreview();
  };
  $('#input-rename').onchange = () => {
    const name = $('#input-rename').value.trim();
    if (name && gameState.pet) {
      gameState.pet.name = name;
      showToast(`宠物改名为 "${name}"`);
      saveGame();
      updateGameUI();
    }
  };
  $('#select-title-prefix').onchange = () => {
    if (gameState.pet) {
      const prefixId = $('#select-title-prefix').value;
      gameState.pet.titlePrefix = prefixId || null;
      saveGame();
      updateGameUI();
      updateTitlePreview();
    }
  };
  $('#select-title-suffix').onchange = () => {
    if (gameState.pet) {
      const suffixId = $('#select-title-suffix').value;
      gameState.pet.titleSuffix = suffixId || null;
      saveGame();
      updateGameUI();
      updateTitlePreview();
    }
  };

  $('#toggle-sound').onchange = () => {
    gameState.settings.sound = $('#toggle-sound').checked;
    saveGame();
  };
  $('#btn-reset').onclick = () => {
    $('#reset-confirm-modal').classList.remove('hidden');
    $('#reset-confirm-input').value = '';
    $('#btn-reset-confirm').disabled = true;
  };

  // 重置确认弹窗 - 取消
  $('#btn-reset-cancel').onclick = () => {
    $('#reset-confirm-modal').classList.add('hidden');
  };

  // 重置确认弹窗 - 输入验证
  $('#reset-confirm-input').oninput = () => {
    const val = $('#reset-confirm-input').value.trim().toLowerCase();
    $('#btn-reset-confirm').disabled = val !== 'delete';
  };

  // 重置确认弹窗 - 确认重置
  $('#btn-reset-confirm').onclick = () => {
    const val = $('#reset-confirm-input').value.trim().toLowerCase();
    if (val === 'delete') {
      $('#reset-confirm-modal').classList.add('hidden');
      $('#settings-modal').classList.add('hidden');
      resetGame();
    }
  };

  // 每日登录奖励
  checkDailyReward();
}

// 填充头衔下拉选择框
function populateTitleSelects() {
  const prefixSelect = $('#select-title-prefix');
  const suffixSelect = $('#select-title-suffix');
  const prefixes = getUnlockedPrefixes();
  const suffixes = getUnlockedSuffixes();

  // 保存当前值
  const currentPrefix = gameState.pet?.titlePrefix || '';
  const currentSuffix = gameState.pet?.titleSuffix || '';

  // 填充前缀
  prefixSelect.innerHTML = '<option value="">无</option>';
  prefixes.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.text;
    if (p.id === currentPrefix) opt.selected = true;
    prefixSelect.appendChild(opt);
  });

  // 填充后缀
  suffixSelect.innerHTML = '<option value="">无</option>';
  suffixes.forEach(s => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.text;
    if (s.id === currentSuffix) opt.selected = true;
    suffixSelect.appendChild(opt);
  });

  // 如果没有解锁任何头衔，禁用选择框
  prefixSelect.disabled = prefixes.length === 0;
  suffixSelect.disabled = suffixes.length === 0;
}

// 更新头衔预览
function updateTitlePreview() {
  const name = $('#input-rename').value.trim() || '宠物名';
  const prefixId = $('#select-title-prefix').value;
  const suffixId = $('#select-title-suffix').value;
  const prefix = prefixId ? TITLE_PREFIXES[prefixId]?.text || '' : '';
  const suffix = suffixId ? TITLE_SUFFIXES[suffixId]?.text || '' : '';
  let fullName = '';
  if (prefix) fullName += prefix + ' ';
  fullName += name;
  if (suffix) fullName += ' ' + suffix;
  $('#title-preview').textContent = fullName;
}

function checkDailyReward() {
  const lastLogin = gameState.records.lastLogin;
  const now = Date.now();
  const oneDay = 86400000;

  if (lastLogin && (now - lastLogin) > oneDay) {
    const reward = randInt(20, 50);
    gameState.coins += reward;
    gameState.records.totalCoinsEarned += reward;
    setTimeout(() => showToast(`每日登录奖励：🪙${reward}`), 1500);
  }
}

// ============================================================
// 新增功能系统
// ============================================================

// ===== 宠物收藏系统 =====
function switchPet(petId) {
  // 睡觉状态不能切换主宠
  if (gameState.pet && gameState.pet.isSleeping) {
    showToast('宠物正在睡觉，让它休息吧~');
    return false;
  }

  const pet = gameState.petCollection.find(p => p.id === petId);
  if (!pet) {
    showToast('找不到该宠物');
    return false;
  }
  // 保存当前宠物状态到收藏
  if (gameState.pet && gameState.activePetId) {
    const idx = gameState.petCollection.findIndex(p => p.id === gameState.activePetId);
    if (idx >= 0) gameState.petCollection[idx] = gameState.pet;
  }
  // 切换到新宠物
  gameState.pet = pet;
  gameState.activePetId = petId;
  showToast(`已切换到 ${pet.name}`);
  saveGame();
  updateGameUI();
  return true;
}

// 更新图鉴详细信息
function updateAlbumDetails(pet, extraFields) {
  if (!gameState.albumDetails) gameState.albumDetails = {};
  const speciesId = pet.species?.id || 'unknown';
  if (!gameState.albumDetails[speciesId]) {
    gameState.albumDetails[speciesId] = {
      maxLevel: 0, totalOwned: 0, highestRarity: '',
      firstDiscoveredAt: Date.now(), battles: 0, wins: 0, evolutions: 0
    };
  }
  const detail = gameState.albumDetails[speciesId];
  // 合并额外字段（如 evolutions 计数）
  if (extraFields) {
    Object.assign(detail, extraFields);
  }
  detail.totalOwned = (detail.totalOwned || 0) + 1;
  if (pet.level > detail.maxLevel) detail.maxLevel = pet.level;
  // 更新稀有度（取最高的）
  const rarityOrder = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };
  if (!detail.highestRarity || (rarityOrder[pet.rarity?.id] || 0) > (rarityOrder[detail.highestRarity] || 0)) {
    detail.highestRarity = pet.rarity?.id || 'common';
  }
}

// 仅更新图鉴中某物种的 maxLevel（升级时调用）
function updateAlbumDetailsLevel(pet) {
  if (!gameState.albumDetails) return;
  const speciesId = pet.species?.id || 'unknown';
  const detail = gameState.albumDetails[speciesId];
  if (detail && pet.level > detail.maxLevel) {
    detail.maxLevel = pet.level;
  }
}

function addPetToCollection(pet) {
  gameState.petCollection.push(pet);
  // 添加到图鉴
  if (!gameState.album.includes(pet.species.id)) {
    gameState.album.push(pet.species.id);
  }
  // 更新图鉴详细信息
  updateAlbumDetails(pet);
  checkAchievements();
  saveGame();
}

function getAllPetsForBreeding() {
  return [...gameState.petCollection, ...gameState.importedPets];
}

// 生成繁殖对的唯一 key（按 id 排序确保一致性）
function getBreedPairKey(pet1Id, pet2Id) {
  const ids = [pet1Id, pet2Id].sort();
  return ids.join('__');
}

// 获取一对宠物的繁殖次数
function getBreedCount(pet1Id, pet2Id) {
  const key = getBreedPairKey(pet1Id, pet2Id);
  return gameState.breedHistory[key] || 0;
}

// 增加一对宠物的繁殖次数
function incrementBreedCount(pet1Id, pet2Id) {
  const key = getBreedPairKey(pet1Id, pet2Id);
  gameState.breedHistory[key] = (gameState.breedHistory[key] || 0) + 1;
}

// 检查两只宠物是否可以繁殖（满足所有条件）
function canBreed(pet1, pet2) {
  if (!pet1 || !pet2) return { ok: false, reason: '请选择两只宠物' };
  // 同一只宠物
  if (pet1.id === pet2.id) return { ok: false, reason: '不能选择同一只宠物' };
  // 自己和自己（导入的自己）
  if ((pet1.originalId && pet1.originalId === pet2.id) ||
      (pet2.originalId && pet2.originalId === pet1.id) ||
      (pet1.originalId && pet2.originalId && pet1.originalId === pet2.originalId)) {
    return { ok: false, reason: '不能和自己繁殖哦！' };
  }
  // 性别检查
  if (pet1.gender && pet2.gender && pet1.gender === pet2.gender) {
    return { ok: false, reason: '需要一公一母才能繁殖哦~' };
  }
  // 至少有一只是玩家自己的宠物（不能两个都是导入的）
  const bothImported = (pet1.imported || pet1.isImported) && (pet2.imported || pet2.isImported);
  if (bothImported) {
    return { ok: false, reason: '至少要有一只是你自己的宠物哦~' };
  }
  // 繁殖次数限制（同一对最多1次，每对只能繁殖一次）
  const count = getBreedCount(pet1.id, pet2.id);
  if (count >= 1) {
    return { ok: false, reason: '这对宠物已经繁殖过了，每对只能繁殖一次' };
  }
  return { ok: true };
}

// ===== 段位系统辅助函数 =====
function getRankIndex(rankId) {
  return RANKS.findIndex(r => r.id === rankId);
}

function getCurrentRank() {
  const points = gameState.battleStats.rankPoints;
  for (let i = RANKS.length - 1; i >= 0; i--) {
    if (points >= RANKS[i].minPoints) return RANKS[i];
  }
  return RANKS[0];
}

function updateRank() {
  const rank = getCurrentRank();
  gameState.battleStats.rank = rank.id;
  return rank;
}

// ===== 战斗系统 =====
let battleState = null;

function calcBattleStats(pet) {
  const level = pet.level || 1;
  const stats = pet.stats;
  const mod = pet.species?.modifiers || { hp: 1, atk: 1, def: 1, spd: 1, crit: 1 };
  const passive = getPassiveEffects(pet);
  
  let maxHp = (100 + level * 10 + stats.patience * 0.5) * (mod.hp || 1);
  let attack = (stats.debugging * 0.3 + stats.chaos * 0.4) * (mod.atk || 1);
  let defense = (stats.wisdom * 0.3 + stats.patience * 0.5) * (mod.def || 1);
  let speed = (stats.snark * 0.5 + stats.debugging * 0.3) * (mod.spd || 1);
  let critRate = clamp(stats.chaos * 0.003 * (mod.crit || 1), 0, 0.25);
  let dodgeRate = clamp(stats.wisdom * 0.002 * (mod.def || 1), 0, 0.75);

  // 应用被动加成
  if (passive.maxHpBonus) maxHp *= (1 + passive.maxHpBonus);
  if (passive.atkBonus) attack *= (1 + passive.atkBonus);
  if (passive.defBonus) defense *= (1 + passive.defBonus);
  if (passive.speedBonus) speed *= (1 + passive.speedBonus);
  if (passive.critBonus) critRate = clamp(critRate + passive.critBonus, 0, 0.6);
  if (passive.dodgeBonus) dodgeRate = clamp(dodgeRate + passive.dodgeBonus, 0, 0.75);
  if (passive.allBattleBonus) {
    maxHp *= (1 + passive.allBattleBonus);
    attack *= (1 + passive.allBattleBonus);
    defense *= (1 + passive.allBattleBonus);
    speed *= (1 + passive.allBattleBonus);
  }
  
  return {
    maxHp: Math.floor(maxHp),
    attack: Math.floor(attack),
    defense: Math.floor(defense),
    speed: Math.floor(speed),
    critRate: critRate,
    dodgeRate: dodgeRate,
    critDmgMult: passive.critDmgMult || (passive.critDmgBonus ? 1.5 + passive.critDmgBonus : 1.5),
    armorPen: passive.armorPen || passive.ignoreDefense || 0,
    damageReduce: passive.damageReduce || 0,
    lifeSteal: passive.lifeSteal || 0,
    hpRegenPercent: passive.hpRegenPercent || 0,
    undying: !!passive.undying,
    reflect: passive.reflect || 0
  };
}

function generateAIOpponent(difficulty) {
  const playerRank = getCurrentRank();
  const rankIdx = getRankIndex(playerRank.id);
  // 根据段位决定AI强度因子
  let strengthMult = 0.6 + rankIdx * 0.15 + Math.random() * 0.2;

  // 难度调整
  if (difficulty === 'easy') { strengthMult *= 0.6; }
  else if (difficulty === 'normal') { strengthMult *= 1.0; }
  else if (difficulty === 'hard') { strengthMult *= 1.5; }

  const baseSpeciesList = SPECIES_LIST.filter(s => s.stage === 1);
  const species = pick(baseSpeciesList);
  const rarityIdx = clamp(Math.floor(rankIdx * 0.8 + Math.random() * 2), 0, RARITIES.length - 1);
  const rarity = RARITIES[rarityIdx];
  const shiny = Math.random() < 0.05;

  const level = Math.floor((5 + rankIdx * 5) * strengthMult) + randInt(-2, 3);
  const finalLevel = clamp(level, 1, 50);

  const stats = {};
  STAT_NAMES.forEach(stat => {
    const base = rarity.statMin + Math.random() * 40;
    stats[stat] = Math.floor(clamp(base * strengthMult, 1, 100));
  });

  const aiNames = ['野生的', '流浪的', '神秘的', '远古的', '传说的', '黑暗的', '光明的', '机械的'];
  const name = pick(aiNames) + species.name;

  return {
    id: 'ai_' + Date.now(),
    species: species,
    rarity: rarity,
    shiny: shiny,
    hat: 'none',
    stats: stats,
    peakStat: Object.keys(stats).reduce((a, b) => stats[a] > stats[b] ? a : b),
    lowStat: Object.keys(stats).reduce((a, b) => stats[a] < stats[b] ? a : b),
    name: name,
    personality: 'AI 控制的对手',
    gender: Math.random() < 0.5 ? 'male' : 'female',
    stage: 1,
    evolveBranch: null,
    level: finalLevel,
    exp: 0,
    expToNext: 100,
    status: { hunger: 100, happiness: 100, clean: 100, energy: 100, health: 100 },
    isSleeping: false,
    equippedHat: null,
    isAI: true,
    skillPoints: 0,
    unlockedSkills: [],
    dominantStat: getDominantStat({ stats: stats })
  };
}

function startBattle(opponent, difficulty) {
  const playerPet = gameState.pet;
  if (!playerPet) {
    showToast('没有宠物无法对战！');
    return;
  }

  // 睡觉状态检查
  if (playerPet.isSleeping) {
    showToast('宠物正在睡觉，让它休息吧~');
    return;
  }

  // 生病状态检查
  if (playerPet.status.health < 30) {
    showToast('宠物身体不舒服，先治疗一下吧~');
    return;
  }

  // 体力检查
  if (playerPet.status.energy < 20) {
    if (playerPet.status.energy < 10) {
      showToast('宠物精疲力竭了，必须睡觉！');
    } else {
      showToast('宠物太累了，让它休息一下吧！');
    }
    return;
  }

  gameState.lastActionTime = Date.now();
  playerPet.status.energy = clamp(playerPet.status.energy - 10, 0, 100);

  const playerStats = calcBattleStats(playerPet);
  const enemyStats = calcBattleStats(opponent);

  battleState = {
    difficulty: difficulty || 'easy',
    player: {
      pet: playerPet,
      stats: playerStats,
      hp: playerStats.maxHp,
      maxHp: playerStats.maxHp,
      buffs: { atkReduce: 0, atkReduceTurns: 0, dodgeReduce: 0, dots: [], freeze: false, defenseBoost: 0, dodgeBoost: 0, reflect: 0, defenseReduce: 0, defenseReduceTurns: 0 },
      side: 'left'
    },
    enemy: {
      pet: opponent,
      stats: enemyStats,
      hp: enemyStats.maxHp,
      maxHp: enemyStats.maxHp,
      buffs: { atkReduce: 0, atkReduceTurns: 0, dodgeReduce: 0, dots: [], freeze: false, defenseBoost: 0, dodgeBoost: 0, reflect: 0, defenseReduce: 0, defenseReduceTurns: 0 },
      side: 'right'
    },
    turn: 0,
    log: [],
    isRunning: false,
    result: null
  };

  // 显示对战界面
  $('#battle-pet1-emoji').textContent = playerPet.species.emoji;
  $('#battle-pet1-name').textContent = getPetDisplayName(playerPet);
  $('#battle-pet1-hp').style.width = '100%';
  $('#battle-pet1-hp-text').textContent = `${playerStats.maxHp}/${playerStats.maxHp}`;

  $('#battle-pet2-emoji').textContent = opponent.species.emoji;
  $('#battle-pet2-name').textContent = getPetDisplayName(opponent);
  $('#battle-pet2-hp').style.width = '100%';
  $('#battle-pet2-hp-text').textContent = `${enemyStats.maxHp}/${enemyStats.maxHp}`;

  if (playerPet.shiny) $('#battle-pet1-emoji').style.filter = 'drop-shadow(0 0 10px gold)';
  else $('#battle-pet1-emoji').style.filter = '';
  if (opponent.shiny) $('#battle-pet2-emoji').style.filter = 'drop-shadow(0 0 10px gold)';
  else $('#battle-pet2-emoji').style.filter = '';

  $('#battle-log').innerHTML = '';
  addBattleLog(`⚔️ ${playerPet.name} VS ${opponent.name}！`);
  addBattleLog('准备就绪，点击"开始战斗"！');

  $('#btn-battle-fight').classList.remove('hidden');
  $('#btn-battle-again').classList.add('hidden');
  // 战斗未开始时允许退出
  $('#btn-battle-quit').disabled = false;
  $('#btn-battle-quit').classList.remove('btn-disabled');
  $('#battle-overlay').classList.remove('hidden');
}

function addBattleLog(text) {
  const logEl = $('#battle-log');
  const line = document.createElement('div');
  line.className = 'battle-log-line';
  line.textContent = text;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  battleState.log.push(text);
}

function playBattleAnimation(attacker, defender, isCrit, damage, skillName) {
  const atkEl = attacker.side === 'left' ? $('#battle-pet1') : $('#battle-pet2');
  const defEl = defender.side === 'left' ? $('#battle-pet1') : $('#battle-pet2');
  const atkEmoji = attacker.side === 'left' ? $('#battle-pet1-emoji') : $('#battle-pet2-emoji');
  const defEmoji = defender.side === 'left' ? $('#battle-pet1-emoji') : $('#battle-pet2-emoji');

  // 攻击动画
  atkEl.classList.add('attacking');
  setTimeout(() => atkEl.classList.remove('attacking'), 400);

  setTimeout(() => {
    // 受伤动画
    defEl.classList.add('hurt');
    defEmoji.classList.add('shake');
    setTimeout(() => {
      defEl.classList.remove('hurt');
      defEmoji.classList.remove('shake');
    }, 500);

    // 暴击效果
    if (isCrit) {
      spawnParticles('💥', 5, window.innerWidth * (defender.side === 'left' ? 0.25 : 0.75), window.innerHeight * 0.35);
    }

    // 伤害数字 - append到战斗区域内，相对战斗区域定位
    const dmgEl = document.createElement('div');
    dmgEl.className = 'damage-number' + (isCrit ? ' crit' : '');
    dmgEl.textContent = damage === 0 ? 'miss' : ('-' + damage);
    dmgEl.style.left = (defender.side === 'left' ? '25%' : '75%');
    dmgEl.style.top = '30%';
    const arena = document.querySelector('#battle-overlay .battle-arena');
    if (arena) {
      arena.appendChild(dmgEl);
    } else {
      $('#battle-overlay').appendChild(dmgEl);
    }
    setTimeout(() => dmgEl.remove(), 1000);

    // 更新HP条
    const hpPct = Math.max(0, (defender.hp / defender.maxHp) * 100);
    const hpBar = defender.side === 'left' ? $('#battle-pet1-hp') : $('#battle-pet2-hp');
    const hpText = defender.side === 'left' ? $('#battle-pet1-hp-text') : $('#battle-pet2-hp-text');
    hpBar.style.width = hpPct + '%';
    hpText.textContent = `${Math.max(0, Math.floor(defender.hp))}/${defender.maxHp}`;
  }, 200);
}

function doAttack(attacker, defender) {
  // 检查冰冻
  if (attacker.buffs.freeze) {
    addBattleLog(`❄️ ${attacker.pet.name} 被冰冻了，无法行动！`);
    attacker.buffs.freeze = false;
    return 0;
  }

  // 处理持续伤害（dots数组，支持叠加）
  if (attacker.buffs.dots && attacker.buffs.dots.length > 0) {
    let totalDotDmg = 0;
    attacker.buffs.dots.forEach(dot => {
      totalDotDmg += dot.damage;
      dot.turns--;
    });
    attacker.buffs.dots = attacker.buffs.dots.filter(d => d.turns > 0);
    if (totalDotDmg > 0) {
      attacker.hp -= totalDotDmg;
      addBattleLog(`🩸 ${attacker.pet.name} 受到 ${totalDotDmg} 点持续伤害`);
      // DOT伤害后检查免死
      if (attacker.hp <= 0 && attacker._undying && !attacker._undyingUsed) {
        attacker.hp = Math.max(1, Math.floor(attacker.maxHp * 0.1));
        attacker._undyingUsed = true;
        addBattleLog(`🌟 ${attacker.pet.name} 触发了免死！剩余 ${attacker.hp} HP`);
      }
    }
  }

  // 处理攻击降低
  let atkMult = 1;
  if (attacker.buffs.atkReduceTurns > 0) {
    atkMult = 1 - attacker.buffs.atkReduce;
    attacker.buffs.atkReduceTurns--;
    if (attacker.buffs.atkReduceTurns <= 0) attacker.buffs.atkReduce = 0;
  }

  // 基础伤害
  const baseAtk = Math.floor(attacker.stats.attack * atkMult);
  const randomBonus = randInt(0, 10);
  let damage = baseAtk + randomBonus;

  // 属性克制加成：克制方造成 30% 额外伤害
  if (isCounterAttack(attacker.pet, defender.pet)) {
    damage = Math.floor(damage * 1.5);
  }
  // 反克制惩罚：被克制方对克制方伤害降低20%
  if (isCounterAttack(defender.pet, attacker.pet)) {
    damage = Math.floor(damage * 0.8);
  }

  // 低血量条件加成（攻击方）
  let critBonus = 0; // 提前声明，避免TDZ错误
  const attackerPassiveLow = getPassiveEffects(attacker.pet);
  const hpRatio = attacker.hp / attacker.maxHp;
  if (attackerPassiveLow.lowHpAtk && hpRatio < attackerPassiveLow.lowHpAtk.threshold) {
    damage *= (1 + attackerPassiveLow.lowHpAtk.mult);
  }
  if (attackerPassiveLow.highHpAtk && hpRatio >= attackerPassiveLow.highHpAtk.threshold) {
    damage *= (1 + attackerPassiveLow.highHpAtk.mult);
  }
  if (attackerPassiveLow.lowHpCrit && hpRatio < attackerPassiveLow.lowHpCrit.threshold) {
    critBonus = (critBonus || 0) + attackerPassiveLow.lowHpCrit.critBonus;
  }
  if (attackerPassiveLow.lowHpAllBoost && hpRatio < attackerPassiveLow.lowHpAllBoost.threshold) {
    damage *= (1 + attackerPassiveLow.lowHpAllBoost.bonus);
  }

  // 低血量条件加成（防御方）+ 敌方攻击降低（enemyAtkReduce）
  const defenderPassiveLow = getPassiveEffects(defender.pet);
  const defHpRatio = defender.hp / defender.maxHp;
  let lowHpDefMult = 1;
  if (defenderPassiveLow.lowHpDef && defHpRatio < defenderPassiveLow.lowHpDef.threshold) {
    lowHpDefMult = (1 + defenderPassiveLow.lowHpDef.mult);
  }
  let lowHpDodgeBonus = 0;
  if (defenderPassiveLow.lowHpDodge && defHpRatio < defenderPassiveLow.lowHpDodge.threshold) {
    lowHpDodgeBonus = defenderPassiveLow.lowHpDodge.dodgeBonus;
  }

  // enemyAtkReduce：降低攻击方伤害
  if (defenderPassiveLow.enemyAtkReduce) {
    damage *= (1 - defenderPassiveLow.enemyAtkReduce);
  }

  // 计算暴击
  let isCrit = false;
  let guaranteed = false; // 是否必中（学习技能可设置）

  // 检查特殊技能
  const baseSpecies = getBaseSpecies(attacker.pet.species);
  const skill = SPECIES_SKILLS[baseSpecies.id];
  let skillTriggered = false;
  let skillEffect = null;

  if (skill && Math.random() < 0.25) {
    skillTriggered = true;
    skillEffect = skill.effect(damage, attacker);
    damage = Math.floor(skillEffect.dmg || damage);
    if (skillEffect.critBonus) critBonus = skillEffect.critBonus;
    // 攻击方自身效果立即应用（不受闪避影响）
    if (skillEffect.heal) {
      const healAmt = Math.floor(skillEffect.heal);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmt);
      addBattleLog(`💚 ${attacker.pet.name} 的 ${skill.name} 恢复了 ${healAmt} HP！`);
    }
    if (skillEffect.selfDamage) {
      const selfDmg = Math.floor(skillEffect.selfDamage);
      attacker.hp -= selfDmg;
      addBattleLog(`💔 ${attacker.pet.name} 受到 ${selfDmg} 点反噬伤害！`);
    }
    if (skillEffect.dodgeBoost) {
      attacker.buffs.dodgeBoost = (attacker.buffs.dodgeBoost || 0) + skillEffect.dodgeBoost;
    }
    if (skillEffect.defenseBoost) {
      attacker.buffs.defenseBoost = (attacker.buffs.defenseBoost || 0) + skillEffect.defenseBoost;
    }
  }

  // 已学习作战技能触发（与本体技能独立判定）
  let learnedSkillTriggered = false;
  let learnedSkillName = '';
  let activeSkillHeal = 0; // 主动技能吸血回血量临时变量
  let pendingAtkReduce = null, pendingAtkReduceTurns = 0;
  let pendingDefReduce = null, pendingDefReduceTurns = 0;
  let pendingFreezeChance = 0;
  let pendingReflect = 0;
  if (attacker.pet.unlockedSkills && attacker.pet.unlockedSkills.length > 0) {
    const battleSkills = attacker.pet.unlockedSkills
      .map(id => LEARNED_SKILL_MAP[id])
      .filter(s => s && s.type === 'active');

    if (battleSkills.length > 0) {
      // 每个作战技能独立判定是否触发
      for (const bs of battleSkills) {
        const chance = bs.battleEffect.triggerChance || 0.15;
        if (Math.random() < chance) {
          learnedSkillTriggered = true;
          learnedSkillName = bs.name;
          const eff = bs.battleEffect;
          if (eff.dmgMult) damage = Math.floor(damage * eff.dmgMult);
          if (eff.critBonus) critBonus = (critBonus || 0) + eff.critBonus;
          if (eff.guaranteed) guaranteed = true;
          if (eff.healPercent) {
            // 回复百分比HP（攻击方自身效果，立即生效）
            const healAmount = Math.floor(attacker.maxHp * eff.healPercent);
            attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmount);
          }
          if (eff.defenseBoost) {
            attacker.buffs.defenseBoost = (attacker.buffs.defenseBoost || 0) + eff.defenseBoost;
          }
          if (eff.dodgeBoost) attacker.buffs.dodgeBoost = (attacker.buffs.dodgeBoost || 0) + eff.dodgeBoost;
          if (eff.lifeSteal) activeSkillHeal = eff.lifeSteal; // 存储比例，后面用 finalDamage 计算
          // 对防御方的负面效果，延迟到命中后应用
          if (eff.atkReduce) {
            pendingAtkReduce = eff.atkReduce;
            pendingAtkReduceTurns = eff.atkReduceTurns || 2;
          }
          if (eff.defReduce) {
            pendingDefReduce = eff.defReduce;
            pendingDefReduceTurns = eff.defReduceTurns || 2;
          }
          if (eff.freezeChance) pendingFreezeChance = eff.freezeChance;
          if (eff.reflect) pendingReflect = eff.reflect;
          break; // 只触发一个
        }
      }
    }
  }

  const critChance = clamp(attacker.stats.critRate + critBonus, 0, 0.6);
  if (Math.random() < critChance) {
    damage = Math.floor(damage * (attacker.stats.critDmgMult || 1.8));
    isCrit = true;
  }

  // 计算闪避
  let dodgeRate = defender.stats.dodgeRate;
  if (defender.buffs.dodgeBoost) {
    dodgeRate += defender.buffs.dodgeBoost;
    defender.buffs.dodgeBoost = 0;
  }
  if (skillEffect && skillEffect.dodgeReduce) {
    dodgeRate = Math.max(0, dodgeRate - skillEffect.dodgeReduce);
  }
  // 防御方低血量闪避加成
  dodgeRate += lowHpDodgeBonus;

  // 闪避判定：先判定必中，再判定闪避（基础闪避上限75%，主动dodgeBoost可突破）
  if (!guaranteed && Math.random() < dodgeRate) {
    addBattleLog(`💨 ${defender.pet.name} 闪避了攻击！`);
    playBattleAnimation(attacker, defender, false, 0);
    return 0;
  }

  // 计算防御
  let defense = defender.stats.defense;
  if (defender.buffs.defenseBoost > 0) {
    defense = Math.floor(defense * (1 + defender.buffs.defenseBoost));
    defender.buffs.defenseBoost = 0;
  }
  // 学习技能降低防御
  if (defender.buffs.defenseReduce && defender.buffs.defenseReduceTurns > 0) {
    defense = Math.floor(defense * (1 - defender.buffs.defenseReduce));
    defender.buffs.defenseReduceTurns--;
    if (defender.buffs.defenseReduceTurns <= 0) defender.buffs.defenseReduce = 0;
  }
  // 防御方低血量防御加成
  defense = Math.floor(defense * lowHpDefMult);
  // 破甲（被动效果）
  if (attacker.stats.armorPen > 0) {
    defense = Math.floor(defense * (1 - Math.min(0.8, attacker.stats.armorPen)));
  }
  // 防御百分比减免（新公式）：防御越高减免比例越高，但有上限
  const defLevelFactor = 80 + (attacker.pet?.level || 1) * 15;
  let damageReduction = Math.min(0.5, defense / (defense + defLevelFactor));
  // 温柔系宠物天然抗暴击：暴击时减免率额外+10%
  if (isCrit && getDominantStat(defender.pet) === 'patience') {
    damageReduction = Math.min(0.6, damageReduction + 0.10);
  }
  // 高防克高攻：防御显著高于攻击时额外减免
  if (defense > (attacker.stats.attack || 0) * 0.8) {
    damageReduction = Math.min(0.6, damageReduction + 0.10);
  }
  let finalDamage = Math.max(1, Math.floor(damage * (1 - damageReduction)));
  // 伤害减免（被动效果）
  if (defender.stats.damageReduce > 0) {
    finalDamage = Math.max(1, Math.floor(finalDamage * (1 - Math.min(0.8, defender.stats.damageReduce))));
  }

  defender.hp -= finalDamage;

  // 吸血（被动效果）
  if (finalDamage > 0) {
    const attackerPassive = getPassiveEffects(attacker.pet);
    if (attackerPassive.lifeSteal > 0) {
      const healAmt = Math.max(1, Math.floor(finalDamage * attackerPassive.lifeSteal));
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmt);
    }
    // 主动技能的吸血也在这里处理
    if (activeSkillHeal > 0) {
      const healAmt = Math.max(1, Math.floor(finalDamage * activeSkillHeal));
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmt);
    }
  }

  // 免死（被动效果）
  if (defender.hp <= 0) {
    const defenderPassive = getPassiveEffects(defender.pet);
    if (defenderPassive.undying && !defender._undyingUsed) {
      defender.hp = 1;
      defender._undyingUsed = true;
      addBattleLog(`💀 ${defender.pet.name} 触发了免死！`);
    }
  }

  // 命中后应用物种技能对防御方的负面效果
  if (skillTriggered && skillEffect) {
    // 攻击方自身效果已在技能触发时应用（heal、selfDamage、dodgeBoost、defenseBoost）
    // 命中后才应用对防御方的负面效果
    if (skillEffect.freezeChance && Math.random() < skillEffect.freezeChance) {
      defender.buffs.freeze = true;
      addBattleLog(`❄️ ${defender.pet.name} 被冰冻了！`);
    }
    if (skillEffect.dot && skillEffect.dotTurns) {
      defender.buffs.dots = defender.buffs.dots || [];
      defender.buffs.dots.push({ damage: Math.floor(skillEffect.dot), turns: skillEffect.dotTurns, source: skill.name });
      addBattleLog(`🩸 ${defender.pet.name} 陷入持续伤害状态！`);
    }
    if (skillEffect.atkReduce && skillEffect.atkReduceTurns) {
      defender.buffs.atkReduce = skillEffect.atkReduce;
      defender.buffs.atkReduceTurns = skillEffect.atkReduceTurns;
      addBattleLog(`⬇️ ${defender.pet.name} 的攻击力降低了！`);
    }
    if (skillEffect.dodgeReduce) {
      // 闪避降低已在闪避判定时应用，无需再次处理
    }
    if (skillEffect.reflect) {
      // 物种技能反伤直接在反伤区域处理，不写入buffs避免重复
    }
    if (skillEffect.doubleStrike) {
      // 连击 - 再来一次简化处理
      setTimeout(() => {
        if (battleState && battleState.isRunning && defender.hp > 0) {
          const bonusDmg = Math.floor(finalDamage * 0.5);
          defender.hp -= bonusDmg;
          addBattleLog(`⚡ 连击！${attacker.pet.name} 再次攻击造成 ${bonusDmg} 伤害！`);
          playBattleAnimation(attacker, defender, false, bonusDmg);
        }
      }, 600);
    }

    addBattleLog(`✨ ${attacker.pet.name} 释放了 ${skill.name}！`);
  }

  // 命中后应用主动技能对防御方的负面效果
  if (pendingAtkReduce !== null) {
    defender.buffs.atkReduce = pendingAtkReduce;
    defender.buffs.atkReduceTurns = pendingAtkReduceTurns;
    addBattleLog(`⬇️ ${defender.pet.name} 的攻击力降低了！`);
  }
  if (pendingDefReduce !== null) {
    defender.buffs.defenseReduce = pendingDefReduce;
    defender.buffs.defenseReduceTurns = pendingDefReduceTurns;
  }
  if (pendingFreezeChance > 0 && Math.random() < pendingFreezeChance) {
    defender.buffs.freeze = true;
    addBattleLog(`❄️ ${defender.pet.name} 被冰冻了！`);
  }
  if (pendingReflect > 0) {
    attacker.buffs.reflect = pendingReflect;
  }

  // 被动连击（doubleStrikeChance：额外概率触发二连击，与物种连击不叠加）
  const attackerPassiveStrike = getPassiveEffects(attacker.pet);
  if (!skillEffect?.doubleStrike && attackerPassiveStrike.doubleStrikeChance && Math.random() < attackerPassiveStrike.doubleStrikeChance) {
    setTimeout(() => {
      if (battleState && battleState.isRunning && defender.hp > 0) {
        const bonusDmg = Math.floor(finalDamage * 0.5);
        defender.hp -= bonusDmg;
        addBattleLog(`⚡ 被动连击！${attacker.pet.name} 再次攻击造成 ${bonusDmg} 伤害！`);
        playBattleAnimation(attacker, defender, false, bonusDmg);
      }
    }, 600);
  }

  // 反伤处理（统一处理：物种技能 + 主动技能buffs + 被动stats）
  let totalReflectRate = 0;
  // 被动技能反伤
  if (defender.stats.reflect > 0) totalReflectRate += defender.stats.reflect;
  // 主动技能反伤（来自 buffs，仅当物种技能没有reflect时才使用buffs，避免重复）
  if (defender.buffs && defender.buffs.reflect > 0) totalReflectRate += defender.buffs.reflect;
  // 物种技能反伤
  const defBaseSpecies = getBaseSpecies(defender.pet.species);
  const defSkill = SPECIES_SKILLS[defBaseSpecies.id];
  if (defSkill) {
    const defEffect = defSkill.effect(0, defender);
    if (defEffect.reflect) totalReflectRate += defEffect.reflect;
  }
  // 反伤上限保护：最多反弹 60% 伤害
  totalReflectRate = Math.min(0.6, totalReflectRate);
  if (totalReflectRate > 0) {
    const reflectDmg = Math.max(1, Math.floor(finalDamage * totalReflectRate));
    attacker.hp -= reflectDmg;
    addBattleLog(`🌵 ${defender.pet.name} 反弹了 ${reflectDmg} 点伤害！`);
    // 反伤后检查免死
    if (attacker.hp <= 0 && attacker._undying && !attacker._undyingUsed) {
      attacker.hp = Math.max(1, Math.floor(attacker.maxHp * 0.1));
      attacker._undyingUsed = true;
      addBattleLog(`🌟 ${attacker.pet.name} 触发了免死！剩余 ${attacker.hp} HP`);
    }
  }

  const critText = isCrit ? ' 暴击！' : '';
  // 属性克制提示日志
  if (isCounterAttack(attacker.pet, defender.pet)) {
    const atkDom = getDominantStat(attacker.pet);
    const defDom = getDominantStat(defender.pet);
    addBattleLog(`⚠️ 属性克制！${attacker.pet.name} 的${STAT_LABELS[atkDom]?.name || ''}克制了${defender.pet.name}的${STAT_LABELS[defDom]?.name || ''}！`);
  }
  // 学习技能触发日志
  if (learnedSkillTriggered) {
    addBattleLog(`🌟 ${attacker.pet.name} 发动了${learnedSkillName}！`);
  }
  addBattleLog(`⚔️ ${attacker.pet.name} 对 ${defender.pet.name} 造成 ${finalDamage} 点伤害${critText}`);
  playBattleAnimation(attacker, defender, isCrit, finalDamage);

  return finalDamage;
}

async function runBattleTurns() {
  if (!battleState) return;
  battleState.isRunning = true;

  // 战斗开始后禁用退出按钮
  $('#btn-battle-fight').classList.add('hidden');
  $('#btn-battle-quit').disabled = true;
  $('#btn-battle-quit').classList.add('btn-disabled');

  // 比较双方速度，决定先手
  const playerSpeed = battleState.player.stats.speed;
  const enemySpeed = battleState.enemy.stats.speed;
  let playerFirst;
  if (playerSpeed > enemySpeed) {
    playerFirst = true;
    addBattleLog(`⚡ ${battleState.player.pet.name} 速度更快，先手攻击！`);
  } else if (enemySpeed > playerSpeed) {
    playerFirst = false;
    addBattleLog(`⚡ ${battleState.enemy.pet.name} 速度更快，先手攻击！`);
  } else {
    playerFirst = Math.random() < 0.5;
    addBattleLog(`⚡ 双方速度相当，随机决定先手...`);
  }

  while (battleState.isRunning && battleState.player.hp > 0 && battleState.enemy.hp > 0) {
    battleState.turn++;
    addBattleLog(`--- 第 ${battleState.turn} 回合 ---`);

    await delay(800);
    if (!battleState.isRunning) break;

    if (playerFirst) {
      // 玩家先手
      doAttack(battleState.player, battleState.enemy);
      if (battleState.enemy.hp <= 0) break;

      await delay(1000);
      if (!battleState.isRunning) break;

      doAttack(battleState.enemy, battleState.player);
      if (battleState.player.hp <= 0) break;
    } else {
      // 敌人先手
      doAttack(battleState.enemy, battleState.player);
      if (battleState.player.hp <= 0) break;

      await delay(1000);
      if (!battleState.isRunning) break;

      doAttack(battleState.player, battleState.enemy);
      if (battleState.enemy.hp <= 0) break;
    }

    // 回合末被动回血与被动毒伤（每回合只结算一次）
    if (battleState.isRunning && battleState.player.hp > 0 && battleState.enemy.hp > 0) {
      [battleState.player, battleState.enemy].forEach(fighter => {
        if (!fighter || fighter.hp <= 0) return;
        const passive = getPassiveEffects(fighter.pet);
        if (passive.hpRegenPercent && fighter.maxHp > 0) {
          const regen = Math.max(1, Math.floor(fighter.maxHp * passive.hpRegenPercent));
          const prev = fighter.hp;
          fighter.hp = Math.min(fighter.maxHp, fighter.hp + regen);
          if (fighter.hp > prev) {
            addBattleLog(`💚 ${fighter.pet.name} 回复了 ${fighter.hp - prev} 点HP`);
          }
        }
        // 被动毒伤 dotPercent 给对方造成伤害
        if (passive.dotPercent && fighter.maxHp > 0) {
          const opponent = fighter === battleState.player ? battleState.enemy : battleState.player;
          if (opponent.hp > 0) {
            const dotDmg = Math.max(1, Math.floor(opponent.maxHp * passive.dotPercent));
            opponent.hp -= dotDmg;
            addBattleLog(`🩸 ${opponent.pet.name} 被毒伤 ${dotDmg} 点`);
          }
        }
      });
    }

    await delay(600);
  }

  if (battleState && battleState.isRunning) {
    battleState.isRunning = false;
    const win = battleState.player.hp > 0;
    endBattle(win);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function endBattle(win) {
  const bs = gameState.battleStats;
  const pet = gameState.pet;
  bs.total++;
  gameState.lastInteractionTime = Date.now();

  if (win) {
    bs.wins++;
    bs.streak++;
    bs.maxStreak = Math.max(bs.maxStreak, bs.streak);

    // 险胜检测：胜利时玩家HP低于最大HP的10%
    const hpRatio = battleState.player.maxHp > 0 ? (battleState.player.hp / battleState.player.maxHp) : 0;
    const isCloseWin = hpRatio < 0.1;
    if (isCloseWin) {
      bs.closeWins++;
    }

    // 积分计算
    const basePoints = 15 + bs.streak * 2;
    bs.rankPoints += basePoints;
    const oldRank = bs.rank;
    const newRank = updateRank();

    // 金币奖励
    const battlePassive = getPassiveEffects(pet);
    const battleCoinMult = 1 + (battlePassive.battleCoinBonus || 0);
    const coinReward = Math.floor((20 + bs.streak * 5) * battleCoinMult);
    if (battlePassive.coinDoubleChance && Math.random() < battlePassive.coinDoubleChance) coinReward *= 2;
    gameState.coins += coinReward;
    gameState.records.totalCoinsEarned += coinReward;

    // 经验奖励（对战经验大幅高于其他操作，困难模式加成）
    const diffExpMult = { easy: 0.8, normal: 1.0, hard: 1.5 };
    gainExp(Math.floor(80 * (diffExpMult[battleState?.difficulty] || 1)));

    // 对战胜利降低快乐（-3）
    if (pet) {
      pet.status.happiness = clamp(pet.status.happiness - 3, 0, 100);
    }

    addBattleLog('');
    if (isCloseWin) {
      addBattleLog(`😅 险胜！HP 仅剩 ${Math.floor(battleState.player.hp)}/${battleState.player.maxHp}！`);
    }
    addBattleLog(`🎉 胜利！获得 ${basePoints} 积分，${coinReward} 金币！`);
    if (bs.streak > 1) addBattleLog(`🔥 ${bs.streak} 连胜！`);
    if (oldRank !== newRank.id) addBattleLog(`🏆 段位提升：${newRank.icon} ${newRank.name}！`);

    showToast(isCloseWin
      ? `😅 险胜！+${coinReward}🪙 +${basePoints}积分`
      : `🎉 战斗胜利！+${coinReward}🪙 +${basePoints}积分`);

    // 对战胜利重置连败计数
    if (gameState.hiddenCounters) {
      gameState.hiddenCounters.consecutiveBattleLosses = 0;
    }

    // 玩家对战统计
    const opp = battleState && battleState.enemy && battleState.enemy.pet;
    if (opp && (opp.imported || opp.isImported)) {
      if (!gameState.pvpStats) gameState.pvpStats = { total: 0, wins: 0, losses: 0 };
      gameState.pvpStats.total++;
      gameState.pvpStats.wins++;
    }
  } else {
    bs.losses++;
    bs.streak = 0;

    // 扣除积分
    const lostPoints = Math.min(bs.rankPoints, 10);
    bs.rankPoints -= lostPoints;
    updateRank();

    // 对战失败降低快乐（-8）
    if (pet) {
      pet.status.happiness = clamp(pet.status.happiness - 8, 0, 100);
    }

    addBattleLog('');
    addBattleLog(`💀 失败... 失去 ${lostPoints} 积分`);
    showToast(`💀 战斗失败... -${lostPoints}积分`);

    // 连续对战失败隐藏计数
    if (gameState.hiddenCounters) {
      gameState.hiddenCounters.consecutiveBattleLosses++;
      if (gameState.hiddenCounters.consecutiveBattleLosses >= 10 && !gameState.achievements.unlocked.includes('hidden_losestreak')) {
        gameState.achievements.unlocked.push('hidden_losestreak');
        setTimeout(() => showToast('🎁 发现隐藏头衔：不屈的！'), 1500);
      }
    }

    // 玩家对战统计
    const opp = battleState && battleState.enemy && battleState.enemy.pet;
    if (opp && (opp.imported || opp.isImported)) {
      if (!gameState.pvpStats) gameState.pvpStats = { total: 0, wins: 0, losses: 0 };
      gameState.pvpStats.total++;
      gameState.pvpStats.losses++;
    }
  }

  battleState.result = win ? 'win' : 'lose';

  $('#btn-battle-fight').classList.add('hidden');
  $('#btn-battle-again').classList.remove('hidden');
  // 战斗结束后才允许退出
  $('#btn-battle-quit').disabled = false;
  $('#btn-battle-quit').classList.remove('btn-disabled');

  // 更新对战数据UI
  updateBattleStatsUI();

  // 更新每日任务
  updateDailyTaskProgress('battle', 1);
  if (win) updateDailyTaskProgress('battleWin', 1);

  checkAchievements();
  saveGame();
}

function quitBattle() {
  // 战斗进行中禁止退出（防止刷分/避免损失）
  if (battleState && battleState.isRunning) {
    showToast('战斗进行中，不能退出！');
    return;
  }
  battleState = null;
  $('#battle-overlay').classList.add('hidden');
  updateGameUI();
}

// ===== 社交分享功能 =====
function generateShareCode(pet) {
  try {
    // 只保存核心数据
    const shareData = {
      v: 1,
      id: pet.id,
      n: pet.name,
      tp: pet.titlePrefix || null,
      ts: pet.titleSuffix || null,
      s: pet.species.id,
      r: pet.rarity.id,
      sh: pet.shiny,
      st: pet.stats,
      l: pet.level,
      p: pet.personality,
      g: pet.gender,
      stg: pet.stage || 1,
      eb: pet.evolveBranch || null
    };
    const json = JSON.stringify(shareData);
    // base64 编码
    return btoa(unescape(encodeURIComponent(json)));
  } catch(e) {
    console.warn('Share code generation failed:', e);
    return '';
  }
}

function parseShareCode(code) {
  try {
    const json = decodeURIComponent(escape(atob(code.trim())));
    const data = JSON.parse(json);
    if (!data || !data.s || !data.st) return null;

    const species = findSpecies(data.s) || SPECIES_LIST.find(s => s.id === data.s) || SPECIES_LIST[0];
    const rarity = RARITIES.find(r => r.id === data.r) || RARITIES[0];
    if (!species) return null;

    // 如果分享代码包含原始id，保留它用于检测同一只宠物
    const originalId = data.id || null;
    const petId = originalId || ('imported_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4));

    // 补全 stats 默认值，防止缺失属性导致 NaN
    const defaultStats = { debugging: 20, patience: 20, chaos: 20, wisdom: 20, snark: 20 };
    const stats = { ...defaultStats, ...(data.st || {}) };

    return {
      id: petId,
      originalId: originalId,
      species: species,
      rarity: rarity,
      shiny: !!data.sh,
      hat: 'none',
      stats: stats,
      peakStat: Object.keys(stats).reduce((a, b) => stats[a] > stats[b] ? a : b),
      lowStat: Object.keys(stats).reduce((a, b) => stats[a] < stats[b] ? a : b),
      name: data.n || species.name,
      titlePrefix: data.tp || null,
      titleSuffix: data.ts || null,
      personality: data.p || '来自远方的宠物',
      gender: data.g || (Math.random() < 0.5 ? 'male' : 'female'),
      stage: data.stg || 1,
      evolveBranch: data.eb || null,
      level: data.l || 1,
      exp: 0,
      expToNext: 100,
      status: { hunger: 100, happiness: 100, clean: 100, energy: 100, health: 100 },
      isSleeping: false,
      equippedHat: null,
      imported: true,
      hatchTime: Date.now(),
      skillPoints: 0,
      unlockedSkills: [],
      dominantStat: getDominantStat({ stats: stats })
    };
  } catch(e) {
    console.warn('Share code parse failed:', e);
    return null;
  }
}

function openShareModal() {
  const pet = gameState.pet;
  if (!pet) return;

  $('#share-pet-emoji').textContent = pet.species.emoji;
  $('#share-pet-name').textContent = getPetDisplayName(pet);
  $('#share-pet-rarity').textContent = `${pet.rarity.stars} ${pet.rarity.name}${pet.shiny ? ' ✨闪光' : ''}`;

  if (pet.shiny) {
    $('#share-pet-emoji').style.filter = 'drop-shadow(0 0 12px gold)';
  } else {
    $('#share-pet-emoji').style.filter = '';
  }

  const code = generateShareCode(pet);
  $('#share-code').value = code;

  $('#share-modal').classList.remove('hidden');
}

function copyShareCode() {
  const code = $('#share-code');
  code.select();
  try {
    document.execCommand('copy');
    showToast('代码已复制到剪贴板！');
  } catch(e) {
    showToast('复制失败，请手动复制');
  }
}

// ===== 宠物繁殖系统 =====
let selectedBreedSlot = 1;

function openBreedPanel() {
  renderBreedCollection();
  updateBreedSlots();
  updateBreedLevelHint();
  showPanel('breed-panel');
}

function updateBreedLevelHint() {
  const pet = gameState.pet;
  const hintEl = $('#breed-level-hint');
  const btn = $('#btn-breed-start');
  if (!pet || pet.level < 10) {
    const curLevel = pet ? pet.level : 0;
    if (hintEl) {
      hintEl.textContent = `宠物需要达到 10 级才能繁殖哦~ 当前等级：Lv.${curLevel} / 10`;
      hintEl.style.display = 'block';
      hintEl.style.cssText = 'text-align:center;color:#E17055;padding:8px;font-size:13px;';
    }
    btn.disabled = true;
  } else {
    if (hintEl) {
      hintEl.style.display = 'none';
    }
    // 等级够了也要看是否选了两只宠物
    const allPets = getAllPetsForBreeding();
    const pet1 = allPets.find(p => p.id === gameState.breedSlot1);
    const pet2 = allPets.find(p => p.id === gameState.breedSlot2);
    btn.disabled = !(pet1 && pet2);
  }
}

function renderBreedCollection() {
  const grid = $('#breed-collection-grid');
  grid.innerHTML = '';

  const allPets = getAllPetsForBreeding();
  $('#breed-collection-count').textContent = allPets.length;

  // 另一个已选中的槽位（用于计算配对次数）
  const otherSlotId = selectedBreedSlot === 1 ? gameState.breedSlot2 : gameState.breedSlot1;

  allPets.forEach(pet => {
    const card = document.createElement('div');
    card.className = 'pet-mini-card';
    const displayEmoji = getPetDisplayEmoji(pet);
    const isActive = pet.id === gameState.activePetId;
    const isSelected = pet.id === gameState.breedSlot1 || pet.id === gameState.breedSlot2;

    // 计算与另一个已选中宠物的剩余繁殖次数
    let breedCountInfo = '';
    let breedLeft = null;
    if (otherSlotId && otherSlotId !== pet.id) {
      const count = getBreedCount(otherSlotId, pet.id);
      breedLeft = 3 - count;
      if (breedLeft <= 0) {
        breedCountInfo = `<div class="pet-mini-tag" style="background:#E17055;font-size:10px;">已达上限</div>`;
      } else {
        breedCountInfo = `<div class="pet-mini-tag" style="background:#00B894;font-size:10px;">剩${breedLeft}/3</div>`;
      }
    }

    // 检查是否可选（与另一个槽位的宠物配对）
    let disabled = false;
    let disabledReason = '';
    if (otherSlotId && otherSlotId !== pet.id) {
      const otherPet = allPets.find(p => p.id === otherSlotId);
      if (otherPet) {
        // 先按性别构造临时检查
        const pet1 = selectedBreedSlot === 1 ? pet : otherPet;
        const pet2 = selectedBreedSlot === 1 ? otherPet : pet;
        const check = canBreed(pet1, pet2);
        if (!check.ok) {
          disabled = true;
          disabledReason = check.reason;
        }
      }
    }

    if (isSelected) card.classList.add('pet-mini-selected');
    if (disabled) card.classList.add('pet-mini-disabled');

    // 繁殖选择模式：根据当前选择的槽位高亮/灰显
    if (!isSelected && !disabled) {
      if (selectedBreedSlot === 1) {
        // 正在选父方（公），公宠物高亮，母宠物灰显
        if (pet.gender === 'male') {
          card.classList.add('breed-highlight-male');
        } else if (pet.gender === 'female') {
          card.classList.add('breed-dim');
        }
      } else if (selectedBreedSlot === 2) {
        // 正在选母方（母），母宠物高亮，公宠物灰显
        if (pet.gender === 'female') {
          card.classList.add('breed-highlight-female');
        } else if (pet.gender === 'male') {
          card.classList.add('breed-dim');
        }
      }
    }

    // 已经繁殖过1次的配对灰显
    if (otherSlotId && otherSlotId !== pet.id) {
      const count = getBreedCount(otherSlotId, pet.id);
      if (count >= 1) {
        card.classList.add('breed-dim');
      }
    }

    card.innerHTML = `
      <div class="pet-mini-emoji" style="${pet.shiny ? 'filter:drop-shadow(0 0 8px gold)' : ''};white-space:pre;">${displayEmoji}</div>
      <div class="pet-mini-name">${pet.name}${getGenderSymbol(pet.gender)}</div>
      <div class="pet-mini-rarity" style="color:${pet.rarity.color}">${pet.rarity.stars}</div>
      <div class="pet-mini-level">Lv.${pet.level}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center;margin-top:2px;">
        ${pet.imported ? '<div class="pet-mini-tag" style="font-size:10px;">导入</div>' : ''}
        ${pet.isAI ? '<div class="pet-mini-tag" style="font-size:10px;">AI</div>' : ''}
        ${isActive ? '<div class="pet-mini-tag" style="background:#00B894;font-size:10px;">当前</div>' : ''}
        ${breedCountInfo}
      </div>
      <button class="btn btn-small pet-switch-btn" style="margin-top:6px;font-size:11px;padding:2px 8px;${isActive ? 'display:none;' : ''}">设为主宠</button>
    `;
    // 点击卡片选择繁殖
    card.onclick = (e) => {
      if (disabled) {
        showToast(disabledReason || '无法选择');
        return;
      }
      // 如果点击的是按钮，不触发卡片选择
      if (e.target.classList.contains('pet-switch-btn')) return;
      selectPetForBreeding(pet.id);
    };
    const switchBtn = card.querySelector('.pet-switch-btn');
    if (switchBtn) {
      switchBtn.onclick = (e) => {
        e.stopPropagation();
        if (!pet.imported && !pet.isAI) {
          switchPet(pet.id);
          renderBreedCollection();
          updateBreedSlots();
        } else {
          showToast('导入/AI宠物不能设为主宠');
        }
      };
    }
    grid.appendChild(card);
  });
}

function createPetMiniCard(pet, onClick) {
  const card = document.createElement('div');
  card.className = 'pet-mini-card';
  const displayEmoji = getPetDisplayEmoji(pet);
  card.innerHTML = `
    <div class="pet-mini-emoji" style="${pet.shiny ? 'filter:drop-shadow(0 0 8px gold)' : ''};white-space:pre;">${displayEmoji}</div>
    <div class="pet-mini-name">${pet.name}${getGenderSymbol(pet.gender)}</div>
    <div class="pet-mini-rarity" style="color:${pet.rarity.color}">${pet.rarity.stars}</div>
    <div class="pet-mini-level">Lv.${pet.level}</div>
    ${pet.imported ? '<div class="pet-mini-tag">导入</div>' : ''}
    ${pet.isAI ? '<div class="pet-mini-tag">AI</div>' : ''}
  `;
  if (onClick) card.onclick = onClick;
  return card;
}

function selectPetForBreeding(petId) {
  const allPets = getAllPetsForBreeding();
  const pet = allPets.find(p => p.id === petId);
  if (!pet) return;

  if (selectedBreedSlot === 1) {
    // 槽位1必须是公的
    if (pet.gender && pet.gender !== 'male') {
      showToast('父方必须是公宠物哦~');
      return;
    }
    gameState.breedSlot1 = petId;
    selectedBreedSlot = 2;
    // 更新提示为选择母方
    const hintAfterSlot1 = $('#breed-mode-hint');
    if (hintAfterSlot1) {
      hintAfterSlot1.style.display = 'block';
      hintAfterSlot1.className = 'breed-mode-hint selecting-mother';
      hintAfterSlot1.textContent = '正在选择母宠物（母） - 粉色高亮宠物可选择';
    }
  } else {
    // 不能选同一只
    if (gameState.breedSlot1 === petId) {
      showToast('不能选择同一只宠物');
      return;
    }
    // 槽位2必须是母的
    if (pet.gender && pet.gender !== 'female') {
      showToast('母方必须是母宠物哦~');
      return;
    }
    // 使用 canBreed 统一检查（自己、性别、导入、次数等）
    const pet1 = allPets.find(p => p.id === gameState.breedSlot1);
    const pet2 = pet;
    if (pet1 && pet2) {
      const check = canBreed(pet1, pet2);
      if (!check.ok) {
        showToast(check.reason);
        return;
      }
    }
    gameState.breedSlot2 = petId;
    selectedBreedSlot = 1;
    // 隐藏提示
    const hintAfterSlot2 = $('#breed-mode-hint');
    if (hintAfterSlot2) {
      hintAfterSlot2.style.display = 'none';
    }
  }
  updateBreedSlots();
  saveGame();
}

function updateBreedSlots() {
  const allPets = getAllPetsForBreeding();
  const pet1 = allPets.find(p => p.id === gameState.breedSlot1);
  const pet2 = allPets.find(p => p.id === gameState.breedSlot2);

  const slot1 = $('#breed-slot1');
  const slot2 = $('#breed-slot2');

  if (pet1) {
    slot1.innerHTML = `
      <div class="breed-slot-pet">
        <div class="pet-mini-emoji" style="${pet1.shiny ? 'filter:drop-shadow(0 0 8px gold)' : ''};white-space:pre;">${getPetDisplayEmoji(pet1)}</div>
        <div class="pet-mini-name">${pet1.name}${getGenderSymbol(pet1.gender)}</div>
        <div class="pet-mini-rarity" style="color:${pet1.rarity.color}">${pet1.rarity.stars}</div>
      </div>
    `;
    slot1.onclick = () => {
      selectedBreedSlot = 1;
      const hint = $('#breed-mode-hint');
      if (hint) {
        hint.style.display = 'block';
        hint.className = 'breed-mode-hint selecting-father';
        hint.textContent = '正在选择父宠物（公） - 蓝色高亮宠物可选择';
      }
      renderBreedCollection();
      showToast('请选择父方宠物');
    };
  } else {
    slot1.innerHTML = `
      <div class="breed-slot-empty">
        <span class="breed-slot-icon">➕</span>
        <span>选择父方 ♂</span>
      </div>
    `;
    slot1.onclick = () => {
      selectedBreedSlot = 1;
      const hint = $('#breed-mode-hint');
      if (hint) {
        hint.style.display = 'block';
        hint.className = 'breed-mode-hint selecting-father';
        hint.textContent = '正在选择父宠物（公） - 蓝色高亮宠物可选择';
      }
      renderBreedCollection();
      showToast('请选择父方宠物');
    };
  }

  if (pet2) {
    slot2.innerHTML = `
      <div class="breed-slot-pet">
        <div class="pet-mini-emoji" style="${pet2.shiny ? 'filter:drop-shadow(0 0 8px gold)' : ''};white-space:pre;">${getPetDisplayEmoji(pet2)}</div>
        <div class="pet-mini-name">${pet2.name}${getGenderSymbol(pet2.gender)}</div>
        <div class="pet-mini-rarity" style="color:${pet2.rarity.color}">${pet2.rarity.stars}</div>
      </div>
    `;
    slot2.onclick = () => {
      selectedBreedSlot = 2;
      const hint = $('#breed-mode-hint');
      if (hint) {
        hint.style.display = 'block';
        hint.className = 'breed-mode-hint selecting-mother';
        hint.textContent = '正在选择母宠物（母） - 粉色高亮宠物可选择';
      }
      renderBreedCollection();
      showToast('请选择母方宠物');
    };
  } else {
    slot2.innerHTML = `
      <div class="breed-slot-empty">
        <span class="breed-slot-icon">➕</span>
        <span>选择母方 ♀</span>
      </div>
    `;
    slot2.onclick = () => {
      selectedBreedSlot = 2;
      const hint = $('#breed-mode-hint');
      if (hint) {
        hint.style.display = 'block';
        hint.className = 'breed-mode-hint selecting-mother';
        hint.textContent = '正在选择母宠物（母） - 粉色高亮宠物可选择';
      }
      renderBreedCollection();
      showToast('请选择母方宠物');
    };
  }

  const btn = $('#btn-breed-start');
  if (pet1 && pet2) {
    const check = canBreed(pet1, pet2);
    btn.disabled = !check.ok;
    if (!check.ok) {
      btn.title = check.reason;
    }
  } else {
    btn.disabled = true;
    btn.title = '';
  }
}

function startBreeding() {
  const pet = gameState.pet;
  if (!pet || pet.level < 10) {
    showToast('宠物需要达到 10 级才能繁殖哦~');
    return;
  }

  // 睡觉状态检查
  if (pet.isSleeping) {
    showToast('宠物正在睡觉，让它休息吧~');
    return;
  }

  // 生病状态检查
  if (pet.status.health < 30) {
    showToast('宠物身体不舒服，先治疗一下吧~');
    return;
  }

  // 体力检查
  if (pet.status.energy < 20) {
    if (pet.status.energy < 10) {
      showToast('宠物精疲力竭了，必须睡觉！');
    } else {
      showToast('宠物太累了，让它休息一下吧！');
    }
    return;
  }

  gameState.lastActionTime = Date.now();
  gameState.lastInteractionTime = Date.now();

  const allPets = getAllPetsForBreeding();
  const parent1 = allPets.find(p => p.id === gameState.breedSlot1);
  const parent2 = allPets.find(p => p.id === gameState.breedSlot2);

  if (!parent1 || !parent2) {
    showToast('请选择两只宠物');
    return;
  }

  // 父方/母方性别检查
  if (parent1.gender && parent1.gender !== 'male') {
    showToast('父方必须是公宠物哦~');
    return;
  }
  if (parent2.gender && parent2.gender !== 'female') {
    showToast('母方必须是母宠物哦~');
    return;
  }

  // 使用 canBreed 统一检查（自己、性别、导入、次数等）
  const check = canBreed(parent1, parent2);
  if (!check.ok) {
    showToast(check.reason);
    return;
  }

  if (gameState.coins < 200) {
    showToast('金币不足！繁殖需要 200 🪙');
    return;
  }

  gameState.coins -= 200;

  // 增加繁殖次数记录
  incrementBreedCount(parent1.id, parent2.id);

  // 繁殖逻辑
  const baby = breedPets(parent1, parent2);
  gameState.records.totalBreeds++;

  // 繁殖降低快乐（-10）
  if (parent1.id === pet.id) {
    pet.status.happiness = clamp(pet.status.happiness - 10, 0, 100);
  }
  if (parent2.id === pet.id) {
    pet.status.happiness = clamp(pet.status.happiness - 10, 0, 100);
  }
  // 如果两只都是收藏中的不同宠物，也给当前宠物降快乐
  // （繁殖对当前活跃宠物有精力消耗）
  pet.status.energy = clamp(pet.status.energy - 20, 0, 100);

  // 显示结果
  showBreedResult(baby);

  // 加入收藏
  addPetToCollection(baby);

  checkAchievements();
  saveGame();
}

// ===== 繁殖阶数计算 =====
// 根据父母阶数计算后代阶数及是否为变异闪光
function calcOffspringStage(parent1, parent2) {
  const s1 = parent1.stage || 1;
  const s2 = parent2.stage || 1;
  // 确保 s1 <= s2，统一处理顺序
  const low = Math.min(s1, s2);
  const high = Math.max(s1, s2);
  const roll = Math.random();

  if (low === 1 && high === 1) {
    // 1阶 × 1阶：100% → 1阶
    return { stage: 1, shinyVariant: false };
  } else if (low === 2 && high === 2) {
    // 2阶 × 2阶：99% → 2阶，1% → 变异闪光1阶
    if (roll < 0.99) {
      return { stage: 2, shinyVariant: false };
    } else {
      return { stage: 1, shinyVariant: true };
    }
  } else if (low === 1 && high === 2) {
    // 1阶 × 2阶：50% → 1阶，50% → 2阶
    if (roll < 0.5) {
      return { stage: 1, shinyVariant: false };
    } else {
      return { stage: 2, shinyVariant: false };
    }
  } else if (low === 3 && high === 3) {
    // 3阶 × 3阶：95% → 3阶，4% → 变异闪光1阶，1% → 变异闪光2阶
    if (roll < 0.95) {
      return { stage: 3, shinyVariant: false };
    } else if (roll < 0.99) {
      return { stage: 1, shinyVariant: true };
    } else {
      return { stage: 2, shinyVariant: true };
    }
  } else if (low === 2 && high === 3) {
    // 3阶 × 2阶：98% → 2阶，1.9% → 变异闪光1阶，0.1% → 变异闪光2阶
    if (roll < 0.98) {
      return { stage: 2, shinyVariant: false };
    } else if (roll < 0.999) {
      return { stage: 1, shinyVariant: true };
    } else {
      return { stage: 2, shinyVariant: true };
    }
  } else if (low === 1 && high === 3) {
    // 3阶 × 1阶：50% → 1阶，50% → 2阶（简化处理）
    if (roll < 0.5) {
      return { stage: 1, shinyVariant: false };
    } else {
      return { stage: 2, shinyVariant: false };
    }
  }
  // 默认返回 1 阶
  return { stage: 1, shinyVariant: false };
}

// 根据基础物种ID和目标阶数，随机选择该阶数下的对应物种
function pickSpeciesByStage(baseId, stage) {
  if (stage === 1) {
    return SPECIES_LIST.find(s => s.id === baseId && s.stage === 1) || SPECIES_LIST.find(s => s.stage === 1);
  }
  // stage 2 或 3：从该基础物种在该阶段的所有分支中随机选一个
  const candidates = SPECIES_LIST.filter(s => s.baseId === baseId && s.stage === stage);
  if (candidates.length > 0) {
    return pick(candidates);
  }
  // 找不到的话，从该阶段所有物种中随机选
  const fallback = SPECIES_LIST.filter(s => s.stage === stage);
  return pick(fallback);
}

function breedPets(parent1, parent2) {
  // 计算后代阶数和是否变异闪光
  const stageResult = calcOffspringStage(parent1, parent2);
  const offspringStage = stageResult.stage;
  const isShinyVariant = stageResult.shinyVariant;

  // 获取父母的基础物种
  const p1Base = parent1.species.baseId ? SPECIES_LIST.find(s => s.id === parent1.species.baseId) : parent1.species;
  const p2Base = parent2.species.baseId ? SPECIES_LIST.find(s => s.id === parent2.species.baseId) : parent2.species;

  // 物种遗传：完全随机
  let baseSpecies;
  const allStage1 = SPECIES_LIST.filter(s => s.stage === 1);
  baseSpecies = pick(allStage1);

  // 根据目标阶数选择具体物种
  const species = pickSpeciesByStage(baseSpecies.id, offspringStage);

  // 稀有度遗传：取父母稀有度中间偏上 + 小概率提升
  const r1 = RARITIES.findIndex(r => r.id === parent1.rarity.id);
  const r2 = RARITIES.findIndex(r => r.id === parent2.rarity.id);
  const midRarity = Math.max(r1, r2);
  let rarityIdx = midRarity;
  if (Math.random() < 0.15) rarityIdx = clamp(midRarity + 1, 0, RARITIES.length - 1);
  if (Math.random() < 0.1) rarityIdx = clamp(midRarity - 1, 0, RARITIES.length - 1);
  const rarity = RARITIES[rarityIdx];

  // 闪光概率（单方闪光父母大幅提高，双方闪光更高）
  let shinyChance = 0.01;
  if (parent1.shiny && parent2.shiny) shinyChance = 0.25;
  else if (parent1.shiny || parent2.shiny) shinyChance = 0.08;
  // 变异闪光强制为 true
  const shiny = isShinyVariant ? true : (Math.random() < shinyChance);

  // 子代属性：完全随机生成（不受父母影响），稀有度越高初始值越高
  const babyStats = {};
  const peakStat = STAT_NAMES[Math.floor(Math.random() * STAT_NAMES.length)];
  let lowStat;
  do { lowStat = STAT_NAMES[Math.floor(Math.random() * STAT_NAMES.length)]; } while (lowStat === peakStat);

  STAT_NAMES.forEach(stat => {
    let val;
    if (stat === peakStat) {
      val = (rarity.statMin || 20) + 50 + randInt(0, 30);
    } else if (stat === lowStat) {
      val = Math.max(1, (rarity.statMin || 20) - 10 + randInt(0, 15));
    } else {
      val = (rarity.statMin || 20) + randInt(0, 40);
    }
    babyStats[stat] = clamp(val, 1, 100);
  });

  // 名字
  const names = ['小团子','豆豆','球球','棉花糖','布丁','年糕','糯米','芝麻','汤圆','饭团',
                 '可乐','奶茶','咖啡','抹茶','芒果','草莓','蓝莓','樱桃','西瓜','蜜桃',
                 '星星','月亮','太阳','云朵','彩虹','雪花','闪电','微风','露珠','花瓣'];
  const babyNames = ['宝宝','小宝贝','蛋蛋','咪咪','毛毛','绒绒','团团','圆圆'];

  return {
    id: generatePetId(),
    species: species,
    rarity: rarity,
    shiny: shiny,
    hat: 'none',
    stats: babyStats,
    peakStat: peakStat,
    lowStat: lowStat,
    name: pick([...names, ...babyNames]),
    personality: pick(PERSONALITIES),
    gender: Math.random() < 0.5 ? 'male' : 'female',
    stage: offspringStage,
    evolveBranch: species.evolveBranch || null,
    level: 1,
    exp: 0,
    expToNext: 100,
    status: { hunger: 100, happiness: 100, clean: 100, energy: 100, health: 100 },
    isSleeping: false,
    equippedHat: null,
    equippedHatColor: null,
    hatchTime: Date.now(),
    skillPoints: 1,
    unlockedSkills: [],
    parents: [parent1.id, parent2.id],
    dominantStat: getDominantStat({ stats: babyStats })
  };
}

function showBreedResult(baby) {
  $('#breed-result-sprite').textContent = baby.species.emoji;
  if (baby.shiny) {
    $('#breed-result-sprite').style.filter = 'drop-shadow(0 0 20px gold) brightness(1.3)';
  } else {
    $('#breed-result-sprite').style.filter = '';
  }

  const isImported = baby.isImported || baby.imported;

  $('#breed-result-info').innerHTML = `
    <div class="breed-result-name">${baby.name}</div>
    <div class="breed-result-rarity" style="color:${baby.rarity.color}">${baby.rarity.stars} ${baby.rarity.name}</div>
    ${baby.shiny ? '<div class="breed-result-shiny">✨ SHINY ✨</div>' : ''}
    <div class="breed-result-species">${baby.species.emoji} ${baby.species.name}</div>
    <div class="breed-result-stats">
      ${STAT_NAMES.map(s => `<span>${STAT_LABELS[s].icon}${baby.stats[s]}</span>`).join(' ')}
    </div>
    <div style="margin-top:12px;">
      <button class="btn btn-primary breed-set-active-btn" ${isImported ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}>
        ${isImported ? '导入宠物不能设为主宠' : '设为主宠'}
      </button>
    </div>
  `;

  // 绑定设为主宠按钮
  const setActiveBtn = $('#breed-result-info').querySelector('.breed-set-active-btn');
  if (setActiveBtn && !isImported) {
    setActiveBtn.onclick = () => {
      switchPet(baby.id);
      $('#breed-result-modal').classList.add('hidden');
      renderBreedCollection();
      updateBreedSlots();
    };
  }

  $('#breed-result-modal').classList.remove('hidden');
}

function importPetForBreeding() {
  const code = $('#breed-import-code').value.trim();
  if (!code) {
    showToast('请输入宠物代码');
    return;
  }

  const pet = parseShareCode(code);
  if (!pet) {
    showToast('无效的宠物代码');
    return;
  }

  // 检查是否是自己的宠物
  const playerPet = gameState.pet;
  if (playerPet && pet.originalId && pet.originalId === playerPet.id) {
    showToast('这是你自己的宠物，不能导入哦！');
    return;
  }

  // 检查是否已经导入过
  if (pet.originalId && gameState.importedPetIds.includes(pet.originalId)) {
    showToast('这只宠物已经导入过了！');
    return;
  }

  pet.isImported = true;
  pet.imported = true;
  gameState.importedPets.push(pet);
  if (pet.originalId) {
    gameState.importedPetIds.push(pet.originalId);
  }

  showToast(`成功导入 ${pet.name}！`);
  $('#breed-import-code').value = '';
  renderBreedCollection();
  updateBreedSlots();
  saveGame();
}

// ===== 宠物进化系统 =====
function openEvolvePanel() {
  const pet = gameState.pet;
  if (!pet) return;

  $('#evolve-current-emoji').textContent = pet.species.emoji;
  $('#evolve-current-emoji').style.whiteSpace = 'pre';
  $('#evolve-current-name').textContent = getPetDisplayName(pet) + getGenderSymbol(pet.gender);
  $('#evolve-current-level').textContent = `Lv.${pet.level}`;
  $('#evolve-current-rarity').textContent = `${pet.rarity.stars} ${pet.rarity.name}`;
  const stageText = ['', '一阶段', '二阶段', '三阶段'][pet.stage || 1];
  $('#evolve-current-stage') && ($('#evolve-current-stage').textContent = stageText);

  if (pet.shiny) {
    $('#evolve-current-emoji').style.filter = 'drop-shadow(0 0 12px gold)';
  } else {
    $('#evolve-current-emoji').style.filter = '';
  }

  renderEvolutionTree();
  showPanel('evolve-panel');
}

function renderEvolutionTree() {
  const pet = gameState.pet;
  const tree = $('#evolve-tree');
  if (!pet || !tree) return;

  const paths = getEvolutionPaths(pet);

  if (!paths || paths.length === 0) {
    tree.innerHTML = '<p style="text-align:center;color:#889;padding:20px">没有可用的进化路线</p>';
    return;
  }

  // 检查是否有满足条件的路线
  const availablePaths = paths.filter(p => {
    return pet.level >= p.level && gameState.coins >= p.cost;
  });

  if (availablePaths.length === 0) {
    tree.innerHTML = `<p style="text-align:center;color:#889;padding:20px">进化条件不足<br>需要 Lv.${paths[0].level} 及 ${paths[0].cost}🪙</p>`;
    return;
  }

  // 只显示一个进化按钮，进化时随机选择路线
  const cost = availablePaths[0].cost; // 所有同级路线费用相同
  const levelReq = availablePaths[0].level;
  const stage = pet.stage || 1;
  const nextStage = stage + 1;

  // 获取可能的进化结果（所有可用路线的目标物种）
  const possibleResults = availablePaths.map(p => {
    const branch = EVOLVE_BRANCHES[p.branch];
    // 使用 getEvolutionPaths 返回的 toSpecies，无需额外构建
    return { branch: p.branch, name: branch.prefix + pet.species.name, emoji: branch.emoji };
  });

  tree.innerHTML = `
    <div class="evolve-path-card available" style="text-align:center;padding:16px;">
      <div style="font-size:14px;color:#aab;margin-bottom:12px;">
        进化到 ${nextStage} 阶 · 需要等级 Lv.${levelReq} · 消耗 🪙${cost}
      </div>
      <div style="font-size:12px;color:#667;margin-bottom:8px;">
        进化方向随机（多种可能性）
      </div>
      ${possibleResults.map(r => `
        <div style="display:inline-block;margin:4px 8px;padding:4px 10px;background:rgba(255,255,255,0.05);border-radius:8px;font-size:13px;color:#99a;">
          ${r.emoji} ${r.name}
        </div>
      `).join('')}
      <div style="margin-top:14px;">
        <button class="btn btn-primary evolve-btn" id="btn-evolve-random">🎲 随机进化</button>
      </div>
    </div>
  `;

  // 绑定随机进化按钮
  const btn = $('#btn-evolve-random');
  if (btn) {
    btn.onclick = () => {
      // 从可用路线中随机选择一条
      const randomPath = availablePaths[Math.floor(Math.random() * availablePaths.length)];
      doNewEvolution(randomPath);
    };
  }
}

function doNewEvolution(evo) {
  const pet = gameState.pet;
  if (!pet) return;

  // 睡觉状态检查
  if (pet.isSleeping) {
    showToast('宠物正在睡觉，让它休息吧~');
    return;
  }

  // 生病状态检查
  if (pet.status.health < 30) {
    showToast('宠物身体不舒服，先治疗一下吧~');
    return;
  }

  // 体力检查
  if (pet.status.energy < 20) {
    if (pet.status.energy < 10) {
      showToast('宠物精疲力竭了，必须睡觉！');
    } else {
      showToast('宠物太累了，让它休息一下吧！');
    }
    return;
  }

  gameState.coins -= evo.cost;
  gameState.records.totalEvolves++;
  gameState.lastInteractionTime = Date.now();

  // 进化降低快乐（-5）
  pet.status.happiness = clamp(pet.status.happiness - 5, 0, 100);

  const fromSpecies = pet.species;
  const toSpecies = evo.toSpecies;

  // 进化动画
  showEvolveResult(fromSpecies, toSpecies, pet.shiny);

  // 属性提升（进化成长：各 +5~15，乘以成长倍率）
  STAT_NAMES.forEach(stat => {
    const mult = getGrowthMultiplier(pet, stat);
    addStat(pet, stat, randInt(5, 15) * mult);
  });

  // 物种变化
  pet.species = toSpecies;
  pet.stage = toSpecies.stage;
  pet.evolveBranch = toSpecies.evolveBranch;

  // 稀有度可能提升（只会升级或保持，不会降级）
  // 进化时稀有度提升概率：普通→非凡 20%，非凡→稀有 15%，稀有→史诗 10%，史诗→传说 5%，传说不变
  const curIdx = RARITIES.findIndex(r => r.id === pet.rarity.id);
  const upgradeChances = [0.20, 0.15, 0.10, 0.05, 0]; // 对应 common/uncommon/rare/epic/legendary 的升级概率
  if (curIdx < RARITIES.length - 1 && Math.random() < upgradeChances[curIdx]) {
    pet.rarity = RARITIES[curIdx + 1];
  }
  // 闪光状态进化后保持（pet.shiny 不做修改，自动保留）

  // 更新收藏中的宠物
  const idx = gameState.petCollection.findIndex(p => p.id === pet.id);
  if (idx >= 0) gameState.petCollection[idx] = pet;

  // 添加到图鉴
  if (!gameState.album.includes(toSpecies.id)) {
    gameState.album.push(toSpecies.id);
  }
  // 更新图鉴详细信息（含进化计数）
  updateAlbumDetails(pet);
  if (gameState.albumDetails && gameState.albumDetails[toSpecies.id]) {
    gameState.albumDetails[toSpecies.id].evolutions = (gameState.albumDetails[toSpecies.id].evolutions || 0) + 1;
  }

  gainExp(50);
  checkAchievements();
  saveGame();
  updateGameUI();
}

function showEvolveResult(fromSpecies, toSpecies, shiny) {
  $('#evolve-from').textContent = fromSpecies.emoji;
  $('#evolve-from').style.whiteSpace = 'pre';
  $('#evolve-to').textContent = toSpecies.emoji;
  $('#evolve-to').style.whiteSpace = 'pre';

  if (shiny) {
    $('#evolve-from').style.filter = 'drop-shadow(0 0 10px gold)';
    $('#evolve-to').style.filter = 'drop-shadow(0 0 15px gold)';
  } else {
    $('#evolve-from').style.filter = '';
    $('#evolve-to').style.filter = '';
  }

  $('#evolve-result-info').innerHTML = `
    <div class="evolve-result-name">${gameState.pet.name} 进化了！</div>
    <div class="evolve-result-species">${fromSpecies.name} → ${toSpecies.name}</div>
    <div class="evolve-result-bonus">属性大幅提升！</div>
  `;

  // 添加进化粒子效果
  spawnParticles('✨', 20, window.innerWidth / 2, window.innerHeight / 2);
  spawnParticles('⭐', 10, window.innerWidth / 2, window.innerHeight / 2);

  $('#evolve-result-modal').classList.remove('hidden');
}

// ===== 成就系统 =====
function checkAchievements() {
  const newlyUnlocked = [];

  ACHIEVEMENTS.forEach(ach => {
    if (!gameState.achievements.unlocked.includes(ach.id)) {
      try {
        if (ach.check(gameState)) {
          gameState.achievements.unlocked.push(ach.id);
          newlyUnlocked.push(ach);
        }
      } catch(e) { /* ignore */ }
    }
  });

  newlyUnlocked.forEach(ach => {
    setTimeout(() => showAchievementUnlock(ach), 500);
  });

  // ===== 隐藏头衔检查 =====
  const pet = gameState.pet;
  const unlocked = gameState.achievements.unlocked;

  // "腐败的" - 清洁值低于10
  if (pet && pet.status.clean < 10 && !unlocked.includes('hidden_stinky')) {
    gameState.achievements.unlocked.push('hidden_stinky');
    showToast('🎁 发现隐藏头衔：腐败的！');
  }

  // "被遗忘的" - 长时间没有和宠物互动（lastInteractionTime超过24小时）
  if (pet && gameState.lastInteractionTime) {
    const hoursSinceInteraction = (Date.now() - gameState.lastInteractionTime) / 3600000;
    if (hoursSinceInteraction > 24 && !unlocked.includes('hidden_neglect')) {
      gameState.achievements.unlocked.push('hidden_neglect');
      showToast('🎁 发现隐藏头衔：被遗忘的！');
    }
  }

  // "孤独的" - 宠物快乐值低于5
  if (pet && pet.status.happiness < 5 && !unlocked.includes('hidden_lonely')) {
    gameState.achievements.unlocked.push('hidden_lonely');
    showToast('🎁 发现隐藏头衔：孤独的！');
  }

  // "午夜" - 凌晨0-2点之间登录游戏
  const hour = new Date().getHours();
  if (hour >= 0 && hour < 2 && !unlocked.includes('hidden_midnight')) {
    gameState.achievements.unlocked.push('hidden_midnight');
    showToast('🎁 发现隐藏头衔：午夜！');
  }

  // "破产的" - 金币低于5且总金币获得超过500
  if (gameState.coins < 5 && gameState.records.totalCoinsEarned > 500 && !unlocked.includes('hidden_broke')) {
    gameState.achievements.unlocked.push('hidden_broke');
    showToast('🎁 发现隐藏头衔：破产的！');
  }

  // "失眠者" - 体力极低但还不睡觉
  if (pet && pet.status.energy < 10 && !pet.isSleeping && !unlocked.includes('hidden_insomniac')) {
    gameState.achievements.unlocked.push('hidden_insomniac');
    showToast('🎁 发现隐藏头衔：失眠者！');
  }

  // "贪心鬼" - 金币超过5000
  if (gameState.coins >= 5000 && !unlocked.includes('hidden_greedy')) {
    gameState.achievements.unlocked.push('hidden_greedy');
    showToast('🎁 发现隐藏头衔：贪心鬼！');
  }

  // "倒霉蛋" - 总胜率低于10%且对战超过10场
  if (gameState.battleStats && gameState.battleStats.total >= 10) {
    if (gameState.battleStats.wins / gameState.battleStats.total < 0.1 &&
        !unlocked.includes('hidden_unlucky')) {
      gameState.achievements.unlocked.push('hidden_unlucky');
      showToast('🎁 发现隐藏头衔：倒霉蛋！');
    }
  }

  // "夜猫子" - 凌晨3-6点之间登录
  if (hour >= 3 && hour < 6 && !unlocked.includes('hidden_nightowl')) {
    gameState.achievements.unlocked.push('hidden_nightowl');
    showToast('🎁 发现隐藏头衔：夜猫子！');
  }

  // 小游戏隐藏成就
  const lb = gameState.leaderboards || {};
  // 接接乐超过200分
  if (lb.catch && lb.catch.length > 0 && lb.catch[0].score >= 200 && !gameState.achievements.unlocked.includes('hidden_catch_master')) {
    gameState.achievements.unlocked.push('hidden_catch_master');
    setTimeout(() => showToast('🎁 发现隐藏头衔：接物达人！'), 1500);
  }
  // 五子棋少于30步赢（排行榜存的是负步数，所以score < -29表示30步以内获胜）
  if (lb.gomoku && lb.gomoku.length > 0 && !gameState.achievements.unlocked.includes('hidden_gomoku_genius')) {
    // 排行榜第一条是最佳成绩（负步数最大=实际步数最少）
    if (lb.gomoku[0].score < -29) {
      gameState.achievements.unlocked.push('hidden_gomoku_genius');
      setTimeout(() => showToast('🎁 发现隐藏头衔：棋圣！'), 1500);
    }
  }

  return newlyUnlocked;
}

function showAchievementUnlock(ach) {
  showToast(`🏆 成就解锁：${ach.name}！+${ach.reward}🪙`);
  gameState.coins += ach.reward;
  gameState.records.totalCoinsEarned += ach.reward;
  gameState.achievements.claimed.push(ach.id);

  // 检查是否解锁了新头衔
  const newTitles = [];
  for (const [id, prefix] of Object.entries(TITLE_PREFIXES)) {
    if (prefix.source === ach.id) {
      newTitles.push(`前缀「${prefix.text}」`);
    }
  }
  for (const [id, suffix] of Object.entries(TITLE_SUFFIXES)) {
    if (suffix.source === ach.id) {
      newTitles.push(`后缀「${suffix.text}」`);
    }
  }
  if (newTitles.length > 0) {
    setTimeout(() => {
      showToast(`✨ 解锁新头衔：${newTitles.join('、')}！`);
    }, 1200);
  }

  saveGame();
  updateGameUI();
}

function renderAchievements() {
  const list = $('#achievements-list');
  list.innerHTML = '';

  const categories = [
    { id: 'care',    name: '养成' },
    { id: 'battle',  name: '对战' },
    { id: 'collect', name: '收集' },
    { id: 'special', name: '特殊' }
  ];

  categories.forEach(cat => {
    const catAch = ACHIEVEMENTS.filter(a => a.category === cat.id);
    const catDiv = document.createElement('div');
    catDiv.className = 'achievement-category';
    catDiv.innerHTML = `<div class="achievement-cat-title">${cat.name}</div>`;

    const achList = document.createElement('div');
    achList.className = 'achievement-cat-list';

    catAch.forEach(ach => {
      const unlocked = gameState.achievements.unlocked.includes(ach.id);
      const item = document.createElement('div');
      item.className = `achievement-item ${unlocked ? 'unlocked' : 'locked'}`;

      // 查找该成就解锁的头衔
      const titleRewards = [];
      for (const [id, prefix] of Object.entries(TITLE_PREFIXES)) {
        if (prefix.source === ach.id) titleRewards.push(`前缀「${prefix.text}」`);
      }
      for (const [id, suffix] of Object.entries(TITLE_SUFFIXES)) {
        if (suffix.source === ach.id) titleRewards.push(`后缀「${suffix.text}」`);
      }
      const titleText = titleRewards.length > 0 ? `<div class="achievement-titles">${titleRewards.join(' ')}</div>` : '';

      item.innerHTML = `
        <div class="achievement-icon">${unlocked ? ach.icon : '🔒'}</div>
        <div class="achievement-info">
          <div class="achievement-name">${ach.name}</div>
          <div class="achievement-desc">${ach.desc}</div>
          ${titleText}
        </div>
        <div class="achievement-reward">🪙${ach.reward}</div>
      `;
      achList.appendChild(item);
    });

    catDiv.appendChild(achList);
    list.appendChild(catDiv);
  });

  const unlockedCount = gameState.achievements.unlocked.length;
  $('#achievement-progress').textContent = `${unlockedCount}/${ACHIEVEMENTS.length}`;
}

// ===== 技能树系统 =====

// 获取宠物对应的技能组
function getPetSkillTree(pet) {
  if (!pet) return null;
  const dominant = pet.dominantStat || getDominantStat(pet);
  return SKILL_TREE_GROUPS[dominant] || null;
}

// 渲染技能树面板
function renderSkillTree() {
  const pet = gameState.pet;
  if (!pet) return;

  const dominant = pet.dominantStat || getDominantStat(pet);
  const statInfo = STAT_LABELS[dominant] || {};
  const skillTree = getPetSkillTree(pet);

  const infoEl = $('#skill-tree-info');
  if (infoEl) {
    infoEl.innerHTML = `<div style="text-align:center;padding:8px;color:${statInfo.color || '#fff'}">${statInfo.icon} ${statInfo.name}系技能树</div><div style="text-align:center;font-size:12px;color:#aaa">每级可选择战斗被动(A)或养成被动(B)</div>`;
  }

  // 更新技能点显示
  const pointsEl = document.querySelector('#skill-tree-points span');
  if (pointsEl) pointsEl.textContent = pet.skillPoints || 0;

  const list = $('#skill-tree-list');
  if (!list) return;
  list.innerHTML = '';

  if (!skillTree || skillTree.length === 0) {
    $('#skill-tree-list').innerHTML = '<p style="color:#889;text-align:center;padding:20px">暂无可用技能</p>';
    return;
  }

  const unlocked = new Set(pet.unlockedSkills || []);

  skillTree.forEach((slot, idx) => {
    if (!slot) return;

    // 主动技能分隔线
    if (idx > 0 && idx % 5 === 0 && idx <= 30 && slot.active) {
      const divider = document.createElement('div');
      divider.className = 'skill-divider';
      divider.textContent = `🌟 主动技能 (Lv.${idx})`;
      divider.style.cssText = 'text-align:center;padding:8px;margin:8px 0;background:linear-gradient(90deg,transparent,#6C5CE7,transparent);color:#fff;font-size:13px;font-weight:bold;border-radius:4px;';
      list.appendChild(divider);
    }

    const container = document.createElement('div');
    container.style.cssText = 'margin:6px 0;';

    if (slot.active) {
      // 主动技能
      const skill = slot.active;
      const isUnlocked = unlocked.has(skill.id);
      const canUnlock = !isUnlocked && (pet.skillPoints || 0) > 0 && idx <= pet.level;
      // 检查前置是否都学了
      let prereqMet = true;
      for (let i = 1; i < idx; i++) {
        const prev = skillTree[i];
        if (!prev) continue;
        if (prev.active && !unlocked.has(prev.active.id)) { prereqMet = false; break; }
        if (prev.branchA && !unlocked.has(prev.branchA.id) && !unlocked.has(prev.branchB.id)) { prereqMet = false; break; }
      }

      const div = document.createElement('div');
      div.className = `skill-item ${isUnlocked ? 'unlocked' : ''} ${canUnlock && prereqMet ? 'available' : 'locked'}`;
      div.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:10px;background:#2d2d3d;border-radius:8px;border:1px solid #444;';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'skill-info';
      infoDiv.innerHTML = `
        <span class="skill-name" style="color:#FFD700">${skill.name}</span>
        <span class="skill-desc">${skill.desc}</span>
      `;
      div.appendChild(infoDiv);

      if (isUnlocked) {
        const statusSpan = document.createElement('span');
        statusSpan.className = 'skill-status';
        statusSpan.textContent = '✅ 已学';
        div.appendChild(statusSpan);
      } else if (canUnlock && prereqMet) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-primary';
        btn.textContent = '学习';
        btn.onclick = () => unlockSkill(skill.id, idx);
        div.appendChild(btn);
      } else {
        const statusSpan = document.createElement('span');
        statusSpan.className = 'skill-status';
        statusSpan.textContent = '🔒';
        div.appendChild(statusSpan);
      }

      container.appendChild(div);
    } else if (slot.branchA && slot.branchB) {
      // 分支技能
      const aUnlocked = unlocked.has(slot.branchA.id);
      const bUnlocked = unlocked.has(slot.branchB.id);
      const isUnlocked = aUnlocked || bUnlocked;
      const canUnlock = !isUnlocked && (pet.skillPoints || 0) > 0 && idx <= pet.level;
      // 检查前置
      let prereqMet = true;
      for (let i = 1; i < idx; i++) {
        const prev = skillTree[i];
        if (!prev) continue;
        if (prev.active && !unlocked.has(prev.active.id)) { prereqMet = false; break; }
        if (prev.branchA && !unlocked.has(prev.branchA.id) && !unlocked.has(prev.branchB.id)) { prereqMet = false; break; }
      }

      const header = document.createElement('div');
      header.style.cssText = 'font-size:11px;color:#888;margin-bottom:4px;';
      header.textContent = `Lv.${idx} ${isUnlocked ? '✅' : (canUnlock && prereqMet ? '👉 可选' : '🔒')}`;
      container.appendChild(header);

      const row = document.createElement('div');
      row.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px;';

      // 分支A
      const aDiv = document.createElement('div');
      const aSkill = slot.branchA;
      aDiv.style.cssText = `padding:8px;border-radius:8px;background:${aUnlocked ? '#2d4a2d' : '#2d2d3d'};border:2px solid ${aUnlocked ? '#4CAF50' : '#555'};cursor:${(canUnlock && prereqMet && !isUnlocked) ? 'pointer' : 'default'};`;
      aDiv.innerHTML = `
        <div style="font-size:10px;color:#e74c3c;margin-bottom:2px;">⚔️ 战斗被动</div>
        <div style="font-size:13px;font-weight:bold;color:${aUnlocked ? '#4CAF50' : '#ddd'}">${aSkill.name}</div>
        <div style="font-size:11px;color:#aaa">${aSkill.desc}</div>
        ${aUnlocked ? '<div style="color:#4CAF50;font-size:11px;margin-top:4px;">✅ 已选</div>' : ''}
      `;
      if (canUnlock && prereqMet && !isUnlocked) {
        aDiv.onclick = () => unlockSkill(aSkill.id, idx);
        aDiv.style.borderColor = '#e74c3c';
      }
      row.appendChild(aDiv);

      // 分支B
      const bDiv = document.createElement('div');
      const bSkill = slot.branchB;
      bDiv.style.cssText = `padding:8px;border-radius:8px;background:${bUnlocked ? '#2d4a2d' : '#2d2d3d'};border:2px solid ${bUnlocked ? '#4CAF50' : '#555'};cursor:${(canUnlock && prereqMet && !isUnlocked) ? 'pointer' : 'default'};`;
      bDiv.innerHTML = `
        <div style="font-size:10px;color:#3498db;margin-bottom:2px;">🌱 养成被动</div>
        <div style="font-size:13px;font-weight:bold;color:${bUnlocked ? '#4CAF50' : '#ddd'}">${bSkill.name}</div>
        <div style="font-size:11px;color:#aaa">${bSkill.desc}</div>
        ${bUnlocked ? '<div style="color:#4CAF50;font-size:11px;margin-top:4px;">✅ 已选</div>' : ''}
      `;
      if (canUnlock && prereqMet && !isUnlocked) {
        bDiv.onclick = () => unlockSkill(bSkill.id, idx);
        bDiv.style.borderColor = '#3498db';
      }
      row.appendChild(bDiv);

      container.appendChild(row);
    }

    list.appendChild(container);
  });
}

// 学习技能
function unlockSkill(skillId, skillIdx) {
  const pet = gameState.pet;
  if (!pet || (pet.skillPoints || 0) <= 0) {
    showToast('没有可用的技能点');
    return;
  }

  const skillTree = getPetSkillTree(pet);
  if (!skillTree || skillIdx < 0 || skillIdx >= skillTree.length) return;

  const slot = skillTree[skillIdx];
  if (!slot) return;

  // 检查是否已解锁该位置的技能
  if (slot.active) {
    if (pet.unlockedSkills.includes(slot.active.id)) return;
    // 主动技能：直接学
  } else if (slot.branchA && slot.branchB) {
    if (pet.unlockedSkills.includes(slot.branchA.id) || pet.unlockedSkills.includes(slot.branchB.id)) return;
  }

  // 找到要学的技能对象
  let skill = null;
  if (slot.active && slot.active.id === skillId) skill = slot.active;
  if (slot.branchA && slot.branchA.id === skillId) skill = slot.branchA;
  if (slot.branchB && slot.branchB.id === skillId) skill = slot.branchB;
  if (!skill) {
    showToast('技能不存在');
    return;
  }

  // 检查等级限制
  if (skillIdx > pet.level) {
    showToast('宠物等级不足');
    return;
  }

  // 检查前置技能（前面所有级别的技能都必须学了）
  for (let i = 1; i < skillIdx; i++) {
    const prev = skillTree[i];
    if (!prev) continue;
    let prevUnlocked = false;
    if (prev.active && pet.unlockedSkills.includes(prev.active.id)) prevUnlocked = true;
    if (prev.branchA && (pet.unlockedSkills.includes(prev.branchA.id) || pet.unlockedSkills.includes(prev.branchB.id))) prevUnlocked = true;
    if (!prevUnlocked) {
      showToast('需要先学习前置技能');
      return;
    }
  }

  // 学习技能
  if (!pet.unlockedSkills) pet.unlockedSkills = [];
  pet.unlockedSkills.push(skillId);
  pet.skillPoints--;

  const branchLabel = skill.branch === 'A' ? '⚔️ 战斗被动' : (skill.branch === 'B' ? '🌱 养成被动' : '🌟 主动技能');
  showToast(`${branchLabel} 学习了：${skill.name}`);

  renderSkillTree();
  saveGame();
}

// 更新属性面板中的技能概览
function updateStatsSkillsSummary() {
  const pet = gameState.pet;
  const el = $('#stats-skills-summary');
  if (!el || !pet) return;

  const skillTree = getPetSkillTree(pet);
  if (!skillTree) {
    el.textContent = '暂无技能树';
    return;
  }

  const unlocked = new Set(pet.unlockedSkills || []);
  let activeCount = 0, branchACount = 0, branchBCount = 0;
  skillTree.forEach(slot => {
    if (!slot) return;
    if (slot.active && unlocked.has(slot.active.id)) activeCount++;
    if (slot.branchA && unlocked.has(slot.branchA.id)) branchACount++;
    if (slot.branchB && unlocked.has(slot.branchB.id)) branchBCount++;
  });

  el.innerHTML = `
    <div style="display:flex;justify-content:space-around;font-size:12px;">
      <span>🌟 主动: <b>${activeCount}</b></span>
      <span>⚔️ 战斗被动: <b>${branchACount}</b></span>
      <span>🌱 养成被动: <b>${branchBCount}</b></span>
    </div>
  `;

  const pointsEl = $('#stats-skill-points');
  if (pointsEl) {
    pointsEl.textContent = `✨ 可用技能点：${pet.skillPoints || 0}`;
    pointsEl.classList.remove('hidden');
  }
}

// ===== 每日任务系统 =====
function getTodayString() {
  const d = new Date();
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function initDailyTasks() {
  const today = getTodayString();
  if (gameState.dailyTasks.date !== today) {
    // 生成新的每日任务
    const shuffled = [...DAILY_TASK_TEMPLATES].sort(() => Math.random() - 0.5);
    const selected = shuffled.slice(0, 5);
    gameState.dailyTasks = {
      date: today,
      tasks: selected.map(t => ({
        ...t,
        progress: 0,
        claimed: false
      })),
      claimedAll: false
    };
    saveGame();
  }
}

function updateDailyTaskProgress(type, amount) {
  if (!gameState.dailyTasks || !gameState.dailyTasks.tasks) return;

  gameState.dailyTasks.tasks.forEach(task => {
    if (task.type === type && !task.claimed) {
      task.progress = Math.min(task.target, task.progress + amount);
    }
  });
  saveGame();
}

function renderDailyTasks() {
  initDailyTasks();
  const list = $('#daily-tasks-list');
  list.innerHTML = '';

  gameState.dailyTasks.tasks.forEach((task, idx) => {
    const completed = task.progress >= task.target;
    const item = document.createElement('div');
    item.className = `task-item ${task.claimed ? 'claimed' : completed ? 'completed' : ''}`;
    item.innerHTML = `
      <div class="task-info">
        <div class="task-name">${task.name}</div>
        <div class="task-progress">${task.progress}/${task.target}</div>
      </div>
      <div class="task-reward">🪙${task.reward}</div>
      <button class="btn task-claim-btn" ${task.claimed ? 'disabled' : completed ? '' : 'disabled'}>
        ${task.claimed ? '已领取' : completed ? '领取' : '进行中'}
      </button>
    `;

    const btn = item.querySelector('.task-claim-btn');
    btn.onclick = () => {
      if (completed && !task.claimed) {
        claimDailyTask(idx);
      }
    };

    list.appendChild(item);
  });
}

function claimDailyTask(idx) {
  const task = gameState.dailyTasks.tasks[idx];
  if (!task || task.claimed || task.progress < task.target) return;

  task.claimed = true;
  gameState.coins += task.reward;
  gameState.records.totalCoinsEarned += task.reward;

  showToast(`任务完成！+${task.reward}🪙`);
  renderDailyTasks();
  saveGame();
  updateGameUI();
}

// ===== 对战面板 =====
function openBattlePanel() {
  updateBattleStatsUI();
  // 添加五维属性提示
  const hintEl = $('#battle-stat-hint');
  if (!hintEl) {
    const sectionTitle = document.querySelector('#battle-panel .section-title');
    if (sectionTitle) {
      const hint = document.createElement('div');
      hint.id = 'battle-stat-hint';
      hint.style.cssText = 'font-size:12px;color:#888;margin-bottom:8px;text-align:center;';
      hint.textContent = '💡 五维属性决定战斗能力';
      sectionTitle.parentNode.insertBefore(hint, sectionTitle);
    }
  }
  showPanel('battle-panel');
}

function updateBattleStatsUI() {
  const bs = gameState.battleStats;
  $('#battle-total').textContent = bs.total;
  $('#battle-wins').textContent = bs.wins;
  $('#battle-losses').textContent = bs.losses;
  $('#battle-winrate').textContent = bs.total > 0 ? Math.floor(bs.wins / bs.total * 100) + '%' : '0%';
  $('#battle-closewins').textContent = bs.closeWins || 0;
  $('#battle-streak').textContent = bs.streak;

  const rank = getCurrentRank();
  $('#rank-icon').textContent = rank.icon;
  $('#rank-name').textContent = rank.name;

  const nextRankIdx = Math.min(getRankIndex(rank.id) + 1, RANKS.length - 1);
  const nextRank = RANKS[nextRankIdx];
  const progressInRank = bs.rankPoints - rank.minPoints;
  const rankRange = rank.maxPoints - rank.minPoints;
  const pct = rank.id === 'rainbow' ? 100 : clamp((progressInRank / rankRange) * 100, 0, 100);

  $('#rank-fill').style.width = pct + '%';
  $('#rank-points').textContent = rank.id === 'rainbow'
    ? `${bs.rankPoints} 积分（最高段位）`
    : `${bs.rankPoints} / ${nextRank.minPoints} 积分`;

  // PvP统计
  const pvp = gameState.pvpStats || {};
  const pvpTotalEl = $('#pvp-total');
  const pvpWinsEl = $('#pvp-wins');
  const pvpLossesEl = $('#pvp-losses');
  if (pvpTotalEl) pvpTotalEl.textContent = pvp.total || 0;
  if (pvpWinsEl) pvpWinsEl.textContent = pvp.wins || 0;
  if (pvpLossesEl) pvpLossesEl.textContent = pvp.losses || 0;
}

// ===== 更多面板 =====
function openMorePanel() {
  showPanel('more-panel');
}

function handleMoreMenu(action) {
  hidePanel('more-panel');
  // 关闭可能覆盖在上层的子面板
  ['skill-tree-panel', 'evolve-panel'].forEach(p => hidePanel(p));
  switch(action) {
    case 'stats': openStatsPanel(); break;
    case 'shop': openShop(); break;
    case 'games': openGamesPanel(); break;
    case 'album': openAlbum(); break;
    case 'share': openShareModal(); break;
    case 'evolve': openEvolvePanel(); break;
    case 'showcase': openShowcasePanel(); break;
    case 'settings':
      $('#settings-modal').classList.remove('hidden');
      $('#input-rename').value = gameState.pet?.name || '';
      $('#toggle-sound').checked = gameState.settings.sound;
      populateTitleSelects();
      updateTitlePreview();
      updateSettingsAccountInfo();
      break;
    case 'update':
      checkGameUpdate();
      break;
  }
}

function checkGameUpdate() {
  showToast('正在检查更新...');
  // 尝试刷新Service Worker缓存
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(reg => {
      if (reg) {
        reg.update().then(() => {
          showToast('已检查更新，即将刷新页面...');
          setTimeout(() => window.location.reload(true), 1500);
        }).catch(() => {
          showToast('检查更新失败，将强制刷新...');
          setTimeout(() => window.location.reload(true), 1500);
        });
      } else {
        showToast('将强制刷新获取最新版本...');
        setTimeout(() => window.location.reload(true), 1500);
      }
    }).catch(() => {
      showToast('将强制刷新获取最新版本...');
      setTimeout(() => window.location.reload(true), 1500);
    });
  } else {
    showToast('将强制刷新获取最新版本...');
    setTimeout(() => window.location.reload(true), 1500);
  }
}

// ===== 成就面板 =====
function openAchievementsPanel() {
  renderAchievements();
  renderDailyTasks();
  showPanel('achievements-panel');
}

// ===== 底部导航扩展 =====
function handleNavTab(tab) {
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.nav-btn[data-tab="${tab}"]`);
  if (btn) btn.classList.add('active');
  currentTab = tab;

  // 关闭所有面板
  ['stats-panel', 'shop-panel', 'games-panel', 'album-panel', 'battle-panel', 'breed-panel', 'achievements-panel', 'more-panel', 'showcase-panel', 'skill-tree-panel', 'evolve-panel'].forEach(p => hidePanel(p));

  switch(tab) {
    case 'home': break;
    case 'battle': openBattlePanel(); break;
    case 'breed': openBreedPanel(); break;
    case 'achievements': openAchievementsPanel(); break;
    case 'more': openMorePanel(); break;
  }
}

// ===== 展示墙 =====
function openShowcasePanel() {
  renderShowcaseStats();
  renderShowcaseAchievements();
  renderShowcaseRarePets();
  renderShowcaseLeaderboard();
  showPanel('showcase-panel');
}

// 渲染炫耀统计数据
function renderShowcaseStats() {
  const container = $('#showcase-stats');
  if (!container) return;

  const totalDays = gameState.records?.hatchTime
    ? Math.max(1, Math.floor((Date.now() - gameState.records.hatchTime) / 86400000))
    : 1;
  const bs = gameState.battleStats || {};
  const totalBattles = bs.total || 0;
  const winRate = totalBattles > 0 ? Math.floor((bs.wins || 0) / totalBattles * 100) : 0;
  const albumPct = SPECIES_LIST.length > 0 ? Math.floor(gameState.album.length / SPECIES_LIST.length * 100) : 0;
  // 找到最高等级宠物
  let maxLevelPet = gameState.pet;
  (gameState.petCollection || []).forEach(p => {
    if (p.level > (maxLevelPet?.level || 0)) maxLevelPet = p;
  });
  const maxLevel = maxLevelPet?.level || 0;
  const totalCoins = gameState.records?.totalCoinsEarned || 0;
  // 稀有成就（史诗/传说级别、隐藏成就）
  const rareAchs = (ACHIEVEMENTS || []).filter(a => {
    const isRare = (a.id.includes('master') && a.reward >= 300) || a.reward >= 400;
    return isRare;
  });
  const unlockedRare = rareAchs.filter(a => gameState.achievements?.unlocked?.includes(a.id)).length;

  container.innerHTML = `
    <div class="showcase-stat-card">
      <div class="stat-value">${totalDays}</div>
      <div class="stat-label">总游戏天数</div>
    </div>
    <div class="showcase-stat-card">
      <div class="stat-value">${totalBattles}/${winRate}%</div>
      <div class="stat-label">对战/胜率</div>
    </div>
    <div class="showcase-stat-card">
      <div class="stat-value">${albumPct}%</div>
      <div class="stat-label">图鉴完成度</div>
    </div>
    <div class="showcase-stat-card">
      <div class="stat-value">Lv.${maxLevel}</div>
      <div class="stat-label">最高等级</div>
    </div>
    <div class="showcase-stat-card">
      <div class="stat-value">${totalCoins}</div>
      <div class="stat-label">总金币获取</div>
    </div>
    <div class="showcase-stat-card">
      <div class="stat-value">${unlockedRare}</div>
      <div class="stat-label">稀有成就</div>
    </div>
  `;
}

// 渲染成就展柜
function renderShowcaseAchievements() {
  const container = $('#showcase-achievements');
  if (!container) return;
  container.innerHTML = '';

  const unlocked = gameState.achievements?.unlocked || [];

  // 高价值成就（史诗级/传说级）
  const showcaseAchs = ACHIEVEMENTS.filter(a => a.reward >= 300).map(a => ({
    id: a.id, name: a.name, desc: a.desc, icon: a.icon,
    isUnlocked: unlocked.includes(a.id)
  }));

  // 已解锁的隐藏头衔（从头衔定义中提取）
  const hiddenUnlocked = unlocked.filter(id => id.startsWith('hidden_'));
  hiddenUnlocked.forEach(hid => {
    const prefix = Object.values(TITLE_PREFIXES).find(p => p.source === hid);
    const suffix = Object.values(TITLE_SUFFIXES).find(s => s.source === hid);
    let name = '';
    if (prefix) name += prefix.text;
    if (prefix && suffix) name += ' ';
    if (suffix) name += suffix.text;
    if (name) {
      showcaseAchs.push({
        id: hid, name: name, desc: '隐藏头衔', icon: '🎭', isUnlocked: true
      });
    }
  });

  showcaseAchs.forEach(ach => {
    const div = document.createElement('div');
    div.className = `showcase-achievement ${ach.isUnlocked ? '' : 'locked'}`;
    div.innerHTML = `
      <div class="ach-icon">${ach.isUnlocked ? ach.icon : '🔒'}</div>
      <div class="ach-name">${ach.isUnlocked ? ach.name : '???'}</div>
      <div class="ach-desc">${ach.isUnlocked ? ach.desc : '隐藏成就'}</div>
    `;
    container.appendChild(div);
  });

  // 如果没有符合条件的成就
  if (showcaseAchs.length === 0) {
    container.innerHTML = '<p style="font-size:13px;color:#889;text-align:center;">暂无稀有成就</p>';
  }
}

// 渲染稀有宠物收藏
function renderShowcaseRarePets() {
  const container = $('#showcase-rare-pets');
  if (!container) return;
  container.innerHTML = '';

  const allPets = [...(gameState.petCollection || [])];
  // 按稀有度排序
  const rarityOrder = { legendary: 5, epic: 4, rare: 3, uncommon: 2, common: 1 };
  allPets.sort((a, b) => {
    const ra = rarityOrder[a.rarity?.id] || 0;
    const rb = rarityOrder[b.rarity?.id] || 0;
    if (rb !== ra) return rb - ra;
    return (b.level || 0) - (a.level || 0);
  });

  if (allPets.length === 0) {
    container.innerHTML = '<p style="font-size:13px;color:#889;text-align:center;">暂无收藏宠物</p>';
    return;
  }

  // 最多展示12只
  const display = allPets.slice(0, 12);
  display.forEach(pet => {
    const rarityObj = RARITIES.find(r => r.id === pet.rarity?.id) || RARITIES[0];
    const div = document.createElement('div');
    div.className = `showcase-pet-card ${pet.shiny ? 'shiny' : ''}`;
    div.innerHTML = `
      <div class="pet-emoji" style="white-space:pre;">${pet.species?.emoji || '❓'}${pet.shiny ? '✨' : ''}</div>
      <div class="pet-name">${pet.name || '未命名'}</div>
      <div class="pet-info" style="color:${rarityObj.color}">${rarityObj.name} Lv.${pet.level || 1}</div>
    `;
    container.appendChild(div);
  });
}

// 渲染对战排行榜
function renderShowcaseLeaderboard() {
  const container = $('#showcase-leaderboard');
  if (!container) return;
  container.innerHTML = '';

  const gameNames = {
    catch: '🎯 接接乐',
    memory: '🧠 记忆翻牌',
    quiz: '❓ 宠物问答',
    gomoku: '⚫⚪ 五子棋'
  };

  const boards = gameState.leaderboards || {};
  Object.keys(gameNames).forEach(game => {
    const board = boards[game] || [];
    if (board.length === 0) return;
    const topScore = board[0].score;
    const row = document.createElement('div');
    row.className = 'leaderboard-row';
    row.innerHTML = `
      <span class="game-name">${gameNames[game] || game}</span>
      <span class="game-score">🏆 ${topScore} 分</span>
    `;
    container.appendChild(row);
  });

  // 如果没有任何排行记录
  if (container.children.length === 0) {
    container.innerHTML = '<p style="font-size:13px;color:#889;text-align:center;">暂无排行榜记录</p>';
  }
}

// ===== 事件绑定扩展 =====
function bindNewEvents() {
  // 底部导航新按钮
  $$('.nav-btn').forEach(btn => {
    btn.onclick = () => {
      const tab = btn.dataset.tab;
      if (tab === 'home' || tab === 'stats' || tab === 'shop' || tab === 'games' || tab === 'album') {
        // 旧的导航逻辑保持兼容
        $$('.nav-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTab = tab;
        ['battle-panel', 'breed-panel', 'achievements-panel', 'more-panel', 'showcase-panel', 'skill-tree-panel', 'evolve-panel'].forEach(p => hidePanel(p));
        ['stats-panel', 'shop-panel', 'games-panel', 'album-panel'].forEach(p => hidePanel(p));
        switch(tab) {
          case 'home': break;
          case 'stats': openStatsPanel(); break;
          case 'shop': openShop(); break;
          case 'games': openGamesPanel(); break;
          case 'album': openAlbum(); break;
        }
      } else {
        handleNavTab(tab);
      }
    };
  });

  // 更多菜单项
  $$('.more-item').forEach(item => {
    item.onclick = () => handleMoreMenu(item.dataset.more);
  });

  // 对战面板返回
  $('#btn-battle-back').onclick = () => {
    hidePanel('battle-panel');
    resetNavToHome();
  };

  // 繁殖面板返回
  $('#btn-breed-back').onclick = () => {
    hidePanel('breed-panel');
    resetNavToHome();
  };

  // 成就面板返回
  $('#btn-achievements-back').onclick = () => {
    hidePanel('achievements-panel');
    resetNavToHome();
  };

  // 更多面板返回
  $('#btn-more-back').onclick = () => {
    hidePanel('more-panel');
    resetNavToHome();
  };

  // 进化面板返回
  $('#btn-evolve-back').onclick = () => {
    hidePanel('evolve-panel');
  };

  // 战斗开始按钮
  $('#btn-battle-fight').onclick = () => {
    if (battleState && !battleState.isRunning) {
      $('#btn-battle-fight').classList.add('hidden');
      runBattleTurns();
    }
  };

  // 战斗退出按钮
  $('#btn-battle-quit').onclick = () => {
    quitBattle();
  };

  // 再来一局按钮
  $('#btn-battle-again').onclick = () => {
    const opponent = generateAIOpponent(selectedDifficulty);
    startBattle(opponent, selectedDifficulty);
  };

  // AI对战按钮
  $('#btn-battle-ai').onclick = () => {
    const opponent = generateAIOpponent(selectedDifficulty);
    startBattle(opponent, selectedDifficulty);
  };

  // 分享宠物对战按钮 - 展开内联输入区域（替代 prompt，避免浏览器拦截）
  $('#btn-battle-share').onclick = () => {
    const inputArea = $('#battle-share-input-area');
    if (inputArea) {
      inputArea.classList.toggle('hidden');
      if (!inputArea.classList.contains('hidden')) {
        $('#battle-share-code-input').value = '';
        $('#battle-share-code-input').focus();
      }
    }
  };

  // 导入对战 - 开始对战按钮
  $('#btn-battle-share-go').onclick = () => {
    const code = $('#battle-share-code-input').value.trim();
    if (!code) {
      showToast('请先粘贴对手的宠物代码');
      return;
    }
    const opponent = parseShareCode(code);
    if (opponent) {
      // 检查是否和自己的宠物相同（通过id或originalId匹配）
      const playerPet = gameState.pet;
      if (!playerPet) {
        showToast('没有宠物无法对战！');
        return;
      }
      if (opponent.id === playerPet.id ||
          (opponent.originalId && opponent.originalId === playerPet.id)) {
        showToast('不能和自己对战哦！');
        return;
      }
      // 检查是否已经导入过（对战临时使用，不加入importedPets）
      if (opponent.originalId && gameState.importedPetIds.includes(opponent.originalId)) {
        showToast('这只宠物已经导入过了，可以直接在繁殖面板中选择对战！');
        // 仍然允许对战，只是提示
      }
      opponent.isImported = true;
      opponent.imported = true;
      // 隐藏输入区域
      $('#battle-share-input-area').classList.add('hidden');
      startBattle(opponent, 'normal'); // PVP对战使用普通难度
    } else {
      showToast('无效的宠物代码，请检查是否完整粘贴');
    }
  };

  // 导入对战 - 取消按钮
  $('#btn-battle-share-cancel').onclick = () => {
    $('#battle-share-input-area').classList.add('hidden');
  };

  // 分享弹窗关闭
  $('#btn-share-close').onclick = () => {
    $('#share-modal').classList.add('hidden');
  };

  // 复制分享代码
  $('#btn-copy-share-code').onclick = copyShareCode;

  // 繁殖开始按钮
  $('#btn-breed-start').onclick = startBreeding;

  // 繁殖导入按钮
  $('#btn-breed-import').onclick = importPetForBreeding;

  // 繁殖结果确认
  $('#btn-breed-result-ok').onclick = () => {
    $('#breed-result-modal').classList.add('hidden');
    renderBreedCollection();
    updateBreedSlots();
  };

  // 进化结果确认
  $('#btn-evolve-result-ok').onclick = () => {
    $('#evolve-result-modal').classList.add('hidden');
    renderEvolutionTree();
  };

  // ===== 登录/注册按钮事件 =====
  $('#btn-login').onclick = handleLogin;
  $('#btn-register').onclick = handleRegister;
  $('#btn-guest').onclick = enterGuestMode;
  $('#link-to-register').onclick = showRegisterForm;
  $('#link-to-login').onclick = showLoginForm;

  // 登录密码回车提交
  $('#login-password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleLogin();
  });
  // 注册密码回车提交
  $('#register-password').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleRegister();
  });

  // 技能树相关事件
  $('#btn-open-skill-tree').onclick = () => {
    renderSkillTree();
    showPanel('skill-tree-panel');
  };
  
  // AI难度选择
  let selectedDifficulty = 'easy';
  $$('.diff-btn').forEach(btn => {
    btn.onclick = () => {
      $$('.diff-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedDifficulty = btn.dataset.diff;
    };
  });

  $('#btn-skill-tree-back').onclick = () => {
    hidePanel('skill-tree-panel');
    showPanel('stats-panel');
  };
  
  // 展示墙返回按钮
  $('#btn-showcase-back').onclick = () => {
    hidePanel('showcase-panel');
    resetNavToHome();
  };
}

function resetNavToHome() {
  $$('.nav-btn').forEach(b => b.classList.remove('active'));
  const homeBtn = document.querySelector('.nav-btn[data-tab="home"]');
  if (homeBtn) homeBtn.classList.add('active');
  currentTab = 'home';
}

// ===== 初始化 =====
function init() {
  // 注册 Service Worker (PWA 离线支持)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => {
          console.log('PWA Service Worker 注册成功');
        })
        .catch((err) => {
          console.log('Service Worker 注册失败:', err);
        });
    });
  }

  // 初始化 Supabase（如果配置了）
  initSupabase();

  bindEvents();
  bindNewEvents();
  // 注意：initDailyTasks 在加载存档后再调用，避免被旧存档覆盖

  // ===== 存档保存（多事件保障） =====
  function doSave() {
    if (gameState.pet) {
      gameState.lastCloseTime = Date.now();
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(gameState));
      } catch(e) { /* ignore */ }
      // 如果已登录用户，也保存到用户数据
      if (currentUser) {
        saveUserData();
      }
    }
  }

  // 1. beforeunload: 页面关闭前（桌面端可靠）
  window.addEventListener('beforeunload', doSave);

  // 2. pagehide: iOS Safari 更可靠的关闭事件
  window.addEventListener('pagehide', doSave);

  // 3. visibilitychange: 页面切换到后台时保存（iOS PWA 最可靠）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      doSave();
    }
  });

  // ===== 用户系统：检查上次会话 =====
  const hasSession = restoreSession();

  if (hasSession && currentUser) {
    // 有保存的登录会话，自动登录
    autoLoginWithSession();
  } else {
    // 没有会话，显示登录画面
    showScreen('login-screen');
    showLoginForm();
  }
}

// 使用保存的会话自动登录
async function autoLoginWithSession() {
  if (!currentUser) return;

  showToast('自动登录中...');

  try {
    // 加载用户数据
    const userData = await loadUserData();

    if (userData && userData.pet) {
      // 有存档
      gameState = { ...createInitialState(), ...userData };
      ensureGameStateDefaults();

      // 初始化每日任务（必须在加载存档后调用，避免被旧存档覆盖）
      initDailyTasks();

      // 连续登录天数检查
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      if (gameState.hiddenCounters) {
        if (gameState.hiddenCounters.lastLoginDate) {
          const lastDate = new Date(gameState.hiddenCounters.lastLoginDate);
          const todayDate = new Date(today);
          const diffDays = Math.floor((todayDate - lastDate) / 86400000);
          if (diffDays === 1) {
            // 连续登录
            gameState.hiddenCounters.consecutiveLoginDays++;
          } else if (diffDays > 1) {
            // 中断，重新计数
            gameState.hiddenCounters.consecutiveLoginDays = 1;
          }
          // diffDays === 0 表示同一天，不增加
        } else {
          gameState.hiddenCounters.consecutiveLoginDays = 1;
        }
        gameState.hiddenCounters.lastLoginDate = today;

        // 连续7天解锁隐藏头衔
        if (gameState.hiddenCounters.consecutiveLoginDays >= 7 && !gameState.achievements.unlocked.includes('hidden_dedicated')) {
          gameState.achievements.unlocked.push('hidden_dedicated');
          setTimeout(() => showToast('🎁 发现隐藏头衔：坚持的！'), 2000);
        }
      }

      const { minsAway, msg } = applyOfflineDecay();
      gameState.records.lastLogin = Date.now();

      saveGame();
      enterGame();
      setTimeout(() => checkAchievements(), 1000);

      // 检查是否离线模式
      const isOffline = currentUser.offline || (currentUser.type === 'cloud' && !cloudSaveEnabled);

      if (msg) {
        setTimeout(() => {
          showToast(`${msg}${isOffline ? '（离线模式）' : ''}`);
        }, 800);
      } else {
        setTimeout(() => {
          showToast(`欢迎回来，${currentUser.username}！${isOffline ? '（离线模式）' : ''}`);
        }, 500);
      }
    } else {
      // 没存档，去孵化画面
      gameState = createInitialState();
      showScreen('hatch-screen');
      const isOffline = currentUser.offline || (currentUser.type === 'cloud' && !cloudSaveEnabled);
      if (isOffline) {
        showToast(`${currentUser.username}，离线模式，开始新游戏吧！`);
      } else if (currentUser.type === 'local') {
        showToast(`${currentUser.username}，开始新游戏吧！`);
      } else {
        showToast(`欢迎，${currentUser.username}！`);
      }
    }
  } catch(e) {
    console.warn('自动登录失败:', e);
    // 失败了也不回登录页，尝试直接从 localStorage 读档
    try {
      const data = localStorage.getItem(SAVE_KEY);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed && parsed.pet) {
          gameState = { ...createInitialState(), ...parsed };
          ensureGameStateDefaults();
          const { msg } = applyOfflineDecay();
          enterGame();
          showToast(msg || '本地存档已恢复');
          return;
        }
      }
    } catch(e2) {}

    // 再尝试从 IndexedDB 全局备份恢复
    try {
      const idbBackup = await loadFromIDB('global_backup');
      if (idbBackup && idbBackup.pet) {
        gameState = { ...createInitialState(), ...idbBackup };
        ensureGameStateDefaults();
        const { msg: msg2 } = applyOfflineDecay();
        enterGame();
        showToast(msg2 || '已从备份恢复存档');
        return;
      }
    } catch(e3) {}

    // 实在不行就新游戏
    gameState = createInitialState();
    showScreen('hatch-screen');
    showToast('加载存档失败，开始新游戏');
  }
}

// DOM Ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();
