import type { ServerSocket } from './platform.ts';
import { isServerPath, type Serve } from './server.ts';

const local = (url: URL) => url.origin === window.location.origin && isServerPath(url.pathname);

class DemoWebSocket extends EventTarget implements ServerSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  detach?: () => void;

  constructor(
    readonly url: string,
    serve: Serve,
  ) {
    super();
    const http = url.replace(/^ws/, 'http');
    setTimeout(async () => {
      const res = await serve(http, { headers: { upgrade: 'websocket' } }, this).catch(() => null);
      if (this.readyState !== 0) return this.detach?.();
      if (!res?.ok) {
        this.emit(new Event('error'), this.onerror);
        return this.shut(1006, '');
      }
      this.readyState = 1;
      this.emit(new Event('open'), this.onopen);
    });
  }

  private emit<E extends Event>(event: E, handler: ((event: E) => void) | null) {
    handler?.call(this, event);
    this.dispatchEvent(event);
  }

  deliver(data: string) {
    setTimeout(() => this.readyState === 1 && this.emit(new MessageEvent('message', { data }), this.onmessage));
  }

  shut(code: number, reason: string) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.detach?.();
    setTimeout(() => this.emit(new CloseEvent('close', { code, reason, wasClean: code !== 1006 }), this.onclose));
  }

  send(data: string) {
    if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
    if (data === 'ping') this.deliver('pong');
  }

  close(code = 1000, reason = '') {
    this.shut(code, reason);
  }
}

export function installShims(serve: Serve) {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    return local(url) ? serve(input, init) : nativeFetch(input, init);
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args: [string | URL, (string | string[])?]) {
      const url = new URL(String(args[0]), window.location.href);
      return local(new URL(url.href.replace(/^ws/, 'http'))) ? new DemoWebSocket(url.href, serve) : Reflect.construct(target, args);
    },
  });
}
