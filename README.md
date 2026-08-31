# che canzone

Agente musicale per iPhone. Detti (col microfono della tastiera iOS) un frammento di
titolo, un verso mal ricordato o una descrizione vaga di una canzone sentita alla
radio; l'app propone **3 candidati**, e scelto quello giusto mostra **copertina**,
**titolo/artista ufficiali**, **testo completo** e **3-4 curiosità**. Ogni ricerca
finisce in un database consultabile dalla scheda **Storico**.

- **App:** `https://stefanoserafin.github.io/che-canzone/` — single-file `index.html`, GitHub Pages.
- **Backend:** Cloudflare Worker `che-canzone-api.serafin-stefano72.workers.dev` + database D1 `che-canzone`.
- **Repo:** `stefanoserafin/che-canzone` (pubblico — nessun segreto nel codice).

---

## Attivazione (una volta, sull'iPhone)

1. Apri `https://stefanoserafin.github.io/che-canzone/` in Safari.
2. Si apre la schermata **Impostazioni**: nel campo **Chiave app** incolla il valore
   del secret `APP_KEY` del Worker (te lo ha dato Claude in fase di setup; se lo hai
   perso vedi "Rigenerare APP_KEY" sotto) → **Salva**.
3. **Condividi → Aggiungi a Home** per l'icona a tutto schermo.

L'URL del Worker è già dentro `index.html`, non serve toccarlo.

---

## Architettura

```
iPhone (Safari / icona Home)                  Cloudflare Worker              Servizi
┌───────────────────────────┐   fetch POST     ┌────────────────────┐
│ index.html (un file solo) │ ───────────────► │ /identify          │ ─► api.anthropic.com (Haiku 4.5)
│  textarea + dettatura iOS  │ ◄─────────────── │ /details           │ ─► lrclib.net (testi, no key)
│  3 card candidati          │   JSON + CORS    │ /history           │
│  schermata risultato       │                  │  + INSERT su D1     │
│  schermata Storico         │                  └────────┬───────────┘
└──────────┬────────────────┘                            │ binding "DB"
           │ JSONP diretto (callback param)     ┌────────▼───────────┐
           └──────────────────────────────────► │ Cloudflare D1       │  tabella "lookups"
             itunes.apple.com/search            └────────────────────┘
             (copertina + dati ufficiali)
```

**Perché iTunes è chiamato dal browser e non dal Worker:** Apple rate-limita in modo
aggressivo l'intero pool di IP dei Cloudflare Workers (risposta `429 "Rate limit has
been exceeded for: itunes-apple-com"`). Chiamato via JSONP dal telefono parte
dall'IP di casa e funziona. L'app passa `year`/`album` ricavati da iTunes a
`/details`, così finiscono anche nello storico.

`lrclib.net` invece dal Worker va bene (nessun rate-limit sul pool).

### Endpoint del Worker

| Metodo | Path | Body / query | Risposta |
| --- | --- | --- | --- |
| POST | `/identify` | `{q}` | `{candidates:[{title,artist,year,why}]}` (max 3, o `[]`) |
| POST | `/details` | `{title,artist,query?,year?,album?}` | `{facts:[...],lyrics,lyricsSource}` |
| GET | `/history` | `?limit=50&q=` | `{rows:[{ts,query,title,artist,year,album}]}` |

Tutti richiedono l'header `X-App-Key: <APP_KEY>`. Tetto giornaliero: variabile
`DAILY_CAP` (200), contata sulle righe inserite in `lookups` (ricerche completate).

---

## Manutenzione

### Aggiornare il Worker

Modifica `worker/worker.js`, poi:

```sh
export CLOUDFLARE_API_TOKEN=<un token con Workers Scripts:Edit + D1:Edit>
npx wrangler@4 deploy
```

Oppure dalla dashboard: **Workers & Pages → che-canzone-api → Edit Code**,
incolla il file, **Deploy**.

### Aggiornare lo schema del DB

```sh
npx wrangler@4 d1 execute che-canzone --remote --file worker/schema.sql
```

### Cambiare il tetto giornaliero

`DAILY_CAP` in [`wrangler.toml`](wrangler.toml) → `npx wrangler@4 deploy`.
(oppure dashboard → Worker → Settings → Variables.)

### Cambiare modello o aggiungere ricerca web

Si tocca solo `worker/worker.js`: costante `MODEL` e funzione `anthropic()`.

### Rigenerare APP_KEY

```sh
# scegli una stringa lunga a caso, poi:
printf '%s' 'NUOVA_CHIAVE' | npx wrangler@4 secret put APP_KEY
```

Poi reinseriscila nell'app (Impostazioni).

### Svuotare lo storico

```sh
npx wrangler@4 d1 execute che-canzone --remote --command "DELETE FROM lookups;"
```

---

## Da zero (se un giorno serve ricreare tutto)

1. Account Cloudflare (gratis, no carta) → `dash.cloudflare.com`.
2. API token: **My Profile → API Tokens → Create Custom Token** con permessi
   *Account · Workers Scripts · Edit*, *Account · D1 · Edit*, *Account · Account Settings · Read*.
3. `export CLOUDFLARE_API_TOKEN=...`
4. `npx wrangler@4 d1 create che-canzone` → copia il `database_id` in `wrangler.toml`.
5. `npx wrangler@4 d1 execute che-canzone --remote --file worker/schema.sql`
6. `printf '%s' '<chiave anthropic>' | npx wrangler@4 secret put ANTHROPIC_API_KEY`
7. `printf '%s' '<app key>' | npx wrangler@4 secret put APP_KEY`
8. `npx wrangler@4 deploy` → prendi l'URL `*.workers.dev` e mettilo in
   `index.html` (`DEFAULT_WORKER_URL`), commit + push.
9. GitHub → **Settings → Pages → Deploy from branch → main / root**.

---

## Costi

- **Cloudflare** Workers + D1: tier gratuito (100k richieste/giorno, 5 GB). Sovrabbondante.
- **Anthropic** Claude Haiku 4.5: < 0,5 cent a ricerca completa. Con `DAILY_CAP = 200`
  il tetto di spesa è pochi centesimi/giorno nel caso peggiore.

## Limiti noti

- Serve connessione a internet per cercare. Offline si rileggono solo gli ultimi
  ~20 risultati salvati sul telefono.
- **LRCLIB** è un database community: può non avere il testo di brani italiani di
  nicchia o molto recenti → l'app mostra un link di ricerca a Genius.
- Le curiosità dipendono dalla conoscenza del modello (nessuna ricerca web): su
  uscite recentissime o dettagli di classifica possono esserci imprecisioni.
- L'endpoint del Worker è pubblico: `X-App-Key` + tetto giornaliero fermano l'abuso
  casuale, non un attacco mirato. Nessun dato personale è in gioco.
- Se Apple cambia politica, la copertina può sparire: l'app continua a funzionare
  con titolo/artista del candidato e un placeholder.
