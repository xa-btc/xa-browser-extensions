import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const extension = resolve(root, 'extension');
const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions.sort(), ['alarms', 'debugger', 'management', 'storage']);
assert.deepEqual(manifest.optional_permissions, ['nativeMessaging', 'tabs', 'webNavigation']);
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.content_scripts, undefined);
assert.equal(manifest.externally_connectable, undefined);
for (const file of await readdir(extension)) {
  if (file.endsWith('.js')) {
    execFileSync(process.execPath, ['--check', resolve(extension, file)], { stdio: 'pipe' });
    const source = await readFile(resolve(extension, file), 'utf8');
    assert.ok(!/\b(?:eval|Function)\s*\(|\.innerHTML\s*=|\.outerHTML\s*=|document\.write\s*\(/.test(source), `${file}: unsafe execution or HTML sink`);
    assert.ok(!/management\.(?:setEnabled|uninstall|installReplacementWebApp)\s*\(/.test(source), `${file}: unexpected extension mutation`);
    assert.ok(!/\bfetch\s*\(|new\s+(?:WebSocket|XMLHttpRequest)\b/.test(source), `${file}: unexpected network transport`);
  }
}
const html = await readFile(resolve(extension, 'dashboard.html'), 'utf8');
assert.ok(!/<script\b(?![^>]*\bsrc=)[^>]*>/.test(html), 'Inline script forbidden by CSP');
assert.ok(!/\bon\w+\s*=/.test(html), 'Inline handlers forbidden by CSP');
for (const path of ['dashboard.js', 'dashboard.css', 'background.js', 'controller.js', 'core.js']) await readFile(resolve(extension, path));
for (const path of ['host.mjs', 'log-reader.mjs']) execFileSync(process.execPath, ['--check', resolve(root, 'native', path)], { stdio: 'pipe' });
// Prose in project Markdown is intentionally one physical line per paragraph.
const readme = await readFile(resolve(root, 'README.md'), 'utf8');
assert.ok(readme.includes('all telemetry'));
let inFence = false;
let previousProse = false;
for (const [index, line] of readme.split(/\r?\n/).entries()) {
  if (/^```/.test(line)) { inFence = !inFence; previousProse = false; continue; }
  if (inFence) continue;
  const prose = line.trim() && !/^(?:#|\||[-*] |\d+\. |>|<)/.test(line);
  assert.ok(!(prose && previousProse), `README.md:${index + 1}: prose appears hard wrapped`);
  previousProse = Boolean(prose);
}
assert.equal(inFence, false, 'Unclosed Markdown fence');
console.log('PASS: JavaScript/native syntax, MV3 permissions, local-only transport, safe DOM sinks, entry points, and Markdown wrapping.');
