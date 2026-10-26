# AizenTrading V2 — istruzioni semplici

Questa cartella contiene il nuovo Mini App, il backend e il pannello amministratore. Il codice è separato dal vecchio progetto.

## 1. Crea il nuovo GitHub
1. Apri GitHub e premi **New repository**.
2. Nome: `aizentrading-v2`.
3. Seleziona **Public** se vuoi usare GitHub Pages nel piano gratuito; non ci sono token o chiavi inserite nei file.
4. Crea il repository e carica i contenuti di questa cartella nella radice del repository (non caricare la cartella padre come un'unica sottocartella).

## 2. Attiva GitHub Pages
1. Apri il nuovo repository → **Settings → Pages**.
2. In **Build and deployment**, scegli **GitHub Actions**.
3. Apri **Actions** e attendi che il workflow “Deploy AizenTrading Mini App” diventi verde.
4. L'indirizzo sarà simile a `https://TUO-USERNAME.github.io/aizentrading-v2/`.

## 3. Crea il nuovo backend su Render
1. Apri Render → **New → Web Service** e collega il nuovo repository.
2. Impostazioni: **Root Directory** `backend`; **Build Command** `npm install`; **Start Command** `npm start`.
3. In **Environment**, imposta almeno:
   - `TELEGRAM_BOT_TOKEN` = token del tuo bot esistente (solo in Render, mai nei file e mai in chat).
   - `ADMIN_TELEGRAM_IDS` = il tuo ID numerico Telegram.
   - `FRONTEND_ORIGIN` = `https://TUO-USERNAME.github.io` (senza percorso finale).
   - `MINI_APP_URL` = `https://TUO-USERNAME.github.io/aizentrading-v2/`.
   - `DEPOSIT_ADDRESS_USDC_ETH` = indirizzo wallet controllato da te, compatibile con USDC su Ethereum/ERC-20.
   - `DATABASE_PATH` = `/var/data/aizen-store.json` se aggiungi un disco persistente montato su `/var/data`.
4. Aggiungi un disco persistente su Render se il tuo piano lo permette. Senza disco, i dati su filesystem possono andare persi nei riavvii o nei nuovi deploy.
5. Copia l'URL pubblico del backend Render, ad esempio `https://nome-servizio.onrender.com`.

## 4. Collega frontend e bot
1. Nel repository GitHub, modifica `public/config.js`:
   - sostituisci `https://REPLACE-WITH-RENDER-SERVICE.onrender.com` con il vero URL Render;
   - sostituisci `REPLACE-WITH-YOUR-BOT-USERNAME` con lo username reale del tuo bot, senza `@`.
2. Salva con **Commit changes** e attendi che GitHub Actions ridistribuisca la pagina.
3. In BotFather, imposta la stessa URL GitHub Pages come Web App/menu button del tuo bot.
4. Prima di avviare il nuovo servizio bot, arresta eventuali vecchie istanze che usano lo stesso token, per evitare conflitti di polling.
5. Apri il tuo bot su Telegram e invia `/start`. Dovresti ricevere il pulsante per aprire la Mini App. Invia `/admin` per aprire il pannello admin.

## 5. Depositi, prelievi e sicurezza
- Il deposito minimo server-side è **50 USDC**; in questa versione i depositi sono limitati a USDC su Ethereum ERC-20 per non usare quotazioni USD non verificate per altri asset.
- Il pannello admin mostra le richieste. Prima di approvare, verifica manualmente il TXID, rete, indirizzo, importo e conferme sull'explorer corretto.
- Una richiesta di prelievo riserva il saldo. Segnala la richiesta come pagata solo dopo aver eseguito il trasferimento reale.
- Non chiedere né raccogliere seed phrase o chiavi private. Configura esclusivamente indirizzi wallet di cui controlli la proprietà.

## 6. Importante sulla calcolatrice
Nelle schermate esistenti la calcolatrice mostra **0,0% e $0,00**, mentre un'altra schermata di piani visualizza percentuali giornaliere diverse. Per questo non sono stati impostati tassi arbitrari e il saldo non cresce automaticamente ogni ora: la calcolatrice può mostrare una proiezione solo dopo che i parametri effettivi sono stati determinati e documentati. Una proiezione non viene mai registrata come denaro reale.

Questo è un progetto iniziale funzionale per interfaccia, sessione Telegram, richieste e revisione admin. Prima di accettare fondi reali, integra e testa una verifica blockchain automatica, un ledger contabile robusto, gli effettivi pagamenti e le procedure legali/compliance applicabili.
