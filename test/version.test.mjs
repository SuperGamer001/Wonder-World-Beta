// Verifies the launcher's semver precedence comparison against the cases that
// actually matter for this project's beta versioning scheme.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// isNewerVersion lives in the Electron main process, which cannot be imported
// outside Electron — lift the function out of the source instead of duplicating it.
const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'electron', 'main.js'), 'utf8');
const start = src.indexOf('function isNewerVersion');
const end   = src.indexOf('\nasync function fetchJson');
if (start < 0 || end < 0) { console.error('FAIL: could not locate isNewerVersion in electron/main.js'); process.exit(1); }
const isNewerVersion = new Function(`${src.slice(start, end)}; return isNewerVersion;`)();

let failures = 0;
function t(a, b, expected, why) {
    const got = isNewerVersion(a, b);
    const ok = got === expected;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  isNewer(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${got}  ${why}`);
}

console.log('--- the project\'s real upgrade path ---');
t('1.0.0-beta.2',  '1.0.0-beta.1',  true,  'beta bump is an update');
t('1.0.0-beta.10', '1.0.0-beta.9',  true,  'prerelease numbers compare numerically, not as strings');
t('1.0.0',         '1.0.0-beta.1',  true,  'stable release supersedes its betas');
t('1.0.0-beta.1',  '1.0.0-beta.1',  false, 'same version is not an update');
t('1.0.0-beta.1',  '1.0.0-beta.2',  false, 'older beta is not an update');
t('1.0.0-beta.1',  '1.0.0',         false, 'a beta never supersedes the stable release');

console.log('\n--- core version precedence ---');
t('1.1.0', '1.0.9', true,  'minor beats patch');
t('2.0.0', '1.99.99', true, 'major beats everything');
t('1.0.10', '1.0.9', true, 'patch compares numerically');
t('1.0.0', '1.0.1', false, 'older patch');

console.log('\n--- prerelease identifier rules ---');
t('1.0.0-beta.1',  '1.0.0-alpha.9', true,  'beta outranks alpha alphabetically');
t('1.0.0-rc.1',    '1.0.0-beta.5',  true,  'rc outranks beta');
t('1.0.0-beta.1.1','1.0.0-beta.1',  true,  'more identifiers outrank fewer when equal so far');
t('1.0.0-beta',    '1.0.0-beta.1',  false, 'fewer identifiers rank lower');
t('1.0.0-beta.1',  '1.0.0-1',       true,  'numeric identifiers rank below alphanumeric');

console.log('\n--- malformed input must never claim an update ---');
for (const [a, b] of [[null, '1.0.0'], ['1.0.0', null], ['', '1.0.0'], ['abc', '1.0.0'],
                      [undefined, undefined], ['1.0', '1.0.0'], ['{}', '1.0.0']]) {
    const got = isNewerVersion(a, b);
    const ok = got === false;
    if (!ok) failures++;
    console.log(`${ok ? 'PASS' : 'FAIL'}  isNewer(${JSON.stringify(a)}, ${JSON.stringify(b)}) = ${got}`);
}

console.log('\n--- tolerates a leading v ---');
t('v1.0.1', '1.0.0', true, 'leading v is stripped');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
