import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filenameLooksSensitive, findLikelySecret } from './secretsHeuristic';

test('flags real key-shaped content: AWS access key', () => {
  const found = findLikelySecret('const key = "AKIAABCDEFGHIJKLMNOP";');
  assert.equal(found?.rule, 'AWS Access Key');
});

test('flags real key-shaped content: PEM private key header', () => {
  const found = findLikelySecret('-----BEGIN RSA PRIVATE KEY-----\nMIIEow...');
  assert.equal(found?.rule, 'Private Key');
});

test('flags real key-shaped content: hardcoded API key assignment', () => {
  const found = findLikelySecret('const apiKey = "sk_abcdefgh12345678ijklmnop";');
  assert.equal(found?.rule, 'Hardcoded API/Secret Key');
  assert.equal(found?.line, 1);
});

test('does NOT flag a reference to an out-of-band env var', () => {
  assert.equal(findLikelySecret('const apiKey = process.env.API_KEY;'), undefined);
  assert.equal(findLikelySecret('const secret = import.meta.env.VITE_SECRET;'), undefined);
});

test('does NOT flag ordinary code that merely mentions "password" or "secret" — the naive word-match this replaces would have false-positived on all of these', () => {
  assert.equal(findLikelySecret('function hashPassword(password: string) {}'), undefined);
  assert.equal(findLikelySecret('// don\'t hardcode secrets here'), undefined);
  assert.equal(findLikelySecret('interface LoginDto { password: string; }'), undefined);
  assert.equal(findLikelySecret('describe("secret rotation", () => {});'), undefined);
  assert.equal(findLikelySecret('const secretsScanner = new SecretsScanner();'), undefined);
});

test('sensitive filenames are flagged regardless of content', () => {
  assert.equal(filenameLooksSensitive('.env'), true);
  assert.equal(filenameLooksSensitive('.env.production'), true);
  assert.equal(filenameLooksSensitive('config/id_rsa'), true);
  assert.equal(filenameLooksSensitive('certs/server.pem'), true);
  assert.equal(filenameLooksSensitive('secrets.yaml'), true);
  assert.equal(filenameLooksSensitive('serviceAccountKey.json'), true);
});

test('ordinary filenames are not flagged', () => {
  assert.equal(filenameLooksSensitive('src/extension.ts'), false);
  assert.equal(filenameLooksSensitive('README.md'), false);
  assert.equal(filenameLooksSensitive('auth/password-service.ts'), false);
});
