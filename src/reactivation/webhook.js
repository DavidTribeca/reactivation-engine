/**
 * GHL webhook handler — real-time outcome and opt-out ingestion.
 *
 * Mount in the existing Express app:
 *
 *   import { ghlWebhookRouter } from './src/reactivation/webhook.js';
 *   app.use('/webhooks/ghl', ghlWebhookRouter(db));
 *
 * Then point the GHL webhook at:
 *   https://isa-call-list-production-a489.up.railway.app/webhooks/ghl
 *
 * WHY THIS MATTERS FOR COMPLIANCE: an opt-out must stop every subsequent dial
 * immediately, not at the next nightly sync. This handler writes to
 * re_suppression synchronously, and the dispatcher checks that table on every
 * push, so a revocation takes effect on the very next batch.
 */

import express from 'express';
import crypto from 'crypto';
import { recordOutcome } from './dispatcher.js';

/**
 * Verify the GHL signature. Adjust the header name and scheme to match what
 * your GHL webhook actually sends — verify against a real captured request
 * before relying on it.
 */
function verifySignature(req) {
  const secret = process.env.GHL_WEBHOOK_SECRET;
  if (!secret) return true;                      // unset = skip (dev only)

  const provided = req.get('x-wh-signature') || req.get('x-ghl-signature');
  if (!provided) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(req.rawBody || JSON.stringify(req.body))
    .digest('hex');

  // Constant-time compare; guard against length mismatch throwing.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Map GHL/SimpleTalk event payloads onto our outcome vocabulary.
 * ⚠️ Tune these to the actual event names your GHL workflow emits — log a few
 * real payloads first, then fill this in.
 */
function mapOutcome(body) {
  const type = (body.type || body.event || '').toLowerCase();
  const status = (body.callStatus || body.status || '').toLowerCase();
  const text = `${type} ${status}`;

  if (/optout|opt_out|unsubscrib|dnc|do_not_contact/.test(text)) return 'opted_out';
  if (/appointment|booked|scheduled/.test(text))                 return 'appointment';
  if (/invalid|disconnected|wrong.?number|failed/.test(text))    return 'bad_number';
  if (/answered|connected|completed|human/.test(text))           return 'reached';
  if (/voicemail|machine/.test(text))                            return 'voicemail';
  if (/no.?answer|busy|missed|noanswer/.test(text))              return 'no_answer';
  return null;
}

export function ghlWebhookRouter(db) {
  const router = express.Router();

  // Capture the raw body so the HMAC is computed over exactly what was sent.
  router.use(express.json({
    verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
  }));

  router.post('/', async (req, res) => {
    if (!verifySignature(req)) {
      console.warn('[webhook] bad signature, rejecting');
      return res.status(401).json({ ok: false, error: 'bad signature' });
    }

    // Always ack fast — GHL retries on non-2xx and we don't want duplicate work.
    res.status(200).json({ ok: true });

    try {
      const body = req.body || {};
      const outcome = mapOutcome(body);
      if (!outcome) {
        console.log(`[webhook] unmapped event: ${body.type || body.event}`);
        return;
      }

      const ghlContactId = body.contactId || body.contact?.id;
      const phone = body.phone || body.contact?.phone;

      const { rows } = await db.query(
        `SELECT id FROM re_contact
          WHERE ($1::text IS NOT NULL AND ghl_contact_id = $1)
             OR ($2::text IS NOT NULL AND phone_e164 = $2)
          ORDER BY updated_at DESC LIMIT 1`,
        [ghlContactId || null, phone || null],
      );

      if (!rows.length) {
        // Opt-outs from people not in the program still belong on the
        // suppression list — never lose a revocation.
        if (outcome === 'opted_out' && phone) {
          await db.query(
            `INSERT INTO re_suppression (phone_e164, reason, source, note)
             VALUES ($1, 'opt_out', 'ghl-webhook', 'not in re_contact at time of opt-out')
             ON CONFLICT (phone_e164) DO NOTHING`, [phone],
          );
          console.log(`[webhook] suppressed unknown number ${phone}`);
        }
        return;
      }

      const result = await recordOutcome(db, {
        contactId: rows[0].id,
        outcome,
        conversationId: body.conversationId || body.callId || null,
        raw: body,
      });

      console.log(`[webhook] contact=${rows[0].id} ${outcome} -> ${result.status}`);
    } catch (err) {
      console.error(`[webhook] handler error: ${err.message}`);
    }
  });

  return router;
}
