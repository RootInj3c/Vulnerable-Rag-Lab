# DigitalWhisper Lab — Hacking RAG Systems

A deliberately vulnerable, single-user educational Node.js application for a RAG security article. All identities, tickets and actions are fictional. Local plaintext is the source of truth; retrieval and model generation are separate. Do not deploy this as a public or production service. It has no real authentication, tenancy or identity-provider integration. Run only on a controlled, isolated workshop machine.

## Start (Node.js 22+)

```bash
npm start
```

Open http://127.0.0.1:3000. No npm packages or API keys are needed for default offline mode. `npm test` runs the automated API regression suite.

Restart the application. Generate a DigitalOcean **Model Access Key** in the DigitalOcean Inference console, not an agent endpoint key. Both the chat and embedding provider settings are independent. 

When remote inference is active, synthetic questions, document contents, external-source text may be sent to the selected providers. Never use real employee or sensitive data. Charges and model access depend on your account; no fallback silently masks a provider error.

## Branding and references

The sidebar uses the Digital Whisper RSS logo URL published at https://www.digitalwhisper.co.il/rss (https://www.digitalwhisper.co.il/rsslogo.png). The asset could not be downloaded in the build environment. For fully offline branding place the official PNG at `public/digitalwhisper.png`; the UI attempts this local file first, then the official URL, and falls back to a text wordmark if unavailable. Branding does not imply endorsement.

- https://github.com/GenAI-Security-Project/GenAI-LLM-Top10/tree/main/2026
- https://atlas.mitre.org/techniques/AML.T0066
- https://atlas.mitre.org/techniques/AML.T0070
- https://atlas.mitre.org/techniques/AML.T0051.001
- https://docs.digitalocean.com/products/inference/how-to/si-endpoints/
- https://docs.digitalocean.com/products/inference/reference/api/embeddings/

## Project structure

```text
hacking-rags/
  server.mjs          HTTP API, retrieval, toy policies, model connectors
  public/             HTML / CSS / browser JavaScript
  seed/*.txt          Local IT knowledge base
  demo-web/status.html Editable website fixture
  data/               Generated at runtime: lab tickets and reset events
  test.mjs            Offline end-to-end HTTP tests
  .env.example        Configuration sample
```

Data sources use a title, owner, kind text header and a blank line before body. The server reloads local `.txt` files per query, chunks at 120 words with 20-word overlap, and caches embeddings in memory by content hash. The query is embedded and ranked by cosine similarity; top 3 chunks are retrieved. The chat API returns text, source, owner, chunk and score; these are not displayed in a separate UI panel. In lab 02 a toy reset action writes only a simulated event to a local `actions.log`. Labs intentionally expose evidence for educational inspection. For actual application security, enforce authorization independently of retrieved text and model claims; apply tenant/user ACLs before retrieval, separate authoritative from untrusted sources, scope tools, and restrict egress.

Developed By [Maor Tal](https://www.linkedin.com/in/maor-tal-06a7ba2a/).
