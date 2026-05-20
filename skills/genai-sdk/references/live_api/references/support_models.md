# Supported Live API models (Gemini Enterprise)

This document lists the models that ship with the Gemini Enterprise
Live API at the time of writing, along with the fields the agent needs
to fill into `BidiGenerateContentSetup.model` and the values that drive
defaults in the settings modal.

> **Authoritative source.** This file is a snapshot of
> <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api>.
> Model lineups change. Before adopting a model name in production
> code, the coding agent SHOULD re-fetch the page above and verify
> that:
>
> 1. Each model id listed below is still present (i.e. not
>    deprecated, removed, or renamed).
> 2. There is no newer model whose name should be preferred (e.g. a
>    GA model that replaced a Preview model the user picked).
> 3. The user's chosen Vertex AI location appears in the model's
>    "Supported regions" list.
> 4. The model's "Discontinuation date" is far enough in the future
>    for the user's use case.
>
> If the upstream page disagrees with this file, the upstream page
> wins — update this file in the same change.

## Available models — quick reference

The ids in this table are the **only** model ids the agent is
permitted to recommend or pre-fill anywhere in the user's project.
Each one has a full data card further down in this file.

| Short model id | Launch stage |
| --- | --- |
| `gemini-live-2.5-flash-native-audio` | GA |

### Hard rule

If the model id the agent is about to recommend or pre-fill anywhere
in the user's project is **not** in the table above, the agent MUST
stop and re-fetch the upstream page in the "Authoritative source"
callout above before continuing. Do not invent ids, do not copy ids
from training data, and do not fall back to ids that previously
appeared in older versions of this file. If the upstream page now
lists a new id that is not yet in this file, add a row to the table
above **and** a full data card below in the same change, then
proceed.

### Explicitly do NOT recommend

The following ids have been observed in coding-agent recommendations
but are **not valid** for new code in this skill. They are listed
here so an agent doing a substring search on a candidate id finds
this rejection text before committing it to a config file:

- `gemini-live-2.5-flash-preview-native-audio-09-2025` — Preview
  superseded by the GA `gemini-live-2.5-flash-native-audio`. The
  preview id was scheduled for removal on 2026-03-19; do not adopt it
  for new code.
- `gemini-2.0-flash-live-preview-04-09` — 2.0 Flash Live family. Not
  in the current Gemini Enterprise Live API lineup; recommendations
  of this id are almost certainly training-data leakage. Use the GA
  id above.
- `gemini-live-2.5-flash` — not a valid Live API short id. The
  closest real id is `gemini-live-2.5-flash-native-audio`; recommend
  that instead.

If the user explicitly asks for one of the ids above, the agent
SHOULD re-fetch the upstream page, confirm the current status, and
either warn the user that the id is no longer recommended (and
suggest the GA replacement) or — if the upstream page now disagrees
with this rejection list — update this file before proceeding.

## Reference snapshot — captured 2026-05-20

### Model resource name format

All Gemini Enterprise Live API models are addressed by the
fully-qualified Vertex AI resource path. The settings modal stores
only the **short model id**; the chat backend wraps it on /start:

```
projects/{project_id}/locations/{location}/publishers/google/models/{short_model_id}
```

### Default short model id used by the reference

`gemini-live-2.5-flash-native-audio`

Set as `DEFAULT_MODEL` in `frontend/chat/constants.js` and prefilled
into the settings-modal `#model-id` input in both
`frontend/index_chat_only.html` and `frontend/index_combined.html`.
Update both places together if you change the default.

---

## Live 2.5 Flash Native Audio (GA)

| Field | Value |
| --- | --- |
| Short model id | `gemini-live-2.5-flash-native-audio` |
| Launch stage | GA |
| Release date | 2025-12-12 |
| Discontinuation date | 2026-12-13 |
| Inputs | Text, Images, Audio, Video |
| Outputs | Text, Audio |
| Max input tokens | 128K |
| Max output tokens | 64K |
| Max concurrent sessions | 1000 |

### Capabilities

| Supported | Not supported |
| --- | --- |
| Grounding with Google Search | Code execution |
| System instructions | Structured output |
| Function calling | Thinking |
| Gemini Live API | Implicit / explicit context caching |
| | Vertex AI RAG Engine |
| | Chat completions (OpenAI-compat) |
| | Content Credentials (C2PA) |

### Consumption options

- **Supported:** Provisioned Throughput, Standard PayGo.
- **Not supported:** Flex PayGo, Priority PayGo, Batch prediction.

### Audio format requirements

- **Input:** Raw 16-bit PCM, **16 kHz**, mono, little-endian
  (`audio/pcm;rate=16000`). Matches `AUDIO_INPUT_SAMPLE_RATE` in
  `frontend/chat/constants.js`.
- **Output:** Raw 16-bit PCM, **24 kHz**, mono, little-endian
  (`audio/pcm;rate=24000`). Matches `AUDIO_OUTPUT_SAMPLE_RATE`.
- Other accepted MIME types for input audio:
  `audio/x-aac`, `audio/flac`, `audio/mp3`, `audio/m4a`,
  `audio/mpeg`, `audio/mpga`, `audio/mp4`, `audio/ogg`, `audio/wav`,
  `audio/webm`.
- Default conversation length: 10 minutes (extendable via session
  resumption per `session_manager.md`).

### Other media specs

- **Images:** up to 3,000 per prompt. Inline / direct upload ≤ 7 MB
  per file; GCS upload ≤ 30 MB. MIME types: `image/png`,
  `image/jpeg`, `image/webp`, `image/heic`, `image/heif`.
- **Video:** standard 768×768. MIME types: `video/x-flv`,
  `video/quicktime`, `video/mpeg`, `video/mpegs`, `video/mpg`,
  `video/mp4`, `video/webm`, `video/wmv`, `video/3gpp`.

### Parameter defaults

| Setting | Default |
| --- | --- |
| Start-of-speech sensitivity | Low |
| End-of-speech sensitivity | High |
| Prefix padding | 0 |
| Max context size | 128K |

### Supported regions

| Continent | Locations |
| --- | --- |
| United States | `us-central1`, `us-east1`, `us-east4`, `us-east5`, `us-south1`, `us-west1`, `us-west4` |
| Europe | `europe-central2`, `europe-north1`, `europe-southwest1`, `europe-west1`, `europe-west4`, `europe-west8` |

> The reference `frontend/chat/constants.js` `LOCATIONS` array lists
> a broader set (covering Asia / Australia for other models). When
> the user picks this model the agent SHOULD trim the location
> picker to the list above, or surface an error if the chosen
> location is unsupported.

### Security controls (online prediction)

Data residency, CMEK, VPC-SC, AXT.

---

## How the agent should use this file

1. **Reading it at setup time.** When the user picks a model in the
   skill's interview step (Step 1 of `SKILL.md`), or when the chat
   backend wraps the short id into a fully-qualified resource name
   on /start, the agent SHOULD consult this file to:
   - Verify the chosen short id appears in the "Available models —
     quick reference" table at the top of this file. If it does not,
     follow the "Hard rule" in that section before doing anything
     else.
   - Reject obviously invalid combinations early (model id that
     isn't listed, region that isn't in the model's "Supported
     regions" list).
   - Choose sensible UI defaults driven by the data cards below
     (voices, locations to surface in the picker, etc.).

2. **Checking for updates.** Whenever the agent is about to ship
   user-visible model defaults — i.e. when it edits
   `frontend/chat/constants.js`'s `DEFAULT_MODEL`, the
   `value="..."` for `#model-id` in the entry HTML files, or the
   `LOCATIONS` array — it SHOULD first re-fetch
   <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/2-5-flash-live-api>
   and reconcile the snapshot above with the live page. If anything
   changed, update this file in the same change (and any
   default-model strings in the references) so the snapshot stays
   useful.

3. **Cross-references inside the skill.**
   - `client_server_messages.md` § 4 — `setup.model` format and
     model name validation rules.
   - `session_manager.md` — bearer-token refresh, max conversation
     length, session extension.
   - `frontend/chat/constants.js` — `DEFAULT_MODEL`, `LOCATIONS`,
     `AUDIO_INPUT_SAMPLE_RATE`, `AUDIO_OUTPUT_SAMPLE_RATE`.
   - `frontend/index_chat_only.html` and
     `frontend/index_combined.html` — settings modal pre-filled
     model id and location options.
