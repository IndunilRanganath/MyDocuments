# MyDocuments

MyDocuments is a mobile-first app for personal document storage. Next.js App Router, TypeScript, Tailwind CSS, Supabase Auth/Postgres/private Storage, and Vercel. Inter is bundled locally. No analytics, external fonts, sample documents, or plaintext document cache.

## Run locally

Requires Node.js 22.12+ and a new Supabase project. Localhost is a secure browser context for Web Crypto; other hosts require HTTPS.

1. Open this directory and install the locked dependencies:
   ```sh
   cd MyDocuments
   npm ci
   ```
2. In Supabase **SQL Editor**, run [`supabase/migrations/001_mydocuments.sql`](supabase/migrations/001_mydocuments.sql) once. It creates the schema, bcrypt verification/lockout functions, session checks, owner policies, and the private `documents` bucket. Use a fresh project; the migration intentionally fails on conflicting existing objects. For CLI migrations, configure this directory with `supabase init`, link your project, and run `supabase db push` instead of running SQL manually.
3. In **Authentication → Sign In / Providers**, enable email/password and **disable public user signups**. MyDocuments creates internal Auth identities through the server Admin API after validating registration. Leave anonymous sign-in disabled. User-entered emails are account identifiers, not verified email addresses; there is no email-based reset or confirmation flow.
4. Copy `.env.example` to `.env.local` and fill in the values below. Generate `APP_AUTH_SECRET` using `openssl rand -hex 32` and keep it stable. Never commit `.env.local`.
5. Run `npm run dev` and visit <http://localhost:3000>. Create an account, confirm its PIN, and upload a document. Set up a recovery key in **menu → Settings** and save it outside MyDocuments.

An unconfigured app shows a setup notice. It does not substitute a local or insecure authentication implementation.

## Upgrade an existing installation after the rename

The project directory is now **MyDocuments**. Your `.env.local` moved with it; keep the same `APP_AUTH_SECRET` and Supabase project.

1. Stop the old development server.
2. In Supabase SQL Editor run [`002_mydocuments_rename.sql`](supabase/migrations/002_mydocuments_rename.sql) once. **Do not rerun migration 001 on an existing database.** This transactional upgrade renames the private schema, key/session tables, functions, constraints, and indexes in place. Existing rows, ownership, RLS dependencies, grants, and encrypted files are preserved. Fresh installations use migration 001; migration 002 is a no-op there.
3. From the parent directory, run `cd MyDocuments` and `npm run dev`. Update Vercel's Root Directory to `MyDocuments` if deployed.
4. Sign in again. Cookie and event names now use `mydocuments`. After successful credential verification, existing internal Auth identities are renamed through the Supabase Admin API while retaining their user UUID and ownership.

New encryption uses `mydocuments` context labels. The reader also accepts the original authenticated labels for existing files and key envelopes. Historical names remain only in `lib/legacy-compat.ts` and the database upgrade SQL, where they are required to identify old data. Replacing those historical bytes would make old documents unreadable. The upgrade SQL is supplied for your Supabase project; local builds do not apply remote database migrations automatically.

## Environment variables

| Variable | Where to find it / purpose | Browser? |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL, e.g. `https://abc.supabase.co` | Public |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase legacy anon API key | Public, protected by RLS |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase legacy service-role key | **Server only** |
| `APP_AUTH_SECRET` | Random 32-byte hex secret; derives opaque internal Auth passwords and anonymizes rate-limit keys | **Server only** |
| `APP_ORIGIN` | Exact app origin, no trailing slash; `http://localhost:3000` locally, `https://mydocuments.example.com` in production | Server only |

Use the anon/service-role pair from Supabase **Project Settings → API Keys → Legacy keys**. Do not put a service-role key in a `NEXT_PUBLIC_` variable. Back up `APP_AUTH_SECRET`: changing it requires rotating internal Auth passwords for existing accounts; otherwise they cannot sign in. Vercel sets `VERCEL` automatically. Rate limits trust only Vercel's overwritten `x-vercel-forwarded-for` header there; outside Vercel the application intentionally uses a shared rate-limit bucket until you configure a trusted proxy integration.

## Deploy to Vercel

1. Commit the `MyDocuments` directory and its lockfile to your Git repository. Do not commit environment files.
2. Import the repository into Vercel. Set **Root Directory** to `MyDocuments` if it is a subdirectory, and select **Next.js**. Use Node 24.x, install command `npm ci`, build command `npm run build`. No static export; API routes need the Node runtime.
3. Add all five environment variables to the intended Vercel environment. Set `APP_ORIGIN` to the exact production HTTPS hostname. Use a separate Supabase project for preview/staging; each preview needs its own matching origin. Redeploy after changing environment variables.
4. Deploy. Vercel supplies HTTPS and redirects HTTP. If you add a custom domain, update `APP_ORIGIN` and redeploy. Direct production traffic to one canonical hostname; mutations from other origins are rejected.
5. Run the live checks below against staging, then smoke-test production: signup, failed PIN attempts, upload, preview/download, rename/delete, recovery, inactivity lock, and logout. The app is prepared for deployment; no Vercel or Supabase account was provisioned by this repository.
6. On iPhone use Safari **Share → Add to Home Screen**; on Android use Chrome's **Install app**. The PWA runs standalone and supports system dark mode. Internet is required to unlock and access documents; offline navigation shows a neutral offline page.

Uploads go straight to Supabase using a scoped signed upload URL, so a 10 MB document never passes through a Vercel function body. See [Vercel function limits](https://vercel.com/docs/functions/limitations) and [Supabase private buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals).

## Folder structure

```text
MyDocuments/
├── app/
│   ├── api/[...path]/route.ts  # auth, session, documents, recovery, PIN reset
│   ├── globals.css            # mobile-first UI and automatic dark theme
│   ├── layout.tsx             # local fonts, metadata, PWA configuration
│   └── page.tsx
├── components/
│   ├── pin-pad.tsx            # keypad + accessible password input
│   └── mydocuments.tsx        # auth, grid, upload, preview, settings
├── lib/
│   ├── api.ts                 # same-origin API client; session expiry signal
│   ├── crypto.ts              # AES-GCM, PBKDF2, validation, expiry calculations
│   ├── legacy-compat.ts       # original encryption context reader
│   └── server.ts              # cookies, verified Auth sessions, guards, rate limits
├── public/
│   ├── icons/                 # SVG, 192/512 PNGs, maskable, Apple icon
│   ├── manifest.webmanifest
│   └── sw.js                  # network-only, no sensitive-data caching
├── supabase/migrations/
│   ├── 001_mydocuments.sql     # fresh install
│   └── 002_mydocuments_rename.sql # existing installation upgrade
├── tests/
│   ├── crypto.test.ts
│   ├── migration.test.ts      # local Postgres rename and RLS preservation
│   ├── rls.integration.test.ts
│   └── ui.spec.ts             # mobile + dark desktop; mocked transport
├── .env.example
├── next.config.ts
└── package-lock.json
```

## Security model

### Authentication and ownership

- PIN hashes use Postgres `pgcrypto` bcrypt, cost 12. PINs are transient request values sent over HTTPS and are never stored or logged in plaintext. The confirmation is checked in the browser and server.
- A database row lock serializes guesses per account. Five failures across PIN/recovery attempts lock the account for 15 minutes, including correct credentials during that interval. A correct login after cooldown resets the failure count. An independent database-backed limit allows 30 authentication attempts per IP per 15 minutes and five signups per IP per 15 minutes. Response text does not distinguish unknown accounts from locked accounts.
- After bcrypt verification, the server signs into an opaque Supabase Auth identity with an internal password derived from a server secret and its random user UUID. The internal email is `<uuid>@mydocuments.invalid`; the user's chosen identifier stays in a private schema. No browser gets internal passwords, Supabase access tokens, or refresh tokens.
- Auth tokens are in `httpOnly`, `SameSite=Strict`, host-only cookies with `Secure` and the `__Host-` prefix in production. Localhost development uses non-secure cookies. Mutations check exact Origin; all responses use `no-store`. Production requires an HTTPS origin. Authentication uses verified [`getUser`](https://supabase.com/docs/reference/javascript/auth-getuser), rather than trusting decoded cookie claims alone.
- Every data operation uses a user-scoped Supabase client. [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) enforces `auth.uid()` ownership and an unexpired app session for metadata, key envelopes, and [Storage objects](https://supabase.com/docs/guides/storage/security/access-control). The service-role client is used only for narrowly scoped authentication, private credential functions, and session maintenance; recovery updates explicitly use the verified current user's ID. Credential RPCs are revoked from public, anon, and authenticated roles.
- Both browser activity and server expiry enforce auto-lock. The browser clears keys, decrypted metadata, previews, and recovery secrets on lock/logout; blob URLs are revoked. Heartbeats run only in response to activity, at most every 25 seconds. Server sessions expire two minutes after their last authorized API request/heartbeat, and cannot be revived. This conservative server timer can lock slightly earlier than the UI activity timer. PIN reset invalidates all app sessions.

### Encryption

- A random 256-bit document key encrypts files and metadata (name, type, expiry, original filename, MIME) with AES-256-GCM. Each operation uses a fresh random 96-bit IV. Authenticated context binds ciphertext to its document UUID and distinguishes metadata from file bytes, preventing substitution.
- PBKDF2-HMAC-SHA-256, 600,000 iterations, and a random 128-bit salt derive a PIN wrapping key. The encrypted key envelope is versioned. Only ciphertext, salts, IVs, opaque IDs, byte lengths, and creation timestamps reach persistent storage. Keys and plaintext live in browser memory; nothing sensitive is written to localStorage, IndexedDB, or service-worker caches. Best-effort wiping of raw key bytes does not guarantee JavaScript memory erasure.
- **A six-digit PIN has only one million possibilities.** Client encryption limits casual/server-at-rest access, but a database attacker can attempt offline PIN guessing without the online rate limit. A saved recovery key prevents loss; it **does not strengthen a weak PIN wrapper**. For higher-assurance use, extend the design to require a strong password/passkey-assisted key derivation as well as the PIN before putting irreplaceable identity documents in it.
- The optional recovery key is a random 256-bit secret. It independently wraps the same document key, and its bcrypt hash is stored for online verification. Recovery logs in with that secret, unwraps the key in-browser, and prompts for a new PIN. Replacing a recovery key invalidates the previous one. There is no email recovery or administrative decryption. **Losing the PIN and recovery key loses access to the documents.**
- The application server receives PINs during login, so a malicious server/runtime could observe them or serve altered JavaScript. This implementation provides client encryption at rest, **not a zero-knowledge guarantee against an actively malicious server**. An independent security review is needed before a sensitive production rollout..

### File handling and signed URLs

- Only JPG, PNG, and PDF up to 10 MiB (10,485,760 bytes) are accepted. The client checks magic bytes and declared MIME before encryption. The encrypted payload is exactly 28 bytes larger (12-byte IV + 16-byte authentication tag). The server validates ciphertext bounds and metadata-envelope shape, creates the upload intent, then verifies the actual stored size before listing the document. The private bucket independently limits MIME to `application/octet-stream` and size to 10 MiB + 28 bytes.
- A server cannot verify the original file type while remaining unable to decrypt it. A modified client could upload arbitrary encrypted bytes to its own document collection. The original-file checks are client-side, not a malware scanner or a server-side plaintext inspection. Originals are never served from the app's origin; previews use browser blob URLs.
- Signed download URLs expire after 15 seconds and return encrypted bytes; the browser decrypts the response. An issued URL remains usable until expiry even after logout. Signed upload URLs are Supabase-scoped capabilities (normally valid for two hours), restricted to a preauthorized user/document path, with no overwrite policy. They may finish an encrypted upload after lock but cannot unlock, read, or finalize documents without a new authenticated session. Treat both URL types as secrets; do not log them.
- `ready=false` upload intents stay hidden. Failed uploads attempt cleanup; a browser crash can leave an orphan. For production, schedule a server maintenance job to remove Storage objects for upload intents older than a day, then delete those rows. Also prune expired `mydocuments_sessions` and expired `mydocuments_private.rate_limits` through a database maintenance job. Delete Storage objects through its API, not direct SQL on `storage.objects`.

### Operational limits

No offline document access, email reminders, OCR, sharing, PIN change without decrypting the key, or server-readable expiry index. Expiry badges are computed locally on calendar days for expired documents and documents expiring today through day 90. Downloaded files and recovery-key text files are deliberately plaintext exports; store them accordingly. App data is not a substitute for backups. Back up the Supabase database, private bucket, and server configuration together, and test recovery. The CSP permits inline scripts for Next.js hydration; a nonce-based CSP is a further hardening option.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

The unit tests cover PIN/recovery wrapping, wrong keys, ciphertext tampering, document-bound authenticated encryption, encrypted metadata, signature/MIME checks, the 10 MB boundary, and expiry dates. Local Postgres tests also check the database rename, row preservation, function permissions, owner RLS, idle expiry, and fresh installation. They use test-only cryptographic function stand-ins; actual Supabase bcrypt and Auth behavior require the live test. The live test is skipped unless explicitly enabled. Browser checks use Playwright with a mocked API transport, exercise real client encryption, and cover the 375px document flow, inactivity lock, signup confirmation, and a dark desktop layout:

```sh
npx playwright install chromium
npm run test:ui
```

To use an existing Chrome install, set `MYDOCUMENTS_CHROME_PATH` to its executable path instead of downloading Chromium. Browser mocks do not verify Supabase or production authentication.

Use a disposable **staging Supabase project** with the migration installed for the integration test. It creates two temporary Auth users and removes their test objects/accounts in `finally`. Load `.env.local` without printing credentials:

```sh
MYDOCUMENTS_RUN_INTEGRATION=true node --env-file=.env.local --import tsx --test tests/rls.integration.test.ts
```

That test checks concurrent five-attempt lockout, cross-user metadata/Storage denial, anonymous Storage denial, and expiry denial at the RLS layer. Manually verify the 15-minute unlock and exercise recovery/PIN reset in staging as well.

Manual acceptance:

1. At 375px and desktop widths, create two accounts, upload JPG/PNG/PDF, choose the camera on a phone, rename and download each, then delete one.
2. Use an expiry of today, +90 days, +91 days, and yesterday; check the badges and filter.
3. Fail a PIN five times; confirm correct PIN and recovery key cannot log in for 15 minutes. Confirm another account remains usable.
4. Leave MyDocuments untouched for two minutes and suspend/resume its tab; confirm content clears and data API calls are rejected. Logout, then use browser Back.
5. Create/save a recovery key, log out, recover, reset PIN, and unlock the existing files with the new PIN. Check the old PIN and all prior app sessions fail. Replace the key and check the old recovery key fails.
6. In browser storage tools, confirm no plaintext, keys, document metadata, or Auth tokens are in localStorage/IndexedDB/cache storage. Inspect httpOnly/Secure/SameSite cookie flags in production.
7. Test iOS/Android standalone installation, dark mode, keyboard navigation, and a screen reader. Check PDFs on the actual target devices; mobile PDF viewers may offer Download instead of a multipage inline view.
