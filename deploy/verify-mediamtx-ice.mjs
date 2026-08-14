#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function iceCandidateAddresses(sdp) {
  return String(sdp)
    .split(/\r?\n/)
    .filter((line) => line.startsWith('a=candidate:'))
    .map((line) => line.trim().split(/\s+/)[4])
    .filter(Boolean);
}

export function isPublicIpv4(address) {
  if (isIP(address) !== 4) return false;

  const [a, b] = address.split('.').map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function assertExpectedPublicCandidate(sdp, expectedIp) {
  if (!isPublicIpv4(expectedIp)) {
    throw new Error(`expected IP must be a public IPv4 address, received ${expectedIp}`);
  }

  const addresses = iceCandidateAddresses(sdp);
  if (!addresses.includes(expectedIp)) {
    throw new Error(
      `MediaMTX SDP is missing public ICE candidate ${expectedIp}; candidates: ${addresses.join(', ') || '(none)'}`,
    );
  }

  return addresses;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function parseArgs(args) {
  const options = { expectedIp: '', sdpFile: '' };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--expected-ip') options.expectedIp = args[++index] ?? '';
    else if (args[index] === '--sdp-file') options.sdpFile = args[++index] ?? '';
    else throw new Error(`unknown argument: ${args[index]}`);
  }
  if (!options.expectedIp) throw new Error('--expected-ip is required');
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sdp = options.sdpFile ? await readFile(options.sdpFile, 'utf8') : await readStdin();
  const addresses = assertExpectedPublicCandidate(sdp, options.expectedIp);
  process.stdout.write(
    `verified MediaMTX public ICE candidate ${options.expectedIp}; candidates: ${addresses.join(', ')}\n`,
  );
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
