/**
 * @file `/api/otp/*` — the email verification challenge.
 *
 * PUBLIC, and necessarily so: a visitor mid-funnel has no credentials. The
 * compensation is that it is bounded on every axis — per address, per caller,
 * by the attempt cap inside `verifyOtpCode`, and by a global ceiling.
 *
 * That global ceiling is the load-bearing one. This endpoint mails a
 * "Verification Code" message to whatever address the request body names, so an
 * unbounded caller turns the operator's domain into an open relay. The per-IP
 * limit cannot be that bound, because its key comes from `clientIp`, which
 * honours caller-supplied `x-forwarded-for` — rotate the header and it never
 * binds. `MAIL_HOURLY_CAP` is keyed on nothing the caller controls.
 */

import { EMAIL_RE, sendOtpCode, verifyOtpCode } from "../lib/email.js";
import { CORS, clientIp, json, readJson } from "../lib/http.js";
import { MAIL_HOURLY_CAP, rateLimit, tooMany } from "../lib/ratelimit.js";

/**
 * @param {Request} req
 * @param {{ path: string, server: any }} ctx
 * @returns {Promise<Response|null>} null when no OTP route matched.
 */
export async function handleOtp(req, ctx) {
  const { path, server } = ctx;

  if (path === "/api/otp/send" && req.method === "POST") {
    const body = await readJson(req);
    const email = String(body?.email || "").trim().toLowerCase();
    if (!email) return json({ error: "missing_email" }, 400, CORS);
    if (!EMAIL_RE.test(email)) return json({ error: "invalid_email" }, 400, CORS);

    const ip = clientIp(req, server) || "unknown";
    // One code per address per minute, a handful per hour, and a ceiling per
    // caller so one host cannot mail every address it can think of.
    if (!(await rateLimit(`otp-send:${email}`, 1, 60 * 1000))) return tooMany();
    if (!(await rateLimit(`otp-send-hourly:${email}`, 5, 60 * 60 * 1000))) return tooMany();
    if (!(await rateLimit(`otp-send-ip:${ip}`, 20, 60 * 60 * 1000))) return tooMany();

    // The per-caller ceiling above is keyed on `clientIp`, which honours
    // `x-forwarded-for` so a proxied deploy attributes traffic correctly — and
    // that header is caller-supplied, so an attacker rotates it and the ceiling
    // never binds. What is actually at stake is outbound mail: this endpoint
    // sends a "Verification Code" message to any address in the request, so an
    // unbounded caller turns the operator's mail domain into an open relay and
    // burns their sending reputation.
    //
    // This cap is global and keyed on nothing the caller controls, so no header
    // rotates past it. It sits after the per-address limits so ordinary traffic
    // never reaches it. Raise it with MAIL_MAX_PER_HOUR on a high-volume funnel.
    if (!(await rateLimit("otp-send-global", MAIL_HOURLY_CAP, 60 * 60 * 1000))) return tooMany();

    const res = await sendOtpCode(email);
    return json(res, res.ok ? 200 : 502, CORS);
  }

  if (path === "/api/otp/verify" && req.method === "POST") {
    const body = await readJson(req);
    const email = String(body?.email || "").trim().toLowerCase();
    const code = body?.code;
    const ip = clientIp(req, server) || "unknown";
    if (!(await rateLimit(`otp-verify:${ip}`, 30, 10 * 60 * 1000))) return tooMany();

    const valid = await verifyOtpCode(email, code);
    return json({ ok: valid, valid }, 200, CORS);
  }

  return null;
}
