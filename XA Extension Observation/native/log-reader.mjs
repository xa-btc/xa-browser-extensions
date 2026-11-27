import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const MAX_LINE_BYTES = 256 * 1024;
const CHUNK = 256 * 1024;
const MAX_MESSAGE_BYTES = 200_000;
const idPattern = /^[a-p]{32}$/;

export function parseActivityLine(line, allowedIds, includeDetails = false) {
  // Require the real logger prefix, not a marker embedded in an argument or title.
  const match = line.match(/^\[[^\]\r\n]*:([0-9]{4}\/[0-9]{6}\.[0-9]+):VERBOSE1:[^\]\r\n]*[\\/]activity_log\.cc(?:\([0-9]+\)|:[0-9]+)\] ACTION ID=-?\d+ EXTENSION ID=([a-p]{32}) CATEGORY=(\w+) API=([^\s]*)(.*)$/);
  if (!match || !allowedIds.has(match[2])) return null;
  const [, browserTime, extensionId, category, api, details] = match;
  const event = { extensionId, category, api: api || '(content script)', browserTime };
  if (includeDetails) {
    event.rawDetails = details.trim().slice(0, 8192);
    event.detailsTruncated = details.trim().length > 8192;
  }
  return event;
}

const digest = buffer => createHash('sha256').update(buffer).digest('hex');

export function parseBrowserError(line) {
  const match = line.match(/^\[[^\]\r\n]*:([0-9]{4}\/[0-9]{6}\.[0-9]+):(WARNING|ERROR|FATAL):([^\]\r\n]+)\] (.*)$/);
  if (!match) return null;
  return { browserTime: match[1], level: match[2], component: match[3].slice(0, 300), message: match[4].slice(0, 4000) };
}

export class LogReader {
  constructor(logPath, ids, includeDetails = false, includeBrowserErrors = false) {
    if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => !idPattern.test(id))) throw new Error('Invalid extension ID list.');
    this.path = logPath;
    this.ids = new Set(ids);
    this.includeDetails = includeDetails;
    this.includeBrowserErrors = includeBrowserErrors;
    this.identity = null;
    this.offset = 0;
    this.anchor = null;
    this.skippingLongLine = false;
  }
  async poll() {
    const file = await open(this.path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error('Configured log path is not a regular file.');
      const identity = `${info.dev}:${info.ino}:${info.birthtimeMs}`;
      let reset = false;
      if (this.identity === null) {
        // Start at the end: do not silently import old sessions or paused activity.
        this.offset = info.size;
        this.identity = identity;
        this.anchor = await this.readAnchor(file);
        return { events: [], browserErrors: [], started: true, reset: false, skippedLines: 0, fileBytes: info.size, backlogBytes: 0 };
      }
      if (this.identity !== identity || info.size < this.offset || (this.anchor && this.anchor !== await this.readAnchor(file))) {
        this.identity = identity;
        this.offset = 0;
        this.anchor = null;
        this.skippingLongLine = false;
        reset = true;
      }
      const buffer = Buffer.alloc(Math.min(CHUNK, Math.max(0, info.size - this.offset)));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, this.offset);
      const data = buffer.subarray(0, bytesRead);
      let consumed = 0;
      let skippedLines = 0;
      let messageBytes = 0;
      const events = [];
      const browserErrors = [];
      while (consumed < data.length) {
        const end = data.indexOf(10, consumed);
        if (end === -1) {
          if (data.length - consumed >= MAX_LINE_BYTES || this.skippingLongLine) { consumed = data.length; this.skippingLongLine = true; }
          break;
        }
        if (this.skippingLongLine) { skippedLines++; this.skippingLongLine = false; consumed = end + 1; continue; }
        const line = data.subarray(consumed, end).toString('utf8').replace(/\r$/, '');
        const event = parseActivityLine(line, this.ids, this.includeDetails);
        const browserError = !event && this.includeBrowserErrors ? parseBrowserError(line) : null;
        const record = event ?? browserError;
        const size = record ? Buffer.byteLength(JSON.stringify(record)) : 0;
        if (record && (events.length + browserErrors.length >= 100 || messageBytes + size > MAX_MESSAGE_BYTES)) break;
        consumed = end + 1;
        if (event) { events.push(event); messageBytes += size; }
        if (browserError) { browserErrors.push(browserError); messageBytes += size; }
      }
      this.offset += consumed;
      this.anchor = await this.readAnchor(file);
      return { events, browserErrors, started: false, reset, skippedLines, fileBytes: info.size, backlogBytes: Math.max(0, info.size - this.offset) };
    } finally { await file.close(); }
  }
  async readAnchor(file) {
    const length = Math.min(64, this.offset);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, this.offset - length);
    return digest(buffer.subarray(0, bytesRead));
  }
}
