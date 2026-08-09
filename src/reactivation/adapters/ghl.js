/**
 * GHL adapter — the ACTUATOR.
 *
 * GHL is SimpleTalk's own CRM, so enrolling a contact in the SimpleTalk
 * workflow here is what actually causes a dial. This replaces the manual
 * "add to the 'send to simpletalk' FUB automation" step.
 *
 * ── TOKEN SCOPES — verified against the live location 7 Aug 2026 ───────────
 *
 * The Private Integration token currently has READ ONLY:
 *      contacts.readonly · locations/customFields.readonly
 *      conversations.readonly · calendars.readonly
 *
 * It is MISSING everything this adapter needs to write:
 *      contacts.write          ← upsertContact() cannot work without it
 *      workflows.readonly      ← to list/confirm the SimpleTalk workflow
 *      workflows.write         ← enrolInSimpleTalk() / removeFromSimpleTalk()
 *
 * Add those in GHL → Settings → Private Integrations → edit the token.
 * Until then the dispatcher will fail every push with HTTP 401
 * "The token is not authorized for this scope."
 *
 * ⚠️ STILL UNVERIFIED: the two endpoint shapes below. They could not be
 * exercised because a successful write would enrol a real person in the
 * SimpleTalk workflow and place a real phone call. Verify against one
 * deliberately-created test contact, never a live record.
 *   1. POST /contacts/upsert
 *   2. POST /contacts/{contactId}/workflow/{workflowId}
 *
 * Also note: GHL sits behind Cloudflare, which rejects requests with no
 * User-Agent (error 1010) — a bare Python/urllib client hits this immediately.
 * An earlier version of this comment said "Node's fetch sets one", which was an
 * assumption, not something anyone checked, and it is the kind of assumption
 * that shows up as an unexplained 403 on the first live push. headers() now
 * sets one explicitly, so it does not matter what the runtime does by default.
 */

const BASE = 'https://services.leadconnectorhq.com';

function headers() {
  return {
    'Authorization': `Bearer ${process.env.GHL_API_TOKEN}`,
    'Version': process.env.GHL_API_VERSION || '2021-07-28',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': process.env.RE_USER_AGENT || 'tribeca-reactivation-engine/1.0',
  };
}

async function ghlFetch(path, options = {}, { retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`${BASE}${path}`, { ...options, headers: headers() });

      // Rate limited or transient — back off and retry.
      if (res.status === 429 || res.status >= 500) {
        const wait = Number(res.headers.get('retry-after')) * 1000 || 2 ** i * 1000;
        await sleep(wait);
        lastErr = new Error(`GHL ${res.status} on ${path}`);
        continue;
      }

      const body = await res.text();
      if (!res.ok) throw new Error(`GHL ${res.status} on ${path}: ${body.slice(0, 400)}`);
      return body ? JSON.parse(body) : {};
    } catch (err) {
      lastErr = err;
      if (i === retries - 1) break;
      await sleep(2 ** i * 1000);
    }
  }
  throw lastErr;
}

/**
 * Create or update the contact in GHL. Returns the GHL contact id.
 * Custom fields carry cohort/attempt context so SimpleTalk's script can
 * personalise and so you can debug from the GHL UI.
 */
export async function upsertContact(contact) {
  const payload = {
    locationId: process.env.GHL_LOCATION_ID,
    firstName:  contact.first_name || undefined,
    lastName:   contact.last_name  || undefined,
    phone:      contact.phone_e164,
    email:      contact.email || undefined,
    timezone:   contact.timezone,
    source:     'reactivation-engine',
    tags:       [`wave-${contact.wave}`, `cohort-${contact.cohort_code}`, 'reactivation'],
    // Custom field keys VERIFIED against the live location 7 Aug 2026 via
    // GET /locations/{id}/customFields. An earlier version guessed
    // 'fub_person_id'; the real key is 'contact.follow_up_boss_record_id',
    // which the existing FUB<->GHL sync already populates — so writing it
    // keeps this engine consistent with the sync rather than competing with it.
    customFields: [
      { key: 'contact.follow_up_boss_record_id',
        field_value: String(contact.fub_person_id ?? '') },
    ],
  };

  const out = await ghlFetch('/contacts/upsert', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return out?.contact?.id || out?.id || null;
}

/**
 * Enrol the contact in the SimpleTalk workflow. THIS is the dial trigger.
 */
export async function enrolInSimpleTalk(ghlContactId) {
  const workflowId = process.env.GHL_SIMPLETALK_WORKFLOW_ID;
  if (!workflowId) throw new Error('GHL_SIMPLETALK_WORKFLOW_ID is not set');

  return ghlFetch(`/contacts/${ghlContactId}/workflow/${workflowId}`, {
    method: 'POST',
    body: JSON.stringify({ eventStartTime: new Date().toISOString() }),
  });
}

/**
 * Pull a contact out of the workflow — used the moment someone is reached,
 * books, or opts out, so SimpleTalk stops dialing them.
 */
export async function removeFromSimpleTalk(ghlContactId) {
  const workflowId = process.env.GHL_SIMPLETALK_WORKFLOW_ID;
  if (!workflowId) return;
  try {
    await ghlFetch(`/contacts/${ghlContactId}/workflow/${workflowId}`, { method: 'DELETE' });
  } catch (err) {
    // Non-fatal: the FUB "stop ai call" tag is the belt to this braces.
    console.warn(`[ghl] could not remove ${ghlContactId} from workflow: ${err.message}`);
  }
}

/** Combined push used by the dispatcher. */
export async function pushForDial(contact) {
  const ghlId = contact.ghl_contact_id || await upsertContact(contact);
  if (!ghlId) throw new Error('GHL upsert returned no contact id');
  await enrolInSimpleTalk(ghlId);
  return ghlId;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
