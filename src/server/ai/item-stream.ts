export interface ItemEvent {
  index: number;
  done: boolean;
  value: Record<string, unknown> | null;
  raw?: string;
}

export class ItemStream {
  private depth = 0;
  private inString = false;
  private escaped = false;
  private text = '';
  private lastComma = -1;
  private index = 0;
  private lastPartial = '';

  private readonly itemDepth: number;

  constructor(itemDepth = 3) {
    this.itemDepth = itemDepth;
  }

  feed(chunk: string): ItemEvent[] {
    const events: ItemEvent[] = [];
    for (const ch of chunk) {
      const collecting = this.depth >= this.itemDepth;
      if (collecting) this.text += ch;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === '\\') this.escaped = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') this.inString = true;
      else if (ch === '{' || ch === '[') {
        this.depth++;
        if (this.depth === this.itemDepth && ch === '{') {
          this.text = ch;
          this.lastComma = -1;
          this.lastPartial = '';
        }
      } else if (ch === ',' && this.depth === this.itemDepth) this.lastComma = this.text.length - 1;
      else if (ch === '}' || ch === ']') {
        if (this.depth === this.itemDepth && ch === '}') {
          events.push(this.finish());
          this.text = '';
        }
        this.depth--;
      }
    }
    const partial = this.partial();
    if (partial) events.push(partial);
    return events;
  }

  private finish(): ItemEvent {
    const raw = this.text;
    const index = this.index++;
    try {
      return { index, done: true, value: JSON.parse(raw) };
    } catch {
      return { index, done: true, value: null, raw };
    }
  }

  private partial(): ItemEvent | null {
    if (this.depth < this.itemDepth || !this.text.startsWith('{')) return null;
    let head = this.text;
    if (this.inString) {
      head = head.replace(/\\(u[0-9a-fA-F]{0,3})?$/, '');
      head += '"';
    } else if (!/["}\]]\s*$/.test(head)) head = head.slice(0, this.lastComma < 0 ? 1 : this.lastComma);
    const value = tryParse(head + '}') ?? tryParse(this.text.slice(0, this.lastComma < 0 ? 1 : this.lastComma) + '}');
    if (!value || Object.keys(value).length === 0) return null;
    const key = JSON.stringify(value);
    if (key === this.lastPartial) return null;
    this.lastPartial = key;
    return { index: this.index, done: false, value };
  }
}

function tryParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
