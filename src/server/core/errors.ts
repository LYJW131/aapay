import { translateError, type ErrorArgs, type ErrorKey } from '../../shared/errors.ts';
import { DEFAULT_LOCALE, type Locale } from '../../shared/i18n.ts';

export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502;

export class AppError extends Error {
  readonly status: ErrorStatus;
  readonly args: ErrorArgs;

  constructor(status: ErrorStatus, ...args: ErrorArgs) {
    super(translateError(DEFAULT_LOCALE, ...args));
    this.name = 'AppError';
    this.status = status;
    this.args = args;
  }

  get key(): ErrorKey {
    return this.args[0];
  }

  toJSON() {
    return { key: this.args[0] as string, params: this.args[1] as Record<string, string> | undefined };
  }

  static fromJSON(status: ErrorStatus, { key, params }: ReturnType<AppError['toJSON']>) {
    return new AppError(status, ...([key, params] as ErrorArgs));
  }

  localized(locale: Locale) {
    return translateError(locale, ...this.args);
  }
}

export const badRequest = (...args: ErrorArgs) => new AppError(400, ...args);
export const forbidden = (...args: ErrorArgs) => new AppError(403, ...args);
export const notFound = (...args: ErrorArgs) => new AppError(404, ...args);
export const conflict = (...args: ErrorArgs) => new AppError(409, ...args);
export const unauthorized = () => new AppError(401, 'unauthorized');
