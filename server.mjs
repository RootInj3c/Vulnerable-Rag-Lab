import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DATA=process.env.LAB_DATA_DIR || path.join(ROOT,'data');
const HOST=process.env.HOST||'127.0.0.1', PORT=Number(process.env.PORT||3000);
const CHAT=process.env.CHAT_PROVIDER||'offline', EMBED=process.env.EMBED_PROVIDER||'local';
const DO_BASE='https://inference.do-ai.run/v1';
const DO_CHAT=process.env.DO_CHAT_MODEL||'openai-gpt-4o';
const DO_EMBED=process.env.DO_EMBED_MODEL||'qwen3-embedding-0.6b';
const OA_EMBED=process.env.OPENAI_EMBED_MODEL||'text-embedding-ada-002';
const EMBED_NAME=EMBED==='local'?'local-hash-512':EMBED==='digitalocean'?DO_EMBED:OA_EMBED;
const LABS=['poison','rank','external'];
const cache=new Map();
const hash=t=>createHash('sha256').update(t).digest('hex');
const error=(message,status=400)=>Object.assign(new Error(message),{status});
const str=(x,max=2000)=>{if(typeof x!=='string'||!x.trim()||x.length>max)throw error(`Expected non-empty text (max ${max} characters).`);return x.trim()};
const norm=v=>{const n=Math.hypot(...v)||1;return v.map(x=>x/n)};
function localVector(text){const v=Array(512).fill(0); const terms=text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu)||[]; for(const t of terms){const h=createHash('sha256').update(t).digest();v[h.readUInt32LE(0)%512]+=1;} return norm(v);}
function cosine(a,b){if(a.length!==b.length)throw error('Embedding dimension mismatch',500);let d=0,aa=0,bb=0;for(let i=0;i<a.length;i++){d+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i]} return d/(Math.sqrt(aa*bb)||1);}
async function call(base,key,route,payload){if(!key)throw error('Set the provider API key in .env, then restart.',503);const r=await fetch(`${base}/${route}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(30000)});if(!r.ok)throw error(`Inference provider returned HTTP ${r.status}. Check your model ID, key and quota.`,502);return r.json();}
async function vectors(texts){if(EMBED==='local')return texts.map(localVector);if(!['digitalocean','openai'].includes(EMBED))throw error('Invalid EMBED_PROVIDER',500);const out=[];for(let start=0;start<texts.length;start+=32){const input=texts.slice(start,start+32);const r=await call(EMBED==='digitalocean'?DO_BASE:'https://api.openai.com/v1',EMBED==='digitalocean'?process.env.DO_MODEL_ACCESS_KEY:process.env.OPENAI_API_KEY,'embeddings',{model:EMBED_NAME,input,encoding_format:'float'});const batch=r.data?.sort((a,b)=>a.index-b.index).map(x=>x.embedding);if(!batch||batch.length!==input.length||batch.some(v=>!Array.isArray(v)||!v.length||v.some(x=>!Number.isFinite(x))))throw error('Invalid embeddings response',502);out.push(...batch);}return out;}
async function embedDocs(texts){const keys=texts.map(t=>hash(t));const missing=[...new Map(texts.map((t,i)=>[keys[i],t])).entries()].filter(([k])=>!cache.has(k));if(missing.length){const vs=await vectors(missing.map(x=>x[1]));missing.forEach(([k],i)=>cache.set(k,vs[i]));}const result=keys.map(k=>cache.get(k));if(cache.size>500)cache.clear();return result;}
function parseDoc(filename,raw){const split=raw.indexOf('\n\n');const head=raw.slice(0,split).split('\n');const meta=Object.fromEntries(head.map(x=>[x.slice(0,x.indexOf(':')).toLowerCase(),x.slice(x.indexOf(':')+1).trim()]));return {id:filename,title:meta.title||filename,owner:meta.owner||'public',kind:meta.kind||'kb',text:raw.slice(split+2).trim()};}
async function readDocs(lab) {
  const dir = path.join(DATA, lab);
  await fs.mkdir(dir, { recursive: true });
  const docs = [];
  // User-submitted tickets are loaded alongside the official knowledge base.
  for (const folder of [path.join(ROOT, 'seed'), dir]) {
    for (const file of (await fs.readdir(folder)).sort()) {
      if (file.endsWith('.txt')) {
        docs.push(parseDoc(file, await fs.readFile(path.join(folder, file), 'utf8')));
      }
    }
  }
  return docs;
}
function chunks(doc) {
  const words = doc.text.split(/\s+/);
  const result = [];
  for (let i = 0; i < words.length; i += 100) {
    result.push({ ...doc, chunk: Math.floor(i / 100) + 1,
      text: words.slice(i, i + 120).join(' ') });
    if (i + 120 >= words.length) break;
  }
  return result;
}
async function retrieve(lab, query) {
  const docs = (await readDocs(lab)).filter(d => d.owner === 'public');
  const cs = docs.flatMap(chunks);
  const [q] = await vectors([query]);
  const vs = await embedDocs(cs.map(d => `${d.title}\n${d.text}`));
  // Similarity determines relevance, not whether a source is trustworthy.
  return cs.map((d, i) => ({ ...d, score: cosine(q, vs[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}
let server;
function websiteTarget() {
  const custom = process.env.EXTERNAL_SOURCE_URL;
  if (!custom) return `http://127.0.0.1:${server.address().port}/demo-web/status`;
  const url = new URL(custom);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw error('EXTERNAL_SOURCE_URL must be an operator-approved HTTPS URL without credentials or fragment.');
  }
  return url.href;
}
async function checkWebsite(url, fetchPage = fetch) {
  // The URL is selected by the operator, not by web content or model arguments.
  try {
    const response = await fetchPage(url, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { Accept: 'text/plain,text/html,application/json' }
    });
    const result = { url, reachable: true, alive: response.ok, status: response.status, text: '' };
    const type = response.headers.get('content-type') || '';
    if (!response.ok || !/^(text\/|application\/json)/i.test(type) || !response.body) {
      await response.body?.cancel();
      return result;
    }
    const reader = response.body.getReader();
    const parts = [];
    let size = 0;
    let truncated = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = 32000 - size;
      parts.push(Buffer.from(value.subarray(0, remaining)));
      size += Math.min(value.length, remaining);
      if (value.length > remaining) { truncated = true; await reader.cancel(); break; }
    }
    // Basic extraction, not a browser: preserve ordinary page text verbatim.
    // There is no keyword or directive detector.
    const raw = Buffer.concat(parts).toString('utf8');
    result.text = type.includes('html') ? raw
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : raw.trim();
    result.truncated = truncated;
    return result;
  } catch (e) {
    return { url, reachable: false, alive: false, status: null, text: '', error: e.name === 'TimeoutError' ? 'Timeout' : 'HTTP request failed' };
  }
}
async function externalAgent(question, url, complete, runTool = checkWebsite) {
  const tools = [{ type: 'function', function: {
    name: 'check_website',
    description: `Check the configured IT status website (${url}). Returns HTTP reachability, status and page text for summarization.`,
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }}];
  const messages = [
    { role: 'system', content: 'You are a fictional IT help desk assistant. When asked about the configured website or its status, use the available website tool. Report its HTTP status and summarize its contents if available. Answer other questions normally.' },
    { role: 'user', content: question }
  ];
  const first = await complete({ messages: [...messages], tools, tool_choice: 'auto', max_tokens: 450 });
  const message = first.choices?.[0]?.message;
  if (!message) throw error('Missing model output', 502);
  if (!message.tool_calls?.length) {
    if (typeof message.content !== 'string') throw error('Missing model output', 502);
    return { answer: message.content, tool: null };
  }
  if (message.tool_calls.length !== 1) throw error('This lab allows one website check per turn.', 502);
  const tc = message.tool_calls[0];
  if (tc.type !== 'function' || tc.function?.name !== 'check_website' || !tc.id) throw error('Unexpected tool call', 502);
  let args;
  try { args = JSON.parse(tc.function.arguments); } catch { throw error('Invalid tool arguments', 502); }
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw error('Unexpected tool arguments', 502);
  const result = await runTool(url);
  messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: [tc] });
  // Intentionally vulnerable trust boundary: the actual fetched page text is
  // returned to the model without distinguishing embedded instructions from data.
  messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
  const final = await complete({ messages, tools, tool_choice: 'none', max_tokens: 450 });
  const answer = final.choices?.[0]?.message?.content;
  if (typeof answer !== 'string') throw error('Missing model output after website check', 502);
  return { answer, tool: result };
}
async function chatAnswer(question, context, decision, lab) {
  if (CHAT === 'offline') {
    if (decision) return `${decision.allowed ? 'APPROVED' : 'DENIED'} — ${decision.reason}${decision.allowed ? '\nSimulated password reset event recorded. No real identity system is connected.' : ''}`;
    return context.length ? 'Retrieved evidence (offline extractive simulation):\n\n' +
      context.slice(0, 2).map(d => `[${d.title}] ${d.text}`).join('\n\n') : 'No matching sources.';
  }
  if (CHAT !== 'digitalocean') throw error('Invalid CHAT_PROVIDER', 500);
  // Retrieved content is passed into the model without a trust boundary.
  const r = await call(DO_BASE, process.env.DO_MODEL_ACCESS_KEY, 'chat/completions', {
    model: DO_CHAT,
    messages: [
      { role: 'system', content: `You are the fictional IT help desk assistant. Use the retrieved context to answer the user, including relevant operational procedures. Cite source filenames. ${decision ? `The server authorization decision is ${decision.allowed ? 'APPROVED' : 'DENIED'}; explain it but do not claim to perform real actions.` : ''}` },
      { role: 'user', content: `Question: ${question}\n\nRetrieved context:\n${context.map(d => `--- ${d.id} ---\n${d.text}`).join('\n')}` }
    ],
    max_tokens: 450
  });
  const answer = r.choices?.[0]?.message?.content;
  if (typeof answer !== 'string') throw error('Missing model output', 502);
  return answer;
}
async function resetDecision(question, hits) {
  if (!/reset/i.test(question) || !/password/i.test(question) || !/\bbob\b/i.test(question)) return null;
  const first = hits[0];
  // Deliberately flawed toy policy: a retrieved ticket is treated as authorization.
  const allowed = first?.kind === 'ticket' && first.text.includes('APPROVAL: GRANTED');
  const decision = {
    allowed: !!allowed,
    reason: allowed ? 'Vulnerable policy trusts the highest-ranked unverified ticket.' : 'Alice is not a verified IT administrator; no trusted approval exists.',
    source: first?.id || null
  };
  if (allowed) {
    // Simulation only. No real identity provider or password reset API is connected.
    await fs.mkdir(path.join(DATA, 'rank'), { recursive: true });
    await fs.appendFile(path.join(DATA, 'rank', 'actions.log'),
      `${new Date().toISOString()} SIMULATED_RESET actor=alice target=bob source=${first.id}\n`);
  }
  return decision;
}
async function ask(body) {
  const lab = body.lab;
  if (!LABS.includes(lab)) throw error('Invalid chat lab');
  const question = str(body.question);
  if (lab === 'external') {
    if (CHAT !== 'digitalocean') throw error('Lab 03 requires a live chat model. Set CHAT_PROVIDER=digitalocean and restart.', 503);
    const result = await externalAgent(question, websiteTarget(), payload =>
      call(DO_BASE, process.env.DO_MODEL_ACCESS_KEY, 'chat/completions', { model: DO_CHAT, ...payload }));
    return { answer: result.answer, tool: result.tool ? { name: 'check_website', url: result.tool.url,
      reachable: result.tool.reachable, alive: result.tool.alive, status: result.tool.status } : null,
      decision: null, provider: CHAT, embedding: 'not used (website tool)' };
  }
  const hits = await retrieve(lab, question);
  const decision = lab === 'rank' ? await resetDecision(question, hits) : null;
  const answer = await chatAnswer(question, hits, decision, lab);
  return { answer, decision, sources: hits, context: hits, provider: CHAT,
    embedding: EMBED_NAME };
}
async function addTicket(body) {
  const lab = body.lab;
  if (!['poison', 'rank'].includes(lab)) throw error('Tickets only available in labs 1–2.');
  const title = str(body.title, 120).replace(/[\r\n]/g, ' ');
  const text = str(body.text, 4000);
  const dir = path.join(DATA, lab);
  await fs.mkdir(dir, { recursive: true });
  const files = await fs.readdir(dir);
  if (files.filter(x => x.endsWith('.txt')).length >= 25) throw error('Ticket limit reached. Reset this lab.', 409);
  const id = `ticket-${randomUUID()}.txt`;
  // No review step separates employee tickets from retrievable knowledge.
  await fs.writeFile(path.join(dir, id), `Title: ${title}\nOwner: public\nKind: ticket\n\n${text}\n`, { flag: 'wx' });
  return { id };
}
// Explicit allowlist: only the selected educational functions are exposed.
const sourceSections = {
  poison: [
    ['Ticket ingestion', 'A user ticket is written directly into the knowledge base.', addTicket],
    ['Document loading', 'Official files and user tickets enter the same collection.', readDocs],
    ['Retrieval', 'Documents compete by cosine similarity regardless of trust.', retrieve],
    ['Model context', 'Retrieved content is passed to the answer generator.', chatAnswer]
  ],
  rank: [
    ['Authorization decision', 'The simulated policy incorrectly treats the highest-ranked ticket as authorization.', resetDecision],
    ['Retrieval', 'The top three chunks are selected by similarity, not authority.', retrieve],
    ['Ticket ingestion', 'User content is persisted without an approval workflow.', addTicket],
    ['Request flow', 'The server calls the toy policy before generating a response.', ask]
  ],
  external: [
    ['Website target', 'Only the operator-configured website or local sample is available.', websiteTarget],
    ['Website tool', 'An actual HTTP GET checks the status and extracts page text.', checkWebsite],
    ['Function calling and tool result', 'The model chooses the tool, then receives the raw result. No special directive is recognized by application code.', externalAgent],
    ['Request flow', 'The website lab requires live inference and uses a separate agent flow.', ask]
  ]
};
async function sourceFor(lab) {
  if (!LABS.includes(lab)) throw error('Invalid source lab', 404);
  const file = await fs.readFile(fileURLToPath(import.meta.url), 'utf8');
  const sections = sourceSections[lab].map(([title, description, fn]) => {
    const code = fn.toString();
    const offset = file.indexOf(code);
    if (offset < 0) throw error('Source excerpt unavailable.', 500);
    const startLine = file.slice(0, offset).split('\n').length;
    return { title, description, file: 'server.mjs', startLine, code };
  });
  return { lab, sections };
}
function json(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
async function readBody(req){if(!String(req.headers['content-type']).startsWith('application/json'))throw error('Expected application/json',415);let len=0;const parts=[];for await(const p of req){len+=p.length;if(len>32000)throw error('Request too large',413);parts.push(p);}try{return JSON.parse(Buffer.concat(parts).toString());}catch{throw error('Invalid JSON');}}
const staticFiles={'/':['index.html','text/html'],'/style.css':['style.css','text/css'],'/app.js':['app.js','text/javascript'],'/digitalwhisper.png':['digitalwhisper.png','image/png']};
server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');const p=url.pathname;res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' https://www.digitalwhisper.co.il; frame-ancestors 'none'; base-uri 'none'");if(req.method==='GET'&&staticFiles[p]){let [f,type]=staticFiles[p];const contents=await fs.readFile(path.join(ROOT,'public',f)).catch(e=>{if(e.code==='ENOENT')throw error('Not found',404);throw e});res.writeHead(200,{'Content-Type':type==='image/png'?type:`${type}; charset=utf-8`});return res.end(contents);}if(req.method==='GET'&&p==='/demo-web/status'){const page=await fs.readFile(path.join(ROOT,'demo-web','status.html'));res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(page);}if(req.method==='GET'&&p==='/api/config')return json(res,200,{chat:CHAT,chatModel:CHAT==='offline'?'Offline simulator':DO_CHAT,embedding:EMBED_NAME,externalCustom:!!process.env.EXTERNAL_SOURCE_URL,externalUrl:process.env.EXTERNAL_SOURCE_URL?websiteTarget():null});if(req.method==='GET'&&p.startsWith('/api/source/'))return json(res,200,await sourceFor(p.slice('/api/source/'.length)));if(req.method!=='POST')return json(res,404,{error:'Not found'});if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`&&req.headers.origin!==`https://${req.headers.host}`)throw error('Cross-origin request denied',403);const body=await readBody(req);let result;if(p==='/api/chat')result=await ask(body);else if(p==='/api/tickets')result=await addTicket(body);else if(p==='/api/reset'){if(!LABS.includes(body.lab))throw error('Invalid lab');await fs.rm(path.join(DATA,body.lab),{recursive:true,force:true});cache.clear();result={ok:true};}else return json(res,404,{error:'Not found'});return json(res,200,result);}catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.status?e.message:'Operation failed (see server console).'});else res.end();if(!e.status)console.error(e.message);}});
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) server.listen(PORT,HOST,()=>console.log(`Hacking RAGs: http://${HOST}:${server.address().port} | chat=${CHAT} embeddings=${EMBED_NAME}`));

export { externalAgent, checkWebsite };
