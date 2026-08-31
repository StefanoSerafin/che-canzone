# che canzone

Agente musicale per iPhone. Detti (col microfono della tastiera iOS) un frammento di
titolo, un verso mal ricordato o una descrizione vaga di una canzone sentita alla
radio; l'app propone **3 candidati**, e scelto quello giusto mostra **copertina**,
**titolo/artista ufficiali**, **testo completo** e **3-4 curiosità**. Ogni ricerca
finisce in un database consultabile dalla scheda **Storico**.

App: single-file `index.html` su GitHub Pages · Backend: un Cloudflare Worker + D1.

---

## Architettura

```
iPhone (Safari / icona Home)                  Cloudflare Worker              Servizi esterni
┌───────────────────────────┐  fetch POST/GET  ┌────────────────────┐
│ index.html (un file solo) │ ───────────────► │ /identify          │ ─► api.anthropic.com (Haiku 4.5)
│  textarea + dettatura iOS  │ ◄─────────────── │ /details           │ ─► lrclib.net  (testi, no key)
│  3 card candidati          │   JSON + CORS    │ /history           │ ─► itunes.apple.com (copertina)
│  schermata risultato       │                  │  + INSERT su D1    │
│  schermata Storico         │                  └────────┬───────────┘
└───────────────────────────┘                            │ binding "DB"
                                                 ┌────────▼───────────┐
                                                 │ Cloudflare D1       │  tabella "lookups"
                                                 │ (SQLite)            │
                                                 └────────────────────┘
```

Il frontend parla **solo** col Worker (un formato, `fetch` normale con header CORS).
iTunes e LRCLIB sono chiamati lato Worker perché iTunes non manda header CORS.

---

## Setup Cloudflare — passo per passo

Serve solo un browser. Wrangler / Node **non** sono necessari (vedi in fondo per
l'alternativa da CLI).

### 1. Account

- Crea un account gratuito su [cloudflare.com](https://dash.cloudflare.com/sign-up).

### 2. Crea il Worker

- Dashboard → **Workers & Pages** → **Create** → scheda **Workers** → **Create Worker**.
- Nome: `che-canzone-api`. **Deploy** (per ora il template di default).
- Annota l'URL che compare: `https://che-canzone-api.<tuo-sottodominio>.workers.dev`.

### 3. Crea il database D1

- Dashboard → **Storage & Databases** → **D1 SQL Database** → **Create**.
- Nome: `che-canzone`. Crea.
- Apri il database → scheda **Console** → incolla e **Run** tutto il contenuto di
  [`worker/schema.sql`](worker/schema.sql).

### 4. Collega il database al Worker

- Torna al Worker `che-canzone-api` → **Settings** → **Bindings** → **Add** →
  **D1 database**.
- Variable name: `DB` · D1 database: `che-canzone`. Salva.

### 5. Secret e variabili

Worker → **Settings** → **Variables and Secrets** → **Add**:

| Tipo    | Nome                | Valore |
| ------- | ------------------- | ------ |
| Secret  | `ANTHROPIC_API_KEY` | la tua chiave API Anthropic (`sk-ant-…`) |
| Secret  | `APP_KEY`           | inventane una lunga e casuale (es. 24 caratteri) — la incollerai anche nell'app |
| Text    | `DAILY_CAP`         | `200` |

### 6. Incolla il codice del Worker

- Worker → **Edit Code** → cancella tutto → incolla il contenuto di
  [`worker/worker.js`](worker/worker.js) → **Deploy**.

### 7. Test rapido

```sh
curl -X POST https://che-canzone-api.<tuo-sottodominio>.workers.dev/identify \
  -H "X-App-Key: <IL_TUO_APP_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"q":"blinding lights"}'
```

Ti deve tornare un JSON con `candidates`.

---

## Collega l'app

1. In [`index.html`](index.html) trova la riga
   `var DEFAULT_WORKER_URL = "https://che-canzone-api.CHANGEME.workers.dev";`
   e metti l'URL reale del tuo Worker. `git commit` + `git push`.
2. Su GitHub: **Settings → Pages → Deploy from branch → `main` / root**.
   L'app è su `https://stefanoserafin.github.io/che-canzone/`.
3. Prima apertura su iPhone Safari: si apre nelle **Impostazioni** — incolla
   l'`APP_KEY` (e, se serve, l'URL del Worker) → **Salva**.
   La chiave resta solo su quel telefono (`localStorage`), mai nel sorgente.
4. **Condividi → Aggiungi a Home** per l'icona a tutto schermo.

---

## Manutenzione

- **Aggiornare il Worker**: modifica `worker/worker.js` nel repo → copia-incolla
  nell'editor della dashboard (**Edit Code**) → **Deploy**. Nessun deploy
  automatico: è voluto, il codice cambia raramente.
- **Aggiornare lo schema**: esegui il nuovo SQL nella **Console** del database D1.
- **Cambiare il tetto giornaliero**: modifica la variabile `DAILY_CAP` nelle
  impostazioni del Worker.
- **Cambiare motore/modello o aggiungere la ricerca web**: si tocca solo
  `worker/worker.js` (costante `MODEL` e il corpo di `anthropic()`).

### Alternativa: deploy da CLI (Wrangler)

Richiede Node sul Mac.

```sh
npm i -g wrangler
wrangler login
# crea wrangler.toml con: name, main = "worker/worker.js",
#   compatibility_date, [[d1_databases]] binding = "DB"
wrangler d1 execute che-canzone --remote --file worker/schema.sql
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put APP_KEY
wrangler deploy
```

---

## Costi

- **Cloudflare** Workers + D1: tier gratuito (100k richieste/giorno, 5 GB) —
  ampiamente sufficiente per uso personale.
- **Anthropic** Claude Haiku 4.5: meno di 0,5 cent a ricerca completa
  (identify + details). Con `DAILY_CAP = 200` il tetto di spesa è pochi
  centesimi al giorno nel caso peggiore.

## Limiti noti

- Serve sempre connessione a internet per cercare. Offline si rileggono solo gli
  ultimi ~20 risultati salvati sul telefono.
- **LRCLIB** è un database community: può non avere il testo di brani italiani di
  nicchia o molto recenti. In quel caso l'app mostra un link di ricerca a Genius.
- Le curiosità dipendono dalla conoscenza del modello (nessuna ricerca web): su
  uscite recentissime o dettagli di classifica possono esserci imprecisioni.
- L'endpoint del Worker è pubblico: l'header `X-App-Key` + il tetto giornaliero
  fermano l'abuso casuale, non un attacco mirato. Nessun dato personale è in gioco.
