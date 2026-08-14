import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertExpectedPublicCandidate,
  iceCandidateAddresses,
  isPublicIpv4,
} from './verify-mediamtx-ice.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..');

describe('MediaMTX public ICE configuration', () => {
  it('requires a literal public IP independently from the HTTP hostname', () => {
    const compose = readFileSync(path.join(repositoryRoot, 'docker-compose.prod.yml'), 'utf8');
    const setting = compose
      .split('\n')
      .find((line) => line.includes('MTX_WEBRTCADDITIONALHOSTS:'));

    expect(setting).toContain('${MEDIAMTX_PUBLIC_IP:?');
    expect(setting).not.toContain('PUBLIC_HOSTNAME');
  });

  it('provides authenticated TURN over TLS/TCP 443 when direct UDP is blocked', () => {
    const compose = readFileSync(path.join(repositoryRoot, 'docker-compose.prod.yml'), 'utf8');
    const turnUrl = compose
      .split('\n')
      .find((line) => line.includes('MTX_WEBRTCICESERVERS2_0_URL:'));
    const turnRule = compose
      .split('\n')
      .find((line) => line.includes('traefik.tcp.routers.sidestage-turn.rule='));
    const turnSecretUses = compose
      .split('\n')
      .filter((line) => line.includes('${TURN_AUTH_SECRET:?'));

    expect(turnUrl).toContain('turns:turn.${PUBLIC_HOSTNAME:-sidestage.buyrestart.com}:443?transport=tcp');
    expect(compose).toContain('MTX_WEBRTCICESERVERS2_0_USERNAME: AUTH_SECRET');
    expect(compose).toContain('MTX_WEBRTCICESERVERS2_0_CLIENTONLY: "yes"');
    expect(turnSecretUses).toHaveLength(2);
    expect(compose).toContain('image: coturn/coturn:4.15.0-r0');
    expect(compose).toContain('traefik.tcp.routers.sidestage-turn.entrypoints=https');
    expect(turnRule).toContain('HostSNI(`turn.${PUBLIC_HOSTNAME:-sidestage.buyrestart.com}`)');
    expect(turnRule).not.toContain('ALPN(');
  });

  it('finds the expected public candidate in a real SDP-shaped answer', () => {
    const sdp = [
      'v=0',
      'a=candidate:1 1 UDP 2130706431 172.18.0.8 8189 typ host',
      'a=candidate:2 1 UDP 2130706431 178.156.254.59 8189 typ host',
      '',
    ].join('\r\n');

    expect(iceCandidateAddresses(sdp)).toEqual(['172.18.0.8', '178.156.254.59']);
    expect(assertExpectedPublicCandidate(sdp, '178.156.254.59')).toContain('178.156.254.59');
  });

  it('fails when the answer exposes only Docker-private candidates', () => {
    const sdp = 'a=candidate:1 1 UDP 2130706431 172.18.0.8 8189 typ host\r\n';
    expect(() => assertExpectedPublicCandidate(sdp, '178.156.254.59')).toThrow(
      /missing public ICE candidate 178\.156\.254\.59/,
    );
  });

  it('does not accept hostnames or private addresses as the public-IP contract', () => {
    expect(isPublicIpv4('sidestage.buyrestart.com')).toBe(false);
    expect(isPublicIpv4('172.20.0.5')).toBe(false);
    expect(isPublicIpv4('178.156.254.59')).toBe(true);
  });
});
