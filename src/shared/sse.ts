export interface SseMessage {
  event: string;
  data: string;
}

export function parseSse(onMessage: (message: SseMessage) => void) {
  let buffer = '';
  let event = '';
  let data: string[] = [];

  const dispatch = () => {
    if (data.length > 0) onMessage({ event: event || 'message', data: data.join('\n') });
    event = '';
    data = [];
  };

  const line = (raw: string) => {
    if (raw === '') return dispatch();
    if (raw.startsWith(':')) return;
    const colon = raw.indexOf(':');
    const field = colon === -1 ? raw : raw.slice(0, colon);
    let value = colon === -1 ? '' : raw.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  };

  return {
    push(chunk: string) {
      buffer += chunk;
      let start = 0;
      for (let i = 0; i < buffer.length; i++) {
        const ch = buffer[i];
        if (ch !== '\n' && ch !== '\r') continue;
        // 块边界可能恰好落在 \r\n 中间，留到下一块再判断
        if (ch === '\r' && i === buffer.length - 1) break;
        line(buffer.slice(start, i));
        if (ch === '\r' && buffer[i + 1] === '\n') i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
    },
    end() {
      if (buffer) line(buffer.replace(/\r$/, ''));
      buffer = '';
      dispatch();
    },
  };
}
