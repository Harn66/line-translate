export default {
  async fetch(request, env, ctx) {
    // LINE only ever sends POST
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
      return new Response("bad signature", { status: 401 });
    }

    const body = JSON.parse(raw);

    // Reply in the background. Tell LINE "ok" immediately,
    // otherwise the reply token expires while we wait for Gemini.
    ctx.waitUntil(handleEvents(body.events, env));

    return new Response("ok");
  },
};

async function handleEvents(events, env) {
  for (const ev of events) {
    if (ev.type !== "message") continue;
    if (ev.message.type !== "text") continue;

    let out;
    try {
      out = await translate(ev.message.text, env);
    } catch (err) {
      out = "Translation failed. Try again.";
    }

    await reply(ev.replyToken, out, env);
  }
}

async function translate(text, env) {
  const prompt = `You are translating messages in a LINE chat between hotel staff in Chiang Mai. They speak Thai, Burmese, English and Vietnamese.

Detect the language of the MESSAGE below, then give it in the other three languages.

How to translate:
- Translate the MEANING, not the words. Never translate word by word.
- Write it the way a real person would actually text it in that language. Chat, not documents.
- Match the speaker's tone. If they are casual, be casual. If they are formal, be formal. Do not add politeness that is not there, and do not remove politeness that is.
- Keep it the same length and energy as the original. Short message in, short message out.
- Use the normal words people say, not the correct-but-stiff words. In Burmese use everyday spoken forms. In Thai use the particles people really use. In Vietnamese use the right pronoun for a workplace peer.
- Keep names, room numbers, times and numbers exactly as they are.
- If something is slang, give the closest natural equivalent, not a literal version.

Output format — exactly this, nothing else:
Thai: ...
Burmese: ...
English: ...
Vietnamese: ...

(Skip the line for whichever language the message was already in.)

MESSAGE:
${text}`;

  const res = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": env.GEMINI_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3 },
      }),
    }
  );

  const data = await res.json();
  const result = data?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!result) {
    // useful when something breaks — shows the real error in LINE
    return "Gemini error: " + JSON.stringify(data).slice(0, 300);
  }
  return result.trim();
}

async function reply(replyToken, text, env) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: text.slice(0, 4900) }],
    }),
  });
}