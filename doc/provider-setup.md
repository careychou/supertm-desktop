# Setting up model providers

Open **⚙ Settings → Model providers → ＋ Add provider** and pick a kind. You can add several; the
chat box groups models by provider, and you choose the model per chat.

The **first provider is the primary**: its model ids are shown bare (`anthropic/claude-sonnet-5`);
models of every other provider are prefixed with its id (`azure::gpt-5`). Use **Make primary** to
move a provider to the top. Existing chats are re-pointed automatically, so they keep using the
same model. **Remove** works on any provider, including the primary (the next one takes over); chats that used a removed provider move to the same model name on the new primary.
Untick **Enabled** to hide a provider's models without deleting it.

Press **Test** before **Save**. It signs in and lists (or pings) the models, so most wrong keys,
projects or permissions show up immediately.

| Kind | Use it for | Auth |
|---|---|---|
| [Google Vertex AI](#google-vertex-ai) | Gemini, Claude and Model Garden MaaS models (GLM, gpt-oss, DeepSeek, Gemma …) in your GCP project | Service-account JSON key (or gcloud ADC) |
| [Azure OpenAI](#azure-openai) | GPT / o-series deployments on an Azure OpenAI resource | Resource API key |
| [Custom endpoint](#custom-endpoint) | Any OpenAI-compatible server: vLLM, Ollama, LiteLLM, OpenRouter, your own gateway | Bearer API key |

---

## Google Vertex AI

The app talks to Vertex AI directly: it signs in with a service account, sends Claude requests to
Anthropic's streaming endpoint on Vertex (with prompt caching) and every other model to Vertex's
OpenAI-compatible endpoint. Nothing else has to run on your Mac.

### 1. Prepare GCP (once, by a project admin)

```bash
PROJECT=my-gcp-project
SA=supertm-desktop@$PROJECT.iam.gserviceaccount.com

gcloud services enable aiplatform.googleapis.com monitoring.googleapis.com --project $PROJECT
gcloud iam service-accounts create supertm-desktop --project $PROJECT --display-name "SuperTM Desktop"

# call models
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SA --role roles/aiplatform.user
# optional: the AI usage panel's Project tab reads token counts from Cloud Monitoring
gcloud projects add-iam-policy-binding $PROJECT --member serviceAccount:$SA --role roles/monitoring.viewer

# a key file for each user (keep it private)
gcloud iam service-accounts keys create ~/.config/supertm/sa-key.json --iam-account $SA
chmod 600 ~/.config/supertm/sa-key.json
```

Partner models (Claude, GLM, …) must also be **enabled in Model Garden** for the project, and
some are only served in certain regions. Check the model card for its region.

If your organization does not allow key files, leave the key path empty and run
`gcloud auth application-default login` once. The app then uses your own user credentials.

### 2. Add the provider

| Field | What to enter |
|---|---|
| **Name** | Any label, e.g. `GCP Model Bank` |
| **Project** | GCP project id, e.g. `my-gcp-project` |
| **Location** | Default region. `global` for most MaaS / partner models; a region such as `us-east5` for regional ones |
| **Service-account key** | Path to the JSON key (📁 to browse). Only the *path* is saved; the key is read when a token is needed and never copied. Empty = `$GOOGLE_APPLICATION_CREDENTIALS`, then gcloud ADC, then `gcloud auth print-access-token` |
| **Models** | One model per line: `publisher/model [@location] [describe]` (see below) |
| **Vision model** | Model that describes images for text-only models, e.g. `google/gemini-3.8-flash` |
| **Claude prompt cache** | `5m` (default), `1h` (fewer cache writes for long pauses; costs more per write) or `off` |

Model lines:

```text
anthropic/claude-sonnet-5          # Claude, streamed with prompt caching
google/gemini-2.5-pro
google/gemini-3.8-flash
openai/gpt-oss-120b-maas describe  # text-only: images are transcribed by the vision model
zai-org/glm-5.2-maas describe
anthropic/claude-opus-5 @us-east5  # override the location for one model
```

- `@region` overrides the default location for that model.
- `describe` marks a model that cannot read images. Each image is transcribed once by the vision
  model, and the text is sent instead. The result is cached per image.
- `#` starts a comment. Blank lines are ignored.

### 3. Test and use

**Test** mints a token and sends a 1-token request. Possible results:
- `✓` with a model count: you're done. Click **Make primary** if this should be the main provider.
- `403 … aiplatform.endpoints.predict`: the service account lacks `roles/aiplatform.user` on the project.
- `404` for one model: it isn't enabled in Model Garden, or it isn't served in that location. Add `@region`.
- `service-account key not found`: fix the path.

### AI usage → Project tab

The Project tab reads `aiplatform.googleapis.com/publisher/online_serving/token_count` from Cloud
Monitoring for the **first enabled Vertex provider's project**, using the same credentials. It
covers every caller in the project, not just this app, for the last ~6 weeks. It needs
`roles/monitoring.viewer`. Costs come from `pricing.json` (Settings path, then `~/.supertm/pricing.json`, then any price table built into the app; see the README).

---

## Azure OpenAI

### 1. Prepare Azure

1. In the Azure portal, open (or create) an **Azure OpenAI** resource.
2. **Keys and Endpoint** → copy the endpoint (`https://<resource>.openai.azure.com`) and **Key 1**.
3. **Azure AI Foundry → Deployments** → deploy each model you want. The **deployment name** you
   choose (e.g. `gpt-5`, `o4-mini-prod`) is what the app calls; it need not match the model name.

### 2. Add the provider

| Field | What to enter |
|---|---|
| **Name** | Any label, e.g. `Azure OpenAI` |
| **Resource host** | `https://<resource>.openai.azure.com` (a trailing `/openai` or `/openai/v1` is ignored) |
| **API key** | Key 1 or Key 2. Stored encrypted with the macOS Keychain |
| **API version** | `2025-04-01-preview` (default). Use a newer version if a model requires it |
| **Deployments** | One deployment name per line |

Requests go to
`<host>/openai/deployments/<deployment>/chat/completions?api-version=<version>` with an `api-key`
header. The app sends `max_completion_tokens`. When **Thinking** is on it also sends
`reasoning_effort`; if a deployment rejects that field (400), the request is retried without it.

Some newer models (e.g. `gpt-6.1-sol`) refuse function tools on chat/completions and point to the
Responses API. When a deployment answers 400 that way, the app switches it to
`<host>/openai/v1/responses` (stateless, `store: false`, full history each turn) and remembers the
choice for that deployment until the app restarts. Nothing to configure.

**Azure AI Foundry (AI Services) resources** work the same way. A Foundry project URL such as
`ai.azure.com/.../<subscription>,<resource-group>,,<resource>,<project>/...` names the resource;
use `https://<resource>.openai.azure.com` as the host (the "Azure OpenAI Legacy API" endpoint), not
the `services.ai.azure.com` or `cognitiveservices.azure.com` hosts. With the Azure CLI:

```bash
az cognitiveservices account deployment list -g <resource-group> -n <resource> -o table
az cognitiveservices account keys list -g <resource-group> -n <resource> --query key1 -o tsv | pbcopy
```

### 3. Test and use

Azure has no "list deployments" call on the data plane, so **Test** only checks that the host is
set and returns your deployment list. The key and deployment names are checked by the first
message: send a short prompt to each new deployment. Each deployment appears in the model picker, as
`<provider-id>::<deployment>` unless Azure is the primary.

---

## Custom endpoint

Use this for any server that speaks the OpenAI **Chat Completions** API with streaming and tools.

| Field | What to enter |
|---|---|
| **Base URL** | The `/v1` root, e.g. `http://localhost:8000/v1` (vLLM), `http://localhost:11434/v1` (Ollama), `https://openrouter.ai/api/v1` |
| **API key** | Sent as `Authorization: Bearer <key>`. Any non-empty value for servers without auth |

**Test** calls `GET <base>/models`, and the returned models appear in the picker. For the usage
panel, the server should honor `stream_options.include_usage`. For thinking blocks it should
stream `reasoning_content` (or `<think>` tags).

The headless CLI (`npm run cli`) uses a single custom endpoint from `SUPERTM_BASE_URL` / `SUPERTM_API_KEY`.

---

## Where settings live

`~/.supertm/settings.json` holds the providers. API keys are saved as `apiKeyEnc`, encrypted with
Electron `safeStorage` (the macOS Keychain). Vertex keys are never copied; only their path is
stored. Deleting a provider deletes its encrypted key.
