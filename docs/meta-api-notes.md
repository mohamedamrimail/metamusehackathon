# Meta Model API — what we've confirmed

Sources: Meta's official workshop repo [meta-models/legal-agent-workshop](https://github.com/meta-models/legal-agent-workshop)
(read Oct 29) and the team's Lahja project on this VM.

- Base URL `https://api.meta.ai/v1`, OpenAI-compatible; the official `openai` SDK works as-is.
- Both `responses.create` (workshop) and `chat.completions` (Lahja) work. We use chat completions
  with tools for now; `apps/server/src/meta/llm.ts` is the only file to change to switch.
- Chat model `muse-spark-1.3`. Muse Wonder is `muse-wonder-1.0` and is now on the API too.
- SAM model id is `sam-3.1`, called through `responses.create` with `input_text` (the prompt) and
  `input_image` (a data URL). Its `output_text` is special tokens:
  `0<|box;x1=..;y1=..;x2=..;y2=..;w=..;h=..|><|mask;...|>,1<|box;...|>`. An empty output means no match.
  The prompt is a noun phrase ("person", "face"); the workshop found literal names don't always match.
- `client.models.list()` lists the models a key can use: `pnpm --filter @ipersons/server preflight`.
- Retries: the SDK retries 429/503 itself; the workshop uses `max_retries=4`, timeout 180 s.
- No TTS in the Meta Model API. `muse-voice-transcribe-1.0` is speech-to-text only.
- Models on our key (Oct 29): muse-spark-1.1/1.2/1.3 (+ -contributor), muse-image-1.0, muse-wonder-1.0,
  muse-voice-transcribe-1.0, sam-3.1.

## Muse Spark (verified live Oct 29)
- Reasoning model: hidden reasoning counts against `max_completion_tokens`. At 600 it used 598 thinking and
  returned nothing (finish_reason=length). We use 4000.
- `reasoning_effort`: minimal | low | medium | high | xhigh | max ('none' is rejected). With our prompt + 11 tools:
  default ≈3.3 s, low ≈1.2 s, minimal ≈1.1 s per call; low still picks the right tool. We use low.
- Without an explicit rule it asks "shall I?" in text instead of calling a write tool; the prompt now says
  calling the tool IS asking.

- Prompt caching is automatic and prefix-based (docs/prompt-caching); `usage.prompt_tokens_details.cached_tokens`
  bills at $0.15/M instead of $1.25/M. A timestamp near the top of the system prompt gave 0% hits. Now the system prompt
  is stable per user and the per-turn context (time, facts, pending, wallet) is a system message AFTER the history,
  plus `prompt_cache_key: "ipersons-agent"`: 36% of input cached over a 3-turn chat, cost −26% (Oct 30).
  A call made ~1 s after the previous one in the same turn often still misses (cache not written yet?).

## Web search (verified live Oct 30; docs/search-grounding)
- Responses API only: `tools: [{type: "web_search", search_context_size, user_location}]`,
  `include: ["web_search_call.results"]`. Output has `web_search_call` items (action.url for opened pages,
  results[].url) and `message` items; the last message is the answer. `max_tool_calls` is accepted.
- `user_location` alone did NOT localize (Tunis → US clubs); putting "Near: Tunis, Tunisia" in the input did.
- Unbounded it opened many pages: 122k input tokens, 21 s, ~$0.095. With max_tool_calls 3 and "answer from snippets,
  don't open pages": ~9k tokens, ~10 s, ~$0.012. No per-search fee on the pricing page; we bill tokens.
- find_opportunities keeps only items whose URL host appears in the returned sources.

## Speech to text (verified live Oct 29; docs: dev.meta.ai/docs/speech-to-text)
- File: `POST /v1/asr/transcribe`, Bearer header, multipart with parts `request` (JSON) and `audio` (WAV).
  `request` = {model, audioEncoding: "WAV", mode, languageBias: ["English"]}. Response `{transcript, audioDurationMs, turns}`.
  WAV mono 16-bit 16/24 kHz, ≤10 min, ≤32 MB. Unknown request fields are ignored; MP3 is rejected.
- Realtime: `wss://api.meta.ai/v1/asr/realtime`. Auth is NOT the header: the first JSON text frame (within 10 s) is
  {authorization: {accessToken: "Bearer <key>"}, model, audioEncoding: "PCM_16KHZ"|"PCM_24KHZ", mode: PUSH_TO_TALK|ENDPOINTING|DIARIZATION,
  partialMode: CUMULATIVE|DELTA, emitAudioProgress, languageBias, keywords}. Ack = `{sessionId}` with no type.
  Then binary PCM16 LE mono at real-time pace. Server: `transcript` {transcript, final}, `speechStart/End/Complete`,
  `audioProgress`, `error`. Finish with `{"type":"endStream"}`; final transcript arrives, then close 1000. 1013 = rate limit.
  Measured: final text ~0.3 s after the audio ends.
## Muse Image + SAM (verified live Oct 29)
- Edit: `POST /v1/images/edits` JSON {model: "muse-image-1.0", prompt, images: [{image_url: data URL}], n, size, output_format,
  reasoning_strength}. Response `{data: [{b64_json}]}`. $0.01/image. Unknown top-level fields → 400; `mask` unsupported.
  `reasoning_strength: "low"` ≈ 9 s vs ≈ 22 s default, same likeness on our test selfie. Output 1600×1600 whatever `size` says.
- SAM: `POST /v1/responses` {model: "sam-3.1", input: [{role: "user", content: [input_text "mouth", input_image]}]} ≈ 2 s.
  Output text `<0f>0<|box;x1;y1;x2;y2;w;h|><|mask;…|>`; "mouth" boxes the lips well. Parsed in meta/image.ts.
- Onboarding: 2 styles in parallel + SAM on each ≈ 17 s end to end.
- Credits: $150 free credits are on the account (seen on the dashboard Oct 29).

## WhatsApp number switch (Oct 31)
- Live number is +216 55 397 770 (our own SIM, phone id 1362084566996807) on WABA "i-persons" 3697911320363912; IDs come from WA_PHONE_NUMBER_ID / WA_WABA_ID / WA_PHONE_NUMBER.
  Own numbers can send while the display name is in review (verified Oct 31: template and free text accepted). The Meta-provided +1 555-390-3087 is gone from that WABA; +1 711-685-3667 (old WABA 1843796920085615) is kept but blocked by 131037.
- Failed delivery reports are logged as "whatsapp delivery failed".
- Profile picture: resumable upload (POST /<app id>/uploads, then the upload id with "Authorization: OAuth" and file_offset 0) gives a handle for POST /<phone id>/whatsapp_business_profile {profile_picture_handle}. Set Oct 31 to the i-persons icon (640×640 JPEG).
- Template sends need a payment method on the WABA (error 131042 "Business eligibility payment issue" until then); verified working Oct 31 after adding one.
- A Meta-provided number can't send anything, not even replies inside the 24 h window, until its display name is approved (error 131037). Inbound webhooks still arrive.
- Templates are per WABA: iperson_update was recreated on the new WABA. `pnpm --filter @ipersons/server wa:check` shows the number, name review and template status.
