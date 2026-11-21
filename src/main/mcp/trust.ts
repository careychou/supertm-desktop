import fs from 'node:fs'
import os from 'node:os'
import { X509Certificate } from 'node:crypto'
import type { Session } from 'electron'

const PEM = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

export const expandHome = (p: string): string => p.replace(/^~(?=$|\/)/, os.homedir())

/** Certificates in a PEM bundle; unreadable or malformed entries are skipped. */
export function readBundle(file: string): X509Certificate[] {
  let text: string
  try { text = fs.readFileSync(expandHome(file), 'utf8') } catch { return [] }
  const out: X509Certificate[] = []
  for (const p of text.match(PEM) ?? []) { try { out.push(new X509Certificate(p)) } catch { /* skip */ } }
  return out
}

/**
 * Whether a chain the OS rejected should be trusted anyway: it must include one of the pinned certificates,
 * every link must be signed by the next, and the leaf must match the host and be within its validity window.
 */
export function trustedChain(chain: X509Certificate[], anchors: X509Certificate[], host: string, now = new Date()): boolean {
  return !chainProblem(chain, anchors, host, now)
}

const cn = (c: X509Certificate) => /CN=([^\n]+)/.exec(c.subject)?.[1] ?? c.subject.split('\n').pop() ?? '?'

/** Why a chain isn't trusted by the extra certificates, or '' when it is. */
export function chainProblem(chain: X509Certificate[], anchors: X509Certificate[], host: string, now = new Date()): string {
  if (!chain.length) return 'the server sent no certificate'
  if (!anchors.length) return 'no extra trusted certificates are set up'
  const pins = new Set(anchors.map((a) => a.fingerprint256))
  const pinAt = chain.findIndex((c) => pins.has(c.fingerprint256))
  if (pinAt < 0) return `its certificate chain (${chain.map(cn).join(' → ')}) doesn't include any certificate in the trusted file (${anchors.map(cn).join(', ')})`
  const leaf = chain[0]
  if (!leaf.checkHost(host) && !leaf.checkIP(host)) return `its certificate is for ${leaf.subjectAltName ?? cn(leaf)}, not ${host}`
  if (new Date(leaf.validFrom) > now || new Date(leaf.validTo) < now) return `its certificate is valid only ${leaf.validFrom} – ${leaf.validTo}`
  for (let i = 0; i < pinAt; i++) if (!chain[i].verify(chain[i + 1].publicKey)) return `${cn(chain[i])} isn't signed by ${cn(chain[i + 1])}`
  return ''
}

/**
 * Lets Chromium's network stack (net.fetch, used for MCP servers) trust extra CA certificates, e.g. a corporate root
 * that isn't in the macOS keychain. Chains the OS accepts are untouched. Call again when the bundle path changes.
 */
export function installExtraTrust(ses: Session, bundlePath: () => string): { problem(host: string): string | undefined; reinstall(): void } {
  // last rejection reason per host, so connection errors can explain themselves
  const problems = new Map<string, string>()
  let cache: { key: string; anchors: X509Certificate[] } | null = null
  let missing = ''
  const anchors = (): X509Certificate[] => {
    const p = bundlePath().trim()
    if (!p) return []
    let key: string
    try { key = `${p}:${fs.statSync(expandHome(p)).mtimeMs}` } catch (e: any) { missing = `the trusted certificates file ${p} can't be read (${e?.code ?? e})`; return [] }
    missing = ''
    if (cache?.key !== key) cache = { key, anchors: readBundle(p) }
    return cache.anchors
  }
  const install = () => ses.setCertificateVerifyProc((req, cb) => {
    if (req.errorCode === 0) { problems.delete(req.hostname); return cb(-3) }
    const a = anchors()
    let why: string
    try {
      const chain: X509Certificate[] = []
      for (let c: Electron.Certificate | undefined = req.certificate; c && chain.length < 10; c = c.issuerCert === c ? undefined : c.issuerCert) chain.push(new X509Certificate(c.data))
      why = !a.length ? (missing || (bundlePath().trim() ? `the trusted certificates file ${bundlePath().trim()} has no certificates` : 'no extra trusted certificates file is set')) : chainProblem(chain, a, req.hostname)
    } catch (e: any) { why = `its certificate couldn't be read (${e?.message ?? e})` }
    if (why) { problems.set(req.hostname, `${req.hostname} isn't trusted: ${why}.`); console.warn('[trust]', problems.get(req.hostname)) } else problems.delete(req.hostname)
    cb(why ? -3 : 0)
  })
  install()
  // Chromium drops the verify proc when its network service restarts after a crash
  // re-registering needs a clear first and a moment for the new service to come up
  return { problem: (host) => problems.get(host), reinstall: () => { ses.setCertificateVerifyProc(null); setTimeout(install, 300) } }
}
