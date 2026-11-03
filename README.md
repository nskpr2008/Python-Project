---
title: VoltBay
emoji: ⚡
colorFrom: blue
colorTo: indigo
sdk: docker
app_port: 7860
pinned: false
short_description: Electronics store with persistent carts, reviews and a Gemini shopping assistant
---

# VoltBay 2.0

An electronics store with a real backend: shoppers keep their cart between visits, see personalised recommendations, and can talk to **VoltAI**, a shopping assistant that works offline and upgrades to a real AI model when you add a key.

## Run it

1. Install **Node.js 22.5 or newer** (the backend uses the built-in `node:sqlite`). There are no npm dependencies.
2. In this folder:

   ```bash
   npm start
   ```

3. Open http://localhost:3000

Settings live in a private `.env` file next to `server.mjs` (the server loads it by itself; it is git-ignored and never served). `.env.example` is the template. Never put real keys in `.env.example`.

- **VoltAI model.** `AI_PROVIDER=gemini`, `GEMINI_API_KEY=...` and `AI_MODEL=gemini-3.5-flash-lite` (a Flash-Lite model: the cheapest tier, with the biggest free daily allowance; `gemini-2.5-flash-lite` is closed to new keys). `AI_FALLBACK_MODEL` is tried automatically if the main model is refused. Without a key the built-in offline assistant answers.
- **Usage caps, so the key is never used up.** `AI_DAILY_LIMIT` (default 200 model requests a day for the whole store) and `AI_USER_DAILY` (default 25 AI answers per shopper per day). When a cap is reached, or the provider fails, VoltAI answers from the offline assistant instead. The admin panel shows today's usage.
- **Admin account.** `ADMIN_EMAIL` and `ADMIN_PASSWORD` create (and keep in sync) the admin account. The demo values are `admin@example.com` / `12345`, which only works while `HOST=127.0.0.1`: with any other host the server refuses to start unless the password has 12 or more characters. Change it before using the site anywhere but this computer.
```bash
npm test      # 21 automated API tests (sessions, carts, recommendations, AI and the model provider, checkout and pricing, reviews, admin, security)
npm run test:e2e  # 9 browser tests: a real headless Chrome or Edge drives the page (cart, checkout, gaming page, admin gate, reviews, VoltAI, mobile); set BROWSER_PATH if no browser is found
npm run images  # re-download product photos from Wikimedia Commons (only needed if you change the catalogue)
npm run bundle  # refresh the "Project files" tab inside the page after editing source files
```

## What changed from the Phase 1 handoff

**Persistent sessions.** Every visitor gets an anonymous server-side session (a random token kept in the browser, only its hash stored in SQLite, valid 90 days and renewed on use). Cart, saved items, compare list and recently viewed products live on the server, so coming back later (even after a server restart) shows the same cart. Creating an account upgrades that session in place; signing in to an existing account merges the anonymous cart into it. The old page kept its state only in `localStorage`, and the cart was not always saved.

**Personalised recommendations** (`lib/recommend.mjs`, `GET /api/recommendations`). Built only from what the shopper actually did: views, searches (including words typed to VoltAI), saved items, compare, cart, past orders, and remembered preferences such as a budget. Recent activity counts more (two-week half-life). Scoring combines category and brand affinity, tag overlap, closeness to their usual price, complementary products for what is in the cart (for example a USB-C accessory for a USB-C phone), a stated budget as a near hard limit, and variety across categories. Every suggestion carries a reason shown on the card ("Goes with Nothing Phone (2a) in your cart"). A brand-new visitor sees staff picks, labelled as such. Out-of-stock and already-in-cart items are never suggested.

**VoltAI** (`lib/ai.mjs`).
- Offline assistant: understands budget ("under 25000"), categories, use cases (gaming, travel, student, camera…), "compare X and Y", "what goes with X", student / office / gaming setups, "recommend something for me", "my budget is 20000", "I prefer Samsung", "what is in my cart".
- Real model mode: a tool-using loop against Google Gemini (default) or the Anthropic Messages API. The tools are search, product details, compare, personalised recommendations, cart, and remembering preferences. The Gemini path was checked against a live key (tool calls and answers); the Anthropic path is only covered by the shared code and is untested live. Every model request counts against the daily caps described above, and any failure falls back to the offline assistant.
- Cart changes always need the shopper to press Confirm. Customers can now use the cart tools (in the Phase 1 build only an "assistant" profile could, and nobody could become one). Admin-only tools stay admin-only, arguments are validated, and every call is audited.
- "Account" shows what VoltAI remembers about you, with a Forget button.

**Real catalogue and photos.** The invented products (Nova X5, Pulse 12…) were replaced with 21 real, well-known products (69 with the Gaming department and the new departments: tablets and e-readers, TV and streaming, cameras, PC components, networking and appliances; monitors, networking and appliances still have only one or two products each) in the same departments, each with a summary, description, highlights and a specification table, plus a photo from Wikimedia Commons with its author and licence (shown in the product popup and under "licences and credits" in the footer; the data is in `data/image-credits.json`). Products that have no verifiable photo of an exact model (neckband earphones, GaN charger, USB-C cable, outdoor camera) are named generically and flagged "representative".
- **Prices are indicative and stock counts are demo values.** Specifications are the manufacturers' published headline figures; check them before selling.
- The fake star ratings (they were computed from the product id) were removed. Add real reviews before showing ratings again.

**Admin panel (admin sign-in only).** There is no admin menu for shoppers. Sign in with the admin account (the "Sign in" button) and an "Admin" menu appears with "Manage store" and "Project files". This is enforced on the server, not just hidden: every `/api/admin/*` route needs an admin session (anonymous gets 401, a shopper 403), and the manager code itself (`admin/panel.js`) and the source-code viewer data (`data/project-files.json`) are not public files; they are sent only to an admin. The panel works on real data: overview and revenue from stored orders, inventory (price, stock, reorder level, add a product), orders with status changes, counter billing that decrements stock and records a sale, a live audit log, and an AI control tab (model, today's usage, kill switch, per-tool switches). Price and reorder edits are kept when the catalogue file is re-read; products added in the panel are never removed by a catalogue sync; catalogue products cannot be deleted from the panel (set the stock to 0, or remove them from `data/products.json`). Repair bookings are stored on the server (customers track them with the repair ID, plus the last 4 digits of the phone from another device), and the admin updates status, estimate and notes in the Repairs tab. VoltShield and the VoltAI Command centre are simple rule-based demos that read the store data loaded in the page.

**Reviews.** Product windows show customer reviews and a star summary, and cards show stars once a product has reviews. Only a signed-in (non-guest) account that has actually bought the product can review it, once per product (posting again edits it), and the server enforces that; ratings are real averages of stored reviews (the old fake stars stay removed). Admins can remove reviews in the panel's Reviews tab.

**Smarter VoltAI.** General, impersonal questions (for example "best phone under 25000") reuse a recent model answer for three hours instead of spending quota again; anything personal or a follow-up is never cached. Cache hits are shown in the admin AI tab. VoltAI can also report order status ("where is my order"), shoppers see their orders and status in the account window, and product rows in VoltAI answers show photos.

**No doubles.** The catalogue is checked for repeated ids, names, photos and credits (none). Double clicks cannot create doubles either: the same action twice within 2 seconds is recorded once, a repeated repair booking returns the first reference, two products cannot share a name (the admin add form and the CSV import both refuse it), the checkout and booking buttons ignore a second click while the first is running, and idle guest accounts left by past visits are cleaned up when the server starts. The admin CSV import now saves to the server (before, it only changed the browser copy and was lost on reload).

**Gaming department.** 14 gaming products (consoles, controllers, VR, keyboard, mouse, headset, monitor, chair, capture adapter, graphics card, gaming laptop), each with specs and a Commons photo. They carry the tag `gaming-gear` and a `sub:` tag (for example `sub:Consoles`); the Gaming page builds its category tiles, product grid, featured product and ready-made setups (with "Add all to cart") from the live catalogue. To add gear, add it to `data/products.json` with those tags, then run `npm run images` and restart. VoltAI knows the new words (console, controller, monitor, ps5, xbox...), answers common buying questions (headset vs headphones, PS5 vs Xbox, console vs PC, wired vs wireless, 60 Hz vs 144 Hz) and builds gaming setups from the Gaming department. Four gaming items (headset, monitor, chair, keyboard photo) use representative photos and say so.

**Server-owned stock and checkout.** `POST /api/checkout` checks stock, decrements it, records the order and clears the cart in one transaction. Two shoppers cannot buy the last unit. There are still no payments; orders are pay-on-delivery demo orders.

**Security fixes and hardening**
- Emails are normalised (trimmed, lower-case) for sign-up, sign-in and the admin account (the Phase 1 README claimed this but the code did not do it).
- `.gitignore` was a single line containing literal `\n` text and ignored nothing; it is fixed.
- Sign-in throttling (8 tries per 15 minutes per address and email), registration and guest-session limits, scrypt with timing-safe comparison, session tokens stored hashed, expired sessions purged.
- Static file serving is limited to `public/` and a file-type allow-list (no path traversal, no source or database downloads); a Content-Security-Policy, `nosniff`, `X-Frame-Options` and a same-origin referrer policy on every response; CORS only for one exact configured origin; request bodies capped at 64 KB.
- Binds to `127.0.0.1` by default (`HOST` to change it).
- Customers cannot change their AI profile or reach admin routes (tested).

## Project layout

```
server.mjs            HTTP server and API routes
lib/db.mjs            SQLite schema, catalogue sync, password and token helpers
lib/recommend.mjs     recommendation engine
lib/ai.mjs            VoltAI: tools, permissions, offline assistant, model loop
public/index.html     the storefront (original design, extended)
public/app.js         glue: sessions, catalogue, recommendations, AI panel, accounts
public/assets/products/  product photos
data/products.json    catalogue (edit this, restart the server to apply; stock already in the database is kept)
data/image-credits.json  photo authors and licences
data/db_*_reference.sql  PostgreSQL design for a future migration (not executed)
scripts/              fetch-images.mjs, embed-files.mjs
tests/api.test.mjs    automated tests
```

## Known limits and next steps

- Not production-ready: no payments, shipping or email. VoltShield and the VoltAI Command demo are rule-based demos, not real fraud or AI monitoring. Orders are priced on the server (`lib/pricing.mjs`: deals, the VOLT10 coupon and add-ons); the cart preview in the page repeats the same rules, and a test keeps them equal.
- SQLite is the working database. `data/db_schema_reference.sql` is the PostgreSQL target (variants, paise prices, payments, refunds, audit); the API is already isolated behind `lib/db.mjs`, so migrating means replacing that module.
- Session tokens live in `localStorage`, so a cross-site-scripting bug would expose them; the CSP reduces that risk but the page still uses inline scripts. Moving to HttpOnly cookies plus a CSRF token, and removing inline scripts, would tighten it.
- Rate limits are in memory per process (fine for one server, not for several).
- Put the app behind HTTPS (a reverse proxy) before exposing it beyond localhost.
