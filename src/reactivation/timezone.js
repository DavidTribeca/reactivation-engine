/**
 * Contact timezone resolution — a COMPLIANCE control, not a nicety.
 *
 * The dial-window check enforces 8am–8pm in the CONTACT's local time. That is
 * only meaningful if the contact's timezone is actually right. An earlier
 * version of the importer left every record on the schema default of
 * America/Los_Angeles, which meant an East Coast contact hit the 6–8pm Pacific
 * window at 9–11pm their time — past the federal 9pm cutoff, and a TCPA
 * violation at $500–$1,500 per call.
 *
 * Resolution order, most reliable first:
 *   1. state from the FUB address  — authoritative when present
 *   2. area code                   — good, but people keep numbers when they move
 *   3. unknown                     — restricted to mid-morning only (see below)
 *
 * UNKNOWN HANDLING. A record we can't place is restricted to the mid-morning
 * window, 10am–12pm Pacific. That is 1–3pm Eastern — comfortably inside legal
 * hours everywhere in the continental US regardless of where the person
 * actually is. Alaska (907) and Hawaii (808) are resolved explicitly by area
 * code so they never fall into the unknown bucket, because 10am Pacific is
 * 7am in Hawaii and would be too early.
 */

/** US state / territory → IANA timezone. Split states use their dominant zone. */
const STATE_TZ = {
  AL: 'America/Chicago',    AK: 'America/Anchorage',  AZ: 'America/Phoenix',
  AR: 'America/Chicago',    CA: 'America/Los_Angeles', CO: 'America/Denver',
  CT: 'America/New_York',   DE: 'America/New_York',   DC: 'America/New_York',
  FL: 'America/New_York',   GA: 'America/New_York',   HI: 'Pacific/Honolulu',
  ID: 'America/Boise',      IL: 'America/Chicago',    IN: 'America/Indiana/Indianapolis',
  IA: 'America/Chicago',    KS: 'America/Chicago',    KY: 'America/New_York',
  LA: 'America/Chicago',    ME: 'America/New_York',   MD: 'America/New_York',
  MA: 'America/New_York',   MI: 'America/Detroit',    MN: 'America/Chicago',
  MS: 'America/Chicago',    MO: 'America/Chicago',    MT: 'America/Denver',
  NE: 'America/Chicago',    NV: 'America/Los_Angeles', NH: 'America/New_York',
  NJ: 'America/New_York',   NM: 'America/Denver',     NY: 'America/New_York',
  NC: 'America/New_York',   ND: 'America/Chicago',    OH: 'America/New_York',
  OK: 'America/Chicago',    OR: 'America/Los_Angeles', PA: 'America/New_York',
  RI: 'America/New_York',   SC: 'America/New_York',   SD: 'America/Chicago',
  TN: 'America/Chicago',    TX: 'America/Chicago',    UT: 'America/Denver',
  VT: 'America/New_York',   VA: 'America/New_York',   WA: 'America/Los_Angeles',
  WV: 'America/New_York',   WI: 'America/Chicago',    WY: 'America/Denver',
  PR: 'America/Puerto_Rico', VI: 'America/St_Thomas', GU: 'Pacific/Guam',
};

/**
 * Area code → timezone.
 *
 * ⚠️ SCOPE NOTE. This covers the Pacific Northwest exhaustively and the major
 * metros elsewhere — the realistic shape of a Washington brokerage's database.
 * It is NOT the complete NANP list. Anything not here resolves to 'unknown'
 * and gets the restricted mid-morning window, which is the safe failure mode:
 * a missing area code costs you dial windows, never a violation.
 *
 * Verify against a maintained NANP dataset before relying on it at scale.
 */
const AREA_TZ = {
  // Pacific — WA, OR, CA, NV, ID panhandle
  206: 'America/Los_Angeles', 253: 'America/Los_Angeles', 360: 'America/Los_Angeles',
  425: 'America/Los_Angeles', 564: 'America/Los_Angeles', 509: 'America/Los_Angeles',
  503: 'America/Los_Angeles', 971: 'America/Los_Angeles', 541: 'America/Los_Angeles',
  458: 'America/Los_Angeles',
  209: 'America/Los_Angeles', 213: 'America/Los_Angeles', 279: 'America/Los_Angeles',
  310: 'America/Los_Angeles', 323: 'America/Los_Angeles', 341: 'America/Los_Angeles',
  350: 'America/Los_Angeles', 408: 'America/Los_Angeles', 415: 'America/Los_Angeles',
  424: 'America/Los_Angeles', 442: 'America/Los_Angeles', 510: 'America/Los_Angeles',
  530: 'America/Los_Angeles', 559: 'America/Los_Angeles', 562: 'America/Los_Angeles',
  619: 'America/Los_Angeles', 626: 'America/Los_Angeles', 628: 'America/Los_Angeles',
  650: 'America/Los_Angeles', 657: 'America/Los_Angeles', 661: 'America/Los_Angeles',
  669: 'America/Los_Angeles', 707: 'America/Los_Angeles', 714: 'America/Los_Angeles',
  747: 'America/Los_Angeles', 760: 'America/Los_Angeles', 805: 'America/Los_Angeles',
  818: 'America/Los_Angeles', 820: 'America/Los_Angeles', 831: 'America/Los_Angeles',
  858: 'America/Los_Angeles', 909: 'America/Los_Angeles', 916: 'America/Los_Angeles',
  925: 'America/Los_Angeles', 949: 'America/Los_Angeles', 951: 'America/Los_Angeles',
  702: 'America/Los_Angeles', 725: 'America/Los_Angeles', 775: 'America/Los_Angeles',
  // Mountain
  208: 'America/Boise', 986: 'America/Boise',
  303: 'America/Denver', 720: 'America/Denver', 970: 'America/Denver', 719: 'America/Denver',
  385: 'America/Denver', 801: 'America/Denver', 435: 'America/Denver',
  406: 'America/Denver', 307: 'America/Denver',
  505: 'America/Denver', 575: 'America/Denver',
  // Arizona — no DST, must be its own zone
  480: 'America/Phoenix', 520: 'America/Phoenix', 602: 'America/Phoenix',
  623: 'America/Phoenix', 928: 'America/Phoenix',
  // Central
  312: 'America/Chicago', 773: 'America/Chicago', 872: 'America/Chicago',
  847: 'America/Chicago', 630: 'America/Chicago', 224: 'America/Chicago',
  214: 'America/Chicago', 469: 'America/Chicago', 972: 'America/Chicago',
  713: 'America/Chicago', 281: 'America/Chicago', 832: 'America/Chicago',
  512: 'America/Chicago', 737: 'America/Chicago', 210: 'America/Chicago',
  817: 'America/Chicago', 682: 'America/Chicago', 940: 'America/Chicago',
  612: 'America/Chicago', 651: 'America/Chicago', 763: 'America/Chicago',
  952: 'America/Chicago', 314: 'America/Chicago', 816: 'America/Chicago',
  405: 'America/Chicago', 918: 'America/Chicago', 501: 'America/Chicago',
  504: 'America/Chicago', 615: 'America/Chicago', 901: 'America/Chicago',
  414: 'America/Chicago', 608: 'America/Chicago', 402: 'America/Chicago',
  515: 'America/Chicago', 316: 'America/Chicago', 913: 'America/Chicago',
  // Eastern
  212: 'America/New_York', 646: 'America/New_York', 917: 'America/New_York',
  718: 'America/New_York', 347: 'America/New_York', 929: 'America/New_York',
  516: 'America/New_York', 631: 'America/New_York', 914: 'America/New_York',
  845: 'America/New_York', 585: 'America/New_York', 716: 'America/New_York',
  315: 'America/New_York', 518: 'America/New_York', 607: 'America/New_York',
  201: 'America/New_York', 973: 'America/New_York', 862: 'America/New_York',
  609: 'America/New_York', 856: 'America/New_York', 908: 'America/New_York',
  215: 'America/New_York', 267: 'America/New_York', 412: 'America/New_York',
  610: 'America/New_York', 484: 'America/New_York', 717: 'America/New_York',
  202: 'America/New_York', 301: 'America/New_York', 240: 'America/New_York',
  410: 'America/New_York', 443: 'America/New_York', 703: 'America/New_York',
  571: 'America/New_York', 804: 'America/New_York', 757: 'America/New_York',
  617: 'America/New_York', 857: 'America/New_York', 781: 'America/New_York',
  508: 'America/New_York', 978: 'America/New_York', 413: 'America/New_York',
  203: 'America/New_York', 860: 'America/New_York', 401: 'America/New_York',
  305: 'America/New_York', 786: 'America/New_York', 954: 'America/New_York',
  561: 'America/New_York', 407: 'America/New_York', 321: 'America/New_York',
  813: 'America/New_York', 727: 'America/New_York', 904: 'America/New_York',
  239: 'America/New_York', 941: 'America/New_York', 352: 'America/New_York',
  404: 'America/New_York', 470: 'America/New_York', 678: 'America/New_York',
  770: 'America/New_York', 912: 'America/New_York', 706: 'America/New_York',
  704: 'America/New_York', 980: 'America/New_York', 919: 'America/New_York',
  984: 'America/New_York', 336: 'America/New_York', 828: 'America/New_York',
  803: 'America/New_York', 843: 'America/New_York', 864: 'America/New_York',
  216: 'America/New_York', 614: 'America/New_York', 513: 'America/New_York',
  330: 'America/New_York', 440: 'America/New_York', 937: 'America/New_York',
  313: 'America/Detroit', 248: 'America/Detroit', 734: 'America/Detroit',
  616: 'America/Detroit', 517: 'America/Detroit',
  317: 'America/Indiana/Indianapolis', 463: 'America/Indiana/Indianapolis',
  502: 'America/New_York', 859: 'America/New_York',
  // Non-continental — resolved explicitly so they never land in 'unknown'
  907: 'America/Anchorage', 808: 'Pacific/Honolulu',
};

/** Windows an unknown-timezone contact may be dialed in. Mid-morning only. */
export const UNKNOWN_TZ_ALLOWED_WINDOWS = new Set(['mid_morning']);

/**
 * Resolve a contact's timezone.
 * @returns {{timezone: string, source: 'address_state'|'area_code'|'default_unknown'}}
 */
export function resolveTimezone({ addresses, phoneE164 } = {}) {
  // 1. address state — authoritative
  for (const a of addresses || []) {
    const st = String(a?.state || '').trim().toUpperCase();
    if (STATE_TZ[st]) return { timezone: STATE_TZ[st], source: 'address_state' };
  }

  // 2. area code
  if (phoneE164) {
    const d = String(phoneE164).replace(/\D/g, '');
    const nat = d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
    const ac = Number(nat.slice(0, 3));
    if (AREA_TZ[ac]) return { timezone: AREA_TZ[ac], source: 'area_code' };
  }

  // 3. unknown — safe default, restricted window enforced at dispatch
  return { timezone: 'America/Los_Angeles', source: 'default_unknown' };
}

export const _internal = { STATE_TZ, AREA_TZ };
