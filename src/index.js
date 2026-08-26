export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return new Response("bot is alive");
    }

    const raw = await request.text();

    // --- check the message really came from LINE ---
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

    // Tell LINE "ok" now; do the slow work after.
    ctx.waitUntil(handleEvents(body.events ?? [], env));

    return new Response("ok");
  },
};

// Cheap model first. Second one is only a rescue.
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.5-flash"];

async function handleEvents(events, env) {
  const jobs = events
    .filter((ev) => ev.type === "message" && ev.message?.type === "text")
    .map((ev) => handleOne(ev, env));

  // all at once, not one after another
  await Promise.all(jobs);
}

async function handleOne(ev, env) {
  let out = "ขอโทษนะ ตอนนี้แปลไม่ได้ ลองใหม่อีกที";

  for (const model of MODELS) {
    let r;
    try {
      r = await translate(ev.message.text, env, model);
    } catch (err) {
      console.log(`${model} threw:`, err);
      continue;
    }

    if (r.ok) {
      out = r.text;
      break;
    }

    console.log(`${model} failed: ${r.status} ${r.detail}`);
    if (r.status === 503 || r.status === 429) {
      await new Promise((res) => setTimeout(res, 300));
    }
  }

  await reply(ev.replyToken, out, env);
}

async function translate(text, env, model) {
  const prompt = `You are the invisible interpreter between two friends texting in Chiang Mai. One writes Thai. The other writes Burmese or English.

Detect the language of the MESSAGE:
- Thai in → Burmese out.
- Burmese or English in → Thai out.
- Anything else in → Thai out.

The input is real chat, so expect it to be messy: typos, missing words, no punctuation, wrong grammar, English words mixed in, romanised Thai or Burmese typed in Latin letters. Never comment on any of that. Work out what the person MEANT and translate the meaning. If a word is misspelled, translate the word they intended. If a sentence is broken, translate the complete thought behind it. If it is genuinely unclear, pick the most likely reading and go.

Write the output the way a local person would actually text a friend:
- Real spoken language, not textbook language.
- Thai: use the particles people really type — นะ ค่ะ ครับ เหรอ อ่ะ ป่ะ มั้ย. Not stiff written Thai.
- Burmese: everyday colloquial forms, not formal written Burmese.
- Match their tone exactly. Never make it more polite or more formal than the original.
- Slang gets the closest slang, never a literal explanation.

The test: a native speaker reading the output should believe a real person wrote it, not a machine.

Output ONLY the translated sentence. No labels, no notes, no corrections, no romanisation.

REMEMBER: if the MESSAGE is Thai, your output MUST be in Burmese script. If the MESSAGE is Burmese or English, your output MUST be in Thai script. Never reply in the same language as the input.

MESSAGE:
${text}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.5 },
      }),
      signal: AbortSignal.timeout(8000),
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