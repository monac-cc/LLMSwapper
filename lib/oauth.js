'use strict';
// PKCE login + token refresh + profile fetch against Anthropic.
// Constants below were read out of the shipped claude.exe and verified live.
const { spawn } = require('node:child_process');

const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
// Verified by probing with a deliberately invalid refresh token: this host answers
// 400 invalid_grant (i.e. it processed the request), while console.anthropic.com
// answers 404 not_found. Getting this wrong breaks BOTH refresh and code exchange.
const TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

const SCOPES = [
  'user:inference',
  'user:profile',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];

// `claude setup-token` mints an INFERENCE-ONLY token. Verified in claude.exe v2.1.258, whose
// authorize-URL builder reads `inferenceOnly ? ["user:inference"] : <the five scopes above>`.
//
// Storing the HONEST scope list matters. Writing the full five instead would flip the client-side
// check that guards /api/oauth/profile and /api/oauth/usage, so Claude Code would START calling
// endpoints the SERVER answers 403 to - turning a silent absence of data into visible errors
// inside the user's CLI. And the field cannot simply be omitted: a credentials blob carrying no
// `scopes` at all makes Claude Code print "Not logged in - Please run /login" (verified live).
const INFERENCE_ONLY_SCOPES = ['user:inference'];

// setup-token asks the token endpoint for expires_in: 31536000 - exactly 365 days. A pasted token
// carries no expires_in of its own, so this is what we stamp on it. Without it, toStoredOauth's
// 1-hour fallback would mark a year-long token expired 55 minutes after it was added.
const LONG_LIVED_MS = 365 * 24 * 60 * 60 * 1000;

// Shape only. An interactive-login access token and a setup-token share the `sk-ant-oat01-`
// prefix AND length, so this rejects obvious rubbish and nothing more; probeToken decides truth.
const TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/;

const API_HEADERS = {
  'anthropic-beta': 'oauth-2025-04-20',
  'User-Agent': 'claude-cli/2.0.0 (external, cli)',
  Accept: 'application/json',
};

/**
 * A token must never reach a log or an HTTP response, not even inside an upstream error body.
 * Covers Codex too: OpenAI access and id tokens are JWTs (eyJ...), and its refresh token has the
 * shape <2 lowercase>.<1 char>.<~206 url-safe chars>.
 */
function scrub(text) {
  return String(text == null ? '' : text)
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'eyJ***')
    .replace(/\b[a-z]{2}\.[A-Za-z0-9_-]\.[A-Za-z0-9_-]{100,}/g, 'rt***');
}

async function postJson(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...API_HEADERS },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`Network error calling ${url}: ${scrub(err.message)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${url} returned ${res.status}: ${scrub(text).slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} returned ${res.status} but the body was not JSON: ${scrub(text).slice(0, 200)}`);
  }
}

const refresh = (refreshToken) =>
  postJson(TOKEN_URL, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID });

/** Map a token response onto the stored account.oauth shape (expires_in is SECONDS). */
function toStoredOauth(tok, previous) {
  const prev = previous || {};
  const scopes = Array.isArray(tok.scope)
    ? tok.scope
    : typeof tok.scope === 'string' && tok.scope
      ? tok.scope.split(/\s+/).filter(Boolean)
      : prev.scopes || SCOPES;

  const expiresAt = tok.expires_in
    ? Date.now() + Number(tok.expires_in) * 1000
    : prev.expiresAt || Date.now() + 3600 * 1000;

  return {
    accessToken: tok.access_token || prev.accessToken,
    refreshToken: tok.refresh_token || prev.refreshToken,
    expiresAt,
    refreshTokenExpiresAt: tok.refresh_expires_in
      ? Date.now() + Number(tok.refresh_expires_in) * 1000
      : prev.refreshTokenExpiresAt || null,
    scopes,
    subscriptionType: tok.subscription_type || prev.subscriptionType || 'max',
    rateLimitTier: tok.rate_limit_tier || prev.rateLimitTier || null,
  };
}

/**
 * The live source of truth for who a token belongs to - ~/.claude.json can be stale
 * relative to the credentials file, so always trust this over the on-disk copy.
 * Returns the exact oauthAccount shape Claude Code expects.
 */
async function fetchProfile(accessToken) {
  let res;
  try {
    res = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, ...API_HEADERS },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`Network error calling the profile endpoint: ${scrub(err.message)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Profile endpoint returned ${res.status}: ${scrub(text).slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  let body;
  try { body = JSON.parse(text); } catch { throw new Error('Profile endpoint returned malformed JSON'); }

  const acc = body.account || {};
  const org = body.organization || {};
  const email = acc.email || acc.email_address || null;
  if (!email) throw new Error('Profile response carried no email address - cannot identify this account');

  return {
    email,
    profile: {
      accountUuid: acc.uuid || null,
      emailAddress: email,
      organizationUuid: org.uuid || null,
      hasExtraUsageEnabled: org.has_extra_usage_enabled ?? false,
      billingType: org.billing_type ?? null,
      accountCreatedAt: acc.created_at ?? null,
      subscriptionCreatedAt: org.subscription_created_at ?? null,
      ccOnboardingFlags: org.cc_onboarding_flags ?? {},
      claudeCodeTrialEndsAt: org.claude_code_trial_ends_at ?? null,
      claudeCodeTrialDurationDays: org.claude_code_trial_duration_days ?? null,
      seatTier: org.seat_tier ?? null,
      displayName: acc.display_name || acc.full_name || email,
      fullName: acc.full_name || acc.display_name || email,
      profileFetchedAt: Date.now(),
      organizationRole: org.organization_role ?? 'admin',
      workspaceRole: org.workspace_role ?? null,
      organizationName: org.name ?? null,
      organizationType: org.organization_type ?? null,
      organizationRateLimitTier: org.rate_limit_tier ?? null,
      userRateLimitTier: acc.rate_limit_tier ?? null,
    },
  };
}

/**
 * What a pasted token IS, decided by the profile endpoint rather than by its shape.
 *
 *   'full'      (200)         a token an interactive /login would mint. It carries user:profile,
 *                             so we can name the account and its usage meters will work.
 *   'inference' (403 + scope) a `claude setup-token` token. Inference works; /profile and /usage
 *                             will never answer it.
 *   throws      (401/other)   not a token we can use.
 *
 * The 403 is the whole trick, and it is a POSITIVE signal: Anthropic only bothers to check scopes
 * on a token it has already authenticated, so a scope complaint proves the token is real. That
 * makes this a free validator. Proving the same thing by sending a message would cost inference,
 * would bill the user, and still would not reveal whose token it is.
 *
 * Deliberately NOT the usage endpoint: that one allows roughly five calls per five minutes for
 * the whole app, and spending one to validate a paste would blank the dashboard being looked at.
 */
async function probeToken(accessToken) {
  const token = String(accessToken == null ? '' : accessToken).trim();
  if (!TOKEN_RE.test(token)) {
    // Deliberately quotes no token prefix: every API error goes through scrub(), which redacts
    // anything matching sk-ant-* - including a prefix written as a hint, leaving the user with
    // "debe empezar por sk-ant-***". Telling them where the token comes from is more useful and
    // survives the scrubber intact.
    const e = new Error('Eso no parece un token de Claude Code. Pega el que imprime "claude setup-token", entero.');
    e.malformed = true;
    throw e;
  }

  let res;
  try {
    res = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${token}`, ...API_HEADERS },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new Error(`No se pudo contactar con Anthropic para validar el token: ${scrub(err.message)}`);
  }

  if (res.ok) return { kind: 'full' };

  const text = await res.text();
  // Authenticated, but not enough scope: this is exactly what `claude setup-token` produces.
  if (res.status === 403 && /scope/i.test(text)) return { kind: 'inference' };
  if (res.status === 401) {
    const e = new Error('Anthropic rechaza ese token (401). ¿Lo has copiado entero? ¿Sigue vigente?');
    e.status = 401;
    throw e;
  }
  const e = new Error(`Anthropic devolvió ${res.status} al validar el token: ${scrub(text).slice(0, 200)}`);
  e.status = res.status;
  throw e;
}

/** Best-effort; a headless box that cannot open a browser is not an error. */
function openBrowser(url) {
  try {
    const opts = { detached: true, stdio: 'ignore' };
    let child;
    if (process.platform === 'win32') child = spawn('cmd', ['/c', 'start', '', url], { ...opts, windowsHide: true });
    else if (process.platform === 'darwin') child = spawn('open', [url], opts);
    else child = spawn('xdg-open', [url], opts);
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  CLIENT_ID, TOKEN_URL, PROFILE_URL, SCOPES, API_HEADERS,
  INFERENCE_ONLY_SCOPES, LONG_LIVED_MS, TOKEN_RE,
  refresh, toStoredOauth, fetchProfile, probeToken, openBrowser, scrub,
};
