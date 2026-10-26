# AizenTrading V2

New project bundle: bilingual Telegram Mini App (IT/EN), API backend, Telegram `/start` launcher, user profile/activity, persistent request queue and restricted admin dashboard.

## Important architecture notes
- The token of your own existing Telegram bot is reused by setting `TELEGRAM_BOT_TOKEN` privately in Render. Never put it in frontend files or commit it to GitHub. Configure that bot’s public username in `public/config.js`.
- This app does not invent profits or balances. Pending deposits do not affect the balance. An admin credits a deposit only after checking the transaction on the correct blockchain explorer.
- Withdrawal requests reserve the user's available balance. An admin marks them `paid` only after manually completing the transfer. This starter version does not sign or broadcast blockchain transactions and does not automatically watch on-chain deposits.
- Configure actual deposit addresses only after confirming wallet ownership and network. Never ask customers for seed phrases or private keys.
- Consult applicable legal/compliance requirements before taking customer deposits or offering investment services.

## Quick deploy overview
1. Create a **new private or public GitHub repository** named `aizentrading-v2`, and upload the contents of this directory (contents, not the parent folder).
2. In the GitHub repository, go to **Settings → Pages**, choose **GitHub Actions**, and use the workflow included at `.github/workflows/pages.yml`.
3. In Render, create a new **Web Service** connected to the repo. Set **Root Directory** to `backend`, **Build Command** to `npm install`, **Start Command** to `npm start`.
4. Add Render environment variables listed in `backend/.env.example`. Set `FRONTEND_ORIGIN` to the GitHub Pages **origin only**, e.g. `https://USERNAME.github.io` (no path). Set `MINI_APP_URL` to the full published site URL, e.g. `https://USERNAME.github.io/aizentrading-v2/`.
5. After Render gives the service URL, edit `public/config.js` and replace `https://REPLACE-WITH-RENDER-SERVICE.onrender.com` with that URL. Commit the change. Wait for Pages to deploy.
6. Once backend and Pages are live, open BotFather from Telegram and configure the same bot's Mini App URL / menu button to the new HTTPS Pages URL. The backend polling bot will also answer `/start` with a launch button.
7. Add your own numeric Telegram user ID to `ADMIN_TELEGRAM_IDS` in Render. Separate IDs with commas. Restart the service.

## Environment variables
See `backend/.env.example`. Render's filesystem is ephemeral unless a persistent disk is attached. For persistent request records, attach a Render disk (e.g. mounted at `/var/data`) and set `DATABASE_PATH=/var/data/aizen-store.json`.

## Admin
Open `admin.html` *inside Telegram* using the admin launch button sent by `/admin`, or from the configured Mini App URL. The API rejects users whose numeric Telegram IDs are not in `ADMIN_TELEGRAM_IDS`. The admin page is a client UI; authorization is enforced again by the backend for each admin API call.

## Included features
- IT/EN language switch
- Animated backend status indicator
- Aizen Academy: blockchain, wallet, transaction, network and safety explainers
- Feature-focused Starter/Bronze/Silver/Gold/Platinum/Diamond/Royal plans (not promised returns)
- Deposit request submission with transaction hash and admin verification
- Withdrawal requests, balance reservation and admin paid/rejected workflow
- User profile, balances by asset, transaction history
- Basic append-only admin audit log

## Earnings / calculator
The prior screenshots are inconsistent: the calculator screenshot shows 0.0% and $0.00, while the plans screenshot displays daily percentages. No rates are invented in this bundle and there is no automatic hourly balance growth. Configure the calculator only from documented, actual plan terms; a projection is not a ledger credit.

## Test after deployment
- `GET /health` returns `{ "ok": true }`
- Open the Mini App from Telegram, not a regular browser (Telegram initData is required)
- Submit a test deposit request with a transaction hash; confirm it appears in admin review
- Verify non-admin users get HTTP 403 from `/api/admin/*`
- Test withdrawal reservation and rejection refund using a test user and test values before allowing any real funds
