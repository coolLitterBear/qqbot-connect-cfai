import nacl from 'tweetnacl' 

// 日志：fire-and-forget，不阻塞主流程
function log(db, msg) {
  if (!db) return;
  db.prepare('INSERT INTO logs (content) VALUES (?)').bind(String(msg)).run().catch(() => {});
}

export default {
  async fetch(request, env, ctx) {
    const db = env.qqbotdb;
    const appSecret = env.appSecret;

    // 建表（只执行一次，失败也无所谓）
    db?.prepare('CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT DEFAULT CURRENT_TIMESTAMP, content TEXT)').run().catch(() => {});

    const body = await request.text();
    log(db, '=== 收到请求 ===');
    log(db, 'Body: ' + body.substring(0, 500));

    let data;
    try {
      data = JSON.parse(body);
    } catch (e) {
      log(db, 'JSON 解析失败');
      return new Response(JSON.stringify({code: 0}), {
        status: 200,
        headers: {'Content-Type': 'application/json'}
      });
    }

    const op = data.op ?? 0;
    log(db, 'Op: ' + op);

    // ========== 回调验证 (op=13) ==========
    if (op === 13) {
      const plainToken = data.d?.plain_token ?? '';
      const eventTs = data.d?.event_ts ?? '';

      // 生成 seed：重复自身直到 32 字节
      let seed = new TextEncoder().encode(appSecret);
      while (seed.length < 32) {
        const newSeed = new Uint8Array(seed.length * 2);
        newSeed.set(seed);
        newSeed.set(seed, seed.length);
        seed = newSeed;
      }
      seed = seed.slice(0, 32);

      // Ed25519 签名
      const keyPair = nacl.sign.keyPair.fromSeed(seed);
      const msg = new TextEncoder().encode(eventTs + plainToken);
      const sig = nacl.sign.detached(msg, keyPair.secretKey);

      const signature = Array.from(sig)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      return new Response(JSON.stringify({
        plain_token: plainToken,
        signature: signature
      }), {
        headers: {'Content-Type': 'application/json'}
      });
    }

    // ========== 收到消息 (op=0) ==========
    if (op === 0) {
      const eventType = data.t ?? '';
      const eventData = data.d ?? {};
      log(db, '事件类型: ' + eventType);

      if (eventType === 'C2C_MESSAGE_CREATE') {
        const userMsg = eventData.content ?? '';
        const userId = eventData.author?.id ?? '';
        const msgId = eventData.id ?? '';
        log(db, '用户消息: ' + userMsg);

        // 后台处理：读取 KV → 调用 AI → 获取 Token → 发送消息
        // 立即返回 200，QQ 不会重试
        ctx.waitUntil(handleMessage(userMsg, userId, msgId, env, db));
      }
    }

    // 立即返回 200，不等待后台处理
    return new Response(JSON.stringify({code: 0}), {
      status: 200,
      headers: {'Content-Type': 'application/json'}
    });
  },

  // ===== 新增：Cron 触发器 =====
  async scheduled(controller, env, ctx) {
    const db = env.qqbotdb;
    db?.prepare('CREATE TABLE IF NOT EXISTS logs (...)').run().catch(() => {});
    
    log(db, '=== Cron 执行：重置神经元 ===');
    try {
      const maxNeuron = await env.qqbot.get('maxNeuron');
      if (maxNeuron) {
        await env.qqbot.put('remainingNeuron', maxNeuron);
        log(db, '神经元已重置: ' + maxNeuron);
      } else {
        log(db, 'maxNeuron 未设置，跳过');
      }
    } catch (e) {
      log(db, 'Cron 重置失败: ' + e.message);
    }
  }
};

// ===== 后台处理消息 =====
async function handleMessage(userMsg, userId, msgId, env, db) {
  try {
    log(db, '【后台】开始处理消息...');

    // 读取 KV 配置
    log(db, '【后台】读取 KV...');
    const model = await env.qqbot.get('model');
    const systemMessage = await env.qqbot.get('systemMessage');
    const contentPath = await env.qqbot.get('content');
    const reasoningPath = await env.qqbot.get('reasoningContent');
    const showThinkingStr = await env.qqbot.get('showThinking');

    log(db, '【后台】model: ' + model);
    log(db, '【后台】systemMessage长度: ' + (systemMessage ? systemMessage.length : 0));

    if (!model || !systemMessage) {
      log(db, '【后台】KV 配置缺失，放弃');
      return;
    }

    const contentKeys = contentPath ? JSON.parse(contentPath) : ['result', 'response'];
    const reasoningKeys = reasoningPath ? JSON.parse(reasoningPath) : null;
    const showThinking = showThinkingStr === 'true' || showThinkingStr === '1';

    // 调用 AI
    log(db, '【后台】调用 AI...');
    const neuronUsagePath = await env.qqbot.get('neuronUsage')
    const aiResult = await callAI(model, systemMessage, userMsg, contentKeys, reasoningKeys, showThinking, env, db, neuronUsagePath);
    log(db, '【后台】AI 回复: ' + aiResult.substring(0, 100));

    // 扣除神经元
  if (usage !== null && usage !== undefined) {
    try {
      const remaining = await env.qqbot.get('remainingNeuron');
      const current = parseFloat(remaining) || 0;
      const newRemaining = current - parseFloat(usage);
      await env.qqbot.put('remainingNeuron', String(newRemaining));
      log(db, '【后台】神经元扣除: ' + usage + ', 剩余: ' + newRemaining);
    } catch (e) {
      log(db, '【后台】神经元记录失败: ' + e.message);
    }
  }


    // 获取 QQ Token
    log(db, '【后台】获取 Token...');
    const token = await getQQToken(env, db);
    log(db, '【后台】Token 获取成功');

    // 发送回复
    log(db, '【后台】发送 QQ 消息...');
    await sendQQMessage(userId, aiResult, msgId, token, env.appId, db);
    log(db, '【后台】QQ 消息发送完成');

  } catch (err) {
    log(db, '【后台】出错: ' + err.message);
    log(db, '【后台】堆栈: ' + (err.stack || '').substring(0, 200));
  }
}

// ===== 调用 Cloudflare Workers AI =====
async function callAI(model, systemMessage, userMessage, contentKeys, reasoningKeys, showThinking, env, db, neuronUsagePath) {
  const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${env.accountId}/ai/run/${model}`;
  log(db, '【后台】AI URL: ' + apiUrl);

  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.authToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messages: [
        {role: 'system', content: systemMessage},
        {role: 'user', content: userMessage}
      ]
    })
  });

  const data = await res.json();
  log(db, '【后台】AI 状态: ' + res.status);

  if (!res.ok) {
    throw new Error(`AI API 错误: ${res.status} ${JSON.stringify(data).substring(0, 200)}`);
  }

  // 提取回复文本
  let result = data;
  for (const key of contentKeys) {
    if (result === undefined || result === null) {
      throw new Error(`路径中断: ${key}`);
    }
    result = result[key];
  }

  let reply = (result ?? '（AI 无返回）').trim();

  // 提取 reasoning
  if (showThinking && reasoningKeys) {
    let reasoning = data;
    for (const key of reasoningKeys) {
      if (reasoning === undefined || reasoning === null) break;
      reasoning = reasoning[key];
    }
    if (reasoning) {
      reply = reasoning + reply;
    }
  }

  // 提取神经元用量（新增）
  let usage = null;
  if (neuronUsagePath) {
    try {
      const usageKeys = JSON.parse(neuronUsagePath);
      let u = data;
      for (const key of usageKeys) {
        if (u === undefined || u === null) break;
        u = u[key];
      }
      if (typeof u === 'number') {
        usage = u;
        log(db, '【后台】神经元用量: ' + usage);
      }
    } catch (e) {
      log(db, '【后台】提取神经元用量失败: ' + e.message);
   }
  }

  return {reply, usage};

}

// ===== 获取 QQ Access Token =====
async function getQQToken(env, db) {
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      appId: env.appId,
      clientSecret: env.appSecret
    })
  });

  const data = await res.json();
  log(db, '【后台】Token 响应: ' + JSON.stringify(data).substring(0, 200));

  if (!res.ok || !data.access_token) {
    throw new Error(`获取 Token 失败: ${res.status}`);
  }

  return data.access_token;
}

// ===== 发送 QQ 单聊消息 =====
async function sendQQMessage(openid, content, msgId, token, appId, db) {
  const url = `https://api.bot.qq.com/v2/users/${openid}/messages`;
  log(db, '【后台】发送 URL: ' + url);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `QQBot ${token}`,
      'X-Union-Appid': appId,
      'Content-Type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify({
      content: content,
      msg_type: 0,
      msg_id: msgId
    })
  });

  const responseData = await res.json().catch(() => ({}));
  log(db, '【后台】发送响应: ' + res.status + ' ' + JSON.stringify(responseData).substring(0, 200));

  if (responseData.err_code !== undefined && responseData.err_code !== 0) {
    throw new Error(`发送业务错误: ${responseData.err_code} ${responseData.message}`);
  }

  if (!res.ok) {
    throw new Error(`发送 HTTP 错误: ${res.status}`);
  }
}
