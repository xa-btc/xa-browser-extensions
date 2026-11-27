function rectangle(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function path(ctx, points) {
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
  if (points.length === 1) ctx.lineTo(points[0].x + 0.01, points[0].y);
  ctx.stroke();
}

function draw(ctx, action, preview = false) {
  const { tool, start, end, color, size, text, points } = action;
  const bounds = rectangle(start, end);
  ctx.save();
  ctx.lineWidth = size;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  if (tool === 'pen') path(ctx, points);
  if (tool === 'rectangle') ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  if (tool === 'highlight') {
    ctx.globalAlpha = 0.28;
    ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }
  if (tool === 'arrow') {
    const angle = Math.atan2(end.y - start.y, end.x - start.x);
    const length = size * 4;
    const tip = offset => ({ x: end.x - length * Math.cos(angle + offset), y: end.y - length * Math.sin(angle + offset) });
    path(ctx, [start, end]);
    path(ctx, [tip(-0.55), end, tip(0.55)]);
  }
  if (tool === 'text') {
    ctx.font = Math.max(12, size * 4) + 'px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(text, start.x, start.y);
  }
  if (tool === 'crop' && preview) {
    ctx.strokeStyle = '#00a682';
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 5]);
    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  }
  if (tool === 'blur' && bounds.width >= 2 && bounds.height >= 2) {
    const width = Math.max(1, Math.ceil(bounds.width / Math.max(12, size)));
    const height = Math.max(1, Math.ceil(bounds.height / Math.max(12, size)));
    const reduced = new OffscreenCanvas(width, height);
    reduced.getContext('2d').drawImage(ctx.canvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, width, height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(reduced, bounds.x, bounds.y, bounds.width, bounds.height);
  }
  ctx.restore();
}

function reposition(items, crop) {
  return (items || []).flatMap(item => {
    const x = Math.max(item.x, crop.x);
    const y = Math.max(item.y, crop.y);
    const right = Math.min(item.x + item.width, crop.x + crop.width);
    const bottom = Math.min(item.y + item.height, crop.y + crop.height);
    if (right <= x || bottom <= y) return [];
    if (item.value && (x > item.x || right < item.x + item.width || y > item.y || bottom < item.y + item.height)) return [];
    return [{ ...item, x: x - crop.x, y: y - crop.y, width: right - x, height: bottom - y }];
  });
}

export class Editor {
  constructor(canvas, options, change) {
    this.canvas = canvas;
    this.options = options;
    this.change = change;
    this.context = canvas.getContext('2d');
    this.actions = [];
    this.future = [];
    canvas.addEventListener('pointerdown', event => this.start(event));
    canvas.addEventListener('pointermove', event => this.move(event));
    canvas.addEventListener('pointerup', event => this.finish(event));
    canvas.addEventListener('pointercancel', () => { this.draft = null; this.render(); });
  }

  setImage(bitmap, entry) {
    this.bitmap?.close();
    this.bitmap = bitmap;
    this.entry = entry;
    this.actions = [];
    this.future = [];
    this.draft = null;
    this.render();
  }

  coordinate(event) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(this.canvas.width, (event.clientX - rect.left) / rect.width * this.canvas.width))),
      y: Math.round(Math.max(0, Math.min(this.canvas.height, (event.clientY - rect.top) / rect.height * this.canvas.height)))
    };
  }

  start(event) {
    if (!this.bitmap || event.button !== 0) return;
    const options = this.options();
    if (!options.tool || (options.tool === 'text' && !options.text.trim())) return;
    const start = this.coordinate(event);
    this.canvas.setPointerCapture(event.pointerId);
    this.draft = { ...options, start, end: start, points: [start], pointer: event.pointerId };
    this.render();
  }

  move(event) {
    if (this.draft?.pointer !== event.pointerId) return;
    const point = this.coordinate(event);
    this.draft.end = point;
    if (this.draft.tool === 'pen') this.draft.points.push(point);
    this.render();
  }

  finish(event) {
    if (this.draft?.pointer !== event.pointerId) return;
    this.move(event);
    const { start, end, tool } = this.draft;
    if (['text', 'pen', 'arrow'].includes(tool) || (Math.abs(start.x - end.x) >= 2 && Math.abs(start.y - end.y) >= 2)) {
      this.actions.push(this.draft);
      this.future = [];
    }
    this.draft = null;
    this.render();
  }

  undo() {
    if (this.actions.length) this.future.push(this.actions.pop());
    this.render();
  }

  redo() {
    if (this.future.length) this.actions.push(this.future.pop());
    this.render();
  }

  reset() {
    this.actions = [];
    this.future = [];
    this.render();
  }

  render() {
    if (!this.bitmap) return;
    const ctx = this.context;
    this.canvas.width = this.bitmap.width;
    this.canvas.height = this.bitmap.height;
    ctx.drawImage(this.bitmap, 0, 0);
    let crop = { x: 0, y: 0, width: this.bitmap.width, height: this.bitmap.height };
    let redacted = false;
    for (const action of this.actions) {
      if (action.tool !== 'crop') {
        draw(ctx, action);
        redacted ||= action.tool === 'blur';
        continue;
      }
      const area = rectangle(action.start, action.end);
      const tile = new OffscreenCanvas(area.width, area.height);
      tile.getContext('2d').drawImage(this.canvas, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
      this.canvas.width = area.width;
      this.canvas.height = area.height;
      ctx.drawImage(tile, 0, 0);
      crop = { ...area, x: crop.x + area.x, y: crop.y + area.y };
    }
    this.crop = crop;
    this.redacted = redacted;
    if (this.draft) draw(ctx, this.draft, true);
    this.change();
  }

  async export(format = 'png', quality = 0.92) {
    if (!this.bitmap) throw new Error('Choose a capture first.');
    if (this.draft) throw new Error('Finish the current edit before exporting.');
    const type = format === 'jpg' ? 'image/jpeg' : 'image/' + format;
    const image = await new Promise((resolve, reject) => {
      this.canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode the image.')), type, quality);
    });
    return {
      ...this.entry, image, width: this.canvas.width, height: this.canvas.height,
      text: this.redacted ? [] : reposition(this.entry.text, this.crop),
      links: this.redacted ? [] : reposition(this.entry.links, this.crop)
    };
  }
}

