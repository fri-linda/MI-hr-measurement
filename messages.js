/* Shared by Camera Pulse (index.html) and the hospital system (nis.html).
 *
 * A measurement m = { id, patient, bpm, sdnn, start (ms since 1970), dur (s), tz (minutes east of UTC) }
 * can travel from the phone to the hospital system in three ways:
 *  - a link to nis.html whose part after "#" carries the whole FHIR or HL7 v2 message
 *    (browsers never send the part after "#" to any server),
 *  - the same link as a QR code,
 *  - a short transfer code typed by hand, from which the hospital system rebuilds the message.
 */
"use strict";

const MI = (() => {
  const pad = (x, n = 2) => String(x).padStart(n, "0");
  const UCUM = "http://unitsofmeasure.org", LOINC = "http://loinc.org";

  // Date parts in the time zone of the measurement (tz minutes east of UTC)
  function parts(ms, tz) {
    const d = new Date(ms + tz * 60000);
    return { y: d.getUTCFullYear(), mo: pad(d.getUTCMonth() + 1), d: pad(d.getUTCDate()),
             h: pad(d.getUTCHours()), mi: pad(d.getUTCMinutes()), s: pad(d.getUTCSeconds()),
             sign: tz >= 0 ? "+" : "-", oh: pad(Math.floor(Math.abs(tz) / 60)), om: pad(Math.abs(tz) % 60) };
  }
  const isoTime = (ms, tz) => { const p = parts(ms, tz); return `${p.y}-${p.mo}-${p.d}T${p.h}:${p.mi}:${p.s}${p.sign}${p.oh}:${p.om}`; };
  const hl7Time = (ms, tz) => { const p = parts(ms, tz); return `${p.y}${p.mo}${p.d}${p.h}${p.mi}${p.s}${p.sign}${p.oh}${p.om}`; };

  // FHIR R4 Observation (heart rate with heart rate variability as a component)
  function buildFHIR(m, pretty) {
    const obs = {
      resourceType: "Observation",
      identifier: [{ system: "urn:fri:mi:camera-pulse", value: m.id }],
      status: "final",
      category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
      code: { coding: [{ system: LOINC, code: "8867-4", display: "Heart rate" }] },
      subject: { identifier: { system: "urn:fri:mi:patient", value: m.patient }, display: m.patient },
      ...(m.dur ? { effectivePeriod: { start: isoTime(m.start, m.tz), end: isoTime(m.start + m.dur * 1000, m.tz) } }
                : { effectiveDateTime: isoTime(m.start, m.tz) }),
      valueQuantity: { value: m.bpm, unit: "beats/minute", system: UCUM, code: "/min" },
      device: { display: "Camera Pulse (phone camera, PPG)" },
      component: [{
        code: { coding: [{ system: LOINC, code: "80404-7", display: "R-R interval.standard deviation (Heart rate variability)" }] },
        valueQuantity: { value: m.sdnn, unit: "ms", system: UCUM, code: "ms" }
      }]
    };
    return pretty ? JSON.stringify(obs, null, 2) : JSON.stringify(obs);
  }

  // HL7 v2.5.1 ORU^R01, segments separated by carriage return
  function buildHL7(m) {
    const t = hl7Time(m.start, m.tz), sent = hl7Time(m.start + m.dur * 1000, m.tz);
    const flag = m.bpm > 100 ? "H" : m.bpm < 60 ? "L" : "N";
    return [
      `MSH|^~\\&|CAMERAPULSE|FRI_UNIZA|NIS|NEMOCNICA|${sent}||ORU^R01^ORU_R01|${m.id}|P|2.5.1`,
      `PID|1||${m.patient}^^^FRI^PI||${m.patient}`,
      `OBR|1||${m.id}|8867-4^Heart rate^LN|||${t}`,
      `OBX|1|NM|8867-4^Heart rate^LN||${m.bpm}|/min^beats per minute^UCUM|60-100|${flag}|||F|||${t}`,
      `OBX|2|NM|80404-7^R-R interval.standard deviation^LN||${m.sdnn}|ms^millisecond^UCUM||||F|||${t}`,
    ].join("\r");
  }

  // ----- Link: the message after "#m=", compressed when the browser can -----
  const b64url = bytes => { let s = ""; bytes.forEach(b => s += String.fromCharCode(b)); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
  const unb64url = s => { const b = atob(s.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, c => c.charCodeAt(0)); };
  async function pipe(bytes, stream) {
    return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  }
  async function encodeLink(text, base) {
    const raw = new TextEncoder().encode(text);
    let payload;
    if (typeof CompressionStream === "function") payload = "z" + b64url(await pipe(raw, new CompressionStream("deflate-raw")));
    else payload = "t" + b64url(raw);
    return new URL("nis.html", base).href + "#m=" + payload;
  }
  async function decodeLink(hash) {
    const p = hash.replace(/^#?m=/, "");
    const bytes = unb64url(p.slice(1));
    if (p[0] === "z") return new TextDecoder().decode(await pipe(bytes, new DecompressionStream("deflate-raw")));
    return new TextDecoder().decode(bytes);
  }

  // ----- Transfer code: 50 bits of data + 1 check character, Crockford base 32 -----
  // bpm 8 bits | SDNN 10 bits (ms) | start: minutes since 2026-01-01 UTC, 20 bits |
  // time zone in quarter hours + 64, 7 bits | duration 5 bits (s)
  const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";      // no I, L, O, U
  const EPOCH = Date.UTC(2026, 0, 1);
  // weighted sum modulo the prime 31: every single mistyped character and every swap of two
  // neighbours changes it (except swapping 0 and Z)
  function check(digits) { return digits.reduce((s, d, i) => s + d * (i + 1), 0) % 31; }
  function encodeCode(m) {
    const min = Math.max(0, Math.min(2 ** 20 - 1, Math.floor((m.start - EPOCH) / 60000)));
    const fields = [[Math.max(0, Math.min(255, m.bpm)), 8], [Math.max(0, Math.min(1023, m.sdnn)), 10],
                    [min, 20], [Math.round(m.tz / 15) + 64, 7], [Math.max(0, Math.min(31, m.dur)), 5]];
    let v = 0n;
    for (const [x, bits] of fields) v = (v << BigInt(bits)) | BigInt(x);
    const digits = [];
    for (let i = 0; i < 10; i++) { digits.unshift(Number(v & 31n)); v >>= 5n; }
    digits.push(check(digits));
    const s = digits.map(d => ALPHA[d]).join("");
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  }
  function decodeCode(text) {
    const s = text.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
    if (s.length !== 11) throw new Error("The code has 11 characters (e.g. K7QM-2XA9-3FB), this one has " + s.length + ".");
    const digits = [...s].map(c => { const i = ALPHA.indexOf(c); if (i < 0) throw new Error(`"${c}" is not allowed in the code.`); return i; });
    if (check(digits.slice(0, 10)) !== digits[10]) throw new Error("The check character does not match: the code was probably mistyped.");
    let v = 0n;
    for (const d of digits.slice(0, 10)) v = (v << 5n) | BigInt(d);
    const take = bits => { const x = Number(v & ((1n << BigInt(bits)) - 1n)); v >>= BigInt(bits); return x; };
    const dur = take(5), tz = (take(7) - 64) * 15, min = take(20), sdnn = take(10), bpm = take(8);
    return { bpm, sdnn, start: EPOCH + min * 60000, tz, dur, id: "CP-" + s };
  }
  const idFromCode = code => "CP-" + code.replace(/-/g, "");

  return { buildFHIR, buildHL7, encodeLink, decodeLink, encodeCode, decodeCode, idFromCode, isoTime, hl7Time };
})();

if (typeof module !== "undefined") module.exports = MI;
