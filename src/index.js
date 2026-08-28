const MY_GENDER = "male";
const FRIEND_GENDER = "female";

const MENTIONS = ["@leon", "@harn", "@leon harn", "ลีออน", "လီယွန်"];

const GROUPS = {
  Ce540ec9ff202d5ad182d7614345ddc8d: { name: "Friend 1", mode: "translate" },
  Ca7a3b1006ab5302107fb6998032820a3: { name: "Friend 2", mode: "translate" },
  C07c69b8cbdb79abb044810a5f8604b99: { name: "Crush", mode: "translate" },
  Ceacc44a74c00d696414e16fddc5e5763: { name: "Silent test", mode: "log" },
};

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("bot is alive");
    }

    const raw = await request.text();

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.CHANNEL_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sigBuf = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(raw)
    );
    const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));

    if (expected !== request.headers.get("x-line-signature")) {
      console.log("rejected: bad signature");
      return new Response("bad signature", { status: 401 });
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch (err) {
      console.log("bad json from LINE:", err);
      return new Response("bad json", { status: 400 });
    }

    ctx.waitUntil(handleEvents(body.events ?? [], env));

    return new Response("ok");
  },
};

const MODELS = ["gemini-3.5-flash", "gemini-3.5-flash-lite"];

const DEADLINE_MS = 18000;
const PER_CALL_MS = 9000;

const THAI = /[\u0E00-\u0E7F]/;
const MYANMAR = /[\u1000-\u109F\uAA60-\uAA7F\uA9E0-\uA9FF]/;
const LATIN = /[A-Za-z]/;
const STICKER_ALT = /^(\s*\([^)]*\)\s*)+$/;

function keyring(env) {
  return [env.GEMINI_KEY, env.GEMINI_KEY_2, env.GEMINI_KEY_3, env.GEMINI_KEY_4]
    .filter(Boolean);
}

function decideTarget(text) {
  const t = text.trim();

  if (!t) return null;
  if (STICKER_ALT.test(t)) return null;

  const thai = THAI.test(t);
  const mya = MYANMAR.test(t);

  if (thai && mya) return null;
  if (thai) return "Burmese";
  if (mya) return "Thai";
  if (LATIN.test(t)) return "Thai";

  return null;
}

function mentionsMe(ev, text) {
  const tagged = ev.message?.mention?.mentionees;
  if (Array.isArray(tagged) && tagged.length > 0) return true;

  const lower = text.toLowerCase();
  return MENTIONS.some((m) => lower.includes(m));
}

function routeFor(ev) {
  const src = ev.source ?? {};

  if (src.type === "user") {
    return { name: "direct", mode: "translate", log: false };
  }

  const conf = GROUPS[src.groupId];
  if (!conf) return null;

  return { name: conf.name, mode: conf.mode, log: conf.mode === "log" };
}

async function handleEvents(events, env) {
  const jobs = events
    .filter((ev) => ev.type === "message" && ev.message?.type === "text")
    .map((ev) => handleOne(ev, env));

  await Promise.all(jobs);
}

async function handleOne(ev, env) {
  const text = ev.message.text.trim();

  if (text === "/id") {
    const src = ev.source ?? {};
    await reply(
      ev.replyToken,
      `type: ${src.type}\ngroup: ${src.groupId ?? "-"}\nroom: ${src.roomId ?? "-"}\nuser: ${src.userId ?? "-"}`,
      env
    );
    return;
  }

  const route = routeFor(ev);
  if (!route) {
    console.log("ignored: unknown room");
    return;
  }

  const target = decideTarget(text);
  if (!target) {
    console.log("skipped:", text.slice(0, 40));
    return;
  }

  const translation = await translateWithFallback(text, target, env);

  const tasks = [];

  if (route.mode === "translate") {
    tasks.push(reply(ev.replyToken, translation, env));
  }

  if (route.log) {
    tasks.push(
      logToSheet(ev, route.name, text, translation, mentionsMe(ev, text), env)
    );
  }

  await Promise.all(tasks);
}

async function logToSheet(ev, groupName, original, translation, mention, env) {
  if (!env.SHEET_URL) return;

  const sender = await senderName(ev, env);

  try {
    const res = await fetch(env.SHEET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.SHEET_SECRET,
        group: groupName,
        sender,
        original,
        translation,
        mention,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.log("sheet write failed:", res.status);
    }
  } catch (err) {
    console.log("sheet write threw:", err);
  }
}

async function senderName(ev, env) {
  const src = ev.source ?? {};
  if (!src.userId) return "unknown";

  const url = src.groupId
    ? `https://api.line.me/v2/bot/group/${src.groupId}/member/${src.userId}`
    : `https://api.line.me/v2/bot/profile/${src.userId}`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) return src.userId.slice(0, 8);

    const data = await res.json();
    return data.displayName || src.userId.slice(0, 8);
  } catch {
    return src.userId.slice(0, 8);
  }
}

async function translateWithFallback(text, target, env) {
  const keys = keyring(env);
  const started = Date.now();

  for (const model of MODELS) {
    const offset = Math.floor(Math.random() * keys.length);

    for (let n = 0; n < keys.length; n++) {
      const i = (offset + n) % keys.length;

      if (Date.now() - started > DEADLINE_MS) {
        console.log("deadline hit, giving up");
        return failMessage(target);
      }

      let r;
      try {
        r = await translate(text, target, keys[i], model);
      } catch (err) {
        console.log(`${model} key${i + 1} threw:`, err);
        break;
      }

      if (r.ok) {
        if (n > 0) console.log(`${model} succeeded on key${i + 1}`);
        return r.text;
      }

      console.log(`${model} key${i + 1} failed: ${r.status} ${r.detail}`);

      if (r.status !== 429) break;
    }
  }

  return failMessage(target);
}

function failMessage(target) {
  return target === "Thai"
    ? "ขอโทษครับ ตอนนี้แปลไม่ได้ ลองใหม่อีกครั้งครับ"
    : "တောင်းပန်ပါတယ်။ အခုဘာသာပြန်လို့မရသေးပါ။ ခဏနေမှ ထပ်ကြိုးစားကြည့်ပါ။";
}

function voiceRules(target) {
  if (target === "Thai") {
    return MY_GENDER === "male"
      ? `The speaker is MALE. Use male Thai forms only: ครับ as the polite particle, ผม for "I". NEVER use ค่ะ, คะ, ดิฉัน, or any other female form — that would misgender the speaker.`
      : `The speaker is FEMALE. Use female Thai forms only: ค่ะ / คะ as the polite particle, ดิฉัน or ฉัน for "I". Never use ครับ or ผม.`;
  }
  return FRIEND_GENDER === "female"
    ? `The speaker is FEMALE. Use female Burmese forms: ရှင့် / ရှင် for polite address, ကျွန်မ for "I". Never use ခင်ဗျာ or ကျွန်တော်.`
    : `The speaker is MALE. Use male Burmese forms: ခင်ဗျာ for polite address, ကျွန်တော် for "I". Never use ရှင့် or ကျွန်မ.`;
}

async function translate(text, target, apiKey, model) {
  const prompt = `Translate the MESSAGE below into ${target}. The output must be written in ${target} and nothing else.

${voiceRules(target)}

This is a real chat between two friends in Chiang Mai, so the input may be messy: typos, missing words, no punctuation, mixed-in English, or romanised script. Never comment on any of that. Work out what the sender meant and translate that meaning.

Accuracy comes first. The reader must receive exactly what the sender meant — no additions, no omissions, no invented detail. If two readings are possible, choose the plainer one. Never translate a word by its surface form when the context makes another sense obviously correct.

Register: read the sender's formality from the original and match it.
- Formal signals — Burmese ပါ / ပါတယ် / ခင်ဗျာ / ရှင့်, complete careful sentences, no slang. Translate into properly polite Thai with ครับ and full sentences.
- Casual signals — slang, jokes, shortened words, no politeness particles, playful spelling. Translate into relaxed everyday Thai. Keep the humour: slang gets the closest natural slang, a joke stays a joke.
- Neutral stays neutral.
- Never make the message warmer, ruder, more familiar or more distant than it was.
- No emoji unless the original had them.

Keep names, numbers, times, places and prices exactly as written.

Clarity: complete sentences, natural word order, readable at a glance. A native ${target} speaker should believe a real person wrote it.

Output ONLY the ${target} translation. No labels, no notes, no romanisation.

MESSAGE:
${text}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(PER_CALL_MS),
    }
  );

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      detail: JSON.stringify(data).slice(0, 200),
    };
  }

  const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!result) {
    return {
      ok: false,
      status: res.status,
      detail: "empty: " + JSON.stringify(data).slice(0, 200),
    };
  }

  return { ok: true, text: result.trim() };
}

async function reply(replyToken, text, env) {
  const res = await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    console.log("LINE reply failed:", res.status, await res.text());
  }
}