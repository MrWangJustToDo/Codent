/**
 * SSRF guard for model-driven HTTP: one definition of "may this URL be fetched".
 *
 * `webfetch` takes a URL from the model, and the model's choice can be steered by page content
 * it just read (prompt injection). Without a host check, `http://169.254.169.254/latest/meta-data/`
 * returns cloud credentials, `http://127.0.0.1:<port>/` reaches a local admin service, and any
 * RFC1918 address reaches the private network — all through a tool the model can call with no
 * approval. `webfetch` validates the input and every redirect hop, and refuses the body of a
 * target it did not vet.
 *
 * The CoreEnv fetch proxy is deliberately NOT guarded: it also serves non-model callers that may
 * legitimately reach a local dev server or loopback MCP endpoint. Every model-driven caller is
 * responsible for `assertPublicHttpUrl`; a proxy that applied the policy would break those other
 * callers.
 *
 * ## What this can and cannot do
 *
 * It inspects the URL only — no DNS resolution, because `CoreEnv` has no resolver and a
 * resolution that is checked here can still be re-resolved differently by the actual connect
 * (DNS rebinding). It therefore blocks:
 *
 * - a hostname that can only mean the local machine or a metadata service (`localhost`,
 *   `*.localhost`, `*.local`, `*.internal`, `metadata.google.internal`, …),
 * - a literal IP in a loopback / private / link-local / CGNAT / multicast / reserved range,
 *   including IPv4-mapped IPv6 and the AWS IPv6 metadata address,
 * - numeric and hex host spellings (`http://2130706433/`, `http://0x7f.0.0.1/`) that resolve
 *   to a loopback address in a browser but parse as an ordinary name here.
 *
 * A public name that resolves to a private address (or rebinds to one) is still reachable; that
 * needs a resolver-level policy in the host. Redirects are handled by the caller one hop at a
 * time (`webfetch` requests `redirect: "manual"` and validates each `Location` before following),
 * because a followed redirect has already issued the request by the time `response.url` exists.
 */

/** Hostnames that name the local machine or a cloud metadata service by name. */
const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
  "metadata.azure.internal",
]);

/** Non-public suffixes: mDNS and split-horizon names are by definition local. */
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"] as const;

/**
 * Whether `hostname` is a literal IP in a range that is not publicly routable, or a name that
 * can only refer to the local machine.
 */
export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, "");
  if (host === "") return true;

  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;

  // `2130706433` and `0x7f.0.0.1` are loopback to a browser but ordinary names to `new URL`.
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) return true;
  if (host.split(".").every((label) => /^(?:\d+|0x[0-9a-f]+)$/.test(label))) return true;

  const bracketed = host.startsWith("[") && host.endsWith("]");
  const address = bracketed ? host.slice(1, -1) : host;
  const ipv4 = parseIpv4(address);
  if (ipv4) return isPrivateIpv4(ipv4);
  if (address.includes(":")) return isPrivateIpv6(address);

  return false;
}

/**
 * Validate a URL for a model-driven fetch, returning the parsed URL.
 *
 * @throws Error with a message intended for the model (it becomes a tool error), naming the
 * host that was refused rather than a bare "invalid URL".
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${raw}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`URL must start with http:// or https:// (got ${url.protocol})`);
  }

  if (isPrivateHostname(url.hostname)) {
    throw new Error(`Refusing to fetch a private, loopback, or metadata address: ${url.hostname}`);
  }

  return url;
}

function parseIpv4(address: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return null;
  const octets = match.slice(1).map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) return null;
  return octets as [number, number, number, number];
}

function isPrivateIpv4([a, b]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // "this" network / private / loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT (includes Alibaba metadata)
  if (a === 169 && b === 254) return true; // link-local (AWS/GCP/Azure metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && (b === 0 || b === 2)) return true; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast / reserved / broadcast
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();

  // `::ffff:a.b.c.d` / `::ffff:7f00:1` — an IPv4 address wearing an IPv6 hat.
  const mapped = /^::ffff:(.+)$/.exec(normalized);
  if (mapped) {
    const tail = mapped[1]!;
    const dotted = parseIpv4(tail);
    if (dotted) return isPrivateIpv4(dotted);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (hex) {
      const value = (parseInt(hex[1]!, 16) << 16) | parseInt(hex[2]!, 16);
      return isPrivateIpv4([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
    }
    return true;
  }

  if (normalized === "::" || normalized === "::1") return true; // unspecified / loopback
  if (/^f[cd][0-9a-f]{0,2}:/.test(normalized)) return true; // unique-local fc00::/7 (incl. fd00:ec2::254)
  if (/^fe[89ab][0-9a-f]?:/.test(normalized)) return true; // link-local fe80::/10
  if (/^ff[0-9a-f]{0,2}:/.test(normalized)) return true; // multicast
  if (/^64:ff9b::/.test(normalized)) return true; // NAT64 — can embed a private IPv4
  if (/^2001:db8:/.test(normalized)) return true; // documentation range

  return false;
}
