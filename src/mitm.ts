import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import http from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import tls from "node:tls";
import { getRequestListener } from "@hono/node-server";

export const DEFAULT_MITM_HOST = "daily-cloudcode-pa.googleapis.com";

export interface MitmCerts {
  certDir: string;
  caCertPath: string;
  caKeyPath: string;
  hostCertPath: string;
  hostKeyPath: string;
  bundlePath: string;
  caCert: Buffer;
  hostCert: Buffer;
  hostKey: Buffer;
}

function isValidCert(certPem: string): boolean {
  try {
    const cert = new X509Certificate(certPem);
    const validTo = new Date(cert.validTo).getTime();
    return validTo > Date.now() + 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

function createCaCert(caKeyPath: string, caPemPath: string): void {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKeyPath,
      "-out",
      caPemPath,
      "-days",
      "3650",
      "-subj",
      "/CN=Jev Gateway CA",
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ],
    { stdio: "pipe" },
  );
  try {
    chmodSync(caKeyPath, 0o600);
  } catch {}
}

function createHostCert(caKeyPath: string, caPemPath: string, hostKeyPath: string, hostPemPath: string, hostname: string): void {
  const csrPath = `${hostPemPath}.csr`;
  execFileSync(
    "openssl",
    [
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      hostKeyPath,
      "-out",
      csrPath,
      "-subj",
      `/CN=${hostname}`,
      "-addext",
      `subjectAltName=DNS:${hostname}`,
    ],
    { stdio: "pipe" },
  );
  try {
    chmodSync(hostKeyPath, 0o600);
  } catch {}

  execFileSync(
    "openssl",
    [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      caPemPath,
      "-CAkey",
      caKeyPath,
      "-CAcreateserial",
      "-out",
      hostPemPath,
      "-days",
      "365",
      "-copy_extensions",
      "copy",
    ],
    { stdio: "pipe" },
  );

  try {
    rmSync(csrPath, { force: true });
    rmSync(`${caPemPath.replace(/\.pem$/, ".srl")}`, { force: true });
  } catch {}
}

function createBundle(bundlePath: string, caPem: string): void {
  const systemPaths = [
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/ssl/cert.pem",
  ];
  let systemCerts = "";
  for (const p of systemPaths) {
    if (existsSync(p)) {
      try {
        systemCerts = readFileSync(p, "utf8");
        if (systemCerts.trim()) break;
      } catch {}
    }
  }

  if (!systemCerts.trim()) {
    // Node's rootCertificates elements are already full PEM strings with BEGIN/END markers.
    systemCerts = tls.rootCertificates
      .map((c) => (c.includes("BEGIN CERTIFICATE") ? c.trim() : `-----BEGIN CERTIFICATE-----\n${c.trim()}\n-----END CERTIFICATE-----`))
      .join("\n\n");
  }

  const combined = systemCerts.trimEnd() + "\n\n# Jev Gateway Local CA\n" + caPem.trim() + "\n";
  writeFileSync(bundlePath, combined, "utf8");
}

/** Ensure local CA and host certificates exist and are valid, writing a bundle with system roots. */
export function ensureMitmCerts(
  certDir = join(homedir(), ".jev-gateway", "certs"),
  hostname = DEFAULT_MITM_HOST,
): MitmCerts {
  mkdirSync(certDir, { recursive: true });
  const caKeyPath = join(certDir, "ca.key");
  const caPemPath = join(certDir, "ca.pem");
  const hostKeyPath = join(certDir, `${hostname}.key`);
  const hostPemPath = join(certDir, `${hostname}.pem`);
  const bundlePath = join(certDir, "bundle.pem");

  let caRecreated = false;
  const caValid = existsSync(caKeyPath) && existsSync(caPemPath) && isValidCert(readFileSync(caPemPath, "utf8"));
  if (!caValid) {
    createCaCert(caKeyPath, caPemPath);
    caRecreated = true;
  }

  const caPem = readFileSync(caPemPath, "utf8");
  const hostValid = !caRecreated && existsSync(hostKeyPath) && existsSync(hostPemPath) && isValidCert(readFileSync(hostPemPath, "utf8"));
  if (!hostValid) {
    createHostCert(caKeyPath, caPemPath, hostKeyPath, hostPemPath, hostname);
  }

  if (!existsSync(bundlePath) || !readFileSync(bundlePath, "utf8").includes(caPem.trim())) {
    createBundle(bundlePath, caPem);
  }

  return {
    certDir,
    caCertPath: caPemPath,
    caKeyPath,
    hostCertPath: hostPemPath,
    hostKeyPath,
    bundlePath,
    caCert: readFileSync(caPemPath),
    hostCert: readFileSync(hostPemPath),
    hostKey: readFileSync(hostKeyPath),
  };
}

/** Attach HTTPS MITM / CONNECT tunneling to an HTTP server. */
export function setupMitm(
  server: Server,
  fetchHandler: (request: Request) => Promise<Response> | Response,
  options: { certDir?: string; interceptHost?: string } = {},
): { certs?: MitmCerts; close: () => void } {
  const interceptHost = options.interceptHost ?? DEFAULT_MITM_HOST;

  let certs: MitmCerts;
  try {
    certs = ensureMitmCerts(options.certDir, interceptHost);
  } catch (error) {
    // Fail-open: if cert generation fails, log a warning and don't crash other client launchers.
    console.warn(`jev-gateway: MITM HTTPS proxy disabled: ${error instanceof Error ? error.message : String(error)}`);
    return { close: () => {} };
  }

  const secureContext = tls.createSecureContext({
    key: certs.hostKey,
    cert: certs.hostCert,
  });

  const internalHttpServer = http.createServer(getRequestListener(fetchHandler));
  internalHttpServer.on("clientError", (_err, socket) => {
    socket.destroy();
  });

  const onConnect = (req: IncomingMessage, clientSocket: Duplex, head: Buffer) => {
    const url = req.url ?? "";
    const colon = url.lastIndexOf(":");
    const rawHost = colon !== -1 ? url.slice(0, colon) : url;
    const hostname = rawHost.replace(/^\[|\]$/g, "");
    const port = colon !== -1 ? Number(url.slice(colon + 1)) || 443 : 443;

    if (hostname === interceptHost) {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      clientSocket.on("error", () => {
        clientSocket.destroy();
      });

      // Pipelined client bytes (TLS ClientHello) belong to the raw encrypted socket, not the decrypted TLSSocket.
      if (head && head.length > 0) {
        clientSocket.unshift(head);
      }

      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        secureContext,
      });

      tlsSocket.on("error", () => {
        tlsSocket.destroy();
      });

      internalHttpServer.emit("connection", tlsSocket);
    } else {
      clientSocket.on("error", () => {});

      const upstreamSocket = net.connect(port, hostname, () => {
        if (clientSocket.destroyed) {
          upstreamSocket.destroy();
          return;
        }
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length > 0) {
          upstreamSocket.write(head);
        }
        upstreamSocket.pipe(clientSocket);
        clientSocket.pipe(upstreamSocket);
      });

      upstreamSocket.on("error", () => {
        if (!clientSocket.destroyed) {
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        }
      });

      clientSocket.on("close", () => {
        upstreamSocket.destroy();
      });
      upstreamSocket.on("close", () => {
        clientSocket.destroy();
      });
    }
  };

  server.on("connect", onConnect);

  const close = () => {
    server.off("connect", onConnect);
    server.off("close", close);
    internalHttpServer.close();
  };

  server.on("close", close);

  return { certs, close };
}
