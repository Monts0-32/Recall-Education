# Security architecture

This document describes how Recall Education protects the data of UK secondary school students (Year 7–13) and their parents. It is the architecture that the eventual production system must follow. Where the static pages in this repo collect data, this document is the contract for how that data is stored, transmitted, and destroyed.

It is opinionated. Choices are made; reasons are one sentence away. If you want to change a choice, change it here first, then change the code.

Version: 1.1
Last updated: 2026-07-01
Owner: Engineering
Status: Draft, pre-implementation, free-tier architecture

> **Note on v1.1 — free-tier architecture.** This version of the document describes how the architecture is realised at launch under a **zero-budget constraint**. The data-protection goal is the same as v1.0; the *primitives* are different because there is no money for managed services. The KMS is HashiCorp Vault on the same VM instead of AWS KMS. The hosting is Oracle Cloud Always Free (US region) instead of `eu-west-2` ECS on Fargate. The backups go to Backblaze B2 (US) instead of S3. The email is Mailgun Flex (US) instead of Postmark EU. Every deviation is called out as a numbered risk in the section it appears, and the **migration plan in the appendix to section 10** lists the swaps back to managed services in dependency order, triggered by the first paid plan. The hard commitment is in section 1.10: on the first paid plan, the primary database, the KMS, the backup bucket, the email service, the error tracker, and the monitoring service all move to a UK or EU region. That migration is a pre-launch requirement of the paid tier, not a follow-up.

---

## 1. Scope and stack

Recall is a multi-subject online learning platform for UK secondary students. The data it holds is the data of minors and their parents. The architecture must hold up to an ICO investigation and to a parent reading the breach notification.

Stack:

- **Backend**: Node.js 22 LTS, TypeScript, Fastify as the HTTP framework. Fastify is chosen over Hono for the plugin ecosystem (`@fastify/cookie`, `@fastify/csrf-protection`, `@fastify/rate-limit`, `@fastify/helmet`, JSON Schema validation built in). Hono is a fine alternative; the security properties in this document do not change.
- **Database**: Postgres 16 in Docker on the host. Row-level security, pgcrypto for column-level helpers, and the `pgcrypto` and `uuid-ossp` extensions on.
- **ORM**: Drizzle. It produces parameterised SQL by default, the query builder is auditable, and there is no string interpolation magic. Drizzle's `sql` template tag parameterises correctly; this document forbids `sql.raw()` outright, and code review must treat any use of `sql` as a flagged change.
- **KMS (v1.1 free tier)**: HashiCorp Vault, file-backed storage mode, on the same VM. Provides: (1) a `transit` key named `cmk` for envelope encryption, AES-256-GCM, auto-rotation at 90 days; (2) a `transit` key named `email-hmac` (type `hmac-sha2-256`) for the email-lookup index; (3) a `kv v2` secret at `secret/data/pepper` for the password pepper, read at boot and refreshed every 15 minutes; (4) the `database` secrets engine for dynamic Postgres credentials on a 1-hour TTL; (5) a `transit` key named `backup-key` for backup encryption. The Vault data file lives at `/var/lib/vault/data`, sealed at rest, unsealed on boot from a key stored in 1Password (with a paper backup on an offline USB in a fireproof safe). The application's `kmsClient.encrypt/decrypt/hmac` interface is identical to the v1.0 design; only the implementation changes. **Risks**: R1 (same-disk compromise — root on the VM reads the Vault data file and the Postgres data directory; column-level encryption is the floor); R2 (unseal-key-in-1Password is a single point of failure for VM reboots); R3 (Vault adds 100–200 MB RAM — fine on the 24 GB Ampere A1, not fine on the 1 GB x86 fallback); R4 (no FIPS 140-2 — Vault is software-only). **Upgrade path** (section 10): export the Vault `transit` keys in wrapped form, re-wrap with an AWS KMS CMK, import to AWS KMS in `eu-west-2`; `*_encrypted` columns are not re-encrypted. See section 10 for the full migration sequence.
- **Hosting (v1.1 free tier)**: a single Oracle Cloud Always Free **Ampere A1** VM, 4 OCPUs, 24 GB RAM, Ubuntu 22.04, in a US region (EU region is also free but US is the default for now). The VM runs four Docker containers — nginx, node (Fastify), postgres, vault — plus host-level ufw and fail2ban. TLS 1.3 is terminated at the Cloudflare free edge, re-established to the origin with a 15-year Cloudflare Origin Certificate. The `ufw` rule on the host allows 443/tcp from Cloudflare IP ranges only; a direct probe to the origin IP gets a TCP RST. No SOC 2 is available on the free tier; the threat model accepts that the OCI standard DPA is the legal floor until the paid tier. **Risk**: R7 (single-VM blast radius — root on the box owns Postgres, Vault, and the app; mitigated by column-level encryption, encrypted backups, fail2ban, and Cloudflare in front). **Upgrade path**: provision AWS ECS on Fargate in `eu-west-2`, cut over, decommission the Oracle VM.
- **Background jobs (v1.1 free tier)**: `pg-boss`, a Postgres-backed queue that runs in-process with the node container. No separate worker host. **Upgrade path**: a dedicated worker container in `eu-west-2` on the paid tier.
- **Front end**: static assets served from a CDN. The static pages in this repo are previews of the eventual marketing surface; the dashboard and signup will move to the same Next.js or SvelteKit app that the API serves.

### 1.10 Data residency commitment (v1.1)

The primary VM, the Postgres data, the Vault data file, the Backblaze B2 backup bucket, the Mailgun email service, the UptimeRobot monitor, and the Cloudflare edge logs are all in the **United States** on the free tier. This is a deliberate, time-boxed concession to budget reality. The data is children's PII.

The hard commitment is: on the first paid plan, the VM, the database, the KMS, the backup bucket, the email service, the error tracker, and the monitoring service all move to a **UK or EU region**. The migration is a **pre-launch requirement of the paid tier**, not a follow-up. Until then, this is documented in the privacy notice and in the data-processing agreement at `/legal/data-protection` and `/legal/dpa.pdf`. Parents are informed at signup that data is processed in the US, with the migration commitment as the remedy.

Justifications are short on purpose. If a future engineer wants to swap Fastify for Hono, Postgres for MySQL, or London for Frankfurt, they update this document, get a sign-off from the security owner, and then change the code.

## 2. Threat model

The attackers we plan against are the attackers we will actually see. The threats are ordered roughly by likelihood for a UK consumer education product.

- **Opportunistic scanners** hitting `/.env`, `/.git`, `/wp-admin`, common CVE paths, looking for exposed debug endpoints. They get nothing because the app does not run PHP, the build artefact is a single Node process behind a reverse proxy, and the **Cloudflare free WAF** drops them at the edge. The free plan ships 5 custom rules; the budget is: (1) per-IP rate limit, (2) bot-score challenge, (3) known-bad user agents, (4) geo-allowlist UK, (5) a reserved "breach response" rule that the on-call can flip to a strict challenge during an incident. The Cloudflare Pro managed-OWASP-Top-10 ruleset is a paid-tier upgrade; until then, the OWASP Top 10 is mitigated at the application level.
- **Credential stuffers** with breached email/password lists. Mitigated by rate limiting, breached-password rejection on signup and password change, and per-account backoff on failed logins.
- **Scrapers** harvesting the marketing pages and the free-tier content. Mitigated with rate limits, `robots.txt`, `noindex` on draft routes, and a Cloudflare Turnstile (or hCaptcha) challenge on the marketing email-capture form. Paying content is gated; the only public PII is the marketing email-capture list.
- **Malicious students** on a shared school network trying to access another student's account, or a teacher trying to access a student's data without consent. Mitigated with TLS 1.3, `SameSite=strict` cookies, per-user session tokens, and authorisation checks on every endpoint.
- **Malicious parents** in a custodial dispute trying to access the other parent's data, or to delete a child against the other parent's wishes. Mitigated with the under-16 parental-consent flow, a verified-parent gating model for data export and erasure, and a documented escalation process for disputed access.
- **Insider threats** (employee abuse of data access). Mitigated with least-privilege IAM, query-level audit logs, no direct production database access (**on the free tier there is no read replica; engineers query through `psql` with their own dynamic Vault credential, which is logged in `audit_log` with the query text**, and the credential is rotated automatically by Vault on a 1-hour TTL), quarterly access reviews, and a "no raw DB access in production" rule.
- **Opportunistic DB dumps from misconfig**. This is the realistic nightmare: a misconfigured S3 bucket, a debug endpoint exposing the ORM, a leaked backup, a snapshot shared with the wrong team. Mitigated by column-level encryption for sensitive fields, encrypted backups with separate keys, no `SELECT *` from any production endpoint, CI rules that block known bad patterns, and a "no PII in any log or backup that isn't itself encrypted" rule.

Assets protected:

- Account credentials (email + password).
- PII: name, email, date of birth, year group, school (when added), parent email, exam board choices.
- Exam progress data: subject enrolments, lesson completions, test scores, streak data.
- Payment data (when payments are added). Out of scope for this version; will use Stripe and stay PCI-DSS out of scope.
- Marketing email-capture list.

Realistic impact of a breach. A dump of children's names, dates of birth, and parent emails is a notifiable incident under UK GDPR. The ICO will want to see the controls in this document, the evidence that they were operating on the day of the breach, and the timeline of the response. Reputational and commercial damage is total if a children's data dump happens. Most of the controls in this document are about making that scenario survivable.

## 3. Legal and regulatory baseline

The legal floor for this product:

- **UK GDPR and the Data Protection Act 2018**. Lawful basis for most processing is **consent** for the under-16 group (with parental consent where required) and **contract** for the paying relationship. Legitimate interest is not a clean fit for minors' data and is not relied on for marketing to students. For the parent email-capture list, consent is also the basis (PECR soft opt-in does not apply to children).
- **ICO Age-Appropriate Design Code (the Children's Code)**. The fifteen standards apply because the service is "likely to be accessed by children." The ones that bite hardest:
  - Best interests of the child is a primary consideration.
  - DPIA completed before launch.
  - Default-high privacy settings.
  - No behavioural profiling of minors.
  - No nudge techniques that lead minors to provide more data than necessary.
  - No use of personal data in ways that are "obviously detrimental to children's wellbeing."
  - Geolocation off by default.
  - No parental-control mechanisms that incentivise surveillance.
  - A clear, prominent reporting mechanism for safeguarding concerns, answered by a human.
- **Parental consent for under-13s (UK GDPR Article 8)**. The digital consent age in the UK is 13. For under-13s, hold **verifiable parental consent** before account activation. For 13–15s, the safer interpretation of the Children's Code is also to hold parental consent; "legitimate interest" on minors is hard to defend at the ICO. The signup flow therefore collects a parent email for **under-16s** and sends a one-time consent link that the parent must click before the account activates. For 16–17s, consent is the student's own. For 18+, no parental step. The age boundaries are not a privacy-by-policy choice; they are the conservative reading of the regulation.
- **Keeping Children Safe in Education (KCSiE)**. If a school or sixth form signs up, the school becomes the data controller for its own students' data and Recall acts as **processor**. A Data Processing Agreement is required, with: purpose limitation, sub-processor list, breach notification SLA (24 hours), audit rights, return/destruction of data on contract end, and an explicit statement on KCSiE obligations. The DPA template is held in `/legal/dpa.pdf` and is reviewed annually.
- **PECR** for marketing emails. Soft opt-in is not enough on its own; the first marketing email must contain a working unsubscribe, a real identity, and the ICO-registered address. Transactional emails (password reset, email verification, parent consent, payment receipts) are exempt under PECR.
- **ICO registration**. Registration is filed before any personal data is processed. The fee is £40/year for small organisations (under 10 staff and under £632k turnover). The registration number is filed in section 12 of this document and at `/legal/data-protection`.
- **KCSiE and school contracts (v1.1 free-tier note)**. On the free tier, **no school contracts are signed**. The DPA template at `/legal/dpa.pdf` is finalised and published, but the "processor" role is not activated until a school contract is in place. The published sub-processor list at `/legal/sub-processors` reflects the free-tier stack (Oracle US, Backblaze B2 US, Cloudflare global, Mailgun US, Sentry EU, UptimeRobot US, hCaptcha EU, GitHub US, 1Password US). When the first school contract is signed, the sub-processor list is reviewed against that school's data-residency requirements, and the migration to UK/EU is a precondition of the school contract going live.

The point of listing these instruments is not to satisfy "GDPR compliance theatre." It is to fix the design constraints. UK GDPR Article 8 forces the under-16 parent step. The Children's Code forces the default-high privacy settings and the no-profiling rule. KCSiE forces the DPA template. PECR forces the unsubscribe. These are not options.

## 4. Auth and password handling

### Password hash

- **Argon2id**. Not bcrypt (GPU-friendlier, 72-byte input limit, less tunable). Not PBKDF2 (not memory-hard, which is the point of a modern password hash).
- Parameters: `m=64MiB, t=3, p=4`, 16-byte salt per user (built into Argon2id's PHC string), 32-byte output. These are the OWASP 2024-recommended starting values. Re-evaluate annually and whenever the server fleet changes.
- **Pepper (v1.1 free tier)**: a 32-byte secret loaded from **Vault's `kv v2` secret at `secret/data/pepper`** at boot, refreshed every 15 minutes, held in process memory only and never written to disk in the app layer. The pepper is prepended to the password before hashing. A database dump alone cannot crack passwords; the attacker also needs the Vault-managed pepper. Rotate the pepper quarterly via `vault kv put secret/pepper value=...` followed by a rolling deploy, with a dual-write window where new passwords are hashed with both the old and new pepper, and old passwords are re-hashed on next successful login. **Risk**: R1 (same-disk compromise — the Vault data file is on the same block volume as Postgres). **Upgrade path**: Vault → AWS KMS in `eu-west-2` on the first paid plan.

### Password policy (NIST 800-63B)

- Minimum length **12**. 12 is the floor; the UI nudges toward 16+. There are no composition rules (no "must contain a number, a capital, and a symbol"). Composition rules are a known usability failure: they push users to `Password1!`.
- No forced rotation. Forced rotation produces `Password1!`, `Password1!2`, `Password1!3`.
- Screen passwords against the HaveIBeenPwned top 100k and the k-anonymity API on signup and on password change. Reject with a clear message: "This password has appeared in a known breach. Choose a different one."

### Sessions and cookies

- Session token: 256 bits of randomness from `crypto.randomBytes(32)`, base64url-encoded. Stored server-side in a session table keyed by the token's SHA-256 hash (never the token itself, so a session-table dump is not a credential dump).
- Cookie name: `__Host-session` (the `__Host-` prefix requires `Secure`, no `Domain`, and `Path=/`, which is a built-in hardening).
- Cookie attributes: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`.
- Idle timeout: 30 days. Absolute timeout: 90 days. After the absolute timeout, the user must re-authenticate even if they have used the session in the last 30 days.
- **Not a JWT.** JWTs cannot be revoked without a server-side blocklist, and a blocklist defeats the purpose of using JWTs. The session table is the source of truth, and revocation is one DELETE.

### MFA

- TOTP per RFC 6238. Optional for the free tier; encouraged (not required) for paid users.
- Recovery codes generated at MFA enrolment, single-use, hashed (Argon2id, same parameters) at rest.

### Email verification

- Required before account activation. A new account cannot access any non-auth endpoint until the verification link is clicked.
- Verification link is single-use, 24-hour TTL, tied to a server-side token stored as an Argon2id hash.

### Password reset

- Same channel as email verification. Rate-limited per email and per IP.
- Always returns "If that email exists, we sent a link." No account enumeration.
- Reset link is single-use, 1-hour TTL, hashed at rest.

## 5. Data model and field-level encryption

### The `users` table

| Column                  | Type                | Plaintext? | Notes |
|-------------------------|---------------------|------------|-------|
| `id`                    | UUID v7             | yes        | Primary key. Time-ordered, no information leak. |
| `email_lookup`          | bytea               | HMAC       | HMAC-SHA-256 of the lowercased, trimmed email, keyed with a **Vault `transit` key named `email-hmac` (type `hmac-sha2-256`)**. Used for case-insensitive login lookup without revealing the email. The application calls `vaultClient.transit.hmac('email-hmac', lower(email))`. |
| `email_encrypted`       | bytea               | envelope   | AES-256-GCM, envelope-encrypted with the Vault `cmk` key. The actual email, used for outbound communication. |
| `email_last4`           | text                | yes        | For human-friendly display ("a***@gmail.com"). |
| `password_hash`         | text                | Argon2id   | PHC string. |
| `display_name`          | text                | yes        | Shown in the dashboard; not the worst PII in a breach. |
| `year_group`            | smallint            | yes        | 7–13. |
| `dob_encrypted`         | bytea               | envelope   | Full date of birth. |
| `dob_year_only`         | smallint            | yes        | Used for age-gating UI without decrypting DOB. |
| `parent_email_encrypted`| bytea, nullable     | envelope   | Required for under-16s. |
| `parent_consent_state`  | enum                | yes        | `not_required`, `pending`, `granted`, `denied`, `expired`. |
| `parent_consent_token`  | text, nullable      | Argon2id   | Single-use, 24h TTL. Hashed at rest. |
| `email_verified_at`     | timestamptz, null   | yes        | Set when the verification link is clicked. |
| `mfa_secret_encrypted`  | bytea, nullable     | envelope   | TOTP shared secret. |
| `mfa_enabled`           | boolean             | yes        | |
| `created_at`            | timestamptz         | yes        | |
| `updated_at`            | timestamptz         | yes        | |
| `last_login_at`         | timestamptz, null   | yes        | |
| `soft_deleted_at`       | timestamptz, null   | yes        | Set on account deletion request. |
| `hard_delete_after`     | timestamptz, null   | yes        | `soft_deleted_at` + 30 days. |
| `failed_login_count`    | int                 | yes        | Reset on successful login. Drives progressive backoff. |

### The `audit_log` table

Append-only. Written through a dedicated database role that has `INSERT` and `SELECT` but no `UPDATE` or `DELETE`. Schema:

| Column      | Type        | Notes |
|-------------|-------------|-------|
| `id`        | UUID v7     | |
| `event`     | enum        | `signup`, `login_success`, `login_failure`, `password_change`, `password_reset_request`, `email_verified`, `mfa_enabled`, `mfa_disabled`, `parent_consent_granted`, `parent_consent_denied`, `data_export_requested`, `data_export_completed`, `data_erasure_requested`, `data_erasure_completed`, `account_locked`, `account_unlocked`, `admin_login`, `admin_action`. |
| `user_id`   | UUID, null  | Indexed. |
| `ip`        | inet        | |
| `user_agent`| text        | |
| `request_id`| text        | For correlation with the application logs. |
| `metadata`  | jsonb       | No PII in the metadata payload. The allowlist is enforced by the writer. |
| `created_at`| timestamptz | |

The audit log is the source of truth for the "who did what, when, from where" questions. A breach investigation starts here.

### Envelope encryption (v1.1 free tier)

- A Customer Master Key (CMK) lives in **Vault as a `transit` key named `cmk`**, AES-256-GCM, key version 1, auto-rotation at 90-day intervals. Each write to an `*_encrypted` column generates a fresh 256-bit Data Encryption Key (DEK). The DEK encrypts the column value with AES-256-GCM. The DEK is wrapped by the CMK and stored alongside the ciphertext.
- Decryption happens inside a thin Vault-aware service in the application. The application calls `vaultClient.transit.encrypt('cmk', plaintext)` and `vaultClient.transit.decrypt('cmk', ciphertext)`; the `kmsClient` interface is identical to the v1.0 design. The DEK is unwrapped on demand, used in memory, and never written to logs, files, or environment variables.
- Rotation: the Vault `cmk` is rotated every 90 days (Vault's auto-rotation). Re-wrapping DEKs is a background job. The application tolerates both the old and new wrapped DEK for the rotation window. **Risk**: R1, R2, R4. **Upgrade path**: export the Vault `transit` key in wrapped form, re-wrap with an AWS KMS CMK in `eu-west-2`, import to AWS KMS. The application's `kmsClient` interface is unchanged and the `*_encrypted` columns are not re-encrypted.

### What's plaintext and why

`display_name` and `year_group` are plaintext because the application reads them on every dashboard render. They are not the worst PII in a breach. `email` is encrypted at rest and looked up via the HMAC index — the trade-off is that you cannot `SELECT email FROM users WHERE email = ?`, you have to do `SELECT … WHERE email_lookup = ?` and then decrypt. The HMAC is the protection; the index is unkeyed as a search primitive. DOB is fully encrypted; only the year is plaintext for age-gating. Parent email is fully encrypted.

## 6. Database and infrastructure

- **Postgres 16 in Docker on the Oracle Ampere A1 VM (v1.1 free tier).** **Disk encryption is not available on the free tier's block volume.** The host volume is treated as untrusted at rest. The column-level encryption in section 5 is the actual floor: a stolen disk is useless without the Vault-managed keys, and a stolen VM is useless without the unseal key in 1Password. **Risk**: R1, R7. **Upgrade path**: enable OCI block-volume encryption (free) or move to AWS RDS with storage encryption in `eu-west-2` on the paid tier.
- **Column-level encryption** for the fields listed in section 5. Unchanged.
- **TLS 1.3 in transit everywhere (v1.1 free tier).** Terminated at the **Cloudflare free edge** with an automatically managed certificate; re-established to the origin over HTTPS using a 15-year **Cloudflare Origin Certificate** that only Cloudflare's edge will present a valid chain to. nginx on the VM terminates TLS, presents the origin cert, and requires the `Host: recall.education` header. The connection from the application to Postgres uses TLS with `sslmode=verify-full`; a self-signed CA is generated on first boot, pinned in the application's connection config (`ssl=on` in `postgresql.conf`, CA in `pg_hba.conf` hostssl entry). No plaintext connections from the application to Postgres. No plaintext connections between services.
- **Connection pooling (v1.1 free tier).** In-process `pg.Pool` with `max=10`; 50-connection ceiling on Postgres. No PgBouncer on the free tier (single-tenant, no other clients). **Upgrade path**: PgBouncer in transaction-pool mode, sized to the database's `max_connections` minus a reserve for migrations and admin.
- **No long-lived database credentials (v1.1 free tier).** The application fetches a fresh credential from **Vault's `database` secrets engine** on a 1-hour TTL. The credential is a Postgres role with a randomly generated password, scoped to the application's database. A bootstrap credential (the only static password) is generated on first boot, written to Vault, then never used again; rotation is quarterly. The application does not have a database password in any config file. `vault read database/creds/recall-app` returns a fresh role. **Upgrade path**: AWS IAM database authentication for RDS on the paid tier.
- **No read replica on the free tier.** Analytics is deferred. The Children's Code's no-profiling rule reduces the need; only aggregate counts and `year_group`/`dob_year_only` are read by analytics, and a nightly SQL aggregate run from the same database is sufficient at this scale. **Upgrade path**: read replica in `eu-west-2` on the paid tier, with the analytics service pointed at the replica and PII scrubbed at the analytics-service boundary.
- **Parameterised queries only.** Drizzle generates them by default. This document forbids:
  - `sql.raw()`.
  - String concatenation in `WHERE` clauses.
  - Dynamic `ORDER BY` from request input. Use a whitelist of column names.
  - `LIKE '%${term}%'`. Parameterise the term, never the pattern structure.
- **CI fails the build** if any of the above patterns appear in the codebase. A `grep` rule plus an AST-level check on the query builder catches them.

## 7. Application security

- **CSRF**: synchronizer token via `@fastify/csrf-protection`. All state-changing endpoints require a token. Same-origin only. The token is bound to the session.
- **Cookies**: see section 4.
- **CSP** (Content-Security-Policy):
  - Marketing pages (this repo's `index.html` and any future marketing routes): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. The `'unsafe-inline'` on styles is a pragmatic compromise.
  - Dashboard, signup, login, and any authenticated route: `default-src 'self'; script-src 'self' 'sha256-…'; style-src 'self' 'sha256-…'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. No `'unsafe-inline'`. Every script and style block is hashed at build time.
- **HSTS**: `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`. The header is set at the **Cloudflare free edge**; the application also sets it as a defence-in-depth pass-through. **Preload submission to https://hstspreload.org/ is part of the paid-tier launch checklist** — the domain must be live 90 days on HTTPS before preload acceptance, so the submission waits until either (a) 90 days of free-tier uptime or (b) the first paid plan, whichever comes first.
- **Other security headers**:
  - `X-Content-Type-Options: nosniff`.
  - `Referrer-Policy: strict-origin-when-cross-origin`.
  - `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- **Rate limits** (via `@fastify/rate-limit`):
  - Signup: 5 per IP per hour, 3 per email per hour. CAPTCHA after the second failed attempt from the same IP.
  - Login: 10 per IP per minute, 20 per account per hour.
  - Password reset: 3 per email per hour, 10 per IP per hour.
  - Email verification resend: 3 per email per hour.
  - Marketing email capture: 5 per IP per hour.
- **Account lockout: progressive backoff.** 5 failures → 1 minute. 10 → 15 minutes. 20 → 1 hour. 50 → 24 hours. **Never permanent.** Permanent lockout is a denial-of-service vector. A support path exists to unlock after identity verification.
- **CAPTCHA**: hCaptcha (not reCAPTCHA — reCAPTCHA ships data to Google) on signup, password reset, and after the second failed login from a given IP in a session. The **hCaptcha free tier is sufficient and works on a free Cloudflare-fronted domain**; the only constraint is that the site must not be used for "high-risk abuse patterns," which a children's education site is not. No design change versus v1.0.
- **OWASP Top 10 mitigations**:
  - **XSS**: CSP + no `innerHTML` on user content. User-generated content is rendered as text.
  - **SSRF**: no user-supplied URLs hit internal services. The only user-supplied URL is the avatar upload, which is fetched through a separate sandboxed service.
  - **Broken access control**: every endpoint has a per-route authorisation check. A test suite asserts that a non-owner of a resource gets a 403, not a 200.
  - **Insecure deserialisation**: no `eval`. No `JSON.parse` of untrusted data fed to a function or a query.
  - **Security misconfig**: a `security.txt` at `/.well-known/security.txt`, a public security policy, a public security contact email. CSP, HSTS, and the other security headers above are set at the framework level; a test fails CI if any of them is missing on any response.
  - **Vulnerable and outdated components**: Dependabot or Renovate on, weekly updates for security patches, `npm audit` (or the equivalent) clean in CI.
  - **Identification and authentication failures**: see section 4.
  - **Software and data integrity failures**: signed commits on `main`, signed releases, a Software Bill of Materials (SBOM) for every build.
  - **Security logging and monitoring failures**: see section 8.
  - **Server-side request forgery**: see SSRF.

### Edge and nginx backstop (v1.1 free tier)

- The **Cloudflare free WAF** runs 5 custom rules: (1) per-IP rate limit, (2) bot-score challenge, (3) known-bad user agents, (4) geo-allowlist UK, (5) a reserved "breach response" rule. OWASP Top 10 managed rules are paid; the application-level OWASP mitigations above are the substitute. **Upgrade path**: Cloudflare Pro with managed OWASP rules on the paid tier.
- The **nginx layer on the VM** is a second line of defence: TLS termination with the Cloudflare Origin Certificate, `limit_req_zone` at 1000 req/min per IP for everything except `/api/*` (100 req/min per IP), `limit_conn_zone` with 50 concurrent connections per IP, `client_max_body_size 1m;` to reject large uploads early. The application rate limits (`@fastify/rate-limit`) are the primary; nginx is a backstop.
- **fail2ban** on the host: SSH brute-force protection (3 failed attempts in 10 minutes → 1-hour ban); an optional log-parsing jail that watches the application's structured JSON logs for `event=login_failure` and bans IPs that cross a threshold (a 20-line `filter.conf` and a `jail.conf`).

## 8. Logging, monitoring, and incident response

### What goes in the logs

Structured JSON, **written to stdout and captured by Docker's logging driver to local disk at `/var/log/recall/`**, rotated by `logrotate`, retained 30 days. The application logger has a hardcoded allowlist; the developer cannot accidentally log PII because the field names are not in the allowlist. **On the free tier there is no log shipper, no Datadog, no Loki.** The threat model accepts that a host-level compromise is also a log-store compromise. The logs are included in the backup script's encryption and upload (see section 9), so an attacker has to defeat both Vault's `backup-key` and the application-layer logger scrubber to read the logs. **Upgrade path**: ship structured logs to a managed log store (Datadog EU, Grafana Cloud EU) on the paid tier.

- Auth events: `login_success`, `login_failure`, `password_change`, `mfa_challenge_failed`, `mfa_enabled`, `mfa_disabled`.
- Admin events: every admin action, with the admin's user_id, the action, and the target user_id.
- Rate-limit triggers: which endpoint, which key, the threshold that fired.
- Application errors: stack traces, request IDs, route, method, status. PII fields are redacted at the logger layer.

### What never goes in the logs

- Passwords, password hashes, password reset tokens. The logger scrubs any field named `password`, `token`, `secret`, or any header named `Authorization`.
- DOB and parent email values. Only `dob_year_only` and the `parent_consent_state` enum may appear.
- Full request bodies on sensitive endpoints (`/login`, `/signup`, `/password-reset`, `/forgot-password`). The body is replaced with `{"redacted": true}` at the logger layer.

### Alerts (v1.1 free tier)

The alerting channel is **email to a small distribution list + a webhook to a Telegram bot for the on-call**. Telegram is free and a reasonable substitute for PagerDuty at this scale.

- **Uptime monitoring**: UptimeRobot free tier, 50 monitors, 5-minute interval. Monitors: `https://recall.education/`, `https://recall.education/api/health`, `https://recall.education/.well-known/security.txt`, `https://recall.education/api/health/restore-test`, and a Postgres TCP probe.
- **Impossible travel**: a login from a new country within an hour of the previous one. Threshold is conservative — first version alerts, does not block. Avoids locking out a student moving between school and home Wi-Fi.
- **Brute force**: rate-limit fire counter crosses a threshold across all users from a single IP or ASN. Indicates a credential-stuffing attempt.
- **New admin login, new admin action, new IAM credential issued.**
- **Anomalous data export**: a user exporting more than once a month, or exporting from a new country.
- **Anomalous signup pattern**: spike in signups from a single ASN, or a spike in parent-consent failures.
- **Restore-test freshness** (v1.1 free tier): the `/api/health/restore-test` endpoint exposes the most recent monthly restore test result; UptimeRobot polls it; a missing or `pass=false` result fires the alert. See section 9.
- **Vault unseal failure** (v1.1 free tier): a systemd unit restart-loop on the Vault container is alerted via a host-level health check.

**Deferred to the paid tier**: managed-log-store anomaly detection (impossible travel and anomalous-export become statistical, not rule-based). **Upgrade path**: Datadog or Better Stack in EU, with the same alert set and managed-log anomaly detection.

### Incident response runbook

A full version lives in `RUNBOOK.md` (to be created before launch). Summary:

1. **Detect.** An alert fires. The on-call engineer is paged.
2. **Contain.** Rotate the affected credential. **Rotate the Vault `database` role and force all clients to re-fetch credentials** (the 1-hour TTL means clients pick up the new credential on the next refresh — no deploy needed). Revoke the affected session tokens. Take the affected endpoint offline if needed. These operations are rehearsed: rotating the Vault database role, rotating the Vault `cmk` key, and revoking all sessions are each one-command operations.
3. **Eradicate.** Identify the root cause from the application logs, the audit log, and the breach timeline.
4. **Recover.** Restore from the most recent clean backup if data integrity is in question. Force a password reset for affected users. Issue new session tokens.
5. **Notify.** ICO within 72 hours if there is a risk to individuals' rights (UK GDPR Article 33). Affected users without undue delay (Article 34). For children's data, the threshold for user notification is low — the safer assumption is notify. The communication template is in `RUNBOOK.md` and is reviewed by counsel annually.

## 9. Backups, recovery, and data lifecycle

- **Encrypted backups with a separate Vault-managed key (v1.1 free tier).** Nightly `pg_dump --format=custom --no-owner --no-privileges` of the database, encrypted with the Vault `transit` key `backup-key` before upload to a **Backblaze B2** bucket named `recall-backups-prod` (B2's free 10 GB tier, geographically separate from the VM's region). The script at `/opt/recall/backup.sh` runs from cron at 03:00 UTC, computes a `sha256` digest of the dump, calls `vault write transit/encrypt/backup-key plaintext=...`, writes the ciphertext to the bucket, then `shred -u`'s the local plaintext. The upload is recorded in `audit_log` with `event='backup_uploaded'`, `metadata={size, sha256, vault_key_version}`. **35-day retention is enforced by the B2 lifecycle rule**, not by local cron. **Risk**: R5 (no point-in-time recovery — a `pg_dump` is a snapshot; an 11-hour window of writes can be lost if the database is corrupted mid-day). **Upgrade path**: RDS automated backups with KMS encryption and WAL archiving to S3 in `eu-west-2` for PITR.
- **Restore is tested monthly (v1.1 free tier).** The script at `/opt/recall/restore-test.sh` downloads the most recent backup, decrypts it with Vault's `backup-key`, restores it to a throwaway Postgres container, runs a smoke test (`SELECT count(*) FROM users;` and a hash-of-row test), and writes the result to `/var/log/recall/restore-test.log`. The result is exposed at `https://recall.education/api/health/restore-test` as `{"last_restore":"YYYY-MM-DD","result":"pass|fail"}`. UptimeRobot polls this endpoint every 5 minutes; a missing or `pass=false` result fires the alert. The test record (date, who ran it, what was restored, what was checked) is filed in section 12.
- **Soft delete.** On account deletion request, `soft_deleted_at` is set. The account is invisible to the application and to the user. After 30 days, a background job hard-deletes the row. Before dropping the row, the job overwrites the `*_encrypted` columns with random bytes, then drops the row.
- **Right of erasure (UK GDPR Article 17).** A user (or a verified parent of an under-16) can request erasure from Settings → Data. The request creates an audit-log entry, a confirmation email is sent, and the job is enqueued. Erasure covers backups too: the **Vault `transit` key `cmk` is rotated, and the old key version is destroyed**, so even historical backups cannot decrypt the account. The audit-log entry for the erasure request is retained for 7 years (the audit-log retention in the table below), and the entry does not contain the account's PII.
- **Right of access (Article 15).** A user can request a data export. The export is generated asynchronously and emailed as a signed, time-limited download link. The export itself is encrypted with a passphrase the user supplies at request time. The export includes everything Recall holds on the user, in a machine-readable format (JSON).
- **Retention schedule**:
  - Account data: life of the account + 30 days.
  - Marketing email-capture list: until the user unsubscribes.
  - Session records: 90 days.
  - Audit logs: 7 years (financial-record-adjacent justification), with PII redacted after 2 years.
  - Backups: 35 days.

## 10. Third-party risk

Categories, and what we require from each.

- **Hosting (v1.1 free tier).** **Oracle Cloud Always Free**, Ampere A1, **US region**, OCI standard DPA. No SOC 2, no ISO 27001 on the free tier. The OCI standard DPA is the legal floor; the threat model accepts this. **Upgrade path**: AWS ECS on Fargate in `eu-west-2` on the paid tier, with an AWS-standard DPA and SOC 2.
- **Email (transactional) (v1.1 free tier).** **Mailgun Flex free tier**, 100 emails/day free forever, **US**. Marketing email is deferred to the paid tier (a dedicated ESP is a paid feature). DKIM, SPF, DMARC configured on both sides; DMARC policy is `p=quarantine` at launch. In development, `mailpit` runs in Docker. **Upgrade path**: Postmark with EU data residency on the paid tier.
- **KMS (v1.1 free tier).** **HashiCorp Vault, file-backed, on the same VM**. No FIPS 140-2. Vault is open source, audited, and the only free option that gives us the dynamic-credentials and transit-encryption properties called for in this document. **Upgrade path**: AWS KMS in `eu-west-2` on the paid tier, with FIPS 140-2 validated HSMs and customer-managed keys.
- **Backups (v1.1 free tier).** **Backblaze B2**, free 10 GB tier, US. The dump is encrypted with the Vault `transit` key `backup-key` before upload, so the cloud provider does not hold the encryption key. **Upgrade path**: S3 in `eu-west-2` with KMS-managed encryption and PITR via WAL archiving.
- **CAPTCHA.** hCaptcha. **Free tier is sufficient and works on a free Cloudflare-fronted domain.** Privacy-respecting, EU-hosted option. reCAPTCHA is out because it ships data to Google. No design change versus v1.0.
- **Error tracking (v1.1 free tier).** **Sentry free Developer plan**, 5,000 events/month, 1 project, 7-day retention, **EU data residency in Frankfurt**. `sendDefaultPii: false`; `beforeSend` scrubber on every event. The 5k/month budget is tight for a launch with even 100 active students; the event count is monitored and the project is migrated to the paid Team tier when it crosses 80% of the budget. **Upgrade path**: Sentry Team on the paid tier.
- **Monitoring (v1.1 free tier).** **UptimeRobot free tier** (50 monitors, 5-minute interval, email + webhook alerts) + **fail2ban** on the host + **Telegram** for the on-call webhook. No managed log store. **Upgrade path**: Datadog or Better Stack in EU on the paid tier, with managed-log anomaly detection.
- **Payments (when added).** Stripe via Stripe Checkout or Stripe Connect. PCI-DSS out of scope (Stripe handles PAN). DPA required. Not on the v1.1 free tier; deferred to the first paid plan.
- **Customer support tooling (v1.1 free tier).** **Plain email to support@recall.education**. No Intercom, no Zendesk, no third-country data export. **Upgrade path**: Intercom (EU region) or Zendesk (EU region) on the paid tier.
- **CI/CD (v1.1 free tier).** **GitHub Actions free tier**, 2,000 minutes/month for private repos. Pipeline: lint, type-check, unit tests, Drizzle migration dry-run, Trivy scan, `npm audit --omit=dev` clean, CI grep for `sql.raw`, `bcrypt`, `pbkdf2`, `scrypt`, `innerHTML` (must return zero), deploy over SSH.
- **Secrets storage (v1.1 free tier).** **1Password** for the Vault unseal key, the Cloudflare API token, the Backblaze B2 application key, the Mailgun API key, the Sentry DSN, the GitHub deploy key, and any other operator-level secrets. 1Password is highly available and provides an audit trail. A paper backup of the Vault unseal key is held on an offline USB in a fireproof safe.
- **AI assistance.** Any feature that uses an LLM (e.g. a "explain this answer" tutor) must not send student content to a model that trains on inputs. Use providers with a zero-retention configuration; verify in the contract, not just in the marketing. The Anthropic and OpenAI zero-retention modes both qualify when configured correctly. Out of scope for the v1.1 free-tier launch; the architecture supports it, but the feature is not on the v1.1 launch checklist.

### 10.x Migration plan to the paid tier

When revenue arrives, the following swaps happen in dependency order. Each step is a precondition of the next. The whole sequence is the "pre-launch requirement of the paid tier" referenced in section 1.10.

1. **Submit HSTS preload.** Trigger: any revenue, or 90 days of HTTPS uptime on the free tier. Work: submit at https://hstspreload.org/; wait for acceptance; update `SECURITY.md` section 12.
2. **ICO registration.** Trigger: before any personal data is processed. Work: register at https://ico.org.uk/for-organisations/data-protection-fee/; £40/year; file the number in section 12 and on `/legal/data-protection`.
3. **Replace Vault with AWS KMS in `eu-west-2`.** Trigger: first paid plan. Work: create an AWS account in `eu-west-2`, create a customer-managed CMK, export Vault `transit` keys (`cmk`, `email-hmac`, `pepper`, `backup-key`) in wrapped form, re-wrap with the AWS KMS CMK, import to AWS KMS. Update `kmsClient` to point at AWS KMS. The `*_encrypted` columns are not re-encrypted. Decommission Vault.
4. **Move Postgres to AWS RDS in `eu-west-2`.** Trigger: same as KMS migration. Work: provision RDS Postgres 16 with storage encryption, TLS required, IAM database authentication. `pg_dump` from the free-tier Postgres, restore to RDS, cut over. Replace Vault's `database` secrets engine with AWS IAM database authentication. Add a read replica in `eu-west-2`.
5. **Move the Node app to AWS ECS on Fargate in `eu-west-2`.** Trigger: when the free-tier VM is at 60% of any resource. Work: containerise the app (already in Docker), push to ECR, define an ECS service on Fargate with an ALB. Cloudflare edge stays in place. Oracle VM is decommissioned.
6. **Move backups to S3 in `eu-west-2` with KMS encryption.** Trigger: same week as the RDS migration. Work: configure RDS automated backups with KMS encryption and 35-day retention; configure `pg_dump` to S3, encrypted with the AWS KMS `backup-key`; enable PITR via RDS automated backups + WAL archiving to S3. Backblaze B2 is decommissioned.
7. **Move transactional email to Postmark (EU data residency).** Trigger: when Mailgun's 100 emails/day is hit. Work: sign up for Postmark with EU data residency, configure DKIM/SPF/DMARC, update `SMTP_HOST`. Mailgun is decommissioned.
8. **Move monitoring and alerting to Better Stack (EU) or Datadog (EU).** Trigger: first paid plan. Work: provision the monitoring service in EU; configure the same alerts (uptime, restore-test, impossible-travel, anomalous data export, anomalous signup); ship structured logs to the managed log store. UptimeRobot is decommissioned.
9. **Move analytics off the same database.** Trigger: when analytics query load on the primary exceeds 5% of CPU. Work: enable the RDS read replica in `eu-west-2`; point the analytics service at the replica; scrub PII at the analytics-service boundary.
10. **First external penetration test.** Trigger: first paying customer, or first 1,000 active students. Work: commission a CREST-accredited pen test firm; scope: external network, web app, API, auth flow, parental consent flow, encryption at rest and in transit, backup encryption, incident response rehearsal. Findings tracked in section 12.
11. **First DPIA review.** Trigger: 12 months after launch, or after any significant architecture change. Work: re-file the DPIA to reflect the current state of the controls; reviewed by counsel; filed at `/legal/dpia-v2.pdf`.
12. **First KCSiE audit (if schools sign up).** Trigger: first school contract. Work: enable the DPA template; sign with the school; audit the sub-processor list; configure the school's data residency requirements (likely a separate AWS account or a per-school encryption key); annual KCSiE audit is part of the contract.
13. **First ISO 27001 audit (optional, but unlocks school contracts).** Trigger: first multi-school contract or first £50k MRR. Work: engage an ISO 27001-accredited certification body; scope to the production stack; run a 6-month readiness programme; complete Stage 1 and Stage 2 audits; maintain the ISMS.

## 11. Minimum viable secure launch checklist (v1.1 free tier)

These 15 items must be true before a real student signs up. Each is verifiable with a specific command or test on the free-tier stack.

1. **Argon2id is the only password hash in the codebase.** `grep -r "bcrypt\|pbkdf2\|scrypt" src/` returns nothing. Same check applies on the paid tier.
2. **The pepper is read from a Vault-managed secret.** `vault kv get -mount=secret pepper` returns the current value. Rotation is logged in `audit_log` with `event='pepper_rotated'`. A CI grep for `PEPPER=` in `*.env*` files fails the build.
3. **Every PII column is wrapped in the envelope-encryption helper.** A Drizzle migration check asserts that `*_encrypted` columns are `bytea`. A unit test asserts fresh DEK per write and plaintext recovery via Vault.
4. **TLS 1.3 at the edge. HSTS with `preload`.** `curl -I --tlsv1.3 https://recall.education` returns 200 with the `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload` header. HSTS preload submission to https://hstspreload.org/ is part of the paid-tier launch checklist.
5. **CSP, X-Content-Type-Options, Referrer-Policy, and Permissions-Policy are set on every response.** `curl -I https://recall.education/api/health` returns all four headers. `securityheaders.com` scores A or better.
6. **Rate limits on signup, login, password reset, verification resend.** A `k6` load test sends 200 signups from one IP in 10 minutes; the 6th through 200th receive 429.
7. **CAPTCHA on signup, password reset, after the second failed login.** A Playwright test signs up, intentionally fails the CAPTCHA, and asserts a 400 with `{"error":"captcha_failed"}`.
8. **Email verification required before any non-auth endpoint returns 200.** An integration test signs up, calls `GET /api/dashboard` without verifying email, and gets 403 `{"error":"email_not_verified"}`.
9. **Parental consent flow is end-to-end tested.** A Playwright test creates an under-16 account, asserts the parent email receives a consent link, clicks the link, and asserts the child's account activates. A second test revokes a previously granted consent and asserts the child's account is soft-deleted.
10. **Audit log captures every event in the section 5 enum.** A smoke test signs up, logs in, changes a password, requests a data export, and asserts four `audit_log` rows with the correct `event` values. The audit log writer role is verified to have `INSERT` and `SELECT` but not `UPDATE` or `DELETE`.
11. **Logger scrubber redacts `password`, `token`, `secret`, `authorization` headers, and PII fields.** A unit test feeds `{"password":"hunter2","email":"a@b.com","dob":"2010-01-01","authorization":"Bearer x"}` to the logger and asserts all four are `[REDACTED]`. Sentry's `beforeSend` has the same test.
12. **Backups are encrypted, restored, monthly restore test.** The monthly restore test writes a result to `/var/log/recall/restore-test.log` and exposes it at `https://recall.education/api/health/restore-test`. UptimeRobot checks this endpoint every 5 minutes; missing or `pass=false` fires the alert.
13. **DPA template finalised, sub-processor list published at `/legal/sub-processors`.** `curl https://recall.education/legal/sub-processors` returns a JSON list reflecting the free-tier stack (Oracle US, Backblaze B2 US, Cloudflare global, Mailgun US, Sentry EU, UptimeRobot US, hCaptcha EU, GitHub US, 1Password US). The DPA template is at `/legal/dpa.pdf`.
14. **DPIA completed, reviewed, filed before launch.** A DPIA document at `/legal/dpia.pdf` covers: nature of processing, scope, context, necessity and proportionality, risks to children's rights, mitigations; references `SECURITY.md` sections 1–10; dated; signed by the data controller; reviewed annually; explicitly notes US data residency and 35-day backup retention.
15. **`SECURITY.md`, `RUNBOOK.md`, `/.well-known/security.txt` are all live.** `curl https://recall.education/.well-known/security.txt` returns a `Contact:` line with a monitored email. A quarterly test email is sent to the security contact and the response time is logged.

## 12. Evidence and living-document note

A security spec is only as good as the evidence that it was followed. This section is where that evidence lives. The list starts empty at v1.1. Each entry includes the date, what was checked, who checked it, and any links to the artefact (pen test report, restore log, access review).

- **Last penetration test**: not yet performed (paid-tier trigger; see section 10).
- **Most recent backup restore test (v1.1 free tier)**: not yet performed. To be filled at the first monthly run of `/opt/recall/restore-test.sh`; the timestamp and result are exposed at `/api/health/restore-test` and polled by UptimeRobot.
- **Most recent Vault unseal test (v1.1 free tier)**: not yet performed. To be filled at the first monthly test (boot the VM, confirm Vault unseals, confirm the application logs `kmsClient.ready=true`).
- **Most recent HSTS preload check (v1.1 free tier)**: not yet performed. Paid-tier trigger.
- **Most recent free-tier cost review (v1.1 free tier)**: not yet performed. Quarterly: confirm the only billable item is the domain name (and any overage on the B2 bucket).
- **Most recent access review**: not yet performed.
- **ICO registration number**: not yet registered (pre-launch requirement; see section 10).
- **Company registration number**: 14882047 (Recall Education Ltd).

This document is versioned and dated at the top. Any change to the controls in sections 1–10 requires a version bump, a PR review from the security owner, and a corresponding update to the Evidence section. The MVP launch checklist in section 11 is the acceptance gate; the spec in sections 1–10 is the contract for what is being built.

If you are reading this because you are about to launch, finish the checklist before you push the signup button live.
