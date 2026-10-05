// Software WebAuthn authenticator (ES256, "none" attestation) for tests: builds the exact JSON a browser would send.
import { b64url, unb64url } from "../src/util";

function cbor(v: unknown): Uint8Array {
  const head = (major: number, n: number): number[] => {
    if (n < 24) return [(major << 5) | n];
    if (n < 256) return [(major << 5) | 24, n];
    return [(major << 5) | 25, n >> 8, n & 255];
  };
  const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  if (typeof v === "number") return new Uint8Array(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === "string") { const b = new TextEncoder().encode(v); return cat(new Uint8Array(head(3, b.length)), b); }
  if (v instanceof Uint8Array) return cat(new Uint8Array(head(2, v.length)), v);
  const entries = [...(v as Map<unknown, unknown>).entries()];
  return cat(new Uint8Array(head(5, entries.length)), ...entries.flatMap(([k, x]) => [cbor(k), cbor(x)]));
}

const sha = async (d: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest("SHA-256", d));
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
const concat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

function derSig(raw: Uint8Array): Uint8Array {
  const enc = (b: Uint8Array) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; let x = b.slice(i); if (x[0] & 0x80) x = concat(new Uint8Array([0]), x); return concat(new Uint8Array([2, x.length]), x); };
  const body = concat(enc(raw.slice(0, 32)), enc(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

export class SoftAuthenticator {
  credId = crypto.getRandomValues(new Uint8Array(32));
  counter = 0;
  private keys!: CryptoKeyPair;
  constructor(public rpId: string, public origin: string) {}

  async register(options: any) {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", this.keys.publicKey)) as JsonWebKey;
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, unb64url(jwk.x!)], [-3, unb64url(jwk.y!)]]));
    const rpHash = await sha(new TextEncoder().encode(this.rpId));
    const authData = concat(rpHash, new Uint8Array([0x45]), u32(0), new Uint8Array(16), new Uint8Array([this.credId.length >> 8, this.credId.length & 255]), this.credId, cose);
    const att = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    return { id: b64url(this.credId), rawId: b64url(this.credId), type: "public-key", authenticatorAttachment: "platform", clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), attestationObject: b64url(att), transports: ["internal"] } };
  }

  async authenticate(options: any, userHandle = "") {
    this.counter++;
    const rpHash = await sha(new TextEncoder().encode(this.rpId));
    const authData = concat(rpHash, new Uint8Array([0x05]), u32(this.counter));
    const clientData = new TextEncoder().encode(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin: this.origin, crossOrigin: false }));
    const toSign = concat(authData, await sha(clientData));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, toSign));
    return { id: b64url(this.credId), rawId: b64url(this.credId), type: "public-key", clientExtensionResults: {},
      response: { clientDataJSON: b64url(clientData), authenticatorData: b64url(authData), signature: b64url(derSig(sig)), userHandle } };
  }
}
