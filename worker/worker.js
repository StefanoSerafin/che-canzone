/*
 * che-canzone — Cloudflare Worker (cervello + proxy)
 * =================================================================
 * Endpoint:
 *   POST /identify   body {q}                         -> {candidates:[{title,artist,year,why}]}
 *   POST /details    body {title,artist,query?,year?,album?} -> {facts,lyrics,lyricsSource}
 *   GET  /history?limit=50&q=                         -> {rows:[{ts,query,title,artist,year,album}]}
 *
 * NOTA iTunes: la copertina + i dati ufficiali NON passano da qui. Apple
 * rate-limita in modo aggressivo il pool di IP dei Cloudflare Workers
 * (429 "Rate limit ... itunes-apple-com"). L'app li recupera via JSONP
 * direttamente dal browser (IP di casa), e passa year/album a /details
 * per lo storico.
 *
 * Deploy: dashboard Cloudflare -> il Worker -> Edit Code -> incolla -> Deploy
 *   oppure:  wrangler deploy   (vedi wrangler.toml + README)
 *
 * Binding richiesto:   DB  -> database D1 "che-canzone"
 * Secret richiesti:    ANTHROPIC_API_KEY, APP_KEY
 * Variabile:           DAILY_CAP (default 200)
 * Schema DB:           worker/schema.sql
 */

const MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-App-Key",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      // --- auth: segreto condiviso ---
      const key = request.headers.get("X-App-Key") || "";
      if (!env.APP_KEY || key !== env.APP_KEY) {
        return json({ error: "Chiave non valida." }, 401);
      }

      if (url.pathname === "/history" && request.method === "GET") {
        return await handleHistory(url, env);
      }

      // --- tetto giornaliero (vale per identify + details) ---
      const cap = parseInt(env.DAILY_CAP, 10) || 200;
      const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
      const used = await countToday(env, today);
      if (used >= cap) {
        return json(
          { error: "Limite giornaliero raggiunto. Riprova domani." },
          429
        );
      }

      if (url.pathname === "/identify" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        return await handleIdentify(body, env);
      }

      if (url.pathname === "/details" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        return await handleDetails(body, env);
      }

      return json({ error: "Endpoint non trovato." }, 404);
    } catch (err) {
      return json({ error: "Errore interno: " + (err && err.message) }, 500);
    }
  },
};

/* ------------------------------------------------------------------ */
/* /identify                                                          */
/* ------------------------------------------------------------------ */

async function handleIdentify(body, env) {
  const q = (body.q || "").toString().trim();
  if (!q) return json({ error: "Query vuota." }, 400);

  const system =
    "Sei un esperto di musica, inclusi pop e rock italiani. " +
    "L'utente ha sentito una canzone alla radio e ricorda solo un frammento: " +
    "puo' essere un pezzo di titolo storpiato, un verso del testo mal ricordato " +
    "(anche in inglese approssimativo, con parole travisate), o una descrizione " +
    "vaga (artista, anno, genere, \"quella della pubblicita' X\"). " +
    "Restituisci SOLO un array JSON di massimo 3 oggetti " +
    '{"title","artist","year","why"}, dal piu\' probabile al meno probabile. ' +
    '"year" e\' una stringa con l\'anno di uscita. "why" e\' una frase breve in ' +
    "italiano che spiega perche' corrisponde. Se nulla e' plausibile, restituisci []. " +
    "Nessun testo fuori dal JSON.";

  const data = await anthropic(env, {
    system,
    max_tokens: 700,
    messages: [{ role: "user", content: q }],
  });

  const text = extractText(data);
  const candidates = safeJsonArray(text).slice(0, 3).map(normCandidate);
  return json({ candidates });
}

function normCandidate(c) {
  return {
    title: str(c.title),
    artist: str(c.artist),
    year: str(c.year),
    why: str(c.why),
  };
}

/* ------------------------------------------------------------------ */
/* /details                                                           */
/* ------------------------------------------------------------------ */

async function handleDetails(body, env) {
  const title = (body.title || "").toString().trim();
  const artist = (body.artist || "").toString().trim();
  const query = (body.query || "").toString().trim();
  const year = (body.year || "").toString().trim();
  const album = (body.album || "").toString().trim();
  if (!title || !artist) return json({ error: "title e artist richiesti." }, 400);

  const [facts, lyricsRes] = await Promise.all([
    getFacts(env, title, artist).catch(() => []),
    getLyrics(title, artist).catch(() => ({ lyrics: null, lyricsSource: null })),
  ]);

  // log su D1 (non deve mai far fallire la risposta)
  try {
    await env.DB.prepare(
      "INSERT INTO lookups (ts, query, title, artist, year, album) VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(
        new Date().toISOString(),
        query || `${artist} ${title}`,
        title,
        artist,
        year,
        album
      )
      .run();
  } catch (e) {
    /* ignora errori di logging */
  }

  return json({
    facts,
    lyrics: lyricsRes.lyrics,
    lyricsSource: lyricsRes.lyricsSource,
  });
}

async function getFacts(env, title, artist) {
  const system =
    "Ti do un brano confermato (titolo + artista). Scrivi 3-4 curiosita' in " +
    "italiano, tono brillante e un filo ironico, non da enciclopedia: aneddoti " +
    "di registrazione, fatti di classifica, sample o cover famose, curiosita' " +
    "sull'artista o sul gruppo. NON riprodurre il testo della canzone. " +
    'Restituisci SOLO {"facts": ["...", "..."]}. Nessun testo fuori dal JSON.';

  const data = await anthropic(env, {
    system,
    max_tokens: 800,
    messages: [{ role: "user", content: `Brano: "${title}" di ${artist}` }],
  });

  const text = extractText(data);
  const obj = safeJsonObject(text);
  const facts = Array.isArray(obj.facts) ? obj.facts.map(str).filter(Boolean) : [];
  return facts.slice(0, 4);
}

async function getLyrics(title, artist) {
  const u =
    "https://lrclib.net/api/search?q=" +
    encodeURIComponent(`${artist} ${title}`);
  const r = await fetch(u, {
    headers: { "User-Agent": "che-canzone (personal tool)" },
  });
  if (!r.ok) return { lyrics: null, lyricsSource: null };
  const arr = await r.json();
  if (!Array.isArray(arr)) return { lyrics: null, lyricsSource: null };
  const hit = arr.find((x) => x && x.plainLyrics && x.plainLyrics.trim());
  if (!hit) return { lyrics: null, lyricsSource: null };
  return { lyrics: hit.plainLyrics.trim(), lyricsSource: "LRCLIB" };
}

/* ------------------------------------------------------------------ */
/* /history                                                           */
/* ------------------------------------------------------------------ */

async function handleHistory(url, env) {
  let limit = parseInt(url.searchParams.get("limit"), 10) || 50;
  if (limit > 200) limit = 200;
  if (limit < 1) limit = 1;
  const q = (url.searchParams.get("q") || "").trim();

  let stmt;
  if (q) {
    const like = `%${q}%`;
    stmt = env.DB.prepare(
      "SELECT ts, query, title, artist, year, album FROM lookups " +
        "WHERE title LIKE ? OR artist LIKE ? ORDER BY ts DESC LIMIT ?"
    ).bind(like, like, limit);
  } else {
    stmt = env.DB.prepare(
      "SELECT ts, query, title, artist, year, album FROM lookups ORDER BY ts DESC LIMIT ?"
    ).bind(limit);
  }
  const { results } = await stmt.all();
  return json({ rows: results || [] });
}

async function countToday(env, today) {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM lookups WHERE ts LIKE ?"
    )
      .bind(`${today}%`)
      .first();
    return (row && row.n) || 0;
  } catch (e) {
    return 0; // se il DB non risponde non blocchiamo l'uso
  }
}

/* ------------------------------------------------------------------ */
/* helper                                                             */
/* ------------------------------------------------------------------ */

async function anthropic(env, { system, max_tokens, messages }) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: MODEL, system, max_tokens, messages }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Anthropic ${r.status}: ${t.slice(0, 200)}`);
  }
  return await r.json();
}

function extractText(data) {
  try {
    return (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  } catch (e) {
    return "";
  }
}

// estrae il primo array JSON dal testo del modello
function safeJsonArray(text) {
  if (!text) return [];
  try {
    return JSON.parse(text);
  } catch (e) {}
  const a = text.indexOf("[");
  const b = text.lastIndexOf("]");
  if (a !== -1 && b > a) {
    try {
      const v = JSON.parse(text.slice(a, b + 1));
      return Array.isArray(v) ? v : [];
    } catch (e) {}
  }
  return [];
}

// estrae il primo oggetto JSON dal testo del modello
function safeJsonObject(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (e) {}
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try {
      return JSON.parse(text.slice(a, b + 1)) || {};
    } catch (e) {}
  }
  return {};
}

function str(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}
