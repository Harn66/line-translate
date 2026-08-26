# LINE Translation Bot

A LINE bot that translates messages between Thai, Burmese, English and Vietnamese.

Built for a hotel front desk in Chiang Mai, where the staff don't all share a language.

## How it works

LINE webhook → Cloudflare Worker → Gemini API → reply back to LINE.

The Worker verifies the LINE request signature with HMAC-SHA256, then sends the
reply in the background using `ctx.waitUntil`, so LINE gets its 200 response
immediately and the reply token doesn't expire while waiting for the translation.

It only uses LINE *reply* messages, which don't count against the Official
Account message quota. With the Cloudflare and Gemini free tiers, it runs at
zero cost.

## Stack

- Cloudflare Workers
- Google Gemini API
- LINE Messaging API

## Setup

    npm install
    npx wrangler secret put CHANNEL_SECRET
    npx wrangler secret put CHANNEL_ACCESS_TOKEN
    npx wrangler secret put GEMINI_KEY
    npx wrangler deploy

Then set the Worker URL as the webhook URL in the LINE Developers Console.