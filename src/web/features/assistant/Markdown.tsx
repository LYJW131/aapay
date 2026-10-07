import type { ReactNode } from 'react';

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul' | 'ol'; items: string[] };

const BULLET = /^\s*[-*•]\s+/;
const NUMBER = /^\s*\d+[.)、]\s+/;

function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const last = out.at(-1);
    if (!line.trim()) {
      if (last?.kind === 'p') out.push({ kind: 'p', lines: [] });
      continue;
    }
    const kind = BULLET.test(line) ? 'ul' : NUMBER.test(line) ? 'ol' : null;
    if (kind) {
      const item = line.replace(kind === 'ul' ? BULLET : NUMBER, '');
      if (last?.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
    } else if (last?.kind === 'p') {
      last.lines.push(line.replace(/^#+\s+/, ''));
    } else {
      out.push({ kind: 'p', lines: [line.replace(/^#+\s+/, '')] });
    }
  }
  return out.filter((b) => (b.kind === 'p' ? b.lines.length > 0 : true));
}

function inline(text: string, key: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > index) nodes.push(text.slice(index, match.index));
    const token = match[0];
    const k = `${key}-${match.index}`;
    nodes.push(
      token.startsWith('**') ? (
        <strong key={k} className="font-semibold">
          {token.slice(2, -2)}
        </strong>
      ) : (
        <code key={k} className="rounded-md bg-zinc-900/6 px-1 py-px font-mono text-[0.9em] dark:bg-white/10">
          {token.slice(1, -1)}
        </code>
      ),
    );
    index = match.index + token.length;
  }
  if (index < text.length) nodes.push(text.slice(index));
  return nodes;
}

function closeOpenMarks(text: string) {
  let out = text;
  if ((out.match(/\*\*/g)?.length ?? 0) % 2) out = out.endsWith('**') ? out.slice(0, -2) : `${out}**`;
  if ((out.replace(/\*\*/g, '').match(/`/g)?.length ?? 0) % 2) out = out.endsWith('`') ? out.slice(0, -1) : `${out}\``;
  return out;
}

export function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const list = blocks(caret ? closeOpenMarks(text) : text);
  const cursor = caret ? <span className="ai-caret" aria-hidden /> : null;
  if (list.length === 0) return cursor;
  return (
    <div className="space-y-2 break-words">
      {list.map((block, i) => {
        const tail = i === list.length - 1 ? cursor : null;
        if (block.kind === 'p') {
          return (
            <p key={i}>
              {block.lines.flatMap((line, j) => [...(j ? [<br key={`br${j}`} />] : []), ...inline(line, `${i}-${j}`)])}
              {tail}
            </p>
          );
        }
        const List = block.kind;
        return (
          <List key={i} className={List === 'ul' ? 'list-disc space-y-1 pl-5 marker:text-zinc-400' : 'list-decimal space-y-1 pl-5 marker:text-zinc-400'}>
            {block.items.map((item, j) => (
              <li key={j}>
                {inline(item, `${i}-${j}`)}
                {j === block.items.length - 1 && tail}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}
